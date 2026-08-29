// paiement.js — Paiement en ligne via des LIENS FIXES Money Fusion, un par
// catégorie de vente (pages "boutique" créées manuellement sur le compte
// Money Fusion, voir shop.getPayLink/setPayLink) :
// - 'strategy' : les stratégies existantes (catalogue)
// - 'ia_100'   : déclencheurs IA à 100% de réussite
// - 'ia_93'    : déclencheurs IA de 93% à 99,99%
// Tous les articles d'une même catégorie partagent le même lien, collé une
// fois par l'admin depuis le panneau Boutique.
//
// Le bot ouvre directement ce lien pour le paiement. Il envoie aussi un
// bouton séparé « Voir mon code », qui pointe vers succes.html avec la
// référence de CETTE réservation (ref, identité et ID Telegram).
'use strict';

const crypto = require('crypto');
const store = require('./store');
const db = require('./db');
const shop = require('./shop');
const config = require('./config');

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
const LOCK_MS = 10 * 60 * 1000; // 10 minutes — laisse le temps au paiement mobile money (Money Fusion) de se confirmer avant expiration de la réservation
const COPY_GRACE_MS = 30 * 1000; // 30 secondes après la copie
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

// Après la copie, le code reste utilisable pendant 30 secondes afin de
// laisser le temps au client de revenir dans Telegram et de l'envoyer au bot.
// La première copie fixe le délai : recharger la page ne doit pas prolonger
// indéfiniment la validité du code.
function expireAfterCopy(ref) {
  const record = records.get(ref);
  if (!record || record.status === 'expired') return record;
  if (record.status !== 'paid' || !record.code) return record;
  if (record.copiedAt) return record;

  record.copiedAt = new Date().toISOString();
  record.expiresAt = Date.now() + COPY_GRACE_MS;
  record.updatedAt = new Date().toISOString();
  persist();
  scheduleExpiry(ref, record.expiresAt);
  return record;
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
  const provider = shop.getPaymentProvider(); // 'fusion' (défaut) ou 'sebpay' — choix admin, voir shop.js
  const ref = shortRef();
  let checkoutUrl;
  if (provider === 'sebpay') {
    // SebPay n'a pas de lien fixe : le client donne son numéro/opérateur sur
    // NOTRE page (voir sebpay.js, public/pay-sebpay.html), qui lance
    // elle-même l'encaissement. Le code n'est attaché qu'à la confirmation
    // RÉELLE du webhook (voir confirmSebpayPayment plus bas), jamais par un
    // minuteur aveugle comme pour Money Fusion ci-dessous.
    if (!config.PUBLIC_URL) {
      lastError = "URL publique du site non configurée (PUBLIC_URL) : impossible de générer le lien de paiement SebPay.";
      lastErrorAt = new Date().toISOString();
      return { ok: false, error: lastError };
    }
    const keys = shop.getSebpayKeys();
    if (!keys.publicKey || !keys.secretKey) {
      lastError = "Clés API SebPay non configurées (voir Boutique → Paiement).";
      lastErrorAt = new Date().toISOString();
      return { ok: false, error: lastError };
    }
    checkoutUrl = `${config.PUBLIC_URL}/pay-sebpay.html?ref=${ref}`;
  } else {
    checkoutUrl = shop.payLinkForItem(item);
    if (!checkoutUrl) {
      lastError = `Aucun lien de paiement n'est configuré pour la catégorie « ${shop.categoryForItem(item)} » (voir Boutique → Paiement en ligne).`;
      lastErrorAt = new Date().toISOString();
      return { ok: false, error: lastError };
    }
  }

  const name = buyerName || `Client Telegram ${userId}`;
  const lock = getLock();
  const expiresAt = lock ? lock.expiresAt : Date.now() + LOCK_MS;

  const record = {
    ref,
    kind: 'item',
    provider,
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
  return { ok: true, checkoutUrl, ref, provider };
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
  const provider = shop.getPaymentProvider();
  const ref = shortRef();
  let checkoutUrl;
  if (provider === 'sebpay') {
    if (!config.PUBLIC_URL) {
      lastError = "URL publique du site non configurée (PUBLIC_URL) : impossible de générer le lien de paiement SebPay.";
      lastErrorAt = new Date().toISOString();
      return { ok: false, error: lastError };
    }
    const keys = shop.getSebpayKeys();
    if (!keys.publicKey || !keys.secretKey) {
      lastError = "Clés API SebPay non configurées (voir Boutique → Paiement).";
      lastErrorAt = new Date().toISOString();
      return { ok: false, error: lastError };
    }
    checkoutUrl = `${config.PUBLIC_URL}/pay-sebpay.html?ref=${ref}`;
  } else {
    checkoutUrl = shop.getPayLink('strategy') || shop.getPayLink('ia_93') || shop.getPayLink('ia_100');
    if (!checkoutUrl) {
      lastError = "Aucun lien de paiement n'est configuré (voir Boutique → Paiement en ligne).";
      lastErrorAt = new Date().toISOString();
      return { ok: false, error: lastError };
    }
  }
  const name = buyerName || `Client Telegram ${userId}`;
  const expiresAt = Date.now() + LOCK_MS;

  const record = {
    ref,
    kind: 'support',
    provider,
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
  return { ok: true, checkoutUrl, ref, provider };
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
  // CORRECTIF SebPay : contrairement à Money Fusion (lien de succès FIXE,
  // atteint côté Fusion uniquement après paiement réellement validé), la
  // simple arrivée sur la page ne prouve RIEN pour SebPay — seul le webhook
  // signé (voir confirmSebpayPayment ci-dessous, déclenché depuis
  // server.js) peut confirmer un paiement SebPay. On renvoie juste l'état
  // courant, que succes.html continue de sonder normalement en attendant.
  if (record.provider === 'sebpay') return record;
  if (record.status === 'pending') await markPaid(record);
  return getRecord(ref);
}

// ---------------------------------------------------------------------------
// Recherche (SANS marquer payé) de la réservation la plus récente pour un ID
// Telegram donné — utilisée par succes.html pour reconstruire l'URL
// classique (?ref=...&uid=...&fn=...&ln=...) à partir du seul ID Telegram
// saisi par le client, puisque le lien de succès Money Fusion est fixe et ne
// transmet pas de ref. La confirmation réelle du paiement a lieu ensuite,
// comme d'habitude, au clic sur « Voir mon code » (voir markPaidOnArrival).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Réservation ACTIVE en ce moment — utilisée par succes.html à l'arrivée
// (sans ref dans l'URL, car le lien de succès Money Fusion est fixe) pour
// retrouver automatiquement QUI est en train de payer, sans rien lui faire
// saisir : grâce au verrou global (une seule personne peut payer un article
// à la fois, voir lockItem/getLock plus haut), il n'y a jamais d'ambiguïté
// pendant les 3 minutes qui suivent le clic sur « Payer » dans le bot.
// Si aucun verrou d'article n'est actif (ex. don de soutien, non verrouillé),
// on retombe sur la réservation « pending » la plus récente tout court.
// ---------------------------------------------------------------------------
function currentActiveRecord() {
  const lock = getLock();
  if (lock) {
    const forLock = [...records.values()]
      .filter((r) => r.status === 'pending' && r.userId === lock.userId && r.itemId === lock.itemId)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (forLock[0]) return forLock[0];
  }
  const anyPending = [...records.values()]
    .filter((r) => r.status === 'pending')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return anyPending[0] || null;
}

function findActiveRecordByUserId(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  const candidates = [...records.values()]
    .filter((r) => r.userId === uid && r.status !== 'failed' && r.status !== 'expired')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return candidates[0] || null;
}

function cancelPayment(ref) {
  const record = getRecord(ref);
  if (!record) return { ok: false, error: 'Paiement introuvable.' };
  markFailed(record);
  return { ok: true, record: getRecord(ref) };
}

// ---------------------------------------------------------------------------
// Confirmation MANUELLE par ID Telegram — utilisée depuis succes.html quand
// la page est atteinte SANS référence. C'est le cas normal ici : le lien de
// succès collé sur le compte Money Fusion est un lien FIXE, unique pour tout
// le site, qui ne peut pas transporter un ?ref=... propre à chaque
// transaction. Le client colle donc son ID Telegram sur succes.html ; on
// retrouve sa réservation la plus récente (encore active) et on la confirme
// exactement comme le ferait markPaidOnArrival avec un ref connu.
// ---------------------------------------------------------------------------
async function confirmByUserId(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'ID Telegram manquant.' };
  const candidates = [...records.values()]
    .filter((r) => r.userId === uid && r.status !== 'failed')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const record = candidates[0];
  if (!record) {
    return { ok: false, error: "Aucun paiement en cours trouvé pour cet ID Telegram. Lance d'abord un paiement depuis le bot Telegram." };
  }
  const updated = await markPaidOnArrival(record.ref);
  if (!updated) return { ok: false, error: 'Paiement introuvable.' };
  if (updated.status === 'expired') {
    return { ok: false, error: 'Ta réservation a expiré. Relance un paiement depuis le bot Telegram.' };
  }
  return { ok: true, record: updated };
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

// ---------------------------------------------------------------------------
// SebPay — appelées uniquement depuis server.js (voir routes /api/sebpay/*).
// ---------------------------------------------------------------------------

// Après l'appel réussi à sebpay.createCollection() (voir
// public/pay-sebpay.html → POST /api/sebpay/collect/:ref, server.js) : trace
// la transaction sur l'enregistrement, à titre informatif (affiché dans le
// panneau admin Boutique → Paiement) — n'affecte pas le statut, seul le
// webhook confirme réellement.
function attachSebpayTransaction(ref, { transactionId, phone, operator, providerLink } = {}) {
  const record = records.get(ref);
  if (!record) return null;
  record.sebpayTransactionId = transactionId || null;
  record.sebpayPhone = phone || null;
  record.sebpayOperator = operator || null;
  record.sebpayProviderLink = providerLink || null; // ex. lien de redirection Wave
  record.updatedAt = new Date().toISOString();
  persist();
  return record;
}

// Confirmation RÉELLE d'un paiement SebPay — déclenchée UNIQUEMENT par le
// webhook SebPay une fois sa signature HMAC vérifiée (voir
// sebpay.verifyWebhookSignature et server.js — POST /api/sebpay/webhook).
// C'est ICI, et seulement ici, que le code de la stratégie est attaché pour
// un paiement SebPay — jamais par un minuteur aveugle comme pour Money
// Fusion (voir bot.js, purchase flow). `status === 'pending'` protège contre
// un double webhook (SebPay peut renvoyer la même notification plusieurs
// fois — voir doc « idempotence »).
async function confirmSebpayPayment(ref) {
  const record = getRecord(ref);
  if (!record || record.provider !== 'sebpay') return null;
  if (record.status !== 'pending') return record; // déjà traité : jamais retraité deux fois
  if (record.kind === 'item' && record.itemId) {
    const item = shop.getItem(record.itemId);
    if (item) record.code = item.code;
  }
  await markPaid(record);
  return getRecord(ref);
}

function failSebpayPayment(ref) {
  const record = getRecord(ref);
  if (!record || record.provider !== 'sebpay') return null;
  markFailed(record);
  return getRecord(ref);
}

module.exports = {
  loadFromDb, setPaidHandler, setExpiredHandler, configured, getConfig,
  initiatePayment, initiateSupportPayment, getRecord, listPending, markPaidOnArrival, cancelPayment, attachCode,
  lockItem, getLock, unlockItem, expireAfterCopy, confirmByUserId, findActiveRecordByUserId, currentActiveRecord,
  attachSebpayTransaction, confirmSebpayPayment, failSebpayPayment,
};
