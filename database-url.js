// database-url.js — lien PostgreSQL fourni à l'exécution.
'use strict';

function databaseUrl() {
  return String(process.env.DATABASE_URL || '').trim();
}

module.exports = { databaseUrl };
