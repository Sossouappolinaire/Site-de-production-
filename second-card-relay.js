// second-card-relay.js — relais « après perte » de la stratégie « 2ᵉ carte du joueur » (demande admin).
//
// Fonctionne comme une configuration CACHÉE qui travaille en arrière-plan, sans avoir à la créer :
//  • Elle suit TOUTES les prédictions de la stratégie « secondeCarte », publiées OU silencieuses
//    (pendant la pause de « série puis pause », la stratégie continue de prédire et de se vérifier).
//  • Dès qu'une de ces prédictions est PERDUE, les N prochaines prédictions de la stratégie
//    (N = 1 à 10, 2 par défaut ; 2, 3 ou 4 en pratique) sont envoyées dans un canal (ID) DIFFÉRENT de
//    ceux de la stratégie, puis le relais se remet en veille jusqu'à la perte suivante.
//  • La stratégie standard n'a rien à voir avec ce relais : elle continue d'envoyer comme avant.
//  • Anti-doublon : si la même prédiction (même numéro de jeu ET même costume) a déjà été relayée,
//    elle est ignorée (non comptée dans les N).
//  • Chaque message relayé est vérifié (rattrapages de la stratégie) puis édité avec le résultat.
'use strict';

const strategies = require('./strategies');
const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const { state, hasSuit, addSiteChannelMessage, setOnShoeReset } = require('./predictor');
const earlyVerify = require('./early-verify');

const KEY = 'secondeCarte';

const panel = {
  enabled: false,       // désactivé par défaut : à activer depuis la fiche de la stratégie
  channels: [],         // canal(aux) qui reçoivent les prédictions relayées
  siteChannelId: null,
  count: 2,             // nombre de prédictions relayées après une perte
  format: 0,            // 0 = format de la stratégie
  tracker: { lastSeenTarget: 0, remaining: 0, sentCount: 0, lastSentAt: null, lastLossTarget: null },
  pendingMessages: [],
  sentKeys: [],         // anti-doublon : « cible|costume » déjà relayés (sabot en cours)
  history: [],
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
};

let sender = null;
function setSender(fn) { sender = fn; }
const siteEntries = new Map();
let busy = false;

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------
function parseChannels(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const v = String(raw == null ? '' : raw).trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
function sanitizeCount(v) { return Math.max(1, Math.min(10, parseInt(v, 10) || 2)); }
function sanitizeSiteChannelId(v) { return v === null || v === undefined || v === '' ? null : v; }
function strategyCfg() { return state.strategies[KEY] || strategies.defaultsFor(KEY) || {}; }
function effectiveFormat() { return panel.format ? fmt.clampFormat(panel.format) : fmt.clampFormat(strategyCfg().format || 1); }
function effectiveMaxR() { const m = parseInt(strategyCfg().maxR, 10); return Number.isFinite(m) ? Math.max(0, Math.min(9, m)) : 1; }
function strategyName() { return `${((strategies.BY_KEY[KEY] || {}).name || KEY).split(' · ')[0]} (relais)`; }

function sourcePredictions() {
  return state.predictions.filter((p) => p.strategy === KEY).sort((a, b) => a.target - b.target);
}
// on repart de la dernière prédiction déjà connue : jamais de rejeu de l'ancien
function syncTracker() {
  const list = sourcePredictions();
  panel.tracker.lastSeenTarget = list.length ? list[list.length - 1].target : 0;
  panel.tracker.remaining = 0;
}

function configure(patch = {}) {
  const wasEnabled = panel.enabled;
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.count !== undefined) panel.count = sanitizeCount(patch.count);
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) panel.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.format !== undefined) { const f = parseInt(patch.format, 10); panel.format = Number.isFinite(f) && f > 0 ? fmt.clampFormat(f) : 0; }
  if (panel.enabled && !wasEnabled) syncTracker(); // activation : on n'envoie rien du passé
  persist();
  return config();
}

function config() {
  return { enabled: panel.enabled, channels: panel.channels, siteChannelId: panel.siteChannelId, count: panel.count, format: panel.format };
}

// ---------------------------------------------------------------------------
// Persistance (data.json + base)
// ---------------------------------------------------------------------------
function persist() {
  const saved = { config: config(), sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt };
  try { store.patch({ secondCardRelay: saved }); } catch (_) {}
  if (db.ready) db.setSetting('second_card_relay_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  if (saved.config) {
    panel.enabled = saved.config.enabled === true;
    panel.channels = parseChannels(saved.config.channels);
    panel.siteChannelId = sanitizeSiteChannelId(saved.config.siteChannelId);
    panel.count = sanitizeCount(saved.config.count);
    const f = parseInt(saved.config.format, 10);
    panel.format = Number.isFinite(f) && f > 0 ? fmt.clampFormat(f) : 0;
  }
  if (Number.isFinite(Number(saved.sentCount))) panel.sentCount = Number(saved.sentCount);
  panel.lastSentAt = saved.lastSentAt || null;
  panel.lastScanAt = saved.lastScanAt || null;
  syncTracker(); // jamais de rejeu au démarrage
  panel.pendingMessages = []; panel.history = []; panel.sentKeys = [];
}
function restore() { try { applySaved((store.read() || {}).secondCardRelay); } catch (_) {} return config(); }
async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('second_card_relay_state');
    if (raw) applySaved(JSON.parse(raw)); else persist();
  } catch (_) { persist(); }
  return config();
}

// ---------------------------------------------------------------------------
// Envoi / édition / vérification
// ---------------------------------------------------------------------------
function render(entryLike, statusFr) {
  return fmt.renderMessage(entryLike.format, {
    gameNumber: entryLike.target, suit: entryLike.suit, strategy: strategyName(),
    maxR: entryLike.maxR, status: statusFr, rattrapage: entryLike.step || 0,
  }, null);
}
const keyOf = (target, suit) => `${target}|${suit}`;

async function relay(pred) {
  const targetSite = panel.siteChannelId;
  if (!panel.channels.length && !targetSite) { panel.lastError = 'Aucun canal configuré pour le relais'; return false; }
  const entry = { target: pred.target, suit: pred.suit, format: effectiveFormat(), maxR: effectiveMaxR(), step: 0, gap: 0, skipped: 0 };
  const out = render(entry, 'en attente');
  const sent = []; const errors = [];
  if (panel.channels.length) {
    const bot = typeof sender === 'function' ? sender() : null;
    if (!bot) errors.push('Aucun token Telegram configuré');
    else {
      for (const id of panel.channels) {
        try {
          const m = await bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {});
          sent.push({ chatId: id, messageId: m.message_id });
        } catch (e) { errors.push(`${id} : ${e.message}`); }
      }
    }
  }
  let siteMsg = null;
  if (targetSite) {
    siteMsg = addSiteChannelMessage(targetSite, { sender: 'Relais 2ᵉ carte', text: out.text });
    if (!siteMsg) errors.push(`Canal du site introuvable (id ${targetSite})`);
  }
  if (!sent.length && !siteMsg) { panel.lastError = errors[0] || 'Envoi impossible'; return false; }
  const full = {
    ...entry, id: `scr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    status: 'en attente', messages: sent, createdAt: Date.now(), sentAt: Date.now(), resolvedAt: null,
  };
  panel.pendingMessages.push(full);
  if (siteMsg) siteEntries.set(full.id, siteMsg);
  panel.sentKeys.push(keyOf(pred.target, pred.suit)); panel.sentKeys = panel.sentKeys.slice(-200);
  panel.history.unshift({ target: pred.target, suit: pred.suit, sentAt: Date.now() }); panel.history = panel.history.slice(0, 50);
  panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = errors.length ? errors[0] : null;
  return true;
}

function editEntry(entry, statusFr) {
  const out = render(entry, statusFr);
  const siteMsg = siteEntries.get(entry.id);
  if (siteMsg) { siteMsg.text = out.text; siteEntries.delete(entry.id); }
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  for (const m of entry.messages) {
    bot.editMessageText(out.text, { chat_id: m.chatId, message_id: m.messageId, ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}) }).catch(() => {});
  }
}

function maxFinishedGameNumber() {
  let max = 0;
  for (const g of state.games.values()) if (g.finished && g.number > max) max = g.number;
  return max;
}

function verifyPending() {
  const maxDone = maxFinishedGameNumber();
  for (const entry of panel.pendingMessages) {
    if (entry.status !== 'en attente') continue;
    let guard = 0;
    while (entry.status === 'en attente' && guard++ <= entry.maxR + entry.gap + 8) {
      const num = entry.target + entry.step + entry.gap;
      const g = state.games.get(num);
      const usable = (!!g && g.finished && g.complete !== false) || earlyVerify.hit(g, 'suit', (gg) => hasSuit(gg, entry.suit));
      if (!usable) {
        if (num + 2 <= maxDone) {
          entry.gap += 1; entry.skipped = (entry.skipped || 0) + 1;
          if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); break; }
          continue;
        }
        break;
      }
      if (hasSuit(g, entry.suit)) { entry.status = 'gagné'; entry.resolvedAt = Date.now(); editEntry(entry, 'gagné'); break; }
      if (entry.step >= entry.maxR) { entry.status = 'perdu'; entry.resolvedAt = Date.now(); editEntry(entry, 'perdu'); break; }
      entry.step += 1;
    }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pendingMessages = panel.pendingMessages.filter((e) => e.status === 'en attente' || !e.resolvedAt || e.resolvedAt >= cutoff);
}

// ---------------------------------------------------------------------------
// Moteur : une perte arme le relais des N prochaines prédictions
// ---------------------------------------------------------------------------
async function process() {
  const tr = panel.tracker;
  for (const pred of sourcePredictions()) {
    if (pred.target <= tr.lastSeenTarget) continue;
    if (tr.remaining > 0) {
      // anti-doublon : même numéro + même costume déjà relayé → ignoré (pas compté dans les N)
      if (panel.sentKeys.includes(keyOf(pred.target, pred.suit))) { tr.lastSeenTarget = pred.target; continue; }
      const ok = await relay(pred);
      if (!ok) break; // canal indisponible : nouvel essai au prochain scan
      tr.lastSeenTarget = pred.target; tr.remaining -= 1; tr.sentCount += 1; tr.lastSentAt = Date.now();
      continue;
    }
    // une prédiction « en attente » est traitée au tour suivant, une fois son résultat connu
    if (pred.status === 'en attente') break;
    tr.lastSeenTarget = pred.target;
    if (pred.status === 'perdu') { tr.remaining = panel.count; tr.lastLossTarget = pred.target; }
  }
}

setOnShoeReset(() => {
  panel.tracker = { lastSeenTarget: 0, remaining: 0, sentCount: panel.tracker.sentCount, lastSentAt: panel.tracker.lastSentAt, lastLossTarget: null };
  panel.sentKeys = [];
  for (const e of panel.pendingMessages) if (e.status === 'en attente') { e.status = 'annulé'; e.resolvedAt = Date.now(); }
  persist();
});

async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    await process();
    verifyPending();
    panel.lastScanAt = Date.now();
  } catch (e) { panel.lastError = e.message; } finally { persist(); busy = false; }
  return panel;
}

async function test() {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  if (!panel.channels.length) return { ok: false, error: 'Renseigne d’abord le canal du relais' };
  const errors = [];
  for (const id of panel.channels) {
    try { await bot.sendMessage(id, '✅ Test — relais « 2ᵉ carte du joueur » : ce canal recevra les prochaines prédictions après une perte.'); }
    catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return errors.length ? { ok: false, error: errors[0] } : { ok: true };
}

function statusView() {
  const tr = panel.tracker;
  const cfg = strategyCfg();
  return {
    ...config(),
    effectiveFormat: effectiveFormat(), effectiveMaxR: effectiveMaxR(),
    remaining: tr.remaining, armed: tr.remaining > 0, lastLossTarget: tr.lastLossTarget,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt, lastError: panel.lastError,
    strategyChannels: [...(cfg.publishedChannels || cfg.channels || []), ...(cfg.shadowChannels || [])].map(String),
    pending: panel.pendingMessages.filter((e) => e.status === 'en attente').length,
    history: panel.history.slice(0, 20),
  };
}

module.exports = { panel, setSender, tick, test, status: statusView, config, configure, restore, restoreFromDb, parseChannels, persist };
