// prev-suit.js — bouton « Costume N-1 → +4 » (v93) :
//
//  • On COCHE des stratégies / configurations de tout le site (liste construite par server.js : stratégies, Répétition, Rupture,
//    Dizaine, Costume faible, Meilleur + plus faible, Relance, Prédit IA, etc.). Le bot OBSERVE chaque prédiction qu'elles
//    envoient (N° de jeu + costume) depuis le point d'envoi unique de bot.js.
//  • Pour chaque prédiction « N + costume » observée, il regarde la main du JOUEUR :
//        – le costume est venu au jeu N-1 ET il n'est PAS sorti au jeu N  →  il prédit le même costume au jeu N + 4
//          (décalage réglable) et l'envoie dans le canal (ID) configuré ;
//        – le costume n'était pas venu à N-1, ou il est sorti au jeu N  →  rien n'est envoyé.
//    Exemple : une configuration cochée prédit 12♦️ ; ♦️ est venu au jeu 11 puis n'est pas sorti au jeu 12 → envoi de 16♦️.
//  • La nouvelle prédiction est vérifiée à son tour (N+4, puis rattrapages) et son message est édité (✅ / ❌).
//  • Jamais deux prédictions pour le même numéro de jeu, jamais pour un jeu déjà joué, jamais de suivi du propre canal d'envoi.
//  • Un canal peut servir plusieurs configurations : cocher l'une d'elles suit donc toutes les prédictions publiées dans ses canaux.
//  • RÈGLE RATTRAPAGE 3 : seules les stratégies / configurations réglées sur 3 rattrapages sont suivies. Une source dont le
//    rattrapage est différent de 3 (ou inconnu) reste affichée mais grisée, et ses prédictions sont ignorées.
'use strict';
const strategyRecap = require('./strategy-recap');

const store = require('./store');
const db = require('./db');
const strategies = require('./strategies');
const fmt = require('./formats');
const loss = require('./loss-return'); // lecture d'une publication (parsePost) et liste d'ID (parseChannels)
const { state, hasSuit } = require('./predictor');

const DB_KEY = 'prev_suit_state';
const SOURCE_MAXR = 3; // rattrapage exigé des sources suivies
const DEFAULT_OFFSET = 4;
const DEFAULT_MAXR = 2;
const DEFAULT_FORMAT = 107;
const SEEN_MAX = 1500;
const WATCH_MAX = 400;
const SENT_RESOLVED_MAX = 100;

const panel = {
  enabled: false, selected: {}, channels: [], offset: DEFAULT_OFFSET, maxR: DEFAULT_MAXR, format: DEFAULT_FORMAT,
  watches: [], pendingMessages: [], seen: [], stats: null, sentCount: 0, lastSentAt: null, lateSkipped: 0, duplicatesBlocked: 0,
  channelTitles: {}, lastError: null,
};
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
const bot = () => (typeof sender === 'function' ? sender() : null);
let sourceProvider = null; // fournie par server.js : () => [{ key, name, group, channels: [id…] }]
function setSourceProvider(fn) { sourceProvider = typeof fn === 'function' ? fn : null; }
function sources() { try { return sourceProvider ? (sourceProvider() || []) : []; } catch (_) { return []; } }
// une source n'est suivie que si son rattrapage est exactement SOURCE_MAXR (3)
const isFollowable = (s) => !!s && s.maxR !== null && s.maxR !== undefined && s.maxR !== '' && Number(s.maxR) === SOURCE_MAXR;
function followableSources() { return sources().filter(isFollowable); }

const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const isDone = (g) => !!g && g.finished && g.complete !== false;
// main du joueur terminée (même règle que loss-relaunch.js) : 2 cartes à 6-9, ou 3 cartes, ou jeu terminé
function isPlayerHandComplete(g) {
  if (!g || g.complete === false) return false;
  const count = g.playerCards !== null && g.playerCards !== undefined && Number.isFinite(Number(g.playerCards))
    ? Number(g.playerCards) : (Array.isArray(g.player) ? g.player.length : 0);
  if (count < 2) return false;
  if (g.finished) return true;
  if (count >= 3) return true;
  if (count !== 2 || g.playerValue === null || g.playerValue === undefined || g.playerValue === '') return false;
  const total = Number(g.playerValue);
  return Number.isFinite(total) && total >= 6;
}
const maxFinishedGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; };
const maxKnownGameNumber = () => { let m = 0; for (const g of state.games.values()) if ((g.finished || g.dealing) && g.number > m) m = g.number; return m; };
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const emptyStats = () => ({ sent: 0, won: 0, lost: 0, byStep: {}, bySuit: {}, triggered: 0, notTriggered: 0 });
const statsOf = () => { panel.stats = panel.stats && typeof panel.stats === 'object' ? { ...emptyStats(), ...panel.stats } : emptyStats(); return panel.stats; };

// ── observation ─────────────────────────────────────────────────────────────
// « #N511 » n'est pas lu par parsePost : on le ramène à « #511 » avant lecture
function readPost(text) {
  if (typeof text !== 'string') return null;
  return loss.parsePost(text.replace(/(#|№)\s*N(?=\s*\d)/gi, '$1'));
}
// appelé pour chaque message ENVOYÉ par le bot (point d'envoi unique de bot.js)
function onOwnPost(chatId, text) {
  try {
    if (!panel.enabled || chatId == null) return false;
    const chat = String(chatId).trim().toLowerCase();
    if ((panel.channels || []).some((c) => String(c).trim().toLowerCase() === chat)) return false; // jamais son propre canal d'envoi
    const ticked = Object.keys(panel.selected || {}).filter((k) => panel.selected[k]);
    if (!ticked.length) return false;
    const src = followableSources().filter((s) => ticked.includes(s.key) && (s.channels || []).some((c) => String(c).trim().toLowerCase() === chat));
    if (!src.length) return false;
    const post = readPost(text);
    if (!post) return false;
    let changed = false;
    for (const suit of post.suits) {
      const key = `${chat}:${post.target}:${suit}`;
      if (panel.seen.includes(key)) continue;
      panel.seen.push(key); if (panel.seen.length > SEEN_MAX) panel.seen = panel.seen.slice(-SEEN_MAX);
      panel.watches.push({ id: `psw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, src: src.map((s) => s.name).join(' / ').slice(0, 120), chatId: chat, suit, target: post.target, phase: 'verif', status: 'en attente', at: Date.now() });
      changed = true;
    }
    if (panel.watches.length > WATCH_MAX) panel.watches = panel.watches.slice(-WATCH_MAX);
    if (changed) persist();
    return changed;
  } catch (e) { panel.lastError = e.message; return false; }
}

// ── envoi / édition ─────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, { gameNumber: entry.target, suit: entry.suit, strategy: 'Costume N-1 → +4', maxR: entry.maxR, status: statusFr, rattrapage: entry.step || 0 }, null);
}
async function sendToChannels(out) {
  const b = bot();
  if (!b) { panel.lastError = 'Aucun token Telegram configuré'; return []; }
  const results = await Promise.all((panel.channels || []).map((id) => b.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {})
    .then((m) => (m && m.skipped ? { ok: false, skipped: true, id } : { ok: true, id, messageId: m.message_id }))
    .catch((e) => ({ ok: false, id, error: e.message }))));
  const sent = [];
  for (const r of results) { if (r.ok) sent.push({ chatId: r.id, messageId: r.messageId }); else if (!r.skipped) panel.lastError = `${r.id} : ${r.error}`; }
  return sent;
}
function editSent(entry, statusFr) {
  const b = bot(); if (!b) return;
  const out = renderFor(entry, statusFr);
  for (const m of entry.messages || []) {
    Promise.resolve().then(() => b.editMessageText(out.text, { chat_id: m.chatId, message_id: m.messageId, ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}) }))
      .then(() => { entry.editFail = null; })
      .catch((e) => {
        const msg = String((e && e.message) || e);
        if (/message is not modified/i.test(msg)) { entry.editFail = null; return; }
        if (/not found|can't be edited|chat not found|kicked|not a member|forbidden|blocked/i.test(msg)) return;
        entry.editTries = (Number(entry.editTries) || 0) + 1;
        if (entry.editTries <= 20) entry.editFail = Date.now();
      });
  }
}

const inflight = new Set();
// condition remplie : prédit le même costume à N + décalage
async function launch(e) {
  const target = e.target + panel.offset;
  e.launchTarget = target;
  if (!panel.channels.length) { e.launch = 'aucun canal d’envoi'; panel.lastError = 'Renseigne le canal où envoyer les prédictions.'; return false; }
  if (target <= maxKnownGameNumber()) { e.launch = 'trop tard (jeu déjà joué)'; panel.lateSkipped += 1; panel.lastError = `N°${target} non envoyé : jeu déjà joué.`; return false; }
  if (panel.pendingMessages.some((s) => s.target === target) || inflight.has(String(target))) { e.launch = 'doublon ignoré'; panel.duplicatesBlocked += 1; return false; } // un seul message par numéro de jeu
  inflight.add(String(target));
  try {
    const entry = { id: `pss-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: 'prev-suit', suit: e.suit, target, maxR: panel.maxR, format: panel.format, step: 0,
      status: 'en attente', messages: [], origin: { target: e.target, src: e.src }, createdAt: Date.now(), resolvedAt: null };
    entry.messages = await sendToChannels(renderFor(entry, null));
    if (!entry.messages.length) { e.launch = 'non envoyé'; return false; }
    panel.pendingMessages.push(entry);
    const st = statsOf(); st.sent += 1; panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null;
    e.launch = `envoyé N°${target}`;
    return true;
  } finally { inflight.delete(String(target)); }
}

// ── vérification (appelée à chaque cycle du bot) ────────────────────────────
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const maxDone = maxFinishedGameNumber();
    if (!maxDone) return;
    let changed = false;
    const close = (e, status, why) => { e.phase = 'clos'; e.status = status; e.why = why; e.closedAt = Date.now(); changed = true; };
    // 1) prédictions OBSERVÉES : costume venu à N-1 ET absent à N ?
    for (const e of panel.watches) {
      if (e.phase !== 'verif') continue;
      const prev = state.games.get(e.target - 1);
      const cur = state.games.get(e.target);
      if (!isPlayerHandComplete(prev)) { if (e.target + 1 <= maxDone) close(e, 'annulé', 'jeu N-1 inconnu'); continue; } // N-1 pas encore joué : on attend
      if (!hasSuit(prev, e.suit)) { close(e, 'non déclenché', 'costume absent à N-1'); statsOf().notTriggered += 1; continue; }
      if (cur && hasSuit(cur, e.suit)) { close(e, 'non déclenché', 'costume sorti à N'); statsOf().notTriggered += 1; continue; } // sorti dès les premières cartes : inutile d'attendre
      if (!isPlayerHandComplete(cur)) { if (e.target + 2 <= maxDone) close(e, 'annulé', 'jeu N manquant'); continue; }
      close(e, 'déclenché', 'venu à N-1, absent à N'); statsOf().triggered += 1;
      try { await launch(e); } catch (err) { panel.lastError = err.message; e.launch = 'erreur'; }
    }
    // 2) prédictions ENVOYÉES : rattrapages, résultat, édition du message
    for (const s of panel.pendingMessages) {
      if (s.status !== 'en attente') continue;
      let verdict = null; let hitAt = -1;
      for (let k = 0; k <= s.maxR; k++) {
        const g = state.games.get(s.target + k);
        if (!isDone(g)) { if (s.target + k + 2 <= maxDone) verdict = 'annulé'; break; }
        if (hasSuit(g, s.suit)) { verdict = 'gagné'; hitAt = k; break; }
        if (k === s.maxR) verdict = 'perdu';
        else if (s.step < k + 1) { s.step = k + 1; changed = true; editSent(s, null); }
      }
      if (!verdict) continue;
      changed = true; s.status = verdict; s.resolvedAt = Date.now();
      if (verdict === 'gagné') s.step = hitAt;
      if (verdict === 'annulé') continue;
      strategyRecap.noteEntry(s);
      editSent(s, verdict);
      const st = statsOf();
      if (verdict === 'gagné') { st.won += 1; st.byStep[s.step] = (st.byStep[s.step] || 0) + 1; } else st.lost += 1;
      const bs = st.bySuit[s.suit] || (st.bySuit[s.suit] = { won: 0, lost: 0 });
      if (verdict === 'gagné') bs.won += 1; else bs.lost += 1;
    }
    for (const s of panel.pendingMessages) {
      if (!s.editFail || Date.now() - s.editFail < 8000) continue;
      s.editFail = null;
      if (s.status === 'gagné' || s.status === 'perdu') editSent(s, s.status); else if (s.status === 'en attente') editSent(s, null);
    }
    // nettoyage : suivis récents (24 h) + tout ce qui est encore en attente
    const before = panel.watches.length + panel.pendingMessages.length;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    panel.watches = panel.watches.filter((e) => e.phase !== 'clos' || (e.closedAt || e.at) > cutoff).slice(-WATCH_MAX);
    const open = panel.pendingMessages.filter((s) => s.status === 'en attente');
    const done = panel.pendingMessages.filter((s) => s.status !== 'en attente').slice(-SENT_RESOLVED_MAX);
    panel.pendingMessages = [...done, ...open];
    if (changed || panel.watches.length + panel.pendingMessages.length !== before) persist();
  } catch (err) { panel.lastError = err.message; }
  finally { ticking = false; }
}

// ── réglages ────────────────────────────────────────────────────────────────
function config() {
  return { enabled: panel.enabled, selected: { ...panel.selected }, channels: [...panel.channels], offset: panel.offset, maxR: panel.maxR, format: panel.format };
}
function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = loss.parseChannels(patch.channels);
  if (patch.offset !== undefined) panel.offset = clampInt(patch.offset, 1, 40, DEFAULT_OFFSET);
  if (patch.maxR !== undefined) panel.maxR = clampInt(patch.maxR, 0, 9, DEFAULT_MAXR);
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.selected !== undefined) {
    const list = Array.isArray(patch.selected) ? patch.selected : Object.keys(patch.selected || {}).filter((k) => patch.selected[k]);
    panel.selected = Object.fromEntries(list.map((k) => [String(k), true]));
  }
  persist();
  return config();
}
function resetStats() { panel.stats = emptyStats(); panel.watches = []; panel.pendingMessages = panel.pendingMessages.filter((s) => s.status === 'en attente'); persist(); }
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }

// test : exemple de prédiction (jeu fictif) dans le canal d'envoi, marqué 🧪 — ni suivi ni vérifié
async function test() {
  if (!panel.channels.length) return { ok: false, error: 'Renseigne le canal où envoyer les prédictions.' };
  const out = renderFor({ format: panel.format, target: 1234, suit: '♦️', maxR: panel.maxR, step: 0 }, null);
  const sent = await sendToChannels({ ...out, text: `🧪 Test\n${out.text}` });
  return sent.length ? { ok: true, sent: sent.map((m) => m.chatId) } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

// ── vue pour le tableau de bord ─────────────────────────────────────────────
function status() {
  const st = statsOf(); const resolved = st.won + st.lost;
  const list = sources();
  const known = new Set(list.filter(isFollowable).map((s) => s.key));
  return {
    ...config(),
    sources: list.map((s) => ({ key: s.key, name: s.name, group: s.group, channels: s.channels || [], maxR: (s.maxR === null || s.maxR === undefined || s.maxR === '' ? null : Number(s.maxR)), followable: isFollowable(s), selected: !!panel.selected[s.key] })),
    sourceMaxR: SOURCE_MAXR,
    notFollowed: Object.keys(panel.selected).filter((k) => panel.selected[k] && list.some((s) => s.key === k && !isFollowable(s))).length,
    missingSelected: Object.keys(panel.selected).filter((k) => panel.selected[k] && !known.has(k)),
    channelNames: panel.channels.map((id) => panel.channelTitles[String(id)] || String(id)),
    following: panel.watches.filter((e) => e.phase === 'verif').length,
    waiting: panel.pendingMessages.filter((s) => s.status === 'en attente').length,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lateSkipped: panel.lateSkipped, duplicatesBlocked: panel.duplicatesBlocked,
    triggered: st.triggered, notTriggered: st.notTriggered, won: st.won, lost: st.lost, rate: pct(st.won, resolved), resolved,
    steps: Object.entries(st.byStep || {}).map(([k, n]) => ({ step: Number(k), n: Number(n) })).sort((a, b) => a.step - b.step),
    recent: panel.pendingMessages.slice(-10).reverse().map((s) => ({ target: s.target, suit: s.suit, status: s.status, step: s.step, originTarget: s.origin && s.origin.target, src: s.origin && s.origin.src })),
    lastWatches: panel.watches.filter((e) => e.phase === 'clos').slice(-10).reverse().map((e) => ({ target: e.target, suit: e.suit, status: e.status, why: e.why || '', launch: e.launch || '', src: e.src })),
    lastError: panel.lastError, channelTitles: panel.channelTitles,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { config: config(), watches: panel.watches, pendingMessages: panel.pendingMessages, seen: panel.seen, stats: panel.stats, sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lateSkipped: panel.lateSkipped, channelTitles: panel.channelTitles };
  try { store.patch({ prevSuit: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  const c = saved.config || {};
  panel.enabled = c.enabled === true;
  panel.channels = loss.parseChannels(c.channels);
  panel.offset = clampInt(c.offset, 1, 40, DEFAULT_OFFSET);
  panel.maxR = clampInt(c.maxR, 0, 9, DEFAULT_MAXR);
  panel.format = fmt.clampFormat(c.format || DEFAULT_FORMAT);
  panel.selected = c.selected && typeof c.selected === 'object' ? Object.fromEntries(Object.keys(c.selected).filter((k) => c.selected[k]).map((k) => [k, true])) : {};
  panel.watches = Array.isArray(saved.watches) ? saved.watches.filter((e) => e && e.id).slice(-WATCH_MAX) : [];
  panel.pendingMessages = Array.isArray(saved.pendingMessages) ? saved.pendingMessages.filter((s) => s && s.id).slice(-(SENT_RESOLVED_MAX + WATCH_MAX)) : [];
  panel.seen = Array.isArray(saved.seen) ? saved.seen.slice(-SEEN_MAX) : [];
  panel.stats = saved.stats && typeof saved.stats === 'object' ? saved.stats : null;
  panel.sentCount = Number(saved.sentCount) || 0; panel.lastSentAt = saved.lastSentAt || null; panel.lateSkipped = Number(saved.lateSkipped) || 0;
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
}
function restore() { try { const s = (store.read() || {}).prevSuit; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting(DB_KEY); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

module.exports = {
  panel, setSender, setSourceProvider, restore, restoreFromDb, persist, onOwnPost, tick, status, test, configure, resetStats, setChannelTitle, readPost,
};
