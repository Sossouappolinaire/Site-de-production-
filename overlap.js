// overlap.js — nouveau bouton « Chevauchement de prédictions » (demande
// admin) : système INDÉPENDANT de « Prédit après une perte » (after-loss.js),
// « Combinaisons » (combined.js), « Répétition de costume » (suit-streak.js)
// et « Rupture de costume » (suit-break.js), avec une sémantique différente
// de tous les autres :
//
//  • On sélectionne UNE source : n'importe quelle stratégie existante, la
//    stratégie IA « Prédit », OU une Formation (formation-relay.js — même
//    logique de fiabilité que dans combined.js/suit-streak.js).
//  • On surveille la source prédiction par prédiction. Dès que la source
//    prédit un jeu (n° X), on se met à la SURVEILLER tant qu'elle n'est pas
//    vérifiée (statut « en attente »).
//  • Si la source publie une NOUVELLE prédiction (jeu n° Y > X) AVANT que le
//    jeu n° X soit vérifié → on considère qu'il y a CHEVAUCHEMENT (la
//    prédiction précédente n'a pas eu le temps d'être confirmée qu'une autre
//    est déjà arrivée). On déclenche alors sur cette 2ᵉ prédiction (n° Y),
//    jamais sur la 1ʳᵉ, selon le mode choisi :
//      - 'meme'   → même prédiction : on relaie Y tel quel (même costume,
//                   même numéro de jeu).
//      - 'miroir' → même numéro de jeu Y, mais costume miroir
//                   (strategies.MIRROR — ❤️↔♦️, ♠️↔♣️, comme le mode
//                   « miroir » de after-loss.js).
//      - 'offset' → même costume que Y, mais sur le jeu Y + décalage réglable.
//  • Si au contraire le jeu n° X est vérifié (gagné/perdu/annulé) avant
//    qu'une nouvelle prédiction n'arrive → il n'y a pas de chevauchement,
//    rien ne se déclenche, et on passe simplement à la surveillance de la
//    prochaine prédiction dès qu'elle apparaît.
//  • Toujours sur la main du JOUEUR : vérification via hasSuit(), jamais
//    hasSuitBanker() (comme combined.js/suit-streak.js/suit-break.js).
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
// IA « Prédit », les Formations, ET (comme les autres panneaux « frères »)
// les trackers « après perte », les combos, les répétitions et ruptures de
// costume. Require() PARESSEUX de ces modules : ce fichier ne doit pas créer
// de cycle avec eux (aucun des cinq ne se requiert au chargement).
// ---------------------------------------------------------------------------
function afterLossOptions() {
  try {
    const afterLoss = require('./after-loss');
    return (afterLoss.panel.trackers || []).map((t) => ({ key: `after:${t.id}`, name: t.name, group: 'Stratégies enregistrées' }));
  } catch (_) { return []; }
}

function combinedOptions() {
  try {
    const combined = require('./combined');
    return (combined.panel.trackers || []).map((t) => ({ key: `combo:${t.id}`, name: `Combinaison — ${t.name}`, group: 'Combinaisons' }));
  } catch (_) { return []; }
}

function suitStreakOptions() {
  try {
    const suitStreak = require('./suit-streak');
    return (suitStreak.panel.trackers || []).map((t) => ({ key: `streak:${t.id}`, name: `Répétition — ${t.name}`, group: 'Répétitions de costume' }));
  } catch (_) { return []; }
}

function suitBreakOptions() {
  try {
    const suitBreak = require('./suit-break');
    return (suitBreak.panel.trackers || []).map((t) => ({ key: `break:${t.id}`, name: `Rupture — ${t.name}`, group: 'Ruptures de costume' }));
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
  return [...base, ...formations, ...afterLossOptions(), ...combinedOptions(), ...suitStreakOptions(), ...suitBreakOptions()];
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
  if (key.startsWith('streak:')) {
    try { return require('./suit-streak').pendingFor(key.slice('streak:'.length)); } catch (_) { return []; }
  }
  if (key.startsWith('break:')) {
    try { return require('./suit-break').pendingFor(key.slice('break:'.length)); } catch (_) { return []; }
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
function sanitizeMode(value) {
  return (value === 'miroir' || value === 'offset') ? value : 'meme'; // 'meme' par défaut = même prédiction (relais)
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
  try { store.patch({ overlap: saved }); } catch (_) {}
  if (db.ready) db.setSetting('overlap_state', JSON.stringify(saved)).catch((error) => { panel.lastError = error.message; });
}

function restore() {
  try {
    const saved = (store.read() || {}).overlap;
    if (saved) applySaved(saved);
  } catch (_) {}
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('overlap_state');
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
      mode: sanitizeMode(t.mode),
      offset: sanitizeOffset(t.offset),
      channels: Array.isArray(t.channels) ? parseChannels(t.channels) : [],
      siteChannelId: sanitizeSiteChannelId(t.siteChannelId),
      format: t.format ? fmt.clampFormat(t.format) : null,
      maxR: sanitizeTrackerMaxR(t.maxR),
      // la surveillance en cours n'est jamais rejouée telle quelle depuis
      // data.json au redémarrage — on repart de zéro, recalé sur la
      // dernière prédiction déjà connue (jamais rejouée), même principe
      // que suit-streak.js/suit-break.js.
      watching: null,
      lastSeenTarget: currentMaxTarget(t.key),
      overlapCount: Number.isFinite(Number(t.overlapCount)) ? Number(t.overlapCount) : 0,
      sentCount: Number.isFinite(Number(t.sentCount)) ? Number(t.sentCount) : 0,
      lastSentAt: t.lastSentAt || null,
      createdAt: t.createdAt || Date.now(),
    }));
  }
  // l'historique et les messages en attente ne sont jamais rejoués au
  // démarrage — ils ne doivent refléter que ce qui se passe APRÈS.
  panel.history = [];
  panel.pendingMessages = [];
  if (Number.isFinite(Number(saved.sentCount))) panel.sentCount = Number(saved.sentCount);
  panel.lastSentAt = saved.lastSentAt || null;
  panel.lastScanAt = saved.lastScanAt || null;
}

// ---------------------------------------------------------------------------
// Gestion des sources suivies
// ---------------------------------------------------------------------------
function addTracker(key, extra = {}) {
  const opt = optionByKey(key);
  if (!opt) throw new Error('Source inconnue pour le chevauchement de prédictions.');
  const tracker = {
    id: `ov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    key: opt.key,
    name: (extra.name && String(extra.name).trim()) || opt.name,
    mode: sanitizeMode(extra.mode),
    offset: sanitizeOffset(extra.offset),
    channels: parseChannels(extra.channels),
    siteChannelId: sanitizeSiteChannelId(extra.siteChannelId),
    format: sanitizeTrackerFormat(extra.format),
    maxR: sanitizeTrackerMaxR(extra.maxR),
    watching: null,
    // on ne rejoue pas l'historique déjà passé au moment de l'ajout.
    lastSeenTarget: currentMaxTarget(opt.key),
    overlapCount: 0,
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
  if (patch.mode !== undefined) tracker.mode = sanitizeMode(patch.mode);
  if (patch.offset !== undefined) tracker.offset = sanitizeOffset(patch.offset);
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
// règle complète (surveillance d'UNE prédiction à la fois, déclenchement
// uniquement en cas de chevauchement avec la suivante).
// ---------------------------------------------------------------------------
async function fire(tracker, pred) {
  const sourceSuit = pred.suit || null;
  if (!sourceSuit) return;
  let suit = sourceSuit;
  let target = pred.target;
  if (tracker.mode === 'miroir') {
    suit = strategies.MIRROR[sourceSuit] || sourceSuit;
  } else if (tracker.mode === 'offset') {
    target = pred.target + tracker.offset;
  }
  // mode 'meme' (par défaut) = même prédiction : suit + target identiques.
  tracker.overlapCount = (tracker.overlapCount || 0) + 1;
  await send(tracker, { target, suit, sourceTarget: pred.target, sourceSuit, mode: tracker.mode });
}

async function processTracker(tracker) {
  if (isFormationSource(tracker.key)) {
    const base = baseKeyOf(tracker.key);
    const trustKey = base === 'ia' ? 'predit' : base; // formation.js utilise la clé 'predit' pour le panneau IA
    const trust = formationRelay.formationTrusted(trustKey);
    if (!trust.ok) return; // formation pas (ou plus) fiable : on ne traite rien ce tour-ci
  }
  const list = trackerPredictions(tracker.key);

  // Cas 1 : on surveille déjà une prédiction encore en attente (le jeu n° X
  // du commentaire d'en-tête).
  if (tracker.watching != null) {
    const watched = list.find((p) => p.target === tracker.watching);
    const next = list.find((p) => p.target > tracker.watching);
    if (next) {
      // Chevauchement : une 2ᵉ prédiction (jeu n° Y) est arrivée avant que
      // la 1ʳᵉ (jeu n° X) ait été vérifiée — peu importe l'état de X à cet
      // instant précis. On déclenche sur CETTE 2ᵉ, jamais sur la 1ʳᵉ.
      tracker.lastSeenTarget = next.target;
      tracker.watching = null;
      await fire(tracker, next);
      return;
    }
    if (watched && watched.status !== 'en attente') {
      // La 1ʳᵉ prédiction s'est résolue avant qu'une 2ᵉ n'arrive : pas de
      // chevauchement, rien à faire — on arrête de la surveiller et on
      // repart en veille (Cas 2 au prochain tour).
      tracker.lastSeenTarget = tracker.watching;
      tracker.watching = null;
    }
    return; // on attend encore soit la résolution, soit une 2ᵉ prédiction
  }

  // Cas 2 : pas de surveillance en cours — on cherche la prochaine
  // prédiction jamais vue de cette source.
  const pred = list.find((p) => p.target > tracker.lastSeenTarget);
  if (!pred) return;
  if (pred.status === 'en attente') {
    // Elle n'est pas encore vérifiée : on commence à la surveiller (jeu
    // n° X). On ne déclenche rien tant qu'aucune 2ᵉ prédiction n'arrive.
    tracker.watching = pred.target;
  } else {
    // Déjà résolue au moment où on la voit pour la première fois : rien de
    // spécial (pas de chevauchement possible), on avance simplement.
    tracker.lastSeenTarget = pred.target;
  }
}

function messageText(tracker, syn) {
  const modeLabel = tracker.mode === 'miroir' ? 'chevauchement, costume miroir'
    : tracker.mode === 'offset' ? `chevauchement, +${tracker.offset} jeux`
    : 'chevauchement, même prédiction';
  return fmt.renderMessage(effectiveFormat(tracker), {
    gameNumber: syn.target,
    suit: syn.suit,
    strategy: `${tracker.name} (${modeLabel})`,
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
      // envoi en PARALLÈLE à tous les canaux (jamais un for...await
      // séquentiel — voir le correctif appliqué aux autres panneaux).
      const results = await Promise.all(targetChannels.map((id) =>
        bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {})
          .then((m) => ({ ok: true, id, messageId: m.message_id }))
          .catch((e) => ({ ok: false, id, error: e.message }))
      ));
      for (const r of results) {
        if (r.ok) { sentMessages.push({ chatId: r.id, messageId: r.messageId }); ok = true; }
        else errors.push(`${r.id} : ${r.error}`);
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
    sourceTarget: syn.sourceTarget, mode: syn.mode, sentAt: Date.now(),
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
// être consommée à l'identique par les autres panneaux (bridge symétrique,
// clé `overlap:<id>` côté de ces fichiers si besoin).
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
    t.lastSeenTarget = 0; t.watching = null;
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
    // trackers traités en PARALLÈLE (voir le correctif « envoi en retard »
    // appliqué aux autres panneaux).
    await Promise.all(panel.trackers.map((tracker) => processTracker(tracker)));
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
      await bot.sendMessage(id, `🎯 CHEVAUCHEMENT DE PRÉDICTIONS — message de test\n\nFormat ${panel.format} :\n\n${preview}`);
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
    // la page « Canaux » (voir predictor.js/siteChannelsView), identique
    // aux autres panneaux.
    siteChannels: siteChannelsView().map((c) => ({ id: c.id, name: c.name })),
    trackers: panel.trackers.map((t) => ({
      id: t.id, key: t.key, name: t.name, mode: t.mode, offset: t.offset,
      channels: t.channels, siteChannelId: t.siteChannelId, format: t.format, maxR: t.maxR,
      watching: t.watching, overlapCount: t.overlapCount,
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
