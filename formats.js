// formats.js — adaptateur entre le moteur du bot et les 107 formats de tg-formats.js (8 à 86 : tg-formats-uniques.js)
// Rôle :
//   • normaliser le costume ('♦️' -> '♦') pour que les noms FR soient trouvés
//   • nettoyer le texte (plus jamais de "\n" ou de "'n" visibles dans Telegram)
//   • fournir la liste / l'aperçu des 77 styles de prédiction
'use strict';

const tg = require('./tg-formats');
const animator = require('./status-animator');

const FORMAT_COUNT = 107;  // 107 = TRADING FOR BACCARA · 90-91 = ÉTOILE/ÉCLAIR BACCARA · 92-101 = 10 formats proposés (ChatGPT) · 102-106 = « Il y aura distribution 2/2 » (5 formats simples)

// costumes utilisés par le moteur (avec sélecteur emoji) -> clés de tg-formats
function normalizeSuit(suit) {
  if (!suit) return suit;
  const raw = String(suit).replace(/\uFE0F/g, '').trim();
  if (raw === '❤' || raw === '♥') return '♥';
  return raw;
}

// supprime les retours à la ligne écrits en texte ("\n", "'n") et les espaces morts
function sanitize(text) {
  return String(text == null ? '' : text)
    .replace(/\\r\\n|\\n|\\r/g, '\n')   // "\n" littéral
    .replace(/'n/g, '\n')               // artefact "'n"
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clampFormat(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(FORMAT_COUNT, n));
}

// statuts internes ('en attente' / 'gagné' / 'perdu') -> statuts tg-formats
function mapStatus(status) {
  if (status === 'gagné' || status === 'gagne' || status === 'win') return 'gagne';
  if (status === 'perdu' || status === 'perdue' || status === 'loss') return 'perdu';
  return null;
}

// Registre des derniers messages rendus (texte final → formats + données de la prédiction).
// Sert à channel-uniform.js : au point d'envoi, le message est retrouvé ici pour être re-rendu dans le format imposé au canal,
// sans jamais « deviner » le contenu en lisant le texte.
const RECENT_MAX = 400;
const recent = new Map();
function recordRendered(text, formatId, payload, parseMode) {
  if (!text || text.length < 6) return;
  recent.delete(text);
  recent.set(text, { formatId, payload: { ...payload }, parse_mode: parseMode || null });
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
}
// exact : le texte est exactement un message rendu ; sinon on cherche un message rendu CONTENU dans un texte plus long (décor autour)
function locateRendered(text) {
  if (typeof text !== 'string' || !text) return null;
  const rec = recent.get(text);
  if (rec) return { rec, key: text, exact: true };
  let found = null;
  for (const [k, v] of recent) if (k.length >= 12 && text.includes(k) && (!found || k.length > found.key.length)) found = { rec: v, key: k, exact: false };
  return found;
}

/**
 * renderMessage — construit le message Telegram final.
 * @returns {{text: string, parse_mode: (string|null)}}
 */
function renderMessage(formatId, data = {}, template = null, opts = {}) {
  const payload = {
    gameNumber: data.gameNumber != null ? data.gameNumber : data.num,
    suit: normalizeSuit(data.suit),
    strategy: data.strategy || 'costume',
    maxR: data.maxR != null ? data.maxR : 2,
    status: mapStatus(data.status),
    rattrapage: data.rattrapage != null ? data.rattrapage : data.r || 0,
    hand: 'joueur',                       // le projet ne suit que la main du joueur
    cardsLabel: data.cardsLabel || null,
    playerCards: data.playerCards || null,
    bankerCards: null,
  };
  let out;
  try {
    out = tg.buildTgMessage(clampFormat(formatId), payload, template || null);
  } catch (e) {
    out = { text: `🎯 #N${payload.gameNumber} ${tg.getSuitEmoji(payload.suit)} +${payload.maxR}`, parse_mode: null };
  }
  const raw = sanitize(out && out.text ? out.text : out);
  const result = finalize(raw, out && out.parse_mode);
  if (!(opts && (opts.noRecord || opts.noAnimate))) { // les aperçus (noAnimate) ne saturent pas le registre
    try { recordRendered(result.text, clampFormat(formatId), payload, result.parse_mode); } catch (_) { /* registre seulement */ } }
  // message de prédiction « en cours » : signalé à l'animateur de statut
  // (status-animator.js) qui l'animera dès son envoi. Aperçus : noAnimate.
  if (payload.status === null && !(opts && opts.noAnimate)) animator.registerPending(result.text);
  return result;
}

const HTML_TAG = /<\/?(b|i|u|s|strong|em|code|pre|a)\b[^>]*>/i;

// Certains styles contiennent du gras HTML ou Markdown : on choisit le bon
// parse_mode pour que Telegram affiche le style au lieu des balises brutes.
function finalize(text, parseMode) {
  if (parseMode) return { text, parse_mode: parseMode };
  if (HTML_TAG.test(text)) return { text, parse_mode: 'HTML' };
  if (/\*[^*\n]+\*|_[^_\n]+_/.test(text)) {
    const html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
      .replace(/_([^_\n]+)_/g, '<i>$1</i>');
    return { text: html, parse_mode: 'HTML' };
  }
  return { text, parse_mode: null };
}

// aperçu complet d'un style, avec des données d'exemple
function formatPreview(id, opts = {}) {
  const parityFormat = id >= 80 && id <= 83;
  const shadowFormat = id >= 84 && id <= 86;
  const out = renderMessage(id, {
    cardsLabel: opts.cardsLabel || (id === 79 ? '2/2' : id === 78 ? '3/3' : null),
    gameNumber: opts.gameNumber || 1234,
    suit: opts.suit || (parityFormat ? 'impair' : shadowFormat ? '❤️' : '♦️'),
    maxR: opts.maxR != null ? opts.maxR : 2,
    status: opts.status !== undefined ? opts.status : null,
    rattrapage: opts.rattrapage || 0,
  }, null, { noAnimate: true });
  // aperçu lisible : on retire les balises HTML
  return out.text.replace(/<\/?[a-z][^>]*>/gi, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// liste compacte : "n — première ligne de l'aperçu"
function formatList(page = 1, perPage = FORMAT_COUNT) {
  const total = Math.ceil(FORMAT_COUNT / perPage);
  const p = Math.max(1, Math.min(total, parseInt(page, 10) || 1));
  const start = (p - 1) * perPage + 1;
  const lines = [];
  for (let i = start; i < start + perPage && i <= FORMAT_COUNT; i++) {
    const first = formatPreview(i).split('\n').filter(Boolean)[0] || '';
    lines.push(`${String(i).padStart(2, ' ')} — ${first.slice(0, 60)}`);
  }
  return { page: p, pages: total, text: lines.join('\n') };
}

// tous les styles sous forme de tableau (utilisé par le panel web)
function formatCatalog() {
  const out = [];
  for (let i = 1; i <= FORMAT_COUNT; i++) {
    const full = formatPreview(i);
    out.push({ id: i, label: (full.split('\n').filter(Boolean)[0] || '').slice(0, 60), preview: full });
  }
  return out;
}

module.exports = {
  FORMAT_COUNT,
  locateRendered,
  normalizeSuit,
  sanitize,
  clampFormat,
  mapStatus,
  renderMessage,
  formatPreview,
  formatList,
  formatCatalog,
  getSuitEmoji: tg.getSuitEmoji,
  getSuitName: tg.getSuitName,
};
