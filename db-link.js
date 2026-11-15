// db-link.js — connexion à la base Supabase « site-production-baccara », intégrée au code
// (aucune variable d'environnement à régler sur Render).
//
// Accès dédié : le rôle PostgreSQL « bot_app » (limité aux tables du site, pas administrateur
// Supabase). Si ce fichier est publié, la base est lisible par quiconque le voit : garder le
// dépôt PRIVÉ. Pour couper l'accès à tout moment, dans Supabase :  ALTER ROLE bot_app NOLOGIN;
//
// L'ancien DATABASE_URL de Render est IGNORÉ : seule la base Supabase est utilisée.
'use strict';

const REF = 'kmvbsntmzjkpwwqgkqhz';
const USER = 'bot_app';
const PASS = 'ZHv41ll3G8Rir3v1YgzncBlzqk6Hyg2u3d3o6Rfb';

// Adresses essayées dans l'ordre (la première qui répond est retenue). Le « pooler » est
// obligatoire sur Render (réseau IPv4) ; la connexion directe est le dernier recours.
const CANDIDATES = [
  `postgresql://${USER}.${REF}:${PASS}@aws-1-eu-west-3.pooler.supabase.com:5432/postgres`,
  `postgresql://${USER}.${REF}:${PASS}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`,
  `postgresql://${USER}.${REF}:${PASS}@aws-1-eu-west-3.pooler.supabase.com:6543/postgres`,
  `postgresql://${USER}.${REF}:${PASS}@aws-0-eu-west-3.pooler.supabase.com:6543/postgres`,
  `postgresql://${USER}:${PASS}@db.${REF}.supabase.co:5432/postgres`,
];

// ── Base de SECOURS (projet Supabase « tv-kouame », la même que dans l'appli Appel Prédictions) ──
// Même principe que la principale : un rôle PostgreSQL dédié (pas l'admin Supabase).
// À RENSEIGNER avec le mot de passe de ce rôle (Supabase → Connect → Session pooler), soit :
//   • ici, dans BACKUP_PASS (+ BACKUP_USER si le rôle n'est pas « bot_app »),
//   • ou en collant l'adresse complète dans BACKUP_DATABASE_URL (variable Render ou constante ci-dessous).
// Tant que rien n'est renseigné, la base de secours est simplement ignorée (le site marche comme avant).
const BACKUP_REF  = 'hvjgqaxejqnvgvefjhnj';
const BACKUP_USER = process.env.BACKUP_DB_USER || 'bot_app';
const BACKUP_PASS = process.env.BACKUP_DB_PASS || '';          // ← mot de passe du rôle sur la base de secours
const BACKUP_URL_OVERRIDE = String(process.env.BACKUP_DATABASE_URL || '').trim(); // ← ou adresse complète
const BACKUP_REGION = process.env.BACKUP_DB_REGION || 'eu-west-3'; // région du projet de secours (voir Supabase → Settings)

const BACKUP_CANDIDATES = BACKUP_URL_OVERRIDE
  ? [BACKUP_URL_OVERRIDE]
  : (BACKUP_PASS ? [
      `postgresql://${BACKUP_USER}.${BACKUP_REF}:${BACKUP_PASS}@aws-1-${BACKUP_REGION}.pooler.supabase.com:5432/postgres`,
      `postgresql://${BACKUP_USER}.${BACKUP_REF}:${BACKUP_PASS}@aws-0-${BACKUP_REGION}.pooler.supabase.com:5432/postgres`,
      `postgresql://${BACKUP_USER}.${BACKUP_REF}:${BACKUP_PASS}@aws-1-${BACKUP_REGION}.pooler.supabase.com:6543/postgres`,
      `postgresql://${BACKUP_USER}.${BACKUP_REF}:${BACKUP_PASS}@aws-0-${BACKUP_REGION}.pooler.supabase.com:6543/postgres`,
      `postgresql://${BACKUP_USER}:${BACKUP_PASS}@db.${BACKUP_REF}.supabase.co:5432/postgres`,
    ] : []);

const mask = (u) => String(u).replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@');

async function tryOne(url) {
  let c = null;
  try {
    const { Client } = require('pg');
    c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 7000 });
    await c.connect(); await c.query('SELECT 1'); return true;
  } catch (e) { return e.message; }
  finally { try { if (c) await c.end(); } catch (_) { /* ignoré */ } }
}

// Un tour : essaie les adresses d'une liste dans l'ordre, retient la première qui répond.
async function tryList(list, setter, label, log) {
  for (const url of list) {
    const r = await tryOne(url);
    if (r === true) {
      setter(url);
      console.log(`🔌 Base Supabase (${label}) connectée :`, mask(url));
      return url;
    }
    if (log) console.log(`ℹ️  Adresse Supabase (${label}) refusée :`, mask(url), '—', String(r).slice(0, 120));
  }
  return '';
}
const tryAll = (log) => tryList(CANDIDATES, (u) => require('./database-url').setDatabaseUrl(u), 'principale', log);
const tryBackup = (log) => BACKUP_CANDIDATES.length
  ? tryList(BACKUP_CANDIDATES, (u) => require('./database-url').setBackupUrl(u), 'secours', log)
  : Promise.resolve('');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Renseigne les liens des bases (database-url.js) : première adresse qui répond pour la principale ET pour le secours.
// Au démarrage : jusqu'à 3 tours (2 s puis 5 s entre les tours). Si tout échoue, db.js relance ensureDatabaseUrl()
// toutes les 30 s (reconnexion automatique). Renvoie l'adresse de la base utilisable (principale, sinon secours).
async function ensureDatabaseUrl(rounds = 3) {
  if (String(process.env.DATABASE_URL || '').trim()) {
    console.log('ℹ️  DATABASE_URL de Render ignoré (ancienne base) : seules les bases Supabase sont utilisées.');
    delete process.env.DATABASE_URL;
  }
  const dbu = require('./database-url');
  for (let i = 0; i < rounds; i++) {
    const [main, back] = await Promise.all([
      dbu.databaseUrl() ? Promise.resolve(dbu.databaseUrl()) : tryAll(true),
      dbu.backupUrl() ? Promise.resolve(dbu.backupUrl()) : tryBackup(true),
    ]);
    if (main || back) return main || back;
    if (i < rounds - 1) await sleep(i === 0 ? 2000 : 5000);
  }
  console.error('⚠️ Aucune adresse Supabase n\'a répondu — le site démarre sans base et réessaie toutes les 30 s.');
  return '';
}

// Reteste UNE base (0 = principale, 1 = secours) et renvoie son adresse ('' si rien ne répond).
async function ensureOne(which, log) {
  const dbu = require('./database-url');
  const list = which === 0 ? CANDIDATES : BACKUP_CANDIDATES;
  if (!list.length) return '';
  // l'adresse retenue d'abord, puis les autres
  const known = which === 0 ? dbu.databaseUrl() : dbu.backupUrl();
  const ordered = known ? [known, ...list.filter((u) => u !== known)] : list;
  return tryList(ordered, which === 0 ? dbu.setDatabaseUrl : dbu.setBackupUrl, which === 0 ? 'principale' : 'secours', log);
}

module.exports = { ensureDatabaseUrl, ensureOne, CANDIDATES, BACKUP_CANDIDATES };
