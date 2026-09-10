// cards-count.js — nouveau bouton « Comptage 2/2 » (demande admin).
//
// Principe (indépendant de toutes les autres stratégies) :
//
//  • On compte, par LOT DE 30 JEUX, la distribution des cartes de chaque jeu
//    terminé, en 4 catégories :
//        3/2 : 3 cartes joueur + 2 cartes banquier
//        3/3 : 3 cartes joueur + 3 cartes banquier
//        2/3 : 2 cartes joueur + 3 cartes banquier
//        2/2 : 2 cartes joueur + 2 cartes banquier
//  • Les lots sont TOUJOURS alignés sur 1 : 1→30, 31→60, 61→90, 91→120…
//    On ne commence donc JAMAIS un comptage à 43, 45, 50 ou 52 : au
//    démarrage du bot, on calcule le prochain début de lot valide à partir
//    du jeu en cours (voir pickStart()).
//  • À la fin d'un lot, si le nombre de 2/2 est STRICTEMENT INFÉRIEUR aux
//    trois autres catégories, on programme 3 prédictions « 2/2 » :
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

const CATEGORIES = ['3/2', '3/3', '2/3', '2/2'];
const BLOCK = 30;
const OFFSETS = [34, 44, 54]; // début du lot + offset = jeux prédits

const panel = {
  enabled: true,
  channels: [],
  siteChannelId: null,
  maxR: 1,
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

function sanitizeTrigger(value) {
  return value === 'minus3' || value === 'minus2' ? value : 'both';
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) panel.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.maxR !== undefined) panel.maxR = Math.max(0, Math.min(9, parseInt(patch.maxR, 10) || 0));
  if (patch.trigger !== undefined) panel.trigger = sanitizeTrigger(patch.trigger);
  persist();
  return config();
}

function config() {
  return {
    enabled: panel.enabled,
    channels: panel.channels,
    siteChannelId: panel.siteChannelId,
    maxR: panel.maxR,
    trigger: panel.trigger,
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
    panel.trigger = sanitizeTrigger(saved.config.trigger);
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
    end: start + BLOCK - 1,
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
  const n = Math.max(1, Number(currentNumber) || 1);
  if (n <= BLOCK) return 1;
  return 1 + BLOCK * Math.ceil((n - 1) / BLOCK);
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

function twoTwoIsLowest(counts) {
  const two = counts['2/2'] || 0;
  return CATEGORIES.filter((c) => c !== '2/2').every((c) => two < (counts[c] || 0));
}

function closeBlock() {
  const block = panel.block;
  if (!block) return;
  const decided = twoTwoIsLowest(block.counts);
  if (decided) {
    for (const off of OFFSETS) {
      const target = block.start + off;
      if (panel.pending.some((p) => p.target === target)) continue;
      panel.pending.push({
        id: `cc-${target}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        target,
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
    predicted: decided, targets: decided ? OFFSETS.map((o) => block.start + o) : [],
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

function messageText(entry, status) {
  const result = status === 'gagné' ? '✅' : status === 'perdu' ? '❌' : '⏳';
  const lines = [
    `🎯 Jeu №${entry.target}`,
    '🔹 Signal : 2/2',
    `✅ Résultat : ${result}`,
  ];
  if (entry.step > 0 && status !== 'perdu') lines.splice(2, 0, `🔁 Rattrapage ${entry.step}/${entry.maxR}`);
  return lines.join('\n');
}

async function sendEntry(entry) {
  if (!panel.channels.length && !panel.siteChannelId) {
    panel.lastError = 'Aucun canal configuré pour le comptage 2/2';
    return false;
  }
  const text = messageText(entry, 'en attente');
  const errors = [];
  let ok = false;
  if (panel.channels.length) {
    const bot = typeof sender === 'function' ? sender() : null;
    if (!bot) errors.push('Aucun token Telegram configuré');
    else {
      for (const id of panel.channels) {
        try {
          const m = await bot.sendMessage(id, text);
          entry.messages.push({ chatId: id, messageId: m.message_id });
          ok = true;
        } catch (e) { errors.push(`${id} : ${e.message}`); }
      }
    }
  }
  if (panel.siteChannelId) {
    const posted = addSiteChannelMessage(panel.siteChannelId, { sender: 'Comptage 2/2', text });
    if (posted) ok = true; else errors.push(`Canal du site introuvable (id ${panel.siteChannelId})`);
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
      if (categoryOf(g) === '2/2') {
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
  if (!panel.channels.length) return { ok: false, error: 'Aucun canal configuré' };
  const preview = messageText({ target: 35, step: 0, maxR: panel.maxR }, 'en attente');
  const sent = [];
  const errors = [];
  for (const id of panel.channels) {
    try {
      await bot.sendMessage(id, `🧮 COMPTAGE 2/2 — message de test\n\n${preview}`);
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
    siteChannels: siteChannelsView().map((c) => ({ id: c.id, name: c.name })),
    live: liveNumber(),
    block,
    pending: panel.pending.slice(-30).map((e) => ({
      id: e.id, target: e.target, blockStart: e.blockStart, status: e.status,
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
  restore, restoreFromDb, parseChannels, resetCounting, categoryOf, pickStart,
  CATEGORIES, BLOCK, OFFSETS,
};
