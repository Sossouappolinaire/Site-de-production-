// suit-streak.js — nouveau bouton « Série de costume » (demande admin) :
// système INDÉPENDANT de « Prédit après une perte » (after-loss.js) et de
// « Combinaisons » (combined.js), avec une sémantique différente des deux :
//
//  • On sélectionne UNE source : n'importe quelle stratégie existante, la
//    stratégie IA « Prédit », OU une Formation (formation-relay.js — même
//    logique de fiabilité que dans combined.js, voir formationOptions()).
//  • On définit N = nombre de prédictions CONSÉCUTIVES de MÊME COSTUME (peu
//    importe si elles ont été gagnées ou perdues) à observer avant de
//    déclencher. Une prédiction d'un AUTRE costume casse la série en cours
//    et en démarre une nouvelle avec ce nouveau costume.
//  • Dès que la série atteint N :
//      - Si AUCUNE des N prédictions de la série n'a été perdue → on
//        déclenche IMMÉDIATEMENT : on prédit le MÊME costume, soit sur le
//        jeu qui suit directement la dernière occurrence (mode « jeu
//        suivant », target+1), soit sur target+Z (mode « décalage », Z
//        réglable).
//      - Si AU MOINS UNE des N prédictions de la série a été perdue → on ne
//        déclenche PAS tout de suite. On attend que la source prédise à
//        nouveau CE MÊME costume (une prochaine fois, peu importe quand),
//        et c'est CETTE occurrence-là qui déclenche (une seule fois), avec
//        le même choix jeu suivant / +Z.
//  • Exemple : source prédit ♦️ au jeu 2 (résultat gagné ou perdu), puis ♦️
//    au jeu 4 (résultat gagné ou perdu) — série de 2 même costume atteinte.
//    S'il n'y a eu aucune perte parmi les deux : on prédit ♦️ immédiatement
//    (jeu 5 en mode « jeu suivant », ou jeu 4+Z en mode décalage). S'il y a
//    eu une perte parmi les deux : on ne prédit rien pour l'instant — on
//    attend que la source reprédise ♦️ une prochaine fois (même si elle
//    prédit d'autres costumes entre-temps, ex. ❤️ au jeu 7 — ça ne compte
//    pas, on attend spécifiquement le retour de ♦️) et c'est CE moment-là
//    qui déclenche.
//  • Toujours sur la main du JOUEUR : vérification via hasSuit(), jamais
//    hasSuitBanker() (comme combined.js).
'use strict';

const strategies = require('./strategies');
const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const { state, hasSuit, addSiteChannelMessage, siteChannelsView, setOnShoeReset } = require('./predictor');
const predit = require('./predit');
const formationRelay = require('./formation-relay');

const panel = {
  enabled: true,
  channels: [],
  siteChannelId: null,
  format: 1,
  maxR: 1,
  trackers: [],
  pendingMessages: [],
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
// Configuration
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

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) panel.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.maxR !== undefined) panel.maxR = Math.max(0, Math.min(9, parseInt(patch.maxR, 10) || 0));
  persist();
  return config();
}

function config() {
  return {
    enabled: panel.enabled, channels: panel.channels, siteChannelId: panel.siteChannelId,
    format: panel.format, maxR: panel.maxR,
  };
}

// ---------------------------------------------------------------------------
// Sources disponibles — n'importe quelle stratégie existante, la stratégie
// IA « Prédit », les Formations, ET (comme after-loss.js/combined.js déjà
// bridés entre eux) les trackers « après perte » et les combos.
// Require() PARESSEUX de after-loss.js/combined.js : ce fichier est un
// troisième panneau « frère » qui ne doit pas créer de cycle avec eux
// (aucun des trois ne se requiert au chargement).
// ---------------------------------------------------------------------------
function afterLossOptions() {
  try {
    const afterLoss = require('./after-loss');
    return (afterLoss.panel.trackers || []).map((t) => ({ key: `after:${t.id}`, name: `Après perte — ${t.name}`, group: 'Après perte' }));
  } catch (_) { return []; }
}

function combinedOptions() {
  try {
    const combined = require('./combined');
    return (combined.panel.trackers || []).map((t) => ({ key: `combo:${t.id}`, name: `Combinaison — ${t.name}`, group: 'Combinaisons' }));
  } catch (_) { return []; }
}

function options() {
  const base = [
    ...strategies.LIST.map((s) => ({ key: s.key, name: s.name, group: 'Stratégies' })),
    { key: 'ia', name: 'Stratégie IA (Prédit)', group: 'Stratégies' },
  ];
  const formations = [
    ...strategies.LIST.map((s) => ({ key: `formation:${s.key}`, name: `Formation — ${s.name}`, group: 'Formations' })),
    { key: 'formation:ia', name: 'Formation — Prédit IA', group: 'Formations' },
  ];
  return [...base, ...formations, ...afterLossOptions(), ...combinedOptions()];
}

function optionByKey(key) {
  return options().find((o) => o.key === key) || null;
}

function baseKeyOf(key) {
  return key.startsWith('formation:') ? key.slice('formation:'.length) : key;
}

function isFormationSource(key) {
  return key.startsWith('formation:');
}

function trackerPredictions(key) {
  if (key.startsWith('after:')) {
    try { return require('./after-loss').pendingFor(key.slice('after:'.length)); } catch (_) { return []; }
  }
  if (key.startsWith('combo:')) {
    try { return require('./combined').pendingFor(key.slice('combo:'.length)); } catch (_) { return []; }
  }
  const base = baseKeyOf(key);
  if (base === 'ia') return [...predit.panel.predictions].sort((a, b) => a.target - b.target);
  return state.predictions.filter((p) => p.strategy === base).sort((a, b) => a.target - b.target);
}

function currentMaxTarget(key) {
  const list = trackerPredictions(key);
  return list.length ? list[list.length - 1].target : 0;
}

// ---------------------------------------------------------------------------
// Réglages d'une source suivie
// ---------------------------------------------------------------------------
function sanitizeN(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(2, Math.min(20, n)) : 2;
}

function sanitizeMode(value) {
  return value === 'offset' ? 'offset' : 'next'; // 'next' = target+1 ; 'offset' = target+offset
}

function sanitizeOffset(value) {
  const z = parseInt(value, 10);
  return Number.isFinite(z) ? Math.max(1, Math.min(20, z)) : 1;
}

function sanitizeTrackerFormat(value) {
  if (value === null || value === undefined || value === '') return null;
  return fmt.clampFormat(value);
}

function sanitizeTrackerMaxR(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(9, n)) : null;
}

function effectiveChannels(tracker) {
  return (tracker.channels && tracker.channels.length) ? tracker.channels : panel.channels;
}

function effectiveSiteChannelId(tracker) {
  return tracker.siteChannelId != null ? tracker.siteChannelId : panel.siteChannelId;
}

function effectiveFormat(tracker) {
  return tracker.format || panel.format;
}

function effectiveMaxR(tracker) {
  return (tracker.maxR === null || tracker.maxR === undefined) ? panel.maxR : tracker.maxR;
}

function postToSiteChannel(tracker, text) {
  const id = effectiveSiteChannelId(tracker);
  if (!id) return false;
  const entry = addSiteChannelMessage(id, { sender: tracker.name, text });
  return !!entry;
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const saved = {
    config: config(), trackers: panel.trackers, history: panel.history,
    pendingMessages: panel.pendingMessages, sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt,
  };
  try { store.patch({ suitStreak: saved }); } catch (_) {}
  if (db.ready) db.setSetting('suit_streak_state', JSON.stringify(saved)).catch((error) => { panel.lastError = error.message; });
}

function restore() {
  try {
    const saved = (store.read() || {}).suitStreak;
    if (saved) applySaved(saved);
  } catch (_) {}
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('suit_streak_state');
    if (raw) applySaved(JSON.parse(raw));
    else persist();
  } catch (_) { persist(); }
  return config();
}

function applySaved(saved) {
  if (saved.config) {
    panel.enabled = saved.config.enabled !== false;
    panel.channels = parseChannels(saved.config.channels);
    panel.siteChannelId = sanitizeSiteChannelId(saved.config.siteChannelId);
    panel.format = fmt.clampFormat(saved.config.format);
    panel.maxR = Math.max(0, Math.min(9, parseInt(saved.config.maxR, 10) || 0));
  }
  if (Array.isArray(saved.trackers)) {
    panel.trackers = saved.trackers.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name || (optionByKey(t.key) || {}).name || t.key,
      n: sanitizeN(t.n),
      mode: sanitizeMode(t.mode),
      offset: sanitizeOffset(t.offset),
      channels: Array.isArray(t.channels) ? parseChannels(t.channels) : [],
      siteChannelId: sanitizeSiteChannelId(t.siteChannelId),
      format: t.format ? fmt.clampFormat(t.format) : null,
      maxR: sanitizeTrackerMaxR(t.maxR),
      streakSuit: t.streakSuit || null,
      streakCount: Number.isFinite(Number(t.streakCount)) ? Number(t.streakCount) : 0,
      streakHasLoss: !!t.streakHasLoss,
      waitingSuit: t.waitingSuit || null,
      lastSeenTarget: Number.isFinite(Number(t.lastSeenTarget)) ? Number(t.lastSeenTarget) : 0,
      sentCount: Number.isFinite(Number(t.sentCount)) ? Number(t.sentCount) : 0,
      lastSentAt: t.lastSentAt || null,
      createdAt: t.createdAt || Date.now(),
    }));
  }
  if (Array.isArray(saved.history)) panel.history = saved.history.slice(0, 100);
  if (Array.isArray(saved.pendingMessages)) {
    const keep = [];
    let resolvedCount = 0;
    for (let i = saved.pendingMessages.length - 1; i >= 0; i--) {
      const e = saved.pendingMessages[i];
      if (e.status === 'en attente' || resolvedCount < 200) {
        keep.unshift(e);
        if (e.status !== 'en attente') resolvedCount += 1;
      }
    }
    panel.pendingMessages = keep;
  }
  if (Number.isFinite(Number(saved.sentCount))) panel.sentCount = Number(saved.sentCount);
  panel.lastSentAt = saved.lastSentAt || null;
  panel.lastScanAt = saved.lastScanAt || null;
}

// ---------------------------------------------------------------------------
// Gestion des sources suivies
// ---------------------------------------------------------------------------
function addTracker(key, extra = {}) {
  const opt = optionByKey(key);
  if (!opt) throw new Error('Source inconnue pour la série de costume.');
  const tracker = {
    id: `ss-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    key: opt.key,
    name: (extra.name && String(extra.name).trim()) || opt.name,
    n: sanitizeN(extra.n),
    mode: sanitizeMode(extra.mode),
    offset: sanitizeOffset(extra.offset),
    channels: parseChannels(extra.channels),
    siteChannelId: sanitizeSiteChannelId(extra.siteChannelId),
    format: sanitizeTrackerFormat(extra.format),
    maxR: sanitizeTrackerMaxR(extra.maxR),
    streakSuit: null,
    streakCount: 0,
    streakHasLoss: false,
    waitingSuit: null,
    // on ne rejoue pas l'historique déjà passé au moment de l'ajout.
    lastSeenTarget: currentMaxTarget(opt.key),
    sentCount: 0,
    lastSentAt: null,
    createdAt: Date.now(),
  };
  panel.trackers.push(tracker);
  persist();
  return tracker;
}

function updateTracker(id, patch = {}) {
  const tracker = panel.trackers.find((t) => t.id === id);
  if (!tracker) return null;
  if (patch.name !== undefined) {
    const clean = String(patch.name || '').trim();
    if (clean) tracker.name = clean;
  }
  if (patch.n !== undefined) tracker.n = sanitizeN(patch.n);
  if (patch.mode !== undefined) tracker.mode = sanitizeMode(patch.mode);
  if (patch.offset !== undefined) tracker.offset = sanitizeOffset(patch.offset);
  if (patch.n !== undefined || patch.mode !== undefined || patch.offset !== undefined) {
    // changement de réglage : on annule la série/l'attente en cours pour
    // repartir proprement sur les nouvelles règles.
    tracker.streakSuit = null;
    tracker.streakCount = 0;
    tracker.streakHasLoss = false;
    tracker.waitingSuit = null;
  }
  if (patch.channels !== undefined) tracker.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) tracker.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.format !== undefined) tracker.format = sanitizeTrackerFormat(patch.format);
  if (patch.maxR !== undefined) tracker.maxR = sanitizeTrackerMaxR(patch.maxR);
  persist();
  return tracker;
}

function removeTracker(id) {
  panel.trackers = panel.trackers.filter((t) => t.id !== id);
  persist();
  return true;
}

// ---------------------------------------------------------------------------
// Boucle de traitement — voir le commentaire en tête de fichier pour la
// règle complète (série de N même costume, mémoire de perte).
// ---------------------------------------------------------------------------
async function processTracker(tracker) {
  if (isFormationSource(tracker.key)) {
    const base = baseKeyOf(tracker.key);
    const trustKey = base === 'ia' ? 'predit' : base; // formation.js utilise la clé 'predit' pour le panneau IA
    const trust = formationRelay.formationTrusted(trustKey);
    if (!trust.ok) return; // formation pas (ou plus) fiable : on ne traite rien ce tour-ci
  }
  const list = trackerPredictions(tracker.key);
  for (const pred of list) {
    if (pred.target <= tracker.lastSeenTarget) continue;
    if (pred.status === 'en attente') break; // pas encore résolue : on la retraite au prochain tour
    tracker.lastSeenTarget = pred.target;
    const suit = pred.suit;
    if (!suit) continue; // ce panneau ne suit que les prédictions de costume (parité/cartes non gérées)

    // Une perte est déjà survenue dans une série précédente de ce costume :
    // on attend SPÉCIFIQUEMENT son retour, quel que soit le costume prédit
    // entre-temps (une prédiction d'un autre costume n'interrompt PAS cette
    // attente — voir le commentaire d'en-tête, exemple ❤️ au jeu 7).
    if (tracker.waitingSuit) {
      if (suit === tracker.waitingSuit) {
        await fire(tracker, pred);
        tracker.waitingSuit = null;
      }
      continue;
    }

    // comptage de la série de MÊME costume en cours (peu importe gagné/perdu) :
    if (suit === tracker.streakSuit) tracker.streakCount += 1;
    else { tracker.streakSuit = suit; tracker.streakCount = 1; tracker.streakHasLoss = false; }
    if (pred.status === 'perdu') tracker.streakHasLoss = true;

    if (tracker.streakCount >= tracker.n) {
      if (!tracker.streakHasLoss) {
        // aucune perte dans la série : on déclenche tout de suite.
        await fire(tracker, pred);
      } else {
        // au moins une perte dans la série : pas de déclenchement immédiat,
        // on attend que ce costume revienne (une seule fois, voir plus haut).
        tracker.waitingSuit = suit;
      }
      tracker.streakSuit = null;
      tracker.streakCount = 0;
      tracker.streakHasLoss = false;
    }
  }
}

async function fire(tracker, pred) {
  const target = pred.target + (tracker.mode === 'offset' ? tracker.offset : 1);
  await send(tracker, { target, suit: pred.suit, sourceTarget: pred.target });
}

function messageText(tracker, syn) {
  return fmt.renderMessage(effectiveFormat(tracker), {
    gameNumber: syn.target,
    suit: syn.suit,
    strategy: `${tracker.name} (série de costume)`,
    maxR: effectiveMaxR(tracker),
    status: 'en attente',
    rattrapage: 0,
  }, null);
}

async function send(tracker, syn) {
  const targetChannels = effectiveChannels(tracker);
  const siteChannelId = effectiveSiteChannelId(tracker);
  if (!targetChannels.length && !siteChannelId) {
    panel.lastError = `Aucun canal configuré pour « ${tracker.name} » (ni Telegram, ni canal du site, sur la source ou le panneau)`;
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
      for (const id of targetChannels) {
        try {
          const m = await bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {});
          sentMessages.push({ chatId: id, messageId: m.message_id });
          ok = true;
        } catch (e) { errors.push(`${id} : ${e.message}`); }
      }
    }
  }
  if (siteChannelId) {
    const posted = postToSiteChannel(tracker, out.text);
    if (posted) ok = true;
    else errors.push(`Canal du site introuvable (id ${siteChannelId})`);
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
    sourceTarget: syn.sourceTarget, sentAt: Date.now(),
  });
  panel.history = panel.history.slice(0, 100);
  if (sentMessages.length) {
    panel.pendingMessages.push({
      id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      trackerId: tracker.id, target: syn.target, suit: syn.suit, strategyName: tracker.name,
      format: effectiveFormat(tracker), maxR: effectiveMaxR(tracker), step: 0, gap: 0, skipped: 0,
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

// Vue « prédiction » des relais déjà envoyés par CE panneau, pour une source
// suivie donnée (trackerId) — même forme que les prédictions normales, pour
// être consommée à l'identique par after-loss.js/combined.js (bridge
// symétrique, clé `streak:<id>` côté de ces deux fichiers si besoin). Voir
// module.exports en bas de fichier.
function pendingFor(trackerId) {
  return panel.pendingMessages
    .filter((e) => e.trackerId === trackerId)
    .map((e) => ({ target: e.target, suit: e.suit, kind: 'suit', status: e.status, step: e.step, maxR: e.maxR }))
    .sort((a, b) => a.target - b.target);
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

function maxFinishedGameNumber() {
  let max = 0;
  for (const g of state.games.values()) if (g.finished && g.number > max) max = g.number;
  return max;
}

async function verifyPending() {
  const maxDone = maxFinishedGameNumber();
  for (const entry of panel.pendingMessages) {
    if (entry.status !== 'en attente') continue;
    let guard = 0;
    while (entry.status === 'en attente' && guard++ <= entry.maxR + entry.gap + 8) {
      const num = entry.target + entry.step + entry.gap;
      const g = state.games.get(num);
      const usable = !!g && g.finished && g.complete !== false;
      if (!usable) {
        if (num + 2 <= maxDone) {
          entry.gap += 1;
          entry.skipped = (entry.skipped || 0) + 1;
          if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); break; }
          continue;
        }
        break;
      }
      const won = hasSuit(g, entry.suit);
      if (won) { entry.status = 'gagné'; entry.resolvedAt = Date.now(); editPending(entry, 'gagné'); break; }
      if (entry.step >= entry.maxR) { entry.status = 'perdu'; entry.resolvedAt = Date.now(); editPending(entry, 'perdu'); break; }
      entry.step += 1;
    }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pendingMessages = panel.pendingMessages.filter((e) => e.status === 'en attente' || !e.resolvedAt || e.resolvedAt >= cutoff);
}

setOnShoeReset(() => {
  for (const t of panel.trackers) {
    t.lastSeenTarget = 0; t.streakSuit = null; t.streakCount = 0; t.streakHasLoss = false; t.waitingSuit = null;
  }
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

async function test() {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  if (!panel.channels.length) return { ok: false, error: 'Aucun canal configuré' };
  const preview = fmt.formatPreview(panel.format, { maxR: panel.maxR });
  const sent = [];
  const errors = [];
  for (const id of panel.channels) {
    try {
      await bot.sendMessage(id, `🎯 SÉRIE DE COSTUME — message de test\n\nFormat ${panel.format} :\n\n${preview}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

function statusView() {
  return {
    ...config(),
    options: options(),
    // liste des canaux du site pour peupler le sélecteur — même source que
    // la page « Canaux » (voir predictor.js/siteChannelsView), identique à
    // after-loss.js.
    siteChannels: siteChannelsView().map((c) => ({ id: c.id, name: c.name })),
    trackers: panel.trackers.map((t) => ({
      id: t.id, key: t.key, name: t.name, n: t.n, mode: t.mode, offset: t.offset,
      channels: t.channels, siteChannelId: t.siteChannelId, format: t.format, maxR: t.maxR,
      streakSuit: t.streakSuit, streakCount: t.streakCount, streakHasLoss: t.streakHasLoss, waitingSuit: t.waitingSuit,
      sentCount: t.sentCount, lastSentAt: t.lastSentAt, createdAt: t.createdAt,
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
  options, addTracker, updateTracker, removeTracker,
  restore, restoreFromDb, parseChannels, pendingFor,
};
