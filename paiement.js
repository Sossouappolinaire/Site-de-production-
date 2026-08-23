// paiement.js — Paiement en ligne via LIEN DIRECT Money Fusion (payin.moneyfusion.net),
// SANS passer par l'API FusionPay. Le lien de paiement est construit à
// partir d'un identifiant FIXE (id du compte Money Fusion, voir
// LINK_BASE/LINK_ID ci-dessous), en y insérant juste le montant et le nom
// du client :
//
//   https://payin.moneyfusion.net/payment/{id}/{montant}/{nom}
//
// Confirmation du paiement : AUTOMATIQUE, sans intervention de l'admin.
// Money Fusion est configuré (côté Money Fusion, par l'admin du compte
// Money Fusion — pas dans ce code) pour rediriger le client vers notre page
// succes.html UNIQUEMENT une fois le paiement validé. Cette page interroge
// GET /api/paiement/statut/:ref (voir server.js), qui marque alors le
// paiement comme payé dès ce premier appel — l'arrivée sur succes.html EST
// la preuve du paiement, il n'y a plus de bouton « Confirmer » côté admin.
// Dès la confirmation, le code est envoyé automatiquement au client sur
// Telegram (voir paidHandler, câblé dans bot.js).
'use strict';

const crypto = require('crypto');
const store = require('./store');
const db = require('./db');

// Lien de paiement Money Fusion fixe, fourni par l'admin — base + identifiant
// du compte, réutilisés pour chaque achat en changeant juste le montant et
// le nom du client. Plus besoin de le coller/configurer depuis le panneau.
const LINK_BASE = 'https://payin.moneyfusion.net/payment';
const LINK_ID = '6a8abc79ff0cbef4d3e8dc38';

const records = new Map(); // ref -> { ref, itemId, userId, chatId, lang, amount, buyerName, status, code, createdAt, updatedAt }

let paidHandler = null; // enregistrée par bot.js : async (record) => {} — envoie le code au client sur Telegram
let lastError = null;
let lastErrorAt = null;


// ---------------------------------------------------------------------------
// Verrou temporaire par article (en mémoire, pas besoin de survivre à un
// redémarrage) : dès qu'un acheteur clique « Payer » pour une stratégie, elle
// est réservée pour lui seul pendant 3 minutes. Tant que la réservation est
// active, personne d'autre ne peut lancer un paiement pour la MÊME stratégie
// — ça évite que deux acheteurs se voient attribuer/afficher en même temps le
// même code (celui-ci est unique et partagé tant qu'il n'a pas été consommé,
// voir shop.redeem/unlockItem), ce qui aurait pu faire que succes.html
// affiche à l'un un code déjà régénéré (donc invalide) entre-temps pour
// l'autre. Si le même acheteur reclique, sa réservation est simplement
// prolongée (jamais bloqué par son propre verrou).
// ---------------------------------------------------------------------------
const LOCK_MS = 3 * 60 * 1000; // 3 minutes
const locks = new Map(); // itemId -> { userId, expiresAt }

function getLock(itemId) {
  const lock = locks.get(itemId);
  if (!lock) return null;
  if (Date.now() > lock.expiresAt) { locks.delete(itemId); return null; }
  return lock;
}

// Tente de réserver l'article pour cet acheteur : renvoie le verrou obtenu,
// ou null si un AUTRE acheteur le détient déjà (verrou toujours actif).
function lockItem(itemId, userId) {
  const existing = getLock(itemId);
  if (existing && existing.userId !== String(userId)) return null;
  const lock = { userId: String(userId), expiresAt: Date.now() + LOCK_MS };
  locks.set(itemId, lock);
  return lock;
}

function unlockItem(itemId) { locks.delete(itemId); }

(function loadInitial() {
  try {
    const saved = store.read().paiement;
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.records)) {
        for (const r of saved.records) if (r && r.ref) records.set(r.ref, r);
      }
    }
  } catch (_) { /* ignore */ }
})();

function persist() {
  // on ne garde que les 500 derniers enregistrements (transactions récentes) —
  // pas besoin d'un historique illimité, juste de quoi retrouver un paiement
  // récent (page succes.html rechargée...).
  const recent = [...records.values()]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 500);
  records.clear();
  for (const r of recent) records.set(r.ref, r);
  store.patch({ paiement: { records: recent } });
  if (db.ready) db.setSetting('paiement_data', JSON.stringify({ records: recent })).catch(() => {});
}

async function loadFromDb() {
  if (!db.ready) return false;
  try {
    const raw = await db.getSetting('paiement_data');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.records)) {
      for (const r of parsed.records) if (r && r.ref && !records.has(r.ref)) records.set(r.ref, r);
    }
    return true;
  } catch (_) { return false; }
}

function setPaidHandler(fn) { paidHandler = fn; }

function configured() { return true; } // lien fixe (LINK_BASE/LINK_ID) : toujours prêt, rien à configurer.

function getConfig() {
  return {
    configured: true,
    // dernière erreur rencontrée lors de la construction d'un lien —
    // affichée dans le panneau Boutique → Paiement pour ne pas dépendre
    // uniquement des logs serveur.
    lastError,
    lastErrorAt,
  };
}

function shortRef() { return `pay_${crypto.randomBytes(6).toString('hex')}`; }

// Construit le lien de paiement pour UN montant/nom donnés — même
// identifiant fixe (LINK_ID) à chaque fois, seul le montant et le nom du
// client changent dans l'URL.
function buildStaticLink(amountLocal, buyerName) {
  const name = encodeURIComponent(String(buyerName || 'Client').trim());
  return `${LINK_BASE}/${LINK_ID}/${Math.round(amountLocal)}/${name}`;
}

// ---------------------------------------------------------------------------
// Prépare un achat : réserve un enregistrement local (ref, item, acheteur,
// montant attendu) et construit le lien de paiement direct — pas d'appel
// réseau, tout est local et immédiat. Le code de la stratégie existe déjà
// (généré à la création de l'article, voir shop.js) : il est simplement
// envoyé au client une fois le paiement confirmé (automatiquement, voir
// markPaidOnArrival plus bas).
// Retourne { ok, checkoutUrl, ref } ou { ok:false, error }.
// ---------------------------------------------------------------------------
async function initiatePayment({ item, userId, chatId, lang, buyerName } = {}) {
  if (!item || !Number.isFinite(item.payAmountLocal) || item.payAmountLocal <= 0) {
    lastError = 'Cette stratégie n\'a pas de montant de lien configuré (voir Boutique → cet article → Montant du lien).';
    lastErrorAt = new Date().toISOString();
    return { ok: false, error: lastError };
  }

  const name = buyerName || `Client Telegram ${userId}`;
  const checkoutUrl = buildStaticLink(item.payAmountLocal, name);

  const ref = shortRef();
  const record = {
    ref,
    kind: 'item',
    itemId: item.id,
    userId: String(userId),
    chatId: String(chatId),
    lang: lang || 'fr',
    amount: item.payAmountLocal,
    buyerName: name,
    status: 'pending',
    code: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  records.set(ref, record);
  persist();
  return { ok: true, checkoutUrl, ref };
}

// ---------------------------------------------------------------------------
// Paiement de « soutien » (don libre, sans stratégie associée) : le client
// saisit un montant en $ dans le bot, on construit le même genre de lien
// direct Money Fusion avec le montant converti en F CFA. Une fois confirmé
// (arrivée sur succes.html), AUCUN code n'est envoyé — juste un message de
// remerciement (voir shop.supportThanksMessage, branché dans bot.js).
// ---------------------------------------------------------------------------
async function initiateSupportPayment({ userId, chatId, lang, buyerName, amountUsd, amountLocal } = {}) {
  if (!Number.isFinite(amountLocal) || amountLocal <= 0) {
    lastError = 'Montant de soutien invalide.';
    lastErrorAt = new Date().toISOString();
    return { ok: false, error: lastError };
  }
  const name = buyerName || `Client Telegram ${userId}`;
  const checkoutUrl = buildStaticLink(amountLocal, name);

  const ref = shortRef();
  const record = {
    ref,
    kind: 'support',
    itemId: null,
    userId: String(userId),
    chatId: String(chatId),
    lang: lang || 'fr',
    amount: amountLocal,
    amountUsd,
    buyerName: name,
    status: 'pending',
    code: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  records.set(ref, record);
  persist();
  return { ok: true, checkoutUrl, ref };
}

function getRecord(ref) { return records.get(ref) || null; }

function listPending() {
  return [...records.values()]
    .filter((r) => r.status === 'pending')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// Marque une transaction payée et déclenche le handler (déblocage + envoi
// Telegram) — appelée par markPaidOnArrival (chargement de succes.html),
// protégée contre un double appel (un paiement déjà confirmé n'est jamais
// retraité, ex. si le client recharge la page).
async function markPaid(record) {
  if (record.status === 'paid') return; // déjà traité
  record.status = 'paid';
  record.updatedAt = new Date().toISOString();
  persist();
  unlockItem(record.itemId); // achat confirmé : le verrou n'a plus lieu d'être
  if (paidHandler) {
    try { await paidHandler(record); } catch (e) { console.error('Paiement (handler) :', e.message); }
  }
}

function markFailed(record) {
  if (record.status === 'paid') return; // un paiement déjà confirmé n'est jamais rétrogradé
  record.status = 'failed';
  record.updatedAt = new Date().toISOString();
  persist();
  unlockItem(record.itemId); // paiement annulé/échoué : on libère l'article pour le prochain acheteur
}

// Confirmation AUTOMATIQUE : appelée par le serveur (voir server.js,
// GET /api/paiement/statut/:ref) dès que le navigateur du client charge
// succes.html — cette page n'est atteinte, côté Money Fusion, qu'après un
// paiement réellement validé (URL de succès configurée sur le compte Money
// Fusion). Sans effet si déjà payé/échoué (jamais retraité deux fois).
async function markPaidOnArrival(ref) {
  const record = getRecord(ref);
  if (!record) return null;
  if (record.status === 'pending') await markPaid(record);
  return getRecord(ref);
}

function cancelPayment(ref) {
  const record = getRecord(ref);
  if (!record) return { ok: false, error: 'Paiement introuvable.' };
  markFailed(record);
  return { ok: true, record: getRecord(ref) };
}

// Enregistre le code débloqué (appelé par le gestionnaire dans bot.js après
// shop.redeem) pour que succes.html puisse l'afficher si un ref est présent.
function attachCode(ref, code) {
  const record = records.get(ref);
  if (!record) return;
  record.code = code;
  record.updatedAt = new Date().toISOString();
  persist();
}

module.exports = {
  loadFromDb, setPaidHandler, configured, getConfig,
  initiatePayment, initiateSupportPayment, getRecord, listPending, markPaidOnArrival, cancelPayment, attachCode,
  lockItem, getLock, unlockItem,
};
