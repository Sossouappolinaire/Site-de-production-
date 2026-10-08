// best-weak-top.js — « Meilleur + plus faible » : UN seul message de prédiction qui propose DEUX costumes.
//
// Une configuration = une stratégie source (« Dizaine — costume le plus / le moins sorti » OU « Costume faible
// sur 2 cartes (miroir) ») + un/des canaux Telegram + un nombre de rattrapages + les costumes à proposer :
// on COCHE au moins 2 parmi : le meilleur (1ᵉʳ), le 2ᵉ meilleur, le 3ᵉ meilleur, le plus faible (4ᵉ) — jusqu'à 4.
//
// Le bot attend que, pour le MÊME numéro de jeu N, la meilleure configuration du jour ET la configuration du
// plus faible (4ᵉ du classement) de la stratégie source aient chacune prédit un costume. Il envoie alors :
//
//   ♦️ 85%  ─────┐
//               ├ N°464
//   ❤️ 78%  ─────┘
//
// (pourcentage = taux de réussite du jour de chacune des deux configurations).
// Vérification sur la main du JOUEUR, avec les rattrapages de la configuration (N, N+1, N+2…). Dès qu'un des
// deux costumes sort, le message est ÉDITÉ : on garde le costume sorti et on retire l'autre :
//
//   ⚜️ #464 | ♦️ | ✅0️⃣
//
// Si les deux costumes sortent sur le même jeu, les deux restent. Si aucun ne sort : « ⚜️ #464 | ♦️ ❤️ | ❌ ».
// Si la meilleure et le plus faible ne prédisent pas le MÊME numéro de jeu, aucun message n'est envoyé.
'use strict';

const store = require('./store');
const db = require('./db');
const { state, hasSuit, setOnShoeReset } = require('./predictor');
const earlyVerify = require('./early-verify');

const STRATEGIES = {
  dizaine: 'Dizaine — costume le plus / le moins sorti',
  costumeFaible: 'Costume faible sur 2 cartes (miroir)',
};
const RANK_LABELS = { 1: 'Le meilleur', 2: 'Le 2ᵉ meilleur', 3: 'Le 3ᵉ meilleur', 4: 'Le plus faible (4ᵉ)' };
const DEFAULT_RANKS = [1, 4];
const KEYCAP = (n) => `${Number(n)}\uFE0F\u20E3`;

const panel = { configs: [], pending: [], sentCount: 0, lastSentAt: null, lastError: null, channelTitles: {} };
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }

// fournisseurs de pourcentage « en direct » (un par stratégie, enregistrés par les stratégies elles-mêmes)
const pctProviders = {};
function setPctProvider(strategy, fn) { if (typeof fn === 'function') pctProviders[strategy] = fn; }

// numéro de jeu → { best, weak } reçus des deux stratégies (mémoire seulement)
const collector = new Map();

function parseChannels(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    if (/^-?\d+$/.test(t)) { const n = Number(t); if (Number.isFinite(n) && n !== 0 && !out.includes(n)) out.push(n); }
    else { const name = t.startsWith('@') ? t : `@${t.replace(/^https?:\/\/t\.me\//i, '')}`; if (name.length > 2 && !out.includes(name)) out.push(name); }
  }
  return out;
}
const sanitizeMaxR = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, Math.min(9, n)) : 2; };
// rangs choisis : au moins 2, au plus 4, parmi 1 (meilleur) · 2 · 3 · 4 (plus faible)
function sanitizeRanks(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;]+/);
  const out = [...new Set(list.map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 4))].sort((a, b) => a - b);
  if (out.length < 2) throw new Error('Coche au moins 2 costumes (meilleur, 2ᵉ, 3ᵉ ou plus faible).');
  return out;
}
const sanitizeStrategy = (v) => (STRATEGIES[v] ? v : null);

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const saved = { configs: panel.configs, pending: panel.pending, sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, channelTitles: panel.channelTitles };
  try { store.patch({ bestWeakTop: saved }); } catch (_) {}
  if (db.ready) db.setSetting('best_weak_top_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  panel.configs = (Array.isArray(saved.configs) ? saved.configs : []).map((c) => ({
    id: String(c.id), strategy: sanitizeStrategy(c.strategy) || 'dizaine', channels: parseChannels(c.channels), maxR: sanitizeMaxR(c.maxR),
    ranks: (() => { try { return sanitizeRanks(c.ranks); } catch (_) { return DEFAULT_RANKS.slice(); } })(),
    enabled: c.enabled !== false, sentCount: Number(c.sentCount) || 0, wins: Number(c.wins) || 0, losses: Number(c.losses) || 0, lastSentAt: c.lastSentAt || null,
  })).filter((c) => c.channels.length);
  panel.pending = Array.isArray(saved.pending) ? saved.pending.slice(-200) : [];
  panel.sentCount = Number(saved.sentCount) || 0;
  panel.lastSentAt = saved.lastSentAt || null;
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
}
function restore() { try { const s = (store.read() || {}).bestWeakTop; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting('best_weak_top_state'); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------
function addConfig(input = {}) {
  const strategy = sanitizeStrategy(input.strategy);
  if (!strategy) throw new Error('Choisis la stratégie (Dizaine ou Costume faible).');
  const channels = parseChannels(input.channels);
  if (!channels.length) throw new Error('Renseigne au moins un ID de canal.');
  const cfg = { id: `bw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, strategy, channels, maxR: sanitizeMaxR(input.maxR), ranks: input.ranks === undefined ? DEFAULT_RANKS.slice() : sanitizeRanks(input.ranks), enabled: true, sentCount: 0, wins: 0, losses: 0, lastSentAt: null };
  panel.configs.push(cfg); persist(); return cfg;
}
function updateConfig(id, patch = {}) {
  const c = panel.configs.find((x) => x.id === id);
  if (!c) return null;
  if (patch.strategy !== undefined) { const s = sanitizeStrategy(patch.strategy); if (!s) throw new Error('Stratégie invalide.'); c.strategy = s; }
  if (patch.channels !== undefined) { const ch = parseChannels(patch.channels); if (!ch.length) throw new Error('Renseigne au moins un ID de canal.'); c.channels = ch; }
  if (patch.maxR !== undefined) c.maxR = sanitizeMaxR(patch.maxR);
  if (patch.ranks !== undefined) c.ranks = sanitizeRanks(patch.ranks);
  if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
  persist(); return c;
}
function removeConfig(id) { panel.configs = panel.configs.filter((c) => c.id !== id); persist(); return true; }
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }
function hasEnabled(strategy) { return panel.configs.some((c) => c.enabled && c.strategy === strategy); }

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
const pctText = (p) => (Number.isFinite(p) ? `${Math.round(p)}%` : '--%');
// items : [{ suit, pct }] dans l'ordre meilleur → plus faible (2 à 4). Une barre verticale relie tous les traits, N° au milieu.
function predictionText(target, items) {
  const line = (s) => `${s.suit} ${pctText(s.pct).padEnd(4)}─────`;
  const pad = ' '.repeat(2 + 1 + 4 + 5); // largeur de « ♦️ 85%  ───── »
  const k = items.length; let rows;
  if (k === 2) rows = [`${line(items[0])}┐`, `${pad}├ N°${target}`, `${line(items[1])}┘`];
  else if (k === 3) rows = [`${line(items[0])}┐`, `${line(items[1])}┼ N°${target}`, `${line(items[2])}┘`];
  else rows = [`${line(items[0])}┐`, `${line(items[1])}┤`, `${pad}├ N°${target}`, `${line(items[2])}┤`, `${line(items[3])}┘`];
  return `<pre>${rows.join('\n')}</pre>`;
}
function resultText(entry, shownSuits, ok) {
  const suits = (shownSuits.length ? shownSuits : [...new Set(entry.suits.map((s) => s.suit))]).join(' ');
  return `⚜️ #${entry.target} | ${suits} | ${ok ? `✅${KEYCAP(entry.step)}` : '❌'}`;
}

async function sendToChannels(cfg, text, parseMode) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return []; }
  const out = [];
  const results = await Promise.all(cfg.channels.map((id) => bot.sendMessage(id, text, parseMode ? { parse_mode: parseMode } : {})
    .then((m) => (m && m.skipped ? { ok: false, skipped: true, id } : { ok: true, id, messageId: m.message_id }))
    .catch((e) => ({ ok: false, id, error: e.message }))));
  for (const r of results) { if (r.ok) out.push({ chatId: r.id, messageId: r.messageId }); else if (!r.skipped) panel.lastError = `${r.id} : ${r.error}`; }
  return out;
}
function editAll(entry, text) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  for (const m of entry.messages || []) bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Réception des prédictions des rangs 1 (meilleur), 2, 3 et 4 (plus faible) — appelé par les deux stratégies
// ---------------------------------------------------------------------------
async function record(strategy, rank, data) {
  try {
    rank = Number(rank);
    if (!hasEnabled(strategy) || !data || !Number.isFinite(Number(data.target)) || !data.suit || !(rank >= 1 && rank <= 4)) return;
    const now = Date.now();
    for (const [k, v] of collector) if (now - v.at > 60 * 60 * 1000) collector.delete(k);
    const key = `${strategy}:${Number(data.target)}`;
    const slot = collector.get(key) || { at: now, ranks: {}, sent: new Set() };
    slot.ranks[rank] = { suit: data.suit, ref: data.ref, pct: Number.isFinite(Number(data.pct)) ? Number(data.pct) : null };
    collector.set(key, slot);
    for (const cfg of panel.configs.filter((c) => c.enabled && c.strategy === strategy && !slot.sent.has(c.id))) {
      const want = cfg.ranks && cfg.ranks.length ? cfg.ranks : DEFAULT_RANKS;
      if (!want.every((r) => slot.ranks[r])) continue; // tous les costumes cochés doivent avoir prédit ce même jeu
      slot.sent.add(cfg.id);
      // pourcentages recalculés AU MOMENT de l'envoi (taux instantané), pas à celui de leur prédiction
      const items = want.map((r) => {
        const it = { ...slot.ranks[r], rank: r };
        try { const p = pctProviders[strategy] ? pctProviders[strategy](it.ref) : null; if (Number.isFinite(p)) it.pct = p; } catch (_) { /* dernier connu */ }
        return it;
      });
      const entry = {
        id: `bwp-${now}-${Math.random().toString(36).slice(2, 6)}`, configId: cfg.id, strategy, target: Number(data.target),
        suits: items, maxR: cfg.maxR, step: 0, gap: 0, skipped: 0,
        status: 'en attente', messages: [], createdAt: now, resolvedAt: null,
      };
      entry.messages = await sendToChannels(cfg, predictionText(entry.target, items), 'HTML');
      if (!entry.messages.length) continue;
      panel.pending.push(entry);
      cfg.sentCount = (cfg.sentCount || 0) + 1; cfg.lastSentAt = now;
      panel.sentCount += 1; panel.lastSentAt = now; panel.lastError = null;
    }
    persist();
  } catch (e) { panel.lastError = e.message; }
}

// ---------------------------------------------------------------------------
// Vérification : main du JOUEUR, rattrapages N, N+1, N+2…
// ---------------------------------------------------------------------------
function maxFinishedGameNumber() { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; }
function tick() {
  const maxDone = maxFinishedGameNumber();
  let changed = false;
  for (const entry of panel.pending) {
    if (entry.status !== 'en attente') continue;
    let guard = 0;
    while (entry.status === 'en attente' && guard++ <= entry.maxR + entry.gap + 8) {
      const num = entry.target + entry.step + entry.gap;
      const g = state.games.get(num);
      const anySuit = (gg) => entry.suits.some((s) => hasSuit(gg, s.suit));
      const usable = (!!g && g.finished && g.complete !== false) || earlyVerify.hit(g, undefined, anySuit);
      if (!usable) {
        if (num + 2 <= maxDone) {
          entry.gap += 1; entry.skipped = (entry.skipped || 0) + 1;
          if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); changed = true; break; }
          continue;
        }
        break;
      }
      const hit = entry.suits.filter((s) => hasSuit(g, s.suit)).map((s) => s.suit);
      const cfg = panel.configs.find((c) => c.id === entry.configId);
      if (hit.length) {
        entry.status = 'gagné'; entry.resolvedAt = Date.now(); changed = true;
        if (cfg) cfg.wins = (cfg.wins || 0) + 1;
        editAll(entry, resultText(entry, [...new Set(hit)], true)); // on garde le(s) costume(s) sorti(s), on retire l'autre
        break;
      }
      if (entry.step >= entry.maxR) {
        entry.status = 'perdu'; entry.resolvedAt = Date.now(); changed = true;
        if (cfg) cfg.losses = (cfg.losses || 0) + 1;
        editAll(entry, resultText(entry, [], false));
        break;
      }
      entry.step += 1;
    }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pending = panel.pending.filter((e) => e.status === 'en attente' || !e.resolvedAt || e.resolvedAt >= cutoff);
  if (changed) persist();
}
setOnShoeReset(() => {
  collector.clear();
  for (const e of panel.pending) if (e.status === 'en attente') { e.status = 'annulé'; e.resolvedAt = Date.now(); }
  persist();
});

async function test(id) {
  const cfg = panel.configs.find((c) => c.id === id);
  if (!cfg) return { ok: false, error: 'Configuration introuvable' };
  const msgs = await sendToChannels(cfg, `🧪 Test\n${predictionText(464, (cfg.ranks || DEFAULT_RANKS).map((r, i) => ({ suit: ['♦️', '❤️', '♣️', '♠️'][i], pct: [85, 80, 78, 70][i] })))}`, 'HTML');
  return msgs.length ? { ok: true, sent: msgs.length } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

function status() {
  return {
    strategies: STRATEGIES, rankLabels: RANK_LABELS,
    configs: panel.configs.map((c) => ({ ...c, strategyLabel: STRATEGIES[c.strategy], ranksLabel: (c.ranks || DEFAULT_RANKS).map((r) => RANK_LABELS[r]).join(' + '), channelNames: c.channels.map((id) => panel.channelTitles[String(id)] || String(id)) })),
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastError: panel.lastError,
    waiting: panel.pending.filter((e) => e.status === 'en attente').length,
  };
}

function config() { return { count: panel.configs.length }; }
function configure() { persist(); } // import d'une sauvegarde : réécrit l'état en base

module.exports = { config, configure, setSender, setPctProvider, restore, restoreFromDb, persist, addConfig, updateConfig, removeConfig, setChannelTitle, hasEnabled, record, tick, test, status, parseChannels, STRATEGIES };
