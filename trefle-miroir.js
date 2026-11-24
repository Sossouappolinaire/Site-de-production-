// trefle-miroir.js — « IMAGE INVERSE » du calcul de la stratégie « Trèfle ×3 » (demande admin).
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

const KEY = 'trefleTrio';
const DB_KEY = 'trefle_miroir_state';
const SEEN_MAX = 600;
const RESOLVED_MAX = 100;
const LABEL = 'Trèfle ×3 — image inverse';

const panel = { pendingMessages: [], seen: [], stats: null, sentCount: 0, lastSentAt: null, duplicatesBlocked: 0, lastError: null };
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
const maxFinishedGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; };
const maxKnownGameNumber = () => { let m = 0; for (const g of state.games.values()) if ((g.finished || g.dealing) && g.number > m) m = g.number; return m; };

// ── envoi / édition ─────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, { gameNumber: entry.target, suit: entry.suit, strategy: LABEL, maxR: entry.maxR, status: statusFr, rattrapage: entry.step || 0 }, null);
}
async function sendToChannels(channels, out) {
  const b = bot();
  if (!b) { panel.lastError = 'Aucun token Telegram configuré'; return []; }
  const opts = { ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}), ...(cfg().bypassGates ? { __bypassGates: true } : {}) };
  const results = await Promise.all(channels.map((id) => b.sendMessage(id, out.text, opts)
    .then((m) => (m && m.skipped ? { ok: false, skipped: true, id, why: m.why } : { ok: true, id, messageId: m.message_id }))
    .catch((e) => ({ ok: false, id, error: e.message }))));
  const sent = [];
  for (const r of results) {
    if (r.ok) sent.push({ chatId: r.id, messageId: r.messageId });
    else if (!r.skipped) panel.lastError = `${r.id} : ${r.error}`;
    else if (r.why) panel.lastError = `${r.id} : ${r.why}`;
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
function onPrediction(pred) {
  try {
    if (!pred || pred.strategy !== KEY || pred.silent) return false;
    if (!isActive()) return false;
    if (!pred.meta || !pred.meta.calc) return false; // seulement les prédictions du CALCUL (pas les déclencheurs fixes)
    const suit = mirrorSuit(pred.suit);
    if (!suit) return false;
    let channels = mirrorChannels();
    if (!channels.length) { panel.lastError = 'Renseigne le canal de l’image inverse.'; return false; }
    let main = []; try { main = strategyChannels(KEY, 'active').map((x) => String(x).toLowerCase()); } catch (_) { main = []; }
    channels = channels.filter((c) => !main.includes(String(c).toLowerCase())); // jamais dans le canal de la prédiction du calcul
    if (!channels.length) { panel.lastError = 'Le canal de l’image inverse est le même que celui du calcul : choisis un autre canal.'; return false; }
    const key = `${pred.target}:${suit}`;
    if (panel.seen.includes(key) || inflight.has(key)) { panel.duplicatesBlocked += 1; return false; }
    if (pred.target <= maxKnownGameNumber()) { panel.lastError = `Image N°${pred.target} non envoyée : jeu déjà joué.`; return false; }
    panel.seen.push(key); if (panel.seen.length > SEEN_MAX) panel.seen = panel.seen.slice(-SEEN_MAX);
    inflight.add(key);
    sendMirror(pred, suit, channels, key).catch((e) => { panel.lastError = e.message; }).finally(() => inflight.delete(key));
    return true;
  } catch (e) { panel.lastError = e.message; return false; }
}

async function sendMirror(pred, suit, channels, key) {
  const entry = {
    id: `tm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: 'trefle-miroir', suit, target: pred.target,
    maxR: pred.maxR != null ? pred.maxR : (cfg().maxR != null ? cfg().maxR : 4), format: pred.format || cfg().format, step: 0,
    status: 'en attente', messages: [], origin: { target: pred.target, suit: pred.suit, trigger: pred.trigger }, createdAt: Date.now(), resolvedAt: null,
  };
  entry.messages = await sendToChannels(channels, renderFor(entry, null));
  if (!entry.messages.length) { panel.seen = panel.seen.filter((k) => k !== key); return false; } // rien n'est parti : on pourra réessayer
  panel.pendingMessages.push(entry);
  const st = statsOf(); st.sent += 1; panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null;
  persist();
  return true;
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
    const open = panel.pendingMessages.filter((s) => s.status === 'en attente');
    const done = panel.pendingMessages.filter((s) => s.status !== 'en attente').slice(-RESOLVED_MAX);
    const next = [...done, ...open];
    if (changed || next.length !== panel.pendingMessages.length) { panel.pendingMessages = next; persist(); }
  } catch (err) { panel.lastError = err.message; }
  finally { ticking = false; }
}

// test : exemple (jeu fictif) dans le canal de l'image, marqué 🧪 — ni suivi ni vérifié
async function test() {
  const channels = mirrorChannels();
  if (!channels.length) return { ok: false, error: 'Renseigne le canal de l’image inverse.' };
  const out = renderFor({ format: cfg().format, target: 1234, suit: mirrorSuit('♣️'), maxR: cfg().maxR != null ? cfg().maxR : 4, step: 0 }, null);
  const sent = await sendToChannels(channels, { ...out, text: `🧪 Test — image inverse\n${out.text}` });
  return sent.length ? { ok: true, sent: sent.map((m) => m.chatId) } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

function resetStats() { panel.stats = emptyStats(); panel.pendingMessages = panel.pendingMessages.filter((s) => s.status === 'en attente'); persist(); }

// ── vue pour le tableau de bord ─────────────────────────────────────────────
function status() {
  const st = statsOf(); const resolved = st.won + st.lost;
  return {
    enabled: !!cfg().mirrorEnabled, calcOn: !!cfg().useCalc, active: isActive(), channels: mirrorChannels(),
    waiting: panel.pendingMessages.filter((s) => s.status === 'en attente').length,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, duplicatesBlocked: panel.duplicatesBlocked,
    won: st.won, lost: st.lost, rate: pct(st.won, resolved), resolved,
    recent: panel.pendingMessages.slice(-8).reverse().map((s) => ({ target: s.target, suit: s.suit, status: s.status, step: s.step, from: s.origin && s.origin.suit })),
    lastError: panel.lastError,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { pendingMessages: panel.pendingMessages, seen: panel.seen, stats: panel.stats, sentCount: panel.sentCount, lastSentAt: panel.lastSentAt };
  try { store.patch({ trefleMiroir: saved }); } catch (_) { /* tant pis */ }
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  panel.pendingMessages = Array.isArray(saved.pendingMessages) ? saved.pendingMessages.filter((s) => s && s.id).slice(-(RESOLVED_MAX + 200)) : [];
  panel.seen = Array.isArray(saved.seen) ? saved.seen.slice(-SEEN_MAX) : [];
  panel.stats = saved.stats && typeof saved.stats === 'object' ? saved.stats : null;
  panel.sentCount = Number(saved.sentCount) || 0; panel.lastSentAt = saved.lastSentAt || null;
}
function restore() { try { const s = (store.read() || {}).trefleMiroir; if (s) applySaved(s); } catch (_) { /* défauts */ } }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting(DB_KEY); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

// remise à zéro de 00h00 : données du jour effacées, réglages (dans la stratégie) conservés
function wipeDay() {
  panel.pendingMessages = []; panel.seen = []; panel.stats = null; panel.sentCount = 0; panel.lastSentAt = null; panel.duplicatesBlocked = 0; panel.lastError = null;
  persist();
}

module.exports = { panel, mirrorSuit, setSender, restore, restoreFromDb, persist, onPrediction, tick, status, test, resetStats, wipeDay };
