// best-weak-top.js — « Meilleur + plus faible » : deux modes de configuration, pour les deux stratégies
// « Dizaine — costume le plus / le moins sorti » et « Costume faible sur 2 cartes (miroir) ».
//
// ─── Mode « multi » : UN message de prédiction qui propose 2 à 4 costumes ───────────────────────────────────────
//   On coche au moins 2 parmi : le meilleur (1ᵉʳ), le 2ᵉ, le 3ᵉ meilleur, le plus faible (4ᵉ). Quand tous ceux qui sont
//   cochés ont prédit le MÊME numéro de jeu, un seul message part, avec le pourcentage instantané de chacun :
//
//       ♦️ 85%  ─────┐
//                   ├ N°464
//       ❤️ 78%  ─────┘
//
//   Dès qu'un costume sort (main du JOUEUR, rattrapages N, N+1…), le message est édité : on garde le(s) costume(s) sorti(s)
//   « ⚜️ #464 | ♦️ | ✅0️⃣ », ou « ⚜️ #464 | ♦️ ❤️ | ❌ » si aucun ne sort.
//
// ─── Mode « déclencheur » (bouton de l'accueil) : prédiction simple, au format choisi ────────────────────────────
//   Le bot surveille les 4 configurations (meilleur, 2ᵉ, 3ᵉ, 4ᵉ) et envoie une prédiction dans le canal quand :
//     1. une configuration vient d'enchaîner 2 PERTES consécutives        → sa prochaine prédiction est envoyée ;
//     2. une configuration a gagné 2 fois de suite au rattrapage 2 ou 3   → sa prochaine prédiction est envoyée ;
//     3. un costume n'est pas sorti (main du joueur) depuis 13 jeux       → ce costume est prédit à N+1 ET à N+5.
//   Le message est ensuite édité au résultat (✅ / ❌) avec le même format.
//
// ─── Mode « cycle » : on suit UNE configuration à la fois, parmi les 4 ──────────────────────────────────────────
//   On suit d'abord le MEILLEUR (A) et on envoie ses prédictions. Tant que chaque prédiction envoyée gagne en ✅0️⃣ ou
//   ✅1️⃣, on reste sur la même configuration. Dès qu'une prédiction finit en ✅2️⃣, ✅3️⃣ (ou plus) ou ❌, on passe à la suivante,
//   dans l'ordre : meilleur → plus faible → 2ᵉ meilleur → 3ᵉ meilleur. Une seule prédiction à la fois.
//   Quand les 4 sont passées, le cycle NE recommence PAS tout seul : on attend qu'une des 4 configurations PERDE (une des
//   prédictions à venir). Celle qui perd est alors suivie : sa prochaine prédiction est envoyée, et les mêmes règles
//   s'appliquent (elle reste tant que ✅0️⃣/✅1️⃣, puis on enchaîne dans l'ordre jusqu'à avoir refait le tour des 4).
//
// ─── Mode « suivi » (bouton « Créer » de l'accueil) : suivre les messages à plusieurs costumes du bot ────────────
//   On coche, dans la liste de tous les canaux qui reçoivent des prédictions, ceux à suivre. Chaque message à plusieurs
//   costumes que CE bot publie dans un canal coché (♦️ 95% / ♣️ 93% / N°884) donne une prédiction simple, au format choisi :
//     • rotation : 1ᵉʳ costume au 1ᵉʳ message, 2ᵉ costume au suivant, 3ᵉ au suivant s'il y en a 3 ; avec 2 costumes on
//       revient au 1ᵉʳ (le compteur tourne par canal suivi) ;
//     • motif : si le 1ᵉʳ costume gagne (jeu N) et que le 2ᵉ gagne au rattrapage (jeu N+1), on prédit le 2ᵉ costume au jeu N+2.
//
// ─── ANTI-DOUBLONS ─────────────────────────────────────────────────────────────────────────────────────────────
//   • configurations : deux configurations identiques (même mode, même stratégie, mêmes costumes et un canal en commun)
//     sont refusées à la création / modification, et les doublons déjà enregistrés sont fusionnés au chargement ;
//   • prédictions : une configuration n'envoie JAMAIS deux prédictions pour le même numéro de jeu (verrou pendant l'envoi
//     + mémoire persistée des envois, valable après un redémarrage).
'use strict';

const store = require('./store');
const db = require('./db');
const { state, hasSuit, setOnShoeReset } = require('./predictor');
const earlyVerify = require('./early-verify');
const fmt = require('./formats');

const STRATEGIES = {
  dizaine: 'Dizaine — costume le plus / le moins sorti',
  costumeFaible: 'Costume faible sur 2 cartes (miroir)',
};
const RANK_LABELS = { 1: 'Le meilleur', 2: 'Le 2ᵉ meilleur', 3: 'Le 3ᵉ meilleur', 4: 'Le plus faible (4ᵉ)' };
const DEFAULT_RANKS = [1, 4];
const SUITS = ['♦️', '❤️', '♣️', '♠️'];
const TRIGGER = { lossRun: 2, bigSteps: [2, 3], bigStepRun: 2, absenceGames: 13, offsets: [1, 5] };
const TRIGGER_LABEL = `${TRIGGER.lossRun} pertes de suite · ${TRIGGER.bigStepRun}× rattrapage 2 ou 3 de suite · costume absent ${TRIGGER.absenceGames} jeux (+${TRIGGER.offsets.join(' et +')})`;
const CYCLE_ORDER = [1, 4, 2, 3]; // meilleur → plus faible → 2ᵉ → 3ᵉ → (retour au meilleur)
const CYCLE_STAY_STEPS = [0, 1];  // ✅0️⃣ ou ✅1️⃣ : on reste sur la même configuration
const TZ = process.env.RESET_TZ || 'Africa/Abidjan';
const KEYCAP = (n) => `${Number(n)}\uFE0F\u20E3`;
const dayKey = (ts = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));

const panel = {
  configs: [], pending: [], recentSent: [], watch: [], duplicatesRemoved: 0, duplicatesBlocked: 0,
  trig: { day: null, results: {}, armed: {}, absenceFired: {} },
  sentCount: 0, lastSentAt: null, lastError: null, channelTitles: {},
};
const inflight = new Set(); // « configuration:jeu » en cours d'envoi (verrou anti-doublon)
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }

// fournisseurs de pourcentage « en direct » (un par stratégie, enregistrés par les stratégies elles-mêmes)
const pctProviders = {};
function setPctProvider(strategy, fn) { if (typeof fn === 'function') pctProviders[strategy] = fn; }

// fournisseurs de rang (1 meilleur · 2 · 3 · 4 plus faible) d'une configuration, par stratégie
const rankProviders = {};
function setRankProvider(strategy, fn) { if (typeof fn === 'function') rankProviders[strategy] = fn; }

// numéro de jeu → rangs ayant prédit (mode multi, mémoire seulement)
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
const sanitizeStrategy = (v) => (STRATEGIES[v] ? v : null);
const sanitizeMode = (v) => (['trigger', 'cycle', 'follow'].includes(v) ? v : 'multi');
const sanitizeFormat = (v) => fmt.clampFormat(v);
const sanitizeName = (v) => String(v == null ? '' : v).trim().slice(0, 60);
const modeOf = (c) => (c && ['trigger', 'cycle', 'follow'].includes(c.mode) ? c.mode : 'multi');
const simpleMode = (c) => modeOf(c) !== 'multi'; // déclencheur ou cycle : message simple au format choisi
// rangs choisis (mode multi) : au moins 2, au plus 4, parmi 1 (meilleur) · 2 · 3 · 4 (plus faible)
function sanitizeRanks(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;]+/);
  const out = [...new Set(list.map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 4))].sort((a, b) => a - b);
  if (out.length < 2) throw new Error('Coche au moins 2 costumes (meilleur, 2ᵉ, 3ᵉ ou plus faible).');
  return out;
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const saved = {
    configs: panel.configs, pending: panel.pending, recentSent: panel.recentSent, watch: panel.watch, trig: panel.trig,
    duplicatesRemoved: panel.duplicatesRemoved, duplicatesBlocked: panel.duplicatesBlocked,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, channelTitles: panel.channelTitles,
  };
  try { store.patch({ bestWeakTop: saved }); } catch (_) {}
  if (db.ready) db.setSetting('best_weak_top_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  panel.configs = (Array.isArray(saved.configs) ? saved.configs : []).map((c) => {
    const mode = modeOf(c);
    return {
      id: String(c.id), mode, name: sanitizeName(c.name), strategy: mode === 'follow' ? 'follow' : (sanitizeStrategy(c.strategy) || 'dizaine'), channels: parseChannels(c.channels),
      sources: mode === 'follow' ? parseChannels(c.sources).map(String) : [], rot: c.rot && typeof c.rot === 'object' ? c.rot : {},
      maxR: sanitizeMaxR(c.maxR), format: sanitizeFormat(c.format),
      cycleRole: CYCLE_ORDER.includes(Number(c.cycleRole)) ? Number(c.cycleRole) : 1, cycleWaiting: !!c.cycleWaiting,
      cycleDone: Array.isArray(c.cycleDone) ? c.cycleDone.map(Number).filter((r) => CYCLE_ORDER.includes(r)) : [],
      ranks: mode !== 'multi' ? [] : (() => { try { return sanitizeRanks(c.ranks); } catch (_) { return DEFAULT_RANKS.slice(); } })(),
      enabled: c.enabled !== false, sentCount: Number(c.sentCount) || 0, wins: Number(c.wins) || 0, losses: Number(c.losses) || 0, lastSentAt: c.lastSentAt || null,
    };
  }).filter((c) => c.channels.length);
  panel.pending = Array.isArray(saved.pending) ? saved.pending.slice(-300) : [];
  panel.recentSent = Array.isArray(saved.recentSent) ? saved.recentSent.slice(-500) : [];
  panel.watch = Array.isArray(saved.watch) ? saved.watch.slice(-100) : [];
  const t = saved.trig && typeof saved.trig === 'object' ? saved.trig : {};
  panel.trig = { day: t.day || null, results: t.results || {}, armed: t.armed || {}, absenceFired: t.absenceFired || {} };
  panel.duplicatesRemoved = Number(saved.duplicatesRemoved) || 0;
  panel.duplicatesBlocked = Number(saved.duplicatesBlocked) || 0;
  panel.sentCount = Number(saved.sentCount) || 0;
  panel.lastSentAt = saved.lastSentAt || null;
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
  dedupeConfigs();
}
function restore() { try { const s = (store.read() || {}).bestWeakTop; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting('best_weak_top_state'); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

// ---------------------------------------------------------------------------
// Configurations + ANTI-DOUBLONS DE CONFIGURATION
// ---------------------------------------------------------------------------
const configKey = (c) => `${modeOf(c)}|${c.strategy}|${modeOf(c) === 'multi' ? (c.ranks || []).join('') : (modeOf(c) === 'follow' ? [...(c.sources || [])].map(String).sort().join(',') : '')}`;
const shareChannel = (a, b) => { const mine = new Set((a.channels || []).map(String)); return (b.channels || []).some((ch) => mine.has(String(ch))); };
function findDuplicate(cfg, excludeId) {
  return panel.configs.find((o) => o.id !== excludeId && configKey(o) === configKey(cfg) && shareChannel(o, cfg)) || null;
}
const duplicateError = (d) => new Error(`Doublon : une configuration identique envoie déjà dans ce canal${d.name ? ` (« ${d.name} »)` : ''}. Modifie-la ou supprime-la d'abord.`);
// fusionne les doublons déjà enregistrés : on garde la plus ancienne, on additionne ses compteurs
function dedupeConfigs() {
  const kept = []; let removed = 0;
  for (const c of panel.configs) {
    const dup = kept.find((o) => configKey(o) === configKey(c) && shareChannel(o, c));
    if (dup) {
      dup.sentCount = (dup.sentCount || 0) + (c.sentCount || 0); dup.wins = (dup.wins || 0) + (c.wins || 0); dup.losses = (dup.losses || 0) + (c.losses || 0);
      for (const e of panel.pending) if (e.configId === c.id) e.configId = dup.id;
      removed += 1;
    } else kept.push(c);
  }
  if (removed) { panel.configs = kept; panel.duplicatesRemoved += removed; }
  return removed;
}
function addConfig(input = {}) {
  const mode = sanitizeMode(input.mode);
  const strategy = mode === 'follow' ? 'follow' : sanitizeStrategy(input.strategy);
  if (!strategy) throw new Error('Choisis la stratégie (Dizaine ou Costume faible).');
  const sources = mode === 'follow' ? parseChannels(input.sources).map(String) : [];
  if (mode === 'follow' && !sources.length) throw new Error('Coche au moins un canal à suivre.');
  const channels = parseChannels(input.channels);
  if (!channels.length) throw new Error('Renseigne au moins un ID de canal.');
  const cfg = {
    id: `bw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, mode, name: sanitizeName(input.name) || ({ trigger: 'Déclencheur', cycle: 'Cycle', follow: 'Suivi' }[mode] || ''),
    strategy, channels, sources, rot: {}, maxR: sanitizeMaxR(input.maxR), format: sanitizeFormat(input.format),
    ranks: mode !== 'multi' ? [] : (input.ranks === undefined ? DEFAULT_RANKS.slice() : sanitizeRanks(input.ranks)),
    cycleRole: 1, cycleWaiting: false, cycleDone: [],
    enabled: true, sentCount: 0, wins: 0, losses: 0, lastSentAt: null,
  };
  const dup = findDuplicate(cfg);
  if (dup) throw duplicateError(dup);
  panel.configs.push(cfg); persist(); return cfg;
}
function updateConfig(id, patch = {}) {
  const c = panel.configs.find((x) => x.id === id);
  if (!c) return null;
  const old = JSON.parse(JSON.stringify(c));
  try {
    if (patch.sources !== undefined && modeOf(c) === 'follow') { const src = parseChannels(patch.sources).map(String); if (!src.length) throw new Error('Coche au moins un canal à suivre.'); c.sources = src; }
    if (patch.strategy !== undefined && modeOf(c) !== 'follow') { const s = sanitizeStrategy(patch.strategy); if (!s) throw new Error('Stratégie invalide.'); c.strategy = s; }
    if (patch.channels !== undefined) { const ch = parseChannels(patch.channels); if (!ch.length) throw new Error('Renseigne au moins un ID de canal.'); c.channels = ch; }
    if (patch.maxR !== undefined) c.maxR = sanitizeMaxR(patch.maxR);
    if (patch.name !== undefined) c.name = sanitizeName(patch.name) || c.name;
    if (patch.format !== undefined) c.format = sanitizeFormat(patch.format);
    if (patch.ranks !== undefined && modeOf(c) === 'multi') c.ranks = sanitizeRanks(patch.ranks);
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
    const dup = findDuplicate(c, c.id);
    if (dup) throw duplicateError(dup);
  } catch (e) { Object.assign(c, old); throw e; }
  persist(); return c;
}
function removeConfig(id) { panel.configs = panel.configs.filter((c) => c.id !== id); persist(); return true; }
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }
const enabledOf = (strategy, mode) => panel.configs.filter((c) => c.enabled && c.strategy === strategy && modeOf(c) === mode);
// canaux qui reçoivent aujourd'hui des messages à plusieurs costumes (utile pour guider le choix du suivi)
const hasMultiChannels = () => [...new Set(panel.configs.filter((c) => c.enabled && modeOf(c) === 'multi').flatMap((c) => c.channels.map(String)))];
const hasEnabled = (strategy) => panel.configs.some((c) => c.enabled && c.strategy === strategy);

// ---------------------------------------------------------------------------
// ANTI-DOUBLONS DE PRÉDICTION : une configuration, un jeu → une seule prédiction
// ---------------------------------------------------------------------------
const sentKey = (cfgId, target) => `${cfgId}:${Number(target)}`;
function alreadySent(cfgId, target) {
  const k = sentKey(cfgId, target);
  return inflight.has(k) || panel.recentSent.includes(k) || panel.pending.some((e) => e.configId === cfgId && Number(e.target) === Number(target));
}
function rememberSent(cfgId, target) {
  panel.recentSent.push(sentKey(cfgId, target));
  if (panel.recentSent.length > 500) panel.recentSent = panel.recentSent.slice(-500);
}
const blocked = () => { panel.duplicatesBlocked += 1; };

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
// message simple du mode « déclencheur » (même moteur de formats que les autres stratégies)
function triggerMessage(entryLike, statusFr) {
  return fmt.renderMessage(entryLike.format, {
    gameNumber: entryLike.target, suit: entryLike.suits[0].suit, strategy: entryLike.strategyName || 'Déclencheur',
    maxR: entryLike.maxR, status: statusFr, rattrapage: entryLike.step || 0,
  }, null);
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
function editAll(entry, text, parseMode) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  for (const m of entry.messages || []) bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId, ...(parseMode ? { parse_mode: parseMode } : {}) }).catch(() => {});
}
function editTrigger(entry, statusFr) { const o = triggerMessage(entry, statusFr); editAll(entry, o.text, o.parse_mode); }

// ---------------------------------------------------------------------------
// Mode « déclencheur » : envoi d'une prédiction simple
// ---------------------------------------------------------------------------
async function sendTrigger(cfg, { target, suit, reason, role }) {
  if (!Number.isFinite(Number(target)) || !suit) return false;
  if (alreadySent(cfg.id, target)) { blocked(); return false; } // doublon de prédiction
  const k = sentKey(cfg.id, target);
  inflight.add(k);
  try {
    const entry = {
      id: `bwt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, configId: cfg.id, mode: modeOf(cfg), reason, role: role || null, strategy: cfg.strategy,
      target: Number(target), suits: [{ suit }], format: cfg.format, strategyName: cfg.name || 'Déclencheur',
      maxR: cfg.maxR, step: 0, gap: 0, skipped: 0, status: 'en attente', messages: [], createdAt: Date.now(), resolvedAt: null,
    };
    const out = triggerMessage(entry, 'en attente');
    entry.messages = await sendToChannels(cfg, out.text, out.parse_mode);
    if (!entry.messages.length) return false;
    panel.pending.push(entry); rememberSent(cfg.id, target);
    cfg.sentCount = (cfg.sentCount || 0) + 1; cfg.lastSentAt = Date.now();
    panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null;
    persist();
    return true;
  } catch (e) { panel.lastError = e.message; return false; } finally { inflight.delete(k); }
}
function ensureTrigDay() {
  const d = dayKey();
  if (panel.trig.day !== d) panel.trig = { day: d, results: {}, armed: {}, absenceFired: panel.trig.absenceFired || {} };
  return panel.trig;
}
// résultat d'une configuration (appelé par les stratégies à chaque prédiction vérifiée, hors relais)
function recordResult(strategy, ref, field, step) {
  try {
    if (ref == null) return;
    // mode cycle : une fois les 4 passées, on attend qu'une des 4 configurations PERDE ; celle qui perd est suivie
    if (field === 'losses') {
      const waiting = enabledOf(strategy, 'cycle').filter((cfg) => cfg.cycleWaiting);
      const rank = waiting.length && rankProviders[strategy] ? rankProviders[strategy](ref) : null;
      if (rank) {
        for (const cfg of waiting) { cfg.cycleWaiting = false; cfg.cycleRole = rank; cfg.cycleDone = []; }
        persist();
      }
    }
    if (!enabledOf(strategy, 'trigger').length) return;
    const ts = ensureTrigDay();
    const key = `${strategy}:${ref}`;
    const list = (ts.results[key] = ts.results[key] || []);
    list.push({ ok: field === 'wins', step: Number(step) || 0 });
    if (list.length > 6) list.shift();
    const last = list.slice(-2);
    let reason = null;
    if (last.length === 2 && last.every((r) => !r.ok)) reason = 'pertes';
    else if (last.length === 2 && last.every((r) => r.ok && TRIGGER.bigSteps.includes(r.step))) reason = 'rattrapages';
    if (reason) ts.armed[key] = { reason, at: Date.now() }; else delete ts.armed[key];
    persist();
  } catch (e) { panel.lastError = e.message; }
}
const cyclePending = (cfg) => panel.pending.some((e) => e.configId === cfg.id && e.status === 'en attente');
// mode cycle : prédiction de la configuration suivie (une seule à la fois ; rien tant qu'on attend une perte)
async function handleCyclePrediction(strategy, rank, data) {
  for (const cfg of enabledOf(strategy, 'cycle')) {
    if (cfg.cycleWaiting || rank !== cfg.cycleRole || cyclePending(cfg)) continue;
    await sendTrigger(cfg, { target: data.target, suit: data.suit, reason: 'cycle', role: rank });
  }
}
// résultat de NOTRE prédiction : ✅0️⃣/✅1️⃣ → on reste ; ✅2️⃣/✅3️⃣… ou ❌ → on passe à la suivante ; les 4 passées → attente d'une perte
function advanceCycle(cfg, entry) {
  const stay = entry.status === 'gagné' && CYCLE_STAY_STEPS.includes(Number(entry.step));
  if (stay) return;
  cfg.cycleDone = [...new Set([...(cfg.cycleDone || []), cfg.cycleRole])];
  const start = CYCLE_ORDER.indexOf(cfg.cycleRole);
  for (let i = 1; i <= CYCLE_ORDER.length; i++) {
    const r = CYCLE_ORDER[(start + i) % CYCLE_ORDER.length];
    if (!cfg.cycleDone.includes(r)) { cfg.cycleRole = r; return; }
  }
  cfg.cycleWaiting = true; cfg.cycleDone = []; // les 4 sont passées : on attend qu'une des 4 perde
}
// prochaine prédiction d'une configuration « armée » → envoyée dans les canaux déclencheur
async function handleTriggerPrediction(strategy, data) {
  const ts = ensureTrigDay();
  const key = `${strategy}:${data.ref}`;
  const armed = ts.armed[key];
  if (!armed) return;
  delete ts.armed[key];
  persist();
  for (const cfg of enabledOf(strategy, 'trigger')) await sendTrigger(cfg, { target: data.target, suit: data.suit, reason: armed.reason });
}
// costume absent depuis 13 jeux (main du joueur) → ce costume est prédit à N+1 et à N+5
async function checkAbsence() {
  const cfgs = panel.configs.filter((c) => c.enabled && modeOf(c) === 'trigger');
  if (!cfgs.length) return;
  const maxDone = maxFinishedGameNumber();
  if (!maxDone) return;
  const ts = ensureTrigDay();
  for (const suit of SUITS) {
    let absent = 0; let lastSeen = 0; let contiguous = true;
    for (let n = maxDone; n > 0 && n > maxDone - 60; n--) {
      const g = state.games.get(n);
      if (!g || !g.finished || g.complete === false) { // jeu manquant : si l'absence est déjà assez longue, il sert de repère de série
        if (absent >= TRIGGER.absenceGames) lastSeen = n; else contiguous = false;
        break;
      }
      if (hasSuit(g, suit)) { lastSeen = n; break; }
      absent += 1;
    }
    if (!contiguous || absent < TRIGGER.absenceGames) continue;
    if (ts.absenceFired[suit] === lastSeen) continue; // une seule série de prédictions par absence
    ts.absenceFired[suit] = lastSeen;
    for (const cfg of cfgs) for (const off of TRIGGER.offsets) await sendTrigger(cfg, { target: maxDone + off, suit, reason: 'absence' });
    persist();
  }
}

// ---------------------------------------------------------------------------
// Mode « suivi » : prédictions tirées des messages à plusieurs costumes publiés par le bot dans les canaux cochés
// ---------------------------------------------------------------------------
async function onMultiSent(chatId, entry) {
  const src = String(chatId);
  for (const cfg of panel.configs.filter((c) => c.enabled && modeOf(c) === 'follow' && (c.sources || []).map(String).includes(src))) {
    const items = entry.suits || [];
    if (!items.length) continue;
    // 1) rotation : costume n°1 puis n°2 puis n°3 (s'il y en a 3), puis retour au n°1
    cfg.rot = cfg.rot || {};
    const idx = (cfg.rot[src] || 0) % items.length;
    const sent = await sendTrigger(cfg, { target: entry.target, suit: items[idx].suit, reason: 'rotation', role: idx + 1 });
    if (sent) cfg.rot[src] = (cfg.rot[src] || 0) + 1;
    // 2) motif : 1ᵉʳ costume gagnant au jeu N puis 2ᵉ costume gagnant au rattrapage (N+1) → on prédit le 2ᵉ au jeu N+2
    if (items.length >= 2 && !panel.watch.some((w) => w.cfgId === cfg.id && w.target === Number(entry.target))) {
      panel.watch.push({ cfgId: cfg.id, target: Number(entry.target), s1: items[0].suit, s2: items[1].suit, at: Date.now() });
      if (panel.watch.length > 100) panel.watch = panel.watch.slice(-100);
    }
    persist();
  }
}
async function checkPatterns() {
  if (!panel.watch.length) return;
  const maxDone = maxFinishedGameNumber();
  const keep = [];
  for (const w of panel.watch) {
    const done = (g) => !!g && g.finished && g.complete !== false;
    const g0 = state.games.get(w.target); const g1 = state.games.get(w.target + 1);
    if (done(g0) && done(g1)) {
      const cfg = panel.configs.find((c) => c.id === w.cfgId && c.enabled);
      if (cfg && hasSuit(g0, w.s1) && !hasSuit(g0, w.s2) && hasSuit(g1, w.s2)) {
        await sendTrigger(cfg, { target: w.target + 2, suit: w.s2, reason: 'motif' });
      }
      continue; // motif évalué : on ne le garde plus
    }
    if (maxDone > w.target + 4 || Date.now() - w.at > 6 * 3600 * 1000) continue; // jeux manquants : abandon
    keep.push(w);
  }
  if (keep.length !== panel.watch.length) { panel.watch = keep; persist(); }
}

// ---------------------------------------------------------------------------
// Mode « multi » : réception des prédictions des rangs 1 (meilleur), 2, 3 et 4 (plus faible)
// ---------------------------------------------------------------------------
async function record(strategy, rank, data) {
  try {
    rank = Number(rank);
    if (!hasEnabled(strategy) || !data || !Number.isFinite(Number(data.target)) || !data.suit || !(rank >= 1 && rank <= 4)) return;
    await handleTriggerPrediction(strategy, data).catch((e) => { panel.lastError = e.message; });
    await handleCyclePrediction(strategy, rank, data).catch((e) => { panel.lastError = e.message; });
    if (!enabledOf(strategy, 'multi').length) return;
    const now = Date.now();
    for (const [k, v] of collector) if (now - v.at > 60 * 60 * 1000) collector.delete(k);
    const key = `${strategy}:${Number(data.target)}`;
    const slot = collector.get(key) || { at: now, ranks: {}, sent: new Set() };
    slot.ranks[rank] = { suit: data.suit, ref: data.ref, pct: Number.isFinite(Number(data.pct)) ? Number(data.pct) : null };
    collector.set(key, slot);
    for (const cfg of enabledOf(strategy, 'multi').filter((c) => !slot.sent.has(c.id))) {
      const want = cfg.ranks && cfg.ranks.length ? cfg.ranks : DEFAULT_RANKS;
      if (!want.every((r) => slot.ranks[r])) continue; // tous les costumes cochés doivent avoir prédit ce même jeu
      slot.sent.add(cfg.id);
      if (alreadySent(cfg.id, data.target)) { blocked(); continue; } // doublon de prédiction
      const lock = sentKey(cfg.id, data.target);
      inflight.add(lock);
      try {
        // pourcentages recalculés AU MOMENT de l'envoi (taux instantané), pas à celui de leur prédiction
        const items = want.map((r) => {
          const it = { ...slot.ranks[r], rank: r };
          try { const p = pctProviders[strategy] ? pctProviders[strategy](it.ref) : null; if (Number.isFinite(p)) it.pct = p; } catch (_) { /* dernier connu */ }
          return it;
        });
        const entry = {
          id: `bwp-${now}-${Math.random().toString(36).slice(2, 6)}`, configId: cfg.id, mode: 'multi', strategy, target: Number(data.target),
          suits: items, maxR: cfg.maxR, step: 0, gap: 0, skipped: 0, status: 'en attente', messages: [], createdAt: now, resolvedAt: null,
        };
        entry.messages = await sendToChannels(cfg, predictionText(entry.target, items), 'HTML');
        if (!entry.messages.length) continue;
        panel.pending.push(entry); rememberSent(cfg.id, data.target);
        cfg.sentCount = (cfg.sentCount || 0) + 1; cfg.lastSentAt = now;
        panel.sentCount += 1; panel.lastSentAt = now; panel.lastError = null;
        for (const mm of entry.messages) await onMultiSent(mm.chatId, entry).catch((e) => { panel.lastError = e.message; }); // mode « suivi »
      } finally { inflight.delete(lock); }
    }
    persist();
  } catch (e) { panel.lastError = e.message; }
}

// ---------------------------------------------------------------------------
// Vérification : main du JOUEUR, rattrapages N, N+1, N+2…
// ---------------------------------------------------------------------------
function maxFinishedGameNumber() { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; }
function verifyPending() {
  const maxDone = maxFinishedGameNumber();
  let changed = false;
  for (const entry of panel.pending) {
    if (entry.status !== 'en attente') continue;
    const isTrigger = entry.mode === 'trigger' || entry.mode === 'cycle' || entry.mode === 'follow'; // message simple au format choisi
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
        if (isTrigger) editTrigger(entry, 'gagné');
        if (entry.mode === 'cycle' && cfg) advanceCycle(cfg, entry);
        else editAll(entry, resultText(entry, [...new Set(hit)], true)); // on garde le(s) costume(s) sorti(s), on retire l'autre
        break;
      }
      if (entry.step >= entry.maxR) {
        entry.status = 'perdu'; entry.resolvedAt = Date.now(); changed = true;
        if (cfg) cfg.losses = (cfg.losses || 0) + 1;
        if (isTrigger) editTrigger(entry, 'perdu');
        if (entry.mode === 'cycle' && cfg) advanceCycle(cfg, entry);
        else editAll(entry, resultText(entry, [], false));
        break;
      }
      entry.step += 1; changed = true;
      if (isTrigger) editTrigger(entry, 'en attente'); // le message affiche le rattrapage en cours
    }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pending = panel.pending.filter((e) => e.status === 'en attente' || !e.resolvedAt || e.resolvedAt >= cutoff);
  if (changed) persist();
}
async function tick() {
  verifyPending();
  try { await checkAbsence(); } catch (e) { panel.lastError = e.message; }
  try { await checkPatterns(); } catch (e) { panel.lastError = e.message; }
}
setOnShoeReset(() => {
  collector.clear();
  panel.trig.armed = {}; panel.trig.absenceFired = {}; // nouveau sabot : la numérotation repart de zéro
  for (const e of panel.pending) if (e.status === 'en attente') { e.status = 'annulé'; e.resolvedAt = Date.now(); }
  persist();
});

async function test(id) {
  const cfg = panel.configs.find((c) => c.id === id);
  if (!cfg) return { ok: false, error: 'Configuration introuvable' };
  let msgs;
  if (simpleMode(cfg)) {
    const o = triggerMessage({ format: cfg.format, target: 464, suits: [{ suit: '♦️' }], strategyName: cfg.name || 'Déclencheur', maxR: cfg.maxR, step: 0 }, 'en attente');
    msgs = await sendToChannels(cfg, `🧪 Test\n${o.text}`, o.parse_mode);
  } else {
    msgs = await sendToChannels(cfg, `🧪 Test\n${predictionText(464, (cfg.ranks || DEFAULT_RANKS).map((r, i) => ({ suit: SUITS[i], pct: [85, 80, 78, 70][i] })))}`, 'HTML');
  }
  return msgs.length ? { ok: true, sent: msgs.length } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

function status() {
  return {
    strategies: STRATEGIES, rankLabels: RANK_LABELS, triggerLabel: TRIGGER_LABEL, cycleLabel: `Cycle : ${CYCLE_ORDER.map((r) => RANK_LABELS[r]).join(' → ')}`, formatCount: fmt.FORMAT_COUNT,
    configs: panel.configs.map((c) => ({
      ...c, mode: modeOf(c), strategyLabel: modeOf(c) === 'follow' ? 'Suivi des canaux cochés' : STRATEGIES[c.strategy], sourceNames: (c.sources || []).map((id) => panel.channelTitles[String(id)] || String(id)),
      ranksLabel: modeOf(c) === 'follow' ? `Suit : ${(c.sources || []).map((id) => panel.channelTitles[String(id)] || String(id)).join(', ')}` : modeOf(c) === 'trigger' ? TRIGGER_LABEL : (modeOf(c) === 'cycle' ? `Cycle : ${CYCLE_ORDER.map((r) => RANK_LABELS[r]).join(' → ')}` : (c.ranks || DEFAULT_RANKS).map((r) => RANK_LABELS[r]).join(' + ')),
      cycleLabel: modeOf(c) === 'cycle' ? (c.cycleWaiting ? 'Les 4 sont passées : en attente d’une perte parmi les 4' : `Suit actuellement : ${RANK_LABELS[c.cycleRole] || RANK_LABELS[1]}${(c.cycleDone || []).length ? ` (déjà passés : ${c.cycleDone.map((r) => RANK_LABELS[r]).join(', ')})` : ''}`) : null,
      channelNames: c.channels.map((id) => panel.channelTitles[String(id)] || String(id)),
    })),
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastError: panel.lastError, channelTitles: panel.channelTitles,
    duplicatesRemoved: panel.duplicatesRemoved, duplicatesBlocked: panel.duplicatesBlocked,
    waiting: panel.pending.filter((e) => e.status === 'en attente').length,
  };
}

function config() { return { count: panel.configs.length }; }
function configure() { persist(); } // import d'une sauvegarde : réécrit l'état en base

module.exports = {
  config, configure, setSender, setPctProvider, setRankProvider, restore, restoreFromDb, persist, addConfig, updateConfig, removeConfig, setChannelTitle,
  hasEnabled, hasMultiChannels, record, recordResult, tick, test, status, parseChannels, STRATEGIES, findDuplicate, dedupeConfigs,
};
