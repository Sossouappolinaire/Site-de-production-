// after-loss.js — panneau « Prédiction après perte » :
//
//  • On choisit une ou plusieurs stratégies à surveiller (une stratégie
//    EXISTANTE du bot — costume, dominant, matchnul, parite, absente, ombre —
//    OU la stratégie IA du panneau « Prédit »).
//  • Pour chaque stratégie suivie, on configure un nombre de pertes
//    consécutives à atteindre (« nombre de perte »).
//  • Dès que ce nombre de pertes consécutives est atteint sur la stratégie
//    suivie, le panneau ARME cette stratégie : il attend simplement la
//    PROCHAINE prédiction de cette stratégie (générée normalement par le
//    moteur) puis la RENVOIE (relais) dans le canal configuré ici, avec le
//    format et le nombre de rattrapage propres à ce panneau.
//  • Exemple : stratégie « dominant », nombre de perte = 1 → dès qu'une
//    prédiction de « dominant » est perdue, on attend sa prochaine
//    prédiction et on l'envoie dans le canal configuré.
//  • Exemple : stratégie IA, nombre de perte = 2 → il faut deux prédictions
//    IA perdues D'AFFILÉE avant que la prédiction IA suivante soit relayée.
//  • Une fois la prédiction relayée, le compteur de pertes consécutives de
//    cette stratégie repart à zéro (elle doit de nouveau perdre N fois pour
//    se réarmer).
'use strict';

const strategies = require('./strategies');
const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const { state, setStrategyConfig } = require('./predictor');
const predit = require('./predit');

const panel = {
  enabled: true,
  channels: [],   // canaux Telegram où sont relayées les prédictions « après perte »
  format: 1,      // format de prédiction utilisé pour les messages relayés
  maxR: 1,        // nombre de rattrapage affiché sur le message relayé
  trackers: [],   // [{ id, key, name, lossThreshold, consecutiveLosses, armed, armedAt, lastSeenTarget, sentCount, lastSentAt, createdAt }]
  history: [],    // journal des relais envoyés (les 100 derniers)
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
};

let sender = null;
function setSender(fn) { sender = fn; }

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

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.maxR !== undefined) panel.maxR = Math.max(0, Math.min(9, parseInt(patch.maxR, 10) || 0));
  persist();
  return config();
}

function config() {
  return {
    enabled: panel.enabled,
    channels: panel.channels,
    format: panel.format,
    maxR: panel.maxR,
  };
}

// ---------------------------------------------------------------------------
// Stratégies disponibles pour le choix (barre de déroulement)
// ---------------------------------------------------------------------------
function options() {
  return [
    ...strategies.LIST.map((s) => ({ key: s.key, name: s.name })),
    { key: 'ia', name: 'Stratégie IA (Prédit)' },
  ];
}

function optionByKey(key) {
  return options().find((o) => o.key === key) || null;
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const saved = {
    config: config(),
    trackers: panel.trackers,
    history: panel.history,
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
  };
  try { store.patch({ afterLoss: saved }); } catch (_) {}
  if (db.ready) db.saveAfterLossState(saved).catch((error) => { panel.lastError = error.message; });
}

function restore() {
  try {
    const saved = (store.read() || {}).afterLoss;
    if (saved) applySaved(saved);
  } catch (_) {}
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  const saved = await db.loadAfterLossState();
  if (!saved || typeof saved !== 'object') { persist(); return config(); }
  applySaved(saved);
  return config();
}

function applySaved(saved) {
  if (saved.config) {
    panel.enabled = saved.config.enabled !== false;
    panel.channels = parseChannels(saved.config.channels);
    panel.format = fmt.clampFormat(saved.config.format);
    panel.maxR = Math.max(0, Math.min(9, parseInt(saved.config.maxR, 10) || 0));
  }
  if (Array.isArray(saved.trackers)) {
    panel.trackers = saved.trackers.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name || (optionByKey(t.key) || {}).name || t.key,
      lossThreshold: Math.max(1, Math.min(20, parseInt(t.lossThreshold, 10) || 1)),
      consecutiveLosses: Number.isFinite(Number(t.consecutiveLosses)) ? Number(t.consecutiveLosses) : 0,
      armed: !!t.armed,
      armedAt: t.armedAt || null,
      lastSeenTarget: Number.isFinite(Number(t.lastSeenTarget)) ? Number(t.lastSeenTarget) : 0,
      sentCount: Number.isFinite(Number(t.sentCount)) ? Number(t.sentCount) : 0,
      lastSentAt: t.lastSentAt || null,
      createdAt: t.createdAt || Date.now(),
    }));
  }
  if (Array.isArray(saved.history)) panel.history = saved.history.slice(0, 100);
  if (Number.isFinite(Number(saved.sentCount))) panel.sentCount = Number(saved.sentCount);
  panel.lastSentAt = saved.lastSentAt || null;
  panel.lastScanAt = saved.lastScanAt || null;
}

// ---------------------------------------------------------------------------
// Gestion des stratégies suivies (trackers)
// ---------------------------------------------------------------------------
function trackerPredictions(key) {
  if (key === 'ia') return [...predit.panel.predictions].sort((a, b) => a.target - b.target);
  return state.predictions.filter((p) => p.strategy === key).sort((a, b) => a.target - b.target);
}

function currentMaxTarget(key) {
  const list = trackerPredictions(key);
  return list.length ? list[list.length - 1].target : 0;
}

function addTracker(key, lossThreshold) {
  const opt = optionByKey(key);
  if (!opt) throw new Error("Stratégie inconnue pour le suivi « après perte »");
  // La stratégie suivie doit être ACTIVE pour produire de nouvelles
  // prédictions (voir evaluate() dans predictor.js, qui ignore les
  // stratégies désactivées) — sans quoi le tracker resterait bloqué à 0
  // pertes indéfiniment. On l'active donc automatiquement à l'ajout (la
  // stratégie IA du panneau « Prédit » a son propre cycle, elle n'a pas
  // besoin de ce réglage).
  if (opt.key !== 'ia') setStrategyConfig(opt.key, { enabled: true });
  const tracker = {
    id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    key: opt.key,
    name: opt.name,
    lossThreshold: Math.max(1, Math.min(20, parseInt(lossThreshold, 10) || 1)),
    consecutiveLosses: 0,
    armed: false,
    armedAt: null,
    // on ne compte que les pertes à VENIR : l'historique déjà joué au moment
    // de l'ajout n'est pas rejoué.
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
  if (patch.lossThreshold !== undefined) {
    tracker.lossThreshold = Math.max(1, Math.min(20, parseInt(patch.lossThreshold, 10) || 1));
  }
  persist();
  return tracker;
}

function removeTracker(id) {
  panel.trackers = panel.trackers.filter((t) => t.id !== id);
  persist();
  return true;
}

// ---------------------------------------------------------------------------
// Relais Telegram
// ---------------------------------------------------------------------------
function relayText(tracker, pred) {
  return fmt.renderMessage(panel.format, {
    gameNumber: pred.target,
    suit: pred.suit,
    strategy: tracker.name,
    maxR: panel.maxR,
    status: 'en attente',
    rattrapage: 0,
  }, null);
}

async function forward(tracker, pred) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return false; }
  if (!panel.channels.length) { panel.lastError = "Aucun canal configuré pour « Prédiction après perte »"; return false; }
  const out = relayText(tracker, pred);
  let ok = false;
  const errors = [];
  for (const id of panel.channels) {
    try {
      await bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {});
      ok = true;
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  if (ok) {
    panel.sentCount = (panel.sentCount || 0) + 1;
    panel.lastSentAt = Date.now();
    panel.lastError = errors.length ? errors[0] : null;
    tracker.sentCount = (tracker.sentCount || 0) + 1;
    tracker.lastSentAt = Date.now();
    panel.history.unshift({
      trackerId: tracker.id,
      trackerName: tracker.name,
      target: pred.target,
      suit: pred.suit,
      sentAt: Date.now(),
    });
    panel.history = panel.history.slice(0, 100);
  } else if (errors.length) {
    panel.lastError = errors[0];
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Boucle : compte les pertes consécutives, arme puis relaie la prédiction
// suivante dès qu'elle apparaît.
// ---------------------------------------------------------------------------
async function processTracker(tracker) {
  const list = trackerPredictions(tracker.key);
  for (const pred of list) {
    if (pred.target <= tracker.lastSeenTarget) continue;
    if (tracker.armed) {
      // c'est la prochaine prédiction de la stratégie suivie depuis
      // l'armement : on la relaie immédiatement dans le canal configuré.
      await forward(tracker, pred);
      tracker.armed = false;
      tracker.armedAt = null;
      tracker.consecutiveLosses = 0;
      tracker.lastSeenTarget = pred.target;
      continue;
    }
    // pas encore armé : on ne compte que les prédictions déjà résolues, dans
    // l'ordre chronologique — une prédiction encore en attente arrête la
    // boucle (on la traitera au prochain tour, une fois son résultat connu).
    if (pred.status === 'en attente') break;
    tracker.lastSeenTarget = pred.target;
    if (pred.status === 'perdu') {
      tracker.consecutiveLosses += 1;
      if (tracker.consecutiveLosses >= tracker.lossThreshold) {
        tracker.armed = true;
        tracker.armedAt = Date.now();
      }
    } else if (pred.status === 'gagné') {
      tracker.consecutiveLosses = 0;
    }
  }
}

let busy = false;
async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    for (const tracker of panel.trackers) await processTracker(tracker);
    panel.lastScanAt = Date.now();
  } catch (e) {
    panel.lastError = e.message;
  } finally {
    persist();
    busy = false;
  }
  return panel;
}

// ---------------------------------------------------------------------------
// Test d'envoi
// ---------------------------------------------------------------------------
async function test() {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  if (!panel.channels.length) return { ok: false, error: 'Aucun canal configuré' };
  const preview = fmt.formatPreview(panel.format, { maxR: panel.maxR });
  const sent = [];
  const errors = [];
  for (const id of panel.channels) {
    try {
      await bot.sendMessage(id, `🎯 PRÉDICTION APRÈS PERTE — message de test\n\nFormat ${panel.format} :\n\n${preview}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

// ---------------------------------------------------------------------------
// Statut (pour le tableau de bord)
// ---------------------------------------------------------------------------
function status() {
  return {
    ...config(),
    running: panel.enabled,
    formatPreview: fmt.formatPreview(panel.format, { maxR: panel.maxR }),
    options: options(),
    trackers: panel.trackers.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      lossThreshold: t.lossThreshold,
      consecutiveLosses: t.consecutiveLosses,
      armed: t.armed,
      armedAt: t.armedAt,
      sentCount: t.sentCount,
      lastSentAt: t.lastSentAt,
      createdAt: t.createdAt,
    })),
    history: panel.history.slice(0, 20),
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
  };
}

module.exports = {
  panel, status, config, configure, restore, restoreFromDb, setSender, tick, test,
  parseChannels, options, addTracker, updateTracker, removeTracker,
};
