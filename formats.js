// formats.js — adaptateur entre le moteur du bot et les 77 formats de tg-formats.js
// Rôle :
//   • normaliser le costume ('♦️' -> '♦') pour que les noms FR soient trouvés
//   • nettoyer le texte (plus jamais de "\n" ou de "'n" visibles dans Telegram)
//   • fournir la liste / l'aperçu des 77 styles de prédiction
'use strict';

const tg = require('./tg-formats');

const FORMAT_COUNT = 89;   // 89 = format ROYAL CLUB (Jeu · costume · Dogon · Résultat)

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

/**
 * renderMessage — construit le message Telegram final.
 * @returns {{text: string, parse_mode: (string|null)}}
 */
function renderMessage(formatId, data = {}, template = null) {
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
  return finalize(raw, out && out.parse_mode);
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
  });
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
