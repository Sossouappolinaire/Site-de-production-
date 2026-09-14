// sebpay.js — client de l'API SebPay (https://sebpay.bj), second fournisseur
// de paiement Mobile Money au choix de l'admin, à côté de Money Fusion (voir
// shop.js/getPaymentProvider et paiement.js). Doc technique lue directement
// sur https://new.sebpay.bj/fr/docs (authentification, collections,
// webhooks, otp, payout, status-codes, tarifs).
//
// Authentification : deux en-têtes sur chaque requête — X-Public-Key
// (pk_live_/pk_test_) et X-Secret-Key (sk_live_/sk_test_), saisies par
// l'admin depuis le panneau Boutique → Paiement (voir shop.js) et jamais
// codées en dur ici.
const crypto = require('crypto');
const config = require('./config');
const shop = require('./shop');

function apiUrl(path) {
  return `${config.SEBPAY_API_URL}${path}`;
}

function headers() {
  const keys = shop.getSebpayKeys();
  return {
    'Content-Type': 'application/json',
    'X-Public-Key': keys.publicKey || '',
    'X-Secret-Key': keys.secretKey || '',
  };
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, error: `Réseau SebPay indisponible : ${e.message}` };
  }
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok || !data || data.success === false) {
    const msg = (data && (data.message || data.error)) || `Erreur SebPay (HTTP ${res.status})`;
    return { ok: false, status: res.status, error: msg, data };
  }
  return { ok: true, status: res.status, data: data.data !== undefined ? data.data : data };
}

// Crée un encaissement (demande de paiement Mobile Money) — voir
// https://new.sebpay.bj/fr/docs/collections. `otpCode` est optionnel, requis
// seulement pour certains opérateurs (voir getOperators ci-dessous).
async function createCollection({ amount, currency, phone, operator, country, externalReference, callbackUrl, otpCode }) {
  const body = {
    amount,
    currency: currency || 'XOF',
    phone,
    operator,
    country: country || 'BJ',
    external_reference: externalReference,
  };
  if (callbackUrl) body.callback_url = callbackUrl;
  if (otpCode) body.otp_code = otpCode;
  return call('POST', '/api/v1/collections', body);
}

// Relit le statut d'un encaissement (id SebPay OU external_reference) —
// utile en secours si le webhook n'est jamais arrivé.
async function getCollection(idOrReference) {
  return call('GET', `/api/v1/collections/${encodeURIComponent(idOrReference)}`);
}

// Liste des opérateurs disponibles pour un pays, avec `otp_required` par
// opérateur (ex. Orange CI/BF/SN) — voir https://new.sebpay.bj/fr/docs/otp.
async function getOperators(country) {
  return call('GET', `/api/v1/operators?country=${encodeURIComponent(country || 'BJ')}`);
}

// Frais estimés pour un montant/corridor donné — voir
// https://new.sebpay.bj/fr/docs/tarifs. Affiché à titre indicatif à l'admin
// uniquement ; le montant réellement débité au client reste `amount`.
async function calculateFee({ amount, sourceCountry, destinationCountry, transactionType }) {
  const qs = new URLSearchParams({
    amount: String(amount),
    source_country: sourceCountry || 'bj',
    destination_country: destinationCountry || sourceCountry || 'bj',
    transaction_type: transactionType || 'collection',
  });
  return call('GET', `/api/v1/c/calculate-fee?${qs.toString()}`);
}

// Vérifie la signature HMAC-SHA256 d'un webhook entrant (en-tête
// X-SebPay-Signature, calculée par SebPay avec LA MÊME clé secrète que
// celle utilisée pour authentifier nos requêtes) — voir
// https://new.sebpay.bj/fr/docs/webhooks. `rawBody` doit être la chaîne
// brute reçue (avant tout JSON.parse), sans quoi la signature ne correspond
// jamais (express.json() garde le corps parsé — voir server.js, qui doit
// donc conserver le brut via express.raw() ou un verify() dédié sur cette
// route précise).
function verifyWebhookSignature(rawBody, signatureHeader) {
  const keys = shop.getSebpayKeys();
  if (!keys.secretKey || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', keys.secretKey).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signatureHeader), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { createCollection, getCollection, getOperators, calculateFee, verifyWebhookSignature };
