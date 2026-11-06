// miracle-prediction.js — bouton « ✨ Miracle prediction » (demande admin, v129).
//
//  Le bot OBSERVE toutes les prédictions envoyées par les stratégies / configurations suivies (même point d'envoi unique que
//  « Costume N-1 → +4 » : bot.js → onOwnPost) et ne prédit lui-même QUE dans deux cas :
//
//  1) APRÈS UNE PERTE — une stratégie suivie qui vient de PERDRE (3 rattrapages épuisés) : sa PROCHAINE prédiction est reprise
//     par Miracle et envoyée dans le canal configuré, puis Miracle s'arrête et attend une NOUVELLE perte de cette stratégie.
//       • seules les stratégies réglées sur 3 rattrapages sont suivies (les autres sont ignorées) ;
//       • avant l'envoi : le jeu en direct doit être proche du numéro à prédire (à ± « proximité » = 2 par défaut, le jeu en direct
//         doit être AVANT le numéro). Ex. : prédiction 12, jeu en direct 10 → envoi ; jeu en direct 8 → on attend ;
//       • le compteur ne monte QUE quand la prédiction reprise par Miracle PERD : attente de (pertes consécutives de Miracle sur la
//         stratégie) + 1 pertes de la stratégie avant de la reprendre (1ʳᵉ perte → 2 pertes d'attente, 2ᵉ → 3…) ; une victoire remet à zéro ;
//       • 2 puis 3 pertes consécutives de Miracle sur une stratégie → message dans le CHAT PRIVÉ de l'admin ;
//       • 00h00 (Abidjan) : tout repart de zéro, seule la MOYENNE des séries de pertes de Miracle est gardée (séries 1, 2, 3 → moyenne 2).
//
//  2) CONSENSUS — au moins 5 stratégies (par défaut) prédisent le MÊME numéro et le MÊME costume : envoi immédiat, SANS
//     condition (ni perte, ni rattrapage 3, ni proximité). Seul garde-fou : le jeu visé n'a pas encore commencé.
//
//  Trois choix de stratégies suivies (« mode ») :
//     select = on coche des stratégies / configurations existantes ;
//     parity = uniquement ce qui utilise le Compte parité (Palier parité, Palier parité égalité) et l'« Analyse fin de numéro »
//              (Prédiction fin de numéro, Trio fin de numéro, stratégies « Fin de numéro » et « Mama ») ;
//     all    = toutes les stratégies, toutes les configurations et tout ce qui prédit sur le site.
//
//  v130 — Miracle n'ATTEND PLUS aucune vérification pour envoyer :
//     • la perte d'une stratégie suivie est constatée dès que la main du JOUEUR du dernier rattrapage est terminée (plus d'attente du banquier) ;
//     • une prédiction Miracle encore en cours n'empêche jamais une autre d'être envoyée (autre stratégie, autre jeu, même jeu avec un autre costume) ;
//       seul le doublon exact (même jeu ET même costume) est ignoré ;
//     • toutes les prédictions prêtes partent en même temps (un envoi Telegram lent ne retarde plus les autres ni les vérifications) ;
//     • un envoi refusé par le canal est retenté à chaque passage tant que le jeu visé n'est pas passé (raison visible sur la page).
//
//  v131 — rattrapages des prédictions Miracle : 3 par défaut (l'ancien défaut 2 enregistré est remplacé une fois par 3) ; le nombre réglé
//         est celui du message envoyé, de la vérification (jeu N puis N+1 … N+rattrapages) et du bilan.
//
//  Réglages : canal(aux) d'envoi, rattrapages des prédictions Miracle, format de message, chat privé (par défaut : admin),
//  proximité, seuil de consensus.
//
//  Unité de suivi = un CANAL source (une stratégie = un canal d'envoi). Si plusieurs stratégies partagent un canal, elles sont
//  suivies ensemble (on ne peut pas savoir laquelle a publié) et ne comptent qu'une seule fois dans le consensus.
'use strict';

const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const loss = require('./loss-return'); // parsePost (lecture d'une publication) et parseChannels
const { state, hasSuit } = require('./predictor');
let strategyRecap = null;
try { strategyRecap = require('./strategy-recap'); } catch (_) { strategyRecap = null; }

const DB_KEY = 'miracle_state';
const SOURCE_MAXR = 3;          // rattrapage exigé des stratégies suivies (règle admin)
const DEFAULT_MAXR = 3;           // rattrapages par défaut des prédictions Miracle (v131 : 3, comme les stratégies suivies)
const MAXR_VERSION = 131;         // les réglages enregistrés avant v131 gardaient l'ancien défaut (2) : remplacé une fois par 3
const DEFAULT_FORMAT = 107;
const DEFAULT_PROX = 2;
const DEFAULT_CONSENSUS = 5;
const MODES = ['select', 'parity', 'all'];
const SEEN_MAX = 2000;
const WATCH_MAX = 800;
const SENT_RESOLVED_MAX = 100;
const CAND_MAX = 100;
const SEND_MAX_MS = 20000;

const panel = {
  enabled: false, mode: 'all', selected: {}, channels: [], privateChat: '', maxR: DEFAULT_MAXR, format: DEFAULT_FORMAT,
  proximity: DEFAULT_PROX, consensus: DEFAULT_CONSENSUS,
  units: {},            // chat → { streak, cooldown, armed, armedAt, names, lastLossAt, notified }
  watches: [],          // prédictions observées { id, chat, target, suit, sig, names, status, step, at }
  candidates: [],       // prédictions reprises après perte, en attente de proximité
  pendingMessages: [],  // prédictions Miracle envoyées
  seen: [], stats: null, sentCount: 0, lastSentAt: null, lateSkipped: 0, duplicatesBlocked: 0, privateNotices: 0,
  channelTitles: {}, lastError: null, lastSkip: null, lastMax: 0,
};

let sender = null; let adminIdFn = null; let sourceProvider = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
function setAdminId(fn) { adminIdFn = typeof fn === 'function' ? fn : null; }
function setSourceProvider(fn) { sourceProvider = typeof fn === 'function' ? fn : null; }
const bot = () => (typeof sender === 'function' ? sender() : null);

const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const norm = (c) => String(c == null ? '' : c).trim().toLowerCase();
const isDone = (g) => !!g && g.finished && g.complete !== false;
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
const emptyStats = () => ({ sent: 0, won: 0, lost: 0, byStep: {}, bySuit: {}, byKind: { loss: { won: 0, lost: 0 }, consensus: { won: 0, lost: 0 } } });
const statsOf = () => {
  panel.stats = panel.stats && typeof panel.stats === 'object' ? { ...emptyStats(), ...panel.stats } : emptyStats();
  if (!panel.stats.byKind) panel.stats.byKind = emptyStats().byKind;
  return panel.stats;
};
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
// sources dans le périmètre qui publient dans ce canal
function scopedSourcesOf(chat) { return sources().filter((s) => inScope(s) && (s.channels || []).some((c) => norm(c) === chat)); }

// ── observation ─────────────────────────────────────────────────────────────
function readPost(text) {
  if (typeof text !== 'string') return null;
  return loss.parsePost(text.replace(/(#|№)\s*N(?=\s*\d)/gi, '$1'));
}
function unitOf(chat, names) {
  const u = panel.units[chat] || (panel.units[chat] = { streak: 0, cooldown: 0, armed: false, armedAt: 0, names: '', lastLossAt: null, notified: 0, runs: [], avg: 0, mStreak: 0 });
  if (!Array.isArray(u.runs)) u.runs = [];
  if (!Number.isFinite(u.mStreak)) u.mStreak = 0;
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
      panel.watches.push({ id: `mw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, chat, target: post.target, suit, sig, names, followable, status: 'en cours', step: 0, at: Date.now() });
      changed = true;
    }
    if (changed) { unitOf(chat, names); if (panel.watches.length > WATCH_MAX) panel.watches = panel.watches.slice(-WATCH_MAX); persist(); }
    return changed;
  } catch (e) { panel.lastError = e.message; return false; }
}

// ── envoi / édition ─────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, { gameNumber: entry.target, suit: entry.suit, strategy: 'Miracle prediction', maxR: entry.maxR, status: statusFr, rattrapage: entry.step || 0 }, null);
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
// message dans le chat PRIVÉ (jamais bloqué par le garde de canaux)
async function toPrivate(text) {
  try {
    const b = bot();
    const target = String(panel.privateChat || '').trim() || (adminIdFn ? adminIdFn() : null);
    if (!b || !target) { panel.lastError = !target ? 'Chat privé inconnu (ADMIN_ID non renseigné)' : 'Aucun token Telegram configuré'; return false; }
    const send = b.sendMessageUnguarded || b.sendMessage.bind(b);
    await withTimeout(send(target, text), SEND_MAX_MS, 'message privé');
    return true;
  } catch (e) { panel.lastError = e.message; return false; }
}

const inflight = new Set();
// un numéro de jeu revient chaque jour (le sabot repart à #1) : un doublon n'existe que pour le même jeu ET le même costume, en cours ou envoyé il y a moins de 2 h
const DUP_WINDOW_MS = 2 * 3600 * 1000;
const alreadySent = (target, suit) => inflight.has(`${target}:${suit}`)
  || panel.pendingMessages.some((s) => s.target === target && s.suit === suit && (s.status === 'en attente' || Date.now() - (Number(s.createdAt) || 0) < DUP_WINDOW_MS));
// envoie UNE prédiction Miracle (après perte ou consensus)
async function launch({ target, suit, kind, src, count, chat, streakAtSend }) {
  if (!panel.channels.length) { panel.lastError = 'Renseigne le canal où envoyer les prédictions Miracle.'; return 'aucun canal'; }
  if (target <= liveNumber()) { panel.lateSkipped += 1; return 'trop tard'; }
  if (alreadySent(target, suit)) { panel.duplicatesBlocked += 1; return 'doublon'; }
  const inflightKey = `${target}:${suit}`;
  inflight.add(inflightKey);
  try {
    const entry = { id: `mp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: 'miracle', kind, chat: chat || null, streakAtSend: streakAtSend || 0, suit, target, maxR: panel.maxR, format: panel.format, step: 0, status: 'en attente',
      messages: [], origin: { src: String(src || '').slice(0, 140), count: count || 1 }, createdAt: Date.now(), resolvedAt: null };
    entry.messages = await sendToChannels(renderFor(entry, null));
    if (!entry.messages.length) return 'non envoyé';
    panel.pendingMessages.push(entry);
    const st = statsOf(); st.sent += 1; panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null;
    return 'envoyé';
  } finally { inflight.delete(inflightKey); }
}

// ── perte d'une stratégie suivie ────────────────────────────────────────────
// Règle d'attente (demande admin) : le compteur ne bouge QUE si la prédiction envoyée par Miracle pour cette stratégie PERD.
// Compteur = pertes consécutives de Miracle sur la stratégie ; après chaque perte de Miracle, on attend (compteur + 1) nouvelles pertes
// de la stratégie avant de la reprendre (1ʳᵉ perte de Miracle → 2 pertes d'attente, 2ᵉ → 3, …). Une victoire de Miracle remet le compteur à zéro.
// La perte de la prédiction reprise par Miracle ne compte pas dans l'attente.
const noticeQueue = [];
function onUnitLoss(chat, w) {
  const u = unitOf(chat, w.names);
  u.streak += 1; u.lastLossAt = Date.now();
  if (w.taken) return; // prédiction reprise par Miracle : son résultat règle le compteur (voir onMiracleLoss / onMiracleWin)
  if (u.cooldown > 0) { u.cooldown -= 1; if (u.cooldown > 0) { u.armed = false; return; } }
  u.armed = true; u.armedAt = Date.now(); // prochaine prédiction de la stratégie → Miracle
}
function onUnitWin(chat, w) {
  const u = unitOf(chat, w.names);
  u.streak = 0; u.armed = false; /* l'attente restante est conservée */
}
// la prédiction Miracle d'une stratégie a PERDU → compteur + 1, attente = compteur + 1 pertes de la stratégie
function onMiracleLoss(s) {
  if (s.kind !== 'loss' || !s.chat) return;
  const u = unitOf(s.chat, s.origin && s.origin.src);
  u.mStreak += 1; u.cooldown = u.mStreak + 1; u.armed = false;
  if (u.mStreak === 2 || u.mStreak === 3) noticeQueue.push({ chat: s.chat, streak: u.mStreak }); // message privé (envoyé en fin de cycle)
}
// la prédiction Miracle d'une stratégie a GAGNÉ → la série de pertes de Miracle se termine (gardée pour la moyenne du jour)
function onMiracleWin(s) {
  if (s.kind !== 'loss' || !s.chat) return;
  const u = unitOf(s.chat, s.origin && s.origin.src);
  if (u.mStreak > 0) { u.runs.push(u.mStreak); if (u.runs.length > 500) u.runs = u.runs.slice(-500); }
  u.mStreak = 0;
}
async function flushNotices() {
  while (noticeQueue.length) {
    const n = noticeQueue.shift();
    const u = panel.units[n.chat]; if (!u) continue;
    u.notified = n.streak; panel.privateNotices += 1;
    const wait = u.cooldown > 0 ? `Miracle attend encore ${u.cooldown} perte(s) de cette stratégie avant de reprendre sa prédiction.` : 'Miracle reprendra sa prédiction suivante après la prochaine perte.';
    await toPrivate(`⚠️ Miracle prediction — « ${u.names || n.chat} » a vu ses prédictions Miracle perdre ${n.streak} fois de suite.\n${wait}`);
  }
}
// moyenne des séries de pertes consécutives (arrondie) : gardée après la remise à zéro de 00h00
const averageOf = (runs) => (runs.length ? Math.round(runs.reduce((a, b) => a + b, 0) / runs.length) : 0);
function keepAverages() {
  const next = {};
  for (const [chat, u] of Object.entries(panel.units || {})) {
    const runs = [...(Array.isArray(u.runs) ? u.runs : []), ...(u.mStreak > 0 ? [u.mStreak] : [])];
    const avg = runs.length ? averageOf(runs) : (Number(u.avg) || 0);
    next[chat] = { streak: 0, cooldown: 0, armed: false, armedAt: 0, names: u.names || '', lastLossAt: null, notified: 0, runs: [], avg, mStreak: 0 };
  }
  return next;
}

// ── boucle (appelée à chaque cycle du bot) ──────────────────────────────────
const TICK_MAX_MS = 90000;
let ticking = false; let tickStartedAt = 0; let tickSeq = 0;
async function tick() {
  if (ticking) {
    if (Date.now() - tickStartedAt < TICK_MAX_MS) return;
    panel.lastError = 'passage bloqué : reprise forcée'; inflight.clear(); // un passage resté bloqué est abandonné au bout de 90 s
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

    // 1) résultat des prédictions OBSERVÉES des stratégies suivies (rattrapage 3, main du joueur, sans attendre le banquier) → gagné / perdu
    for (const w of panel.watches) {
      if (w.status !== 'en cours' || !w.followable) continue;
      const r = verdictOf(w.target, w.suit, SOURCE_MAXR, maxDone, null);
      if (!r) continue;
      w.status = r.verdict; w.step = r.hitAt >= 0 ? r.hitAt : SOURCE_MAXR; w.closedAt = Date.now(); changed = true;
      if (r.verdict === 'perdu') onUnitLoss(w.chat, w);
      else if (r.verdict === 'gagné') onUnitWin(w.chat, w);
    }

    // 2) vérification des prédictions Miracle déjà envoyées (rattrapages, résultat, édition du message) — AVANT tout nouvel envoi,
    //    mais une prédiction encore en cours n'empêche JAMAIS d'en envoyer une autre
    for (const s of panel.pendingMessages) {
      if (s.status !== 'en attente') continue;
      const r = verdictOf(s.target, s.suit, s.maxR, maxDone, (k) => { if ((s.step || 0) < k) { s.step = k; changed = true; editSent(s, null); } });
      if (!r) continue;
      changed = true; s.status = r.verdict; s.resolvedAt = Date.now();
      if (r.verdict === 'gagné') s.step = r.hitAt;
      if (r.verdict === 'annulé') continue;
      try { if (strategyRecap && strategyRecap.noteEntry) strategyRecap.noteEntry(s); } catch (_) { /* bilan seulement */ }
      if (r.verdict === 'perdu') onMiracleLoss(s); else if (r.verdict === 'gagné') onMiracleWin(s);
      editSent(s, r.verdict);
      const st = statsOf(); const bk = st.byKind[s.kind === 'consensus' ? 'consensus' : 'loss'];
      if (r.verdict === 'gagné') { st.won += 1; bk.won += 1; st.byStep[s.step] = (st.byStep[s.step] || 0) + 1; } else { st.lost += 1; bk.lost += 1; }
      const bs = st.bySuit[s.suit] || (st.bySuit[s.suit] = { won: 0, lost: 0 });
      if (r.verdict === 'gagné') bs.won += 1; else bs.lost += 1;
    }
    for (const s of panel.pendingMessages) {
      if (!s.editFail || Date.now() - s.editFail < 8000) continue;
      s.editFail = null;
      if (s.status === 'gagné' || s.status === 'perdu') editSent(s, s.status); else if (s.status === 'en attente') editSent(s, null);
    }

    // 3) stratégies « armées » (perte) : on reprend leur prochaine prédiction encore à venir
    for (const [chat, u] of Object.entries(panel.units)) {
      if (!u.armed) continue;
      const next = panel.watches.filter((w) => w.chat === chat && w.status === 'en cours' && !w.taken && w.target > live && w.at >= (u.armedAt || 0) - 15 * 60 * 1000)
        .sort((a, b) => a.target - b.target)[0];
      if (!next) continue;
      next.taken = true; u.armed = false; // s'arrête jusqu'à la prochaine perte
      panel.candidates.push({ id: `mc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, chat, target: next.target, suit: next.suit, src: next.names, status: 'attend la proximité', streak: u.streak, at: Date.now() });
      if (panel.candidates.length > CAND_MAX) panel.candidates = panel.candidates.slice(-CAND_MAX);
      changed = true;
    }

    // 4) envois : TOUS les envois prêts partent ensemble (un envoi Telegram lent ne retarde ni les autres ni les vérifications)
    const jobs = [];
    //    a) après perte : dès que le jeu en direct est à ± proximité AVANT le numéro prédit
    for (const c of panel.candidates) {
      if (c.status !== 'attend la proximité') continue;
      if (c.target <= live) { c.status = 'trop tard'; panel.lateSkipped += 1; changed = true; continue; }
      if (c.target - live > panel.proximity) continue; // jeu en direct encore trop loin : on attend
      jobs.push(launch({ target: c.target, suit: c.suit, kind: 'loss', src: c.src, chat: c.chat, streakAtSend: c.streak }).then((r) => {
        if (r === 'envoyé') { c.status = 'envoyé'; c.sentAt = Date.now(); changed = true; return; }
        if (r === 'non envoyé' || r === 'aucun canal') { c.tries = (Number(c.tries) || 0) + 1; if (c.tries < 60) return; } // envoi refusé : retenté au passage suivant
        c.status = r; c.sentAt = Date.now(); changed = true;
      }));
    }
    //    b) consensus : ≥ N stratégies (signatures distinctes) sur le même numéro + même costume → envoi sans condition
    const votes = new Map();
    for (const w of panel.watches) {
      if (w.target <= live || w.status === 'annulé') continue;
      const k = `${w.target}:${w.suit}`;
      const v = votes.get(k) || { target: w.target, suit: w.suit, sigs: new Set(), names: [] };
      if (!v.sigs.has(w.sig)) { v.sigs.add(w.sig); v.names.push(w.names); }
      votes.set(k, v);
    }
    for (const v of votes.values()) {
      if (v.sigs.size < panel.consensus) continue;
      if (alreadySent(v.target, v.suit)) continue;
      jobs.push(launch({ target: v.target, suit: v.suit, kind: 'consensus', src: `Consensus ${v.sigs.size} stratégies`, count: v.sigs.size }).then((r) => { if (r === 'envoyé') changed = true; }));
    }
    if (jobs.length) await Promise.all(jobs.map((j) => j.catch((e) => { panel.lastError = e.message; })));

    await flushNotices();

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
  return { enabled: panel.enabled, mode: panel.mode, selected: { ...panel.selected }, channels: [...panel.channels], privateChat: panel.privateChat, maxR: panel.maxR, maxRv: MAXR_VERSION, format: panel.format, proximity: panel.proximity, consensus: panel.consensus };
}
function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.mode !== undefined && MODES.includes(String(patch.mode))) panel.mode = String(patch.mode);
  if (patch.channels !== undefined) panel.channels = loss.parseChannels(patch.channels);
  if (patch.privateChat !== undefined) panel.privateChat = String(patch.privateChat || '').trim().slice(0, 40);
  if (patch.maxR !== undefined) { panel.maxR = clampInt(patch.maxR, 0, 9, DEFAULT_MAXR); }
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.proximity !== undefined) panel.proximity = clampInt(patch.proximity, 1, 20, DEFAULT_PROX);
  if (patch.consensus !== undefined) panel.consensus = clampInt(patch.consensus, 2, 30, DEFAULT_CONSENSUS);
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
  panel.units = keepAverages(); // 00h00 : séries, attentes et prédictions remises à zéro ; seule la MOYENNE des séries de pertes est gardée
  panel.watches = []; panel.candidates = []; panel.seen = []; panel.pendingMessages = []; panel.stats = null;
  panel.sentCount = 0; panel.lastSentAt = null; panel.lateSkipped = 0; panel.duplicatesBlocked = 0; panel.privateNotices = 0; panel.lastMax = 0; panel.lastError = null; panel.lastSkip = null; inflight.clear();
  persist();
}
function resetStats() { panel.stats = emptyStats(); panel.watches = []; panel.candidates = []; panel.units = {}; panel.pendingMessages = panel.pendingMessages.filter((s) => s.status === 'en attente'); persist(); }
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }

// test : exemple de prédiction (jeu fictif) dans le canal d'envoi, marqué 🧪 — ni suivi ni vérifié
async function test() {
  if (!panel.channels.length) return { ok: false, error: 'Renseigne le canal où envoyer les prédictions Miracle.' };
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
    units: Object.entries(panel.units).map(([chat, u]) => ({ chat, names: u.names, streak: u.streak, mStreak: u.mStreak || 0, cooldown: u.cooldown, armed: !!u.armed, notified: u.notified || 0, avg: Number(u.avg) || 0, avgToday: averageOf([...(u.runs || []), ...(u.mStreak > 0 ? [u.mStreak] : [])]) })).sort((a, b) => b.streak - a.streak).slice(0, 60),
    candidates: panel.candidates.filter((c) => c.status === 'attend la proximité').map((c) => ({ target: c.target, suit: c.suit, src: c.src, gap: c.target - live })),
    following: panel.watches.filter((w) => w.status === 'en cours').length,
    waiting: panel.pendingMessages.filter((s) => s.status === 'en attente').length,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lateSkipped: panel.lateSkipped, duplicatesBlocked: panel.duplicatesBlocked, privateNotices: panel.privateNotices,
    won: st.won, lost: st.lost, rate: pct(st.won, resolved), resolved, byKind: st.byKind,
    steps: Object.entries(st.byStep || {}).map(([k, n]) => ({ step: Number(k), n: Number(n) })).sort((a, b) => a.step - b.step),
    recent: panel.pendingMessages.slice(-12).reverse().map((s) => ({ target: s.target, suit: s.suit, status: s.status, step: s.step, kind: s.kind, src: s.origin && s.origin.src, count: s.origin && s.origin.count })),
    lastError: panel.lastError, lastSkip: panel.lastSkip, channelTitles: panel.channelTitles,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { config: config(), units: panel.units, watches: panel.watches, candidates: panel.candidates, pendingMessages: panel.pendingMessages, seen: panel.seen, stats: panel.stats,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lateSkipped: panel.lateSkipped, privateNotices: panel.privateNotices, channelTitles: panel.channelTitles, lastMax: panel.lastMax };
  try { store.patch({ miracle: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  const c = saved.config || {};
  panel.enabled = c.enabled === true;
  panel.mode = MODES.includes(c.mode) ? c.mode : 'all';
  panel.channels = loss.parseChannels(c.channels);
  panel.privateChat = String(c.privateChat || '').trim().slice(0, 40);
  panel.maxR = clampInt(c.maxR, 0, 9, DEFAULT_MAXR);
  if (c.maxRv !== MAXR_VERSION && panel.maxR === 2) panel.maxR = DEFAULT_MAXR; // ancien défaut (2) jamais choisi → 3 ; un autre choix est gardé
  panel.format = fmt.clampFormat(c.format || DEFAULT_FORMAT);
  panel.proximity = clampInt(c.proximity, 1, 20, DEFAULT_PROX);
  panel.consensus = clampInt(c.consensus, 2, 30, DEFAULT_CONSENSUS);
  panel.selected = c.selected && typeof c.selected === 'object' ? Object.fromEntries(Object.keys(c.selected).filter((k) => c.selected[k]).map((k) => [k, true])) : {};
  panel.units = saved.units && typeof saved.units === 'object' ? saved.units : {};
  panel.watches = Array.isArray(saved.watches) ? saved.watches.filter((w) => w && w.id).slice(-WATCH_MAX) : [];
  panel.candidates = Array.isArray(saved.candidates) ? saved.candidates.filter((x) => x && x.id).slice(-CAND_MAX) : [];
  panel.pendingMessages = Array.isArray(saved.pendingMessages) ? saved.pendingMessages.filter((s) => s && s.id).slice(-(SENT_RESOLVED_MAX + 100)) : [];
  panel.seen = Array.isArray(saved.seen) ? saved.seen.slice(-SEEN_MAX) : [];
  panel.stats = saved.stats && typeof saved.stats === 'object' ? saved.stats : null;
  panel.sentCount = Number(saved.sentCount) || 0; panel.lastSentAt = saved.lastSentAt || null; panel.lateSkipped = Number(saved.lateSkipped) || 0;
  panel.privateNotices = Number(saved.privateNotices) || 0; panel.lastMax = Number(saved.lastMax) || 0;
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
}
function restore() { try { const s = (store.read() || {}).miracle; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting(DB_KEY); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

module.exports = {
  panel, setSender, setAdminId, setSourceProvider, restore, restoreFromDb, persist, onOwnPost, tick, status, test, configure, resetStats, wipeDay, setChannelTitle, readPost,
};
