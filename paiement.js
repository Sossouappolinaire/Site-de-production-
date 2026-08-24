// paiement.js — Paiement en ligne via des LIENS FIXES Money Fusion, un par
// catégorie de vente (pages "boutique" créées manuellement sur le compte
// Money Fusion, voir shop.getPayLink/setPayLink) :
// - 'strategy' : les stratégies existantes (catalogue)
// - 'ia_100'   : déclencheurs IA à 100% de réussite
// - 'ia_93'    : déclencheurs IA de 93% à 99,99%
// Tous les articles d'une même catégorie partagent le même lien, collé une
// fois par l'admin depuis le panneau Boutique.
//
// Comme le lien est identique pour toute une catégorie, Money Fusion ne
// peut pas rediriger vers une URL différente par transaction : il redirige
// toujours vers la même succes.html (URL fixe configurée dans chaque
// produit Money Fusion), sans paramètre de référence. C'est pourquoi le bot
// envoie EN PLUS un bouton « Voir mon code » qui, lui, pointe directement
// vers succes.html avec la référence de CETTE réservation (ref, id
// Telegram, nom, prénom) — c'est ce lien-là qui permet à succes.html de
// retrouver la bonne transaction et d'afficher le code une fois que le
// client confirme avoir payé.
'use strict';

const crypto = require('crypto');
const store = require('./store');
const db = require('./db');
const shop = require('./shop');

const records = new Map(); // ref -> { ref, itemId, userId, chatId, lang, amount, buyerName, status, code, createdAt, updatedAt }

let paidHandler = null; // enregistrée par bot.js : async (record) => {} — envoie le code au client sur Telegram
let lastError = null;
let lastErrorAt = null;


// ---------------------------------------------------------------------------
// Verrou global de la boutique (en mémoire, pas besoin de survivre à un
// redémarrage) : dès qu'un acheteur clique « Payer » pour une stratégie,
// aucun AUTRE utilisateur ne peut lancer de paiement, même pour une autre
// stratégie, pendant 3 minutes. Le même acheteur peut rouvrir SA propre
// réservation (même article) sans problème ; mais s'il clique par erreur
// sur un AUTRE article pendant que son verrou est actif, cette tentative
// est traitée exactement comme si c'était quelqu'un d'autre — bloquée avec
// le même message d'attente — pour ne jamais changer de lien de paiement
// en cours de réservation.
// ---------------------------------------------------------------------------
const LOCK_MS = 3 * 60 * 1000; // 3 minutes
const GLOBAL_LOCK_KEY = '__shop_global__';
const locks = new Map(); // verrou global -> { userId, itemId, expiresAt }
const expiryTimers = new Map(); // ref -> timeout
let expiredHandler = null;

function getLock() {
  const lock = locks.get(GLOBAL_LOCK_KEY);
  if (!lock) return null;
  if (Date.now() >= lock.expiresAt) { locks.delete(GLOBAL_LOCK_KEY); return null; }
  return lock;
}

// Tente de réserver CET article pour cet acheteur : renvoie le verrou
// obtenu, ou null si un autre verrou est déjà actif — que ce soit un autre
// utilisateur, OU CE MÊME utilisateur mais pour un autre article (traité
// comme une personne différente, voir commentaire ci-dessus).
function lockItem(itemId, userId) {
  const existing = getLock();
  if (existing && (existing.userId !== String(userId) || existing.itemId !== String(itemId))) return null;
  const lock = { userId: String(userId), itemId: String(itemId), expiresAt: Date.now() + LOCK_MS };
  locks.set(GLOBAL_LOCK_KEY, lock);
  return lock;
}

function unlockItem(_itemId) { locks.delete(GLOBAL_LOCK_KEY); }

function setExpiredHandler(fn) { expiredHandler = fn; }

async function expireRecord(ref, force = false) {
  const record = records.get(ref);
  if (!record || record.status === 'expired') return record;
  if (!force && record.expiresAt && Date.now() < record.expiresAt) return record;
  const expiredCode = record.code;
  record.status = 'expired';
  record.code = null;
  record.updatedAt = new Date().toISOString();
  persist();
  const lock = getLock();
  if (!lock || lock.userId === String(record.userId)) unlockItem();
  if (expiredHandler) {
    try { await expiredHandler({ ...record, code: expiredCode }); } catch (e) {
      console.error('Expiration du paiement :', e.message);
    }
  }
  return record;
}

// Expiration IMMÉDIATE, déclenchée dès que le client a copié le code sur
// succes.html (bouton « Copier ») — le code est à usage unique dès qu'il a
// été vu/copié, inutile d'attendre les 3 minutes restantes. Annule le
// minuteur programmé (scheduleExpiry) pour éviter un double traitement, puis
// force l'expiration même si record.expiresAt n'est pas encore atteint.
function expireNow(ref) {
  const timer = expiryTimers.get(ref);
  if (timer) { clearTimeout(timer); expiryTimers.delete(ref); }
  return expireRecord(ref, true);
}

function scheduleExpiry(ref, expiresAt) {
  if (!expiresAt) return;
  const oldTimer = expiryTimers.get(ref);
  if (oldTimer) clearTimeout(oldTimer);
  const delay = Math.max(0, expiresAt - Date.now());
  const timer = setTimeout(() => {
    expiryTimers.delete(ref);
    expireRecord(ref).catch((e) => console.error('Expiration du paiement :', e.message));
  }, delay);
  expiryTimers.set(ref, timer);
}

(function loadInitial() {
  try {
    const saved = store.read().paiement;
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.records)) {
        for (const r of saved.records) if (r && r.ref) {
          records.set(r.ref, r);
          scheduleExpiry(r.ref, r.expiresAt);
        }
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
      for (const r of parsed.records) if (r && r.ref && !records.has(r.ref)) {
        records.set(r.ref, r);
        scheduleExpiry(r.ref, r.expiresAt);
      }
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

// ---------------------------------------------------------------------------
// Prépare un achat : réserve un enregistrement local (ref, item, acheteur,
// montant attendu) et résout le lien de paiement Money Fusion de la
// catégorie de cet article (voir shop.payLinkForItem — collé par l'admin,
// un seul lien pour toute la catégorie). Le code de la stratégie existe
// déjà (généré à la création de l'article, voir shop.js) : il est stocké
// dans l'enregistrement pour être affiché sur succes.html une fois le
// paiement confirmé ; le déblocage Telegram se fait uniquement après
// saisie manuelle du code dans le bot.
// Retourne { ok, checkoutUrl, ref } ou { ok:false, error }.
// ---------------------------------------------------------------------------
async function initiatePayment({ item, userId, chatId, lang, buyerName } = {}) {
  if (!item) {
    lastError = 'Article introuvable.';
    lastErrorAt = new Date().toISOString();
    return { ok: false, error: lastError };
  }
  const checkoutUrl = shop.payLinkForItem(item);
  if (!checkoutUrl) {
    lastError = `Aucun lien de paiement n'est configuré pour la catégorie « ${shop.categoryForItem(item)} » (voir Boutique → Paiement en ligne).`;
    lastErrorAt = new Date().toISOString();
    return { ok: false, error: lastError };
  }

  const name = buyerName || `Client Telegram ${userId}`;
  const lock = getLock();
  const expiresAt = lock ? lock.expiresAt : Date.now() + LOCK_MS;

  const ref = shortRef();
  const record = {
    ref,
    kind: 'item',
    itemId: item.id,
    userId: String(userId),
    chatId: String(chatId),
    lang: lang || 'fr',
    amount: item.payAmountLocal ?? null,
    buyerName: name,
    status: 'pending',
    code: null,
    expiresAt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  records.set(ref, record);
  persist();
  scheduleExpiry(ref, expiresAt);
  return { ok: true, checkoutUrl, ref };
}

// ---------------------------------------------------------------------------
// Paiement de « soutien » (don libre, sans stratégie associée) : le client
// saisit un montant en $ dans le bot. Comme il n'y a pas de catégorie
// d'article associée, on utilise par défaut le lien « stratégies
// existantes » (le premier configuré par l'admin). Une fois confirmé
// (clic sur « Voir mon code » sur succes.html), AUCUN code n'est envoyé —
// juste un message de remerciement (voir shop.supportThanksMessage,
// branché dans bot.js).
// ---------------------------------------------------------------------------
async function initiateSupportPayment({ userId, chatId, lang, buyerName, amountUsd, amountLocal } = {}) {
  if (!Number.isFinite(amountLocal) || amountLocal <= 0) {
    lastError = 'Montant de soutien invalide.';
    lastErrorAt = new Date().toISOString();
    return { ok: false, error: lastError };
  }
  const checkoutUrl = shop.getPayLink('strategy') || shop.getPayLink('ia_93') || shop.getPayLink('ia_100');
  if (!checkoutUrl) {
    lastError = "Aucun lien de paiement n'est configuré (voir Boutique → Paiement en ligne).";
    lastErrorAt = new Date().toISOString();
    return { ok: false, error: lastError };
  }
  const name = buyerName || `Client Telegram ${userId}`;
  const expiresAt = Date.now() + LOCK_MS;

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
    expiresAt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  records.set(ref, record);
  persist();
  scheduleExpiry(ref, expiresAt);
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
  // Le verrou reste actif pendant les 3 minutes prévues, même après
  // confirmation du paiement. Cela empêche un autre utilisateur de payer
  // pendant que le premier copie son code.
  if (paidHandler) {
    try { await paidHandler(record); } catch (e) { console.error('Paiement (handler) :', e.message); }
  }
}

function markFailed(record) {
  if (record.status === 'paid') return; // un paiement déjà confirmé n'est jamais rétrogradé
  record.status = 'failed';
  record.updatedAt = new Date().toISOString();
  persist();
  // Même un paiement annulé ne libère pas la stratégie avant la fin des
  // 3 minutes commencées au clic sur « Payer ».
}

// Confirmation AUTOMATIQUE : appelée par le serveur (voir server.js,
// GET /api/paiement/statut/:ref) dès que le navigateur du client charge
// succes.html — cette page n'est atteinte, côté Money Fusion, qu'après un
// paiement réellement validé (URL de succès configurée sur le compte Money
// Fusion). Sans effet si déjà payé/échoué (jamais retraité deux fois).
async function markPaidOnArrival(ref) {
  const record = getRecord(ref);
  if (!record) return null;
  if (record.expiresAt && Date.now() >= record.expiresAt) {
    return expireRecord(ref);
  }
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
  loadFromDb, setPaidHandler, setExpiredHandler, configured, getConfig,
  initiatePayment, initiateSupportPayment, getRecord, listPending, markPaidOnArrival, cancelPayment, attachCode,
  lockItem, getLock, unlockItem, expireNow,
};
