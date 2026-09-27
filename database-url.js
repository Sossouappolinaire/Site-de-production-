// database-url.js — MODE SANS BASE DE DONNÉES.
// Aucune URL par défaut : la base n'est utilisée QUE si DATABASE_URL est définie.
'use strict';
function databaseUrl() { return String(process.env.DATABASE_URL || '').trim(); }
module.exports = { databaseUrl, INTERNAL_URL: '', EXTERNAL_URL: '', DEFAULT_URL: '' };
