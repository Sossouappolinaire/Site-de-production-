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
//
// BILAN (demande admin) : toutes les heures pile (réglable), un bilan est envoyé dans les
// canaux des configurations : la meilleure configuration y est désignée par le
// nom réel de son canal, classée 1ʳᵉ avec son taux de réussite sur N prédictions,
// suivie du classement des autres. Taux calculé sur la JOURNÉE EN COURS (fuseau
// BILAN_TZ, Africa/Porto-Novo par défaut) ; au point de minuit, bilan de la
// journée qui vient de se terminer. Une configuration doit avoir au moins 5
// prédictions vérifiées dans la journée pour être classée. Chaque canal reçoit le
// bilan complet. Envoi à heure fixe (00h, 02h, 04h…), jamais en double après un
// redémarrage.
'use strict';

const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const strategies = require('./strategies');
const { state, hasSuit, addSiteChannelMessage, siteChannelsView, setOnShoeReset } = require('./predictor');
const earlyVerify = require('./early-verify');
const sendDelay = require('./send-delay');

const SUITS = strategies.SUITS; // ['♦️', '❤️', '♣️', '♠️'] — ordre de départage des égalités
const MIN_READABLE = 6;

const panel = {
  enabled: true,
  trackers: [],
  pendingMessages: [],
  channelTitles: {},
  channelLinks: {},
  history: [],
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
  // bilan périodique (voir en-tête)
  bilan: { enabled: true, everyHours: 1, hourlyMigrated: true, minPreds: 5, lastSlot: null, lastSentAt: null, lastResult: null },
  // canal des MEILLEURES prédictions (voir en-tête) : configuré une fois, il reçoit les
  // prédictions de la configuration actuellement en tête du classement du jour.
  best: { enabled: false, channels: [], link: '', welcome: true, recap: true, recapMin: 125, lastRecapAt: null, wins: 0, losses: 0, format: 1, maxR: 2, currentTrackerId: null, switchedAt: null, sentCount: 0, lastSentAt: null, delayEnabled: true, delaySec: 0 },
  weak: { enabled: false, channels: [], link: '', welcome: true, recap: true, recapMin: 125, lastRecapAt: null, wins: 0, losses: 0, format: 1, maxR: 2, rank: 4, currentTrackerId: null, switchedAt: null, sentCount: 0, lastSentAt: null, delayEnabled: true, delaySec: 0 },
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

function sanitizeEvery(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(1, Math.min(24, n)) : 1; }
function sanitizeMinPreds(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 5; }

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.bilanEnabled !== undefined) panel.bilan.enabled = !!patch.bilanEnabled;
  if (patch.bilanEveryHours !== undefined) panel.bilan.everyHours = sanitizeEvery(patch.bilanEveryHours);
  if (patch.bilanMinPreds !== undefined) panel.bilan.minPreds = sanitizeMinPreds(patch.bilanMinPreds);
  if (patch.bestEnabled !== undefined) panel.best.enabled = !!patch.bestEnabled;
  if (patch.bestChannels !== undefined) panel.best.channels = parseChannels(patch.bestChannels);
  if (patch.bestLink !== undefined) panel.best.link = sanitizeLink(patch.bestLink);
  if (patch.bestWelcome !== undefined) panel.best.welcome = !!patch.bestWelcome;
  if (patch.bestRecap !== undefined) panel.best.recap = !!patch.bestRecap;
  if (patch.bestRecapMin !== undefined) panel.best.recapMin = sanitizeRecapMin(patch.bestRecapMin);
  if (patch.bestDelayEnabled !== undefined) panel.best.delayEnabled = !!patch.bestDelayEnabled;
  if (patch.bestDelaySec !== undefined) panel.best.delaySec = sanitizeDelaySec(patch.bestDelaySec);
  if (patch.bestFormat !== undefined) panel.best.format = sanitizeFormat(patch.bestFormat);
  if (patch.bestMaxR !== undefined) panel.best.maxR = sanitizeMaxR(patch.bestMaxR);
  if (patch.weakEnabled !== undefined) panel.weak.enabled = !!patch.weakEnabled;
  if (patch.weakChannels !== undefined) panel.weak.channels = parseChannels(patch.weakChannels);
  if (patch.weakLink !== undefined) panel.weak.link = sanitizeLink(patch.weakLink);
  if (patch.weakWelcome !== undefined) panel.weak.welcome = !!patch.weakWelcome;
  if (patch.weakRecap !== undefined) panel.weak.recap = !!patch.weakRecap;
  if (patch.weakRecapMin !== undefined) panel.weak.recapMin = sanitizeRecapMin(patch.weakRecapMin);
  if (patch.weakDelayEnabled !== undefined) panel.weak.delayEnabled = !!patch.weakDelayEnabled;
  if (patch.weakDelaySec !== undefined) panel.weak.delaySec = sanitizeDelaySec(patch.weakDelaySec);
  if (patch.weakFormat !== undefined) panel.weak.format = sanitizeFormat(patch.weakFormat);
  if (patch.weakMaxR !== undefined) panel.weak.maxR = sanitizeMaxR(patch.weakMaxR);
  if (patch.weakRank !== undefined) panel.weak.rank = sanitizeWeakRank(patch.weakRank);
  persist();
  return config();
}
function config() {
  return {
    enabled: panel.enabled,
    bilanEnabled: panel.bilan.enabled, bilanEveryHours: panel.bilan.everyHours, bilanMinPreds: panel.bilan.minPreds,
    bestEnabled: panel.best.enabled, bestChannels: panel.best.channels, bestFormat: panel.best.format, bestMaxR: panel.best.maxR,
    weakEnabled: panel.weak.enabled, weakChannels: panel.weak.channels, weakFormat: panel.weak.format, weakMaxR: panel.weak.maxR, weakRank: panel.weak.rank,
  };
}

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
    channelLinks: panel.channelLinks,
    bilan: panel.bilan,
    best: panel.best,
    weak: panel.weak,
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
    // résultats par journée (bilan) : jour en cours + veille
    day: t.day && t.day.date ? { date: t.day.date, wins: Number(t.day.wins) || 0, losses: Number(t.day.losses) || 0, rsum: Number(t.day.rsum) || 0, d0: Number(t.day.d0) || 0, streak: Number(t.day.streak) || 0, rmax: Number(t.day.rmax) || 0, lrun: Number(t.day.lrun) || 0, lmax: Number(t.day.lmax) || 0, smax: Number(t.day.smax) || 0 } : null,
    seg: normSeg(t.seg),
    prevDay: t.prevDay && t.prevDay.date ? { date: t.prevDay.date, wins: Number(t.prevDay.wins) || 0, losses: Number(t.prevDay.losses) || 0, rsum: Number(t.prevDay.rsum) || 0, d0: Number(t.prevDay.d0) || 0, streak: Number(t.prevDay.streak) || 0, rmax: Number(t.prevDay.rmax) || 0, lrun: Number(t.prevDay.lrun) || 0, lmax: Number(t.prevDay.lmax) || 0, smax: Number(t.prevDay.smax) || 0 } : null,
  };
  base.name = (t.name && String(t.name).trim()) || defaultName(base);
  return base;
}

function applySaved(saved) {
  if (saved.channelTitles && typeof saved.channelTitles === 'object') panel.channelTitles = { ...saved.channelTitles };
  if (saved.channelLinks && typeof saved.channelLinks === 'object') panel.channelLinks = { ...saved.channelLinks };
  if (saved.config) panel.enabled = saved.config.enabled !== false;
  if (saved.bilan && typeof saved.bilan === 'object') {
    panel.bilan = {
      ...panel.bilan,
      enabled: saved.bilan.enabled !== false,
      // migration unique : passage à un bilan toutes les heures pile (demande admin)
      everyHours: saved.bilan.hourlyMigrated ? sanitizeEvery(saved.bilan.everyHours) : 1,
      hourlyMigrated: true,
      minPreds: sanitizeMinPreds(saved.bilan.minPreds),
      lastSlot: saved.bilan.lastSlot || null,
      lastSentAt: saved.bilan.lastSentAt || null,
      segSince: Number(saved.bilan.segSince) || null,
    };
  }
  if (saved.best && typeof saved.best === 'object') {
    panel.best = {
      ...panel.best,
      enabled: !!saved.best.enabled,
      channels: parseChannels(saved.best.channels || []),
      link: sanitizeLink(saved.best.link),
      welcome: saved.best.welcome !== false,
      recap: saved.best.recap !== false,
      recapMin: sanitizeRecapMin(saved.best.recapMin == null ? 125 : saved.best.recapMin),
      lastRecapAt: Number(saved.best.lastRecapAt) || null,
      wins: Number(saved.best.wins) || 0,
      losses: Number(saved.best.losses) || 0,
      format: sanitizeFormat(saved.best.format),
      maxR: sanitizeMaxR(saved.best.maxR),
      currentTrackerId: saved.best.currentTrackerId || null,
      switchedAt: saved.best.switchedAt || null,
      sentCount: Number(saved.best.sentCount) || 0,
      lastSentAt: saved.best.lastSentAt || null,
      delayEnabled: saved.best.delayEnabled !== false,
      delaySec: sanitizeDelaySec(saved.best.delaySec),
      day: saved.best.day || undefined,
      lastSuit: saved.best.lastSuit || null,
      lastTarget: Number.isFinite(Number(saved.best.lastTarget)) && saved.best.lastTarget !== null ? Number(saved.best.lastTarget) : null,
    };
  }
  if (saved.weak && typeof saved.weak === 'object') {
    panel.weak = {
      ...panel.weak,
      enabled: !!saved.weak.enabled,
      rank: sanitizeWeakRank(saved.weak.rank),
      channels: parseChannels(saved.weak.channels || []),
      link: sanitizeLink(saved.weak.link),
      welcome: saved.weak.welcome !== false,
      recap: saved.weak.recap !== false,
      recapMin: sanitizeRecapMin(saved.weak.recapMin == null ? 125 : saved.weak.recapMin),
      lastRecapAt: Number(saved.weak.lastRecapAt) || null,
      wins: Number(saved.weak.wins) || 0,
      losses: Number(saved.weak.losses) || 0,
      format: sanitizeFormat(saved.weak.format),
      maxR: sanitizeMaxR(saved.weak.maxR),
      currentTrackerId: saved.weak.currentTrackerId || null,
      switchedAt: saved.weak.switchedAt || null,
      sentCount: Number(saved.weak.sentCount) || 0,
      lastSentAt: saved.weak.lastSentAt || null,
      delayEnabled: saved.weak.delayEnabled !== false,
      delaySec: sanitizeDelaySec(saved.weak.delaySec),
      day: saved.weak.day || undefined,
      lastSuit: saved.weak.lastSuit || null,
      lastTarget: Number.isFinite(Number(saved.weak.lastTarget)) && saved.weak.lastTarget !== null ? Number(saved.weak.lastTarget) : null,
    };
  }
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

// ---------------------------------------------------------------------------
// Canal des MEILLEURES prédictions
// ---------------------------------------------------------------------------
// Classement du jour (même règle que le bilan : taux, puis moyenne des rattrapages,
// puis nombre de prédictions, puis victoires ; minimum de prédictions vérifiées pour être classée).
function rankedToday(now = Date.now()) {
  const key = dayKeyOf(now);
  return panel.trackers
    .map((t) => { const st = dayStats(t, key); return { t, ...st, rate: st.total ? st.wins / st.total : 0 }; })
    .filter((r) => r.total >= panel.bilan.minPreds)
    .sort(compareRanking);
}

// Meilleure configuration du moment. Si une autre devient STRICTEMENT meilleure,
// on bascule sur elle (sa prédiction en cours part tout de suite dans le canal des meilleures).
// Tant que personne n'est classé (début de journée), on garde le dernier meilleur connu.
// lien saisi à la main : https://t.me/..., t.me/..., telegram.me/... ou @nom (vide = aucun)
function sanitizeLink(value) {
  let v = String(value == null ? '' : value).trim().slice(0, 200);
  if (!v) return '';
  if (v.startsWith('@')) return `https://t.me/${v.slice(1)}`;
  if (/^(t\.me|telegram\.me)\//i.test(v)) v = `https://${v}`;
  return /^https?:\/\/(t\.me|telegram\.me)\/\S+$/i.test(v) ? v : '';
}
function channelLinkOf(id) {
  const key = String(id == null ? '' : id).trim();
  if (panel.channelLinks[key]) return panel.channelLinks[key];
  if (key.startsWith('@')) return `https://t.me/${key.slice(1)}`;
  return null;
}

let adminIdFn = null;
function setAdminId(fn) { adminIdFn = typeof fn === 'function' ? fn : null; }
function trackerRealName(t) { return trackerChannelNames(t, siteChannelsView()).join(' + ') || t.name; }

// Alerte envoyée UNIQUEMENT au chat privé de l'administrateur (jamais dans un canal)
function notifyBestChange(prevId, top, ranked, reason) {
  try {
    const b = panel.best;
    const adminId = adminIdFn ? adminIdFn() : null;
    const bot = typeof sender === 'function' ? sender() : null;
    if (!b.enabled || !b.channels.length || !adminId || !bot) return;
    const line = (r) => `${trackerRealName(r.t)} — ${pct(r.wins, r.total)} (${r.wins}/${r.total}) · moy. ${avgRattrapage(r)}`;
    const prevRow = prevId ? ranked.find((r) => r.t.id === prevId) : null;
    const prevT = prevId ? panel.trackers.find((t) => t.id === prevId) : null;
    const dest = b.channels.map((id) => panel.channelTitles[String(id)] || String(id)).join(' + ');
    const text = prevT
      ? `🔄 Nouveau meilleur canal${reason ? `\n⚠️ Cause : ${reason}` : ''}\n\n🏆 ${line(top)}\n↩️ Remplace : ${prevRow ? line(prevRow) : trackerRealName(prevT)}\n\n📣 Ses prédictions partent maintenant dans « ${dest} »`
      : `🏆 Meilleur canal désigné\n\n${line(top)}\n\n📣 Ses prédictions partent dans « ${dest} »`;
    Promise.resolve(bot.sendMessage(adminId, text)).catch(() => {});
  } catch (_) { /* une alerte ratée ne doit jamais bloquer les prédictions */ }
}

// ---- BIENVENUE dans le canal des meilleures prédictions ------------------
function bestRecap(title) {
  rollBestDay(); // 00h00 Abidjan : tout repart à zéro
  const w = panel.best.wins || 0; const l = panel.best.losses || 0; const total = w + l;
  const rate = total ? ((w / total) * 100).toFixed(2) : '0.00';
  return `📊 ${title} :\n• 🎮 All games : ${total}\n• ✅ Won : ${w}\n• ❌ Lost : ${l}\n• ${rate}%`;
}
// ---- RÉCAPITULATIF PÉRIODIQUE dans le canal des meilleures prédictions -----
function sanitizeRecapMin(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(5, Math.min(1440, n)) : 125;
}
async function maybeSendRecap(now = Date.now()) {
  const b = panel.best;
  if (!b.enabled || !b.recap || !b.channels.length) return;
  if (!b.lastRecapAt) { b.lastRecapAt = now; return; } // le compteur démarre : 1er récapitulatif après l'intervalle
  if (now - b.lastRecapAt < sanitizeRecapMin(b.recapMin) * 60000) return;
  b.lastRecapAt = now;
  if (((b.wins || 0) + (b.losses || 0)) === 0) return; // rien à récapituler
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  for (const id of b.channels) {
    const title = panel.channelTitles[String(id)] || String(id);
    try { await bot.sendMessage(id, bestRecap(title)); }
    catch (e) { panel.lastError = `Récapitulatif ${id} : ${e.message}`; }
  }
}

function welcomeText(fullName, title) {
  return `👋 ${fullName}, bienvenue dans le canal : ${title}\n\n${bestRecap(title)}`;
}
const welcomeSeen = new Map();
function isBestChat(chat) {
  return panel.best.channels.some((id) => String(id) === String(chat.id)
    || (String(id).startsWith('@') && chat.username && String(id).slice(1).toLowerCase() === String(chat.username).toLowerCase()));
}
let lastMember = null; // diagnostic : dernier événement « membre » reçu de Telegram (non sauvegardé)
async function handleMemberUpdate(u) {
  if (u && u.chat && u.new_chat_member) {
    lastMember = {
      at: Date.now(), chat: u.chat.title || String(u.chat.id),
      from: (u.old_chat_member || {}).status || '?', to: u.new_chat_member.status,
      isBest: isBestChat(u.chat),
    };
  }
  const b = panel.best;
  if (!b.enabled || !b.welcome || !b.channels.length || !u || !u.chat || !u.new_chat_member) return false;
  const nm = u.new_chat_member; const old = u.old_chat_member || {};
  const joined = ['member', 'administrator', 'creator'].includes(nm.status) && ['left', 'kicked'].includes(old.status);
  if (!joined || !nm.user || nm.user.is_bot || !isBestChat(u.chat)) return false;
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return false;
  const k = `${u.chat.id}:${nm.user.id}`;
  const now = Date.now();
  if (welcomeSeen.has(k) && now - welcomeSeen.get(k) < 10 * 60 * 1000) return false; // pas de double message
  welcomeSeen.set(k, now);
  if (welcomeSeen.size > 500) for (const [kk, t] of welcomeSeen) if (now - t > 10 * 60 * 1000) welcomeSeen.delete(kk);
  const title = u.chat.title || panel.channelTitles[String(u.chat.id)] || String(u.chat.id);
  if (u.chat.title) setChannelTitle(u.chat.id, u.chat.title);
  const fullName = [nm.user.first_name, nm.user.last_name].filter(Boolean).join(' ').trim() || nm.user.username || 'Nouveau membre';
  try { await bot.sendMessage(u.chat.id, welcomeText(fullName, title)); return true; }
  catch (e) { panel.lastError = `Bienvenue ${u.chat.id} : ${e.message}`; return false; }
}


// Test de la bienvenue : vérifie les droits du bot dans le canal des meilleures et y poste un message d'essai
async function testWelcome() {
  const b = panel.best;
  if (!b.channels.length) return { ok: false, error: 'Aucun canal des meilleures prédictions configuré' };
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  const out = { ok: false, channel: String(b.channels[0]) };
  try {
    const me = await bot.getMe();
    const chat = await bot.getChat(b.channels[0]);
    out.chatType = chat.type;
    const mem = await bot.getChatMember(chat.id, me.id);
    out.botStatus = mem.status; out.canPost = mem.can_post_messages; out.canInvite = mem.can_invite_users;
    const title = chat.title || panel.channelTitles[String(chat.id)] || String(chat.id);
    const m = await bot.sendMessage(chat.id, `🧪 TEST — ${welcomeText('Prénom Nom', title)}`);
    if (m && m.skipped) out.error = 'Envoi ignoré : les prédictions de ce canal sont en pause (/stop)';
    else out.ok = true;
  } catch (e) { out.error = e.message; }
  return out;
}

function currentBest(now = Date.now(), reason) {
  const b = panel.best;
  const ranked = rankedToday(now);
  if (ranked.length) {
    const top = ranked[0];
    const cur = ranked.find((r) => r.t.id === b.currentTrackerId);
    if (!cur || compareQuality(top, cur) < 0) { // égalité parfaite (taux ET moyenne) : on reste sur le meilleur actuel (pas d'aller-retour)
      const prevId = b.currentTrackerId;
      b.currentTrackerId = top.t.id;
      b.switchedAt = Date.now();
      if (prevId !== top.t.id) { notifyBestChange(prevId, top, ranked, reason); b.lastSuit = null; b.lastTarget = null; relayNewBest(top.t); }
    }
  }
  return panel.trackers.find((t) => t.id === b.currentTrackerId) || null;
}

// ---------------------------------------------------------------------------
// CANAL DES MEILLEURES : journée 00h00 (heure d'Abidjan), anti-doublon de costume, relais au changement
// ---------------------------------------------------------------------------
const BEST_TZ = process.env.RESET_TZ || 'Africa/Abidjan';
function bestDayKey(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BEST_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
// Après 00h00 (Abidjan) : le récapitulatif (All games / Won / Lost) repart de zéro et le dernier costume est oublié.
// Au tout premier passage on ne remet à zéro que si le dernier envoi date d'un jour précédent.
function rollBestDay(now = Date.now()) {
  const b = panel.best;
  const key = bestDayKey(now);
  if (b.day === key) return false;
  const stale = b.day ? true : !!(b.lastSentAt && bestDayKey(b.lastSentAt) !== key);
  b.day = key;
  if (stale) { b.wins = 0; b.losses = 0; b.lastSuit = null; b.lastTarget = null; }
  persist();
  return stale;
}
// prédiction d'origine (celle du canal de la configuration) qui correspond à syn : sert à ne jamais relayer deux fois la même
function findOriginalEntry(tracker, syn) {
  for (let i = panel.pendingMessages.length - 1; i >= 0; i--) {
    const e = panel.pendingMessages[i];
    if (!e.mirror && e.trackerId === tracker.id && e.target === syn.target && String(e.suit) === String(syn.suit)) return e;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ENVOI vers le canal des meilleures : attente du jeu suivant
// Dès qu'une configuration est désignée meilleure (ou que le meilleur produit une prédiction), on N'envoie PAS tout de
// suite : la prédiction est retenue jusqu'à ce que le jeu situé juste AVANT la cible démarre (cartes en distribution ou
// jeu terminé), puis elle part automatiquement (`delaySec` = 0 s par défaut ; aucun retard de 10 s). Si le jeu cible est
// déjà lancé / terminé, ou si le meilleur a changé entre-temps, elle est abandonnée (jamais d'annonce périmée).
// ---------------------------------------------------------------------------
function sanitizeDelaySec(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(120, n)) : 0;
}
const bestHeld = [];
let bestHeldTimer = null;
let bestReleasing = false;
function bestDelayOn() { return panel.best.delayEnabled !== false && sendDelay.enabled(); }

function cancelHeld(h) {
  const b = panel.best;
  // l'anti-doublon ne doit pas se souvenir d'une prédiction que le canal n'a jamais reçue
  if (b.lastTarget === h.target) { b.lastSuit = h.prevSuit || null; b.lastTarget = h.prevTarget == null ? null : h.prevTarget; }
  if (h.orig) h.orig.bestRelayed = false;
}
async function releaseBestHeld(now = Date.now()) {
  if (bestReleasing || !bestHeld.length) return;
  bestReleasing = true;
  try {
    const { done, dealing } = sendDelay.progress(state.games);
    for (let i = 0; i < bestHeld.length;) {
      const h = bestHeld[i];
      if (!panel.best.enabled || String(panel.best.currentTrackerId) !== String(h.tracker.id)) { bestHeld.splice(i, 1); cancelHeld(h); continue; } // plus le meilleur
      if (Number.isFinite(h.target) && (done >= h.target || dealing >= h.target)) { bestHeld.splice(i, 1); cancelHeld(h); continue; } // jeu cible déjà lancé
      const prevOn = !Number.isFinite(h.target) || dealing >= h.target - 1 || done >= h.target - 1;
      if (!prevOn) { i++; continue; }
      if (!h.armedAt) h.armedAt = now;
      if (now - h.armedAt < h.sec * 1000) { i++; continue; }
      bestHeld.splice(i, 1);
      let ok = false;
      try { ok = await postToBest(h.tracker, h.syn, h.orig); } catch (e) { panel.lastError = `Meilleures prédictions : ${e.message}`; }
      if (!ok) cancelHeld(h);
    }
  } finally {
    bestReleasing = false;
    if (!bestHeld.length && bestHeldTimer) { clearInterval(bestHeldTimer); bestHeldTimer = null; }
  }
}
function holdBest(tracker, syn, orig) {
  const b = panel.best;
  if (orig) orig.bestRelayed = true; // marquée tout de suite : jamais retenue ni envoyée deux fois
  const target = Number(syn.target);
  bestHeld.push({ tracker, syn, orig, target, armedAt: null, sec: sanitizeDelaySec(b.delaySec), prevSuit: b.lastSuit || null, prevTarget: b.lastTarget == null ? null : b.lastTarget });
  b.lastSuit = String(syn.suit); // pour l'anti-doublon dès maintenant
  if (Number.isFinite(target)) b.lastTarget = target;
  if (!bestHeldTimer) { bestHeldTimer = setInterval(() => { releaseBestHeld().catch(() => {}); }, 1000); if (bestHeldTimer.unref) bestHeldTimer.unref(); }
  releaseBestHeld().catch(() => {}); // la condition peut déjà être remplie : envoi aussitôt
}

// Envoi réel dans le canal des meilleures (relais). Retourne true seulement si Telegram a VRAIMENT posté le message
// (canal en /stop ou erreur → false → rien n'est compté dans le récapitulatif).
async function postToBest(tracker, syn, orig) {
  const b = panel.best;
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Meilleures prédictions : aucun token Telegram configuré'; return false; }
  if (orig) orig.bestRelayed = true; // marqué TOUT DE SUITE (avant l'envoi) : jamais deux envois de la même prédiction
  const out = fmt.renderMessage(b.format, {
    gameNumber: syn.target, suit: syn.suit, strategy: 'Meilleure prédiction',
    maxR: b.maxR, status: 'en attente', rattrapage: 0,
  }, null);
  const sentMessages = [];
  const res = await Promise.all(b.channels.map((id) =>
    bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {})
      .then((m) => (m && m.skipped ? { skipped: true } : { ok: true, id, messageId: m.message_id }))
      .catch((e) => ({ id, error: e.message }))));
  for (const r of res) {
    if (r.ok) sentMessages.push({ chatId: r.id, messageId: r.messageId });
    else if (!r.skipped) panel.lastError = `Meilleures prédictions ${r.id} : ${r.error}`;
  }
  if (!sentMessages.length) { if (orig) orig.bestRelayed = false; return false; }
  b.sentCount = (b.sentCount || 0) + 1;
  b.lastSentAt = Date.now();
  b.lastSuit = String(syn.suit); // mémoire du dernier costume envoyé (anti-doublon)
  if (Number.isFinite(Number(syn.target))) b.lastTarget = Number(syn.target);
  panel.pendingMessages.push({
    id: `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    trackerId: tracker.id, mirror: true, best: true, // relais : ne compte pas deux fois dans les scores
    target: syn.target, suit: syn.suit, strategyName: 'Meilleure prédiction',
    format: b.format, maxR: b.maxR, step: 0, gap: 0, skipped: 0,
    status: 'en attente', messages: sentMessages, createdAt: Date.now(), resolvedAt: null,
  });
  persist();
  return true;
}

// Quand le meilleur CHANGE : sa prédiction en cours (en attente, pas encore en rattrapage) part tout de suite dans le canal
// des meilleures, sans attendre sa prochaine prédiction.
function relayNewBest(tracker) {
  try {
    const b = panel.best;
    if (!b.enabled || !b.channels.length) return;
    const today = bestDayKey();
    let orig = null;
    for (let i = panel.pendingMessages.length - 1; i >= 0; i--) {
      const e = panel.pendingMessages[i];
      if (!e.mirror && e.trackerId === tracker.id && e.status === 'en attente' && !e.step && !e.bestRelayed && bestDayKey(e.createdAt) === today) { orig = e; break; }
    }
    if (!orig) return;
    // la prédiction est choisie et marquée « relayée » tout de suite (avant tout await) ; l'envoi attend le jeu suivant
    const synR = { target: orig.target, suit: orig.suit };
    if (bestDelayOn()) { holdBest(tracker, synR, orig); return; } // attend le démarrage du jeu suivant, puis envoi automatique
    postToBest(tracker, synR, orig)
      .catch((e) => { panel.lastError = `Meilleures prédictions : ${e.message}`; });
  } catch (e) { panel.lastError = `Meilleures prédictions : ${e.message}`; }
}

// Prédiction d'une configuration : relayée dans le canal des meilleures SEULEMENT si c'est la meilleure du moment
// ET si son costume est différent de la dernière prédiction envoyée dans ce canal (même costume = ignoré).
async function forwardToBest(tracker, syn) {
  const b = panel.best;
  if (!b.enabled || !b.channels.length) return false;
  rollBestDay();
  const best = currentBest();
  if (!best || best.id !== tracker.id) return false; // ce n'est pas la meilleure configuration
  const orig = findOriginalEntry(tracker, syn);
  if (orig && orig.bestRelayed) return false; // déjà relayée (par le changement de meilleur)
  // même costume que la précédente ET numéros qui se suivent (écart < 2) : ignorée. Écart d'au moins 2 : envoyée.
  const tNum = Number(syn.target);
  const sameSuit = !!b.lastSuit && String(b.lastSuit) === String(syn.suit);
  const near = Number.isFinite(tNum) && Number.isFinite(b.lastTarget) && Math.abs(tNum - b.lastTarget) < 2;
  if (Number.isFinite(tNum)) b.lastTarget = tNum; // dernier numéro prédit par le meilleur (envoyé ou ignoré)
  if (sameSuit && near) { b.skippedSame = (b.skippedSame || 0) + 1; return false; }
  if (bestDelayOn()) { holdBest(tracker, syn, orig); return true; }
  return postToBest(tracker, syn, orig);
}


// ---------------------------------------------------------------------------
// CANAL DU PLUS FAIBLE (demande admin) : même principe que le canal des meilleures, mais il relaie les
// prédictions de la stratégie classée au 4ᵉ rang (réglable) du classement du jour — « le plus fiable » à
// contre-courant. Si moins de 4 sont classées, c'est la dernière classée (au moins 2 classées requises).
// Jamais la même stratégie que le canal des meilleures.
// ---------------------------------------------------------------------------
function sanitizeWeakRank(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(2, Math.min(10, n)) : 4; }
function welcomeTextWeak(fullName, title) {
  return `👋 ${fullName}, bienvenue dans le canal : ${title}\n\n${weakRecap(title)}`;
}
const weakHeld = [];
let weakHeldTimer = null;
let weakReleasing = false;
function notifyWeakChange(prevId, top, ranked, reason) {
  try {
    const b = panel.weak;
    const adminId = adminIdFn ? adminIdFn() : null;
    const bot = typeof sender === 'function' ? sender() : null;
    if (!b.enabled || !b.channels.length || !adminId || !bot) return;
    const line = (r) => `${trackerRealName(r.t)} — ${pct(r.wins, r.total)} (${r.wins}/${r.total}) · moy. ${avgRattrapage(r)}`;
    const prevRow = prevId ? ranked.find((r) => r.t.id === prevId) : null;
    const prevT = prevId ? panel.trackers.find((t) => t.id === prevId) : null;
    const dest = b.channels.map((id) => panel.channelTitles[String(id)] || String(id)).join(' + ');
    const text = prevT
      ? `🔄 Nouveau canal du plus faible${reason ? `\n⚠️ Cause : ${reason}` : ''}\n\n📉 ${line(top)}\n↩️ Remplace : ${prevRow ? line(prevRow) : trackerRealName(prevT)}\n\n📣 Ses prédictions partent maintenant dans « ${dest} »`
      : `📉 Canal du plus faible désigné\n\n${line(top)}\n\n📣 Ses prédictions partent dans « ${dest} »`;
    Promise.resolve(bot.sendMessage(adminId, text)).catch(() => {});
  } catch (_) { /* une alerte ratée ne doit jamais bloquer les prédictions */ }
}
function weakRecap(title) {
  rollWeakDay(); // 00h00 Abidjan : tout repart à zéro
  const w = panel.weak.wins || 0; const l = panel.weak.losses || 0; const total = w + l;
  const rate = total ? ((w / total) * 100).toFixed(2) : '0.00';
  return `📊 ${title} :\n• 🎮 All games : ${total}\n• ✅ Won : ${w}\n• ❌ Lost : ${l}\n• ${rate}%`;
}
async function maybeSendRecapWeak(now = Date.now()) {
  const b = panel.weak;
  if (!b.enabled || !b.recap || !b.channels.length) return;
  if (!b.lastRecapAt) { b.lastRecapAt = now; return; } // le compteur démarre : 1er récapitulatif après l'intervalle
  if (now - b.lastRecapAt < sanitizeRecapMin(b.recapMin) * 60000) return;
  b.lastRecapAt = now;
  if (((b.wins || 0) + (b.losses || 0)) === 0) return; // rien à récapituler
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  for (const id of b.channels) {
    const title = panel.channelTitles[String(id)] || String(id);
    try { await bot.sendMessage(id, weakRecap(title)); }
    catch (e) { panel.lastError = `Récapitulatif ${id} : ${e.message}`; }
  }
}
function isWeakChat(chat) {
  return panel.weak.channels.some((id) => String(id) === String(chat.id)
    || (String(id).startsWith('@') && chat.username && String(id).slice(1).toLowerCase() === String(chat.username).toLowerCase()));
}
function rollWeakDay(now = Date.now()) {
  const b = panel.weak;
  const key = bestDayKey(now);
  if (b.day === key) return false;
  const stale = b.day ? true : !!(b.lastSentAt && bestDayKey(b.lastSentAt) !== key);
  b.day = key;
  if (stale) { b.wins = 0; b.losses = 0; b.lastSuit = null; b.lastTarget = null; }
  persist();
  return stale;
}
function cancelHeldWeak(h) {
  const b = panel.weak;
  // l'anti-doublon ne doit pas se souvenir d'une prédiction que le canal n'a jamais reçue
  if (b.lastTarget === h.target) { b.lastSuit = h.prevSuit || null; b.lastTarget = h.prevTarget == null ? null : h.prevTarget; }
  if (h.orig) h.orig.weakRelayed = false;
}
async function releaseWeakHeld(now = Date.now()) {
  if (weakReleasing || !weakHeld.length) return;
  weakReleasing = true;
  try {
    const { done, dealing } = sendDelay.progress(state.games);
    for (let i = 0; i < weakHeld.length;) {
      const h = weakHeld[i];
      if (!panel.weak.enabled || String(panel.weak.currentTrackerId) !== String(h.tracker.id)) { weakHeld.splice(i, 1); cancelHeldWeak(h); continue; } // plus le meilleur
      if (Number.isFinite(h.target) && (done >= h.target || dealing >= h.target)) { weakHeld.splice(i, 1); cancelHeldWeak(h); continue; } // jeu cible déjà lancé
      const prevOn = !Number.isFinite(h.target) || dealing >= h.target - 1 || done >= h.target - 1;
      if (!prevOn) { i++; continue; }
      if (!h.armedAt) h.armedAt = now;
      if (now - h.armedAt < h.sec * 1000) { i++; continue; }
      weakHeld.splice(i, 1);
      let ok = false;
      try { ok = await postToWeak(h.tracker, h.syn, h.orig); } catch (e) { panel.lastError = `Plus faible : ${e.message}`; }
      if (!ok) cancelHeldWeak(h);
    }
  } finally {
    weakReleasing = false;
    if (!weakHeld.length && weakHeldTimer) { clearInterval(weakHeldTimer); weakHeldTimer = null; }
  }
}
function holdWeak(tracker, syn, orig) {
  const b = panel.weak;
  if (orig) orig.weakRelayed = true; // marquée tout de suite : jamais retenue ni envoyée deux fois
  const target = Number(syn.target);
  weakHeld.push({ tracker, syn, orig, target, armedAt: null, sec: sanitizeDelaySec(b.delaySec), prevSuit: b.lastSuit || null, prevTarget: b.lastTarget == null ? null : b.lastTarget });
  b.lastSuit = String(syn.suit); // pour l'anti-doublon dès maintenant
  if (Number.isFinite(target)) b.lastTarget = target;
  if (!weakHeldTimer) { weakHeldTimer = setInterval(() => { releaseWeakHeld().catch(() => {}); }, 1000); if (weakHeldTimer.unref) weakHeldTimer.unref(); }
  releaseWeakHeld().catch(() => {}); // la condition peut déjà être remplie : envoi aussitôt
}
async function postToWeak(tracker, syn, orig) {
  const b = panel.weak;
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Plus faible : aucun token Telegram configuré'; return false; }
  if (orig) orig.weakRelayed = true; // marqué TOUT DE SUITE (avant l'envoi) : jamais deux envois de la même prédiction
  const out = fmt.renderMessage(b.format, {
    gameNumber: syn.target, suit: syn.suit, strategy: 'Prédiction du plus faible',
    maxR: b.maxR, status: 'en attente', rattrapage: 0,
  }, null);
  const sentMessages = [];
  const res = await Promise.all(b.channels.map((id) =>
    bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {})
      .then((m) => (m && m.skipped ? { skipped: true } : { ok: true, id, messageId: m.message_id }))
      .catch((e) => ({ id, error: e.message }))));
  for (const r of res) {
    if (r.ok) sentMessages.push({ chatId: r.id, messageId: r.messageId });
    else if (!r.skipped) panel.lastError = `Plus faible ${r.id} : ${r.error}`;
  }
  if (!sentMessages.length) { if (orig) orig.weakRelayed = false; return false; }
  b.sentCount = (b.sentCount || 0) + 1;
  b.lastSentAt = Date.now();
  b.lastSuit = String(syn.suit); // mémoire du dernier costume envoyé (anti-doublon)
  if (Number.isFinite(Number(syn.target))) b.lastTarget = Number(syn.target);
  panel.pendingMessages.push({
    id: `w-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    trackerId: tracker.id, mirror: true, weak: true, // relais : ne compte pas deux fois dans les scores
    target: syn.target, suit: syn.suit, strategyName: 'Prédiction du plus faible',
    format: b.format, maxR: b.maxR, step: 0, gap: 0, skipped: 0,
    status: 'en attente', messages: sentMessages, createdAt: Date.now(), resolvedAt: null,
  });
  persist();
  return true;
}
function relayNewWeak(tracker) {
  try {
    const b = panel.weak;
    if (!b.enabled || !b.channels.length) return;
    const today = bestDayKey();
    let orig = null;
    for (let i = panel.pendingMessages.length - 1; i >= 0; i--) {
      const e = panel.pendingMessages[i];
      if (!e.mirror && e.trackerId === tracker.id && e.status === 'en attente' && !e.step && !e.weakRelayed && bestDayKey(e.createdAt) === today) { orig = e; break; }
    }
    if (!orig) return;
    // la prédiction est choisie et marquée « relayée » tout de suite (avant tout await) ; l'envoi attend le jeu suivant
    const synR = { target: orig.target, suit: orig.suit };
    if (weakDelayOn()) { holdWeak(tracker, synR, orig); return; } // attend le démarrage du jeu suivant, puis envoi automatique
    postToWeak(tracker, synR, orig)
      .catch((e) => { panel.lastError = `Plus faible : ${e.message}`; });
  } catch (e) { panel.lastError = `Plus faible : ${e.message}`; }
}
async function forwardToWeak(tracker, syn) {
  const b = panel.weak;
  if (!b.enabled || !b.channels.length) return false;
  rollWeakDay();
  const best = currentWeak();
  if (best && String(panel.best.currentTrackerId) === String(best.id)) return false; // jamais la meilleure
  if (!best || best.id !== tracker.id) return false; // ce n'est pas la meilleure configuration
  const orig = findOriginalEntry(tracker, syn);
  if (orig && orig.weakRelayed) return false; // déjà relayée (par le changement de meilleur)
  // même costume que la précédente ET numéros qui se suivent (écart < 2) : ignorée. Écart d'au moins 2 : envoyée.
  const tNum = Number(syn.target);
  const sameSuit = !!b.lastSuit && String(b.lastSuit) === String(syn.suit);
  const near = Number.isFinite(tNum) && Number.isFinite(b.lastTarget) && Math.abs(tNum - b.lastTarget) < 2;
  if (Number.isFinite(tNum)) b.lastTarget = tNum; // dernier numéro prédit par le meilleur (envoyé ou ignoré)
  if (sameSuit && near) { b.skippedSame = (b.skippedSame || 0) + 1; return false; }
  if (weakDelayOn()) { holdWeak(tracker, syn, orig); return true; }
  return postToWeak(tracker, syn, orig);
}
async function handleWeakMemberUpdate(u) {
  const b = panel.weak;
  if (!b.enabled || !b.welcome || !b.channels.length || !u || !u.chat || !u.new_chat_member) return false;
  const nm = u.new_chat_member; const old = u.old_chat_member || {};
  const joined = ['member', 'administrator', 'creator'].includes(nm.status) && ['left', 'kicked'].includes(old.status);
  if (!joined || !nm.user || nm.user.is_bot || !isWeakChat(u.chat)) return false;
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return false;
  const k = `${u.chat.id}:${nm.user.id}`;
  const now = Date.now();
  if (welcomeSeen.has(k) && now - welcomeSeen.get(k) < 10 * 60 * 1000) return false; // pas de double message
  welcomeSeen.set(k, now);
  if (welcomeSeen.size > 500) for (const [kk, t] of welcomeSeen) if (now - t > 10 * 60 * 1000) welcomeSeen.delete(kk);
  const title = u.chat.title || panel.channelTitles[String(u.chat.id)] || String(u.chat.id);
  if (u.chat.title) setChannelTitle(u.chat.id, u.chat.title);
  const fullName = [nm.user.first_name, nm.user.last_name].filter(Boolean).join(' ').trim() || nm.user.username || 'Nouveau membre';
  try { await bot.sendMessage(u.chat.id, welcomeTextWeak(fullName, title)); return true; }
  catch (e) { panel.lastError = `Bienvenue ${u.chat.id} : ${e.message}`; return false; }
}
async function testWeakWelcome() {
  const b = panel.weak;
  if (!b.channels.length) return { ok: false, error: 'Aucun canal du plus faible configuré' };
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  const out = { ok: false, channel: String(b.channels[0]) };
  try {
    const me = await bot.getMe();
    const chat = await bot.getChat(b.channels[0]);
    out.chatType = chat.type;
    const mem = await bot.getChatMember(chat.id, me.id);
    out.botStatus = mem.status; out.canPost = mem.can_post_messages; out.canInvite = mem.can_invite_users;
    const title = chat.title || panel.channelTitles[String(chat.id)] || String(chat.id);
    const m = await bot.sendMessage(chat.id, `🧪 TEST — ${welcomeTextWeak('Prénom Nom', title)}`);
    if (m && m.skipped) out.error = 'Envoi ignoré : les prédictions de ce canal sont en pause (/stop)';
    else out.ok = true;
  } catch (e) { out.error = e.message; }
  return out;
}
function weakDelayOn() { return panel.weak.delayEnabled !== false && sendDelay.enabled(); }
function currentWeak(now = Date.now(), reason) {
  const w = panel.weak;
  const ranked = rankedToday(now);
  if (ranked.length >= 2) {
    const pick = ranked[Math.min(sanitizeWeakRank(w.rank) - 1, ranked.length - 1)];
    const cur = ranked.find((r) => r.t.id === w.currentTrackerId);
    const clash = !!w.currentTrackerId && String(w.currentTrackerId) === String(panel.best.currentTrackerId);
    if (!cur || clash || compareQuality(pick, cur) !== 0) {
      const prevId = w.currentTrackerId;
      if (prevId !== pick.t.id) { w.currentTrackerId = pick.t.id; w.switchedAt = Date.now(); notifyWeakChange(prevId, pick, ranked, reason); w.lastSuit = null; w.lastTarget = null; relayNewWeak(pick.t); }
    }
  }
  return panel.trackers.find((t) => t.id === w.currentTrackerId) || null;
}
const handleBestMemberUpdate = handleMemberUpdate;
async function handleMemberUpdateAll(u) {
  let a = false; let b = false;
  try { a = await handleBestMemberUpdate(u); } catch (_) { /* ignoré */ }
  try { b = await handleWeakMemberUpdate(u); } catch (_) { /* ignoré */ }
  return a || b;
}


// « Meilleur + plus faible » (best-weak-top.js) : transmet la prédiction si cette configuration est la meilleure
// ou la plus faible du moment, avec son pourcentage de réussite du jour.
function bwRankOfRef(ref) {
  const ranked = rankedToday();
  const b = currentBest(); const w = currentWeak();
  if (b && b.id === ref) return 1;
  if (w && w.id === ref) return 4;
  const rest = ranked.filter((r) => r.t.id !== (b && b.id) && r.t.id !== (w && w.id));
  const i = rest.findIndex((r) => r.t.id === ref);
  return i === 0 ? 2 : (i === 1 ? 3 : null);
}
async function comboHook(tracker, syn) {
  const bw = require('./best-weak-top');
  if (!bw.hasEnabled('dizaine')) return;
  bw.setPctProvider('dizaine', (ref) => { const r = rankedToday().find((x) => x.t.id === ref); return r ? r.rate * 100 : null; });
  const ranked = rankedToday();
  const pctOf = (t) => { const r = ranked.find((x) => x.t.id === t.id); return r ? r.rate * 100 : null; };
  const rank = bwRankOfRef(tracker.id); // 1 = meilleur, 4 = plus faible, 2 et 3 = les suivants du classement du jour
  if (rank) await bw.record('dizaine', rank, { target: syn.target, suit: syn.suit, ref: tracker.id, pct: pctOf(tracker) });
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
  // canal des meilleures prédictions : relais si cette configuration est la meilleure du moment
  try { await forwardToBest(tracker, syn); } catch (e) { panel.lastError = `Meilleures prédictions : ${e.message}`; }
  try { await forwardToWeak(tracker, syn); } catch (e) { panel.lastError = `Plus faible : ${e.message}`; }
  try { await comboHook(tracker, syn); } catch (_) { /* jamais bloquant */ }
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

// step = rattrapage auquel la victoire a eu lieu (0 = ✅0️⃣, 1 = ✅1️⃣…) : sert au départage
// des configurations à taux égal (moyenne des rattrapages, voir compareQuality).
// relais vers le canal des meilleures : jamais compté dans les scores des configurations,
// mais il alimente le récapitulatif de CE canal (All games / Won / Lost)
function bumpEntry(entry, field, step = 0) {
  if (!entry.mirror) { try { require('./best-weak-top').recordResult('dizaine', entry.trackerId, field, step); } catch (_) { /* jamais bloquant */ } }
  if (entry.mirror) {
    if (entry.best) {
      rollBestDay();
      if (!entry.createdAt || bestDayKey(entry.createdAt) === panel.best.day) { panel.best[field] = (panel.best[field] || 0) + 1; persist(); }
    }
    if (entry.weak) {
      rollWeakDay();
      if (!entry.createdAt || bestDayKey(entry.createdAt) === panel.weak.day) { panel.weak[field] = (panel.weak[field] || 0) + 1; persist(); }
    }
    return;
  }
  bumpScore(entry.trackerId, field, step);
  recalcBest(entry);
}

// Perte du meilleur actuel : classement recalculé tout de suite, en silence (rien n'est posté dans le canal des
// meilleures ; seule l'alerte privée à l'admin part si le meilleur change). Si l'ancien meilleur reste premier,
// il continue d'envoyer ; sinon c'est la prochaine prédiction du nouveau meilleur qui part.
// Après CHAQUE résultat (victoire ou perte, de n'importe quelle configuration) : le meilleur est recalculé tout de suite ;
// s'il change, la prédiction en cours du nouveau meilleur part aussitôt dans le canal des meilleures.
function recalcBest(entry) {
  try { currentBest(Date.now(), `résultat sur #N${entry.target}`); } catch (_) { /* jamais bloquant */ }
  try { currentWeak(Date.now(), `résultat sur #N${entry.target}`); } catch (_) { /* jamais bloquant */ }
}
function recalcAfterLoss(entry) {
  try {
    if (panel.best.currentTrackerId === entry.trackerId) currentBest(Date.now(), `perte du meilleur sur #N${entry.target}`);
  } catch (_) { /* jamais bloquant */ }
}

function bumpScore(trackerId, field, step = 0) {
  const t = panel.trackers.find((x) => x.id === trackerId);
  if (!t) return;
  t[field] = (t[field] || 0) + 1;
  rollDay(t); // compteur de la journée (bilan)
  t.day[field] = (t.day[field] || 0) + 1;
  if (field === 'wins') {
    t.day.rsum = (t.day.rsum || 0) + (Number(step) || 0);
    if (!Number(step)) t.day.d0 = (t.day.d0 || 0) + 1; // victoire du premier coup
    t.day.streak = (t.day.streak || 0) + 1;
  } else if (field === 'losses') t.day.streak = 0;
  trackDayResult(t.day, field, step);
  bumpSeg(t, field, step); // compteur du bilan (remis à zéro à chaque envoi)
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
        bumpEntry(entry, 'wins', entry.step);
        editPending(entry, 'gagné');
        break;
      }
      if (entry.step >= entry.maxR) {
        entry.status = 'perdu'; entry.resolvedAt = Date.now();
        bumpEntry(entry, 'losses');
        editPending(entry, 'perdu');
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

// ---------------------------------------------------------------------------
// BILAN périodique
// ---------------------------------------------------------------------------
const BILAN_TZ = process.env.RESET_TZ || 'Africa/Abidjan'; // journée du bilan : 00h00 heure d'Abidjan (comme le nouveau départ)

function localParts(ms) {
  const f = new Intl.DateTimeFormat('fr-FR', {
    timeZone: BILAN_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const o = {};
  for (const x of f) o[x.type] = x.value;
  return { y: o.year, m: o.month, d: o.day, h: Number(o.hour) };
}
const dayKeyOf = (ms) => { const p = localParts(ms); return `${p.y}-${p.m}-${p.d}`; };

// bascule de journée : le jour écoulé devient « veille », un nouveau jour démarre
function rollDay(t, now = Date.now()) {
  const key = dayKeyOf(now);
  if (!t.day) t.day = { date: key, wins: 0, losses: 0, rsum: 0, d0: 0, streak: 0, rmax: 0, lrun: 0, lmax: 0, smax: 0 };
  else if (t.day.date !== key) { t.prevDay = t.day; t.day = { date: key, wins: 0, losses: 0, rsum: 0, d0: 0, streak: 0, rmax: 0, lrun: 0, lmax: 0, smax: 0 }; }
}
function dayStats(t, key) {
  const d = [t.day, t.prevDay].find((x) => x && x.date === key);
  return d
    ? { wins: d.wins, losses: d.losses, total: d.wins + d.losses, rsum: d.rsum || 0, d0: d.d0 || 0, streak: d.streak || 0, rmax: d.rmax || 0, lmax: d.lmax || 0, smax: d.smax || 0 }
    : { wins: 0, losses: 0, total: 0, rsum: 0, d0: 0, streak: 0, rmax: 0, lmax: 0, smax: 0 };
}

// Suivi par journée des critères de départage « fins » (remis à zéro avec la journée) :
//   rmax = pire rattrapage d'une victoire (✅2️⃣ > ✅1️⃣ > ✅0️⃣), lrun/lmax = série de pertes en cours / pire série,
//   smax = meilleure série de victoires. Appelé APRÈS la mise à jour de day.streak.
function trackDayResult(d, field, step = 0) {
  if (!d) return;
  if (field === 'wins') {
    d.rmax = Math.max(d.rmax || 0, Number(step) || 0);
    d.lrun = 0;
    d.smax = Math.max(d.smax || 0, d.streak || 0);
  } else if (field === 'losses') {
    d.lrun = (d.lrun || 0) + 1;
    d.lmax = Math.max(d.lmax || 0, d.lrun);
  }
}

// ---------------------------------------------------------------------------
// COMPTEUR DU BILAN (« segment ») : repart de ZÉRO à chaque bilan réellement envoyé.
// Il est distinct du compteur de la journée (day) qui sert au classement du jour et au choix
// des meilleures prédictions : ce dernier n'est PAS touché par l'envoi du bilan.
// À l'envoi, le segment est « gelé » (le texte de tous les canaux est calculé dessus) et un
// segment neuf démarre aussitôt : les résultats qui arrivent pendant l'envoi comptent déjà
// pour le bilan suivant. Si rien n'a pu être envoyé, le segment gelé est remis en place.
// ---------------------------------------------------------------------------
function emptySeg() { return { date: null, wins: 0, losses: 0, rsum: 0, d0: 0, streak: 0, rmax: 0, lrun: 0, lmax: 0, smax: 0 }; }
function normSeg(d) {
  return d && typeof d === 'object'
    ? { date: null, wins: Number(d.wins) || 0, losses: Number(d.losses) || 0, rsum: Number(d.rsum) || 0, d0: Number(d.d0) || 0, streak: Number(d.streak) || 0, rmax: Number(d.rmax) || 0, lrun: Number(d.lrun) || 0, lmax: Number(d.lmax) || 0, smax: Number(d.smax) || 0 }
    : null;
}
function segOf(h) { if (!h.seg) h.seg = emptySeg(); return h.seg; }
function bumpSeg(h, field, step = 0) {
  const s = segOf(h);
  s[field] = (s[field] || 0) + 1;
  if (field === 'wins') {
    s.rsum = (s.rsum || 0) + (Number(step) || 0);
    if (!Number(step)) s.d0 = (s.d0 || 0) + 1; // victoire du premier coup
    s.streak = (s.streak || 0) + 1;
  } else if (field === 'losses') s.streak = 0;
  trackDayResult(s, field, step);
}
function segStatsOf(d) {
  d = d || emptySeg();
  return { wins: d.wins, losses: d.losses, total: d.wins + d.losses, rsum: d.rsum || 0, d0: d.d0 || 0, streak: d.streak || 0, rmax: d.rmax || 0, lmax: d.lmax || 0, smax: d.smax || 0 };
}
// fusion de deux segments (utilisée seulement si l'envoi du bilan a échoué partout)
function mergeSeg(a, b) {
  a = a || emptySeg(); b = b || emptySeg();
  const hasB = (b.wins + b.losses) > 0;
  return {
    date: null,
    wins: a.wins + b.wins, losses: a.losses + b.losses, rsum: (a.rsum || 0) + (b.rsum || 0), d0: (a.d0 || 0) + (b.d0 || 0),
    streak: hasB ? b.streak : a.streak, lrun: hasB ? b.lrun : a.lrun,
    rmax: Math.max(a.rmax || 0, b.rmax || 0), lmax: Math.max(a.lmax || 0, b.lmax || 0), smax: Math.max(a.smax || 0, b.smax || 0),
  };
}
function freezeSeg() {
  const frozen = { since: panel.bilan.segSince || null, map: new Map() };
  for (const { key, holder } of segHolders()) { frozen.map.set(key, holder.seg || emptySeg()); holder.seg = emptySeg(); }
  panel.bilan.segSince = Date.now();
  return frozen;
}
function restoreSeg(frozen) {
  for (const { key, holder } of segHolders()) {
    const f = frozen.map.get(key);
    if (f) holder.seg = mergeSeg(f, holder.seg);
  }
  panel.bilan.segSince = frozen.since;
}
// libellé « depuis quand » du compteur (heure locale du bilan ; avec la date si ce n'est pas aujourd'hui)
function sinceLabel(ms, now = Date.now()) {
  if (!ms) return 'le début';
  const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: BILAN_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const o = {}; for (const x of parts) o[x.type] = x.value;
  const hm = `${o.hour}h${o.minute}`;
  if (dayKeyOf(ms) === dayKeyOf(now)) return hm;
  const [, mm, dd] = dayKeyOf(ms).split('-');
  return `${dd}/${mm} ${hm}`;
}
function segHolders() { return panel.trackers.map((t) => ({ key: t.id, holder: t })); }

// Qualité d'une configuration : 1) taux de réussite, 2) à taux égal, MOYENNE DES RATTRAPAGES
// des victoires (✅0️⃣ = 0, ✅1️⃣ = 1…) : la plus petite moyenne est la meilleure.
// Comparaisons par produits en croix (exactes, sans erreur d'arrondi).
// 3) 1ers coups, 4) série en cours, 5) pire rattrapage, 6) pire série de pertes, 7) meilleure série de victoires.
// Retour : < 0 si a est meilleure que b, > 0 si b est meilleure, 0 si égalité parfaite.
function compareQuality(a, b) {
  const rate = (a.wins * b.total) - (b.wins * a.total); // > 0 : a a un meilleur taux
  if (a.total && b.total && rate !== 0) return rate > 0 ? -1 : 1;
  if (!a.wins || !b.wins) return 0; // pas de victoire : pas de moyenne à comparer
  const avg = (a.rsum * b.wins) - (b.rsum * a.wins); // < 0 : a a une plus petite moyenne
  if (avg !== 0) return avg < 0 ? -1 : 1;
  // 3) à taux ET moyenne égaux : plus de victoires DU PREMIER COUP (rapportées au nombre de prédictions)
  const d0 = ((a.d0 || 0) * b.total) - ((b.d0 || 0) * a.total);
  if (d0 !== 0) return d0 > 0 ? -1 : 1;
  // 4) encore égaux : la plus longue série de victoires EN COURS (meilleure forme du moment)
  const st = (a.streak || 0) - (b.streak || 0);
  if (st !== 0) return st > 0 ? -1 : 1;
  // 5) encore égaux : le pire rattrapage de la journée (celle qui n'a jamais eu besoin d'un rattrapage plus lourd)
  const rm = (a.rmax || 0) - (b.rmax || 0);
  if (rm !== 0) return rm < 0 ? -1 : 1;
  // 6) encore égaux : la plus petite pire série de pertes (la plus régulière)
  const lm = (a.lmax || 0) - (b.lmax || 0);
  if (lm !== 0) return lm < 0 ? -1 : 1;
  // 7) encore égaux : la meilleure série de victoires de la journée
  const sm = (a.smax || 0) - (b.smax || 0);
  return sm > 0 ? -1 : sm < 0 ? 1 : 0;
}
// Classement complet : qualité, puis plus de prédictions, puis plus de victoires.
// Égalité TOTALE sur tous les critères : le meilleur actuel garde la 1re place (cohérent avec currentBest),
// sinon ordre stable par identifiant : il n'y a plus jamais deux « premiers ».
const rowKey = (r) => String(r.c ? r.c.key : r.t.id);
function holderFirst(a, b) {
  const cur = String(panel.best.currentTrackerId || '');
  const ka = rowKey(a); const kb = rowKey(b);
  if (ka === cur && kb !== cur) return -1;
  if (kb === cur && ka !== cur) return 1;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
function compareRanking(a, b) {
  return compareQuality(a, b) || (b.total - a.total) || (b.wins - a.wins) || holderFirst(a, b);
}
const avgRattrapage = (r) => (r.wins ? (r.rsum / r.wins).toFixed(2).replace('.', ',') : '—');

const NUM_EMOJI = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const pct = (w, n) => (n ? `${((w / n) * 100).toFixed(1).replace('.', ',')} %` : '—');

// Barre de progression (10 cases) ; la couleur suit le taux de réussite.
function progressBar(rate, size = 10) {
  const filled = Math.max(0, Math.min(size, Math.round(rate * size)));
  const on = rate >= 0.8 ? '🟩' : rate >= 0.5 ? '🟨' : '🟥';
  return on.repeat(filled) + '⬜'.repeat(size - filled);
}
// Nom affiché = uniquement le(s) canal(aux), jamais le nom de la stratégie.
const channelLabel = (r) => (r.names.length ? r.names.join(' + ') : 'Canal sans nom');

function trackerChannelNames(t, siteList) {
  const names = [];
  for (const id of t.channels || []) names.push(panel.channelTitles[String(id)] || String(id));
  if (t.siteChannelId) {
    const sc = siteList.find((c) => String(c.id) === String(t.siteChannelId));
    names.push(sc && sc.name ? sc.name : `canal du site ${t.siteChannelId}`);
  }
  return names;
}

// Texte du bilan. reportKey = jour concerné ; label = ligne d'en-tête.
function buildBilanText(now = Date.now(), forceToday = false, frozen = null) {
  const lp = localParts(now);
  const slotH = Math.floor(lp.h / panel.bilan.everyHours) * panel.bilan.everyHours;
  // au point de minuit (00h) : bilan de la journée qui vient de se terminer
  const closing = !forceToday && slotH === 0;
  const reportKey = dayKeyOf(closing ? now - 30 * 60 * 1000 : now);
  const [ry, rm, rd] = reportKey.split('-');
  const hh = String(slotH).padStart(2, '0');
  const siteList = siteChannelsView();
  const min = panel.bilan.minPreds;
  const rows = panel.trackers.map((t) => {
    const st = dayStats(t, reportKey); // cumul de la journée : remis à zéro uniquement à 00h00 (Abidjan)
    return { t, ...st, names: trackerChannelNames(t, siteList), rate: st.total ? st.wins / st.total : 0 };
  }).filter((r) => r.total > 0 || forceToday);
  const ranked = rows.filter((r) => r.total >= min)
    .sort(compareRanking);
  const pending = rows.filter((r) => r.total < min && r.total > 0);
  if (!rows.some((r) => r.total > 0)) return null;
  const lines = [];
  lines.push('📊 BILAN — DIZAINE (costume le plus / le moins sorti)');
  const endLbl = forceToday ? sinceLabel(now, now) : `${hh}h00`; // envoi manuel : heure réelle
  lines.push(`🕑 Point de ${endLbl} · ${rd}/${rm}/${ry}`);
  lines.push(`📆 Cumul depuis 00h00 (heure d'Abidjan) · remis à zéro uniquement à 00h00`);
  lines.push('━━━━━━━━━━━━━━━━━━');
  if (ranked.length) {
    const best = ranked[0];
    lines.push(`🏆 Meilleur canal : « ${channelLabel(best)} »`);
    lines.push(`${progressBar(best.rate)} ${pct(best.wins, best.total)}`);
    lines.push(`📈 ${best.wins} ✅ · ${best.losses} ❌ sur ${best.total} prédiction${best.total > 1 ? 's' : ''}`);
    lines.push(`🎯 Rattrapage moyen : ${avgRattrapage(best)}`);
    if (panel.best.enabled && panel.best.channels.length) {
      lines.push('');
      lines.push('🎯 Meilleures prédictions envoyées actuellement dans :');
      for (const id of panel.best.channels) {
        const nm = panel.channelTitles[String(id)] || String(id);
        const lk = (panel.best.link && String(id) === String(panel.best.channels[0])) ? panel.best.link : channelLinkOf(id);
        lines.push(`    📣 « ${nm} »${lk ? `\n    🔗 ${lk}` : ''}`);
      }
      lines.push(`    Taux du meilleur canal : ${pct(best.wins, best.total)} (${best.wins}/${best.total})`);
    }
    lines.push('');
    lines.push('📋 Classement');
    ranked.slice(0, 15).forEach((r, i) => {
      lines.push(`${NUM_EMOJI[i] || `${i + 1}.`} ${channelLabel(r)}`);
      lines.push(`    ${progressBar(r.rate)} ${pct(r.wins, r.total)} · ${r.wins}/${r.total} · moy. ${avgRattrapage(r)} · 1er coup ${r.d0 || 0}`);
    });
  } else {
    lines.push(`ℹ️ Aucun canal n'a encore ${min} prédictions vérifiées : pas de classement pour l'instant.`);
  }
  if (pending.length) {
    lines.push('');
    lines.push('⏳ Pas assez de données');
    pending.slice(0, 10).forEach((r) => lines.push(`• ${channelLabel(r)} — ${progressBar(r.total / min, 5)} ${r.total}/${min}`));
  }
  lines.push('━━━━━━━━━━━━━━━━━━');
  return lines.join('\n');
}

// canaux destinataires : tous ceux des configurations actives (dédoublonnés)
function bilanTargets() {
  const tg = []; const site = [];
  for (const t of panel.trackers) {
    if (t.enabled === false) continue;
    for (const id of t.channels || []) if (!tg.some((x) => String(x) === String(id))) tg.push(id);
    if (t.siteChannelId && !site.includes(String(t.siteChannelId))) site.push(String(t.siteChannelId));
  }
  return { tg, site };
}

// Rafraîchit TOUJOURS les noms réels des canaux (getChat) juste avant l'envoi :
// un ancien nom en cache (canal renommé, nom saisi à la main) ne reste plus affiché.
// Si getChat échoue, on garde le dernier nom connu.
async function refreshChannelTitles(ids) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot || typeof bot.getChat !== 'function') return;
  const uniq = [...new Set(ids.map((id) => String(id)))];
  await Promise.all(uniq.map(async (id) => {
    try {
      const chat = await bot.getChat(id);
      const title = chat && (chat.title || chat.username || chat.first_name);
      if (title && panel.channelTitles[id] !== String(title).slice(0, 120)) setChannelTitle(id, title);
      // lien : canal public (@nom) sinon lien d'invitation déjà connu de Telegram (jamais d'en créer un)
      const link = chat && (chat.username ? `https://t.me/${chat.username}` : (chat.invite_link || null));
      if (link && panel.channelLinks[id] !== link) { panel.channelLinks[id] = link; persist(); }
    } catch (_) { /* on garde le dernier nom connu (ou l'ID) */ }
  }));
}

async function sendBilan({ force = false, now = Date.now() } = {}) {
  const { tg, site } = bilanTargets();
  if (!tg.length && !site.length) return { ok: false, error: 'Aucun canal configuré' };
  // tous les canaux des configurations (même désactivées) apparaissent dans le classement
  const allIds = panel.trackers.flatMap((t) => t.channels || []);
  await refreshChannelTitles([...tg, ...allIds, ...(panel.best.enabled ? panel.best.channels : []), ...(panel.weak.enabled ? panel.weak.channels : [])]);
  if (!buildBilanText(now, force)) return { ok: false, error: "Aucune prédiction vérifiée aujourd'hui : bilan non envoyé" };
  // le cumul de la journée n'est jamais remis à zéro par l'envoi (seulement à 00h00)
  try {
  const text = buildBilanText(now, force);
  const bot = typeof sender === 'function' ? sender() : null;
  const sent = []; const errors = [];
  if (tg.length) {
    if (!bot) errors.push('Aucun token Telegram configuré');
    else {
      const res = await Promise.all(tg.map((id) => bot.sendMessage(id, text)
        .then((m) => (m && m.skipped ? { skipped: true } : { ok: true, id }))
        .catch((e) => ({ id, error: e.message }))));
      for (const r of res) { if (r.ok) sent.push(String(r.id)); else if (!r.skipped) errors.push(`${r.id} : ${r.error}`); }
    }
  }
  for (const id of site) { if (addSiteChannelMessage(id, { sender: 'Bilan Dizaine', text })) sent.push(`site:${id}`); }
  panel.bilan.lastSentAt = Date.now();
  panel.bilan.lastResult = { sent: sent.length, errors: errors.slice(0, 3), at: Date.now() };
  try { persist(); } catch (_) { /* sauvegarde best-effort */ }
  return { ok: sent.length > 0, sent, errors, text };
  } finally { /* rien à restaurer */ }
}

async function bilanTick(now = Date.now()) {
  for (const t of panel.trackers) rollDay(t, now);
  const b = panel.bilan;
  if (!b.enabled) return;
  const lp = localParts(now);
  const slotH = Math.floor(lp.h / b.everyHours) * b.everyHours;
  const slot = `${lp.y}-${lp.m}-${lp.d}T${String(slotH).padStart(2, '0')}`;
  if (b.lastSlot === null) { b.lastSlot = slot; return; } // première activation : on attend le prochain point
  if (b.lastSlot === slot) return;
  b.lastSlot = slot; // marqué avant l'envoi : jamais deux fois le même point
  try { await sendBilan({ now }); } catch (e) { panel.lastError = e.message; }
}

// Envoi À L'HEURE PILE : minuteur dédié (ne dépend pas du rythme du scan).
// Il se réarme sur chaque début d'heure ; bilanTick() ne l'envoie qu'une fois par point.
let bilanTimer = null;
function armBilanTimer() {
  if (bilanTimer) clearTimeout(bilanTimer);
  const HOUR = 3600 * 1000;
  const wait = HOUR - (Date.now() % HOUR) + 300; // +0,3 s : on est sûr d'être dans la nouvelle heure
  bilanTimer = setTimeout(async () => {
    try { await bilanTick(); } catch (e) { panel.lastError = e.message; } finally { persist(); armBilanTimer(); }
  }, wait);
  if (bilanTimer.unref) bilanTimer.unref();
}
armBilanTimer();

async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    rollBestDay(); rollWeakDay();
    for (const tracker of panel.trackers) await processTracker(tracker);
    await verifyPending();
    await bilanTick();
    await maybeSendRecap();
    await maybeSendRecapWeak();
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
    bilan: { ...panel.bilan, tz: BILAN_TZ },
    best: {
      ...panel.best,
      currentName: (panel.trackers.find((t) => t.id === panel.best.currentTrackerId) || {}).name || null,
      channelNames: panel.best.channels.map((id) => panel.channelTitles[String(id)] || String(id)),
      channelLinks: panel.best.channels.map((id, k) => (k === 0 && panel.best.link) ? panel.best.link : channelLinkOf(id)),
    },
    weak: {
      ...panel.weak,
      currentName: (panel.trackers.find((t) => t.id === panel.weak.currentTrackerId) || {}).name || null,
      channelNames: panel.weak.channels.map((id) => panel.channelTitles[String(id)] || String(id)),
      channelLinks: panel.weak.channels.map((id, k) => (k === 0 && panel.weak.link) ? panel.weak.link : channelLinkOf(id)),
    },
    lastMember,
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
  sendBilan, buildBilanText, bilanTick, rollDay, compareQuality, compareRanking,
};

// exposé pour l'effacement de minuit (midnight-reset.js)
module.exports.persist = persist;
module.exports.send = send;
module.exports.currentBest = currentBest;
module.exports.setAdminId = setAdminId;
module.exports.handleMemberUpdate = handleMemberUpdateAll;
module.exports.testWeakWelcome = testWeakWelcome;
module.exports.currentWeak = currentWeak;
module.exports.welcomeText = welcomeText;
module.exports.testWelcome = testWelcome;
module.exports.bumpEntry = bumpEntry;
try { require('./best-weak-top').setRankProvider('dizaine', bwRankOfRef); } catch (_) { /* module facultatif */ }
