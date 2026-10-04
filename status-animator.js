// status-animator.js — animation du statut « En cours » des prédictions Telegram.
//
// Principe (valable pour TOUS les formats, 1 à 101) :
//   • formats.renderMessage() signale chaque message de prédiction « en cours »
//     (registerPending) ; bot.js/installChannelGuard() le repère à l'envoi
//     (maybeTrack) et l'ajoute à la file d'animation ;
//   • toutes les quelques secondes, le message est ÉDITÉ avec une nouvelle image :
//       – le sablier alterne ⏳ / ⌛ (effet de retournement),
//       – le texte « En cours » s'écrit lettre par lettre (E, En, En , En c…),
//         suivi d'un curseur en COULEUR qui change à chaque image (🔴🟠🟡🟢🔵🟣) ;
//         Telegram ne permet pas de colorer du texte : la couleur passe par ces pastilles ;
//       – un format sans marqueur d'attente reçoit une ligne « ⏳ En cours » animée ;
//   • dès que le résultat est publié (editMessageText avec le texte final), l'animation
//     s'arrête et le texte final (ex. « ✅ 1️⃣ ») remplace tout — sans image parasite.
//
// Limites Telegram respectées : au plus 1 édition d'animation par canal toutes les
// STATUS_ANIM_FRAME_MS (3,5 s par défaut ≈ 17/min, sous la limite de ~20/min par
// canal) ; sur erreur 429 on met le canal en pause le temps demandé.
//
// Variables d'environnement :
//   STATUS_ANIM=off              désactive l'animation
//   STATUS_ANIM_FRAME_MS=3500    écart minimal entre deux images d'un même canal
//   STATUS_ANIM_MAX_MS=1800000   durée maxi d'une animation (30 min) puis texte figé
'use strict';

const COLORS = ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣'];
const HOURGLASS = ['⏳', '⌛'];
const HG_TEST = /[\u23F3\u231B]\uFE0F?/;
const HG_ALL = /[\u23F3\u231B]\uFE0F?/g;
const PHRASE_RE = /En cours de vérification|En cours|En attente du résultat|En attente|Vérification en cours|Analyse/i;
const FALLBACK_PHRASE = 'En cours';
const HOLD_FRAMES = 4;          // images pendant lesquelles le mot complet reste affiché
const FIRST_DELAY_MS = 2000;    // délai avant la première image
const PENDING_TTL_MS = 120000;
const MAX_ITEMS = 60;

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }
function enabled() { return !/^(off|0|false)$/i.test(String(process.env.STATUS_ANIM || '')); }
const frameMs = () => num(process.env.STATUS_ANIM_FRAME_MS, 3500);
const maxMs = () => num(process.env.STATUS_ANIM_MAX_MS, 30 * 60 * 1000);

// ── Repérage des textes « en cours » produits par le moteur de formats ──────────
const pending = new Map(); // texte -> expiration

function registerPending(text) {
  if (typeof text !== 'string' || text.length < 5) return;
  const now = Date.now();
  pending.set(text, now + PENDING_TTL_MS);
  if (pending.size > 400) for (const [t, exp] of pending) if (exp < now) pending.delete(t);
}

function matchPending(text) {
  if (typeof text !== 'string' || !text) return false;
  const now = Date.now();
  for (const [t, exp] of pending) {
    if (exp < now) { pending.delete(t); continue; }
    if (text === t) return true;
    // le module émetteur peut avoir ajouté une courte introduction / conclusion
    if (text.length <= t.length + 600 && text.includes(t)) return true;
  }
  return false;
}

// ── Fabrication d'une image d'animation ─────────────────────────────────────────
function buildFrame(base, f) {
  const color = COLORS[f % COLORS.length];
  const hg = HOURGLASS[f % 2];
  const m = PHRASE_RE.exec(base);
  if (m) {
    const word = m[0];
    const cycle = word.length + 1 + HOLD_FRAMES;
    const typed = word.slice(0, Math.min(f % cycle, word.length));
    const out = base.slice(0, m.index) + typed + color + base.slice(m.index + word.length);
    return out.replace(HG_ALL, hg);
  }
  if (HG_TEST.test(base)) {
    let first = true;
    return base.replace(HG_ALL, () => { if (first) { first = false; return hg + color; } return hg; });
  }
  const cycle = FALLBACK_PHRASE.length + 1 + HOLD_FRAMES;
  const typed = FALLBACK_PHRASE.slice(0, Math.min(f % cycle, FALLBACK_PHRASE.length));
  return `${base}\n${hg} ${typed}${color}`;
}

// ── File d'animation ───────────────────────────────────────────────────────────
const items = new Map();     // clé -> élément
const chatNext = new Map();  // chatId -> prochain instant autorisé
let timer = null;

const keyOf = (chatId, messageId) => `${chatId}:${messageId}`;
function keyFromOpts(opts) {
  if (!opts || opts.chat_id === undefined || opts.message_id === undefined || opts.message_id === null) return null;
  return keyOf(opts.chat_id, opts.message_id);
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(tick, 1000);
  if (timer.unref) timer.unref();
}

function maybeStopTimer() {
  if (!items.size && timer) { clearInterval(timer); timer = null; }
}

function maybeTrack(edit, chatId, sent, text, opts) {
  if (!enabled() || !sent || sent.skipped || sent.message_id === null || sent.message_id === undefined) return false;
  if (!matchPending(text)) return false;
  if (items.size >= MAX_ITEMS) return false;
  const key = keyOf(chatId, sent.message_id);
  const now = Date.now();
  items.set(key, {
    key, chatId, messageId: sent.message_id, edit,
    base: text, parse_mode: opts && opts.parse_mode ? opts.parse_mode : null,
    frame: 0, startedAt: now, lastAt: now, inflight: null, errors: 0,
  });
  chatNext.set(chatId, Math.max(chatNext.get(chatId) || 0, now + FIRST_DELAY_MS));
  ensureTimer();
  return true;
}

const has = (key) => items.has(key);

async function settle(it) { if (it && it.inflight) { try { await it.inflight; } catch (_) { /* ignoré */ } } }

// Arrête l'animation et attend la fin d'une image en cours d'envoi, pour que
// l'édition finale passe TOUJOURS en dernier.
async function stop(key) {
  const it = items.get(key);
  if (!it) return;
  items.delete(key);
  await settle(it);
  maybeStopTimer();
}

// Le module émetteur a réédité le message avec un autre texte « en cours »
// (ex. changement du nombre de rattrapages) : l'animation continue sur ce texte.
async function rebase(key, text) {
  const it = items.get(key);
  if (!it) return;
  it.base = text;
  await settle(it);
}

function retryAfterMs(err) {
  const b = err && err.response && err.response.body;
  let s = b && b.parameters && b.parameters.retry_after;
  if (!s) { const m = /retry after (\d+)/i.exec(String(err && err.message)); if (m) s = Number(m[1]); }
  return (Number(s) || 10) * 1000 + 1000;
}

function handleError(it, err) {
  const msg = String((err && err.message) || err);
  if (/message is not modified/i.test(msg)) return;
  if (/429|too many requests/i.test(msg)) { chatNext.set(it.chatId, Date.now() + retryAfterMs(err)); return; }
  if (/400|403|message to edit not found|can't be edited|chat not found|bot was kicked|blocked/i.test(msg)) { items.delete(it.key); return; }
  it.errors += 1;
  if (it.errors >= 5) items.delete(it.key);
}

function step(it) {
  const now = Date.now();
  chatNext.set(it.chatId, now + frameMs());
  it.lastAt = now;
  const opts = { chat_id: it.chatId, message_id: it.messageId, ...(it.parse_mode ? { parse_mode: it.parse_mode } : {}) };
  if (now - it.startedAt > maxMs()) {
    // durée maximale atteinte : on fige le message sur son texte d'origine
    items.delete(it.key);
    it.inflight = Promise.resolve(it.edit(it.base, opts)).catch(() => {}).then(() => { it.inflight = null; });
    return;
  }
  it.frame += 1;
  it.inflight = Promise.resolve()
    .then(() => it.edit(buildFrame(it.base, it.frame), opts))
    .then(() => { it.errors = 0; }, (e) => handleError(it, e))
    .then(() => { it.inflight = null; });
}

function tick() {
  const now = Date.now();
  const pick = new Map(); // un seul élément par canal : le moins récemment animé
  for (const it of items.values()) {
    if (it.inflight) continue;
    const cur = pick.get(it.chatId);
    if (!cur || it.lastAt < cur.lastAt) pick.set(it.chatId, it);
  }
  for (const [chatId, it] of pick) {
    if (now < (chatNext.get(chatId) || 0)) continue;
    step(it);
  }
  maybeStopTimer();
}

function status() { return { enabled: enabled(), active: items.size, frameMs: frameMs() }; }

module.exports = { registerPending, matchPending, maybeTrack, keyFromOpts, has, stop, rebase, buildFrame, status };
