// combined.js — bouton « Prédiction combinée pour costume joueur » :
// système INDÉPENDANT de « Prédiction après perte » (after-loss.js), avec
// une sémantique différente sur le nombre N :
//
//  • On sélectionne UNE OU PLUSIEURS sources à la fois : les stratégies
//    existantes, la stratégie IA « Prédit », ET les stratégies suivies via
//    « Formation » (formation-relay.js — les formations se comportent comme
//    des stratégies qui envoient elles aussi dans des canaux, voir
//    formationOptions() ci-dessous).
//  • Pour chaque source, on définit un ou plusieurs niveaux de rattrapage
//    (1, 2, 3, ou « perdue ») avec, pour CHACUN, un nombre N.
//  • N = nombre de fois CONSÉCUTIF où ce niveau doit survenir avant de
//    déclencher — PAS un nombre de prédictions à sauter (contrairement à
//    « Prédiction après perte »). Exemple : rattrapage 2, N = 2 → il faut
//    deux résultats « rattrapage 2 » d'AFFILÉE (sans qu'un autre résultat ne
//    s'intercale) pour déclencher ; N = 1 → un seul suffit.
//  • Dès que la série atteint N, on synthétise IMMÉDIATEMENT une nouvelle
//    prédiction : même costume que celui de cette dernière occurrence (mode
//    « même »), ou son inverse (mode « inverse », voir strategies.INVERSE),
//    sur le jeu = dernier jeu de la série + w (offset réglable). PAS
//    d'attente d'une « prochaine prédiction naturelle » de la stratégie
//    source : c'est cette combinaison qui la crée elle-même.
//  • Toujours sur la main du JOUEUR (nom du bouton) : vérification via
//    hasSuit(), jamais hasSuitBanker().
'use strict';

const strategies = require('./strategies');
const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const { state, hasSuit, setOnShoeReset } = require('./predictor');
const predit = require('./predit');
const formationRelay = require('./formation-relay');

const LEVEL_KEYS = ['r1', 'r2', 'r3', 'perdue'];
const LEVEL_LABELS = { r1: 'Rattrapage 1', r2: 'Rattrapage 2', r3: 'Rattrapage 3', perdue: 'Perdue' };

const panel = {
  enabled: true,
  channels: [],
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
  return { enabled: panel.enabled, channels: panel.channels, format: panel.format, maxR: panel.maxR };
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
  return [...base, ...formations];
}

function optionByKey(key) {
  return options().find((o) => o.key === key) || null;
}

function baseKeyOf(key) {
  return key.startsWith('formation:') ? key.slice('formation:'.length) : key;
}

function trackerPredictions(key) {
  const base = baseKeyOf(key);
  if (base === 'ia') return [...predit.panel.predictions].sort((a, b) => a.target - b.target);
  return state.predictions.filter((p) => p.strategy === base).sort((a, b) => a.target - b.target);
}

function currentMaxTarget(key) {
  const list = trackerPredictions(key);
  return list.length ? list[list.length - 1].target : 0;
}

function normalizeMode(m) {
  return m === 'inverse' || m === 'meme' ? m : 'relais';
}

// CORRECTIF (demande admin) : le mode (relais / même costume+w / inverse+w)
// et le décalage +w sont désormais réglables INDÉPENDAMMENT pour CHAQUE
// niveau de rattrapage (r1/r2/r3/perdue), pas un seul réglage partagé pour
// toute la source — un rattrapage 1 peut relayer normalement pendant qu'un
// rattrapage 3 prédit l'inverse +6, par exemple.
function sanitizeRules(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const k of LEVEL_KEYS) {
    const raw = src[k] || {};
    out[k] = {
      enabled: !!raw.enabled,
      need: Math.max(1, Math.min(20, parseInt(raw.need, 10) || 1)),
      mode: normalizeMode(raw.mode),
      offset: Math.max(1, Math.min(50, parseInt(raw.offset, 10) || 5)),
    };
  }
  return out;
}

function resultKind(pred) {
  if (pred.status === 'perdu') return 'perdue';
  if (pred.status === 'gagné') return `r${pred.step || 0}`;
  return null;
}

function effectiveChannels(tracker) {
  return (tracker.channels && tracker.channels.length) ? tracker.channels : panel.channels;
}

function effectiveFormat(tracker) {
  return tracker.format || panel.format;
}

function persist() {
  const saved = {
    config: config(), trackers: panel.trackers, history: panel.history,
    pendingMessages: panel.pendingMessages, sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt,
  };
  try { store.patch({ combined: saved }); } catch (_) {}
  if (db.ready) db.setSetting('combined_state', JSON.stringify(saved)).catch((error) => { panel.lastError = error.message; });
}

function restore() {
  try {
    const saved = (store.read() || {}).combined;
    if (saved) applySaved(saved);
  } catch (_) {}
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('combined_state');
    if (raw) applySaved(JSON.parse(raw));
    else persist();
  } catch (_) { persist(); }
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
      rules: sanitizeRules(t.rules),
      channels: Array.isArray(t.channels) ? parseChannels(t.channels) : [],
      format: t.format ? fmt.clampFormat(t.format) : null,
      streakKind: t.streakKind || null,
      armed: !!t.armed,
      armedKind: t.armedKind || null,
      streakCount: Number.isFinite(Number(t.streakCount)) ? Number(t.streakCount) : 0,
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

// Crée UNE source suivie. Voir addTrackers() ci-dessous pour en ajouter
// plusieurs à la fois (demande admin : sélection multi-stratégies).
function addTracker(key, rules, extra = {}) {
  const opt = optionByKey(key);
  if (!opt) throw new Error('Source inconnue pour la prédiction combinée.');
  const clean = sanitizeRules(rules);
  if (!LEVEL_KEYS.some((k) => clean[k].enabled)) {
    throw new Error('Coche au moins un niveau de rattrapage (1/2/3) ou « perdue », avec un nombre consécutif.');
  }
  const tracker = {
    id: `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    key: opt.key,
    // nom personnalisé (demande admin : « donner un nom une fois fini ») —
    // à défaut, on retombe sur le nom de la source comme avant.
    name: (extra.name && String(extra.name).trim()) || opt.name,
    rules: clean,
    channels: parseChannels(extra.channels),
    format: extra.format ? fmt.clampFormat(extra.format) : null,
    streakKind: null,
    streakCount: 0,
    armed: false,
    armedKind: null,
    lastSeenTarget: currentMaxTarget(opt.key),
    sentCount: 0,
    lastSentAt: null,
    createdAt: Date.now(),
  };
  panel.trackers.push(tracker);
  persist();
  return tracker;
}

// Ajoute PLUSIEURS sources à la fois (demande admin), avec LES MÊMES règles
// pour chacune — un appel, plusieurs trackers créés d'un coup. `keys` est un
// tableau de clés de sources (voir options()).
function addTrackers(keys, rules, extra = {}) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (!list.length) throw new Error('Sélectionne au moins une stratégie ou une formation.');
  const created = [];
  const errors = [];
  for (const key of list) {
    try { created.push(addTracker(key, rules, extra)); }
    catch (e) { errors.push(`${key} : ${e.message}`); }
  }
  if (!created.length) throw new Error(errors[0] || 'Aucune source ajoutée.');
  return { created, errors };
}

function updateTracker(id, patch = {}) {
  const tracker = panel.trackers.find((t) => t.id === id);
  if (!tracker) return null;
  if (patch.name !== undefined) {
    const clean = String(patch.name || '').trim();
    if (clean) tracker.name = clean; // vide = on garde le nom actuel (jamais de nom vide)
  }
  if (patch.rules !== undefined) {
    const clean = sanitizeRules(patch.rules);
    if (!LEVEL_KEYS.some((k) => clean[k].enabled)) {
      throw new Error('Coche au moins un niveau de rattrapage (1/2/3) ou « perdue », avec un nombre consécutif.');
    }
    tracker.rules = clean;
    tracker.streakKind = null;
    tracker.streakCount = 0;
    tracker.armed = false;
  }
  if (patch.channels !== undefined) tracker.channels = parseChannels(patch.channels);
  if (patch.format !== undefined) tracker.format = patch.format ? fmt.clampFormat(patch.format) : null;
  persist();
  return tracker;
}

function removeTracker(id) {
  panel.trackers = panel.trackers.filter((t) => t.id !== id);
  persist();
  return true;
}

function resultKindLabelFor(tracker) {
  const k = tracker.armedKind || tracker.streakKind;
  return LEVEL_LABELS[k] || k || '?';
}

// CORRECTIF (le mode par défaut avait été mal compris) : « on prédit le
// 3ième prédiction de cette stratégie » / « sa prochaine prédiction sera
// envoyée » = par défaut, une fois la série consécutive atteinte, on doit
// RELAYER la VRAIE prochaine prédiction NATURELLE de la stratégie source
// (copie exacte — costume, jeu cible, tout — dès qu'elle apparaît, même
// pas encore résolue), pas en inventer une nouvelle. Le « même costume +w »
// et son « inverse » sont des modes ALTERNATIFS, à choisir explicitement —
// pas le comportement systématique.
async function relayNext(tracker, pred) {
  const sourceSuit = pred.suit || null;
  if (!sourceSuit) return;
  await send(tracker, {
    target: pred.target, suit: sourceSuit, sourceTarget: pred.target, sourceSuit,
    kind: resultKindLabelFor(tracker), mode: 'relais',
  });
}

async function synthesize(tracker, pred, rule) {
  const sourceSuit = pred.suit || null;
  if (!sourceSuit) return;
  const suit = rule.mode === 'inverse' ? (strategies.INVERSE[sourceSuit] || sourceSuit) : sourceSuit;
  const target = pred.target + rule.offset;
  await send(tracker, { target, suit, sourceTarget: pred.target, sourceSuit, kind: resultKindLabelFor(tracker), mode: rule.mode });
}

// CORRECTIF (demande admin) : les sources « formation: » n'étaient qu'un
// ALIAS COSMÉTIQUE — elles suivaient exactement les mêmes prédictions que
// la stratégie brute, sans jamais vérifier la fiabilité de la formation.
// Résultat : « la formation » prédisait tout, sans analyser ni chercher le
// meilleur moment. Désormais, une source « formation: » n'avance QUE quand
// formationRelay.formationTrusted() dit que la formation est FIABLE pour
// cette stratégie EN CE MOMENT (formation.js validée + avis IA pas « à
// mettre en pause », voir formation-relay.js) — sinon le suivi est
// simplement mis en PAUSE (rien n'avance, rien ne se déclenche) jusqu'à ce
// que la formation redevienne fiable.
function isFormationSource(key) {
  return key.startsWith('formation:');
}

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

    // Mode « relais » ARMÉ : la toute prochaine prédiction de la stratégie
    // source (résolue ou non) est relayée IMMÉDIATEMENT dès qu'elle
    // apparaît — c'est ÇA, « sa prochaine prédiction sera envoyée ».
    if (tracker.armed) {
      tracker.lastSeenTarget = pred.target;
      await relayNext(tracker, pred);
      tracker.armed = false;
      tracker.armedKind = null;
      continue;
    }

    if (pred.status === 'en attente') break;
    tracker.lastSeenTarget = pred.target;
    const kind = resultKind(pred);
    if (!kind) continue;
    if (kind === tracker.streakKind) tracker.streakCount += 1;
    else { tracker.streakKind = kind; tracker.streakCount = 1; }
    const rule = tracker.rules[kind];
    if (rule && rule.enabled && tracker.streakCount >= rule.need) {
      // 3 modes possibles PAR RÈGLE (r1/r2/r3/perdue ont chacune leur
      // propre mode + décalage, voir sanitizeRules) :
      //   'relais'  (par défaut) → on ARME, et on relaie la VRAIE prochaine
      //             prédiction naturelle de la stratégie source, dès
      //             qu'elle apparaît (voir plus haut, tracker.armed).
      //   'meme'    → prédiction synthétisée : même costume que la
      //             dernière occurrence de la série, + rule.offset jeux.
      //   'inverse' → pareil, mais avec le costume inverse.
      if (rule.mode === 'relais') {
        tracker.armed = true;
        tracker.armedKind = kind; // pour l'historique (voir resultKindLabelFor)
      } else {
        await synthesize(tracker, pred, rule);
      }
      tracker.streakKind = null;
      tracker.streakCount = 0;
    }
  }
}

function messageText(tracker, syn) {
  return fmt.renderMessage(effectiveFormat(tracker), {
    gameNumber: syn.target,
    suit: syn.suit,
    strategy: `${tracker.name} (combinée)`,
    maxR: panel.maxR,
    status: 'en attente',
    rattrapage: 0,
  }, null);
}

async function send(tracker, syn) {
  const targetChannels = effectiveChannels(tracker);
  if (!targetChannels.length) {
    panel.lastError = `Aucun canal configuré pour « ${tracker.name} » (ni sur la source, ni sur le panneau).`;
    return false;
  }
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return false; }
  const out = messageText(tracker, syn);
  const sentMessages = [];
  const errors = [];
  for (const id of targetChannels) {
    try {
      const m = await bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {});
      sentMessages.push({ chatId: id, messageId: m.message_id });
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  if (!sentMessages.length) { panel.lastError = errors[0] || 'Envoi impossible'; return false; }
  panel.sentCount = (panel.sentCount || 0) + 1;
  panel.lastSentAt = Date.now();
  panel.lastError = errors.length ? errors[0] : null;
  tracker.sentCount = (tracker.sentCount || 0) + 1;
  tracker.lastSentAt = Date.now();
  panel.history.unshift({
    trackerId: tracker.id, trackerName: tracker.name, target: syn.target, suit: syn.suit,
    sourceTarget: syn.sourceTarget, sourceSuit: syn.sourceSuit, mode: syn.mode || 'relais',
    triggeredBy: syn.kind, sentAt: Date.now(),
  });
  panel.history = panel.history.slice(0, 100);
  panel.pendingMessages.push({
    id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    trackerId: tracker.id, target: syn.target, suit: syn.suit, strategyName: tracker.name,
    format: effectiveFormat(tracker), maxR: panel.maxR, step: 0, gap: 0, skipped: 0,
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
  for (const t of panel.trackers) { t.lastSeenTarget = 0; t.streakKind = null; t.streakCount = 0; t.armed = false; }
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
      await bot.sendMessage(id, `🎯 PRÉDICTION COMBINÉE — message de test\n\nFormat ${panel.format} :\n\n${preview}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

function statusView() {
  return {
    ...config(),
    options: options(),
    trackers: panel.trackers.map((t) => ({
      id: t.id, key: t.key, name: t.name, rules: t.rules,
      channels: t.channels, format: t.format, streakKind: t.streakKind, streakCount: t.streakCount, armed: t.armed, armedKind: t.armedKind,
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
  options, addTracker, addTrackers, updateTracker, removeTracker,
  restore, restoreFromDb, parseChannels,
};
