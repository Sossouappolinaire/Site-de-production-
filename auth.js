// auth.js — protection du tableau de bord web
//
//  • Compte administrateur fixe : identifiant « sossoukouam » / mot de passe
//    « arrow2026 » (semé automatiquement en base au premier démarrage, une
//    seule fois — un changement de mot de passe ultérieur n'est jamais
//    écrasé au redémarrage).
//  • Si les identifiants ne correspondent à aucun compte connu, la personne
//    peut créer un compte : email @gmail.com + mot de passe + confirmation.
//  • AUCUN code n'est envoyé par email : dès l'inscription, le compte est
//    créé « en attente » et c'est l'administrateur qui l'accepte (et lui
//    accorde un temps d'accès) depuis le panneau « Utilisateurs ».
'use strict';

const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');

const ADMIN_IDENTIFIER = 'sossoukouam';
const ADMIN_PASSWORD_DEFAULT = 'arrow2026';
// contact affiché à un compte bloqué (temps accordé par l'admin écoulé)
const TELEGRAM_CONTACT = 't.me/Kouamappoloak';

function normalize(v) {
  return String(v || '').trim().toLowerCase();
}

function isGmail(email) {
  return /^[^\s@]+@gmail\.com$/i.test(normalize(email));
}

// ---------------------------------------------------------------------------
// Compte administrateur — semé une seule fois (ON CONFLICT DO NOTHING) pour
// ne jamais écraser un mot de passe déjà changé par la suite.
// ---------------------------------------------------------------------------
async function ensureAdminSeed() {
  if (!db.ready) return;
  try {
    const hash = await bcrypt.hash(ADMIN_PASSWORD_DEFAULT, 10);
    await db.exec(
      `INSERT INTO users (identifier, email, password_hash, role, verified, approved)
       VALUES ($1, NULL, $2, 'admin', true, true)
       ON CONFLICT (identifier) DO NOTHING`,
      [ADMIN_IDENTIFIER, hash]
    );
    // La confirmation par email a été supprimée : tous les comptes existants
    // deviennent « confirmés » et n'attendent plus que l'accord de l'admin.
    await db.exec(`UPDATE users SET verified = true WHERE verified = false`);
  } catch (e) { console.error('Seed admin impossible :', e.message); }
}

async function findUser(identifierOrEmail) {
  const v = normalize(identifierOrEmail);
  if (!v) return null;
  const rows = await db.rows(
    `SELECT * FROM users WHERE lower(identifier) = $1 OR lower(email) = $1 LIMIT 1`,
    [v]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------
async function login(identifierRaw, password) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée.' };
  const identifier = normalize(identifierRaw);
  const pwd = String(password || '');
  if (!identifier || !pwd) return { ok: false, error: 'Identifiant et mot de passe requis.' };
  const user = await findUser(identifier);
  if (!user) return { ok: false, error: 'Identifiants incorrects.', unknown: true };
  const match = await bcrypt.compare(pwd, user.password_hash);
  if (!match) return { ok: false, error: 'Identifiants incorrects.' };

  if (user.role !== 'admin') {
    const access = await checkUserAccess(user);
    if (!access.ok) return access;
  }

  return { ok: true, userId: user.id, identifier: user.identifier, role: user.role };
}

// ---------------------------------------------------------------------------
// Vérifie qu'un compte « user » (jamais l'admin) est bien accordé par
// l'administrateur et que le temps accordé n'est pas dépassé. Utilisé à la
// connexion ET à chaque requête (voir server.js) pour couper l'accès dès
// l'expiration, même en pleine session.
// ---------------------------------------------------------------------------
async function checkUserAccess(user) {
  if (!user.approved) {
    return {
      ok: false,
      error: "Compte en attente : l'administrateur doit encore valider votre inscription. Merci de patienter.",
      pendingApproval: true,
    };
  }
  const expiresAt = user.access_expires_at ? new Date(user.access_expires_at).getTime() : null;
  const expired = expiresAt !== null && expiresAt < Date.now();
  if (expired || user.blocked) {
    if (expired && !user.blocked) {
      await db.exec(`UPDATE users SET blocked = true WHERE id = $1`, [user.id]);
    }
    return {
      ok: false,
      error: 'Votre temps d’accès est écoulé — votre compte est bloqué.',
      blocked: true,
      telegram: TELEGRAM_CONTACT,
    };
  }
  return { ok: true };
}

// contrôle léger utilisé sur chaque requête protégée (via l'id de session)
async function checkAccess(userId) {
  if (!db.ready) return { ok: true };
  const rows = await db.rows(`SELECT * FROM users WHERE id = $1`, [Number(userId)]);
  const user = rows[0];
  if (!user) return { ok: false, error: 'Session invalide.' };
  if (user.role === 'admin') return { ok: true };
  return checkUserAccess(user);
}

// ---------------------------------------------------------------------------
// Création de compte (si les identifiants fournis ne correspondent à rien)
// ---------------------------------------------------------------------------
async function signup(emailRaw, password, confirmPassword) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée.' };
  const email = normalize(emailRaw);
  if (!isGmail(email)) return { ok: false, error: 'Seules les adresses @gmail.com sont acceptées.' };
  if (!password || String(password).length < 6)
    return { ok: false, error: 'Mot de passe trop court (6 caractères minimum).' };
  if (password !== confirmPassword)
    return { ok: false, error: 'Les deux mots de passe ne correspondent pas.' };

  const existing = await findUser(email);
  if (existing && existing.verified)
    return { ok: false, error: 'Un compte existe déjà avec cet email — connectez-vous.' };

  const hash = await bcrypt.hash(String(password), 10);
  if (existing) {
    await db.exec(`UPDATE users SET password_hash = $2, verified = true WHERE id = $1`, [existing.id, hash]);
  } else {
    await db.exec(
      `INSERT INTO users (identifier, email, password_hash, role, verified, approved)
       VALUES ($1, $1, $2, 'user', true, false)`,
      [email, hash]
    );
  }

  // Plus aucun code par email : le compte attend simplement la validation
  // de l'administrateur dans le panneau « Utilisateurs ».
  return { ok: true, email, pendingApproval: true };
}

// ---------------------------------------------------------------------------
// Panneau administrateur « Utilisateurs » : lister les comptes créés par
// email, accepter un compte (avec un temps d'accès en minutes ou en heures),
// bloquer manuellement, ou refuser/supprimer un compte en attente.
// ---------------------------------------------------------------------------
function userView(u) {
  const expiresAt = u.access_expires_at ? new Date(u.access_expires_at).getTime() : null;
  const expired = expiresAt !== null && expiresAt < Date.now();
  const blocked = !!u.blocked || expired;
  let status = 'attente_admin';
  if (u.approved && blocked) status = 'bloque';
  else if (u.approved && !blocked) status = 'actif';
  return {
    id: u.id,
    identifier: u.identifier,
    email: u.email,
    verified: !!u.verified,
    approved: !!u.approved,
    blocked,
    accessExpiresAt: u.access_expires_at || null,
    status,
    createdAt: u.created_at,
    approvedAt: u.approved_at || null,
  };
}

async function listUsers() {
  if (!db.ready) return [];
  const rows = await db.rows(
    `SELECT id, identifier, email, verified, approved, access_expires_at, blocked, created_at, approved_at
       FROM users WHERE role != 'admin' ORDER BY created_at DESC`
  );
  return rows.map(userView);
}

async function approveUser(userIdRaw, minutesRaw) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée.' };
  const id = Number(userIdRaw);
  const minutes = Number(minutesRaw);
  if (!id) return { ok: false, error: 'Utilisateur invalide.' };
  if (!minutes || minutes <= 0) return { ok: false, error: "Durée invalide — indiquez un temps en minutes ou en heures." };
  const rows = await db.rows(`SELECT * FROM users WHERE id = $1 AND role != 'admin'`, [id]);
  const user = rows[0];
  if (!user) return { ok: false, error: 'Utilisateur introuvable.' };
  const expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
  await db.exec(
    `UPDATE users SET approved = true, blocked = false, access_expires_at = $2, approved_at = now() WHERE id = $1`,
    [id, expiresAt]
  );
  return { ok: true, user: userView({ ...user, approved: true, blocked: false, access_expires_at: expiresAt }) };
}

async function blockUser(userIdRaw) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée.' };
  const id = Number(userIdRaw);
  if (!id) return { ok: false, error: 'Utilisateur invalide.' };
  const rows = await db.rows(`SELECT * FROM users WHERE id = $1 AND role != 'admin'`, [id]);
  const user = rows[0];
  if (!user) return { ok: false, error: 'Utilisateur introuvable.' };
  await db.exec(`UPDATE users SET blocked = true WHERE id = $1`, [id]);
  return { ok: true, user: userView({ ...user, blocked: true }) };
}

async function rejectUser(userIdRaw) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée.' };
  const id = Number(userIdRaw);
  if (!id) return { ok: false, error: 'Utilisateur invalide.' };
  const rows = await db.rows(`SELECT * FROM users WHERE id = $1 AND role != 'admin'`, [id]);
  if (!rows[0]) return { ok: false, error: 'Utilisateur introuvable.' };
  await db.exec(`DELETE FROM users WHERE id = $1`, [id]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Compte Brevo expéditeur — configuré UNE FOIS par l'admin (stocké en base,
// réutilisé pour tous les envois de code suivants). Brevo envoie par API
// HTTP (port 443, jamais bloqué par Render, contrairement au SMTP classique
// bloqué sur le plan gratuit) — voir https://developers.brevo.com.
// Contrairement à Resend, aucun domaine à vérifier : seule l'adresse
// expéditrice doit être validée une fois dans Brevo (Settings > Senders).
// ---------------------------------------------------------------------------
function parseFromAddress(fromRaw) {
  const from = String(fromRaw || '').trim();
  const m = from.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>$/) || from.match(/^([^<>\s]+@[^<>\s]+)$/);
  if (!m) return null;
  const email = (m[2] || m[1]).trim();
  const name = m[2] ? m[1].replace(/["']/g, '').trim() : 'Baccara Bot';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { name: name || 'Baccara Bot', email };
}

async function configureMailSender(apiKeyRaw, fromRaw) {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée.' };
  const apiKey = String(apiKeyRaw || '').trim();
  if (!apiKey) return { ok: false, error: "Clé API Brevo requise (créez un compte sur app.brevo.com)." };
  const from = String(fromRaw || '').trim();
  if (from && !parseFromAddress(from)) {
    return {
      ok: false,
      error: "Adresse expéditrice invalide — format attendu : Nom <adresse@exemple.com>.",
    };
  }
  await db.setSetting('brevo_api_key', apiKey);
  if (from) await db.setSetting('brevo_from', from);
  return { ok: true, from: from || null };
}

async function mailerStatus() {
  let apiKey = null, from = null;
  if (db.ready) {
    apiKey = await db.getSetting('brevo_api_key');
    from = await db.getSetting('brevo_from');
  }
  apiKey = apiKey || config.BREVO_API_KEY;
  from = from || config.BREVO_FROM;
  return { configured: !!(apiKey && apiKey !== 'BREVO_API_KEY_A_REMPLACER'), from: from || null };
}

// ---------------------------------------------------------------------------
// Diagnostic public (aucune donnée sensible renvoyée) — pour comprendre,
// sans être connecté, pourquoi la connexion admin échoue en production :
// la base utilisée est-elle bien joignable ? le compte existe-t-il vraiment ?
// ---------------------------------------------------------------------------
async function debugInfo() {
  const dbStatus = db.status();
  if (!dbStatus.ready) {
    return { db: dbStatus, usersTableReachable: false };
  }
  let userCount = null;
  let adminExists = false;
  let adminVerified = null;
  try {
    const countRows = await db.rows(`SELECT count(*)::int AS n FROM users`);
    userCount = countRows[0] ? countRows[0].n : null;
    const admin = await findUser(ADMIN_IDENTIFIER);
    adminExists = !!admin;
    adminVerified = admin ? !!admin.verified : null;
  } catch (e) {
    return { db: dbStatus, usersTableReachable: false, error: e.message };
  }
  return { db: dbStatus, usersTableReachable: true, userCount, adminExists, adminVerified };
}

module.exports = {
  ADMIN_IDENTIFIER,
  TELEGRAM_CONTACT,
  ensureAdminSeed,
  login,
  signup,
  checkAccess,
  listUsers,
  approveUser,
  blockUser,
  rejectUser,
  configureMailSender,
  mailerStatus,
  debugInfo,
};
