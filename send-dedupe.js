// send-dedupe.js — ANTI-DOUBLON des messages et des prédictions envoyés dans les canaux Telegram.
//
// Branché dans le point d'envoi unique de bot.js (installChannelGuard) : TOUT message envoyé
// par le bot (toute stratégie, tout bouton) passe ici avant de partir.
//
//  1. MESSAGE : le même texte exact vers le même canal dans la fenêtre `windowMin` (10 min par
//     défaut) n'est envoyé qu'une fois.
//  2. PRÉDICTION : un même jeu (N°) + même costume dans un même canal n'est publié qu'une
//     fois, quelle que soit la stratégie qui l'envoie (`predictionTtlMin`, 90 min par défaut).
//     Les messages de résultat (✅ / ❌) ne sont jamais traités comme des prédictions.
//
// Les clés sont réservées de façon ATOMIQUE dans Supabase (table `sent_dedupe`) : même deux
// instances du site ou un redémarrage ne peuvent pas envoyer deux fois. Sans base, la mémoire
// du processus sert de repli. Si l'envoi Telegram échoue, la réservation est libérée.
//
// Les numéros de jeu repartent de 1 à chaque nouveau sabot / à minuit : le registre des
// prédictions est alors vidé (voir setOnShoeReset plus bas).
// Réglages : data.json → sendDedupe { enabled, messages, predictions, windowMin, predictionTtlMin }.
'use strict';

const crypto = require('crypto');
const store = require('./store');
const db = require('./db');

const DEFAULTS = { enabled: true, messages: true, predictions: true, windowMin: 10, predictionTtlMin: 90 };
const mem = new Map(); // clé → { at, kind, ttl (ms) }
const stats = { blockedMessages: 0, blockedPredictions: 0, last: null };

function cfg() {
  let saved = {};
  try { saved = (store.read() || {}).sendDedupe || {}; } catch (_) { /* défauts */ }
  const c = { ...DEFAULTS, ...saved };
  c.windowMin = Math.max(1, Math.min(1440, Number(c.windowMin) || DEFAULTS.windowMin));
  c.predictionTtlMin = Math.max(5, Math.min(1440, Number(c.predictionTtlMin) || DEFAULTS.predictionTtlMin));
  return c;
}

// seuls les canaux / groupes sont surveillés (ID négatif ou @nom), jamais le chat privé de l'admin
const isChannel = (chatId) => { const s = String(chatId == null ? '' : chatId).trim(); return s.startsWith('-') || s.startsWith('@'); };
const chanOf = (chatId) => String(chatId).trim().toLowerCase();
const hash = (t) => crypto.createHash('sha1').update(t).digest('hex');

function predictionKeys(chan, text, ttl) {
  if (/[✅❌]/.test(text)) return []; // résultat, pas une prédiction
  if (/RÉSUMÉ STATISTIQUE/.test(text)) return []; // message du « Compte parité » (lignes #840 ➔ …) : jamais une prédiction
  let post = null;
  // « en cours » serait lu comme le costume cœur par le lecteur de publications : on l'écarte avant lecture
  try { post = require('./loss-return').parsePost(text.replace(/\bcours\b/gi, ' ')); } catch (_) { post = null; }
  if (!post || !post.target || !Array.isArray(post.suits) || !post.suits.length) return [];
  const suits = [...post.suits].sort().join('');
  return [{ key: `p|${chan}|${post.target}|${suits}`, kind: 'p', ttl }];
}

function buildKeys(chatId, text, c) {
  const chan = chanOf(chatId);
  const out = [];
  if (c.predictions) out.push(...predictionKeys(chan, text, c.predictionTtlMin * 60000));
  if (c.messages) out.push({ key: `m|${chan}|${hash(text.replace(/\s+/g, ' ').trim())}`, kind: 'm', ttl: c.windowMin * 60000 });
  return out;
}

function purge(now) {
  if (mem.size < 600) return;
  for (const [k, v] of mem) if (now - v.at > v.ttl) mem.delete(k);
}

async function dbReserve(k, chan) {
  // insère la clé, ou la rafraîchit si l'ancienne est expirée ; aucune ligne renvoyée = doublon
  const r = await db.exec(
    `INSERT INTO sent_dedupe (key, kind, channel) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET created_at = now()
       WHERE sent_dedupe.created_at < now() - ($4 || ' milliseconds')::interval
     RETURNING key`,
    [k.key, k.kind, chan, String(k.ttl)]
  );
  return !!(r && r.rowCount);
}

function dbDelete(keys) {
  if (!db.ready || !keys.length) return;
  db.exec(`DELETE FROM sent_dedupe WHERE key = ANY($1::text[])`, [keys]).catch(() => {});
}

// Réserve les clés du message. { ok: true, keys } → envoyer ; { ok: false, reason } → doublon à ignorer.
async function claim(chatId, text) {
  const c = cfg();
  if (!c.enabled || typeof text !== 'string' || !text || !isChannel(chatId)) return { ok: true, keys: [] };
  const now = Date.now();
  purge(now);
  const keys = buildKeys(chatId, text, c);
  if (!keys.length) return { ok: true, keys: [] };
  const chan = chanOf(chatId);
  const taken = [];
  const rollback = () => { for (const k of taken) mem.delete(k); dbDelete(taken); };

  for (const k of keys) {
    const m = mem.get(k.key);
    if (m && now - m.at < m.ttl) { rollback(); return noteBlocked(k.kind, chan, text); }
    let fresh = true;
    if (db.ready) {
      try { fresh = await dbReserve(k, chan); } catch (_) { fresh = true; } // base muette : la mémoire protège
    }
    if (!fresh) { rollback(); return noteBlocked(k.kind, chan, text); }
    mem.set(k.key, { at: now, kind: k.kind, ttl: k.ttl });
    taken.push(k.key);
  }
  return { ok: true, keys: taken };
}

function noteBlocked(kind, chan, text) {
  if (kind === 'p') stats.blockedPredictions += 1; else stats.blockedMessages += 1;
  stats.last = { at: new Date().toISOString(), kind: kind === 'p' ? 'prédiction' : 'message', channel: chan, text: String(text).slice(0, 80) };
  return { ok: false, reason: kind === 'p' ? 'prediction' : 'message' };
}

// envoi Telegram échoué : on libère pour permettre une nouvelle tentative
function release(keys) {
  if (!Array.isArray(keys) || !keys.length) return;
  for (const k of keys) mem.delete(k);
  dbDelete(keys);
}

// nouveau sabot / minuit : les numéros de jeu repartent de 1 → registre des prédictions vidé
function clearPredictions() {
  for (const [k, v] of mem) if (v.kind === 'p') mem.delete(k);
  if (db.ready) db.exec(`DELETE FROM sent_dedupe WHERE kind = 'p'`).catch(() => {});
}

function configure(patch = {}) {
  const next = { ...((store.read() || {}).sendDedupe || {}) };
  for (const k of ['enabled', 'messages', 'predictions']) if (patch[k] !== undefined) next[k] = !!patch[k];
  for (const k of ['windowMin', 'predictionTtlMin']) if (patch[k] !== undefined) next[k] = Number(patch[k]) || DEFAULTS[k];
  store.patch({ sendDedupe: next });
  return status();
}

function status() { return { config: cfg(), ...stats, memoryKeys: mem.size, database: !!db.ready }; }

try {
  const predictor = require('./predictor');
  if (typeof predictor.setOnShoeReset === 'function') predictor.setOnShoeReset(clearPredictions);
} catch (_) { /* branché plus tard si le moteur n'est pas encore chargé */ }

module.exports = { claim, release, clearPredictions, configure, status, isChannel };
