// slow-mode.js — « Ralentisseur » (demande admin), valable pour TOUTES les stratégies de TOUS les boutons.
//
// Quand un canal est ralenti, une prédiction destinée à un jeu lointain n'est pas envoyée tout de suite : elle est
// retenue jusqu'à ce que le jeu PRÉCÉDENT commence, puis envoyée automatiquement.
//   Exemple : prédiction du jeu 23 alors que le live est au 18 → le bot attend que le jeu 22 commence, puis envoie
//   automatiquement la prédiction du N°23.
//
// Fonctionnement : tous les envois Telegram du bot passent par un point unique (installChannelGuard de bot.js).
// Si le canal est ralenti ET que le message contient un numéro de jeu futur (N°…, №…, #…) dont le jeu précédent n'a
// pas encore commencé, le message est mis en file et la stratégie reçoit tout de suite un identifiant « virtuel »
// (négatif). Elle continue à travailler normalement ; ses éditions ultérieures (✅ / ❌, relance, rattrapage) sont
// redirigées vers le vrai message dès qu'il est parti. La file survit à un redémarrage (data.json).
// Les messages sans numéro de jeu futur, et les canaux non ralentis, ne sont jamais touchés.
'use strict';

const store = require('./store');
const db = require('./db');
const { state, setOnShoeReset } = require('./predictor');

const STORE_KEY = 'slowMode';
const EXPIRE_MS = 25 * 60 * 1000;   // une prédiction retenue depuis trop longtemps est abandonnée
const MAX_QUEUE = 200;
const MAX_MAP = 800;
const MAX_AHEAD = 300;              // au-delà, le nombre n'est pas pris pour un numéro de jeu

const cfg = { all: false, channels: {} }; // channels : clé du canal → true
let queue = [];                            // { vid, chatId, args, target, at }
let vmap = {};                             // vid (négatif) → { chatId, id (vrai message_id) }
let seq = 0;
let released = 0;
let dropped = 0;
let deliver = null;                        // (chatId, args) => Promise<message> : envoi réel (fourni par bot.js)
let timer = null;

const keyOf = (id) => String(id == null ? '' : id).trim().toLowerCase();
const isVirtual = (id) => Number.isInteger(id) && id < 0;

function persist() {
  const m = Object.entries(vmap).slice(-MAX_MAP);
  try {
    store.patch({ [STORE_KEY]: {
      all: cfg.all, channels: cfg.channels, seq, released, dropped,
      queue: queue.slice(-MAX_QUEUE), vmap: Object.fromEntries(m),
    } });
  } catch (_) {}
  if (db.ready) db.setSetting('slow_mode_config', JSON.stringify({ all: cfg.all, channels: cfg.channels })).catch(() => {}); // réglages : la base prime au redémarrage
}
function restore() {
  try {
    const s = (store.read() || {})[STORE_KEY];
    if (!s || typeof s !== 'object') return status();
    cfg.all = !!s.all;
    cfg.channels = s.channels && typeof s.channels === 'object' ? { ...s.channels } : {};
    seq = Number(s.seq) || 0; released = Number(s.released) || 0; dropped = Number(s.dropped) || 0;
    queue = Array.isArray(s.queue) ? s.queue.filter((q) => q && isVirtual(q.vid) && Array.isArray(q.args)) : [];
    vmap = s.vmap && typeof s.vmap === 'object' ? { ...s.vmap } : {};
  } catch (_) {}
  return status();
}

// la base prime sur data.json pour les réglages (canaux ralentis), comme les autres boutons
async function restoreFromDb() {
  if (!db.ready) return status();
  try {
    const raw = await db.getSetting('slow_mode_config');
    if (raw) { const c = JSON.parse(raw); cfg.all = !!c.all; cfg.channels = c.channels && typeof c.channels === 'object' ? { ...c.channels } : {}; }
    else persist();
  } catch (_) { /* on garde data.json */ }
  return status();
}

function configure(patch = {}) {
  if (patch.all !== undefined) cfg.all = !!patch.all;
  if (patch.channels && typeof patch.channels === 'object') {
    for (const [id, on] of Object.entries(patch.channels)) {
      const k = keyOf(id);
      if (!k) continue;
      if (on) cfg.channels[k] = true; else delete cfg.channels[k];
    }
  }
  persist();
  return status();
}
const isSlowed = (chatId) => cfg.all || !!cfg.channels[keyOf(chatId)];

// plus grand numéro de jeu déjà commencé (en cours de distribution, terminé ou en live)
function startedMax() {
  let m = 0;
  for (const g of state.games.values()) {
    if (g.finished || g.dealing || Number(g.playerCards) > 0) m = Math.max(m, Number(g.number) || 0);
  }
  if (state.live && Number.isFinite(Number(state.live.number))) m = Math.max(m, Number(state.live.number));
  return m;
}
// plus petit numéro de jeu FUTUR cité dans le message (jeu dont le précédent n'a pas encore commencé), sinon null
function futureTarget(text, started = startedMax()) {
  if (typeof text !== 'string' || !started) return null;
  let best = null;
  const re = /(?:N°|№|#)\s*(\d{1,6})/g;
  let m;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    if (n - 1 > started && n - started <= MAX_AHEAD && (best === null || n < best)) best = n;
  }
  return best;
}

// appelée par le point d'envoi unique : true = ce message doit être retenu
function shouldHold(chatId, text) {
  if (!isSlowed(chatId)) return false;
  return futureTarget(text) !== null;
}
// retient le message ; renvoie un « message » virtuel (identifiant négatif) à rendre à la stratégie
function hold(chatId, args) {
  const target = futureTarget(args[0]);
  const vid = -(1000000 + (++seq));
  queue.push({ vid, chatId, args: [...args], target, at: Date.now() });
  if (queue.length > MAX_QUEUE) { queue.shift(); dropped += 1; }
  persist();
  return { message_id: vid, chat: { id: chatId }, date: Math.floor(Date.now() / 1000), deferred: true };
}

// édition d'un message : traduit l'identifiant virtuel en vrai message, ou met à jour le texte encore en file
// → { action: 'pass' | 'done' | 'translated', opts }
function resolveEdit(text, opts) {
  const id = opts && opts.message_id;
  if (!isVirtual(id)) return { action: 'pass', opts };
  const real = vmap[id];
  if (real && real.id != null) return { action: 'translated', opts: { ...opts, message_id: real.id } };
  const q = queue.find((x) => x.vid === id);
  if (q) { q.args[0] = text; persist(); }
  return { action: 'done', opts };
}
function resolveDelete(messageId) {
  if (!isVirtual(messageId)) return { action: 'pass', id: messageId };
  const real = vmap[messageId];
  if (real && real.id != null) return { action: 'translated', id: real.id };
  const i = queue.findIndex((x) => x.vid === messageId);
  if (i >= 0) { queue.splice(i, 1); persist(); }
  return { action: 'done', id: messageId };
}

// libère les messages dont le jeu précédent a commencé (appelée chaque seconde)
let running = false;
async function tick(force = false) {
  if (running || !deliver || !queue.length) return 0;
  running = true;
  let sent = 0;
  try {
    const now = Date.now();
    const started = startedMax();
    for (const q of [...queue]) {
      const tooOld = now - q.at > EXPIRE_MS;
      const ready = force || (started >= q.target - 1);
      if (!ready && !tooOld) continue;
      queue = queue.filter((x) => x !== q);
      if (tooOld && !force) { dropped += 1; continue; } // prédiction périmée : abandonnée
      try {
        const m = await deliver(q.chatId, q.args);
        vmap[q.vid] = { chatId: q.chatId, id: m && m.message_id != null ? m.message_id : null };
        released += 1; sent += 1;
      } catch (_) { dropped += 1; }
    }
    if (sent || queue.length !== 0) persist();
  } finally { running = false; }
  return sent;
}
function start(fn) {
  if (typeof fn === 'function') deliver = fn;
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, 1000);
  if (timer.unref) timer.unref();
}
function setDeliver(fn) { deliver = typeof fn === 'function' ? fn : null; }

// nouveau sabot : les numéros repartent, les prédictions retenues n'ont plus de sens
setOnShoeReset(() => { if (queue.length) { dropped += queue.length; queue = []; persist(); } });

function status() {
  const started = startedMax();
  return {
    all: cfg.all,
    channels: Object.keys(cfg.channels),
    started,
    queue: queue.map((q) => ({ chatId: q.chatId, target: q.target, waitingFor: q.target - 1, text: String(q.args[0] || '').slice(0, 200), since: q.at })),
    released, dropped,
  };
}

module.exports = {
  restore, restoreFromDb, configure, isSlowed, shouldHold, hold, resolveEdit, resolveDelete, tick, start, setDeliver, status, futureTarget, startedMax, isVirtual,
};
