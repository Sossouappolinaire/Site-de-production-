// cards-count.js — nouveau bouton « Comptage 2/2 » (demande admin).
//
// Principe (indépendant de toutes les autres stratégies) :
//
//  • On compte, par LOT DE 30 JEUX, la distribution des cartes de chaque jeu
//    terminé, en 4 catégories :
//        3/2 : 3 cartes joueur + 2 cartes banquier
//        3/3 : 3 cartes joueur + 3 cartes banquier

//        2/2 : 2 cartes joueur + 2 cartes banquier
//  • Les lots sont TOUJOURS alignés sur 1 : 1→30, 31→60, 61→90, 91→120…
//    On ne commence donc JAMAIS un comptage à 43, 45, 50 ou 52 : au
//    démarrage du bot, on calcule le prochain début de lot valide à partir
//    du jeu en cours (voir pickStart()).
//  • À la fin d'un lot, on regarde TOUJOURS LES TROIS comptages (3/2, 3/3,
//    2/2). La catégorie la plus faible n'est prédite que si sa case est
//    cochée. Exemple : si seul 2/2 est coché et que 3/2 est le plus faible,
//    aucune prédiction n'est programmée. En cas d'égalité pour la plus basse,
//    aucun signal n'est programmé.
//  • Le nombre de prédictions est configurable. Avec 1 : jeu 35 ; avec 2 :
//    jeux 35 et 45 ; avec 3 : jeux 35, 45 et 55 pour le lot 1→30.
//        lot 1→30   : jeux 35, 45, 55
//        lot 31→60  : jeux 65, 75, 85
//        lot 61→90  : jeux 95, 105, 115   (règle générale : début+34/+44/+54)
//  • Une prédiction programmée n'est PAS envoyée tout de suite : on attend
//    que le jeu EN LIVE soit proche de la cible. Pour le jeu 35 on attend le
//    jeu 32 ou 33 ; pour le 45, le 42 ou 43 ; etc. Le déclencheur (−3, −2,
//    ou l'un ou l'autre) est réglable dans le panneau.
//  • Le comptage NE S'ARRÊTE PAS pendant que des prédictions sont en
//    attente : le lot suivant démarre immédiatement (31→60, puis 61→90…).
//  • Après l'envoi, la prédiction est vérifiée sur le jeu cible, puis sur les
//    jeux suivants selon le rattrapage configuré, et le message Telegram est
//    édité avec le résultat.
'use strict';

const store = require('./store');
const db = require('./db');
const { state, addSiteChannelMessage, siteChannelsView, setOnShoeReset } = require('./predictor');

const CATEGORIES = ['3/2', '3/3', '2/2'];
const DEFAULT_BLOCK = 30;
// La première cible tombe 4 jeux après la fin du lot, puis les répétitions
// suivantes sont espacées de 10 jeux : +34, +44, +54 pour un lot de 30.
function offsetsFor(size, count = panel.predictionCount) {
  const total = sanitizePredictionCount(count);
  return Array.from({ length: total }, (_, i) => size + 4 + (i * 10));
}
function blockSize() { return panel.blockSize || DEFAULT_BLOCK; }

const panel = {
  enabled: true,
  channels: [],
  siteChannelId: null,
  maxR: 1,
  predictionCount: 1,
  blockSize: DEFAULT_BLOCK,
  categoriesOn: { '3/2': true, '3/3': true, '2/2': true },
  categoryChannels: { '3/2': [], '3/3': [], '2/2': [] },
  categorySiteChannels: { '3/2': null, '3/3': null, '2/2': null },
  trigger: 'both',        // 'both' | 'minus3' | 'minus2'
  block: null,            // { start, end, counts, counted: [numéros comptés] }
  pending: [],            // prédictions programmées / envoyées
  history: [],            // lots terminés (comptages + décision)
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
};

let sender = null;
function setSender(fn) { sender = fn; }
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

function sanitizeBlockSize(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_BLOCK;
  return Math.max(5, Math.min(200, n));
}

function sanitizePredictionCount(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(10, n));
}

function sanitizeCategoriesOn(value) {
  const out = { '3/2': false, '3/3': false, '2/2': false };
  if (Array.isArray(value)) {
    for (const c of value) if (CATEGORIES.includes(String(c))) out[String(c)] = true;
  } else if (value && typeof value === 'object') {
    for (const c of CATEGORIES) out[c] = !!value[c];
  }
  // Au moins une catégorie doit rester cochée.
  if (!CATEGORIES.some((c) => out[c])) for (const c of CATEGORIES) out[c] = true;
  return out;
}

function sanitizeCategoryChannels(value) {
  const out = { '3/2': [], '3/3': [], '2/2': [] };
  if (value && typeof value === 'object') {
    for (const c of CATEGORIES) out[c] = parseChannels(value[c]);
  }
  return out;
}

function sanitizeCategorySites(value) {
  const out = { '3/2': null, '3/3': null, '2/2': null };
  if (value && typeof value === 'object') {
    for (const c of CATEGORIES) out[c] = sanitizeSiteChannelId(value[c]);
  }
  return out;
}

function sanitizeTrigger(value) {
  return value === 'minus3' || value === 'minus2' ? value : 'both';
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) panel.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.maxR !== undefined) panel.maxR = Math.max(0, Math.min(9, parseInt(patch.maxR, 10) || 0));
  if (patch.predictionCount !== undefined) panel.predictionCount = sanitizePredictionCount(patch.predictionCount);
  if (patch.trigger !== undefined) panel.trigger = sanitizeTrigger(patch.trigger);
  if (patch.categoriesOn !== undefined) panel.categoriesOn = sanitizeCategoriesOn(patch.categoriesOn);
  if (patch.categoryChannels !== undefined) panel.categoryChannels = sanitizeCategoryChannels(patch.categoryChannels);
  if (patch.categorySiteChannels !== undefined) panel.categorySiteChannels = sanitizeCategorySites(patch.categorySiteChannels);
  if (patch.blockSize !== undefined) {
    const size = sanitizeBlockSize(patch.blockSize);
    if (size !== panel.blockSize) {
      panel.blockSize = size;
      // Nouvelle taille de lot : on réaligne le comptage en cours.
      panel.block = null;
      ensureBlock();
    }
  }
  persist();
  return config();
}

function config() {
  return {
    enabled: panel.enabled,
    channels: panel.channels,
    siteChannelId: panel.siteChannelId,
    maxR: panel.maxR,
    predictionCount: panel.predictionCount,
    trigger: panel.trigger,
    blockSize: blockSize(),
    categoriesOn: { ...panel.categoriesOn },
    categoryChannels: {
      '3/2': [...panel.categoryChannels['3/2']],
      '3/3': [...panel.categoryChannels['3/3']],
      '2/2': [...panel.categoryChannels['2/2']],
    },
    categorySiteChannels: { ...panel.categorySiteChannels },
  };
}

// ---------------------------------------------------------------------------
// Persistance (même mécanisme que suit-streak.js : data.json + base)
// ---------------------------------------------------------------------------
function persist() {
  const saved = {
    config: config(), block: panel.block, pending: panel.pending, history: panel.history,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt,
  };
  try { store.patch({ cardsCount: saved }); } catch (_) {}
  if (db.ready) db.setSetting('cards_count_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}

function applySaved(saved) {
  if (!saved) return;
  if (saved.config) {
    panel.enabled = saved.config.enabled !== false;
    panel.channels = parseChannels(saved.config.channels);
    panel.siteChannelId = sanitizeSiteChannelId(saved.config.siteChannelId);
    panel.maxR = Math.max(0, Math.min(9, parseInt(saved.config.maxR, 10) || 0));
    panel.predictionCount = sanitizePredictionCount(saved.config.predictionCount);
    panel.trigger = sanitizeTrigger(saved.config.trigger);
    panel.blockSize = sanitizeBlockSize(saved.config.blockSize ?? DEFAULT_BLOCK);
    panel.categoriesOn = sanitizeCategoriesOn(saved.config.categoriesOn);
    panel.categoryChannels = sanitizeCategoryChannels(saved.config.categoryChannels);
    panel.categorySiteChannels = sanitizeCategorySites(saved.config.categorySiteChannels);
  }
  if (saved.block && Number.isFinite(Number(saved.block.start))) {
    panel.block = normalizeBlock(saved.block);
  }
  if (Array.isArray(saved.pending)) panel.pending = saved.pending.slice(-200);
  if (Array.isArray(saved.history)) panel.history = saved.history.slice(0, 60);
  if (Number.isFinite(Number(saved.sentCount))) panel.sentCount = Number(saved.sentCount);
  panel.lastSentAt = saved.lastSentAt || null;
  panel.lastScanAt = saved.lastScanAt || null;
}

function normalizeBlock(b) {
  const start = Number(b.start);
  const counts = {};
  for (const c of CATEGORIES) counts[c] = Number((b.counts || {})[c]) || 0;
  return {
    start,
    end: start + blockSize() - 1,
    counts,
    counted: Array.isArray(b.counted) ? b.counted.filter((n) => Number.isFinite(Number(n))).map(Number) : [],
  };
}

function restore() {
  try { applySaved((store.read() || {}).cardsCount); } catch (_) {}
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('cards_count_state');
    if (raw) applySaved(JSON.parse(raw));
    else persist();
  } catch (_) { persist(); }
  return config();
}

// ---------------------------------------------------------------------------
// Comptage
// ---------------------------------------------------------------------------
function categoryOf(game) {
  if (!game || !game.finished) return null;
  const p = cardCount(game.playerCards);
  const b = cardCount(game.bankerCards);
  if (!p || !b) return null;
  const label = `${p}/${b}`;
  return CATEGORIES.includes(label) ? label : null;
}

// Les jeux venant de l'API portent un NOMBRE de cartes (api.js), mais
// certaines sources internes stockent le TABLEAU des cartes : on gère les deux.
function cardCount(value) {
  if (Array.isArray(value)) return value.length;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function maxFinishedGameNumber() {
  let max = 0;
  for (const g of state.games.values()) if (g.finished && g.number > max) max = g.number;
  return max;
}

// Prochain début de lot valide : toujours ≡ 1 (mod 30) — 1, 31, 61, 91…
// Jamais 43/45/50/52 : ces numéros ne sont pas des débuts de lot.
function pickStart(currentNumber) {
  const size = blockSize();
  const n = Math.max(1, Number(currentNumber) || 1);
  if (n <= size) return 1;
  return 1 + size * Math.ceil((n - 1) / size);
}

function ensureBlock() {
  if (panel.block) return panel.block;
  const live = state.live ? state.live.number : maxFinishedGameNumber();
  const start = pickStart(live);
  panel.block = normalizeBlock({ start, counts: {}, counted: [] });
  return panel.block;
}

function countBlock() {
  const block = ensureBlock();
  for (let n = block.start; n <= block.end; n++) {
    if (block.counted.includes(n)) continue;
    const g = state.games.get(n);
    const cat = categoryOf(g);
    if (!cat) continue;
    block.counts[cat] = (block.counts[cat] || 0) + 1;
    block.counted.push(n);
  }
  return block;
}

// Le lot est terminé dès que le jeu de fin est passé (jeu terminé ≥ fin du lot).
function blockFinished(block) {
  return maxFinishedGameNumber() >= block.end;
}

// Catégorie la PLUS FAIBLE du lot : l'analyse porte toujours sur les trois
// catégories. Les cases cochées ne changent pas l'analyse ; elles autorisent
// seulement (ou refusent) la prédiction de la catégorie trouvée.
function lowestCategory(counts) {
  let best = null;
  for (const c of CATEGORIES) {
    const v = counts[c] || 0;
    if (best === null || v < (counts[best] || 0)) best = c;
  }
  if (best === null) return null;
  const low = counts[best] || 0;
  const tie = CATEGORIES.some((c) => c !== best && (counts[c] || 0) <= low);
  return tie ? null : best;
}

function closeBlock() {
  const block = panel.block;
  if (!block) return;
  const signal = lowestCategory(block.counts);
  const decided = !!signal && panel.categoriesOn[signal] === true;
  if (decided) {
    for (const off of offsetsFor(blockSize())) {
      const target = block.start + off;
      if (panel.pending.some((p) => p.target === target)) continue;
      panel.pending.push({
        id: `cc-${target}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        target,
        signal,
        blockStart: block.start,
        status: 'programmé',   // programmé -> en attente -> gagné/perdu/annulé
        step: 0,
        gap: 0,
        skipped: 0,
        maxR: panel.maxR,
        messages: [],
        createdAt: Date.now(),
        sentAt: null,
        resolvedAt: null,
      });
    }
  }
  panel.history.unshift({
    start: block.start, end: block.end, counts: { ...block.counts },
    predicted: decided, signal: signal || null, selected: signal ? panel.categoriesOn[signal] === true : false,
    targets: decided ? offsetsFor(blockSize()).map((o) => block.start + o) : [],
    closedAt: Date.now(),
  });
  panel.history = panel.history.slice(0, 60);
  // le comptage continue immédiatement sur le lot suivant, même si des
  // prédictions du lot précédent sont encore en attente.
  panel.block = normalizeBlock({ start: block.end + 1, counts: {}, counted: [] });
}

// ---------------------------------------------------------------------------
// Envoi des prédictions (fenêtre de déclenchement −3 / −2)
// ---------------------------------------------------------------------------
function liveNumber() {
  if (state.live && Number.isFinite(Number(state.live.number))) return Number(state.live.number);
  return maxFinishedGameNumber();
}

function triggerReady(target) {
  const live = liveNumber();
  if (live >= target) return false; // trop tard : la cible est déjà en cours/passée
  if (panel.trigger === 'minus3') return live === target - 3;
  if (panel.trigger === 'minus2') return live === target - 2;
  return live === target - 3 || live === target - 2;
}

// Chiffres en emoji pour la vérification : ✅0️⃣ = gagné sur le jeu cible,
// ✅1️⃣ = gagné au 1er rattrapage, ✅2️⃣ au 2e, etc. ❌ = perdu.
const DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
function digitEmoji(n) {
  const i = Math.max(0, parseInt(n, 10) || 0);
  return i < DIGITS.length ? DIGITS[i] : `(${i})`;
}

function messageText(entry, status) {
  const step = Math.max(0, parseInt(entry.step, 10) || 0);
  const result = status === 'gagné'
    ? `✅${digitEmoji(step)}`
    : status === 'perdu'
      ? `❌${digitEmoji(step)}`
      : '⏳';
  const lines = [
    `🎯 Jeu №${entry.target}`,
    `🔹 Signal : ${entry.signal || '2/2'}`,
    `🔎 Résultat : ${result}`,
  ];
  return lines.join('\n');
}

function channelsFor(signal) {
  const list = (panel.categoryChannels[signal] || []);
  return list.length ? list : panel.channels;
}

function siteChannelFor(signal) {
  const id = panel.categorySiteChannels[signal];
  return id === null || id === undefined || id === '' ? panel.siteChannelId : id;
}

async function sendEntry(entry) {
  const cat = entry.signal || '2/2';
  const targetChannels = channelsFor(cat);
  const targetSite = siteChannelFor(cat);
  if (!targetChannels.length && !targetSite) {
    panel.lastError = 'Aucun canal configuré pour le comptage 2/2';
    return false;
  }
  const text = messageText(entry, 'en attente');
  const errors = [];
  let ok = false;
  if (targetChannels.length) {
    const bot = typeof sender === 'function' ? sender() : null;
    if (!bot) errors.push('Aucun token Telegram configuré');
    else {
      for (const id of targetChannels) {
        try {
          const m = await bot.sendMessage(id, text);
          entry.messages.push({ chatId: id, messageId: m.message_id });
          ok = true;
        } catch (e) { errors.push(`${id} : ${e.message}`); }
      }
    }
  }
  if (targetSite) {
    const posted = addSiteChannelMessage(targetSite, { sender: `Comptage ${cat}`, text });
    if (posted) ok = true; else errors.push(`Canal du site introuvable (id ${targetSite})`);
  }
  if (!ok) {
    panel.lastError = errors[0] || 'Envoi impossible';
    return false;
  }
  entry.status = 'en attente';
  entry.sentAt = Date.now();
  entry.maxR = panel.maxR;
  panel.sentCount += 1;
  panel.lastSentAt = Date.now();
  panel.lastError = errors.length ? errors[0] : null;
  return true;
}

function editEntry(entry, status) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  const text = messageText(entry, status);
  for (const m of entry.messages) {
    bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId }).catch(() => {});
  }
}

async function releasePending() {
  for (const entry of panel.pending) {
    if (entry.status !== 'programmé') continue;
    const live = liveNumber();
    if (live >= entry.target) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); continue; }
    if (!triggerReady(entry.target)) continue;
    await sendEntry(entry);
  }
}

// ---------------------------------------------------------------------------
// Vérification (rattrapage configuré)
// ---------------------------------------------------------------------------
function verifyPending() {
  const maxDone = maxFinishedGameNumber();
  for (const entry of panel.pending) {
    if (entry.status !== 'en attente') continue;
    let guard = 0;
    while (entry.status === 'en attente' && guard++ <= entry.maxR + entry.gap + 8) {
      const num = entry.target + entry.step + entry.gap;
      const g = state.games.get(num);
      const usable = !!g && g.finished && g.complete !== false;
      if (!usable) {
        if (num + 2 <= maxDone) {
          entry.gap += 1;
          entry.skipped += 1;
          if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); break; }
          continue;
        }
        break;
      }
      if (categoryOf(g) === (entry.signal || '2/2')) {
        entry.status = 'gagné'; entry.resolvedAt = Date.now(); editEntry(entry, 'gagné'); break;
      }
      if (entry.step >= entry.maxR) {
        entry.status = 'perdu'; entry.resolvedAt = Date.now(); editEntry(entry, 'perdu'); break;
      }
      entry.step += 1;
    }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pending = panel.pending.filter((e) => e.status === 'programmé' || e.status === 'en attente' || !e.resolvedAt || e.resolvedAt >= cutoff);
}

// ---------------------------------------------------------------------------
// Nouveau sabot : on repart du lot 1→30 et on annule ce qui est en cours.
// ---------------------------------------------------------------------------
setOnShoeReset(() => {
  panel.block = normalizeBlock({ start: 1, counts: {}, counted: [] });
  for (const e of panel.pending) {
    if (e.status === 'programmé' || e.status === 'en attente') { e.status = 'annulé'; e.resolvedAt = Date.now(); }
  }
  persist();
});

async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    const block = countBlock();
    if (blockFinished(block)) closeBlock();
    await releasePending();
    verifyPending();
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
  const sent = [];
  const errors = [];
  const targets = [];
  for (const cat of CATEGORIES) {
    if (!panel.categoriesOn[cat]) continue;
    for (const id of channelsFor(cat)) if (!targets.some((t) => t.id === id)) targets.push({ id, cat });
  }
  if (!targets.length) return { ok: false, error: 'Aucun canal configuré' };
  for (const { id, cat } of targets) {
    const preview = messageText({ target: blockSize() + 5, step: 0, maxR: panel.maxR, signal: cat }, 'en attente');
    try {
      await bot.sendMessage(id, `🧮 COMPTAGE ${cat} — message de test\n\n${preview}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

function statusView() {
  const block = panel.block ? { ...panel.block, counts: { ...panel.block.counts }, countedCount: panel.block.counted.length } : null;
  if (block) delete block.counted;
  const resolved = panel.pending.filter((e) => e.status === 'gagné' || e.status === 'perdu');
  return {
    ...config(),
    categories: CATEGORIES,
    offsets: offsetsFor(blockSize()),
    siteChannels: siteChannelsView().map((c) => ({ id: c.id, name: c.name })),
    live: liveNumber(),
    block,
    pending: panel.pending.slice(-30).map((e) => ({
      id: e.id, target: e.target, signal: e.signal || '2/2', blockStart: e.blockStart, status: e.status,
      step: e.step, maxR: e.maxR, sentAt: e.sentAt, resolvedAt: e.resolvedAt,
    })),
    history: panel.history.slice(0, 20),
    won: resolved.filter((e) => e.status === 'gagné').length,
    lost: resolved.filter((e) => e.status === 'perdu').length,
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
  };
}

// Remet le comptage à zéro sur le prochain lot valide à partir du jeu en cours.
function resetCounting() {
  panel.block = null;
  ensureBlock();
  persist();
  return statusView();
}

module.exports = {
  panel, setSender, tick, test, status: statusView, config, configure,
  restore, restoreFromDb, parseChannels, resetCounting, categoryOf, pickStart, lowestCategory,
  CATEGORIES, DEFAULT_BLOCK, offsetsFor, blockSize,
};
