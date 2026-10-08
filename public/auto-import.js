// auto-import.js — import AUTOMATIQUE du classeur de configuration au démarrage
// (demande admin) : après un déploiement, le fichier .xlsx placé dans le
// dossier `config-import/` (celui produit par la commande /exporter) est
// importé tout seul, sans passer par Telegram.
//
// Règles :
//   • le fichier .xlsx le plus récent (ordre alphabétique du nom, donc la
//     date dans « baccara-config-AAAA-MM-JJ.xlsx ») du dossier est utilisé ;
//   • il n'est importé QU'UNE FOIS par version de fichier : on retient son
//     empreinte (SHA-256) en base (et dans data.json en repli). Ainsi un
//     simple redémarrage n'écrase pas les réglages modifiés depuis le site ;
//     un NOUVEAU fichier (ou une base vide/réinitialisée) est réimporté ;
//   • toute erreur est journalisée mais ne bloque jamais le démarrage ;
//   • variable d'environnement AUTO_IMPORT=off pour désactiver, ou
//     AUTO_IMPORT=force pour réimporter à chaque démarrage.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const DIR = path.join(__dirname, 'config-import');
const SETTING_KEY = 'auto_import_hash';

function newestFile() {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch (_) { return null; }
  const list = names.filter((n) => /\.xlsx$/i.test(n) && !n.startsWith('~$')).sort();
  return list.length ? path.join(DIR, list[list.length - 1]) : null;
}

async function lastHash(db) {
  if (db && db.ready) {
    try { const v = await db.getSetting(SETTING_KEY); if (v) return String(v); } catch (_) { /* repli ci-dessous */ }
  }
  return (store.read() || {}).autoImportHash || null;
}

async function rememberHash(db, hash) {
  try { store.patch({ autoImportHash: hash }); } catch (_) {}
  if (db && db.ready) { try { await db.setSetting(SETTING_KEY, hash); } catch (_) {} }
}

// deps : { dataTransfer, db, persist, saveConfigsToDb }
async function run(deps) {
  const mode = String(process.env.AUTO_IMPORT || '').toLowerCase();
  if (mode === 'off' || mode === '0' || mode === 'false') return { skipped: 'désactivé (AUTO_IMPORT=off)' };
  const file = newestFile();
  if (!file) return { skipped: 'aucun fichier .xlsx dans config-import/' };
  try {
    const buffer = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (mode !== 'force' && (await lastHash(deps.db)) === hash) {
      return { skipped: `déjà importé (${path.basename(file)})` };
    }
    const report = await deps.dataTransfer.importBufferAsync(buffer);
    deps.persist();
    if (deps.db && deps.db.ready && typeof deps.saveConfigsToDb === 'function') await deps.saveConfigsToDb();
    await rememberHash(deps.db, hash);
    return { imported: path.basename(file), report };
  } catch (e) {
    return { error: e.message, file: path.basename(file) };
  }
}

module.exports = { run, newestFile, DIR };
