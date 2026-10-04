// dizaine-top.js — stratégie « Dizaine — costume le plus / le moins sorti »
// (demande admin). Même découpage que la stratégie « Comptage par dizaine »
// (strategies.js/dizaine) : le sabot est coupé en tranches de 10 jeux
// (#N1-10, #N11-20, #N21-30…), et le comptage se fait sur la main du JOUEUR
// (comptage « vote » : un costume compte 1 seule fois par main).
//
// DIFFÉRENCES avec la stratégie « dizaine » :
//   • on peut choisir le costume le PLUS sorti (1er, 2e, 3e ou 4e du
//     classement) OU le costume le MOINS sorti (1er, 2e, 3e ou 4e), au lieu
//     de toujours prendre le plus rare ;
//   • on crée des CONFIGURATIONS : chaque configuration est enregistrée avec
//     ses propres réglages (mode, rang, fin de numéro, nombre de
//     rattrapages, format de prédiction, canal) et on peut en créer autant
//     qu'on veut — elles tournent toutes en parallèle, indépendamment.
//
// Règle d'une configuration :
//   1. À la fin de chaque dizaine (#N10, #N20, #N30…), on compte les 4
//      costumes sur les 10 jeux qui viennent de se terminer (au moins 6 jeux
//      lisibles, sinon aucune prédiction pour cette dizaine).
//   2. On classe les costumes : « plus sorti » = du plus fréquent au moins
//      fréquent ; « moins sorti » = du plus rare au moins rare. En cas
//      d'égalité, ordre fixe ♦️ ❤️ ♣️ ♠️ (comme la stratégie « dizaine »).
//   3. On retient le costume au rang choisi (1er, 2e, 3e ou 4e).
//   4. La prédiction est envoyée sur le jeu « fin de numéro N » de la
//      dizaine SUIVANTE : fin de dizaine + N (ex. N = 4 : dizaine #N1-10 →
//      prédiction sur #N14 ; dizaine #N11-20 → #N24). N = 10 → #N20, #N30…
//   5. Vérification sur la main du JOUEUR, avec le nombre de rattrapages
//      configuré ; le message Telegram est édité avec le résultat.
'use strict';

const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const strategies = require('./strategies');
const { state, hasSuit, addSiteChannelMessage, siteChannelsView, setOnShoeReset } = require('./predictor');
const earlyVerify = require('./early-verify');

const SUITS = strategies.SUITS; // ['♦️', '❤️', '♣️', '♠️'] — ordre de départage des égalités
const MIN_READABLE = 6;

const panel = {
  enabled: true,
  trackers: [],
  pendingMessages: [],
  channelTitles: {},
  history: [],
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
};

let sender = null;
function setSender(fn) { sender = fn; }
let busy = false;

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------
function parseChannels(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n) && n !== 0 && !out.includes(n)) out.push(n);
    } else {
      const name = t.startsWith('@') ? t : `@${t.replace(/^https?:\/\/t\.me\//i, '')}`;
      if (name.length > 2 && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

function sanitizeSiteChannelId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = String(value).trim();
  return id ? id : null;
}

// « plus » = costume le PLUS sorti ; « moins » = costume le MOINS sorti
function sanitizeMode(value) { return value === 'moins' ? 'moins' : 'plus'; }
// rang dans le classement : 1 = premier, 2 = deuxième, 3 = troisième, 4 = quatrième
function sanitizeRank(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 1;
}
// « fin de numéro » : 1 à 10 jeux après la fin de la dizaine (10 → fin 0)
function sanitizeLead(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 4;
}
function sanitizeFormat(value) { return fmt.clampFormat(value); }
function sanitizeMaxR(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(9, n)) : 2;
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  persist();
  return config();
}
function config() { return { enabled: panel.enabled }; }

function maxFinishedGameNumber() {
  let max = 0;
  for (const g of state.games.values()) if (g.finished && g.number > max) max = g.number;
  return max;
}
function lastFinishedDecade() { return Math.floor(maxFinishedGameNumber() / 10) * 10; }

function modeLabel(mode, rank) {
  const nth = rank === 1 ? '1er' : `${rank}e`;
  return mode === 'moins' ? `${nth} costume le moins sorti` : `${nth} costume le plus sorti`;
}
function defaultName(t) { return `Dizaine ${modeLabel(t.mode, t.rank)} (fin ${t.lead % 10})`; }

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const saved = {
    config: config(), trackers: panel.trackers, history: panel.history,
    pendingMessages: panel.pendingMessages, sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt,
    channelTitles: panel.channelTitles,
  };
  try { store.patch({ dizaineTop: saved }); } catch (_) {}
  if (db.ready) db.setSetting('dizaine_top_state', JSON.stringify(saved)).catch((error) => { panel.lastError = error.message; });
}

function restore() {
  try {
    const saved = (store.read() || {}).dizaineTop;
    if (saved) applySaved(saved);
  } catch (_) {}
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('dizaine_top_state');
    if (raw) applySaved(JSON.parse(raw));
    else persist();
  } catch (_) { persist(); }
  return config();
}

function normalizeTracker(t) {
  const base = {
    id: t.id,
    mode: sanitizeMode(t.mode),
    rank: sanitizeRank(t.rank),
    lead: sanitizeLead(t.lead),
    enabled: t.enabled !== false,
    channels: Array.isArray(t.channels) ? parseChannels(t.channels) : [],
    siteChannelId: sanitizeSiteChannelId(t.siteChannelId),
    format: sanitizeFormat(t.format),
    maxR: sanitizeMaxR(t.maxR),
    // dernière dizaine déjà traitée (évite tout renvoi après redémarrage)
    lastDecade: Number.isFinite(Number(t.lastDecade)) ? Number(t.lastDecade) : 0,
    lastInfo: t.lastInfo || null,
    wins: Number.isFinite(Number(t.wins)) ? Number(t.wins) : 0,
    losses: Number.isFinite(Number(t.losses)) ? Number(t.losses) : 0,
    sentCount: Number.isFinite(Number(t.sentCount)) ? Number(t.sentCount) : 0,
    lastSentAt: t.lastSentAt || null,
    createdAt: t.createdAt || Date.now(),
  };
  base.name = (t.name && String(t.name).trim()) || defaultName(base);
  return base;
}

function applySaved(saved) {
  if (saved.channelTitles && typeof saved.channelTitles === 'object') panel.channelTitles = { ...saved.channelTitles };
  if (saved.config) panel.enabled = saved.config.enabled !== false;
  if (Array.isArray(saved.trackers)) panel.trackers = saved.trackers.filter((t) => t && t.id).map(normalizeTracker);
  // l'historique et les messages en attente ne sont jamais rejoués au démarrage
  panel.history = [];
  panel.pendingMessages = [];
  if (Number.isFinite(Number(saved.sentCount))) panel.sentCount = Number(saved.sentCount);
  panel.lastSentAt = saved.lastSentAt || null;
  panel.lastScanAt = saved.lastScanAt || null;
}

// ---------------------------------------------------------------------------
// Gestion des configurations
// ---------------------------------------------------------------------------
function addTracker(extra = {}) {
  const tracker = normalizeTracker({
    id: `dt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: extra.name,
    mode: extra.mode,
    rank: extra.rank,
    lead: extra.lead,
    channels: parseChannels(extra.channels),
    siteChannelId: extra.siteChannelId,
    format: extra.format,
    maxR: extra.maxR,
    // on ne rejoue pas la dizaine déjà terminée au moment de la création
    lastDecade: lastFinishedDecade(),
    createdAt: Date.now(),
  });
  if (!tracker.channels.length && !tracker.siteChannelId) {
    throw new Error('Renseigne au moins un canal (ID Telegram ou canal du site) pour cette configuration.');
  }
  panel.trackers.push(tracker);
  persist();
  return tracker;
}

function updateTracker(id, patch = {}) {
  const tracker = panel.trackers.find((t) => t.id === id);
  if (!tracker) return null;
  const next = { ...tracker };
  if (patch.mode !== undefined) next.mode = sanitizeMode(patch.mode);
  if (patch.rank !== undefined) next.rank = sanitizeRank(patch.rank);
  if (patch.lead !== undefined) next.lead = sanitizeLead(patch.lead);
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.channels !== undefined) next.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) next.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.format !== undefined) next.format = sanitizeFormat(patch.format);
  if (patch.maxR !== undefined) next.maxR = sanitizeMaxR(patch.maxR);
  if (patch.name !== undefined) {
    const clean = String(patch.name || '').trim();
    next.name = clean || defaultName(next);
  }
  if (!next.channels.length && !next.siteChannelId) {
    throw new Error('Renseigne au moins un canal (ID Telegram ou canal du site) pour cette configuration.');
  }
  Object.assign(tracker, next);
  persist();
  return tracker;
}

function removeTracker(id) {
  panel.trackers = panel.trackers.filter((t) => t.id !== id);
  persist();
  return true;
}

// ---------------------------------------------------------------------------
// Comptage d'une dizaine + choix du costume
// ---------------------------------------------------------------------------
function countDecade(end) {
  const start = end - 9;
  const counts = { '♦️': 0, '❤️': 0, '♣️': 0, '♠️': 0 };
  let readable = 0;
  for (let n = start; n <= end; n++) {
    const g = state.games.get(n);
    if (!g || !g.finished) continue;
    const suits = new Set(strategies.suitsOf(g.playerSuits)); // comptage « vote »
    if (!suits.size) continue;
    readable += 1;
    for (const s of suits) if (counts[s] !== undefined) counts[s] += 1;
  }
  return { start, end, counts, readable };
}

// classement complet des 4 costumes pour un mode donné (égalité : ordre fixe)
function rankSuits(counts, mode) {
  return SUITS
    .map((s, i) => ({ suit: s, count: counts[s], i }))
    .sort((a, b) => (mode === 'moins' ? (a.count - b.count) : (b.count - a.count)) || (a.i - b.i));
}

function pickSuit(counts, mode, rank) {
  const ranking = rankSuits(counts, mode);
  return ranking[rank - 1] ? ranking[rank - 1].suit : null;
}

// ---------------------------------------------------------------------------
// Boucle de traitement
// ---------------------------------------------------------------------------
async function processTracker(tracker) {
  if (!tracker.enabled) return;
  const maxDone = maxFinishedGameNumber();
  const end = Math.floor(maxDone / 10) * 10;
  // numéros qui repartent à la baisse = nouveau sabot : on repart de zéro
  if (end < tracker.lastDecade) tracker.lastDecade = 0;
  if (end < 10 || end <= tracker.lastDecade) return;
  const endGame = state.games.get(end);
  if (!endGame || !endGame.finished) {
    // le jeu de fin de dizaine n'a jamais été reçu terminé : on abandonne
    // cette dizaine si les jeux suivants sont déjà là.
    if (maxDone >= end + 3) tracker.lastDecade = end;
    return;
  }
  const { start, counts, readable } = countDecade(end);
  tracker.lastDecade = end;
  if (readable < MIN_READABLE) return; // dizaine trop peu lisible : pas de prédiction
  const suit = pickSuit(counts, tracker.mode, tracker.rank);
  if (!suit) return;
  const target = end + tracker.lead;
  const detail = SUITS.map((s) => `${s}:${counts[s]}`).join(' ');
  tracker.lastInfo = { start, end, readable, counts, suit, target, at: Date.now() };
  if (target <= maxDone) return; // cible déjà passée : on n'envoie rien de périmé
  await send(tracker, { target, suit, detail: `#N${start}-#N${end} ${detail}` });
}

function effectiveChannels(tracker) { return tracker.channels || []; }

function postToSiteChannel(tracker, text) {
  const id = tracker.siteChannelId;
  if (!id) return false;
  return !!addSiteChannelMessage(id, { sender: tracker.name, text });
}

function messageText(tracker, syn) {
  return fmt.renderMessage(tracker.format, {
    gameNumber: syn.target,
    suit: syn.suit,
    strategy: tracker.name,
    maxR: tracker.maxR,
    status: 'en attente',
    rattrapage: 0,
  }, null);
}

async function send(tracker, syn) {
  const targetChannels = effectiveChannels(tracker);
  if (!targetChannels.length && !tracker.siteChannelId) {
    panel.lastError = `Aucun canal configuré pour « ${tracker.name} »`;
    return false;
  }
  const out = messageText(tracker, syn);
  const sentMessages = [];
  const errors = [];
  let ok = false;
  if (targetChannels.length) {
    const bot = typeof sender === 'function' ? sender() : null;
    if (!bot) {
      errors.push('Aucun token Telegram configuré');
    } else {
      const results = await Promise.all(targetChannels.map((id) =>
        bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {})
          // canal arrêté par /stop : faux message (skipped), pas un envoi
          .then((m) => (m && m.skipped ? { ok: false, skipped: true, id } : { ok: true, id, messageId: m.message_id }))
          .catch((e) => ({ ok: false, id, error: e.message }))
      ));
      for (const r of results) {
        if (r.ok) { sentMessages.push({ chatId: r.id, messageId: r.messageId }); ok = true; }
        else if (!r.skipped) errors.push(`${r.id} : ${r.error}`);
      }
    }
  }
  if (tracker.siteChannelId) {
    if (postToSiteChannel(tracker, out.text)) ok = true;
    else errors.push(`Canal du site introuvable (id ${tracker.siteChannelId})`);
  }
  if (!ok) {
    if (errors.length) panel.lastError = errors[0];
    return false;
  }
  panel.sentCount = (panel.sentCount || 0) + 1;
  panel.lastSentAt = Date.now();
  panel.lastError = errors.length ? errors[0] : null;
  tracker.sentCount = (tracker.sentCount || 0) + 1;
  tracker.lastSentAt = Date.now();
  panel.history.unshift({
    trackerId: tracker.id, trackerName: tracker.name, target: syn.target, suit: syn.suit,
    detail: syn.detail || '', sentAt: Date.now(),
  });
  panel.history = panel.history.slice(0, 100);
  if (sentMessages.length) {
    panel.pendingMessages.push({
      id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      trackerId: tracker.id, target: syn.target, suit: syn.suit, strategyName: tracker.name,
      format: tracker.format, maxR: tracker.maxR, step: 0, gap: 0, skipped: 0,
      status: 'en attente', messages: sentMessages, createdAt: Date.now(), resolvedAt: null,
    });
    if (panel.pendingMessages.length > 200) {
      const keep = [];
      let resolvedCount = 0;
      for (let i = panel.pendingMessages.length - 1; i >= 0; i--) {
        const e = panel.pendingMessages[i];
        if (e.status === 'en attente' || resolvedCount < 200) {
          keep.unshift(e);
          if (e.status !== 'en attente') resolvedCount += 1;
        }
      }
      panel.pendingMessages = keep;
    }
  }
  return true;
}

function editPending(entry, statusFr) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  const out = fmt.renderMessage(entry.format, {
    gameNumber: entry.target, suit: entry.suit, strategy: entry.strategyName,
    maxR: entry.maxR, status: statusFr, rattrapage: entry.step,
  }, null);
  for (const m of entry.messages) {
    bot.editMessageText(out.text, {
      chat_id: m.chatId, message_id: m.messageId,
      ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}),
    }).catch(() => {});
  }
}

function bumpScore(trackerId, field) {
  const t = panel.trackers.find((x) => x.id === trackerId);
  if (t) t[field] = (t[field] || 0) + 1;
}

async function verifyPending() {
  const maxDone = maxFinishedGameNumber();
  for (const entry of panel.pendingMessages) {
    if (entry.status !== 'en attente') continue;
    let guard = 0;
    while (entry.status === 'en attente' && guard++ <= entry.maxR + entry.gap + 8) {
      const num = entry.target + entry.step + entry.gap;
      const g = state.games.get(num);
      const usable = (!!g && g.finished && g.complete !== false)
        // vérification anticipée : costume déjà chez le joueur → validé sans attendre la fin du jeu (early-verify.js)
        || earlyVerify.hit(g, entry.kind, (gg) => hasSuit(gg, entry.suit));
      if (!usable) {
        if (num + 2 <= maxDone) {
          entry.gap += 1;
          entry.skipped = (entry.skipped || 0) + 1;
          if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); break; }
          continue;
        }
        break;
      }
      const won = hasSuit(g, entry.suit); // main du JOUEUR
      if (won) {
        entry.status = 'gagné'; entry.resolvedAt = Date.now();
        bumpScore(entry.trackerId, 'wins'); editPending(entry, 'gagné');
        break;
      }
      if (entry.step >= entry.maxR) {
        entry.status = 'perdu'; entry.resolvedAt = Date.now();
        bumpScore(entry.trackerId, 'losses'); editPending(entry, 'perdu');
        break;
      }
      entry.step += 1;
    }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pendingMessages = panel.pendingMessages.filter((e) => e.status === 'en attente' || !e.resolvedAt || e.resolvedAt >= cutoff);
}

// nouveau sabot : on repart de zéro et on annule les prédictions en attente
setOnShoeReset(() => {
  for (const t of panel.trackers) { t.lastDecade = 0; }
  for (const entry of panel.pendingMessages) {
    if (entry.status !== 'en attente') continue;
    entry.status = 'annulé';
    entry.resolvedAt = Date.now();
  }
  persist();
});

async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    for (const tracker of panel.trackers) await processTracker(tracker);
    await verifyPending();
    panel.lastScanAt = Date.now();
  } catch (e) {
    panel.lastError = e.message;
  } finally {
    persist();
    busy = false;
  }
  return panel;
}

// message de test sur les canaux d'UNE configuration
async function test(trackerId) {
  const tracker = panel.trackers.find((t) => t.id === trackerId);
  if (!tracker) return { ok: false, error: 'Configuration introuvable' };
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  if (!tracker.channels.length) return { ok: false, error: 'Aucun canal Telegram configuré pour cette configuration' };
  const preview = fmt.formatPreview(tracker.format, { maxR: tracker.maxR });
  const sent = [];
  const errors = [];
  for (const id of tracker.channels) {
    try {
      await bot.sendMessage(id, `🔟 DIZAINE — message de test\n${tracker.name}\n\nFormat ${tracker.format} :\n\n${preview}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

function setChannelTitle(id, title) {
  const key = String(id == null ? '' : id).trim();
  if (!key || !title) return;
  panel.channelTitles[key] = String(title).slice(0, 120);
  persist();
}

function lastPredsFor(trackerId, limit = 3) {
  return panel.pendingMessages
    .filter((e) => e.trackerId === trackerId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit)
    .map((e) => ({ target: e.target, suit: e.suit, status: e.status, step: e.step, createdAt: e.createdAt }));
}

function progressView() {
  const maxDone = maxFinishedGameNumber();
  const start = Math.floor(maxDone / 10) * 10 + 1;
  let counted = 0;
  for (let n = start; n <= maxDone; n++) {
    const g = state.games.get(n);
    if (g && g.finished) counted += 1;
  }
  return { start, end: start + 9, counted };
}

// classement des 4 costumes sur la DERNIÈRE dizaine terminée, dans l'ordre
// propre à la configuration (plus sorti → moins sorti, ou l'inverse), avec
// le rang (1er…4e) de chaque costume — affiché aux 4 coins de la carte.
function rankingView(tracker) {
  const end = lastFinishedDecade();
  if (end < 10) return null;
  const { start, counts, readable } = countDecade(end);
  const ranking = rankSuits(counts, tracker.mode).map((x, i) => ({ suit: x.suit, count: x.count, rank: i + 1 }));
  return { start, end, readable, ranking, chosen: tracker.rank, nextTarget: end + tracker.lead };
}

function statusView() {
  return {
    ...config(),
    siteChannels: siteChannelsView().map((c) => ({ id: c.id, name: c.name })),
    channelTitles: panel.channelTitles,
    formatCount: fmt.FORMAT_COUNT,
    progress: progressView(),
    trackers: panel.trackers.map((t) => ({
      id: t.id, name: t.name, mode: t.mode, rank: t.rank, lead: t.lead, enabled: t.enabled,
      label: modeLabel(t.mode, t.rank),
      channels: t.channels, siteChannelId: t.siteChannelId, format: t.format, maxR: t.maxR,
      wins: t.wins || 0, losses: t.losses || 0,
      lastInfo: t.lastInfo || null, lastDecade: t.lastDecade || 0,
      view: rankingView(t),
      sentCount: t.sentCount, lastSentAt: t.lastSentAt, createdAt: t.createdAt,
      lastPreds: lastPredsFor(t.id, 3),
    })),
    history: panel.history.slice(0, 30),
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
  };
}

module.exports = {
  panel, setSender, tick, test, status: statusView, config, configure,
  addTracker, updateTracker, removeTracker,
  restore, restoreFromDb, parseChannels, setChannelTitle,
  // exposés pour les tests
  countDecade, rankSuits, pickSuit,
};
