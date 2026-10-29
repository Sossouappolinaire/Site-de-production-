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
  }, 2000);
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

function write(data) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    scheduleMirror();
    return true;
  } catch (e) {
    console.error('Sauvegarde impossible :', e.message);
    return false;
  }
}

function patch(partial) {
  const data = { ...read(), ...partial };
  write(data);
  return data;
}

module.exports = { read, write, patch, FILE, flushMirror };
