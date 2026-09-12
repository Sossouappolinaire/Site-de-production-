// vip.js — nouveau bouton « VIP » (demande admin) :
//
//  • Liste à cocher de TOUTES les stratégies existantes + la stratégie IA
//    (« Prédit ») — pas un système « ajouter une source une par une » comme
//    after-loss.js/combined.js, mais une simple case à cocher par stratégie.
//  • Pour CHAQUE stratégie cochée, le panneau surveille en parallèle deux
//    déclencheurs indépendants (réglages communs à tout le panneau) :
//      1) N pertes CONSÉCUTIVES (par défaut 3) → relaie les R prochaines
//         prédictions de cette stratégie (par défaut 2) dans le canal VIP,
//         puis s'ARRÊTE (attend une nouvelle série de N pertes pour repartir).
//      2) N prédictions CONSÉCUTIVES du même costume (par défaut 3) → relaie
//         les R prochaines prédictions de cette stratégie (par défaut 2)
//         dans le canal VIP, puis s'arrête de la même façon.
//  • Un seul relais actif à la fois par stratégie : le premier déclencheur
//    qui atteint son seuil gagne, l'autre compteur est remis à zéro.
//  • Le relais copie la VRAIE prochaine prédiction naturelle de la stratégie
//    (costume, jeu cible), comme after-loss.js — rien n'est inventé.
'use strict';

const strategies = require('./strategies');
const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const { state, hasSuit, addSiteChannelMessage, siteChannelsView, setOnShoeReset } = require('./predictor');
const predit = require('./predit');

const panel = {
  enabled: true,
  channels: [],       // canaux Telegram du canal VIP
  siteChannelId: null, // canal du site (vitrine), facultatif, en plus des canaux Telegram
  format: 1,
  maxR: 1,
  // seuils communs à toutes les stratégies cochées :
  lossNeed: 3,         // pertes consécutives avant relais
  lossRelay: 2,        // nombre de prédictions relayées après ce déclencheur
  suitNeed: 3,         // prédictions consécutives du même costume avant relais
  suitRelay: 2,        // nombre de prédictions relayées après ce déclencheur
  selected: {},        // { <clé stratégie ou 'ia'>: true/false }
  trackers: {},        // état de suivi par clé : { lastSeenTarget, lossStreak, suitStreak, lastSuit, remaining, armedKind, sentCount, lastSentAt }
  pendingMessages: [],
  history: [],
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
};

let sender = null;
function setSender(fn) { sender = fn; }
// Bulles publiées sur le canal du site (non persistées) : { entryId -> message }
const siteEntries = new Map();
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
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value);
}

// Sources sélectionnables : toutes les stratégies existantes + la stratégie IA.
function options() {
  return [
    ...strategies.LIST.map((s) => ({ key: s.key, name: s.name })),
    { key: 'ia', name: 'Stratégie IA (Prédit)' },
  ];
}

function optionByKey(key) {
  return options().find((o) => o.key === key) || null;
}

function sanitizeSelected(value) {
  const opts = options();
  const out = {};
  for (const o of opts) out[o.key] = false;
  if (Array.isArray(value)) {
    for (const k of value) if (out[k] !== undefined) out[k] = true;
  } else if (value && typeof value === 'object') {
    for (const o of opts) out[o.key] = !!value[o.key];
  }
  return out;
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) panel.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.maxR !== undefined) panel.maxR = Math.max(0, Math.min(9, parseInt(patch.maxR, 10) || 0));
  if (patch.lossNeed !== undefined) panel.lossNeed = Math.max(1, Math.min(20, parseInt(patch.lossNeed, 10) || 3));
  if (patch.lossRelay !== undefined) panel.lossRelay = Math.max(1, Math.min(10, parseInt(patch.lossRelay, 10) || 2));
  if (patch.suitNeed !== undefined) panel.suitNeed = Math.max(1, Math.min(20, parseInt(patch.suitNeed, 10) || 3));
  if (patch.suitRelay !== undefined) panel.suitRelay = Math.max(1, Math.min(10, parseInt(patch.suitRelay, 10) || 2));
  if (patch.selected !== undefined) panel.selected = sanitizeSelected(patch.selected);
  persist();
  return config();
}

function config() {
  return {
    enabled: panel.enabled,
    channels: panel.channels,
    siteChannelId: panel.siteChannelId,
    format: panel.format,
    maxR: panel.maxR,
    lossNeed: panel.lossNeed,
    lossRelay: panel.lossRelay,
    suitNeed: panel.suitNeed,
    suitRelay: panel.suitRelay,
    selected: { ...panel.selected },
  };
}

// ---------------------------------------------------------------------------
// Persistance (même mécanisme que cards-count.js : data.json + base)
// ---------------------------------------------------------------------------
function persist() {
  const saved = {
    config: config(),
    trackers: panel.trackers,
    pendingMessages: panel.pendingMessages,
    history: panel.history,
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
  };
  try { store.patch({ vip: saved }); } catch (_) {}
  if (db.ready) db.setSetting('vip_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}

function applySaved(saved) {
  if (!saved) return;
  if (saved.config) {
    panel.enabled = saved.config.enabled !== false;
    panel.channels = parseChannels(saved.config.channels);
    panel.siteChannelId = sanitizeSiteChannelId(saved.config.siteChannelId);
    panel.format = fmt.clampFormat(saved.config.format);
    panel.maxR = Math.max(0, Math.min(9, parseInt(saved.config.maxR, 10) || 0));
    panel.lossNeed = Math.max(1, Math.min(20, parseInt(saved.config.lossNeed, 10) || 3));
    panel.lossRelay = Math.max(1, Math.min(10, parseInt(saved.config.lossRelay, 10) || 2));
    panel.suitNeed = Math.max(1, Math.min(20, parseInt(saved.config.suitNeed, 10) || 3));
    panel.suitRelay = Math.max(1, Math.min(10, parseInt(saved.config.suitRelay, 10) || 2));
    panel.selected = sanitizeSelected(saved.config.selected);
  }
  if (saved.trackers && typeof saved.trackers === 'object') {
    const clean = {};
    for (const [key, t] of Object.entries(saved.trackers)) {
      if (!t || typeof t !== 'object') continue;
      clean[key] = {
        lastSeenTarget: Number.isFinite(Number(t.lastSeenTarget)) ? Number(t.lastSeenTarget) : 0,
        lossStreak: Number.isFinite(Number(t.lossStreak)) ? Number(t.lossStreak) : 0,
        suitStreak: Number.isFinite(Number(t.suitStreak)) ? Number(t.suitStreak) : 0,
        lastSuit: t.lastSuit || null,
        remaining: Number.isFinite(Number(t.remaining)) ? Number(t.remaining) : 0,
        armedKind: t.armedKind || null,
        sentCount: Number.isFinite(Number(t.sentCount)) ? Number(t.sentCount) : 0,
        lastSentAt: t.lastSentAt || null,
      };
    }
    panel.trackers = clean;
  }
  if (Array.isArray(saved.history)) panel.history = saved.history.slice(0, 100);
  if (Array.isArray(saved.pendingMessages)) {
    // CORRECTIF « prédictions non vérifiées » (même règle qu'ailleurs) :
    // seules les entrées déjà résolues sont plafonnées à 200.
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

function restore() {
  try { applySaved((store.read() || {}).vip); } catch (_) {}
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('vip_state');
    if (raw) applySaved(JSON.parse(raw));
    else persist();
  } catch (_) { persist(); }
  return config();
}

// ---------------------------------------------------------------------------
// Suivi par stratégie cochée
// ---------------------------------------------------------------------------
function ensureTracker(key) {
  if (!panel.trackers[key]) {
    panel.trackers[key] = {
      lastSeenTarget: 0, lossStreak: 0, suitStreak: 0, lastSuit: null,
      remaining: 0, armedKind: null, sentCount: 0, lastSentAt: null,
    };
  }
  return panel.trackers[key];
}

function sourcePredictions(key) {
  if (key === 'ia') return [...predit.panel.predictions].sort((a, b) => a.target - b.target);
  return state.predictions.filter((p) => p.strategy === key).sort((a, b) => a.target - b.target);
}

function messageText(name, syn) {
  return fmt.renderMessage(panel.format, {
    gameNumber: syn.target,
    suit: syn.suit,
    strategy: `${name} (VIP)`,
    maxR: panel.maxR,
    status: 'en attente',
    rattrapage: 0,
  }, null);
}

async function relay(key, pred, reasonKind) {
  const name = (optionByKey(key) || {}).name || key;
  const targetChannels = panel.channels;
  const targetSite = panel.siteChannelId;
  if (!targetChannels.length && !targetSite) {
    panel.lastError = `Aucun canal VIP configuré (relais « ${name} » ignoré)`;
    return false;
  }
  const out = messageText(name, { target: pred.target, suit: pred.suit });
  const sentMessages = [];
  const errors = [];
  if (targetChannels.length) {
    const bot = typeof sender === 'function' ? sender() : null;
    if (!bot) errors.push('Aucun token Telegram configuré');
    else {
      for (const id of targetChannels) {
        try {
          const m = await bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {});
          sentMessages.push({ chatId: id, messageId: m.message_id });
        } catch (e) { errors.push(`${id} : ${e.message}`); }
      }
    }
  }
  let sitePosted = false;
  let siteMsg = null;
  if (targetSite) {
    siteMsg = addSiteChannelMessage(targetSite, { sender: `VIP — ${name}`, text: out.text });
    if (siteMsg) sitePosted = true; else errors.push(`Canal du site introuvable (id ${targetSite})`);
  }
  if (!sentMessages.length && !sitePosted) {
    panel.lastError = errors[0] || 'Envoi impossible';
    return false;
  }
  panel.sentCount += 1;
  panel.lastSentAt = Date.now();
  panel.lastError = errors.length ? errors[0] : null;
  panel.history.unshift({ key, name, target: pred.target, suit: pred.suit, reason: reasonKind, sentAt: Date.now() });
  panel.history = panel.history.slice(0, 100);
  const entry = {
    id: `vip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    key, name, target: pred.target, suit: pred.suit, reason: reasonKind,
    maxR: panel.maxR, step: 0, gap: 0, skipped: 0,
    status: 'en attente', messages: sentMessages, createdAt: Date.now(),
    sentAt: Date.now(), siteChannelId: targetSite || null, resolvedAt: null,
  };
  panel.pendingMessages.push(entry);
  if (siteMsg) siteEntries.set(entry.id, siteMsg);
  if (panel.pendingMessages.length > 200) {
    const keep = [];
    let resolvedCount = 0;
    for (let i = panel.pendingMessages.length - 1; i >= 0; i--) {
      const e = panel.pendingMessages[i];
      if (e.status === 'en attente' || resolvedCount < 200) { keep.unshift(e); if (e.status !== 'en attente') resolvedCount += 1; }
    }
    panel.pendingMessages = keep;
  }
  return true;
}

// Traite UNE stratégie cochée : avance sur ses prédictions non encore vues,
// relaie pendant une rafale en cours, sinon met à jour les deux compteurs de
// série (pertes / même costume) et arme une rafale dès que l'un des deux
// seuils est atteint (le premier qui arrive gagne, l'autre repart à zéro).
async function processKey(key) {
  const tr = ensureTracker(key);
  const list = sourcePredictions(key);
  for (const pred of list) {
    if (pred.target <= tr.lastSeenTarget) continue;

    // Rafale en cours : cette prédiction (résolue ou non) est relayée
    // IMMÉDIATEMENT, comme after-loss.js — rien n'est inventé.
    if (tr.remaining > 0) {
      const ok = await relay(key, pred, tr.armedKind);
      if (!ok) break; // canal indisponible : on réessaie au prochain scan
      tr.lastSeenTarget = pred.target;
      tr.remaining -= 1; tr.sentCount += 1; tr.lastSentAt = Date.now();
      if (tr.remaining <= 0) tr.armedKind = null;
      continue;
    }

    // Série de même costume : le costume prédit est connu dès que la cible
    // est fixée, pas besoin d'attendre le résultat.
    if (pred.suit) {
      if (pred.suit === tr.lastSuit) tr.suitStreak += 1; else { tr.lastSuit = pred.suit; tr.suitStreak = 1; }
    }
    if (panel.suitNeed && tr.suitStreak >= panel.suitNeed) {
      tr.lastSeenTarget = pred.target;
      tr.remaining = panel.suitRelay;
      tr.armedKind = 'costume';
      tr.suitStreak = 0;
      tr.lossStreak = 0;
      continue; // le relais démarre à la PROCHAINE prédiction, pas celle-ci
    }

    // Série de pertes : il faut attendre le résultat de chaque prédiction.
    if (pred.status === 'en attente') { tr.lastSeenTarget = pred.target; continue; }
    tr.lastSeenTarget = pred.target;
    if (pred.status === 'perdu') tr.lossStreak += 1;
    else if (pred.status === 'gagné') tr.lossStreak = 0;
    if (panel.lossNeed && tr.lossStreak >= panel.lossNeed) {
      tr.remaining = panel.lossRelay;
      tr.armedKind = 'perte';
      tr.lossStreak = 0;
      tr.suitStreak = 0;
    }
  }
}

function editPending(entry, statusFr) {
  const out = fmt.renderMessage(panel.format, {
    gameNumber: entry.target, suit: entry.suit, strategy: `${entry.name} (VIP)`,
    maxR: entry.maxR, status: statusFr, rattrapage: entry.step,
  }, null);
  const siteMsg = siteEntries.get(entry.id);
  if (siteMsg) { siteMsg.text = out.text; siteEntries.delete(entry.id); }
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
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
  for (const key of Object.keys(panel.trackers)) {
    const tr = panel.trackers[key];
    tr.lastSeenTarget = 0; tr.lossStreak = 0; tr.suitStreak = 0; tr.lastSuit = null;
    tr.remaining = 0; tr.armedKind = null;
  }
  for (const entry of panel.pendingMessages) {
    if (entry.status === 'en attente') { entry.status = 'annulé'; entry.resolvedAt = Date.now(); }
  }
  persist();
});

async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    for (const key of Object.keys(panel.selected)) {
      if (panel.selected[key]) await processKey(key);
    }
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
  if (!panel.channels.length && !panel.siteChannelId) {
    return { ok: false, error: 'Aucun canal VIP configuré', errors: ['Aucun canal VIP configuré'] };
  }
  const preview = fmt.formatPreview(panel.format, { maxR: panel.maxR });
  const text = `👑 VIP — message de test\n\nFormat ${panel.format} :\n\n${preview}`;
  const sent = [];
  const errors = [];
  if (panel.channels.length) {
    const bot = typeof sender === 'function' ? sender() : null;
    if (!bot) errors.push('Aucun token Telegram configuré');
    else {
      for (const id of panel.channels) {
        try { await bot.sendMessage(id, text); sent.push(String(id)); }
        catch (e) { errors.push(`${id} : ${e.message}`); }
      }
    }
  }
  if (panel.siteChannelId) {
    const posted = addSiteChannelMessage(panel.siteChannelId, { sender: 'VIP', text });
    if (posted) sent.push(`site:${panel.siteChannelId}`);
    else errors.push(`Canal du site introuvable (id ${panel.siteChannelId})`);
  }
  const ok = sent.length > 0;
  return { ok, sent, errors, error: ok ? null : (errors[0] || 'Envoi impossible') };
}

function statusView() {
  const opts = options();
  return {
    ...config(),
    options: opts,
    trackers: opts.map((o) => {
      const tr = panel.trackers[o.key];
      return {
        key: o.key,
        name: o.name,
        selected: !!panel.selected[o.key],
        lossStreak: tr ? tr.lossStreak : 0,
        suitStreak: tr ? tr.suitStreak : 0,
        remaining: tr ? tr.remaining : 0,
        armedKind: tr ? tr.armedKind : null,
        sentCount: tr ? tr.sentCount : 0,
        lastSentAt: tr ? tr.lastSentAt : null,
      };
    }),
    pending: panel.pendingMessages.slice(-30).map((e) => ({
      id: e.id, key: e.key, name: e.name, target: e.target, suit: e.suit, reason: e.reason,
      status: e.status, step: e.step, maxR: e.maxR, sentAt: e.sentAt, resolvedAt: e.resolvedAt,
    })),
    history: panel.history.slice(0, 30),
    siteChannels: siteChannelsView().map((c) => ({ id: c.id, name: c.name })),
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
  };
}

module.exports = {
  panel, setSender, tick, test, status: statusView, config, configure,
  restore, restoreFromDb, parseChannels, options,
};
