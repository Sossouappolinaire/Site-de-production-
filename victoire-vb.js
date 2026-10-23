// victoire-vb.js — nouvelle stratégie « Victoire V1 / V2 » (demande admin).
//
// V1 = VICTOIRE DU JOUEUR, V2 = VICTOIRE DU BANQUIER. Comme le message à deux costumes, les deux sont envoyés
// ENSEMBLE dans un seul message (le plus probable en haut, avec son pourcentage) :
//
//       V1 62%
//        ┣━ N°532⏳
//       V2 31%
//
//  Vérification (rattrapages configurables, N, N+1 … N+R) : le premier jeu où le joueur OU le banquier gagne valide
//  le côté correspondant (✅0️⃣ = direct, ✅1️⃣ = 1er rattrapage…). Un match nul ne valide personne (on passe au
//  rattrapage suivant). Rien ne valide sur tous les rattrapages : les deux sont ❌.
//
//  MÊME MÉCANISME QUE LES DEUX COSTUMES (bouton Relance) :
//   • dès qu'un côté est validé, on ATTEND L'AUTRE ;
//   • si l'autre ne valide pas à +1 (jeu suivant, réglable), il est prédit à nouveau à N+3 (réglable) :
//     le même message est édité, on y ajoute seulement le numéro de la relance (N°535⏳) ;
//       V1 ✅0️⃣ 62%
//        ┣━ N°532
//        ┣━ N°535⏳
//       V2 ⏳ 31%
//   • la relance est vérifiée à son tour (mêmes rattrapages) : ✅ si l'autre côté gagne, ❌ sinon.
//
//  DÉCLENCHEURS AUTOMATIQUES : une règle = « après tel(s) gagnant(s) (et/ou telle distribution de cartes) du jeu
//  terminé N, prédire V1/V2 au jeu N+n ». L'analyse (historique des jeux gardé sur plusieurs sabots) cherche
//  elle-même les déclencheurs et le décalage +n qui VALIDENT vraiment : taux de réussite net et statistiquement
//  significatif au-dessus du taux général. Elle AJOUTE, MODIFIE (autre +n) ou SUPPRIME les règles toute seule
//  (case « Appliquer automatiquement ») ; sinon chaque trouvaille part dans le CHAT PRIVÉ de l'administrateur en
//  liste de boutons « Appliquer » (/victoire). Aucune règle n'est inventée : tant que l'historique ne montre pas
//  de déclencheur net, rien n'est envoyé.
'use strict';
const strategyRecap = require('./strategy-recap');

const store = require('./store');
const db = require('./db');
const { state, addSiteChannelMessage, siteChannelsView, setOnShoeReset } = require('./predictor');

const STORE_KEY = 'victoireVb';
const DB_KEY = 'victoire_vb_state';

const LETTER = { V1: 'J', V2: 'B' };
const otherSide = (s) => (s === 'V1' ? 'V2' : 'V1');
const OFFSETS = [1, 2, 3, 4, 5];
const MAX_RULES = 12;
// Sensibilité de l'analyse : plus elle est large, plus elle trouve de déclencheurs (mais plus certains peuvent être du hasard)
const PRESETS = {
  strict: { minN: 20, minNDel: 30, minZ: 2.3, gain: 0.08, modGain: 0.05, minRate: 60, label: 'Stricte' },
  normal: { minN: 15, minNDel: 25, minZ: 1.5, gain: 0.05, modGain: 0.04, minRate: 56, label: 'Normale' },
  large: { minN: 5, minNDel: 20, minZ: 0, gain: 0, modGain: 0.1, minRate: 50, label: 'Large (dès 10 jeux)' },
};
// Règle PAR DÉFAUT (demande admin) : après un match nul, prédit à +1 ; V1 en haut (le côté de la règle reste en tête),
// V2 dessous. Elle n'est jamais modifiée ni supprimée par l'analyse ; l'admin peut la désactiver ou la supprimer.
const DEFAULT_RULE_ID = 'DEF-NUL';
const defaultRule = () => ({ id: DEFAULT_RULE_ID, seq: 'T', p: null, b: null, offset: 1, side: 'V1', enabled: true, auto: false, locked: true });
const thr = () => PRESETS[panel.sensitivity] || PRESETS.large;
const MAX_FINDINGS = 8;
const ANALYSIS_EVERY = 20;   // nouvelle analyse tous les 20 jeux enregistrés
const LOG_MAX = 8000;        // jeux gardés (plusieurs sabots)
const MIN_SAMPLE = 5;
const DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const digitEmoji = (n) => { const i = Math.max(0, parseInt(n, 10) || 0); return i < DIGITS.length ? DIGITS[i] : `(${i})`; };

const emptyStats = () => ({ sent: 0, won: 0, lost: 0, wV1: 0, wV2: 0, second: 0, relSent: 0, relWon: 0, relLost: 0 });
const panel = {
  enabled: true,
  notify: true,           // l'analyse écrit au chat privé quand elle trouve / applique quelque chose
  autoApply: true,        // l'analyse applique elle-même les règles trouvées
  channels: [],
  siteChannelId: null,
  msgFormat: 'classic',   // mise en page du message : 'classic' (V1 ✅0️⃣ 72% ┣━ N°…) ou 'compact' (une ligne par côté : V1 72% ✅0️⃣)
  relanceChannels: [],    // canal(aux) qui reçoivent les RELANCES (message simple par relance) ; vide = relance dans le message d'origine
  relanceMaxR: 1,         // rattrapages de la relance
  maxR: 1,                // rattrapages
  waitGames: 1,           // « l'autre ne valide pas à +1 »
  relanceGap: 3,          // relance à N+3
  sensitivity: 'large',   // strict | normal | large : seuils de l'analyse
  rules: [],
  defaultDropped: false,  // l'admin a supprimé la règle par défaut « après un nul → +1 »
  pending: [],
  stats: {},
  log: '',                // 1 caractère par jeu : a-l (voir codeOf), ? inconnu, | changement de sabot
  lastLogged: 0,
  loggedCount: 0,
  analysisMark: 0,
  notified: {},           // sid → date (trouvailles déjà envoyées)
  dismissed: {},          // sid → date (trouvailles ignorées / appliquées)
  lastScanned: 0,
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastAnalysisAt: null,
  lastError: null,
};
const statsOf = (id) => panel.stats[id] || (panel.stats[id] = emptyStats());

let sender = null;
let adminIdFn = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
function setAdminId(fn) { adminIdFn = typeof fn === 'function' ? fn : null; }
const siteEntries = new Map(); // entryId → bulle du site
let busy = false;

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------
function parseChannels(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    if (/^-?\d+$/.test(t)) { const n = Number(t); if (Number.isFinite(n) && n !== 0 && !out.includes(n)) out.push(n); }
    else { const name = t.startsWith('@') ? t : `@${t.replace(/^https?:\/\/t\.me\//i, '')}`; if (name.length > 2 && !out.includes(name)) out.push(name); }
  }
  return out;
}
function sanitizeSiteChannelId(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value);
}
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const sanitizeMaxR = (v) => clampInt(v, 0, 9, 1);
const sanitizeWait = (v) => clampInt(v, 1, 3, 1);
const sanitizeGap = (v, wait) => clampInt(v, (wait || 1) + 1, 9, 3);

function config() {
  return {
    enabled: panel.enabled, notify: panel.notify, autoApply: panel.autoApply, channels: [...panel.channels], siteChannelId: panel.siteChannelId,
    relanceChannels: [...panel.relanceChannels], relanceMaxR: panel.relanceMaxR,
    maxR: panel.maxR, waitGames: panel.waitGames, relanceGap: panel.relanceGap, sensitivity: panel.sensitivity, msgFormat: panel.msgFormat,
  };
}
function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.notify !== undefined) panel.notify = !!patch.notify;
  if (patch.autoApply !== undefined) panel.autoApply = !!patch.autoApply;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) panel.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.maxR !== undefined) panel.maxR = sanitizeMaxR(patch.maxR);
  if (patch.relanceChannels !== undefined) panel.relanceChannels = parseChannels(patch.relanceChannels);
  if (patch.relanceMaxR !== undefined) panel.relanceMaxR = sanitizeMaxR(patch.relanceMaxR);
  if (patch.waitGames !== undefined) panel.waitGames = sanitizeWait(patch.waitGames);
  if (patch.relanceGap !== undefined || patch.waitGames !== undefined) panel.relanceGap = sanitizeGap(patch.relanceGap !== undefined ? patch.relanceGap : panel.relanceGap, panel.waitGames);
  if (patch.sensitivity !== undefined) panel.sensitivity = PRESETS[patch.sensitivity] ? patch.sensitivity : 'large';
  if (patch.msgFormat !== undefined) panel.msgFormat = patch.msgFormat === 'compact' ? 'compact' : 'classic';
  persist();
  return config();
}

// ---------------------------------------------------------------------------
// Persistance (data.json + base), comme draw-two-three.js
// ---------------------------------------------------------------------------
const trimMap = (o, max = 200) => { const e = Object.entries(o || {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, max); return Object.fromEntries(e); };
function persist() {
  const saved = {
    config: config(), rules: panel.rules, defaultDropped: panel.defaultDropped, pending: panel.pending.map((e) => (e.relance && e.relance.sendP ? { ...e, relance: { ...e.relance, sendP: undefined } } : e)), stats: panel.stats, lastScanned: panel.lastScanned,
    log: panel.log, lastLogged: panel.lastLogged, loggedCount: panel.loggedCount, analysisMark: panel.analysisMark,
    notified: trimMap(panel.notified), dismissed: trimMap(panel.dismissed),
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt, lastAnalysisAt: panel.lastAnalysisAt,
  };
  try { store.patch({ [STORE_KEY]: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function sanitizeRule(r) {
  if (!r || typeof r !== 'object') return null;
  const seq = String(r.seq == null ? '' : r.seq).toUpperCase().replace(/[^JBT]/g, '').slice(-3);
  const p = r.p === null || r.p === undefined ? null : Number(r.p);
  const b = r.b === null || r.b === undefined ? null : Number(r.b);
  if ((p !== null && p !== 2 && p !== 3) || (b !== null && b !== 2 && b !== 3)) return null;
  if (!seq && p === null && b === null) return null;
  const offset = clampInt(r.offset, 1, 9, 1);
  const side = r.side === 'V2' ? 'V2' : 'V1';
  const id = String(r.id || `R${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`);
  return { id, seq, p, b, offset, side, enabled: r.enabled !== false, auto: !!r.auto, locked: id === DEFAULT_RULE_ID };
}
function ensureDefaultRule() {
  if (!panel.defaultDropped && !panel.rules.some((r) => r.id === DEFAULT_RULE_ID)) panel.rules.unshift(defaultRule());
}
ensureDefaultRule();
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  if (saved.config) {
    panel.enabled = saved.config.enabled !== false;
    panel.notify = saved.config.notify !== false;
    panel.autoApply = saved.config.autoApply !== false;
    panel.channels = parseChannels(saved.config.channels);
    panel.siteChannelId = sanitizeSiteChannelId(saved.config.siteChannelId);
    panel.maxR = sanitizeMaxR(saved.config.maxR);
    panel.relanceChannels = parseChannels(saved.config.relanceChannels);
    panel.relanceMaxR = sanitizeMaxR(saved.config.relanceMaxR === undefined ? saved.config.maxR : saved.config.relanceMaxR);
    panel.waitGames = sanitizeWait(saved.config.waitGames);
    panel.relanceGap = sanitizeGap(saved.config.relanceGap, panel.waitGames);
    panel.sensitivity = PRESETS[saved.config.sensitivity] ? saved.config.sensitivity : 'large';
    panel.msgFormat = saved.config.msgFormat === 'compact' ? 'compact' : 'classic';
  }
  if (Array.isArray(saved.rules)) panel.rules = saved.rules.map(sanitizeRule).filter(Boolean).slice(0, MAX_RULES);
  panel.defaultDropped = !!saved.defaultDropped;
  ensureDefaultRule();
  if (Array.isArray(saved.pending)) panel.pending = saved.pending.slice(-200);
  if (saved.stats && typeof saved.stats === 'object') panel.stats = Object.fromEntries(Object.entries(saved.stats).map(([k, v]) => [k, { ...emptyStats(), ...(v || {}) }]));
  if (typeof saved.log === 'string') panel.log = saved.log.replace(/[^a-l?|]/g, '').slice(-LOG_MAX);
  for (const k of ['lastScanned', 'lastLogged', 'loggedCount', 'analysisMark', 'sentCount']) if (Number.isFinite(Number(saved[k]))) panel[k] = Number(saved[k]);
  if (saved.notified && typeof saved.notified === 'object') panel.notified = { ...saved.notified };
  if (saved.dismissed && typeof saved.dismissed === 'object') panel.dismissed = { ...saved.dismissed };
  panel.lastSentAt = saved.lastSentAt || null;
  panel.lastScanAt = saved.lastScanAt || null;
  panel.lastAnalysisAt = saved.lastAnalysisAt || null;
}
function restore() { try { applySaved((store.read() || {})[STORE_KEY]); } catch (_) {} return config(); }
async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting(DB_KEY);
    if (raw) applySaved(JSON.parse(raw)); else persist();
  } catch (_) { persist(); }
  seedFromDb(false).catch(() => {}); // historique court : on le complète avec les jeux déjà en base
  return config();
}

// Historique des jeux déjà enregistrés en base (plusieurs sabots) : l'analyse a tout de suite de quoi travailler
async function seedFromDb(force = false) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée' };
  const have = panel.log.replace(/[|?]/g, '').length;
  if (!force && have >= 300) return { ok: true, skipped: true, games: have };
  const rows = await db.rows('SELECT number, winner, player_count, banker_count FROM games ORDER BY played_on DESC, number DESC LIMIT $1', [LOG_MAX]);
  rows.reverse();
  const current = new Set([...state.games.keys()]); // le sabot en cours est relu depuis la mémoire par appendLog
  let log = ''; let prev = null; let count = 0;
  for (const r of rows) {
    const n = Number(r.number);
    if (!Number.isFinite(n) || current.has(n)) continue;
    if (prev !== null && n !== prev + 1 && !log.endsWith('|')) log += '|';
    prev = n;
    const wi = r.winner === 'Joueur' ? 0 : r.winner === 'Banquier' ? 1 : r.winner === 'Égalité' ? 2 : -1;
    const p = Number(r.player_count); const b = Number(r.banker_count);
    log += (wi < 0 || (p !== 2 && p !== 3) || (b !== 2 && b !== 3)) ? '?' : String.fromCharCode(97 + wi * 4 + (p === 3 ? 2 : 0) + (b === 3 ? 1 : 0));
    count += 1;
  }
  if (!count) return { ok: true, games: 0 };
  panel.log = (log + '|').replace(/\|+/g, '|').slice(-LOG_MAX);
  panel.lastLogged = 0; // appendLog relit le sabot en cours après l'historique
  panel.loggedCount += count;
  persist();
  return { ok: true, games: count };
}

// ---------------------------------------------------------------------------
// Lecture des jeux
// ---------------------------------------------------------------------------
const cardCount = (v) => (Array.isArray(v) ? v.length : (Number.isFinite(Number(v)) ? Number(v) : 0));
const usable = (g) => !!g && g.finished && g.complete !== false && cardCount(g.playerCards) > 0 && cardCount(g.bankerCards) > 0;
function winnerLetter(g) {
  if (!g) return null;
  if (g.winner === 'Joueur') return 'J';
  if (g.winner === 'Banquier') return 'B';
  if (g.winner === 'Égalité') return 'T';
  const pv = Number(g.playerValue); const bv = Number(g.bankerValue);
  if (g.playerValue != null && g.bankerValue != null && g.playerValue !== '' && g.bankerValue !== '' && Number.isFinite(pv) && Number.isFinite(bv)) return pv > bv ? 'J' : pv < bv ? 'B' : 'T';
  return null;
}
function maxFinishedGameNumber() { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; }

// code d'un jeu : lettre a-l = 4 × gagnant (J=0, B=1, T=2) + 2 si joueur 3 cartes + 1 si banquier 3 cartes ; ? = inconnu
function codeOf(g) {
  if (!usable(g)) return '?';
  const w = winnerLetter(g);
  const wi = w === 'J' ? 0 : w === 'B' ? 1 : w === 'T' ? 2 : -1;
  const p = cardCount(g.playerCards); const b = cardCount(g.bankerCards);
  if (wi < 0 || (p !== 2 && p !== 3) || (b !== 2 && b !== 3)) return '?';
  return String.fromCharCode(97 + wi * 4 + (p === 3 ? 2 : 0) + (b === 3 ? 1 : 0));
}
function decode(ch) {
  const c = ch.charCodeAt(0) - 97;
  if (!(c >= 0 && c <= 11)) return null;
  return { w: 'JBT'[Math.floor(c / 4)], p: (c & 2) ? 3 : 2, b: (c & 1) ? 3 : 2 };
}

// ajoute les nouveaux jeux terminés à l'historique (gardé sur plusieurs sabots)
function appendLog() {
  const maxDone = maxFinishedGameNumber();
  if (maxDone < panel.lastLogged) { panel.log += '|'; panel.lastLogged = 0; } // numéros repartis à 1 sans passer par le reset
  let added = 0;
  for (let n = panel.lastLogged + 1; n <= maxDone; n++) { panel.log += codeOf(state.games.get(n)); added += 1; }
  panel.lastLogged = maxDone;
  panel.loggedCount += added;
  if (panel.log.length > LOG_MAX) panel.log = panel.log.slice(-LOG_MAX);
}
let parsedCache = { log: null, segs: [] };
function parsed() {
  if (parsedCache.log !== panel.log) {
    parsedCache = { log: panel.log, segs: panel.log.split('|').filter((x) => x.length).map((s) => Array.from(s).map((ch) => (ch === '?' ? null : decode(ch)))) };
  }
  return parsedCache.segs;
}

// ---------------------------------------------------------------------------
// Règles (déclencheurs) et taux observés
// ---------------------------------------------------------------------------
const NAME = { J: 'Joueur', B: 'Banquier', T: 'Nul' };
const seqLabel = (seq) => seq.split('').map((c) => NAME[c]).join(' → ');
const ruleLabel = (r) => {
  const parts = [];
  if (r.seq) parts.push(r.seq.length === 1 ? `${NAME[r.seq]} gagne` : `Gagnants ${seqLabel(r.seq)}`);
  if (r.p !== null || r.b !== null) parts.push(`cartes ${r.p ?? '?'}/${r.b ?? '?'} (joueur/banquier)`);
  return parts.join(' · ');
};
const ruleText = (r) => `${ruleLabel(r)} → N+${r.offset} (${r.side})`;
const sameCond = (a, b) => a.seq === b.seq && a.p === b.p && a.b === b.b;
const sameRule = (a, b) => sameCond(a, b) && a.side === b.side; // V1 et V2 ont chacun leurs déclencheurs, trouvés séparément

// le jeu d'indice i du segment correspond-il au déclencheur ?
function matchAt(rule, seg, i) {
  const cur = seg[i];
  if (!cur) return false;
  if (rule.p !== null && rule.p !== cur.p) return false;
  if (rule.b !== null && rule.b !== cur.b) return false;
  const k = rule.seq.length;
  if (k) {
    if (i - k + 1 < 0) return false;
    for (let j = 0; j < k; j++) { const s = seg[i - k + 1 + j]; if (!s || s.w !== rule.seq[j]) return false; }
  }
  return true;
}
// fenêtre « jeu visé + rattrapages » : premier gagnant joueur / banquier (J, B), N = aucun, null = pas jouée en entier
function windowFirst(seg, start, maxR) {
  for (let r = 0; r <= maxR; r++) {
    const x = seg[start + r];
    if (x === undefined || x === null) return null;
    if (x.w === 'J' || x.w === 'B') return x.w;
  }
  return 'N';
}
function rateFor(match, offset, maxR = panel.maxR) {
  const r = { n: 0, J: 0, B: 0, N: 0 };
  for (const seg of parsed()) {
    for (let i = 0; i < seg.length; i++) {
      if (!seg[i] || !match(seg, i)) continue;
      const w = windowFirst(seg, i + offset, maxR);
      if (!w) continue;
      r.n += 1; r[w] += 1;
    }
  }
  return r;
}
function baseRate(maxR = panel.maxR) {
  const r = { n: 0, J: 0, B: 0, N: 0 };
  for (const seg of parsed()) {
    for (let i = 0; i < seg.length; i++) {
      const w = windowFirst(seg, i, maxR);
      if (!w) continue;
      r.n += 1; r[w] += 1;
    }
  }
  return r;
}
function pct(hits, n, baseHits, baseN) {
  const use = n >= MIN_SAMPLE ? { h: hits, n } : (baseN > 0 ? { h: baseHits, n: baseN } : { h: 0, n: 0 });
  if (!use.n) return 50;
  return Math.max(1, Math.min(99, Math.round((100 * (use.h + 1)) / (use.n + 2)))); // Laplace
}
const zOf = (hits, n, p0) => (!n || p0 <= 0 || p0 >= 1 ? 0 : (hits / n - p0) / Math.sqrt((p0 * (1 - p0)) / n));
function percentsFor(rule) {
  const r = rateFor((seg, i) => matchAt(rule, seg, i), rule.offset);
  const base = baseRate();
  return { p1: pct(r.J, r.n, base.J, base.n), p2: pct(r.B, r.n, base.B, base.n), n: r.n, observed: r };
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------
function sideLine(entry, side) {
  const pc = side === 'V1' ? entry.p1 : entry.p2;
  const h = entry.hit ? entry.hit[side] : null;
  const rl = entry.relance;
  const isOther = !!entry.first && entry.first.side !== side;
  let mark = '';
  if (h !== null && h !== undefined) mark = ` ✅${digitEmoji(h)}`;
  else if (entry.status === 'perdu') mark = ' ❌';
  else if (isOther) {
    if (rl && rl.status === 'gagné') mark = ` ✅${digitEmoji(rl.hit)}`;
    else if (rl && rl.status === 'perdu') mark = ' ❌';
    else if (rl && rl.status === 'en attente') mark = ' ⏳';
    else if (entry.phase === 'second') mark = ' ⏳';
    else mark = ' ➖';
  }
  return `${side}${mark} ${pc}%`;
}
// Format « compact » : une ligne par côté, résultat à la suite du pourcentage, relance sur la ligne du côté relancé
//   ⚔️ N°1438⏳
//   V1 72% ✅0️⃣
//   V2 68% ⏳ → N°1441⏳
function compactSideLine(entry, side) {
  const pc = side === 'V1' ? entry.p1 : entry.p2;
  const h = entry.hit ? entry.hit[side] : null;
  const rl = entry.relance;
  const isOther = !!entry.first && entry.first.side !== side;
  let mark = '';
  if (h !== null && h !== undefined) mark = ` ✅${digitEmoji(h)}`;
  else if (entry.status === 'perdu') mark = ' ❌';
  else if (isOther) {
    if (rl && rl.status === 'gagné') mark = ` ✅${digitEmoji(rl.hit)}`;
    else if (rl && rl.status === 'perdu') mark = ' ❌';
    else if (rl && rl.status === 'en attente') mark = ' ⏳';
    else if (entry.phase === 'second') mark = ' ⏳';
    else mark = ' ➖';
  }
  let line = `${side} ${pc}%${mark}`;
  if (isOther && rl && rl.status !== 'ignorée' && !rl.own) line += ` → N°${rl.target}${rl.status === 'en attente' ? '⏳' : ''}`;
  return line;
}
function compactMessageText(entry) {
  const order = entry.forceTop ? [entry.forceTop, otherSide(entry.forceTop)]
    : [{ k: 'V1', v: entry.p1 }, { k: 'V2', v: entry.p2 }].sort((a, b) => b.v - a.v).map((x) => x.k);
  return [`⚔️ N°${entry.target}${entry.status === 'en attente' ? '⏳' : ''}`, compactSideLine(entry, order[0]), compactSideLine(entry, order[1])].join('\n');
}
function messageText(entry) {
  if (panel.msgFormat === 'compact') return compactMessageText(entry);
  const order = entry.forceTop ? [entry.forceTop, otherSide(entry.forceTop)] // règle par défaut : son côté (V1) en tête
    : [{ k: 'V1', v: entry.p1 }, { k: 'V2', v: entry.p2 }].sort((a, b) => b.v - a.v).map((x) => x.k); // le plus probable en haut
  const tail = entry.status === 'en attente' ? '⏳' : '';
  const lines = [sideLine(entry, order[0]), ` ┣━ N°${entry.target}${tail}`];
  const rl = entry.relance;
  if (rl && rl.status !== 'ignorée' && !rl.own) {
    const m = rl.status === 'en attente' ? '⏳' : rl.status === 'gagné' ? `✅${digitEmoji(rl.hit)}` : rl.status === 'perdu' ? '❌' : '➖';
    lines.push(` ┣━ N°${rl.target}${m}`);
  }
  lines.push(sideLine(entry, order[1]));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Envoi / édition
// ---------------------------------------------------------------------------
async function sendEntry(entry) {
  const targetChannels = panel.channels;
  const targetSite = panel.siteChannelId;
  if (!targetChannels.length && (targetSite === null || targetSite === undefined || targetSite === '')) {
    panel.lastError = 'Aucun canal configuré pour « Victoire V1 / V2 »';
    return false;
  }
  const text = messageText(entry);
  const errors = [];
  let ok = false;
  if (targetChannels.length) {
    const bot = sender ? sender() : null;
    if (!bot) errors.push('Aucun token Telegram configuré');
    else {
      for (const id of targetChannels) {
        try { const m = await bot.sendMessage(id, text); entry.messages.push({ chatId: id, messageId: m.message_id }); ok = true; }
        catch (e) { errors.push(`${id} : ${e.message}`); }
      }
    }
  }
  if (targetSite !== null && targetSite !== undefined && targetSite !== '') {
    const posted = addSiteChannelMessage(targetSite, { sender: 'Victoire V1 / V2', text });
    if (posted) { ok = true; siteEntries.set(entry.id, posted); } else errors.push(`Canal du site introuvable (id ${targetSite})`);
  }
  if (!ok) { panel.lastError = errors[0] || 'Envoi impossible'; return false; }
  entry.usedChannels = [...targetChannels];
  entry.usedSite = targetSite ?? null;
  panel.sentCount += 1; panel.lastSentAt = Date.now();
  panel.lastError = errors.length ? errors[0] : null;
  return true;
}
function editEntry(entry) {
  const text = messageText(entry);
  const siteMsg = siteEntries.get(entry.id);
  if (siteMsg) { siteMsg.text = text; if (entry.phase === 'done') siteEntries.delete(entry.id); }
  const bot = sender ? sender() : null;
  if (!bot) return;
  for (const m of entry.messages) {
    bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId })
      .catch(() => { setTimeout(() => { try { bot.editMessageText(messageText(entry), { chat_id: m.chatId, message_id: m.messageId }).catch(() => {}); } catch (_) {} }, 4000); });
  }
}

// message simple de la RELANCE (canal des relances) : un seul côté, son pourcentage, son numéro
function relMessageText(entry) {
  const rl = entry.relance; const side = otherSide(entry.first.side);
  const pc = side === 'V1' ? entry.p1 : entry.p2;
  const mark = rl.status === 'gagné' ? ` ✅${digitEmoji(rl.hit)}` : rl.status === 'perdu' ? ' ❌' : rl.status === 'annulé' ? ' ➖' : '';
  const tail = rl.status === 'en attente' ? '⏳' : '';
  if (panel.msgFormat === 'compact') return `⚔️ ${side} ${pc}%${mark} → N°${rl.target}${tail}`;
  return `${side}${mark} ${pc}%\n ┣━ N°${rl.target}${tail}`;
}
async function sendRelance(entry) {
  const rl = entry.relance; rl.messages = [];
  const bot = sender ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return; }
  const text = relMessageText(entry);
  for (const id of panel.relanceChannels) {
    try { const m = await bot.sendMessage(id, text); rl.messages.push({ chatId: id, messageId: m.message_id }); }
    catch (e) { panel.lastError = `Relance ${id} : ${e.message}`; }
  }
}
function editRelance(entry) {
  const rl = entry.relance;
  if (!rl || !rl.own) return;
  Promise.resolve(rl.sendP).then(() => {
    const bot = sender ? sender() : null;
    if (!bot) return;
    const text = relMessageText(entry);
    for (const m of (rl.messages || [])) {
      bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId })
        .catch(() => { setTimeout(() => { try { bot.editMessageText(relMessageText(entry), { chat_id: m.chatId, message_id: m.messageId }).catch(() => {}); } catch (_) {} }, 4000); });
    }
  });
}

// ---------------------------------------------------------------------------
// Détection des déclencheurs (règles)
// ---------------------------------------------------------------------------
const alreadyHave = (target) => panel.pending.some((e) => (e.target === target || (e.relance && e.relance.target === target && e.relance.status === 'en attente')) && e.status !== 'annulé');
const gameStarted = (target, maxDone) => {
  const tg = state.games.get(target);
  return target <= maxDone || (tg && (tg.finished || cardCount(tg.playerCards) > 0 || cardCount(tg.bankerCards) > 0));
};
async function scanTriggers() {
  const maxDone = maxFinishedGameNumber();
  if (!panel.lastScanned || panel.lastScanned > maxDone) { panel.lastScanned = maxDone; return; } // 1er passage : pas de rattrapage du passé
  const segs = parsed();
  const cur = segs.length && !panel.log.endsWith('|') ? segs[segs.length - 1] : null;
  if (cur) {
    for (let n = panel.lastScanned + 1; n <= maxDone; n++) {
      const idx = cur.length - 1 - (maxDone - n);
      if (idx < 0 || !cur[idx]) continue;
      for (const rule of panel.rules) {
        if (!rule.enabled || !matchAt(rule, cur, idx)) continue;
        const target = n + rule.offset;
        if (alreadyHave(target) || gameStarted(target, maxDone)) continue; // doublon, ou trop tard : jeu déjà joué / distribué
        const p = percentsFor(rule);
        const entry = {
          id: `vv-${target}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          trigger: rule.id, ruleLabel: ruleText(rule), source: n, target, p1: p.p1, p2: p.p2, sample: p.n, mainSide: rule.side, forceTop: rule.locked ? rule.side : null,
          status: 'en attente', phase: 'first', step: 0, gap: 0, skipped: 0, maxR: panel.maxR, waitGames: panel.waitGames, relanceGap: panel.relanceGap,
          hit: { V1: null, V2: null }, first: null, wstep: 0, lastNum: null, relance: null,
          messages: [], usedChannels: [], usedSite: null,
          createdAt: Date.now(), sentAt: null, resolvedAt: null, doneAt: null,
        };
        if (await sendEntry(entry)) {
          entry.sentAt = Date.now();
          panel.pending.push(entry);
          statsOf(rule.id).sent += 1;
        }
      }
    }
  }
  panel.lastScanned = maxDone;
}

// ---------------------------------------------------------------------------
// Vérification : rattrapages, attente de l'autre côté, relance
// ---------------------------------------------------------------------------
// prochain jeu d'une fenêtre { target, step, gap, skipped } : { num, w } | { wait } | { retry } | { cancelled }
function nextGame(win, maxDone) {
  const num = win.target + win.step + win.gap;
  const g = state.games.get(num);
  if (!usable(g)) {
    if (num + 2 <= maxDone) { // jeu manquant : on décale
      win.gap += 1; win.skipped += 1;
      return win.skipped > 6 ? { cancelled: true } : { retry: true };
    }
    return { wait: true };
  }
  return { num, w: winnerLetter(g) };
}
const finish = (e) => { e.phase = 'done'; e.doneAt = Date.now(); if (!e.resolvedAt) e.resolvedAt = e.doneAt; };

function verifyEntry(e, maxDone) {
  const st = statsOf(e.trigger);
  // 1) premier côté : rattrapages N, N+1 … N+R
  if (e.phase === 'first') {
    let guard = 0;
    while (e.phase === 'first' && guard++ <= e.maxR + e.gap + 8) {
      const r = nextGame(e, maxDone);
      if (r.wait) break;
      if (r.cancelled) { e.status = 'annulé'; finish(e); break; }
      if (r.retry) continue;
      if (r.w === 'J' || r.w === 'B') { // un côté est validé : on attend l'autre
        const side = r.w === 'J' ? 'V1' : 'V2';
        e.hit[side] = e.step; e.first = { side, step: e.step, num: r.num };
        e.status = 'gagné'; e.phase = 'second'; e.wstep = 1; e.lastNum = r.num; e.resolvedAt = Date.now();
        strategyRecap.noteEntry(e);
        st.won += 1; st[`w${side}`] += 1;
        editEntry(e);
        break;
      }
      if (e.step >= e.maxR) { // ni joueur ni banquier (nuls) sur tous les rattrapages
        e.status = 'perdu'; finish(e); strategyRecap.noteEntry(e); st.lost += 1; editEntry(e); break;
      }
      e.step += 1;
    }
  }
  // 2) l'autre côté doit valider à +1 (réglable) ; sinon il est relancé
  if (e.phase === 'second') {
    const other = otherSide(e.first.side);
    while (e.phase === 'second') {
      const num = e.lastNum + e.wstep;
      const g = state.games.get(num);
      if (!usable(g)) {
        if (num + 2 <= maxDone) { finish(e); editEntry(e); } // jeu manquant : pas de relance au hasard
        break;
      }
      if (winnerLetter(g) === LETTER[other]) { // l'autre valide à +1
        e.hit[other] = num - e.target; st.second += 1; finish(e); editEntry(e); break;
      }
      if (e.wstep < e.waitGames) { e.wstep += 1; continue; }
      // l'autre n'a pas validé à +1 : relance à N+3 (N = jeu du côté validé), même message édité
      const relTarget = e.first.num + e.relanceGap;
      if (gameStarted(relTarget, maxDone)) { e.relance = { target: relTarget, status: 'ignorée' }; finish(e); editEntry(e); break; }
      e.relance = { target: relTarget, step: 0, gap: 0, skipped: 0, hit: null, status: 'en attente', maxR: panel.relanceChannels.length ? panel.relanceMaxR : e.maxR, own: panel.relanceChannels.length > 0 };
      e.phase = 'relance'; st.relSent += 1;
      if (e.relance.own) e.relance.sendP = sendRelance(e);
      editEntry(e);
      break;
    }
  }
  // 3) relance de l'autre côté (mêmes rattrapages)
  if (e.phase === 'relance') {
    const rl = e.relance; const other = otherSide(e.first.side);
    let guard = 0;
    const rMax = rl.maxR === undefined ? e.maxR : rl.maxR;
    while (e.phase === 'relance' && guard++ <= rMax + rl.gap + 8) {
      const r = nextGame(rl, maxDone);
      if (r.wait) break;
      if (r.cancelled) { rl.status = 'annulé'; finish(e); editEntry(e); editRelance(e); break; }
      if (r.retry) continue;
      if (r.w === LETTER[other]) { rl.hit = rl.step; rl.status = 'gagné'; st.relWon += 1; finish(e); editEntry(e); editRelance(e); break; }
      if (rl.step >= rMax) { rl.status = 'perdu'; st.relLost += 1; finish(e); editEntry(e); editRelance(e); break; }
      rl.step += 1;
    }
  }
}
function verifyPending() {
  const maxDone = maxFinishedGameNumber();
  for (const entry of panel.pending) {
    if (entry.phase === 'done') continue;
    verifyEntry(entry, maxDone);
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pending = panel.pending.filter((e) => e.phase !== 'done' || !e.doneAt || e.doneAt >= cutoff);
}

setOnShoeReset(() => {
  panel.lastScanned = 0;
  panel.lastLogged = 0;
  if (panel.log && !panel.log.endsWith('|')) panel.log += '|'; // nouveau sabot : séparateur dans l'historique
  for (const e of panel.pending) {
    if (e.phase === 'done') continue;
    if (e.phase === 'first') e.status = 'annulé';
    else if (e.relance && e.relance.status === 'en attente') { e.relance.status = 'annulé'; editRelance(e); }
    finish(e);
  }
  persist();
});

// ---------------------------------------------------------------------------
// Analyse automatique des déclencheurs : règles à AJOUTER / MODIFIER / SUPPRIMER
// ---------------------------------------------------------------------------
const hash = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0; return h.toString(36); };
const r0 = (v) => Math.round(v);
function allConds() {
  const out = []; const L = ['J', 'B', 'T'];
  const pb = [[null, null], [2, 2], [2, 3], [3, 2], [3, 3]];
  for (const a of L) for (const [p, b] of pb) out.push({ seq: a, p, b });
  for (const a of L) for (const c of L) out.push({ seq: a + c, p: null, b: null });
  for (const a of L) for (const c of L) for (const d of L) out.push({ seq: a + c + d, p: null, b: null });
  for (const [p, b] of [[2, 2], [2, 3], [3, 2], [3, 3], [2, null], [3, null], [null, 2], [null, 3]]) out.push({ seq: '', p, b });
  return out;
}
const rulesSig = () => panel.rules.map((r) => `${r.id}:${r.offset}:${r.side}:${r.enabled ? 1 : 0}`).join(',');
let findingsCache = { key: '', list: [] };
let lastNear = [];

// réussite d'UN côté (V1 ou V2) pour une condition à un décalage donné : { side, n, hits, rate, z, ok }
function evalCond(cond, offset, base, maxR, side) {
  const r = rateFor((seg, i) => matchAt(cond, seg, i), offset, maxR);
  const T = thr();
  if (r.n < T.minN) return { n: r.n, ok: false };
  const L = LETTER[side]; const p0 = base[L] / base.n;
  const rate = r[L] / r.n; const z = zOf(r[L], r.n, p0);
  return { side, n: r.n, hits: r[L], rate, p0, z, ok: rate * 100 >= T.minRate && z >= T.minZ && rate - p0 >= T.gain };
}
function computeFindings() {
  const key = `${panel.loggedCount}|${panel.maxR}|${panel.sensitivity}|${rulesSig()}|${Object.keys(panel.dismissed).length}`;
  if (findingsCache.key === key) return findingsCache.list;
  const list = buildFindings();
  findingsCache = { key, list };
  return list;
}
function buildFindings() {
  const maxR = panel.maxR;
  const base = baseRate(maxR);
  const T = thr();
  lastNear = [];
  if (base.n < Math.max(10, T.minN * 2)) return []; // 10 jeux lus suffisent en sensibilité Large
  const out = [];
  const modded = new Set();
  // MODIFIER : un autre décalage valide nettement mieux
  for (const rule of panel.rules) {
    if (rule.locked) continue;
    const L = LETTER[rule.side];
    const curR = rateFor((seg, i) => matchAt(rule, seg, i), rule.offset, maxR);
    const curRate = curR.n ? curR[L] / curR.n : null;
    let best = null;
    for (const o of OFFSETS) {
      if (o === rule.offset) continue;
      if (panel.rules.some((x) => x.id !== rule.id && x.enabled && sameRule(x, rule) && x.offset === o)) continue;
      const ev = evalCond(rule, o, base, maxR, rule.side);
      if (ev.ok && (!best || ev.z > best.z)) best = { ...ev, o };
    }
    const curZ = curR.n >= T.minN ? zOf(curR[L], curR.n, base[L] / base.n) : 0;
    if (best && (curRate === null || best.rate - curRate >= T.modGain) && best.z > curZ) {
      const k = `mod|${rule.id}|${best.o}`;
      out.push({ sid: hash(k), type: 'mod', key: k, n: best.n, rate: r0(best.rate * 100), base: r0(best.p0 * 100), score: best.z,
        title: `✏️ ${ruleLabel(rule)} : N+${rule.offset} → N+${best.o} · ${r0(best.rate * 100)}% (n=${best.n})`,
        detail: `Modifier « ${ruleText(rule)} » en « N+${best.o} » : ${rule.side} valide ${r0(best.rate * 100)}% sur ${best.n} cas (taux général ${r0(best.p0 * 100)}%), contre ${curRate === null ? 'trop peu de cas' : r0(curRate * 100) + '%'} avec le décalage actuel.`,
        patch: { ruleId: rule.id, offset: best.o } });
      modded.add(rule.id);
    }
  }
  // SUPPRIMER : une règle qui ne fait pas mieux que le hasard
  for (const rule of panel.rules) {
    if (modded.has(rule.id) || rule.locked) continue;
    const L = LETTER[rule.side];
    const cur = rateFor((seg, i) => matchAt(rule, seg, i), rule.offset, maxR);
    if (cur.n < T.minNDel) continue;
    const p0 = base[L] / base.n; const z = zOf(cur[L], cur.n, p0);
    if (z < 0.5 || cur[L] / cur.n * 100 < T.minRate - 10) {
      const k = `del|${rule.id}`;
      out.push({ sid: hash(k), type: 'del', key: k, n: cur.n, rate: r0((cur[L] / cur.n) * 100), base: r0(p0 * 100), score: 5 - z,
        title: `🗑️ Supprimer ${ruleText(rule)} · ${r0((cur[L] / cur.n) * 100)}% (n=${cur.n})`,
        detail: `Supprimer « ${ruleText(rule)} » : ${rule.side} valide ${r0((cur[L] / cur.n) * 100)}% sur ${cur.n} cas, pas assez au-dessus du taux général (${r0(p0 * 100)}%).`,
        patch: { ruleId: rule.id } });
    }
  }
  // AJOUTER : nouveau déclencheur net (une seule règle par déclencheur)
  const adds = []; const nearAll = [];
  for (const side of ['V1', 'V2']) for (const cond of allConds()) {
    if (panel.rules.some((x) => sameRule(x, { ...cond, side }))) continue;
    let best = null;
    for (const o of OFFSETS) {
      const ev = evalCond(cond, o, base, maxR, side);
      if (ev.ok && (!best || ev.z > best.z)) best = { ...ev, o };
    }
    if (!best) {
      // quasi-candidat : meilleur décalage de ce déclencheur, même s'il ne passe pas les seuils (affiché pour comprendre)
      let nb = null;
      for (const o of OFFSETS) { const ev = evalCond(cond, o, base, maxR, side); if (ev.n >= T.minN && ev.z !== undefined && (!nb || ev.z > nb.z)) nb = { ...ev, o }; }
      if (nb) nearAll.push({ side, label: ruleLabel({ ...cond }), offset: nb.o, n: nb.n, rate: r0(nb.rate * 100), base: r0(nb.p0 * 100), z: Math.round(nb.z * 10) / 10 });
      continue;
    }
    const k = `add|${cond.seq}|${cond.p}|${cond.b}|${best.o}|${best.side}`;
    const label = ruleLabel({ ...cond });
    adds.push({ sid: hash(k), type: 'add', key: k, n: best.n, rate: r0(best.rate * 100), base: r0(best.p0 * 100), score: best.z,
      title: `➕ ${label} → N+${best.o} (${best.side}) · ${r0(best.rate * 100)}% (n=${best.n})`,
      detail: `Ajouter le déclencheur « ${label} → N+${best.o} » : ${best.side} valide ${r0(best.rate * 100)}% sur ${best.n} cas, contre ${r0(best.p0 * 100)}% de taux général (écart ${best.z.toFixed(1)} σ).`,
      patch: { rule: { seq: cond.seq, p: cond.p, b: cond.b, offset: best.o, side: best.side } } });
  }
  lastNear = ['V1', 'V2'].flatMap((sd) => nearAll.filter((x) => x.side === sd).sort((a, b) => b.z - a.z).slice(0, 5));
  adds.sort((a, b) => b.score - a.score);
  const top = [...adds.filter((f) => f.patch.rule.side === 'V1').slice(0, 2), ...adds.filter((f) => f.patch.rule.side === 'V2').slice(0, 2)]; // 2 par côté
  const list = out.concat(top).filter((f) => !panel.dismissed[f.sid]);
  list.sort((a, b) => b.score - a.score);
  return list.slice(0, MAX_FINDINGS);
}

function applyFinding(f) {
  if (!f) return { ok: false, text: 'Trouvaille introuvable (la liste a changé).' };
  if (f.type === 'add') {
    const rule = sanitizeRule({ ...f.patch.rule, auto: true, enabled: true });
    if (!rule) return { ok: false, text: 'Règle invalide.' };
    if (panel.rules.some((r) => sameRule(r, rule))) return { ok: false, text: 'Ce déclencheur existe déjà.' };
    if (panel.rules.length >= MAX_RULES) return { ok: false, text: `Limite de ${MAX_RULES} règles atteinte.` };
    panel.rules.push(rule);
    return { ok: true, text: `Règle ajoutée : ${ruleText(rule)}` };
  }
  const rule = panel.rules.find((r) => r.id === f.patch.ruleId);
  if (!rule) return { ok: false, text: 'La règle n\'existe plus.' };
  if (f.type === 'mod') { const old = ruleText(rule); rule.offset = f.patch.offset; return { ok: true, text: `Règle modifiée : ${old} → ${ruleText(rule)}` }; }
  if (f.type === 'del') { panel.rules = panel.rules.filter((r) => r.id !== rule.id); return { ok: true, text: `Règle supprimée : ${ruleText(rule)}` }; }
  return { ok: false, text: 'Type inconnu.' };
}
function applyBySid(sid) {
  const f = computeFindings().find((x) => x.sid === sid);
  const r = applyFinding(f);
  if (r.ok) { panel.dismissed[sid] = Date.now(); persist(); }
  return r;
}
function setRuleEnabled(id, enabled) {
  const rule = panel.rules.find((r) => r.id === id);
  if (!rule) return { ok: false, text: 'Règle introuvable.' };
  rule.enabled = !!enabled; persist();
  return { ok: true, text: `${ruleText(rule)} ${rule.enabled ? 'activée' : 'désactivée'}` };
}
function removeRule(id) {
  const rule = panel.rules.find((r) => r.id === id);
  if (!rule) return { ok: false, text: 'Règle introuvable.' };
  if (id === DEFAULT_RULE_ID) panel.defaultDropped = true;
  panel.rules = panel.rules.filter((r) => r.id !== id); persist();
  return { ok: true, text: `Règle supprimée : ${ruleText(rule)}` };
}

// ---------------------------------------------------------------------------
// Chat privé : liste cliquable
// ---------------------------------------------------------------------------
function rulesSummary() {
  return panel.rules.length ? panel.rules.map((r) => `• ${ruleText(r)}${r.enabled ? '' : ' (désactivée)'}${r.auto ? ' [auto]' : ''}`).join('\n') : '• (aucune règle pour l\'instant — l\'analyse en cherche)';
}
function listView(findings, prefix = '') {
  const list = findings || computeFindings();
  const head = prefix ? `${prefix}\n\n` : '';
  if (!list.length) {
    return { text: `${head}⚔️ Victoire V1 / V2 — aucune modification à proposer pour l'instant.\n\nRègles actuelles :\n${rulesSummary()}`, markup: { inline_keyboard: [[{ text: '🔄 Actualiser', callback_data: 'vvb:l' }]] } };
  }
  const rows = list.map((f) => [{ text: f.title.slice(0, 60), callback_data: `vvb:a:${f.sid}` }]);
  rows.push([{ text: '✅ Tout appliquer', callback_data: 'vvb:all' }, { text: '🙈 Tout ignorer', callback_data: 'vvb:ig' }]);
  rows.push([{ text: '🔄 Actualiser', callback_data: 'vvb:l' }]);
  const text = `${head}🔎 Victoire V1 / V2 — l'analyse a trouvé ${list.length} changement(s) possible(s) :\n\n${list.map((f, i) => `${i + 1}. ${f.detail}`).join('\n\n')}\n\nRègles actuelles :\n${rulesSummary()}\n\nTouche un bouton pour l'appliquer.`;
  return { text, markup: { inline_keyboard: rows } };
}
async function toAdmin(view) {
  try {
    const bot = sender ? sender() : null;
    const adminId = adminIdFn ? adminIdFn() : null;
    if (!bot || !adminId) { panel.lastError = !adminId ? 'ADMIN_ID non renseigné (chat privé inconnu)' : 'Aucun token Telegram configuré'; return false; }
    const raw = bot.sendMessageUnguarded || bot.sendMessage.bind(bot);
    await raw(adminId, view.text, { reply_markup: view.markup });
    return true;
  } catch (e) { panel.lastError = e.message; return false; }
}
async function sendListToAdmin() { return toAdmin(listView()); }

// réponse à un bouton du chat privé (callback_data « vvb:… »)
function handleCallback(data) {
  const parts = String(data || '').split(':');
  const act = parts[1];
  if (act === 'a') {
    const r = applyBySid(parts[2]);
    return { answer: r.ok ? '✅ Appliqué' : '⚠️ ' + r.text, ...listView(null, `${r.ok ? '✅' : '⚠️'} ${r.text}`) };
  }
  if (act === 'all') {
    const done = [];
    for (const f of computeFindings()) {
      const r = applyFinding(f);
      if (r.ok) { panel.dismissed[f.sid] = Date.now(); done.push(r.text); }
    }
    persist();
    return { answer: done.length ? `✅ ${done.length} appliqué(s)` : 'Rien à appliquer', ...listView(null, done.length ? `✅ Appliqué :\n${done.join('\n')}` : 'Rien à appliquer.') };
  }
  if (act === 'ig') {
    const list = computeFindings();
    for (const f of list) panel.dismissed[f.sid] = Date.now();
    persist();
    return { answer: '🙈 Ignoré', ...listView(null, `${list.length} trouvaille(s) ignorée(s).`) };
  }
  return { answer: 'Liste actualisée', ...listView() };
}

// analyse automatique : tous les ANALYSIS_EVERY jeux enregistrés (ou à la demande)
async function maybeAnalyze(force = false) {
  // sans aucune règle active : on cherche dès 3 nouveaux jeux ; sinon tous les ANALYSIS_EVERY jeux
  if (!force && panel.loggedCount - panel.analysisMark < (panel.rules.length ? ANALYSIS_EVERY : 3)) return;
  panel.analysisMark = panel.loggedCount;
  panel.lastAnalysisAt = Date.now();
  const list = computeFindings();
  if (panel.autoApply && list.length) {
    const done = [];
    for (const f of list) {
      const r = applyFinding(f);
      if (r.ok) { panel.dismissed[f.sid] = Date.now(); done.push(r.text); }
    }
    persist();
    if (panel.notify && done.length) {
      await toAdmin({ text: `⚔️ Victoire V1 / V2 — l'analyse a appliqué automatiquement :\n\n${done.map((t) => `• ${t}`).join('\n')}\n\nRègles actuelles :\n${rulesSummary()}`, markup: { inline_keyboard: [[{ text: '📋 Voir la liste', callback_data: 'vvb:l' }]] } });
    }
    return;
  }
  const fresh = list.filter((f) => !panel.notified[f.sid]);
  if (panel.notify && fresh.length) {
    if (await toAdmin(listView(list))) for (const f of list) panel.notified[f.sid] = Date.now();
  }
}
async function analyzeNow() {
  appendLog();
  await maybeAnalyze(true);
  persist();
  return statusView();
}

async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    appendLog();
    await scanTriggers();
    verifyPending();
    await maybeAnalyze();
    panel.lastScanAt = Date.now();
  } catch (e) { panel.lastError = e.message; }
  finally { persist(); busy = false; }
  return panel;
}

async function test() {
  const bot = sender ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré', errors: ['Aucun token Telegram configuré'] };
  if (!panel.channels.length && !panel.relanceChannels.length) return { ok: false, error: 'Aucun canal configuré', errors: ['Aucun canal configuré'] };
  const t = (maxFinishedGameNumber() || 530) + 2;
  const base = { target: t, p1: 62, p2: 31, status: 'en attente', phase: 'first', hit: { V1: null, V2: null }, first: null, relance: null };
  const won = { ...base, status: 'gagné', phase: 'second', hit: { V1: 0, V2: null }, first: { side: 'V1', step: 0, num: t } };
  const rel = { ...won, phase: 'relance', relance: { target: t + 3, status: 'en attente' } };
  const fin = { ...rel, phase: 'done', hit: { V1: 0, V2: null }, relance: { target: t + 3, status: 'gagné', hit: 1 } };
  const sent = []; const errors = [];
  if (panel.relanceChannels.length) {
    const own = { ...fin, relance: { ...fin.relance, own: true } };
    const ownWait = { ...own, relance: { ...own.relance, status: 'en attente', hit: null } };
    for (const id of panel.relanceChannels) {
      try { await bot.sendMessage(id, `🧪 Victoire V1 / V2 — canal des relances\n\n${relMessageText(ownWait)}\n\nRelance gagnée au 1er rattrapage :\n\n${relMessageText(own)}`); sent.push(String(id)); }
      catch (e) { errors.push(`${id} : ${e.message}`); }
    }
  }
  for (const id of panel.channels) {
    try {
      await bot.sendMessage(id, `🧪 Victoire V1 / V2 — message de test\n\n${messageText(base)}\n\nV1 validé, on attend V2 :\n\n${messageText(won)}\n\nV2 pas validé à +1 → relance à N+3 :\n\n${messageText(rel)}\n\nRelance gagnée au 1er rattrapage :\n\n${messageText(fin)}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

// ---------------------------------------------------------------------------
// Analyse affichée sur la page
// ---------------------------------------------------------------------------
function analysis() {
  const segs = parsed();
  let games = 0; let J = 0; let B = 0; let T = 0;
  let curLetter = null; let curRun = 0; let maxJ = 0; let maxB = 0; let runJ = 0; let runB = 0;
  segs.forEach((seg, si) => {
    runJ = 0; runB = 0;
    for (const x of seg) {
      if (!x) { runJ = 0; runB = 0; continue; }
      games += 1;
      if (x.w === 'J') { J += 1; runJ += 1; runB = 0; maxJ = Math.max(maxJ, runJ); } else if (x.w === 'B') { B += 1; runB += 1; runJ = 0; maxB = Math.max(maxB, runB); } else { T += 1; runJ = 0; runB = 0; }
    }
    if (si === segs.length - 1) {
      curLetter = null; curRun = 0;
      for (let i = seg.length - 1; i >= 0; i--) { const x = seg[i]; if (!x) break; if (curLetter === null) curLetter = x.w; if (x.w !== curLetter) break; curRun += 1; }
    }
  });
  const base = baseRate();
  const pc = (v) => (games ? Math.round((1000 * v) / games) / 10 : null);
  return {
    games, J, B, T, jPct: pc(J), bPct: pc(B), tPct: pc(T), shoes: segs.length,
    currentRun: curLetter ? { letter: curLetter, n: curRun } : null, maxRunJ: maxJ, maxRunB: maxB,
    window: { maxR: panel.maxR, base },
    thresholds: { minN: thr().minN, minZ: thr().minZ, minRate: thr().minRate, label: thr().label },
    rules: panel.rules.map((r) => {
      const p = percentsFor(r); const s = statsOf(r.id);
      return { id: r.id, label: ruleLabel(r), offset: r.offset, side: r.side, auto: !!r.auto, enabled: r.enabled, observed: p.observed, p1: p.p1, p2: p.p2, ...s };
    }),
  };
}

function analysisGames() { let n = 0; for (const seg of parsed()) for (const x of seg) if (x) n += 1; return n; }

function statusView() {
  const resolved = panel.pending.filter((e) => e.status === 'gagné' || e.status === 'perdu');
  return {
    ...config(),
    siteChannels: siteChannelsView().map((c) => ({ id: c.id, name: c.name })),
    live: state.live && Number.isFinite(Number(state.live.number)) ? Number(state.live.number) : maxFinishedGameNumber(),
    rules: panel.rules.map((r) => ({ id: r.id, label: ruleLabel(r), offset: r.offset, side: r.side, enabled: r.enabled, auto: !!r.auto, locked: !!r.locked })),
    findings: computeFindings().map((f) => ({ sid: f.sid, type: f.type, title: f.title, detail: f.detail, n: f.n, rate: f.rate, base: f.base })),
    pending: panel.pending.slice(-30).map((e) => ({
      id: e.id, trigger: e.trigger, ruleLabel: e.ruleLabel, source: e.source, target: e.target, p1: e.p1, p2: e.p2, status: e.status, phase: e.phase,
      step: e.step, maxR: e.maxR, hit: e.hit, first: e.first, relance: e.relance ? { target: e.relance.target, status: e.relance.status, hit: e.relance.hit ?? null, own: !!e.relance.own } : null,
      text: messageText(e), sentAt: e.sentAt, resolvedAt: e.resolvedAt, usedChannels: e.usedChannels || [], usedSite: e.usedSite ?? null,
    })),
    near: lastNear,
    historyGames: analysisGames(),
    analysis: analysis(),
    won: resolved.filter((e) => e.status === 'gagné').length,
    lost: resolved.filter((e) => e.status === 'perdu').length,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt, lastAnalysisAt: panel.lastAnalysisAt, lastError: panel.lastError,
  };
}

function resetStats() {
  panel.stats = {};
  panel.pending = [];
  panel.rules = []; panel.defaultDropped = false; ensureDefaultRule();
  panel.notified = {}; panel.dismissed = {};
  persist();
  return statusView();
}

module.exports = {
  panel, setSender, setAdminId, tick, test, status: statusView, config, configure, persist,
  restore, restoreFromDb, parseChannels, resetStats, analysis, messageText,
  seedFromDb, computeFindings, applyBySid, listView, sendListToAdmin, handleCallback, maybeAnalyze, analyzeNow, ruleText,
  setRuleEnabled, removeRule,
};
