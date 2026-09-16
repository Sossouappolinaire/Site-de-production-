// Registre commun des envois de prédictions.
// Les panneaux sont indépendants pour leur logique, mais un même jeu +
// costume ne doit être publié qu'une fois dans un même canal Telegram.
'use strict';

const db = require('./db');

const reserved = new Set();
const sent = new Set();
let resetBarrier = Promise.resolve();
let resetPending = false;

function normalizeChannel(channel) {
  return String(channel == null ? '' : channel).trim();
}

function keyOf(target, suit, channel) {
  return `${Number(target) || 0}|${String(suit || '')}|${normalizeChannel(channel)}`;
}

async function claim({ target, suit, channel, source = 'prediction' } = {}) {
  await resetBarrier;
  if (resetPending && db.ready) {
    resetPending = false;
    resetBarrier = Promise.resolve(db.clearPredictionDeliveries()).catch(() => {});
    await resetBarrier;
  }
  const key = keyOf(target, suit, channel);
  if (!Number(target) || !String(suit || '') || !normalizeChannel(channel)) return false;
  if (sent.has(key) || reserved.has(key)) return false;
  reserved.add(key);

  if (db.ready) {
    try {
      const ok = await db.reservePredictionDelivery({ target, suit, channel, source });
      if (ok === false) {
        reserved.delete(key);
        sent.add(key);
        return false;
      }
    } catch (_) {
      // Le verrou mémoire reste actif si la base tombe pendant l'envoi.
    }
  }
  return true;
}

async function markSent({ target, suit, channel } = {}) {
  const key = keyOf(target, suit, channel);
  reserved.delete(key);
  sent.add(key);
  if (db.ready) {
    try { await db.completePredictionDelivery({ target, suit, channel }); } catch (_) {}
  }
}

async function release({ target, suit, channel } = {}) {
  const key = keyOf(target, suit, channel);
  reserved.delete(key);
  sent.delete(key);
  if (db.ready) {
    try { await db.releasePredictionDelivery({ target, suit, channel }); } catch (_) {}
  }
}

function reset() {
  reserved.clear();
  sent.clear();
  resetPending = true;
  resetBarrier = db.ready
    ? Promise.resolve(db.clearPredictionDeliveries()).catch(() => {})
    : Promise.resolve();
  if (db.ready) resetPending = false;
}

module.exports = { claim, markSent, release, reset, keyOf };