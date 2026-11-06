// parity-counter.js — « Compte parité » (bouton de l'accueil).
//
// Compte la FIN DE NUMÉRO DE JEU (chiffre 0 à 9 : le jeu #1223 compte pour le chiffre 3), séparément pour le JOUEUR et
// le BANQUIER. Pour chaque jeu terminé : si le point du joueur est PAIR, le chiffre va dans « Taux parité pair — Joueur » ;
// s'il est IMPAIR, dans « Taux parité impair — Joueur ». Même principe pour le banquier avec son propre point.
// Le pourcentage de chaque chiffre est calculé sur le total de SON bloc.
//
// Envoi (réglage « Envoyer pour ») : le joueur seulement, le banquier seulement, ou les deux — un message par côté,
// posté À CHAQUE FIN DE JEU (gagnant ou non) dans le canal choisi. Remise à zéro automatique toutes les N minutes (60 par défaut,
// calée sur l'heure pile), avec le compte à rebours dans le message.
'use strict';

const store = require('./store');
const db = require('./db');
const details = require('./counter-details'); // détails du bilan : pair / impair, fins de numéro élevées, chiffre le plus fréquent

const STORE_KEY = 'parityCounter';
const DB_KEY = 'parity_counter_state';
const DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const TARGETS = ['both', 'player', 'banker'];

const zeros = () => Array(10).fill(0);
const SUITS = ['♠️', '❤️', '♦️', '♣️'];
const suitZeros = () => ({ '♠️': 0, '❤️': 0, '♦️': 0, '♣️': 0 });
const suitGrid = () => ({ pair: Array.from({ length: 10 }, suitZeros), impair: Array.from({ length: 10 }, suitZeros) });
const strategies = require('./strategies');
const state = {
  enabled: true,
  channelId: '',
  target: 'player',    // player (défaut : seule la main du joueur est suivie) | banker | both
  intervalMin: 60,
  player: { pair: zeros(), impair: zeros(), suits: suitGrid() },
  banker: { pair: zeros(), impair: zeros(), suits: suitGrid() },
  games: 0,
  lastGameNumber: null,
  dz: { player: {}, banker: {} },        // v130 : costumes vus par dizaine et par fin de numéro { base: [ [costumes] | null ×10 ] } (bilan de l'heure)
  prevTop: { player: null, banker: null }, // v126 : costume(s) au taux max de chaque fin 0-9 à la fin de la dizaine précédente (comparaison du récap)
  lastRecap: null,
  sinceAt: Date.now(),
  sentCount: 0,
  lastSentAt: null,
  lastError: null,
};

let sendFn = null; // enregistrée par bot.js : async (channelId, text) => message_id
function setSender(fn) { sendFn = typeof fn === 'function' ? fn : null; }

// ---------------------------------------------------------------------------
// Réglages + persistance (data.json en repli, base en source de vérité)
// ---------------------------------------------------------------------------
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
function config() {
  return { enabled: state.enabled, channelId: state.channelId, target: state.target, intervalMin: state.intervalMin };
}
function applyConfig(c) {
  if (!c || typeof c !== 'object') return;
  if (c.enabled !== undefined) state.enabled = c.enabled !== false;
  if (c.channelId !== undefined) state.channelId = String(c.channelId == null ? '' : c.channelId).trim();
  if (c.target !== undefined) state.target = TARGETS.includes(c.target) ? c.target : 'player';
  if (c.intervalMin !== undefined) state.intervalMin = clampInt(c.intervalMin, 5, 1440, 60);
}
function persist() {
  const saved = config();
  try { store.patch({ [STORE_KEY]: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { state.lastError = e.message; });
}
function configure(patch = {}) {
  const before = state.intervalMin;
  applyConfig(patch);
  if (state.intervalMin !== before) { resetCounts(); scheduleReset(); } // autre intervalle : on repart de zéro
  persist();
  return config();
}
function restore() { try { applyConfig((store.read() || {})[STORE_KEY]); } catch (_) {} return config(); }
async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting(DB_KEY);
    if (raw) applyConfig(JSON.parse(raw)); else persist();
  } catch (_) { persist(); }
  try { const rawCounts = await db.getSetting(COUNTS_KEY); if (rawCounts) applyCounts(JSON.parse(rawCounts)); } catch (_) {}
  scheduleReset();
  return config();
}
restore();

function setChannel(id) { state.channelId = String(id || '').trim(); persist(); return state.channelId; }
const getChannel = () => state.channelId;

// ---------------------------------------------------------------------------
// Comptage
// ---------------------------------------------------------------------------
// Compteurs conservés en base (PostgreSQL / Supabase, réglage « parity_counter_counts ») : après un redémarrage du site, le palier
// reprend où il en était, tant qu'on est encore dans la même tranche de reset (sinon le reset a déjà dû avoir lieu : on repart de zéro).
const COUNTS_KEY = 'parity_counter_counts';
function slotKey(now = new Date()) { const n = state.intervalMin; const m = now.getHours() * 60 + now.getMinutes(); return `${now.toDateString()}|${Math.floor(m / n)}|${n}`; }
let countsTimer = null;
function persistCounts() {
  if (!db.ready || countsTimer) return;
  countsTimer = setTimeout(() => {
    countsTimer = null;
    const saved = { slot: slotKey(), player: state.player, banker: state.banker, dz: state.dz, prevTop: state.prevTop, games: state.games, lastGameNumber: state.lastGameNumber, sinceAt: state.sinceAt };
    db.setSetting(COUNTS_KEY, JSON.stringify(saved)).catch((e) => { state.lastError = e.message; });
  }, 1500);
  if (countsTimer.unref) countsTimer.unref();
}
const okSide = (s) => s && Array.isArray(s.pair) && s.pair.length === 10 && Array.isArray(s.impair) && s.impair.length === 10 && s.suits && Array.isArray(s.suits.pair) && s.suits.pair.length === 10 && Array.isArray(s.suits.impair) && s.suits.impair.length === 10;
const okDz = (d) => {
  const out = { player: {}, banker: {} };
  for (const side of ['player', 'banker']) {
    const src = d && typeof d === 'object' && d[side] && typeof d[side] === 'object' ? d[side] : {};
    for (const [base, row] of Object.entries(src)) if (Number.isInteger(Number(base)) && Array.isArray(row) && row.length === 10) out[side][base] = row.map((x) => (Array.isArray(x) ? x.filter((y) => typeof y === 'string') : null));
  }
  return out;
};
function applyCounts(c) {
  if (!c || typeof c !== 'object' || c.slot !== slotKey() || !okSide(c.player) || !okSide(c.banker)) return false;
  state.player = c.player; state.banker = c.banker;
  const okTop = (t) => Array.isArray(t) && t.length === 10 && t.every((x) => typeof x === 'string');
  state.prevTop = { player: c.prevTop && okTop(c.prevTop.player) ? c.prevTop.player : null, banker: c.prevTop && okTop(c.prevTop.banker) ? c.prevTop.banker : null };
  state.dz = okDz(c.dz);
  state.games = Number(c.games) || 0; state.lastGameNumber = Number.isInteger(c.lastGameNumber) ? c.lastGameNumber : null; state.sinceAt = Number(c.sinceAt) || Date.now();
  return true;
}

function resetCounts() {
  state.player = { pair: zeros(), impair: zeros(), suits: suitGrid() }; state.banker = { pair: zeros(), impair: zeros(), suits: suitGrid() };
  state.games = 0;
  state.dz = { player: {}, banker: {} };
  state.prevTop = { player: null, banker: null }; // nouvelle tranche : plus de dizaine précédente à comparer
  state.sinceAt = Date.now();
  persistCounts();
}

const pointParity = (v) => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n >= 0 && n <= 9 ? (n % 2 === 0 ? 'pair' : 'impair') : null; };

// appelée une fois par jeu terminé (voir bot.js, même point que le Taux Miroir)
function bump(round) {
  if (!round || !round.finished) return false;
  if (round.complete === false) return false;
  const num = Number(round.number);
  if (!Number.isInteger(num) || num < 0) return false;
  if (state.lastGameNumber === num) return false;
  const pp = pointParity(round.playerValue); const bp = pointParity(round.bankerValue);
  if (!pp && !bp) return false;
  state.lastGameNumber = num;
  const d = num % 10; // fin de numéro : 1223 → 3
  if (pp) state.player[pp][d] += 1;
  if (bp) state.banker[bp][d] += 1;
  // costumes des cartes du côté, rangés dans la même case (parité, chiffre) que le jeu
  if (pp) for (const x of strategies.suitsOf(round.playerSuits)) if (x in state.player.suits[pp][d]) state.player.suits[pp][d][x] += 1;
  if (bp) for (const x of strategies.suitsOf(round.bankerSuits)) if (x in state.banker.suits[bp][d]) state.banker.suits[bp][d][x] += 1;
  // v130 : costumes vus à cette fin de numéro dans cette dizaine (pour le bilan de l'heure)
  const base = Math.floor(num / 10) * 10;
  const rec = (side, list) => { const m = state.dz[side]; const row = m[base] || (m[base] = Array(10).fill(null)); row[d] = [...new Set(list)]; };
  if (pp) rec('player', strategies.suitsOf(round.playerSuits));
  if (bp) rec('banker', strategies.suitsOf(round.bankerSuits));
  for (const side of ['player', 'banker']) { const keys = Object.keys(state.dz[side]).map(Number).sort((a, b) => a - b); for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete state.dz[side][k]; }
  state.games += 1;
  persistCounts();
  return true;
}

const pct = (count, total) => (total ? ((count / total) * 100).toFixed(1) : '0.0');
// Ordre d'affichage des costumes sur chaque ligne : ❤️ ♦️ ♠️ ♣️ (emojis : rouge pour cœur/carreau, noir pour pique/trèfle)
const SUIT_ORDER = ['❤️', '♦️', '♠️', '♣️'];
const SUIT_PLAIN = { '❤️': '❤️', '♦️': '♦️', '♠️': '♠️', '♣️': '♣️' }; // emojis colorés (VS16)
// pourcentages des costumes d'une case (parité, chiffre) ; 👑 sur le costume strictement dominant
function suitCells(cell) {
  const c = cell || suitZeros();
  const total = SUIT_ORDER.reduce((n, x) => n + (c[x] || 0), 0);
  const max = Math.max(...SUIT_ORDER.map((x) => c[x] || 0));
  const topCount = SUIT_ORDER.filter((x) => (c[x] || 0) === max).length;
  return SUIT_ORDER.map((x) => ({ suit: x, count: c[x] || 0, pct: pct(c[x] || 0, total), dominant: total > 0 && max > 0 && topCount === 1 && (c[x] || 0) === max }));
}
// Une ligne par fin de numéro, au format « #840 ➔ (❤️45%) (♣️30%) (♦️15%) (♠️10%) » : le numéro est celui de la dizaine du
// dernier jeu terminé (jeu #845 → #840 à #849) et les costumes sont rangés du plus fréquent au moins fréquent.
// Sans aucun jeu pour ce chiffre : « #840 ➔ — ».
const pctInt = (count, total) => (total ? Math.round((count / total) * 100) : 0);
// v131 : barre de progression ▰▰▰▰▰▱▱▱▱▱ (10 cases) pour lire un taux d'un coup d'œil
const bar = (pc, n = 10) => { const f = Math.max(0, Math.min(n, Math.round((pc / 100) * n))); return '▰'.repeat(f) + '▱'.repeat(n - f); };
const TITLE_RULE = '━━━━━━━━━━━━━━━━';
const SUB_RULE = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈';
function suitLine(label, cell) {
  const cells = suitCells(cell);
  const total = cells.reduce((n, r) => n + r.count, 0);
  if (!total) return `${label} ➔ aucun jeu`;
  const sorted = cells.map((r, i) => ({ ...r, i })).sort((x, y) => y.count - x.count || x.i - y.i); // égalité : ordre ❤️ ♦️ ♠️ ♣️
  const shown = sorted.filter((r) => r.count > 0); // v131 : les costumes à 0 % ne sont plus affichés (message plus court, plus lisible)
  const lead = shown.length > 0 && shown.filter((r) => r.count === shown[0].count).length === 1; // un seul costume en tête → 👑
  return `${label} ➔ ` + shown.map((r, k) => `${k === 0 && lead ? '👑 ' : ''}${r.suit} ${pctInt(r.count, total)} %`).join('  ·  ');
}
// Liste unique de 10 lignes (une par fin de numéro 0 à 9), sans titre : les costumes des jeux à point pair ET impair sont
// réunis pour chaque chiffre. Le nombre de jeux pair / impair reste affiché dans le résumé.
// v122 : chaque ligne dit si le numéro est DÉJÀ PASSÉ ou PAS ENCORE PASSÉ dans la dizaine du dernier jeu terminé :
//   ✅ #840 ➔ …   numéro déjà passé (jeu terminé)
//   ✅ #845 ➔ … ◀ dernier jeu terminé
//   ⏳ #846 ➔ …   numéro pas encore passé (les pourcentages sont ceux des dizaines précédentes depuis le reset)
function listBlock(pairSuits, impairSuits, gameNumber, digits = ALL) {
  const g = Number(gameNumber);
  const known = gameNumber != null && gameNumber !== '' && Number.isInteger(g) && g >= 0;
  const base = known ? Math.floor(g / 10) * 10 : null;
  const cur = known ? g % 10 : null;
  const lines = [];
  for (const d of digits) {
    const p = (pairSuits && pairSuits[d]) || {}; const i = (impairSuits && impairSuits[d]) || {};
    const merged = suitZeros();
    for (const x of SUIT_ORDER) merged[x] = (p[x] || 0) + (i[x] || 0);
    if (base == null) { lines.push(suitLine(DIGITS[d], merged)); continue; }
    const passed = d <= cur;
    lines.push(`${passed ? '✅' : '⏳'} ${suitLine(`#${base + d}`, merged)}${d === cur ? '   ◀ dernier jeu' : ''}`);
  }
  return lines.join('\n');
}

// Palier (stratégie « Palier parité », parity-palier.js) : pour chaque fin de numéro 0-9, les 4 costumes de la main du côté choisi
// (cases pair + impair réunies, comme les lignes du message), avec le même pourcentage entier que celui affiché « #840 ➔ (❤️45%) … ».
function palier(side = 'player') {
  const counts = state[side === 'banker' ? 'banker' : 'player'];
  const sp = (counts.suits && counts.suits.pair) || []; const si = (counts.suits && counts.suits.impair) || [];
  return ALL.map((d) => {
    const merged = suitZeros();
    for (const x of SUIT_ORDER) merged[x] = ((sp[d] || {})[x] || 0) + ((si[d] || {})[x] || 0);
    const total = SUIT_ORDER.reduce((n, x) => n + merged[x], 0);
    return { digit: d, total, cells: SUIT_ORDER.map((x) => ({ suit: x, count: merged[x], pct: pctInt(merged[x], total) })) };
  });
}

// prochain reset : calé sur l'horloge locale (toutes les N minutes à partir de minuit ; 60 = heure pile)
function msUntilNextReset(now = new Date()) {
  const n = state.intervalMin;
  const m = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / 60000;
  const boundary = (Math.floor(m / n) + 1) * n;
  return Math.max(1000, Math.round((boundary - m) * 60000));
}
function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSec / 60)}min ${totalSec % 60}s`;
}

const SIDES = {
  player: { icon: '👤', name: 'Joueur' },
  banker: { icon: '🏦', name: 'Banquier' },
};
function sidesToSend() { return state.target === 'player' ? ['player'] : state.target === 'banker' ? ['banker'] : ['player', 'banker']; }

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad2(d.getHours())}h${pad2(d.getMinutes())}`;
const plural = (n, w) => `${n} ${w}${n > 1 ? 'x' : ''}`;
const RULE = '━━━━━━━━━━━━━━━';

// v130 : message clair et aéré — un titre par bloc, une information par ligne, jamais de mots ou de phrases collés
function buildMessage(side, gameNumber, opts = {}) {
  const s = SIDES[side]; const counts = state[side];
  const pairTotal = counts.pair.reduce((n, x) => n + x, 0);
  const impairTotal = counts.impair.reduce((n, x) => n + x, 0);
  const bilan = opts && opts.bilan;
  const g = Number(gameNumber);
  const known = gameNumber != null && gameNumber !== '' && Number.isInteger(g) && g >= 0;
  const both = pairTotal + impairTotal;
  const pairPct = pctInt(pairTotal, both); const impairPct = both ? 100 - pairPct : 0;
  return [
    ...(bilan ? [`🕐 BILAN DE L'HEURE — ${hhmm(new Date())}`, TITLE_RULE, ''] : []),
    `${s.icon} ${s.name.toUpperCase()} — COMPTE PARITÉ`,
    TITLE_RULE,
    ...(known ? [`🎮 Dernier jeu terminé : #${g}`] : []),
    '',
    '📊 COSTUMES PAR FIN DE NUMÉRO',
    'Du plus fréquent au moins fréquent · 👑 = costume en tête',
    SUB_RULE,
    listBlock(counts.suits && counts.suits.pair, counts.suits && counts.suits.impair, gameNumber),
    ...(known ? [SUB_RULE, '✅ déjà passé  ·  ⏳ pas encore passé  ·  ◀ dernier jeu'] : []),
    '',
    TITLE_RULE,
    '📋 RÉSUMÉ STATISTIQUE',
    TITLE_RULE,
    `${s.icon} ${s.name}`,
    `➖ Pair    ${bar(pairPct)} ${pairTotal} jeux (${pairPct} %)`,
    `➕ Impair  ${bar(impairPct)} ${impairTotal} jeux (${impairPct} %)`,
    `📊 Total compté depuis le dernier reset : ${state.games} jeux`,
    ...(bilan ? ['', details.detailsText(counts.pair, counts.impair, `${s.icon} ${s.name}`)] : []),
    '',
    ...(bilan ? ['🔄 Compteur remis à zéro'] : [`⏭ Prochain reset : dans ${formatCountdown(msUntilNextReset())}`, `⏱ Intervalle : ${state.intervalMin} min`]),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// v130 — BILAN DES DIZAINES, envoyé à chaque heure pile (juste après le bilan de l'heure, avant la remise à zéro) :
// tout ce qui a été vu dans les dizaines de l'heure, puis UN costume proposé par fin de numéro (0 à 9) = le costume au taux le plus élevé
// de cette fin de numéro (même taux que les lignes du compteur). Égalité au taux max : les costumes à égalité sont tous proposés.
// ---------------------------------------------------------------------------
function proposalOf(side) {
  return palier(side).map((row) => {
    if (!row.total) return { digit: row.digit, total: 0, top: [], pct: 0, ranked: [] };
    const idx = (x) => SUIT_ORDER.indexOf(x.suit);
    const ranked = [...row.cells].sort((x, y) => y.count - x.count || idx(x) - idx(y));
    const max = ranked[0].count;
    return { digit: row.digit, total: row.total, top: max ? ranked.filter((c) => c.count === max).map((c) => c.suit) : [], pct: ranked[0].pct, ranked };
  });
}
function buildProposalMessage(side) {
  const s = SIDES[side];
  const rows = proposalOf(side);
  const bases = Object.keys(state.dz[side] || {}).map(Number).sort((a, b) => a - b);
  const since = new Date(state.sinceAt || Date.now());
  const head = [
    `🕐 BILAN DES DIZAINES — ${hhmm(new Date())}`,
    TITLE_RULE,
    `${s.icon} ${s.name.toUpperCase()} — COMPTE PARITÉ`,
    '',
    `⏱ Période : de ${hhmm(since)} à ${hhmm(new Date())}`,
    `🎮 Jeux comptés : ${state.games}`,
    `🔟 Dizaines vues : ${bases.length}`,
    ...(bases.length ? ['', ...bases.map((b) => `   ▸ #${b} à #${b + 9}`)] : []),
    '',
    TITLE_RULE,
    '💡 COSTUME PROPOSÉ PAR FIN DE NUMÉRO',
    TITLE_RULE,
    'Costume au taux le plus élevé de chaque fin de numéro,',
    'calculé sur toutes les dizaines de l\u2019heure.',
  ];
  const block = (r, withDetail) => {
    const lines = ['', SUB_RULE];
    if (!r.total) { lines.push(`${DIGITS[r.digit]} Fin ${r.digit} — aucun jeu`); return lines; }
    const head1 = r.top.length > 1 ? `${DIGITS[r.digit]} Fin ${r.digit}  ➜  ⚖️ ${r.top.join(' ')} à égalité` : `${DIGITS[r.digit]} Fin ${r.digit}  ➜  ✅ ${r.top[0]}`;
    lines.push(head1);
    lines.push(`   ${bar(r.pct)} ${r.pct} %`);
    if (withDetail) {
      const seen = bases.map((b) => { const row = (state.dz[side][b] || [])[r.digit]; return row && row.length ? `#${b + r.digit} ${row.join('')}` : null; }).filter(Boolean);
      if (seen.length) lines.push(`   👁 Vu : ${seen.join('  ·  ')}`);
    }
    lines.push(`   📊 ${r.ranked.filter((c) => c.count > 0).map((c) => `${c.suit} ${c.pct} %`).join('  ·  ')}`);
    return lines;
  };
  const tail = ['', TITLE_RULE, '✅ = costume proposé  ·  ⚖️ = égalité  ·  👁 = costumes vus', 'Barre = taux du costume proposé'];
  let text = [...head, ...rows.flatMap((r) => block(r, true)), ...tail].join('\n');
  if (text.length > 3900) text = [...head, ...rows.flatMap((r) => block(r, false)), ...tail].join('\n'); // trop long pour Telegram : on retire le détail par dizaine
  return text;
}

// publie le compteur À CHAQUE FIN DE JEU (v122) : un message par côté choisi (joueur, banquier ou les deux), quel que soit le gagnant
// (le filtre « côté gagnant seulement » a été retiré ; un nul envoie aussi le compteur)
async function publish(gameNumber) {
  if (!state.enabled || !state.channelId || !sendFn) return false;
  let ok = false;
  for (const side of sidesToSend()) {
    try { await sendFn(state.channelId, buildMessage(side, gameNumber)); ok = true; state.sentCount += 1; state.lastSentAt = Date.now(); state.lastError = null; }
    catch (e) { state.lastError = e.message; console.error('Compte parité :', e.message); }
  }
  return ok;
}
// ---------------------------------------------------------------------------
// v126 — Récap de FIN DE DIZAINE (jeu finissant par 9) : les fins de numéro 0 à 9 alignées deux par deux, avec le costume au taux max
// de chacune (cases pair + impair réunies, comme les lignes du message). ✅ = même costume que lors de la dizaine précédente,
// 🔰 = variation. Égalité au taux max : les costumes à égalité sont tous affichés. Aucun jeu pour ce chiffre : « — ».
// ---------------------------------------------------------------------------
function topSuitsOf(side) {
  const counts = state[side === 'banker' ? 'banker' : 'player'];
  const sp = (counts.suits && counts.suits.pair) || []; const si = (counts.suits && counts.suits.impair) || [];
  return ALL.map((d) => {
    const merged = suitZeros();
    for (const x of SUIT_ORDER) merged[x] = ((sp[d] || {})[x] || 0) + ((si[d] || {})[x] || 0);
    const max = Math.max(...SUIT_ORDER.map((x) => merged[x]));
    if (!max) return '—';
    return SUIT_ORDER.filter((x) => merged[x] === max).join('');
  });
}
function buildDizaineMessage(side, gameNumber) {
  const s = SIDES[side]; const now = topSuitsOf(side); const prev = state.prevTop[side];
  const g = Number(gameNumber);
  const base = Number.isInteger(g) && g >= 0 ? Math.floor(g / 10) * 10 : null;
  const D = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
  const cell = (d) => `${D[d]} ${now[d]}${now[d] === '—' ? '' : (prev && prev[d] !== now[d] ? ' 🔰' : ' ✅')}`;
  const lines = [];
  for (let d = 0; d < 10; d += 2) lines.push(`${cell(d)}   ⚖️   ${cell(d + 1)}`);
  // v131 : bloc CHANGEMENTS lisible — pour chaque fin de numéro qui a varié : avant ➜ maintenant + la nature du changement
  //   🆕 premier costume (rien à la dizaine précédente) · ➕ costume(s) ajouté(s) · ➖ costume(s) retiré(s) · 🔁 costume remplacé ; les fins identiques sont listées à part
  const D2 = D;
  const suitsIn = (t) => SUIT_ORDER.filter((x) => String(t || '').includes(x));
  const changes = []; const same = [];
  if (prev) {
    for (const d of ALL) {
      if (now[d] === '—' && prev[d] === '—') continue;
      if (now[d] === prev[d]) { same.push(D2[d]); continue; }
      if (now[d] === '—') continue; // plus aucun jeu pour cette fin : rien à comparer
      const before = suitsIn(prev[d]); const after = suitsIn(now[d]);
      if (prev[d] === '—' || !before.length) { changes.push(`${D2[d]} Fin ${d} : 🆕 ${now[d]}  (premier costume)`); continue; }
      const added = after.filter((x) => !before.includes(x)); const removed = before.filter((x) => !after.includes(x));
      const kind = added.length && removed.length ? `🔁 remplacé : ${removed.join('')} ➜ ${added.join('')}` : added.length ? `➕ ajouté : ${added.join('')}` : `➖ retiré : ${removed.join('')}`;
      changes.push(`${D2[d]} Fin ${d} : ${prev[d]} ➜ ${now[d]}`, `      ${kind}`);
    }
  }
  return [
    `${s.icon} ${s.name.toUpperCase()} — COMPTE PARITÉ`,
    TITLE_RULE,
    `🔟 FIN DE DIZAINE${base != null ? ` · #${base} à #${base + 9}` : ''}`,
    'Costume au taux le plus élevé de chaque fin de numéro',
    SUB_RULE,
    ...lines,
    ...(prev ? [SUB_RULE, `🔄 CHANGEMENTS${base != null ? ` · #${base}-#${base + 9}` : ''}`, 'Dizaine précédente ➜ cette dizaine', '', ...(changes.length ? changes : ['Aucun changement : tous les costumes sont identiques ✅']), ...(same.length && changes.length ? ['', `✅ Inchangées : ${same.join(' ')}`] : [])] : []),
    SUB_RULE,
    '✅ même costume que la dizaine précédente',
    '🔰 variation par rapport à la dizaine précédente',
  ].join('\n');
}
async function dizaineRecap(gameNumber) {
  const wanted = sidesToSend();
  for (const side of ['player', 'banker']) {
    const text = buildDizaineMessage(side, gameNumber);
    const top = topSuitsOf(side);
    state.prevTop[side] = top; // la dizaine qui vient de finir devient la référence de la suivante
    if (!wanted.includes(side) || !state.channelId || !sendFn) continue;
    try { await sendFn(state.channelId, text); state.sentCount += 1; state.lastSentAt = Date.now(); state.lastError = null; }
    catch (e) { state.lastError = e.message; console.error('Compte parité (fin de dizaine) :', e.message); }
  }
  persistCounts();
}

// à appeler à chaque jeu terminé : compte puis publie
async function onFinished(round) {
  if (!state.enabled) return;
  if (!round || !round.finished) return;
  const counted = bump(round);
  // v122 : le compteur part à CHAQUE fin de jeu, même si le jeu n'a pas pu être compté (cartes absentes, points illisibles) ; jamais deux fois le même numéro
  const num = Number(round.number);
  if (!counted && !Number.isInteger(num)) return;
  if (state.lastPublished === num) return;
  state.lastPublished = num;
  await publish(round.number);
  // v126 : fin de dizaine (jeu finissant par 9) → récap aligné 0-1, 2-3, 4-5, 6-7, 8-9, une seule fois par numéro
  if (num % 10 === 9 && state.lastRecap !== num) {
    state.lastRecap = num;
    try { await dizaineRecap(num); } catch (e) { state.lastError = e.message; console.error('Compte parité (fin de dizaine) :', e.message); }
  }
}

// Bilan envoyé à chaque reset automatique (heure pile pour 60 min) : un message par côté choisi, PUIS remise à zéro.
// Rien n'est envoyé si aucun jeu n'a été compté depuis le dernier reset.
async function sendBilan() {
  if (!state.enabled || !state.channelId || !sendFn || !state.games) return false;
  let ok = false;
  for (const side of sidesToSend()) {
    try { await sendFn(state.channelId, buildMessage(side, state.lastGameNumber, { bilan: true })); ok = true; state.sentCount += 1; state.lastSentAt = Date.now(); state.lastError = null; }
    catch (e) { state.lastError = e.message; console.error('Compte parité (bilan) :', e.message); }
    // v130 : bilan des dizaines de l'heure avec un costume proposé par fin de numéro
    try { await sendFn(state.channelId, buildProposalMessage(side)); state.sentCount += 1; state.lastSentAt = Date.now(); state.lastError = null; }
    catch (e) { state.lastError = e.message; console.error('Compte parité (bilan des dizaines) :', e.message); }
  }
  return ok;
}

let resetTimer = null;
function scheduleReset() {
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(async () => {
    // v124 : si l'envoi du bilan ne répond pas (Telegram), le reset a lieu quand même après 30 s
    try { await Promise.race([sendBilan(), new Promise((r) => { const t = setTimeout(r, 30000); if (t.unref) t.unref(); })]); } catch (_) {}
    resetCounts();
    scheduleReset();
  }, msUntilNextReset());
  if (resetTimer.unref) resetTimer.unref();
}

async function test(gameNumber) {
  if (!state.channelId) return { ok: false, error: 'Aucun canal configuré' };
  if (!sendFn) return { ok: false, error: 'Aucun token Telegram configuré' };
  const errors = []; let sent = 0;
  for (const side of sidesToSend()) {
    try { await sendFn(state.channelId, buildMessage(side, gameNumber)); sent += 1; } catch (e) { errors.push(e.message); }
    if (state.games) { try { await sendFn(state.channelId, buildProposalMessage(side)); sent += 1; } catch (e) { errors.push(e.message); } } // v130 : aperçu du bilan des dizaines
  }
  if (errors.length) state.lastError = errors[0];
  return { ok: sent > 0, sent, errors };
}

function status(gameNumber) {
  const view = (c) => ({
    pair: [...c.pair], impair: [...c.impair],
    pairSuits: c.suits.pair.map(suitCells), impairSuits: c.suits.impair.map(suitCells),
    pairTotal: c.pair.reduce((s, n) => s + n, 0),
    impairTotal: c.impair.reduce((s, n) => s + n, 0),
    details: details.detailsView(c.pair, c.impair),
  });
  return {
    ...config(),
    games: state.games, sinceAt: state.sinceAt, nextResetMs: msUntilNextReset(),
    player: view(state.player), banker: view(state.banker),
    previews: [...sidesToSend().map((side) => ({ side, text: buildMessage(side, gameNumber) })), ...sidesToSend().filter(() => state.games > 0).map((side) => ({ side, text: buildProposalMessage(side) }))],
    sentCount: state.sentCount, lastSentAt: state.lastSentAt, lastError: state.lastError,
  };
}

module.exports = {
  state, setSender, setChannel, getChannel, config, configure, persist, restore, restoreFromDb,
  palier, bump, publish, onFinished, buildMessage, buildProposalMessage, proposalOf, buildDizaineMessage, dizaineRecap, topSuitsOf, sendBilan, resetCounts, scheduleReset, test, status,
};
