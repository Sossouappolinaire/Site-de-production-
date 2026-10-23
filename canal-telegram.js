// canal-telegram.js — bouton « Canal Telegram » (v99, demande admin) :
//
//  • UN CANAL = UNE STRATÉGIE. On choisit un canal Telegram (où le bot est présent) : toutes les prédictions publiées dans ce
//    canal sont considérées comme les prédictions d'UNE SEULE stratégie, qui porte le NOM DU CANAL (modifiable).
//  • UNIFORMISATION : peu importe la mise en page du message (les 107 formats du site, ceux d'autres bots, avec ou sans
//    pourcentage, avec ou sans résultat déjà édité) et peu importe le rattrapage annoncé dans le canal. Le bot lit seulement
//    « N° de jeu + costume » (lecteur universel `parseUniversal`) et vérifie lui-même chaque prédiction sur la main du JOUEUR,
//    avec UN nombre de rattrapages unique réglé ici (N, N+1 … N+R). Costume jamais sorti → PERDUE.
//  • Résultat : pour chaque canal, mêmes statistiques que n'importe quelle autre stratégie (prédictions, gagnées / perdues,
//    taux, répartition par rattrapage et par costume), comparables entre eux puisque vérifiées de la même façon.
//  • Sources lues : publications des canaux où le bot est présent (channel_post, y compris celles de CE bot via le point d'envoi
//    unique de bot.js). Une même prédiction (canal + jeu + costume) n'est jamais comptée deux fois, même si le message est édité.
//  • Un message à plusieurs costumes n'est lu que s'il porte des pourcentages (format « ♦️ 95% / N°1196 / ♣️ 93% ») ; les
//    rapports, bilans et listes de statistiques (plusieurs numéros de jeu) sont ignorés.
//  • Rien n'est jamais envoyé par ce bouton : il observe, vérifie et compte.
'use strict';

const store = require('./store');
const db = require('./db');
const strategies = require('./strategies');
const { state, hasSuit } = require('./predictor');

const DB_KEY = 'canal_telegram_state';
const DEFAULT_MAXR = 3;
const SEEN_MAX = 3000;
const WATCH_MAX = 600;
const RECENT_MAX = 15;
const STRAT_MAX = 100;

const panel = { strategies: [], watches: [], seen: [], lastError: null, lateSkipped: 0, ignoredPosts: 0, lastPostAt: null };

// ── utilitaires ─────────────────────────────────────────────────────────────
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const sanitizeName = (v) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, 80);
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const isDone = (g) => !!g && g.finished && g.complete !== false;
const maxFinishedGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; };
const normChannel = (v) => String(v == null ? '' : v).trim().toLowerCase();
const emptyStats = () => ({ won: 0, lost: 0, cancelled: 0, byStep: {}, bySuit: {} });
function statsOf(s) { s.stats = s.stats && typeof s.stats === 'object' ? { ...emptyStats(), ...s.stats } : emptyStats(); return s.stats; }

// ── lecteur UNIVERSEL d'une publication ─────────────────────────────────────
// Renvoie { target, suits } ou null. Indépendant du format : numéro de jeu écrit « N°1196 », « №1196 », « #1196 », « #N1196 »,
// « Jeu 1196 », « Game 1196 », « Partie / Tour / Manche 1196 », « N1196 » … ; costumes en symboles ou en toutes lettres
// (français / anglais). Les chiffres des rattrapages (« rattrapage 2 », « +2 ») ne sont jamais pris pour un numéro de jeu.
const SUIT_WORDS = [[/carreaux?/i, '♦️'], [/c(?:œ|oe)urs?/i, '❤️'], [/tr[èe]fles?/i, '♣️'], [/piques?/i, '♠️']];
function suitsIn(text) {
  const found = [];
  const re = /[♦♥❤♣♠]|\b(?:carreaux?|c(?:œ|oe)urs?|tr[èe]fles?|piques?)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = strategies.normSuit(m[0]) || (SUIT_WORDS.find(([r]) => r.test(m[0])) || [])[1];
    if (s && !found.includes(s)) found.push(s);
  }
  return found;
}
// Texte « à plat » : variantes d'emoji retirées, lettres / chiffres stylisés (𝐍°𝟏𝟐𝟑), petites capitales (ᴄᴀʀʀᴇᴀᴜ) et lettres espacées (C A R R E A U) ramenés à l'écriture normale
const SMALL_CAPS = { 'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z' };
function plain(text) {
  return String(text).replace(/\uFE0F/g, '').normalize('NFKC')
    .replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡʏᴢ]/g, (c) => SMALL_CAPS[c] || c)
    .replace(/(?<![\p{L}])((?:\p{L} ){2,}\p{L})(?![\p{L}])/gu, (m) => m.replace(/ /g, ''));
}
const NOT_PREDICTION = /RETOUR APRÈS PERTE|BILAN|RÉSUMÉ|RESUME|STATISTIQUE|CLASSEMENT|PARITÉ|PARITE|RÉCAP|RECAP|TAUX DE|🧪|ПОВТОР/i;
const GAME_NUMBER_RES = [
  /(?:N\s*[°º˚]|№|\bNo\.?|#)\s*:?\s*N?\s*(\d{1,4})(?![\d%])/gi,
  /\b(?:jeux?|game|partie|tour|round|manche|match|baccara|baccarat)\s*(?:n\s*[°º˚o]?\s*)?[:#]?\s*N?\s*(\d{1,4})(?![\d%])/gi,
  /\bN(\d{3,4})(?![\d%])/g,
];
function gameNumbers(t) {
  const hits = [];
  for (const base of GAME_NUMBER_RES) {
    const re = new RegExp(base.source, base.flags);
    let m;
    while ((m = re.exec(t)) !== null) {
      const before = t.slice(Math.max(0, m.index - 14), m.index);
      if (/rattrap|retry|\+\s*$/i.test(before)) continue;
      const n = Number(m[1]);
      if (n > 0) hits.push({ n, at: m.index });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  if (hits.length) return hits;
  // Mise en page créative SANS marqueur (« TICKET 1196 », « VOL 1196 », « case 1196 », « classe 1196 »…) : un SEUL nombre de 3 ou 4 chiffres
  // isolé dans le message est le numéro de jeu (les petits nombres sont des rattrapages / durées ; plusieurs grands nombres = ce n'est pas une prédiction)
  const bare = [];
  const re = /(?<![\d.,:+x×/-])(\d{3,4})(?![\d%:.,/h])/gi;
  let m;
  while ((m = re.exec(t)) !== null) bare.push({ n: Number(m[1]), at: m.index });
  return new Set(bare.map((x) => x.n)).size === 1 ? bare : [];
}
function parseUniversal(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2500 || text.trim().startsWith('/')) return null;
  const t = plain(text);
  if (NOT_PREDICTION.test(t)) return null;
  const nums = gameNumbers(t);
  if (!nums.length) return null;
  let suits = suitsIn(t);
  if (!suits.length) return null;
  if (suits.length >= 2 && !/\d\s*%/.test(t)) { // costume écrit en toutes lettres + symboles décoratifs (« BOSS : Carreau / VIES : ❤️❤️❤️ ») : le mot l'emporte
    const named = SUIT_WORDS.filter(([r]) => r.test(t)).map(([, sym]) => sym);
    if (named.length === 1) suits = named;
  }
  const distinct = new Set(nums.map((x) => x.n));
  if (suits.length >= 2) {
    if (!/\d\s*%/.test(t) || distinct.size >= 3) return null; // plusieurs costumes sans pourcentage, ou liste de plusieurs jeux : ce n'est pas une prédiction
  }
  return { target: nums[0].n, suits };
}

// ── observation ─────────────────────────────────────────────────────────────
function matches(s, chat) {
  const id = normChannel(chat.id);
  const uname = chat.username ? `@${normChannel(chat.username).replace(/^@/, '')}` : null;
  return normChannel(s.channel) === id || (uname && (normChannel(s.channel) === uname || (s.username && normChannel(s.username) === uname)));
}
function observe(chat, text) {
  try {
    if (!chat || chat.id == null) return false;
    const list = panel.strategies.filter((s) => s.enabled && matches(s, chat));
    if (!list.length) return false;
    panel.lastPostAt = Date.now();
    const post = parseUniversal(text);
    if (!post) { panel.ignoredPosts += 1; return false; }
    const maxDone = maxFinishedGameNumber();
    let changed = false;
    for (const s of list) {
      if (chat.title && !s.nameCustom) s.name = sanitizeName(chat.title) || s.name;
      if (chat.title) s.title = sanitizeName(chat.title);
      for (const suit of post.suits) {
        const key = `${s.id}:${post.target}:${suit}`;
        if (panel.seen.includes(key)) continue;
        panel.seen.push(key); if (panel.seen.length > SEEN_MAX) panel.seen = panel.seen.slice(-SEEN_MAX);
        if (post.target <= maxDone) { panel.lateSkipped += 1; continue; } // jeu déjà joué : prédiction lue trop tard (ou message ancien édité)
        panel.watches.push({ id: `ct-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, stratId: s.id, suit, target: post.target, maxR: s.maxR, status: 'en attente', step: 0, at: Date.now() });
        changed = true;
      }
    }
    if (panel.watches.length > WATCH_MAX) panel.watches = panel.watches.slice(-WATCH_MAX);
    if (changed) persist();
    return changed;
  } catch (e) { panel.lastError = e.message; return false; }
}
function onChannelPost(chat, text) { return observe(chat, text); }
// message envoyé par le bot lui-même (le bot ne reçoit pas ses propres publications de canal)
function onOwnPost(chatId, text) { return observe({ id: chatId }, text); }

// ── vérification (appelée à chaque cycle du bot) ────────────────────────────
// Même règle pour tous les canaux : main du JOUEUR, jeu N puis N+1 … N+R (R = rattrapages de la stratégie), costume jamais sorti → perdue.
let ticking = false;
function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const maxDone = maxFinishedGameNumber();
    if (!maxDone) return;
    let changed = false;
    for (const w of panel.watches) {
      if (w.status !== 'en attente') continue;
      const s = panel.strategies.find((x) => x.id === w.stratId);
      if (!s) { w.status = 'annulé'; changed = true; continue; }
      const R = clampInt(s.maxR, 0, 9, DEFAULT_MAXR); // rattrapages UNIFORMES de la stratégie (jamais ceux annoncés dans le canal)
      let verdict = null; let hitAt = -1;
      for (let k = 0; k <= R; k++) {
        const g = state.games.get(w.target + k);
        if (!isDone(g)) { if (w.target + k + 2 <= maxDone) verdict = 'annulé'; else if (w.step < k) { w.step = k; changed = true; } break; }
        if (hasSuit(g, w.suit)) { verdict = 'gagné'; hitAt = k; break; }
        if (k === R) verdict = 'perdu';
        else if (w.step < k + 1) { w.step = k + 1; changed = true; }
      }
      if (!verdict) continue;
      w.status = verdict; w.resolvedAt = Date.now(); w.maxR = R; changed = true;
      const st = statsOf(s);
      if (verdict === 'gagné') { w.step = hitAt; st.won += 1; st.byStep[hitAt] = (st.byStep[hitAt] || 0) + 1; }
      else if (verdict === 'perdu') st.lost += 1;
      else st.cancelled += 1;
      if (verdict !== 'annulé') {
        const bs = st.bySuit[w.suit] || (st.bySuit[w.suit] = { won: 0, lost: 0 });
        if (verdict === 'gagné') bs.won += 1; else bs.lost += 1;
      }
    }
    // nettoyage : résolues de moins de 48 h + tout ce qui est en attente
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const before = panel.watches.length;
    panel.watches = panel.watches.filter((w) => w.status === 'en attente' || (w.resolvedAt || w.at) > cutoff).slice(-WATCH_MAX);
    if (changed || panel.watches.length !== before) persist();
  } catch (e) { panel.lastError = e.message; }
  finally { ticking = false; }
}

// ── stratégies (une par canal) ──────────────────────────────────────────────
// input : { channel (ID ou @nom), name?, maxR?, title?, username?, chatId? } — chatId / title / username viennent de la vérification Telegram
function addStrategy(input = {}) {
  const channel = String(input.chatId != null ? input.chatId : input.channel == null ? '' : input.channel).trim();
  if (!channel) throw new Error('Renseigne le canal Telegram (ID ou @nom).');
  if (panel.strategies.length >= STRAT_MAX) throw new Error(`Maximum ${STRAT_MAX} canaux.`);
  const probe = { id: channel, username: input.username || (channel.startsWith('@') ? channel : null) };
  const dup = panel.strategies.find((s) => matches(s, probe));
  if (dup) throw new Error(`Ce canal est déjà une stratégie : « ${dup.name} ».`);
  const title = sanitizeName(input.title) || channel;
  const custom = sanitizeName(input.name);
  const s = {
    id: `ctg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, channel, username: input.username ? `@${String(input.username).replace(/^@/, '')}` : null,
    title, name: custom || title, nameCustom: !!custom, maxR: clampInt(input.maxR, 0, 9, DEFAULT_MAXR), enabled: input.enabled !== false, createdAt: Date.now(), stats: emptyStats(),
  };
  panel.strategies.push(s);
  persist();
  return s;
}
function updateStrategy(id, patch = {}) {
  const s = panel.strategies.find((x) => x.id === id);
  if (!s) throw new Error('Stratégie introuvable.');
  if (patch.name !== undefined) { const n = sanitizeName(patch.name); if (n) { s.name = n; s.nameCustom = n !== s.title; } else { s.name = s.title || s.channel; s.nameCustom = false; } }
  if (patch.maxR !== undefined) s.maxR = clampInt(patch.maxR, 0, 9, DEFAULT_MAXR);
  if (patch.enabled !== undefined) s.enabled = !!patch.enabled;
  persist();
  return s;
}
function removeStrategy(id) {
  panel.strategies = panel.strategies.filter((s) => s.id !== id);
  panel.watches = panel.watches.filter((w) => w.stratId !== id);
  persist();
}
function resetStats(id) {
  for (const s of panel.strategies.filter((x) => !id || x.id === id)) s.stats = emptyStats();
  panel.watches = panel.watches.filter((w) => (id && w.stratId !== id) || w.status === 'en attente');
  persist();
}
function setChannelTitle(channel, title) {
  const k = normChannel(channel); if (!k || !title) return;
  for (const s of panel.strategies) if (normChannel(s.channel) === k) { s.title = sanitizeName(title); if (!s.nameCustom) s.name = s.title; }
  persist();
}

// ── vue pour le tableau de bord ─────────────────────────────────────────────
function viewOf(s) {
  const st = statsOf(s); const resolved = st.won + st.lost;
  const mine = panel.watches.filter((w) => w.stratId === s.id);
  return {
    id: s.id, channel: s.channel, username: s.username || null, title: s.title || s.name, name: s.name, nameCustom: !!s.nameCustom, maxR: s.maxR, enabled: s.enabled,
    won: st.won, lost: st.lost, cancelled: st.cancelled, resolved, total: resolved, rate: pct(st.won, resolved),
    waiting: mine.filter((w) => w.status === 'en attente').length,
    steps: Object.entries(st.byStep || {}).map(([k, n]) => ({ step: Number(k), n: Number(n) })).sort((a, b) => a.step - b.step),
    suits: Object.entries(st.bySuit || {}).map(([k, v]) => ({ suit: k, won: v.won, lost: v.lost, rate: pct(v.won, v.won + v.lost) })),
    recent: mine.slice(-RECENT_MAX).reverse().map((w) => ({ target: w.target, suit: w.suit, status: w.status, step: w.step })),
  };
}
function status() {
  const list = panel.strategies.map(viewOf);
  const won = list.reduce((a, s) => a + s.won, 0); const lost = list.reduce((a, s) => a + s.lost, 0);
  return {
    strategies: list, count: list.length, active: list.filter((s) => s.enabled).length, defaultMaxR: DEFAULT_MAXR,
    won, lost, rate: pct(won, won + lost), waiting: list.reduce((a, s) => a + s.waiting, 0),
    lateSkipped: panel.lateSkipped, ignoredPosts: panel.ignoredPosts, lastPostAt: panel.lastPostAt, lastError: panel.lastError,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { strategies: panel.strategies, watches: panel.watches, seen: panel.seen, lateSkipped: panel.lateSkipped, ignoredPosts: panel.ignoredPosts, lastPostAt: panel.lastPostAt };
  try { store.patch({ canalTelegram: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  panel.strategies = Array.isArray(saved.strategies) ? saved.strategies.filter((s) => s && s.id && s.channel).slice(0, STRAT_MAX).map((s) => ({
    ...s, name: sanitizeName(s.name) || String(s.channel), maxR: clampInt(s.maxR, 0, 9, DEFAULT_MAXR), enabled: s.enabled !== false, stats: { ...emptyStats(), ...(s.stats || {}) },
  })) : [];
  panel.watches = Array.isArray(saved.watches) ? saved.watches.filter((w) => w && w.id).slice(-WATCH_MAX) : [];
  panel.seen = Array.isArray(saved.seen) ? saved.seen.slice(-SEEN_MAX) : [];
  panel.lateSkipped = Number(saved.lateSkipped) || 0; panel.ignoredPosts = Number(saved.ignoredPosts) || 0; panel.lastPostAt = saved.lastPostAt || null;
}
function restore() { try { const s = (store.read() || {}).canalTelegram; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting(DB_KEY); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

module.exports = {
  panel, restore, restoreFromDb, persist, parseUniversal, onChannelPost, onOwnPost, tick, status,
  addStrategy, updateStrategy, removeStrategy, resetStats, setChannelTitle,
};
