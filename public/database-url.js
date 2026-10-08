// database-url.js — lien de la base de données PostgreSQL (Render).
//
// Base « kile » (Render, région Oregon). Le lien INTERNE est utilisé quand le
// service tourne sur Render (plus rapide, réseau privé) ; sinon on retombe sur
// le lien EXTERNE. La variable d'environnement DATABASE_URL reste prioritaire
// pour pouvoir changer de base sans toucher au code.
'use strict';

const INTERNAL_URL =
  'postgresql://kile_user:tpmejh5WKH8fYEeC3NQucNWZp9XhLl0g@dpg-dalgdimk1f9s7385no2g-a/kile';
const EXTERNAL_URL =
  'postgresql://kile_user:tpmejh5WKH8fYEeC3NQucNWZp9XhLl0g@dpg-dalgdimk1f9s7385no2g-a.oregon-postgres.render.com/kile';

// Sur Render, la variable RENDER est toujours définie : on privilégie alors le
// lien interne (le nom d'hôte court n'est résolvable que depuis Render).
const DEFAULT_URL = process.env.RENDER ? INTERNAL_URL : EXTERNAL_URL;

function databaseUrl() {
  return String(process.env.DATABASE_URL || DEFAULT_URL || '').trim();
}

module.exports = { databaseUrl, INTERNAL_URL, EXTERNAL_URL, DEFAULT_URL };
