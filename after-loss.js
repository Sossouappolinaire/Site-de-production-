// after-loss.js — panneau « Prédiction après perte » :
//
//  • On choisit une ou plusieurs stratégies à surveiller (une stratégie
//    EXISTANTE du bot — costume, dominant, matchnul, parite, absente, ombre —
//    OU la stratégie IA du panneau « Prédit »).
//  • Pour chaque stratégie suivie, on coche un ou plusieurs TYPES de résultat
//    déclencheurs — rattrapage 1 / rattrapage 2 / rattrapage 3 / perdue —
//    et on définit, POUR CHAQUE case cochée, un nombre N de prédictions à
//    laisser passer avant de lancer le relais (0 = la toute prochaine).
//  • Dès qu'un résultat correspondant à une case cochée apparaît, le panneau
//    se met à COMPTER : il laisse passer N prédictions supplémentaires de
//    cette stratégie (silencieusement, sans rien relayer), puis relaie la
//    prédiction suivante dans le canal configuré ici. Si plusieurs cases
//    sont cochées, la première qui se présente déclenche le compte (les
//    autres ne sont pas prises en compte tant que celui-ci est en cours).
//  • Exemple : stratégie « dominant », case « Rattrapage 1 » cochée avec
//    N = 0 → dès qu'une prédiction se termine en rattrapage 1, on relaie
//    directement la suivante.
//  • Exemple : stratégie IA, case « Perdue » cochée avec N = 2 → dès qu'une
//    prédiction IA est perdue, on laisse passer 2 prédictions IA de plus
//    (silencieuses), et c'est la 3ᵉ qui est relayée.
//  • Une fois la prédiction relayée, le panneau repart à zéro pour cette
//    stratégie (il attend un nouveau déclencheur parmi les cases cochées).
//  • Canal et format par stratégie suivie (facultatifs) : chaque stratégie
//    peut avoir son propre canal Telegram et/ou son propre format de
//    prédiction, indépendants du canal/format global du panneau. Si l'un des
//    deux est laissé vide à l'ajout/modification, cette stratégie utilise le
//    canal/format du panneau (comportement d'origine). Ça permet d'envoyer
//    chaque stratégie suivie vers un canal différent, ou plusieurs vers le
//    même canal, au choix.
'use strict';

const strategies = require('./strategies');
const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const { state, setStrategyConfig } = require('./predictor');
const predit = require('./predit');
const ai = require('./ai-analyzer');

const TRIGGER_KEYS = ['r1', 'r2', 'r3', 'perdue'];
const TRIGGER_LABELS = { r1: 'Rattrapage 1', r2: 'Rattrapage 2', r3: 'Rattrapage 3', perdue: 'Perdue' };

const panel = {
  enabled: true,
  channels: [],   // canaux Telegram où sont relayées les prédictions « après perte »
  format: 1,      // format de prédiction utilisé pour les messages relayés
  maxR: 1,        // nombre de rattrapage affiché sur le message relayé
  // trackers : [{ id, key, name, triggers:{r1:{enabled,n}, r2:{...}, r3:{...}, perdue:{...}},
  //               counting, armedTrigger, armedNeeded, armedSeen, armed, armedAt,
  //               lastSeenTarget, sentCount, lastSentAt, createdAt }]
  trackers: [],
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
// Déclencheurs par type — normalisation / lecture du résultat
// ---------------------------------------------------------------------------
function sanitizeTriggers(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const k of TRIGGER_KEYS) {
    const raw = src[k] || {};
    out[k] = {
      enabled: !!raw.enabled,
      n: Math.max(0, Math.min(50, parseInt(raw.n, 10) || 0)),
    };
  }
  return out;
}

function defaultTriggers() {
  // par défaut : équivalent à l'ancien comportement (perdue, envoi immédiat)
  return sanitizeTriggers({ perdue: { enabled: true, n: 0 } });
}

// ---------------------------------------------------------------------------
// Option « même costume après perte » : indépendante des déclencheurs
// rattrapage/perdue ci-dessus. Dès qu'une prédiction de la stratégie suivie
// est PERDUE, on RE-PRÉDIT le même costume, décalé de `lead` jeux plus loin
// (ex. +5 ou +10, configurable). Ce n'est pas un « diagnostic de faille » :
// c'est une règle simple, honnête sur ses résultats passés (voir
// adviceForRepeat), le joueur choisit lui-même le décalage.
// ---------------------------------------------------------------------------
function sanitizeRepeat(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    enabled: !!src.enabled,
    lead: Math.max(1, Math.min(50, parseInt(src.lead, 10) || 5)),
  };
}

// ---------------------------------------------------------------------------
// Canal(x) et format PROPRES à une stratégie suivie — facultatifs. Une
// stratégie sans réglage propre utilise le canal/format du panneau (comme
// avant). Ça permet d'envoyer chaque stratégie suivie dans un canal
// différent, ou plusieurs dans le même canal, au choix.
// ---------------------------------------------------------------------------
function sanitizeTrackerFormat(input) {
  if (input === undefined || input === null || input === '') return null;
  return fmt.clampFormat(input);
}

function effectiveChannels(tracker) {
  return (tracker.channels && tracker.channels.length) ? tracker.channels : panel.channels;
}

function effectiveFormat(tracker) {
  return (tracker.format !== null && tracker.format !== undefined) ? tracker.format : panel.format;
}

// type de résultat d'une prédiction terminée : 'r0' (gagné direct — jamais
// une case cochable), 'r1'/'r2'/'r3'... (gagné à ce rattrapage), ou 'perdue'.
function resultKind(pred) {
  if (pred.status === 'perdu') return 'perdue';
  if (pred.status === 'gagné') return `r${pred.step || 0}`;
  return null;
}

function resultLabel(kind) {
  return TRIGGER_LABELS[kind] || (kind === 'r0' ? 'Gagné direct' : kind || '?');
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
      // migration : les anciens trackers n'avaient qu'un « lossThreshold »
      // (nombre de pertes consécutives) — on les convertit en un
      // déclencheur « perdue » avec N=0 (comportement équivalent le plus
      // proche : envoi dès la prédiction suivante après une perte).
      triggers: t.triggers ? sanitizeTriggers(t.triggers) : defaultTriggers(),
      repeat: sanitizeRepeat(t.repeat),
      channels: Array.isArray(t.channels) ? parseChannels(t.channels) : [],
      format: sanitizeTrackerFormat(t.format),
      lastRepeatSource: Number.isFinite(Number(t.lastRepeatSource)) ? Number(t.lastRepeatSource) : 0,
      counting: !!t.counting,
      armedTrigger: t.armedTrigger || null,
      armedNeeded: Number.isFinite(Number(t.armedNeeded)) ? Number(t.armedNeeded) : 0,
      armedSeen: Number.isFinite(Number(t.armedSeen)) ? Number(t.armedSeen) : 0,
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

function addTracker(key, triggers, repeat, extra = {}) {
  const opt = optionByKey(key);
  if (!opt) throw new Error("Stratégie inconnue pour le suivi « après perte »");
  const clean = sanitizeTriggers(triggers);
  const cleanRepeat = sanitizeRepeat(repeat);
  if (!cleanRepeat.enabled && !TRIGGER_KEYS.some((k) => clean[k].enabled)) {
    throw new Error("Coche au moins un type de résultat déclencheur (rattrapage 1/2/3 ou perdue), ou active « même costume après perte ».");
  }
  // La stratégie suivie doit être ACTIVE pour produire de nouvelles
  // prédictions (voir evaluate() dans predictor.js, qui ignore les
  // stratégies désactivées) — sans quoi le tracker resterait bloqué
  // indéfiniment. On l'active donc automatiquement à l'ajout (la stratégie
  // IA du panneau « Prédit » a son propre cycle, elle n'a pas besoin de ce
  // réglage).
  if (opt.key !== 'ia') setStrategyConfig(opt.key, { enabled: true });
  const tracker = {
    id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    key: opt.key,
    name: opt.name,
    triggers: clean,
    repeat: cleanRepeat,
    // canal(x) et format propres à cette stratégie ; vides → hérite du
    // canal/format global du panneau (voir effectiveChannels/effectiveFormat).
    channels: parseChannels(extra.channels),
    format: sanitizeTrackerFormat(extra.format),
    // on ne rejoue pas les pertes déjà passées au moment de l'ajout.
    lastRepeatSource: currentMaxTarget(opt.key),
    counting: false,
    armedTrigger: null,
    armedNeeded: 0,
    armedSeen: 0,
    armed: false,
    armedAt: null,
    // on ne compte que les résultats à VENIR : l'historique déjà joué au
    // moment de l'ajout n'est pas rejoué.
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
  if (patch.triggers !== undefined) {
    const clean = sanitizeTriggers(patch.triggers);
    const willHaveRepeat = patch.repeat !== undefined ? sanitizeRepeat(patch.repeat).enabled : tracker.repeat.enabled;
    if (!willHaveRepeat && !TRIGGER_KEYS.some((k) => clean[k].enabled)) {
      throw new Error("Coche au moins un type de résultat déclencheur (rattrapage 1/2/3 ou perdue), ou active « même costume après perte ».");
    }
    tracker.triggers = clean;
    // un changement de réglages annule un décompte en cours, pour repartir
    // proprement sur les nouvelles règles.
    tracker.counting = false;
    tracker.armedTrigger = null;
    tracker.armedNeeded = 0;
    tracker.armedSeen = 0;
    tracker.armed = false;
    tracker.armedAt = null;
  }
  if (patch.repeat !== undefined) {
    tracker.repeat = sanitizeRepeat(patch.repeat);
  }
  if (patch.channels !== undefined) {
    tracker.channels = parseChannels(patch.channels);
  }
  if (patch.format !== undefined) {
    tracker.format = sanitizeTrackerFormat(patch.format);
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
// Conseil honnête ajouté au bas du message relayé : pas de « diagnostic de
// faille », uniquement les stats RÉELLES déjà mesurées pour la combinaison
// déclencheur/N qui vient d'armer ce tracker, avec le rappel que ce sont des
// résultats passés sur un jeu qui reste indépendant à chaque main. Réutilise
// exactement le même calcul que backtestTracker/simulateCombo, sans appel IA
// (pas de latence sur le chemin d'envoi).
// ---------------------------------------------------------------------------
function adviceForTracker(tracker) {
  const kind = tracker.armedTrigger;
  const n = tracker.armedNeeded;
  if (!kind) return null;
  const history = trackerPredictions(tracker.key).filter((p) => p.status === 'gagné' || p.status === 'perdu');
  const r = simulateCombo(history, kind, n);
  const label = resultLabel(kind);
  if (r.sends < 3) {
    return `Conseil : combinaison « ${label} + attendre ${n} » — seulement ${r.sends} précédent(s) mesuré(s) sur « ${tracker.name} », pas encore assez pour en tirer un taux fiable. Continuer à observer avant d'ajuster N.`;
  }
  const ratePct = Math.round(r.rate * 1000) / 10;
  const base = `Conseil : sur « ${tracker.name} », la combinaison « ${label} + attendre ${n} » a réussi ${r.wins}/${r.sends} fois (${ratePct}%) dans l'historique de cette stratégie.`;
  if (ratePct >= 65) {
    return `${base} C'est un résultat passé, pas une garantie — le tirage reste indépendant à chaque main.`;
  }
  if (ratePct <= 40) {
    return `${base} C'est en-dessous d'une pièce équilibrée sur cet échantillon : envisager d'augmenter N ou de cocher un autre déclencheur, puis relancer l'optimisation (bouton dédié) pour comparer.`;
  }
  return `${base} Résultat passé sans tendance nette — augmenter l'échantillon avant de changer les réglages.`;
}

// ---------------------------------------------------------------------------
// Relais Telegram
// ---------------------------------------------------------------------------
function relayText(tracker, pred) {
  const out = fmt.renderMessage(effectiveFormat(tracker), {
    gameNumber: pred.target,
    suit: pred.suit,
    strategy: tracker.name,
    maxR: panel.maxR,
    status: 'en attente',
    rattrapage: 0,
  }, null);
  // Le conseil (adviceForTracker) n'est plus ajouté aux messages de
  // prédiction envoyés sur Telegram — il reste disponible ailleurs
  // (panneau/API) si besoin, mais ne doit jamais polluer le relais.
  return out;
}

async function forward(tracker, pred) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return false; }
  const targetChannels = effectiveChannels(tracker);
  if (!targetChannels.length) { panel.lastError = `Aucun canal configuré pour « ${tracker.name} » (ni propre à la stratégie, ni sur le panneau)`; return false; }
  const out = relayText(tracker, pred);
  let ok = false;
  const errors = [];
  for (const id of targetChannels) {
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
// Boucle : attend un déclencheur (parmi les cases cochées), compte N
// prédictions supplémentaires, puis relaie la suivante.
// ---------------------------------------------------------------------------
async function processTracker(tracker) {
  const list = trackerPredictions(tracker.key);
  for (const pred of list) {
    if (pred.target <= tracker.lastSeenTarget) continue;
    if (tracker.armed) {
      // c'est la prédiction attendue depuis l'armement : on la relaie
      // immédiatement dans le canal configuré, puis on repart à zéro.
      await forward(tracker, pred);
      tracker.armed = false;
      tracker.armedAt = null;
      tracker.armedTrigger = null;
      tracker.armedNeeded = 0;
      tracker.armedSeen = 0;
      tracker.counting = false;
      tracker.lastSeenTarget = pred.target;
      continue;
    }
    // pas encore armé : on ne traite que les prédictions déjà résolues,
    // dans l'ordre chronologique — une prédiction encore en attente arrête
    // la boucle (on la traitera au prochain tour, une fois son résultat connu).
    if (pred.status === 'en attente') break;
    tracker.lastSeenTarget = pred.target;
    if (tracker.counting) {
      tracker.armedSeen += 1;
      if (tracker.armedSeen >= tracker.armedNeeded) {
        tracker.armed = true;
        tracker.armedAt = Date.now();
        tracker.counting = false;
      }
      continue;
    }
    const kind = resultKind(pred);
    const trig = kind && tracker.triggers[kind];
    if (trig && trig.enabled) {
      tracker.armedTrigger = kind;
      tracker.armedNeeded = trig.n;
      tracker.armedSeen = 0;
      if (trig.n <= 0) {
        tracker.armed = true;
        tracker.armedAt = Date.now();
      } else {
        tracker.counting = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// « Même costume après perte » : quand la stratégie suivie perd, on
// re-prédit le MÊME costume `lead` jeux plus loin. Le conseil ajouté au
// message se base sur ce qui s'est réellement passé pour CE costume à CE
// décalage dans l'historique des jeux déjà joués — pas une promesse.
// ---------------------------------------------------------------------------
function gameAtNumber(number) {
  return (state.history || []).find((g) => g.number === number) || null;
}

function repeatRate(key, lead) {
  const losses = trackerPredictions(key).filter((p) => p.status === 'perdu' && p.suit);
  let trials = 0;
  let hits = 0;
  for (const p of losses) {
    const g = gameAtNumber(p.target + lead);
    if (!g) continue; // ce jeu n'a pas encore été joué
    trials += 1;
    const suits = strategies.suitsOf(g.playerSuits) || [];
    if (suits.includes(p.suit)) hits += 1;
  }
  return { trials, hits, rate: trials ? Math.round((hits / trials) * 1000) / 10 : 0 };
}

function adviceForRepeat(tracker, lead) {
  const r = repeatRate(tracker.key, lead);
  if (r.trials < 3) {
    return `Conseil : répétition du même costume à +${lead} après une perte — seulement ${r.trials} cas mesuré(s) sur « ${tracker.name} », pas encore assez pour en tirer un taux fiable.`;
  }
  const base = `Conseil : sur « ${tracker.name} », après une perte, le même costume est réapparu à +${lead} dans ${r.hits}/${r.trials} cas passés (${r.rate}%).`;
  if (r.rate >= 65) return `${base} Résultat passé encourageant, mais le tirage reste indépendant à chaque main : aucune garantie pour cette fois.`;
  if (r.rate <= 40) return `${base} En-dessous d'une pièce équilibrée sur cet échantillon : ce décalage de +${lead} n'est pas confirmé — essayer un autre lead ou désactiver cette option.`;
  return `${base} Résultat passé sans tendance nette — laisser l'échantillon grandir avant de conclure.`;
}

async function forwardRepeat(tracker, synth) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return false; }
  const targetChannels = effectiveChannels(tracker);
  if (!targetChannels.length) { panel.lastError = `Aucun canal configuré pour « ${tracker.name} » (ni propre à la stratégie, ni sur le panneau)`; return false; }
  const out = fmt.renderMessage(effectiveFormat(tracker), {
    gameNumber: synth.target,
    suit: synth.suit,
    strategy: `${tracker.name} — même costume après perte (+${tracker.repeat.lead})`,
    maxR: panel.maxR,
    status: 'en attente',
    rattrapage: 0,
  }, null);
  // Idem : plus de conseil ajouté au message de prédiction envoyé.
  let ok = false;
  const errors = [];
  for (const id of targetChannels) {
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
      trackerName: `${tracker.name} (répétition)`,
      target: synth.target,
      suit: synth.suit,
      sentAt: Date.now(),
    });
    panel.history = panel.history.slice(0, 100);
  } else if (errors.length) {
    panel.lastError = errors[0];
  }
  return ok;
}

// parcourt les prédictions déjà résolues de la stratégie suivie ; chaque
// perte NON encore traitée pour la répétition déclenche l'envoi d'une
// nouvelle prédiction (même costume, +lead), indépendamment des
// déclencheurs rattrapage/perdue ci-dessus.
async function processRepeat(tracker) {
  if (!tracker.repeat || !tracker.repeat.enabled) return;
  const list = trackerPredictions(tracker.key);
  for (const pred of list) {
    if (pred.target <= (tracker.lastRepeatSource || 0)) continue;
    if (pred.status === 'en attente') break; // pas encore résolue, on la retraite au prochain tour
    tracker.lastRepeatSource = pred.target;
    if (pred.status !== 'perdu' || !pred.suit) continue;
    const lead = tracker.repeat.lead;
    const synth = { target: pred.target + lead, suit: pred.suit };
    await forwardRepeat(tracker, synth);
  }
}

let busy = false;
async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    for (const tracker of panel.trackers) {
      await processTracker(tracker);
      await processRepeat(tracker);
    }
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
// Backtest / optimisation IA — teste chaque type de déclencheur (rattrapage
// 1/2/3, perdue) avec chaque valeur de N (0 à 10) sur l'historique RÉEL déjà
// joué par la stratégie suivie, et retient la ou les combinaisons avec le
// meilleur taux de réussite observé. Important : c'est une performance
// PASSÉE, pas une garantie — le baccara reste un jeu aléatoire. L'IA se
// contente d'expliquer le résultat du backtest, elle n'invente rien.
// ---------------------------------------------------------------------------
function simulateCombo(history, kind, n) {
  let counting = false;
  let seen = 0;
  let armed = false;
  let sends = 0;
  let wins = 0;
  for (const pred of history) {
    if (armed) {
      sends += 1;
      if (pred.status === 'gagné') wins += 1;
      armed = false;
      continue;
    }
    if (counting) {
      seen += 1;
      if (seen >= n) { armed = true; counting = false; }
      continue;
    }
    const k = resultKind(pred);
    if (k === kind) {
      if (n <= 0) { armed = true; } else { counting = true; seen = 0; }
    }
  }
  return { sends, wins, rate: sends ? wins / sends : 0 };
}

function backtestTracker(id) {
  const tracker = panel.trackers.find((t) => t.id === id);
  if (!tracker) throw new Error('Stratégie suivie introuvable.');
  const history = trackerPredictions(tracker.key).filter((p) => p.status === 'gagné' || p.status === 'perdu');
  const results = [];
  for (const kind of TRIGGER_KEYS) {
    for (let n = 0; n <= 10; n++) {
      const r = simulateCombo(history, kind, n);
      if (r.sends >= 2) results.push({ kind, n, ...r }); // au moins 2 essais pour être significatif
    }
  }
  results.sort((a, b) => (b.rate - a.rate) || (b.sends - a.sends) || (a.n - b.n));
  return {
    trackerId: id,
    strategyName: tracker.name,
    sampleSize: history.length,
    top: results.slice(0, 5).map((r) => ({
      kind: r.kind,
      label: resultLabel(r.kind),
      n: r.n,
      sends: r.sends,
      wins: r.wins,
      ratePct: Math.round(r.rate * 1000) / 10,
    })),
  };
}

async function optimizeTracker(id) {
  const bt = backtestTracker(id);
  if (!bt.top.length) {
    return { ...bt, explanation: "Pas assez d'historique résolu sur cette stratégie pour proposer une combinaison fiable — reviens plus tard une fois qu'elle aura accumulé plus de prédictions terminées." };
  }
  const best = bt.top[0];
  let explanation = `Sur ${bt.sampleSize} prédiction(s) résolue(s) de « ${bt.strategyName} », la combinaison « ${best.label} + attendre ${best.n} prédiction(s) » a le meilleur historique observé : ${best.wins}/${best.sends} relais gagnants (${best.ratePct}%). Ce chiffre reflète le passé, pas une garantie pour la suite — le baccara reste aléatoire.`;
  try {
    if (ai.keyLooksValid() || ai.geminiConfigured() || ai.groqConfigured() || ai.openrouterConfigured()) {
      const text = await ai.chat({
        system: "Tu commentes en français, en 2-3 phrases MAXIMUM, un résultat de backtest pour un panneau de prédiction baccara. N'affirme JAMAIS un taux de réussite garanti pour l'avenir : rappelle que c'est une performance passée sur un échantillon limité et que le jeu reste aléatoire. Sois concret, pas de blabla.",
        user: { backtest: bt },
        temperature: 0.3,
        timeoutMs: 15000,
      });
      if (text && String(text).trim()) explanation = String(text).trim();
    }
  } catch (_) { /* on garde l'explication locale si l'IA échoue */ }
  return { ...bt, explanation };
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
    triggerKeys: TRIGGER_KEYS,
    triggerLabels: TRIGGER_LABELS,
    trackers: panel.trackers.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      triggers: t.triggers,
      repeat: t.repeat,
      channels: t.channels,
      format: t.format,
      counting: t.counting,
      armedTrigger: t.armedTrigger,
      armedNeeded: t.armedNeeded,
      armedSeen: t.armedSeen,
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
  backtestTracker, optimizeTracker, TRIGGER_KEYS, TRIGGER_LABELS,
};
