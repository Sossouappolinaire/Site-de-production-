// store.js — persistance simple (token du bot, canaux, seuil B) dans data.json
const fs = require('fs');
const path = require('path');

const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Miroir vers la base (Supabase) : écriture groupée toutes les 2 s maximum.
const MIRROR_DELAY_MS = Number(process.env.MIRROR_DELAY_MS) || 5000; // v133 : 5 s (au lieu de 2 s) entre deux envois de l'état complet
let mirrorTimer = null;
let mirrorEnabled = true;
function scheduleMirror() {
  if (!mirrorEnabled || mirrorTimer) return;
  mirrorTimer = setTimeout(async () => {
    mirrorTimer = null;
    try {
      const db = require('./db'); // chargé à la demande (db.js dépend de store.js)
      if (db && db.ready) await db.saveStoreSnapshot(read());
    } catch (e) { console.error('Miroir de l\'état vers la base impossible :', e.message); }
  }, MIRROR_DELAY_MS);
  if (mirrorTimer.unref) mirrorTimer.unref();
}

// Écrit immédiatement l'état local dans la base (utilisé à l'arrêt du process).
async function flushMirror() {
  if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
  try {
    const db = require('./db');
    if (db && db.ready) await db.saveStoreSnapshot(read());
  } catch (e) { console.error('Sauvegarde finale vers la base impossible :', e.message); }
}

// v133 : dernier contenu écrit pour chaque clé (patch). Si une clé est identique à la précédente, rien n'est relu ni réécrit :
// avant, 3 minuteries (J'aime, Type de mise, Copie et annonce) relisaient puis réécrivaient TOUT data.json toutes les 4 s
// même sans changement, bloquant le serveur et renvoyant l'état complet à Supabase en boucle.
const lastSerialized = Object.create(null);

function write(data) {
  try {
    for (const k of Object.keys(lastSerialized)) delete lastSerialized[k];
    fs.writeFileSync(FILE, JSON.stringify(data));
    scheduleMirror();
    return true;
  } catch (e) {
    console.error('Sauvegarde impossible :', e.message);
    return false;
  }
}

function patch(partial) {
  const ser = {};
  let changed = false;
  for (const k of Object.keys(partial || {})) {
    const s = JSON.stringify(partial[k]);
    ser[k] = s;
    if (s === undefined || lastSerialized[k] !== s) changed = true;
  }
  if (!changed) return null; // rien n'a changé depuis la dernière écriture : aucun accès disque, aucun envoi à la base
  const data = { ...read(), ...partial };
  if (write(data)) Object.assign(lastSerialized, ser); // write() vide le cache, on le remplit après l'écriture réussie
  return data;
}

module.exports = { read, write, patch, FILE, flushMirror };
