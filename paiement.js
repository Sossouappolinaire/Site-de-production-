// paiement.js — Paiement en ligne (FusionPay / Money Fusion, moneyfusion.net)
// pour la boutique de stratégies (shop.js). Quand l'acheteur tape sur le
// bouton « 💳 Payer », on crée un lien de paiement FusionPay et on l'envoie
// comme bouton URL dans Telegram. Une fois payé, FusionPay appelle notre
// webhook côté serveur (confirmation fiable, indépendante du navigateur) :
// on débloque alors automatiquement la stratégie, on envoie le code au
// client directement dans Telegram, et la page succes.html (vers laquelle
// FusionPay redirige le navigateur) affiche ce même code avec un bouton
// « copier ».
//
// Conforme à la documentation officielle FusionPay (API Web) :
// - initiation : POST sur l'URL d'API fournie par le tableau de bord
//   (une seule URL complète, propre à chaque application créée) ;
// - `article` est un tableau contenant UN SEUL objet {nom: prix} ;
// - la réponse d'initiation est { statut, token, message, url } ;
// - le statut peut être vérifié via GET
//   https://www.pay.moneyfusion.net/paiementNotif/{token} ;
// - le webhook envoie { event, personal_Info, tokenPay, ... } avec
//   event = payin.session.pending | payin.session.completed | payin.session.cancelled,
//   et peut être envoyé PLUSIEURS FOIS pour la même transaction (voir
//   handleWebhook ci-dessous, qui ignore les notifications déjà traitées).
'use strict';

const crypto = require('crypto');
const store = require('./store');
const db = require('./db');

const STATUS_CHECK_BASE = 'https://www.pay.moneyfusion.net/paiementNotif';

// URL d'API FusionPay/Money Fusion — en dur (aucune variable Render requise),
// comme les autres services de config.js. Réglable sans toucher au code via
// FUSIONPAY_API_URL ou le panneau Boutique → Paiement (setConfig ci-dessous).
const DEFAULT_FUSIONPAY_API_URL = 'https://pay.moneyfusion.net/Paiements_m/7da7654df194be93/pay/';

const cfg = {
  apiUrl: process.env.FUSIONPAY_API_URL || DEFAULT_FUSIONPAY_API_URL,
  publicBaseUrl: '',  // URL publique de CE serveur (ex. https://mon-bot.onrender.com) — sert à construire return_url / webhook_url
  webhookSecret: '',
};

const records = new Map(); // ref -> { ref, tokenPay, itemId, userId, chatId, lang, status, code, createdAt, updatedAt }

let paidHandler = null; // enregistrée par bot.js : async (record) => {} — envoie le code au client sur Telegram
let lastError = null;
let lastErrorAt = null;

(function loadInitial() {
  try {
    const saved = store.read().paiement;
    if (saved && typeof saved === 'object') {
      const savedCfg = { ...(saved.cfg || {}) };
      // une ancienne sauvegarde avec apiUrl vide ne doit pas écraser la
      // valeur en dur ci-dessus (ex. avant que ce correctif n'existe).
      if (!savedCfg.apiUrl) delete savedCfg.apiUrl;
      Object.assign(cfg, savedCfg);
      if (Array.isArray(saved.records)) {
        for (const r of saved.records) if (r && r.ref) records.set(r.ref, r);
      }
    }
  } catch (_) { /* ignore */ }
  if (!cfg.webhookSecret) cfg.webhookSecret = crypto.randomBytes(16).toString('hex');
})();

function persist() {
  // on ne garde que les 500 derniers enregistrements (transactions récentes) —
  // pas besoin d'un historique illimité, juste de quoi retrouver un paiement
  // récent (webhook en retard, page succes.html rechargée, etc.).
  const recent = [...records.values()]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 500);
  records.clear();
  for (const r of recent) records.set(r.ref, r);
  store.patch({ paiement: { cfg, records: recent } });
  if (db.ready) db.setSetting('paiement_data', JSON.stringify({ cfg, records: recent })).catch(() => {});
}

async function loadFromDb() {
  if (!db.ready) return false;
  try {
    const raw = await db.getSetting('paiement_data');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed.cfg) {
      const dbCfg = { ...parsed.cfg };
      if (!dbCfg.apiUrl) delete dbCfg.apiUrl; // idem loadInitial() : ne pas écraser la valeur en dur
      Object.assign(cfg, dbCfg);
    }
    if (Array.isArray(parsed.records)) {
      for (const r of parsed.records) if (r && r.ref && !records.has(r.ref)) records.set(r.ref, r);
    }
    return true;
  } catch (_) { return false; }
}

function setPaidHandler(fn) { paidHandler = fn; }

function configured() { return !!(cfg.apiUrl && cfg.publicBaseUrl); }

function getConfig() {
  return {
    apiUrl: cfg.apiUrl,
    publicBaseUrl: cfg.publicBaseUrl,
    configured: configured(),
    // dernière erreur d'initiation de paiement rencontrée (voir
    // initiatePayment ci-dessous) : avant, seul un console.error côté
    // serveur signalait un échec (ex. mauvaise URL d'API FusionPay, réponse
    // invalide) — invisible pour l'admin, qui ne voyait que le client
    // recevoir le message « envoie le code » à la place du bouton Payer.
    lastError,
    lastErrorAt,
  };
}

function setConfig({ apiUrl, publicBaseUrl } = {}) {
  if (apiUrl != null) cfg.apiUrl = String(apiUrl).trim();
  if (publicBaseUrl != null) cfg.publicBaseUrl = String(publicBaseUrl).trim().replace(/\/+$/, '');
  persist();
  return getConfig();
}

function shortRef() { return `pay_${crypto.randomBytes(6).toString('hex')}`; }

// ---------------------------------------------------------------------------
// Création d'un lien de paiement pour un article de la boutique (stratégie
// ou déclencheur IA). Retourne { ok, checkoutUrl, ref } ou { ok:false, error }.
// ---------------------------------------------------------------------------
async function initiatePayment({ item, userId, chatId, lang, buyerName, buyerPhone } = {}) {
  if (!configured()) {
    lastError = "Paiement non configuré (URL d'API / URL publique manquantes — voir Boutique → Paiement).";
    lastErrorAt = new Date().toISOString();
    return { ok: false, error: lastError };
  }
  if (!item || !Number.isFinite(item.price) || item.price <= 0) {
    lastError = 'Cette stratégie n\'a pas de prix valide (voir Boutique → cet article → Prix).';
    lastErrorAt = new Date().toISOString();
    return { ok: false, error: lastError };
  }

  const ref = shortRef();
  const record = {
    ref,
    tokenPay: null,
    itemId: item.id,
    userId: String(userId),
    chatId: String(chatId),
    lang: lang || 'fr',
    amount: item.price,
    status: 'pending',
    code: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // `article` : tableau contenant UN SEUL objet { "nom de l'article": prix }
  // (format exact documenté par FusionPay — pas un tableau d'objets {nom,montant}).
  const article = {};
  article[item.aiName] = item.price;

  const payload = {
    totalPrice: item.price,
    article: [article],
    personal_Info: [{ ref, itemId: item.id, userId: String(userId) }],
    numeroSend: buyerPhone || '',
    nomclient: buyerName || `Client Telegram ${userId}`,
    return_url: `${cfg.publicBaseUrl}/succes.html?ref=${ref}`,
    webhook_url: `${cfg.publicBaseUrl}/api/paiement/webhook?key=${cfg.webhookSecret}`,
  };

  try {
    const res = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      lastError = `Réponse invalide de FusionPay (HTTP ${res.status}).`;
      lastErrorAt = new Date().toISOString();
      return { ok: false, error: lastError };
    }
    // Réponse documentée : { statut: true, token, message, url }
    if (!data.statut || !data.url) {
      lastError = data.message || 'FusionPay n\'a renvoyé aucun lien de paiement.';
      lastErrorAt = new Date().toISOString();
      return { ok: false, error: lastError };
    }

    record.tokenPay = data.token || null;
    records.set(ref, record);
    persist();
    return { ok: true, checkoutUrl: data.url, ref };
  } catch (e) {
    lastError = e.message;
    lastErrorAt = new Date().toISOString();
    return { ok: false, error: lastError };
  }
}

function getRecord(ref) { return records.get(ref) || null; }

function findRecordByTokenOrRef({ ref, tokenPay } = {}) {
  if (ref && records.has(ref)) return records.get(ref);
  if (tokenPay) return [...records.values()].find((r) => r.tokenPay === tokenPay) || null;
  return null;
}

// Interroge directement FusionPay pour l'état d'un paiement (GET
// paiementNotif/{token}) — utilisée en secours si le webhook n'est jamais
// arrivé (voir reconcile ci-dessous), pas comme mécanisme principal.
async function checkPaymentStatus(token) {
  try {
    const res = await fetch(`${STATUS_CHECK_BASE}/${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return null;
    return data.data || null; // { tokenPay, statut: 'paid'|'pending'|'failure'|'no paid', ... }
  } catch (_) { return null; }
}

// Marque une transaction payée et déclenche le handler (déblocage + envoi
// Telegram) — appelée par le webhook ET par reconcile(), avec protection
// contre un double traitement (FusionPay peut renvoyer plusieurs fois la
// même notification, voir la doc « Gestion des notifications multiples »).
async function markPaid(record) {
  if (record.status === 'paid') return; // déjà traité, on ignore (notification redondante)
  record.status = 'paid';
  record.updatedAt = new Date().toISOString();
  persist();
  if (paidHandler) {
    try { await paidHandler(record); } catch (e) { console.error('Paiement (handler) :', e.message); }
  }
}

function markFailed(record) {
  if (record.status === 'paid') return; // un paiement déjà confirmé n'est jamais rétrogradé
  record.status = 'failed';
  record.updatedAt = new Date().toISOString();
  persist();
}

// Le montant confirmé par FusionPay doit correspondre à ce qui a été demandé
// à l'initiation (record.amount = item.price au moment de l'achat). Une
// petite tolérance (1 centime) absorbe les arrondis flottants ; en dessous,
// la notification est jugée suspecte et n'est PAS traitée comme un paiement
// valide — mieux vaut un paiement à réconcilier manuellement qu'un
// déblocage sur un montant insuffisant.
const AMOUNT_TOLERANCE = 0.01;
function amountMatches(record, data) {
  const paidAmount = Number(data.Montant);
  if (!Number.isFinite(paidAmount)) return true; // champ absent/illisible : on ne bloque pas sur une donnée qu'on ne sait pas lire
  if (!Number.isFinite(record.amount)) return true; // rien à comparer côté enregistrement
  return paidAmount >= record.amount - AMOUNT_TOLERANCE;
}

// ---------------------------------------------------------------------------
// Webhook FusionPay (« Suivi des Transactions en Temps Réel ») : appelé côté
// serveur par FusionPay lui-même, pas par le navigateur du client — c'est la
// source de vérité, plus fiable que la redirection navigateur (return_url),
// qui peut être fermée avant la fin.
//
// Structure reçue : { event, personal_Info, tokenPay, numeroSend, nomclient,
// numeroTransaction, Montant, frais, return_url, webhook_url, createdAt }
// event ∈ { payin.session.pending, payin.session.completed, payin.session.cancelled }
// ---------------------------------------------------------------------------
async function handleWebhook(query, body) {
  if (!cfg.webhookSecret || query.key !== cfg.webhookSecret) {
    return { ok: false, status: 401, error: 'Clé de webhook invalide.' };
  }
  const data = body || {};
  const personal = Array.isArray(data.personal_Info) ? data.personal_Info[0] : (data.personal_Info || {});
  const ref = personal && personal.ref;
  const tokenPay = data.tokenPay || null;
  const record = findRecordByTokenOrRef({ ref, tokenPay });
  if (!record) return { ok: false, status: 404, error: 'Paiement introuvable (ref/tokenPay inconnu).' };
  if (tokenPay && !record.tokenPay) record.tokenPay = tokenPay; // au cas où l'init n'avait pas encore reçu le token

  const event = String(data.event || '').toLowerCase();
  if (event === 'payin.session.completed') {
    if (!amountMatches(record, data)) {
      record.status = 'amount_mismatch';
      record.expectedAmount = record.amount;
      record.paidAmount = Number(data.Montant);
      record.updatedAt = new Date().toISOString();
      persist();
      console.error(
        `Paiement (montant incohérent) : ref=${record.ref} attendu=${record.amount} reçu=${data.Montant}`
      );
      return { ok: false, status: 409, error: 'Montant payé différent du montant attendu — non débloqué automatiquement.' };
    }
    await markPaid(record);
  } else if (event === 'payin.session.cancelled') {
    markFailed(record);
  }
  // payin.session.pending (ou événement inconnu) : simple accusé de réception,
  // on ne change rien tant que le paiement n'est pas confirmé ou annulé.
  return { ok: true, status: 200 };
}

// Filet de sécurité : si succes.html interroge un paiement encore « pending »
// après un moment, on redemande nous-mêmes l'état à FusionPay au cas où le
// webhook se serait perdu (réseau, redémarrage du serveur pendant l'appel...).
async function reconcile(ref) {
  const record = getRecord(ref);
  if (!record || record.status !== 'pending' || !record.tokenPay) return record;
  const data = await checkPaymentStatus(record.tokenPay);
  if (data && data.statut === 'paid') {
    if (amountMatches(record, data)) {
      await markPaid(record);
    } else {
      record.status = 'amount_mismatch';
      record.expectedAmount = record.amount;
      record.paidAmount = Number(data.Montant);
      record.updatedAt = new Date().toISOString();
      persist();
      console.error(
        `Paiement (montant incohérent, reconcile) : ref=${record.ref} attendu=${record.amount} reçu=${data.Montant}`
      );
    }
  } else if (data && (data.statut === 'failure' || data.statut === 'no paid')) markFailed(record);
  return getRecord(ref);
}

// Enregistre le code débloqué (appelé par le gestionnaire dans bot.js après
// shop.redeem) pour que succes.html puisse l'afficher.
function attachCode(ref, code) {
  const record = records.get(ref);
  if (!record) return;
  record.code = code;
  record.updatedAt = new Date().toISOString();
  persist();
}

module.exports = {
  loadFromDb, setPaidHandler, configured, getConfig, setConfig,
  initiatePayment, getRecord, handleWebhook, reconcile, attachCode,
};
