// database-url.js — liens PostgreSQL des bases.
// Deux bases Supabase sont utilisées (définies dans db-link.js au démarrage) :
//   • la base PRINCIPALE  (databaseUrl)
//   • la base de SECOURS  (backupUrl, projet « tv-kouame »)
// Si l'une est pleine ou injoignable, db.js bascule sur l'autre automatiquement.
// L'ancienne variable DATABASE_URL de Render (ancienne base) est volontairement IGNORÉE.
'use strict';

let current = '';
let backup = '';

function databaseUrl() { return current; }
function setDatabaseUrl(url) { current = String(url || '').trim(); }
function backupUrl() { return backup; }
function setBackupUrl(url) { backup = String(url || '').trim(); }

module.exports = { databaseUrl, setDatabaseUrl, backupUrl, setBackupUrl };
