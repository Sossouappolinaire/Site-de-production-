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

// Un tour : essaie toutes les adresses dans l'ordre, retient la première qui répond.
async function tryAll(log) {
  for (const url of CANDIDATES) {
    const r = await tryOne(url);
    if (r === true) {
      const { setDatabaseUrl } = require('./database-url');
      setDatabaseUrl(url);
      console.log('🔌 Base Supabase connectée :', mask(url));
      return url;
    }
    if (log) console.log('ℹ️  Adresse Supabase refusée :', mask(url), '—', String(r).slice(0, 120));
  }
  return '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Renseigne le lien de la base (database-url.js) avec la première adresse Supabase qui répond.
// Au démarrage : jusqu'à 3 tours (2 s puis 5 s entre les tours) — une base qui se réveille ou un réseau pas encore prêt ne suffit plus à
// démarrer sans base. Si tout échoue, db.js relance ensureDatabaseUrl() toutes les 30 s (reconnexion automatique, voir bot.js ensureDb).
async function ensureDatabaseUrl(rounds = 3) {
  if (String(process.env.DATABASE_URL || '').trim()) {
    console.log('ℹ️  DATABASE_URL de Render ignoré (ancienne base) : seule Supabase est utilisée.');
    delete process.env.DATABASE_URL;
  }
  for (let i = 0; i < rounds; i++) {
    const url = await tryAll(true);
    if (url) return url;
    if (i < rounds - 1) await sleep(i === 0 ? 2000 : 5000);
  }
  console.error('⚠️ Aucune adresse Supabase n\'a répondu — le site démarre sans base et réessaie toutes les 30 s.');
  return '';
}

module.exports = { ensureDatabaseUrl, CANDIDATES };
