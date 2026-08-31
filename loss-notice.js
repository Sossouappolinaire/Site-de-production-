// loss-notice.js — message automatique envoyé dans le MÊME canal qu'une
// prédiction dès qu'elle se solde par une perte (❌) — pour TOUTE stratégie,
// existante comme « Prédit IA » (voir bot.js/updateResult et
// predit.js/update, les deux seuls points d'appel). Prévient les abonnés et
// les renvoie vers l'administrateur pour être remboursés, avec un rappel de
// la formation VIP sur comment jouer avec ce bot. Le texte est entièrement
// réglable depuis le panneau admin (Système → Message de perte), jamais codé
// en dur côté appelant.
'use strict';

const store = require('./store');
const db = require('./db');

const DEFAULT_MESSAGE =
  '❌ Une perte a été enregistrée sur cette prédiction.\n' +
  "Écrivez à l'administrateur pour être remboursé(e).";
const DEFAULT_VIP_TEXT =
  '📘 Pensez à suivre la formation VIP pour apprendre à bien jouer avec ce bot.';

const settings = {
  enabled: true,
  message: DEFAULT_MESSAGE,
  vipText: DEFAULT_VIP_TEXT,
  vipLink: '', // optionnel : lien vers le canal/le contenu de la formation VIP
};

function load() {
  try {
    const saved = store.read();
    if (saved && saved.lossNotice) Object.assign(settings, saved.lossNotice);
  } catch (_) { /* aucune sauvegarde locale encore : valeurs par défaut conservées */ }
}
load();

// relit depuis la base au démarrage/à la reconnexion (voir bot.js —
// mêmes points d'appel que pour les autres réglages persistés en base).
async function loadFromDb() {
  if (!db.ready) return;
  try {
    const raw = await db.getSetting('loss_notice');
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch (_) { /* rien en base pour l'instant : valeurs actuelles conservées */ }
}

function persist() {
  store.patch({ lossNotice: settings });
  if (db.ready) db.setSetting('loss_notice', JSON.stringify(settings)).catch(() => {});
}

function getSettings() {
  return { ...settings };
}

function setSettings(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('Réglages invalides.');
  if (patch.enabled !== undefined) settings.enabled = !!patch.enabled;
  if (patch.message !== undefined) settings.message = String(patch.message || '').trim() || DEFAULT_MESSAGE;
  if (patch.vipText !== undefined) settings.vipText = String(patch.vipText || '').trim();
  if (patch.vipLink !== undefined) settings.vipLink = String(patch.vipLink || '').trim();
  persist();
  return getSettings();
}

// Texte final envoyé — message de perte, puis rappel VIP et/ou lien si
// renseignés (chaque partie omise si vide, jamais de ligne creuse).
function buildText() {
  const parts = [settings.message];
  if (settings.vipText) parts.push(settings.vipText);
  if (settings.vipLink) parts.push(settings.vipLink);
  return parts.join('\n\n');
}

module.exports = { getSettings, setSettings, buildText, loadFromDb, DEFAULT_MESSAGE, DEFAULT_VIP_TEXT };
