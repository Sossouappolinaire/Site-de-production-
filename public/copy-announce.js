// copy-announce.js — bouton « Copie et annonce » (demande admin).
//
// Une RÈGLE relie une SOURCE à un canal Telegram de destination (l'id
// configuré) et peut faire deux choses, activables séparément ou ensemble :
//
//  1. COPIE : chaque nouvelle prédiction PUBLIÉE par la source est recopiée
//     dans le canal de destination (même format, mêmes rattrapages) et son
//     message est modifié quand le résultat tombe (gagné / perdu).
//     Source possible :
//       • une stratégie existante (ou la stratégie IA « Prédit ») ;
//       • une stratégie enregistrée : « après perte », « combinée »,
//         « répétition de costume », « rupture de costume », « chevauchement » ;
//       • un canal (id) déjà configuré : tout ce qui est publié dans ce canal.
//     Seules les prédictions créées APRÈS l'ajout de la règle sont copiées
//     (jamais l'historique déjà existant).
//
//  2. ANNONCES PLANIFIÉES : messages texte envoyés dans le canal de
//     destination, soit à intervalle régulier (toutes les 30 min, 1 h, 3 h…),
//     soit à des heures pile définies (08:00, 12:00…). L'heure est celle du
//     serveur, comme pour l'arrêt/reprise planifié (prediction-control.js).
'use strict';

const strategies = require('./strategies');
const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const { state } = require('./predictor');
const predit = require('./predit');

const panel = {
  enabled: true,
  rules: [],
  channelTitles: {},
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
};

let sender = null;
function setSender(fn) { sender = fn; }
let busy = false;

// ---------------------------------------------------------------------------
// Utilitaires
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

const newId = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const sameChannel = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
function lazy(name) { try { return require(name); } catch (_) { return null; } }

const TRACKER_MODS = [
  { prefix: 'after:', file: './after-loss', group: 'Stratégies enregistrées — Après perte', label: '' },
  { prefix: 'combo:', file: './combined', group: 'Stratégies enregistrées — Combinaisons', label: 'Combinaison — ' },
  { prefix: 'streak:', file: './suit-streak', group: 'Stratégies enregistrées — Répétition costume', label: '' },
  { prefix: 'break:', file: './suit-break', group: 'Stratégies enregistrées — Rupture costume', label: '' },
  { prefix: 'overlap:', file: './overlap', group: 'Stratégies enregistrées — Chevauchement', label: '' },
];

function options() {
  const out = [
    ...strategies.LIST.map((s) => ({ key: s.key, name: s.name, group: 'Stratégies' })),
    { key: 'ia', name: 'Stratégie IA (Prédit)', group: 'Stratégies' },
  ];
  for (const m of TRACKER_MODS) {
    const mod = lazy(m.file);
    if (!mod || !mod.panel) continue;
    for (const t of (mod.panel.trackers || [])) out.push({ key: `${m.prefix}${t.id}`, name: `${m.label}${t.name}`, group: m.group });
  }
  return out;
}

function sourceName(key) {
  if (!key) return '—';
  if (key.startsWith('channel:')) return `Canal ${key.slice('channel:'.length)}`;
  const o = options().find((x) => x.key === key);
  return o ? o.name : key;
}

function normStrategyPred(p) {
  return {
    uid: `s:${p.strategy}:${p.target}:${p.sentAt || p.id || ''}`,
    target: p.target, suit: p.suit || p.card || '', status: p.status, step: p.step || 0,
    maxR: p.maxR, format: p.format, strategyName: strategyLabel(p.strategy),
    messages: p.messages || [],
  };
}
function strategyLabel(key) {
  const s = strategies.LIST.find((x) => x.key === key);
  return s ? s.name : key;
}
function normTrackerEntry(e) {
  return {
    uid: `t:${e.id}`, target: e.target, suit: e.suit || '', status: e.status, step: e.step || 0,
    maxR: e.maxR, format: e.format, strategyName: e.strategyName, messages: e.messages || [],
  };
}

function allEntries() {
  const out = [];
  for (const p of state.predictions) out.push(normStrategyPred(p));
  try { for (const p of (predit.panel.predictions || [])) out.push(normStrategyPred({ ...p, strategy: 'ia' })); } catch (_) {}
  for (const m of TRACKER_MODS) {
    const mod = lazy(m.file);
    if (!mod || !mod.panel) continue;
    for (const e of (mod.panel.pendingMessages || [])) out.push(normTrackerEntry(e));
  }
  return out;
}

// Prédictions (normalisées) d'une source, toutes statuts confondus.
function sourceEntries(key) {
  if (!key) return [];
  if (key.startsWith('channel:')) {
    const id = key.slice('channel:'.length);
    return allEntries().filter((e) => e.messages.some((m) => sameChannel(m.chatId, id)));
  }
  for (const m of TRACKER_MODS) {
    if (!key.startsWith(m.prefix)) continue;
    const mod = lazy(m.file);
    const tid = key.slice(m.prefix.length);
    if (!mod || !mod.panel) return [];
    return (mod.panel.pendingMessages || []).filter((e) => e.trackerId === tid).map(normTrackerEntry);
  }
  if (key === 'ia') return (predit.panel.predictions || []).map((p) => normStrategyPred({ ...p, strategy: 'ia' }));
  return state.predictions.filter((p) => p.strategy === key).map(normStrategyPred);
}

// ---------------------------------------------------------------------------
// Règles
// ---------------------------------------------------------------------------
function sanitizeTime(value) {
  const m = /^(\d{1,2})[:h](\d{2})$/.exec(String(value == null ? '' : value).trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function sanitizeAnnouncement(a, previous) {
  const text = String((a && a.text) || '').trim().slice(0, 3500);
  if (!text) throw new Error('Une annonce doit contenir un message.');
  const mode = a.mode === 'times' ? 'times' : 'interval';
  const out = {
    id: (previous && previous.id) || (a && a.id) || newId('an'),
    text, mode, enabled: a.enabled !== false,
    everyMin: null, times: [],
    lastSentAt: (previous && previous.lastSentAt) || null,
    lastSlot: (previous && previous.lastSlot) || null,
    createdAt: (previous && previous.createdAt) || Date.now(),
  };
  if (mode === 'interval') {
    const n = parseInt(a.everyMin, 10);
    if (!Number.isFinite(n) || n < 1) throw new Error('Intervalle invalide (minutes).');
    out.everyMin = Math.min(n, 7 * 24 * 60);
    // prochain envoi = un intervalle après l'enregistrement
    if (!out.lastSentAt || (previous && previous.everyMin !== out.everyMin)) out.lastSentAt = Date.now();
  } else {
    const raw = Array.isArray(a.times) ? a.times : String(a.times || '').split(/[\s,;]+/);
    const times = [...new Set(raw.map(sanitizeTime).filter(Boolean))].sort();
    if (!times.length) throw new Error('Indique au moins une heure (ex. 08:00).');
    out.times = times;
  }
  return out;
}

// Historique à ignorer à la création d'une règle : tout ce qui est DÉJÀ
// terminé. Une prédiction publiée et encore « en attente » est en cours de
// jeu : elle est copiée tout de suite (sinon la règle semble ne rien faire
// jusqu'à la prochaine prédiction de la source).
function historyUids(sourceKey) {
  return sourceEntries(sourceKey)
    .filter((e) => e.status !== 'en attente' || !(e.messages || []).length)
    .map((e) => e.uid);
}

function buildRule(body, previous) {
  const copyEnabled = body.copyEnabled !== undefined ? !!body.copyEnabled : (previous ? previous.copyEnabled : true);
  const announceEnabled = body.announceEnabled !== undefined ? !!body.announceEnabled : (previous ? previous.announceEnabled : false);
  if (!copyEnabled && !announceEnabled) throw new Error('Active au moins « Copie » ou « Annonces planifiées ».');
  const dest = body.destChannels !== undefined ? parseChannels(body.destChannels) : (previous ? previous.destChannels : []);
  if (!dest.length) throw new Error("Indique l'ID du canal de destination.");
  const sourceKey = body.sourceKey !== undefined ? String(body.sourceKey || '') : (previous ? previous.sourceKey : '');
  if (copyEnabled) {
    if (!sourceKey) throw new Error('Choisis une stratégie ou un canal à copier.');
    if (!sourceKey.startsWith('channel:') && !options().some((o) => o.key === sourceKey)) throw new Error('Source introuvable.');
    if (sourceKey.startsWith('channel:') && dest.some((d) => sameChannel(d, sourceKey.slice('channel:'.length)))) {
      throw new Error('La source et la destination sont le même canal : la copie se répéterait à l\'infini.');
    }
  }
  const anns = body.announcements !== undefined
    ? (Array.isArray(body.announcements) ? body.announcements : []).map((a) => sanitizeAnnouncement(a, ((previous && previous.announcements) || []).find((x) => x.id === (a && a.id))))
    : (previous ? previous.announcements : []);
  if (announceEnabled && !anns.length) throw new Error('Ajoute au moins une annonce planifiée.');
  const rule = {
    id: (previous && previous.id) || newId('ca'),
    name: String(body.name !== undefined ? body.name : (previous ? previous.name : '')).trim().slice(0, 80),
    enabled: body.enabled !== undefined ? !!body.enabled : (previous ? previous.enabled : true),
    sourceKey, destChannels: dest, copyEnabled, announceEnabled, announcements: anns,
    // suivi de copie
    seen: previous ? previous.seen : [],
    mirrors: previous ? previous.mirrors : [],
    recent: previous ? previous.recent : [],
    copiedCount: previous ? previous.copiedCount : 0,
    announcedCount: previous ? previous.announcedCount : 0,
    lastCopyAt: previous ? previous.lastCopyAt : null,
    lastAnnounceAt: previous ? previous.lastAnnounceAt : null,
    lastError: null,
    createdAt: previous ? previous.createdAt : Date.now(),
  };
  if (!rule.name) rule.name = copyEnabled ? `Copie ${sourceName(sourceKey)}` : 'Annonces planifiées';
  // nouvelle source : on ignore tout ce qui existe déjà (historique)
  if (!previous || previous.sourceKey !== sourceKey) {
    rule.seen = sourceKey ? historyUids(sourceKey) : [];
    rule.mirrors = [];
    rule.recent = [];
  }
  // la copie vient d'être activée : même principe, on repart d'aujourd'hui
  if (previous && !previous.copyEnabled && copyEnabled) {
    rule.seen = historyUids(sourceKey);
    rule.mirrors = [];
    rule.recent = [];
  }
  return rule;
}

function addRule(body) {
  const rule = buildRule(body || {}, null);
  panel.rules.push(rule);
  persist();
  return view(rule);
}

function updateRule(id, body) {
  const i = panel.rules.findIndex((r) => r.id === id);
  if (i < 0) return null;
  panel.rules[i] = buildRule(body || {}, panel.rules[i]);
  persist();
  return view(panel.rules[i]);
}

function removeRule(id) {
  panel.rules = panel.rules.filter((r) => r.id !== id);
  persist();
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  persist();
  return config();
}
function config() { return { enabled: panel.enabled }; }

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const saved = {
    config: config(), rules: panel.rules, channelTitles: panel.channelTitles,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt,
  };
  try { store.patch({ copyAnnounce: saved }); } catch (_) {}
  if (db.ready) db.setSetting('copy_announce_state', JSON.stringify(saved)).catch((error) => { panel.lastError = error.message; });
}

function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  if (saved.config) panel.enabled = saved.config.enabled !== false;
  if (saved.channelTitles && typeof saved.channelTitles === 'object') panel.channelTitles = { ...saved.channelTitles };
  if (Array.isArray(saved.rules)) {
    panel.rules = saved.rules.map((r) => ({
      id: r.id || newId('ca'),
      name: r.name || 'Règle',
      enabled: r.enabled !== false,
      sourceKey: r.sourceKey || '',
      destChannels: parseChannels(r.destChannels),
      copyEnabled: r.copyEnabled !== false,
      announceEnabled: !!r.announceEnabled,
      announcements: Array.isArray(r.announcements) ? r.announcements.map((a) => ({ ...a })) : [],
      // Les prédictions déjà vues et les messages en cours de suivi sont
      // conservés : après un redémarrage on ne recopie JAMAIS une ancienne
      // prédiction et on continue de mettre à jour les messages en attente.
      seen: Array.isArray(r.seen) ? r.seen.slice(-600) : [],
      mirrors: Array.isArray(r.mirrors) ? r.mirrors.filter((m) => m && m.status === 'en attente') : [],
      recent: Array.isArray(r.recent) ? r.recent.slice(0, 3) : [],
      copiedCount: r.copiedCount || 0,
      announcedCount: r.announcedCount || 0,
      lastCopyAt: r.lastCopyAt || null,
      lastAnnounceAt: r.lastAnnounceAt || null,
      lastError: null,
      createdAt: r.createdAt || Date.now(),
    }));
  }
  if (Number.isFinite(Number(saved.sentCount))) panel.sentCount = Number(saved.sentCount);
  panel.lastSentAt = saved.lastSentAt || null;
}

function restore() {
  try { const saved = (store.read() || {}).copyAnnounce; if (saved) applySaved(saved); } catch (_) {}
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('copy_announce_state');
    if (raw) applySaved(JSON.parse(raw)); else persist();
  } catch (_) { persist(); }
  return config();
}

// ---------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------
async function sendTo(channels, text, extra = {}) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { sent: [], errors: ['Aucun token Telegram configuré'] };
  const results = await Promise.all(channels.map((id) =>
    bot.sendMessage(id, text, extra)
      .then((m) => (m && m.skipped ? { ok: false, skipped: true, id } : { ok: true, id, messageId: m.message_id }))
      .catch((e) => ({ ok: false, id, error: e.message }))));
  const sent = []; const errors = [];
  for (const r of results) {
    if (r.ok) sent.push({ chatId: r.id, messageId: r.messageId });
    else if (!r.skipped) errors.push(`${r.id} : ${r.error}`);
  }
  return { sent, errors };
}

function render(entry, statusFr) {
  return fmt.renderMessage(entry.format || 1, {
    gameNumber: entry.target, suit: entry.suit, strategy: entry.strategyName,
    maxR: entry.maxR != null ? entry.maxR : 1, status: statusFr, rattrapage: entry.step || 0,
  }, null);
}

async function editMirror(mirror, entry) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  const out = render({ ...entry, format: mirror.format }, entry.status);
  for (const m of mirror.messages) {
    bot.editMessageText(out.text, {
      chat_id: m.chatId, message_id: m.messageId,
      ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}),
    }).catch(() => {});
  }
}

async function processCopy(rule, paused) {
  const entries = sourceEntries(rule.sourceKey);
  const byUid = new Map(entries.map((e) => [e.uid, e]));
  // 1) mettre à jour les messages déjà copiés quand le résultat change
  for (const mirror of rule.mirrors) {
    const e = byUid.get(mirror.uid);
    if (!e) continue;
    if (e.status !== mirror.status || (e.step || 0) !== mirror.step) {
      mirror.status = e.status; mirror.step = e.step || 0;
      const r = rule.recent.find((x) => x.uid === mirror.uid);
      if (r) { r.status = e.status; r.step = e.step || 0; }
      await editMirror(mirror, e);
    }
  }
  rule.mirrors = rule.mirrors.filter((m) => m.status === 'en attente');
  if (paused) return;
  // 2) copier les nouvelles prédictions publiées (les plus anciennes d'abord)
  const fresh = entries.filter((e) => !rule.seen.includes(e.uid)).sort((a, b) => a.target - b.target);
  for (const e of fresh) {
    const published = e.messages.length > 0;
    if (!published && e.status === 'en attente') continue; // pas encore publiée : on attend
    rule.seen.push(e.uid);
    if (!published) continue;                               // jamais publiée (silencieuse) : on ne copie pas
    if (e.status !== 'en attente') continue;                // déjà terminée avant qu'on la voie : inutile
    const out = render(e, 'en attente');
    const { sent, errors } = await sendTo(rule.destChannels, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {});
    if (sent.length) {
      rule.copiedCount += 1; rule.lastCopyAt = Date.now(); rule.lastError = errors[0] || null;
      panel.sentCount += 1; panel.lastSentAt = Date.now();
      rule.recent.unshift({ uid: e.uid, target: e.target, suit: e.suit, status: 'en attente', step: e.step || 0 });
      rule.recent = rule.recent.slice(0, 3);
      rule.mirrors.push({ uid: e.uid, target: e.target, suit: e.suit, status: 'en attente', step: e.step || 0, format: e.format || 1, messages: sent, createdAt: Date.now() });
    } else if (errors.length) { rule.lastError = errors[0]; }
  }
  if (rule.seen.length > 800) rule.seen = rule.seen.slice(-600);
  if (rule.mirrors.length > 100) rule.mirrors = rule.mirrors.slice(-100);
}

// Une annonce est due : (mode intervalle) un intervalle écoulé depuis le
// dernier envoi ; (mode heures) une heure pile atteinte aujourd'hui, pas
// encore envoyée, et pas en retard de plus de 10 minutes (un redémarrage
// tardif ne renvoie pas une annonce du matin l'après-midi).
function dueSlot(a, now) {
  if (a.enabled === false) return null;
  if (a.mode === 'interval') {
    return now.getTime() - (a.lastSentAt || 0) >= a.everyMin * 60000 ? `i:${now.getTime()}` : null;
  }
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (const t of a.times || []) {
    const [h, m] = t.split(':').map(Number);
    const slotAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0).getTime();
    const diff = now.getTime() - slotAt;
    const slot = `${day} ${t}`;
    if (diff >= 0 && diff <= 10 * 60000 && a.lastSlot !== slot && !(a.doneSlots || []).includes(slot)) return slot;
  }
  return null;
}

async function processAnnouncements(rule) {
  const now = new Date();
  for (const a of rule.announcements) {
    const slot = dueSlot(a, now);
    if (!slot) continue;
    const { sent, errors } = await sendTo(rule.destChannels, a.text);
    // On marque l'envoi même en cas d'échec partiel pour ne pas boucler ;
    // si rien n'est parti (canal arrêté, token absent), on réessaie au prochain passage.
    if (!sent.length) { if (errors.length) rule.lastError = errors[0]; continue; }
    a.lastSentAt = Date.now();
    if (a.mode === 'times') {
      a.lastSlot = slot;
      a.doneSlots = [...(a.doneSlots || []), slot].slice(-(a.times.length * 2 + 2));
    }
    rule.announcedCount += 1; rule.lastAnnounceAt = Date.now(); rule.lastError = errors[0] || null;
    panel.sentCount += 1; panel.lastSentAt = Date.now();
  }
}

async function tick(opts = {}) {
  if (busy || !panel.enabled) return panel;
  const paused = !!opts.paused;
  busy = true;
  try {
    for (const rule of panel.rules) {
      if (!rule.enabled) continue;
      try {
        if (rule.copyEnabled) await processCopy(rule, paused);
        if (rule.announceEnabled && !paused) await processAnnouncements(rule);
      } catch (e) { rule.lastError = e.message; }
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

async function test(ruleId) {
  const rule = panel.rules.find((r) => r.id === ruleId);
  if (!rule) return { ok: false, error: 'Règle introuvable' };
  const { sent, errors } = await sendTo(rule.destChannels, `📣 COPIE ET ANNONCE — message de test\n\nRègle : ${rule.name}`);
  return { ok: sent.length > 0, sent: sent.map((s) => String(s.chatId)), errors };
}

function setChannelTitle(id, title) {
  const key = String(id == null ? '' : id).trim();
  if (!key || !title) return;
  if (panel.channelTitles[key] === String(title).slice(0, 120)) return;
  panel.channelTitles[key] = String(title).slice(0, 120);
  persist();
}

// ---------------------------------------------------------------------------
// Vue pour le tableau de bord
// ---------------------------------------------------------------------------
function view(rule) {
  const mirrors = (rule.mirrors || []);
  const recent = sourceEntriesSafe(rule);
  return {
    id: rule.id, name: rule.name, enabled: rule.enabled,
    sourceKey: rule.sourceKey, sourceName: rule.copyEnabled ? sourceName(rule.sourceKey) : null,
    destChannels: rule.destChannels,
    copyEnabled: rule.copyEnabled, announceEnabled: rule.announceEnabled,
    announcements: rule.announcements.map((a) => ({
      id: a.id, text: a.text, mode: a.mode, enabled: a.enabled !== false,
      everyMin: a.everyMin, times: a.times || [], lastSentAt: a.lastSentAt || null,
    })),
    copiedCount: rule.copiedCount, announcedCount: rule.announcedCount,
    lastCopyAt: rule.lastCopyAt, lastAnnounceAt: rule.lastAnnounceAt, lastError: rule.lastError,
    pendingCopies: mirrors.length,
    // 3 dernières prédictions copiées (plus récente d'abord) avec leur résultat
    lastPreds: recent, createdAt: rule.createdAt,
  };
}

function sourceEntriesSafe(rule) {
  if (!rule.copyEnabled) return [];
  return (rule.recent || []).slice(0, 3).map((e) => ({ target: e.target, suit: e.suit, status: e.status, step: e.step }));
}

function statusView() {
  return {
    ...config(),
    options: options(),
    channelTitles: panel.channelTitles,
    rules: panel.rules.map(view),
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
  };
}

module.exports = {
  panel, setSender, tick, test, status: statusView, config, configure,
  options, addRule, updateRule, removeRule, parseChannels,
  restore, restoreFromDb, setChannelTitle,
};

// exposé pour l'effacement de minuit (midnight-reset.js)
module.exports.persist = persist;
