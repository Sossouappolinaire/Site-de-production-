// miracle-serie.js — bouton « 🔁 Miracle série » (demande admin, v148).
//
//  Construit comme « Miracle prediction » (miracle-prediction.js) : mêmes 3 modes de suivi (stratégies cochées / compteur parité +
//  analyse fin de numéro / tout le site), même canal d'envoi, même format, mêmes rattrapages, même règle de proximité, mêmes
//  stratégies suivies (réglées sur 3 rattrapages). La différence est ce qui se passe APRÈS LA PERTE :
//
//  Miracle     : reprend UNE seule prédiction après la perte, puis s'arrête.
//  Miracle série : après la perte (ou N pertes d'affilée, réglage « selon l'analyse »), il prédit la prédiction suivante de la
//                  stratégie, la fait VÉRIFIER, puis enchaîne — une prédiction à la fois — tant que le rattrapage obtenu reste
//                  le MÊME que celui de la première prédiction de la série ; dès qu'il est différent, il s'arrête et attend une nouvelle perte.
//
//  Règle (demande admin) — le rattrapage de la PREMIÈRE prédiction de la série sert de référence :
//     première = ✅0️⃣ → il prédit la suivante, et continue tant que le rattrapage reste ✅0️⃣ ; il s'arrête dès qu'il est différent de ✅0️⃣ ;
//     première = ✅1️⃣ → il continue tant que le rattrapage reste ✅1️⃣ ; il s'arrête dès qu'il est différent de ✅1️⃣ ;
//     première = ✅2️⃣ → même principe : il continue tant que le rattrapage reste ✅2️⃣ ;
//     première = ✅3️⃣ ou ✅4️⃣ (ou ❌) → PAS de référence : il n'envoie plus rien et ATTEND qu'une prédiction de la stratégie arrive en ✅0️⃣ ou ✅1️⃣ ;
//        ce résultat devient la référence : il prédit alors la suivante et continue tant que le rattrapage reste identique, s'arrête dès qu'il est différent ;
//     🚫 prédiction annulée (jeux illisibles) : ni arrêt ni référence, il passe à la suivante.
//  La prédiction dont le résultat est différent a bien été envoyée : c'est elle qui clôt la série.
//
//  Pas de consensus ni d'alertes privées (ce sont des fonctions de Miracle prediction). Une unité de suivi = un CANAL source ;
//  00h00 (Abidjan) : tout repart de zéro, seules les longueurs moyennes de séries sont gardées.
'use strict';

const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const loss = require('./loss-return'); // parsePost (lecture d'une publication) et parseChannels
const { state, hasSuit } = require('./predictor');
let strategyRecap = null;
try { strategyRecap = require('./strategy-recap'); } catch (_) { strategyRecap = null; }

const DB_KEY = 'miracle_serie_state';
const SOURCE_MAXR = 3;            // rattrapage exigé des stratégies suivies (comme Miracle)
const DEFAULT_MAXR = 3;
const DEFAULT_FORMAT = 107;
const DEFAULT_PROX = 2;
const REF_OK = ['0', '1', '2'];     // rattrapages qui servent de référence quand ils sont celui de la première prédiction de la série
const RESTART_OK = ['0', '1'];    // si la première est trop tardive (✅3️⃣, ✅4️⃣, ❌) : on attend un ✅0️⃣ ou ✅1️⃣ de la stratégie pour commencer
const DEFAULT_LOSSES = 1;         // pertes d'affilée de la stratégie avant de démarrer une série (1 = « après la perte »)
const MODES = ['select', 'parity', 'all'];
const SEEN_MAX = 2000;
const WATCH_MAX = 800;
const SENT_RESOLVED_MAX = 100;
const CAND_MAX = 100;
const SEND_MAX_MS = 20000;

const panel = {
  enabled: false, mode: 'all', selected: {}, channels: [], maxR: DEFAULT_MAXR, format: DEFAULT_FORMAT,
  proximity: DEFAULT_PROX, lossesNeeded: DEFAULT_LOSSES,
  units: {},            // chat → { lossRun, active, armed, armedAt, count, cycles, runs, avg, names, lastLossAt, lastEnd }
  watches: [],          // prédictions observées { id, chat, target, suit, sig, names, followable, status, step, taken, at }
  candidates: [],       // prédictions reprises, en attente de proximité
  pendingMessages: [],  // prédictions envoyées par le bouton
  seen: [], stats: null, sentCount: 0, lastSentAt: null, lateSkipped: 0, duplicatesBlocked: 0,
  channelTitles: {}, lastError: null, lastSkip: null, lastMax: 0,
};

let sender = null; let sourceProvider = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
function setSourceProvider(fn) { sourceProvider = typeof fn === 'function' ? fn : null; }
const bot = () => (typeof sender === 'function' ? sender() : null);

const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const norm = (c) => String(c == null ? '' : c).trim().toLowerCase();
// main du joueur terminée sans attendre le banquier : jeu fini, ou 3 cartes, ou 2 cartes valant 6+ (il reste)
const playerFinal = (g) => !!g && (g.finished ? g.complete !== false : (Number(g.playerCards) >= 3 || (Number(g.playerCards) === 2 && Number(g.playerValue) >= 6)));
const hasPlayerCards = (g) => !!g && Array.isArray(g.player) && g.player.length > 0;
// résultat d'une prédiction (jeu N puis rattrapages N+1 … N+maxR) lu sur la main du JOUEUR uniquement
function verdictOf(target, suit, maxR, maxDone, onStep) {
  for (let k = 0; k <= maxR; k++) {
    const g = state.games.get(target + k);
    if (!hasPlayerCards(g)) return target + k + 2 <= maxDone ? { verdict: 'annulé', hitAt: -1 } : null;
    if (hasSuit(g, suit)) return { verdict: 'gagné', hitAt: k };
    if (!playerFinal(g)) return null; // le joueur peut encore tirer : pas de perte tant que sa main n'est pas terminée
    if (k === maxR) return { verdict: 'perdu', hitAt: -1 };
    if (onStep) onStep(k + 1);
  }
  return null;
}
const maxFinishedGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; };
// « jeu en direct » = plus grand numéro commencé (en distribution ou terminé)
const liveNumber = () => { let m = 0; for (const g of state.games.values()) if ((g.finished || g.dealing) && g.number > m) m = g.number; return m; };
const emptyStats = () => ({ sent: 0, won: 0, lost: 0, byStep: {}, bySuit: {} });
const statsOf = () => { panel.stats = panel.stats && typeof panel.stats === 'object' ? { ...emptyStats(), ...panel.stats } : emptyStats(); return panel.stats; };
const withTimeout = (p, ms, label) => Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} : pas de réponse (${ms / 1000} s)`)), ms))]);

// ── sources et périmètre ────────────────────────────────────────────────────
let srcCache = { at: 0, list: [] };
function sources() {
  if (Date.now() - srcCache.at < 4000) return srcCache.list;
  let list = [];
  try { list = sourceProvider ? (sourceProvider() || []) : []; } catch (_) { list = []; }
  srcCache = { at: Date.now(), list };
  return list;
}
const isFollowable = (s) => !!s && s.maxR !== null && s.maxR !== undefined && s.maxR !== '' && Number(s.maxR) === SOURCE_MAXR;
function inScope(s) {
  if (!s) return false;
  if (panel.mode === 'all') return true;
  if (panel.mode === 'parity') return s.parity === true;
  return !!panel.selected[s.key];
}
const ownChannel = (chat) => (panel.channels || []).some((c) => norm(c) === chat);
function scopedSourcesOf(chat) { return sources().filter((s) => inScope(s) && (s.channels || []).some((c) => norm(c) === chat)); }

// ── lecture d'une publication ───────────────────────────────────────────────
// loss.parsePost ne comprend ni « #N1234 » (96 formats sur 108) ni les chiffres « gras » Unicode, et lit « en cours » comme le costume cœur.
function readPost(text) {
  if (typeof text !== 'string') return null;
  const t = text
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, (ch) => ch.normalize('NFKC')) // 𝐍𝟏𝟐𝟑𝟒 → N1234
    .replace(/(#|№)\s*N(?=\s*\d)/gi, '$1')                             // #N1234 → #1234
    .replace(/\bcours\b/gi, ' ');                                      // « en cours » n'est pas le costume cœur
  return loss.parsePost(t);
}

// ── observation ─────────────────────────────────────────────────────────────
function unitOf(chat, names) {
  const u = panel.units[chat] || (panel.units[chat] = { lossRun: 0, active: false, armed: false, armedAt: 0, count: 0, ref: null, waiting: false, cycles: 0, runs: [], avg: 0, names: '', lastLossAt: null, lastEnd: null });
  if (!Array.isArray(u.runs)) u.runs = [];
  if (names) u.names = names;
  return u;
}
// appelé pour chaque message ENVOYÉ par le bot (point d'envoi unique de bot.js)
function onOwnPost(chatId, text) {
  try {
    if (!panel.enabled || chatId == null) return false;
    const chat = norm(chatId);
    if (ownChannel(chat)) return false; // jamais son propre canal d'envoi
    const src = scopedSourcesOf(chat);
    if (!src.length) return false;
    const post = readPost(text);
    if (!post) return false;
    const names = src.map((s) => s.name).join(' / ').slice(0, 140);
    const sig = src.map((s) => s.key).sort().join('|');
    const followable = src.every(isFollowable);
    let changed = false;
    for (const suit of post.suits) {
      const key = `${chat}:${post.target}:${suit}`;
      if (panel.seen.includes(key)) continue;
      panel.seen.push(key); if (panel.seen.length > SEEN_MAX) panel.seen = panel.seen.slice(-SEEN_MAX);
      panel.watches.push({ id: `ms-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, chat, target: post.target, suit, sig, names, followable, status: 'en cours', step: 0, at: Date.now() });
      changed = true;
    }
    if (changed) { unitOf(chat, names); if (panel.watches.length > WATCH_MAX) panel.watches = panel.watches.slice(-WATCH_MAX); persist(); }
    return changed;
  } catch (e) { panel.lastError = e.message; return false; }
}

// ── envoi / édition ─────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, { gameNumber: entry.target, suit: entry.suit, strategy: 'Miracle série', maxR: entry.maxR, status: statusFr, rattrapage: entry.step || 0 }, null);
}
async function sendToChannels(out) {
  const b = bot();
  if (!b) { panel.lastError = 'Aucun token Telegram configuré'; return []; }
  const results = await Promise.all((panel.channels || []).map((id) => withTimeout(b.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {}), SEND_MAX_MS, 'envoi Telegram')
    .then((m) => (m && m.skipped ? { ok: false, skipped: true, id, why: m.gated ? 'mode du canal / « envoi après perte » : le canal retient cette prédiction' : m.duplicate ? 'déjà envoyée dans ce canal (anti-doublon)' : 'canal en pause, jeu instable ou ralenti' } : { ok: true, id, messageId: m.message_id }))
    .catch((e) => ({ ok: false, id, error: e.message }))));
  const sent = [];
  for (const r of results) {
    if (r.ok) sent.push({ chatId: r.id, messageId: r.messageId });
    else if (r.skipped) panel.lastSkip = { chat: String(r.id), why: r.why, at: Date.now() };
    else panel.lastError = `${r.id} : ${r.error}`;
  }
  return sent;
}
function editSent(entry, statusFr) {
  const b = bot(); if (!b) return;
  const out = renderFor(entry, statusFr);
  for (const m of entry.messages || []) {
    Promise.resolve().then(() => withTimeout(b.editMessageText(out.text, { chat_id: m.chatId, message_id: m.messageId, ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}) }), SEND_MAX_MS, 'édition Telegram'))
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
// un numéro de jeu revient chaque jour : un doublon n'existe que pour le même jeu ET le même costume, en cours ou envoyé il y a moins de 2 h
const DUP_WINDOW_MS = 2 * 3600 * 1000;
const alreadySent = (target, suit) => inflight.has(`${target}:${suit}`)
  || panel.pendingMessages.some((s) => s.target === target && s.suit === suit && (s.status === 'en attente' || Date.now() - (Number(s.createdAt) || 0) < DUP_WINDOW_MS));
async function launch({ target, suit, src, chat, position }) {
  if (!panel.channels.length) { panel.lastError = 'Renseigne le canal où envoyer les prédictions Miracle série.'; return 'aucun canal'; }
  if (target <= liveNumber()) { panel.lateSkipped += 1; return 'trop tard'; }
  if (alreadySent(target, suit)) { panel.duplicatesBlocked += 1; return 'doublon'; }
  const inflightKey = `${target}:${suit}`;
  inflight.add(inflightKey);
  try {
    const entry = { id: `mse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: 'miracle-serie', kind: 'serie', chat: chat || null, position: position || 1, suit, target, maxR: panel.maxR, format: panel.format, step: 0, status: 'en attente',
      messages: [], origin: { src: String(src || '').slice(0, 140) }, createdAt: Date.now(), resolvedAt: null };
    entry.messages = await sendToChannels(renderFor(entry, null));
    if (!entry.messages.length) return 'non envoyé';
    panel.pendingMessages.push(entry);
    const st = statsOf(); st.sent += 1; panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null;
    return 'envoyé';
  } finally { inflight.delete(inflightKey); }
}

// ── cycle de la série ───────────────────────────────────────────────────────
// attente → (N pertes d'affilée de la stratégie) → série : une prédiction à la fois, la suivante part quand la précédente est vérifiée
// → le résultat (rattrapage) de la première sert de référence → dès qu'un résultat est différent : fin de la série → attente d'une nouvelle perte.
function startCycle(u) { u.active = true; u.armed = true; u.armedAt = Date.now(); u.lossRun = 0; u.count = 0; u.ref = null; u.waiting = false; }
function endCycle(u) {
  if (u.count > 0) { u.runs.push(u.count); if (u.runs.length > 500) u.runs = u.runs.slice(-500); }
  u.cycles = (Number(u.cycles) || 0) + 1; u.lastEnd = Date.now();
  u.active = false; u.armed = false; u.lossRun = 0; u.count = 0; u.ref = null; u.waiting = false;
}
// résultat d'une prédiction de la stratégie : '0'…'3' = ✅ au rattrapage k, 'L' = perdue
const resultKey = (w) => (w.status === 'gagné' ? String(w.step) : 'L');
// une prédiction observée vient de se terminer (gagné / perdu / annulé)
function onWatchClosed(w) {
  const u = unitOf(w.chat, w.names);
  if (w.taken) { // prédiction reprise par le bouton : son résultat décide de la suite
    if (w.status === 'annulé') { u.armed = true; u.armedAt = Date.now(); return; } // illisible : ni arrêt ni référence
    const key = resultKey(w);
    if (u.ref === null || u.ref === undefined) {
      if (REF_OK.includes(key)) { u.ref = key; u.armed = true; u.armedAt = Date.now(); } // la première fixe la référence → on prédit la suivante
      else { u.waiting = true; u.armed = false; } // ✅3️⃣, ✅4️⃣ ou ❌ : pas de référence, on attend un ✅0️⃣ / ✅1️⃣ de la stratégie
      return;
    }
    if (key === u.ref) { u.armed = true; u.armedAt = Date.now(); } // même rattrapage que la référence → on prédit la suivante
    else endCycle(u); // rattrapage différent → fin de la série
    return;
  }
  if (u.active) {
    // en attente d'un ✅0️⃣ / ✅1️⃣ : le premier qui arrive (prédiction observée de la stratégie) devient la référence, puis on prédit la suivante
    if (u.waiting && w.status === 'gagné' && RESTART_OK.includes(resultKey(w))) { u.ref = resultKey(w); u.waiting = false; u.armed = true; u.armedAt = Date.now(); }
    return; // pendant une série, les autres résultats ne comptent pas
  }
  if (w.status === 'perdu') {
    u.lossRun += 1; u.lastLossAt = Date.now();
    if (u.lossRun >= panel.lossesNeeded) startCycle(u);
  } else if (w.status === 'gagné') u.lossRun = 0;
}
const averageOf = (runs) => (runs.length ? Math.round((runs.reduce((a, b) => a + b, 0) / runs.length) * 10) / 10 : 0);
// 00h00 / nouveau sabot : séries et compteurs remis à zéro, seule la longueur moyenne des séries est gardée
function keepAverages() {
  const next = {};
  for (const [chat, u] of Object.entries(panel.units || {})) {
    const runs = [...(Array.isArray(u.runs) ? u.runs : []), ...(u.active && u.count > 0 ? [u.count] : [])];
    const avg = runs.length ? averageOf(runs) : (Number(u.avg) || 0);
    next[chat] = { lossRun: 0, active: false, armed: false, armedAt: 0, count: 0, ref: null, waiting: false, cycles: 0, runs: [], avg, names: u.names || '', lastLossAt: null, lastEnd: null };
  }
  return next;
}

// ── boucle (appelée à chaque cycle du bot) ──────────────────────────────────
const TICK_MAX_MS = 90000;
let ticking = false; let tickStartedAt = 0; let tickSeq = 0;
async function tick() {
  if (ticking) {
    if (Date.now() - tickStartedAt < TICK_MAX_MS) return;
    panel.lastError = 'passage bloqué : reprise forcée'; inflight.clear();
  }
  ticking = true; tickStartedAt = Date.now(); const myTick = ++tickSeq;
  try {
    const maxDone = maxFinishedGameNumber();
    const live = liveNumber();
    // nouveau sabot / nouveau jour : la numérotation repart de 1 → on repart de zéro (réglages gardés)
    if (panel.lastMax && live && live < panel.lastMax - 60) {
      panel.watches = []; panel.candidates = []; panel.seen = []; panel.units = keepAverages();
      panel.pendingMessages = panel.pendingMessages.filter((s) => s.status !== 'en attente');
      inflight.clear();
      persist();
    }
    if (live) panel.lastMax = live;
    if (!maxDone) return;
    let changed = false;

    // 1) résultat des prédictions OBSERVÉES des stratégies suivies (rattrapage 3, main du joueur) → gagné / perdu / annulé
    for (const w of panel.watches) {
      if (w.status !== 'en cours' || !w.followable) continue;
      const r = verdictOf(w.target, w.suit, SOURCE_MAXR, maxDone, null);
      if (!r) continue;
      w.status = r.verdict; w.step = r.hitAt >= 0 ? r.hitAt : SOURCE_MAXR; w.closedAt = Date.now(); changed = true;
      onWatchClosed(w);
    }

    // 2) vérification des prédictions déjà envoyées (rattrapages, résultat, édition du message)
    for (const s of panel.pendingMessages) {
      if (s.status !== 'en attente') continue;
      const r = verdictOf(s.target, s.suit, s.maxR, maxDone, (k) => { if ((s.step || 0) < k) { s.step = k; changed = true; editSent(s, null); } });
      if (!r) continue;
      changed = true; s.status = r.verdict; s.resolvedAt = Date.now();
      if (r.verdict === 'gagné') s.step = r.hitAt;
      if (r.verdict === 'annulé') continue;
      try { if (strategyRecap && strategyRecap.noteEntry) strategyRecap.noteEntry(s); } catch (_) { /* bilan seulement */ }
      editSent(s, r.verdict);
      const st = statsOf();
      if (r.verdict === 'gagné') { st.won += 1; st.byStep[s.step] = (st.byStep[s.step] || 0) + 1; } else st.lost += 1;
      const bs = st.bySuit[s.suit] || (st.bySuit[s.suit] = { won: 0, lost: 0 });
      if (r.verdict === 'gagné') bs.won += 1; else bs.lost += 1;
    }
    for (const s of panel.pendingMessages) {
      if (!s.editFail || Date.now() - s.editFail < 8000) continue;
      s.editFail = null;
      if (s.status === 'gagné' || s.status === 'perdu') editSent(s, s.status); else if (s.status === 'en attente') editSent(s, null);
    }

    // 3) séries en cours : on reprend la prochaine prédiction encore à venir (une à la fois)
    for (const [chat, u] of Object.entries(panel.units)) {
      if (!u.active) continue;
      // sécurité : une série sans prédiction reprise en cours ne doit jamais rester bloquée (ex. observation effacée)
      if (!u.armed && !u.waiting && !panel.watches.some((w) => w.chat === chat && w.taken && w.status === 'en cours')) { u.armed = true; u.armedAt = Date.now(); changed = true; }
      if (!u.armed) continue;
      const next = panel.watches.filter((w) => w.chat === chat && w.status === 'en cours' && !w.taken && w.followable && w.target > live && w.at >= (u.armedAt || 0) - 15 * 60 * 1000)
        .sort((a, b) => a.target - b.target)[0];
      if (!next) continue;
      next.taken = true; u.armed = false; u.count = (Number(u.count) || 0) + 1; // s'arrête jusqu'au résultat de cette prédiction
      panel.candidates.push({ id: `msc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, chat, target: next.target, suit: next.suit, src: next.names, position: u.count, status: 'attend la proximité', at: Date.now() });
      if (panel.candidates.length > CAND_MAX) panel.candidates = panel.candidates.slice(-CAND_MAX);
      changed = true;
    }

    // 4) envois : dès que le jeu en direct est à ± proximité AVANT le numéro prédit
    const jobs = [];
    for (const c of panel.candidates) {
      if (c.status !== 'attend la proximité') continue;
      if (c.target <= live) { c.status = 'trop tard'; panel.lateSkipped += 1; changed = true; continue; }
      if (c.target - live > panel.proximity) continue; // jeu en direct encore trop loin : on attend
      jobs.push(launch({ target: c.target, suit: c.suit, src: c.src, chat: c.chat, position: c.position }).then((r) => {
        if (r === 'envoyé') { c.status = 'envoyé'; c.sentAt = Date.now(); changed = true; return; }
        if (r === 'non envoyé' || r === 'aucun canal') { c.tries = (Number(c.tries) || 0) + 1; if (c.tries < 60) return; } // envoi refusé : retenté au passage suivant
        c.status = r; c.sentAt = Date.now(); changed = true;
      }));
    }
    if (jobs.length) await Promise.all(jobs.map((j) => j.catch((e) => { panel.lastError = e.message; })));

    // nettoyage : observations récentes (24 h), candidats clos, envois résolus limités
    const before = panel.watches.length + panel.candidates.length + panel.pendingMessages.length;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    panel.watches = panel.watches.filter((w) => (w.status === 'en cours' ? w.at > cutoff : (w.closedAt || w.at) > Date.now() - 3 * 3600 * 1000)).slice(-WATCH_MAX);
    panel.candidates = panel.candidates.filter((c) => c.status === 'attend la proximité' || (c.sentAt || c.at) > Date.now() - 3 * 3600 * 1000).slice(-CAND_MAX);
    const open = panel.pendingMessages.filter((s) => s.status === 'en attente');
    const done = panel.pendingMessages.filter((s) => s.status !== 'en attente').slice(-SENT_RESOLVED_MAX);
    panel.pendingMessages = [...done, ...open];
    if (changed || panel.watches.length + panel.candidates.length + panel.pendingMessages.length !== before) persist();
  } catch (err) { panel.lastError = err.message; }
  finally { if (tickSeq === myTick) ticking = false; }
}

// ── réglages ────────────────────────────────────────────────────────────────
function config() {
  return { enabled: panel.enabled, mode: panel.mode, selected: { ...panel.selected }, channels: [...panel.channels], maxR: panel.maxR, format: panel.format, proximity: panel.proximity, lossesNeeded: panel.lossesNeeded };
}
function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.mode !== undefined && MODES.includes(String(patch.mode))) panel.mode = String(patch.mode);
  if (patch.channels !== undefined) panel.channels = loss.parseChannels(patch.channels);
  if (patch.maxR !== undefined) panel.maxR = clampInt(patch.maxR, 0, 9, DEFAULT_MAXR);
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.proximity !== undefined) panel.proximity = clampInt(patch.proximity, 1, 20, DEFAULT_PROX);
  if (patch.lossesNeeded !== undefined) panel.lossesNeeded = clampInt(patch.lossesNeeded, 1, 10, DEFAULT_LOSSES);
  if (patch.selected !== undefined) {
    const list = Array.isArray(patch.selected) ? patch.selected : Object.keys(patch.selected || {}).filter((k) => patch.selected[k]);
    panel.selected = Object.fromEntries(list.map((k) => [String(k), true]));
  }
  srcCache = { at: 0, list: [] };
  persist();
  return config();
}
// 00h00 (heure d'Abidjan, voir midnight-reset.js) : tout le suivi du jour repart de zéro, les réglages restent
function wipeDay() {
  panel.units = keepAverages();
  panel.watches = []; panel.candidates = []; panel.seen = []; panel.pendingMessages = []; panel.stats = null;
  panel.sentCount = 0; panel.lastSentAt = null; panel.lateSkipped = 0; panel.duplicatesBlocked = 0; panel.lastMax = 0; panel.lastError = null; panel.lastSkip = null; inflight.clear();
  persist();
}
function resetStats() { panel.stats = emptyStats(); panel.watches = []; panel.candidates = []; panel.units = {}; panel.pendingMessages = panel.pendingMessages.filter((s) => s.status === 'en attente'); persist(); }
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }

// test : exemple de prédiction (jeu fictif) dans le canal d'envoi, marqué 🧪 — ni suivi ni vérifié
async function test() {
  if (!panel.channels.length) return { ok: false, error: 'Renseigne le canal où envoyer les prédictions Miracle série.' };
  const out = renderFor({ format: panel.format, target: 1234, suit: '♦️', maxR: panel.maxR, step: 0 }, null);
  const sent = await sendToChannels({ ...out, text: `🧪 Test\n${out.text}` });
  return sent.length ? { ok: true, sent: sent.map((m) => m.chatId) } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

// ── vue pour le tableau de bord ─────────────────────────────────────────────
function status() {
  const st = statsOf(); const resolved = st.won + st.lost;
  const list = sources();
  const live = liveNumber();
  const scope = list.filter(inScope);
  return {
    ...config(), live, sourceMaxR: SOURCE_MAXR,
    sources: list.map((s) => ({ key: s.key, name: s.name, group: s.group, channels: s.channels || [], maxR: (s.maxR === null || s.maxR === undefined || s.maxR === '' ? null : Number(s.maxR)), followable: isFollowable(s), parity: s.parity === true, selected: !!panel.selected[s.key], inScope: inScope(s) })),
    inScopeCount: scope.length, followableCount: scope.filter(isFollowable).length,
    channelNames: panel.channels.map((id) => panel.channelTitles[String(id)] || String(id)),
    units: Object.entries(panel.units).map(([chat, u]) => ({ chat, names: u.names, lossRun: u.lossRun || 0, active: !!u.active, armed: !!u.armed, count: u.count || 0, ref: (u.ref === null || u.ref === undefined) ? null : String(u.ref), waiting: !!u.waiting, cycles: u.cycles || 0, avg: Number(u.avg) || 0, avgToday: averageOf([...(u.runs || []), ...(u.active && u.count > 0 ? [u.count] : [])]) }))
      .sort((a, b) => (b.active - a.active) || (b.lossRun - a.lossRun)).slice(0, 60),
    activeCount: Object.values(panel.units).filter((u) => u.active).length,
    candidates: panel.candidates.filter((c) => c.status === 'attend la proximité').map((c) => ({ target: c.target, suit: c.suit, src: c.src, gap: c.target - live })),
    following: panel.watches.filter((w) => w.status === 'en cours').length,
    waiting: panel.pendingMessages.filter((s) => s.status === 'en attente').length,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lateSkipped: panel.lateSkipped, duplicatesBlocked: panel.duplicatesBlocked,
    won: st.won, lost: st.lost, rate: pct(st.won, resolved), resolved,
    steps: Object.entries(st.byStep || {}).map(([k, n]) => ({ step: Number(k), n: Number(n) })).sort((a, b) => a.step - b.step),
    recent: panel.pendingMessages.slice(-12).reverse().map((s) => ({ target: s.target, suit: s.suit, status: s.status, step: s.step, src: s.origin && s.origin.src, position: s.position })),
    lastError: panel.lastError, lastSkip: panel.lastSkip, channelTitles: panel.channelTitles,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { config: config(), units: panel.units, watches: panel.watches, candidates: panel.candidates, pendingMessages: panel.pendingMessages, seen: panel.seen, stats: panel.stats,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lateSkipped: panel.lateSkipped, channelTitles: panel.channelTitles, lastMax: panel.lastMax };
  try { store.patch({ miracleSerie: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  const c = saved.config || {};
  panel.enabled = c.enabled === true;
  panel.mode = MODES.includes(c.mode) ? c.mode : 'all';
  panel.channels = loss.parseChannels(c.channels);
  panel.maxR = clampInt(c.maxR, 0, 9, DEFAULT_MAXR);
  panel.format = fmt.clampFormat(c.format || DEFAULT_FORMAT);
  panel.proximity = clampInt(c.proximity, 1, 20, DEFAULT_PROX);
  panel.lossesNeeded = clampInt(c.lossesNeeded, 1, 10, DEFAULT_LOSSES);
  panel.selected = c.selected && typeof c.selected === 'object' ? Object.fromEntries(Object.keys(c.selected).filter((k) => c.selected[k]).map((k) => [k, true])) : {};
  panel.units = saved.units && typeof saved.units === 'object' ? saved.units : {};
  panel.watches = Array.isArray(saved.watches) ? saved.watches.filter((w) => w && w.id).slice(-WATCH_MAX) : [];
  panel.candidates = Array.isArray(saved.candidates) ? saved.candidates.filter((x) => x && x.id).slice(-CAND_MAX) : [];
  panel.pendingMessages = Array.isArray(saved.pendingMessages) ? saved.pendingMessages.filter((s) => s && s.id).slice(-(SENT_RESOLVED_MAX + 100)) : [];
  panel.seen = Array.isArray(saved.seen) ? saved.seen.slice(-SEEN_MAX) : [];
  panel.stats = saved.stats && typeof saved.stats === 'object' ? saved.stats : null;
  panel.sentCount = Number(saved.sentCount) || 0; panel.lastSentAt = saved.lastSentAt || null; panel.lateSkipped = Number(saved.lateSkipped) || 0;
  panel.lastMax = Number(saved.lastMax) || 0;
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
}
function restore() { try { const s = (store.read() || {}).miracleSerie; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting(DB_KEY); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

module.exports = {
  panel, setSender, setSourceProvider, restore, restoreFromDb, persist, onOwnPost, tick, status, test, configure, resetStats, wipeDay, setChannelTitle, readPost,
};
