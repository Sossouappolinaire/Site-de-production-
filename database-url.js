// database-url.js — lien PostgreSQL de la base.
// Le seul lien utilisé est celui de Supabase, défini dans db-link.js au démarrage.
// L'ancienne variable DATABASE_URL de Render (ancienne base) est volontairement IGNORÉE.
'use strict';

let current = '';

function databaseUrl() { return current; }
function setDatabaseUrl(url) { current = String(url || '').trim(); }

module.exports = { databaseUrl, setDatabaseUrl };
