// trefle-miroir.js — « TRIO DE TRÈFLE » : canal 1 (♣️) et canal 3 (image inverse) de la stratégie « Trèfle ×3 » (demande admin).
//
//  Trio de canaux (v153) — les trois peuvent prédire au même moment :
//    • CANAL 1 (« canal des déclencheurs fixes ») : reçoit UNIQUEMENT du ♣️ — les déclencheurs fixes (♣️ chez le joueur sur
//      N-2, N-1 et N), quelle que soit la configuration, ET, quand le calcul est activé, la prédiction du calcul si elle est ♣️ ;
//    • CANAL 2 (« canal du calcul ») : toutes les prédictions du calcul IB × 0,21 (envoyées par le moteur, bot.js) ;
//    • CANAL 3 (« image inverse ») : l'inverse de chaque prédiction du canal 2 (ci-dessous).
//    Exemple : le calcul prédit ♣️ sur N+1 → canal 1 ♣️ · canal 2 ♣️ · canal 3 ❤️.
//    Calcul désactivé : le moteur envoie lui-même les déclencheurs fixes (♣️) dans le canal 1 ; ce module ne fait rien.
//    Calcul activé : le moteur ne prédit plus que le calcul (canal 2) ; ce module prend en charge le canal 1 (déclencheurs fixes
//    + calcul ♣️, un seul message par jeu) et le canal 3, vérifie et édite chaque message (✅ / ❌) à part.
//
//  « IMAGE INVERSE » du calcul de la stratégie « Trèfle ×3 » (demande admin).
//
// Quand l'option « calcul IB × 0,21 » de Trèfle ×3 est ACTIVÉE et que l'option « Envoyer aussi l'image inverse
// dans un autre canal » est cochée, CHAQUE prédiction du calcul est doublée, dans le canal choisi, par son IMAGE :
//
//      ❤️ ↔ ♣️        (le calcul prédit ♣️ → l'image est ❤️, et inversement)
//      ♦️ ↔ ♠️        (le calcul prédit ♠️ → l'image est ♦️, et inversement)
//
//  • même numéro de jeu et mêmes rattrapages que la prédiction du calcul, même format de message ;
//  • l'image est vérifiée à son tour sur la main du JOUEUR (rattrapages compris) et son message est édité (✅ / ❌) ;
//  • jamais deux images pour le même jeu, jamais dans le canal où part déjà la prédiction du calcul ;
//  • les envois passent par le point d'envoi unique du bot (arrêt global, arrêt par canal, anti-doublon) ;
//  • réglages (dans la page de la stratégie) : state.strategies.trefleTrio.mirrorEnabled / mirrorChannels.
'use strict';
const strategyRecap = require('./strategy-recap');
const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const { state, hasSuit, strategyChannels } = require('./predictor');
const strategies = require('./strategies');

const KEY = 'trefleTrio';
const DB_KEY = 'trefle_miroir_state';
const SEEN_MAX = 600;
const RESOLVED_MAX = 100;
const LABEL = 'Trèfle ×3 — image inverse';
const LABEL_T = 'Trèfle ×3';
const CLUB = '♣️';

const panel = { pendingMessages: [], seen: [], stats: null, statsT: null, sentCount: 0, sentCountT: 0, lastSentAt: null, lastSentAtT: null, duplicatesBlocked: 0, duplicatesBlockedT: 0, lastError: null, lastErrorT: null, lastScanned: 0 };
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
const bot = () => (typeof sender === 'function' ? sender() : null);

// ── image d'un costume : ❤️ ↔ ♣️ et ♦️ ↔ ♠️ ────────────────────────────────────
const BASE_MIRROR = { '♣': '♥', '♥': '♣', '♦': '♠', '♠': '♦' };
function baseOf(suit) {
  const ch = [...String(suit == null ? '' : suit).trim()][0] || '';
  return ch === '❤' ? '♥' : ch;
}
// retourne le costume image (avec sélecteur d'emoji, comme CALC_SUITS) ou null si le costume est inconnu
function mirrorSuit(suit) {
  const m = BASE_MIRROR[baseOf(suit)];
  return m ? `${m}\uFE0F` : null;
}

const cfg = () => state.strategies[KEY] || {};
const mirrorChannels = () => (Array.isArray(cfg().mirrorChannels) ? cfg().mirrorChannels.map(String) : []);
const isActive = () => !!(cfg().useCalc && cfg().mirrorEnabled);
const isDone = (g) => !!g && g.finished && g.complete !== false;
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const emptyStats = () => ({ sent: 0, won: 0, lost: 0, byStep: {}, bySuit: {} });
const statsOf = () => { panel.stats = panel.stats && typeof panel.stats === 'object' ? { ...emptyStats(), ...panel.stats } : emptyStats(); return panel.stats; };
const statsOfT = () => { panel.statsT = panel.statsT && typeof panel.statsT === 'object' ? { ...emptyStats(), ...panel.statsT } : emptyStats(); return panel.statsT; };
const isTrefle = (e) => !!e && e.kind === 'trefle';
const statsFor = (e) => (isTrefle(e) ? statsOfT() : statsOf());
const setErr = (kind, msg) => { if (kind === 'trefle') panel.lastErrorT = msg; else panel.lastError = msg; };
const maxFinishedGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; };

// ── envoi / édition ─────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, { gameNumber: entry.target, suit: entry.suit, strategy: isTrefle(entry) ? LABEL_T : LABEL, maxR: entry.maxR, status: statusFr, rattrapage: entry.step || 0 }, null);
}
async function sendToChannels(channels, out, kind) {
  const b = bot();
  if (!b) { setErr(kind, 'Aucun token Telegram configuré'); return []; }
  const opts = { ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}), ...(cfg().bypassGates ? { __bypassGates: true } : {}) };
  const results = await Promise.all(channels.map((id) => b.sendMessage(id, out.text, opts)
    .then((m) => (m && m.skipped ? { ok: false, skipped: true, id, why: m.why } : { ok: true, id, messageId: m.message_id }))
    .catch((e) => ({ ok: false, id, error: e.message }))));
  const sent = [];
  for (const r of results) {
    if (r.ok) sent.push({ chatId: r.id, messageId: r.messageId });
    else if (!r.skipped) setErr(kind, `${r.id} : ${r.error}`);
    else if (r.why) setErr(kind, `${r.id} : ${r.why}`);
  }
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

// ── appelé par bot.js dès qu'une prédiction est créée et autorisée à partir ─────────────────────
const inflight = new Set();
const lower = (x) => String(x).toLowerCase();
const mainChannels = () => { try { return strategyChannels(KEY, 'active').map(lower); } catch (_) { return []; } };

// canal 1 : canal des déclencheurs fixes (publié). Actif seulement quand le calcul est activé : sinon le moteur l'alimente lui-même.
const trefleChannels = () => { const c = cfg(); const l = Array.isArray(c.publishedChannels) ? c.publishedChannels : (Array.isArray(c.channels) ? c.channels : []); return l.map(String); };
const isTrefleActive = () => !!(cfg().enabled && cfg().useCalc);

function inWindow(n) {
  let wins = strategies.sanitizeWindows(cfg().windows); if (!wins.length) wins = strategies.BY_KEY.trefleTrio.defaults.windows;
  n = Number(n); return !Number.isFinite(n) || wins.some(([a, b]) => n >= a && n <= b);
}
function onPrediction(pred) {
  try {
    if (!pred || pred.strategy !== KEY || pred.silent) return false;
    if (!pred.meta || !pred.meta.calc) return false; // seulement les prédictions du CALCUL (pas les déclencheurs fixes)
    if (!inWindow(pred.trigger)) return false; // les 3 canaux suivent le même créneau de jeux
    let sent = false;
    // canal 1 : le calcul prédit ♣️ → on le voit aussi dans le canal des déclencheurs (♣️ uniquement)
    if (isTrefleActive() && cfg().calcClubToChannel1 !== false && baseOf(pred.suit) === '♣') { // option (cochée par défaut) : le ♣️ du calcul s'affiche aussi dans le canal 1
      sent = queueTrefle({ target: pred.target, trigger: pred.trigger, src: 'calc', maxR: pred.maxR, format: pred.format }) || sent;
    }
    if (isActive()) sent = queueInverse(pred) || sent;
    return sent;
  } catch (e) { panel.lastError = e.message; return false; }
}

// canal 3 : image inverse de la prédiction du canal 2
function queueInverse(pred) {
  const suit = mirrorSuit(pred.suit);
  if (!suit) return false;
  let channels = mirrorChannels();
  if (!channels.length) { panel.lastError = 'Renseigne le canal de l’image inverse.'; return false; }
  const main = mainChannels();
  channels = channels.filter((c) => !main.includes(lower(c))); // jamais dans le canal de la prédiction du calcul
  if (!channels.length) { panel.lastError = 'Le canal de l’image inverse est le même que celui du calcul : choisis un autre canal.'; return false; }
  const key = `${pred.target}:${suit}`;
  if (panel.seen.includes(key) || inflight.has(key)) { panel.duplicatesBlocked += 1; return false; }
  if (pred.target <= maxFinishedGameNumber()) { panel.lastError = `Image N°${pred.target} non envoyée : jeu déjà joué.`; return false; }
  panel.seen.push(key); if (panel.seen.length > SEEN_MAX) panel.seen = panel.seen.slice(-SEEN_MAX);
  inflight.add(key);
  sendEntry({ kind: 'inverse', suit, target: pred.target, maxR: pred.maxR, format: pred.format, origin: { target: pred.target, suit: pred.suit, trigger: pred.trigger } }, channels, key)
    .catch((e) => { panel.lastError = e.message; }).finally(() => inflight.delete(key));
  return true;
}

// canal 1 : une prédiction ♣️ (déclencheur fixe ou calcul ♣️) ; un seul message par jeu cible, quelle que soit la source
function queueTrefle({ target, trigger, src, maxR, format }) {
  let channels = trefleChannels();
  if (!channels.length) { panel.lastErrorT = 'Renseigne le canal 1 (canal des déclencheurs fixes).'; return false; }
  const main = mainChannels();
  // le calcul ♣️ part déjà par le moteur si le canal 1 est aussi le canal du calcul
  if (src === 'calc') channels = channels.filter((c) => !main.includes(lower(c)));
  if (!channels.length) return false;
  const key = `T:${target}`;
  if (panel.seen.includes(key) || inflight.has(key)) { panel.duplicatesBlockedT += 1; return false; }
  // canal 1 = canal 2 : si le moteur a déjà une prédiction ♣️ en cours pour ce jeu, pas de doublon
  if (src === 'fixed' && channels.some((c) => main.includes(lower(c)))
    && (state.predictions || []).some((p) => p.strategy === KEY && p.status === 'en attente' && p.target === target && baseOf(p.suit) === '♣')) { panel.duplicatesBlockedT += 1; return false; }
  if (target <= maxFinishedGameNumber()) { panel.lastErrorT = `Prédiction ♣️ N°${target} non envoyée : jeu déjà joué.`; return false; }
  panel.seen.push(key); if (panel.seen.length > SEEN_MAX) panel.seen = panel.seen.slice(-SEEN_MAX);
  inflight.add(key);
  sendEntry({ kind: 'trefle', src, suit: CLUB, target, maxR: maxR != null ? maxR : undefined, format, origin: { target, suit: CLUB, trigger } }, channels, key)
    .catch((e) => { panel.lastErrorT = e.message; }).finally(() => inflight.delete(key));
  return true;
}

async function sendEntry(base, channels, key) {
  const kind = base.kind;
  const entry = {
    id: `${kind === 'trefle' ? 'tt' : 'tm'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: kind === 'trefle' ? 'trefle-canal1' : 'trefle-miroir',
    kind, src: base.src || null, suit: base.suit, target: base.target,
    maxR: base.maxR != null ? base.maxR : (cfg().maxR != null ? cfg().maxR : 4), format: base.format || cfg().format, step: 0,
    status: 'en attente', messages: [], origin: base.origin, createdAt: Date.now(), resolvedAt: null,
  };
  entry.messages = await sendToChannels(channels, renderFor(entry, null), kind);
  if (!entry.messages.length) { panel.seen = panel.seen.filter((k) => k !== key); return false; } // rien n'est parti : on pourra réessayer
  panel.pendingMessages.push(entry);
  if (kind === 'trefle') { statsOfT().sent += 1; panel.sentCountT += 1; panel.lastSentAtT = Date.now(); panel.lastErrorT = null; }
  else { statsOf().sent += 1; panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null; }
  persist();
  return true;
}

// ── canal 1 : déclencheurs fixes quand le calcul est activé (le moteur ne s'en occupe plus) ─────────────
// Règle d'origine : sur un déclencheur N (liste + créneaux de la stratégie), ♣️ chez le joueur sur N-2, N-1 et N → ♣️ sur N+1
// (rattrapages réglés) ; un seul cycle à la fois pour les déclencheurs fixes.
function evalFixed(g) {
  const c = cfg();
  const n = Number(g.number);
  const def = strategies.BY_KEY.trefleTrio.defaults;
  let triggers = strategies.sanitizeTriggers(c.triggers); if (!triggers.length) triggers = def.triggers;
  let wins = strategies.sanitizeWindows(c.windows); if (!wins.length) wins = def.windows;
  if (!triggers.includes(n)) return;
  if (!wins.some(([a, b]) => n >= a && n <= b)) return;
  if (panel.pendingMessages.some((s) => isTrefle(s) && s.src === 'fixed' && s.status === 'en attente')) return; // un seul cycle à la fois
  const club = strategies.normSuit(CLUB);
  for (const k of [n - 2, n - 1, n]) {
    const gg = state.games.get(k);
    if (!isDone(gg)) return;
    const ps = strategies.suitsOf(gg.playerSuits);
    if (ps.length < 2) return;
    if (!ps.some((x) => strategies.normSuit(x) === club)) return;
  }
  const lead = Math.max(1, Math.min(20, parseInt(c.lead, 10) || 1));
  queueTrefle({ target: n + lead, trigger: n, src: 'fixed', maxR: c.maxR, format: c.format });
}
function scanFixed() {
  const maxDone = maxFinishedGameNumber();
  if (!maxDone) return;
  if (!isTrefleActive()) { panel.lastScanned = maxDone; return; }
  if (!panel.lastScanned || maxDone < panel.lastScanned || maxDone - panel.lastScanned > 15) { panel.lastScanned = maxDone; return; } // pas de rattrapage rétroactif
  let changed = false;
  for (let n = panel.lastScanned + 1; n <= maxDone; n++) {
    const g = state.games.get(n);
    if (isDone(g)) { try { evalFixed(g); } catch (e) { panel.lastErrorT = e.message; } }
    changed = true;
  }
  panel.lastScanned = maxDone;
  if (changed) persist();
}

// ── vérification (appelée à chaque cycle du bot) ────────────────────────────
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    scanFixed();
    const maxDone = maxFinishedGameNumber();
    if (!maxDone) return;
    let changed = false;
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
      const st = statsFor(s);
      if (verdict === 'gagné') { st.won += 1; st.byStep[s.step] = (st.byStep[s.step] || 0) + 1; } else st.lost += 1;
      const bs = st.bySuit[s.suit] || (st.bySuit[s.suit] = { won: 0, lost: 0 });
      if (verdict === 'gagné') bs.won += 1; else bs.lost += 1;
    }
    for (const s of panel.pendingMessages) {
      if (!s.editFail || Date.now() - s.editFail < 8000) continue;
      s.editFail = null;
      if (s.status === 'gagné' || s.status === 'perdu') editSent(s, s.status); else if (s.status === 'en attente') editSent(s, null);
    }
    const open = panel.pendingMessages.filter((s) => s.status === 'en attente');
    const done = panel.pendingMessages.filter((s) => s.status !== 'en attente').slice(-RESOLVED_MAX);
    const next = [...done, ...open];
    if (changed || next.length !== panel.pendingMessages.length) { panel.pendingMessages = next; persist(); }
  } catch (err) { panel.lastError = err.message; }
  finally { ticking = false; }
}

// test : exemple (jeu fictif) dans le canal de l'image, marqué 🧪 — ni suivi ni vérifié
async function test(kind) {
  if (kind === 'trefle') {
    const ch = trefleChannels();
    if (!ch.length) return { ok: false, error: 'Renseigne le canal 1 (canal des déclencheurs fixes).' };
    const o = renderFor({ kind: 'trefle', format: cfg().format, target: 1234, suit: CLUB, maxR: cfg().maxR != null ? cfg().maxR : 4, step: 0 }, null);
    const sent = await sendToChannels(ch, { ...o, text: `🧪 Test — canal 1 (♣️)\n${o.text}` }, 'trefle');
    return sent.length ? { ok: true, sent: sent.map((m) => m.chatId) } : { ok: false, error: panel.lastErrorT || 'Envoi impossible' };
  }
  const channels = mirrorChannels();
  if (!channels.length) return { ok: false, error: 'Renseigne le canal de l’image inverse.' };
  const out = renderFor({ format: cfg().format, target: 1234, suit: mirrorSuit('♣️'), maxR: cfg().maxR != null ? cfg().maxR : 4, step: 0 }, null);
  const sent = await sendToChannels(channels, { ...out, text: `🧪 Test — image inverse\n${out.text}` });
  return sent.length ? { ok: true, sent: sent.map((m) => m.chatId) } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

function resetStats() { panel.stats = emptyStats(); panel.statsT = emptyStats(); panel.pendingMessages = panel.pendingMessages.filter((s) => s.status === 'en attente'); persist(); }

// ── vue pour le tableau de bord ─────────────────────────────────────────────
function status() {
  const st = statsOf(); const resolved = st.won + st.lost;
  const stT = statsOfT(); const resolvedT = stT.won + stT.lost;
  const pend = (t) => panel.pendingMessages.filter((s) => (t ? isTrefle(s) : !isTrefle(s)));
  return {
    // canal 1 (♣️ : déclencheurs fixes + calcul ♣️) — pris en charge ici seulement quand le calcul est activé
    trefle: {
      active: isTrefleActive(), channels: trefleChannels(), waiting: pend(true).filter((s) => s.status === 'en attente').length,
      sentCount: panel.sentCountT, lastSentAt: panel.lastSentAtT, duplicatesBlocked: panel.duplicatesBlockedT,
      won: stT.won, lost: stT.lost, rate: pct(stT.won, resolvedT), resolved: resolvedT,
      recent: pend(true).slice(-8).reverse().map((s) => ({ target: s.target, suit: s.suit, status: s.status, step: s.step, src: s.src })),
      lastError: panel.lastErrorT,
    },
    enabled: !!cfg().mirrorEnabled, calcOn: !!cfg().useCalc, active: isActive(), channels: mirrorChannels(),
    waiting: pend(false).filter((s) => s.status === 'en attente').length,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, duplicatesBlocked: panel.duplicatesBlocked,
    won: st.won, lost: st.lost, rate: pct(st.won, resolved), resolved,
    recent: pend(false).slice(-8).reverse().map((s) => ({ target: s.target, suit: s.suit, status: s.status, step: s.step, from: s.origin && s.origin.suit })),
    lastError: panel.lastError,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { pendingMessages: panel.pendingMessages, seen: panel.seen, stats: panel.stats, statsT: panel.statsT, sentCount: panel.sentCount, sentCountT: panel.sentCountT, lastSentAt: panel.lastSentAt, lastSentAtT: panel.lastSentAtT, lastScanned: panel.lastScanned };
  try { store.patch({ trefleMiroir: saved }); } catch (_) { /* tant pis */ }
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  panel.pendingMessages = Array.isArray(saved.pendingMessages) ? saved.pendingMessages.filter((s) => s && s.id).slice(-(RESOLVED_MAX + 200)) : [];
  panel.seen = Array.isArray(saved.seen) ? saved.seen.slice(-SEEN_MAX) : [];
  panel.stats = saved.stats && typeof saved.stats === 'object' ? saved.stats : null;
  panel.statsT = saved.statsT && typeof saved.statsT === 'object' ? saved.statsT : null;
  panel.sentCount = Number(saved.sentCount) || 0; panel.lastSentAt = saved.lastSentAt || null;
  panel.sentCountT = Number(saved.sentCountT) || 0; panel.lastSentAtT = saved.lastSentAtT || null; panel.lastScanned = Number(saved.lastScanned) || 0;
}
function restore() { try { const s = (store.read() || {}).trefleMiroir; if (s) applySaved(s); } catch (_) { /* défauts */ } }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting(DB_KEY); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

// remise à zéro de 00h00 : données du jour effacées, réglages (dans la stratégie) conservés
function wipeDay() {
  panel.pendingMessages = []; panel.seen = []; panel.stats = null; panel.statsT = null; panel.sentCount = 0; panel.sentCountT = 0; panel.lastSentAt = null; panel.lastSentAtT = null; panel.duplicatesBlocked = 0; panel.duplicatesBlockedT = 0; panel.lastError = null; panel.lastErrorT = null; panel.lastScanned = 0;
  persist();
}

module.exports = { panel, mirrorSuit, setSender, restore, restoreFromDb, persist, onPrediction, tick, status, test, resetStats, wipeDay };
