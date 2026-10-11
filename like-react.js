// like-react.js — bouton « J'aime » (demande admin).
//
// L'administrateur coche des canaux qui envoient des prédictions. Pour chaque
// canal coché, le bot SUIT les prédictions du canal avec les 4 règles du
// bouton « Type de mise » et, quand une prédiction du canal déclenche une
// règle, il met l'emoji du type SUR CE MESSAGE de prédiction :
//
//   Type 1 → 👍  deux prédictions consécutives de même costume : on attend que
//                ce costume soit prédit à nouveau ; cette prédiction reçoit 👍
//   Type 2 → 🔥  deux prédictions consécutives de même costume : la prédiction
//                SUIVANTE (quel que soit son costume) reçoit 🔥
//   Type 3 → ❤   après 2 pertes consécutives : la prédiction suivante reçoit ❤
//   Type 4 → 🍾  après 1 perte : la prédiction suivante reçoit 🍾
//
// Ce sont des emojis de la liste standard de Telegram (🔰 🌹 🍺 n'en font pas
// partie). Un bot ne peut mettre qu'UNE réaction par message : si plusieurs
// types se déclenchent sur la même prédiction, le plus petit numéro gagne.
// Le canal doit autoriser les réactions et le bot doit y être administrateur.
//
// Au démarrage du bot et après un import, la liste des canaux qui envoient des
// prédictions est revérifiée (scan()). L'historique déjà publié au moment où
// le canal est coché est ignoré : seules les nouvelles prédictions comptent.
'use strict';

const store = require('./store');
const db = require('./db');

function lazy(name) { try { return require(name); } catch (_) { return null; } }

const EMOJIS = { 1: '👍', 2: '🔥', 3: '\u2764', 4: '🍾' };
const MAX_ATTEMPTS = 3;

const panel = {
  enabled: true,
  channels: [],          // canaux cochés (id)
  states: {},            // id canal -> { 1..4 : état de suivi de chaque type }
  known: [],             // canaux détectés comme envoyant des prédictions : { id, title, sources }
  reacted: [],           // clés « chatId:messageId » déjà traitées
  attempts: {},          // clé -> nombre d'essais ratés
  reactedCount: 0,
  lastReactAt: null,
  lastScanAt: null,
  lastError: null,
  history: [],
};

let sender = null;
function setSender(fn) { sender = fn; }

let channelSource = null; // () => [{ id, title, sources }] fourni par server.js (liste complète des canaux)
function setChannelSource(fn) { channelSource = fn; }

let busy = false;

const sameChannel = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function parseChannels(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n) && n !== 0 && !out.some((x) => sameChannel(x, n))) out.push(n);
    } else {
      const name = t.startsWith('@') ? t : `@${t.replace(/^https?:\/\/t\.me\//i, '')}`;
      if (name.length > 2 && !out.some((x) => sameChannel(x, name))) out.push(name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Détection des canaux qui envoient des prédictions
// ---------------------------------------------------------------------------
// Lecture directe des réglages de TOUS les boutons : toute liste dont le nom
// finit par « channels » (channels, destChannels, bestChannels, publishedChannels…)
// est reprise, dans le panneau comme dans chaque configuration créée. Les canaux
// internes du site (siteChannelId…) ne sont pas des canaux Telegram : ignorés.
const SKIP_KEYS = new Set(['messages', 'pendingMessages', 'history', 'predictions', 'seen', 'states', 'verified',
  'sourcePredictions', 'lastPreds', 'channelTitles', 'refs', 'trigRefs', 'lastWins', 'sources', 'progress']);

function validId(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (typeof v === 'string') return /^-?\d+$/.test(v.trim()) || /^@[A-Za-z0-9_]{4,}$/.test(v.trim());
  return false;
}

function collectFrom(node, label, add, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 7) return;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 300)) collectFrom(item, label, add, depth + 1);
    return;
  }
  const here = node.name && typeof node.name === 'string' ? `${label} · ${node.name}` : label;
  for (const [k, v] of Object.entries(node)) {
    if (SKIP_KEYS.has(k) || /site/i.test(k)) continue;
    if (/channels$/i.test(k)) {
      if (Array.isArray(v)) v.forEach((id) => { if (validId(id)) add(id, here); });
      else if (v && typeof v === 'object') {
        for (const list of Object.values(v)) if (Array.isArray(list)) list.forEach((id) => { if (validId(id)) add(id, here); });
      }
      continue;
    }
    if (k === 'channelId' && validId(v)) { add(v, here); continue; }
    if (v && typeof v === 'object') collectFrom(v, here, add, depth + 1);
  }
}

// Canaux configurés dans n'importe quel bouton + canaux où le site a réellement
// publié des prédictions (même s'ils ne sont plus saisis dans un réglage).
function discoverChannels() {
  const found = new Map();
  const add = (id, source) => {
    if (id === null || id === undefined || id === '') return;
    const key = String(id).trim();
    if (!found.has(key)) found.set(key, { id: key, title: '', sources: [] });
    const row = found.get(key);
    if (source && !row.sources.includes(source)) row.sources.push(source);
  };
  const titles = {};
  const addTitle = (id, t) => { const k = String(id == null ? '' : id).trim(); if (k && t && String(t) !== k && !titles[k]) titles[k] = String(t); };
  const fromMessages = (list, label) => {
    for (const e of (list || [])) for (const m of (e.messages || [])) add(m.chatId, label);
  };
  const predictor = lazy('./predictor');
  const strategies = lazy('./strategies');
  try {
    const st = predictor && predictor.state;
    fromMessages(st && st.predictions, 'Stratégies');
    (Array.isArray(st && st.activeChannels) ? st.activeChannels : []).forEach((id) => { if (validId(id)) add(id, 'Canaux actifs'); });
    // canaux où le bot (l'API) a été ajouté : ils ont un nom
    for (const c of (Array.isArray(st && st.channels) ? st.channels : [])) {
      if (c && validId(c.id)) { add(c.id, 'Bot ajouté dans ce canal'); addTitle(c.id, c.title); }
    }
    // toutes les stratégies : canaux publiés, silencieux et anciens canaux
    for (const [key, cfg] of Object.entries((st && st.strategies) || {})) {
      const def = strategies && Array.isArray(strategies.LIST) ? strategies.LIST.find((x) => x.key === key) : null;
      const name = def ? def.name : key;
      for (const id of (Array.isArray(cfg.publishedChannels) ? cfg.publishedChannels : [])) if (validId(id)) add(id, `Stratégie · ${name} · publié`);
      for (const id of (Array.isArray(cfg.shadowChannels) ? cfg.shadowChannels : [])) if (validId(id)) add(id, `Stratégie · ${name} · silencieux`);
      for (const id of (Array.isArray(cfg.channels) ? cfg.channels : [])) if (validId(id)) add(id, `Stratégie · ${name}`);
      for (const info of [...(cfg.publishedChannelInfos || []), ...(cfg.shadowChannelInfos || [])]) if (info && validId(info.id)) addTitle(info.id, info.title || info.name);
    }
  } catch (_) {}
  const predit = lazy('./predit');
  try { fromMessages(predit && predit.panel && predit.panel.predictions, 'Prédit IA'); } catch (_) {}
  const mods = [
    ['./after-loss', 'Prédiction après perte'], ['./combined', 'Prédiction combinée'],
    ['./suit-streak', 'Répétition costume'], ['./suit-break', 'Rupture costume'],
    ['./overlap', 'Chevauchement'], ['./vip', 'VIP'], ['./predit', 'Prédit IA'],
    ['./dizaine-top', 'Dizaine'], ['./costume-faible-top', 'Costume faible'], ['./best-weak-top', 'Meilleur + plus faible'],
    ['./bet-type', 'Type de mise'], ['./copy-announce', 'Copie et annonce'],
    ['./statistics', 'Statistiques'], ['./cards-count', 'Comptage 2/2'], ['./game21-predict', 'Jeu 21'],
    ['./formation-relay', 'Formation'], ['./mirror-counter', 'Compteur miroir'],
  ];
  for (const [file, label] of mods) {
    const mod = lazy(file);
    if (!mod) continue;
    try { collectFrom(mod.panel || mod.state, label, add); } catch (_) {}
    try { for (const [id, t] of Object.entries((mod.panel && mod.panel.channelTitles) || {})) addTitle(id, t); } catch (_) {}
    try { fromMessages(mod.panel && mod.panel.pendingMessages, label); } catch (_) {}
  }
  for (const row of found.values()) row.title = titles[row.id] || row.title || '';
  return [...found.values()];
}

// Revérifie tous les canaux qui envoient des prédictions (démarrage, import,
// puis régulièrement) et met à jour la liste proposée dans le bouton « J'aime ».
function scan() {
  const rows = new Map();
  const merge = (list) => {
    for (const r of (list || [])) {
      if (!r || r.id === undefined || r.id === null || r.id === '') continue;
      const key = String(r.id);
      if (!rows.has(key)) rows.set(key, { id: key, title: r.title || '', sources: [] });
      const row = rows.get(key);
      if (!row.title && r.title) row.title = r.title;
      for (const s of (r.sources || [])) if (!row.sources.includes(s)) row.sources.push(s);
    }
  };
  try { if (typeof channelSource === 'function') merge(channelSource()); } catch (_) {}
  try { merge(discoverChannels()); } catch (_) {}
  // un canal déjà coché reste toujours dans la liste
  for (const id of panel.channels) merge([{ id, title: '', sources: [] }]);
  panel.known = [...rows.values()];
  panel.lastScanAt = Date.now();
  return panel.known;
}

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------
function emptyTypeState(seen) {
  return { seen: seen || [], streakSuit: null, streakCount: 0, waitingSuit: null, armed: false, lossCount: 0 };
}
function entriesOf(id) {
  const ca = lazy('./copy-announce');
  if (!ca || typeof ca.sourceEntries !== 'function') return [];
  return ca.sourceEntries(`channel:${id}`).filter((e) => e.suit).sort((a, b) => a.target - b.target);
}
// Un canal qui vient d'être coché ignore tout l'historique déjà publié.
function newChannelState(id) {
  const uids = entriesOf(id).map((e) => e.uid);
  return { 1: emptyTypeState(uids.slice()), 2: emptyTypeState(uids.slice()), 3: emptyTypeState(uids.slice()), 4: emptyTypeState(uids.slice()) };
}
const keyOf = (id) => String(id);
const stateKey = (id) => Object.keys(panel.states).find((k) => sameChannel(k, id));

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) {
    const next = parseChannels(patch.channels);
    const states = {};
    for (const id of next) {
      const k = stateKey(id);
      states[keyOf(id)] = k ? panel.states[k] : newChannelState(id);
    }
    panel.channels = next;
    panel.states = states;
  }
  persist();
  return config();
}

function config() {
  return { enabled: panel.enabled, channels: panel.channels };
}

// ---------------------------------------------------------------------------
// Suivi des prédictions d'un canal (mêmes règles que « Type de mise »)
// ---------------------------------------------------------------------------
// Parcourt les prédictions du canal pour UN type et appelle onFire(entrée)
// pour chaque prédiction qui déclenche la règle.
function runType(type, st, entries, onFire) {
  for (const e of entries) {
    if (st.seen.includes(e.uid)) continue;
    const pending = e.status === 'en attente';
    const lost = e.status === 'perdu';
    const won = e.status === 'gagné';
    if (e.status === 'annulé') { st.seen.push(e.uid); continue; }

    if (type === 3 || type === 4) {
      const need = type === 3 ? 2 : 1;
      if (st.armed) {
        // une prédiction déjà terminée ne peut plus être marquée : on reste armé
        if (pending) { onFire(e); st.armed = false; st.lossCount = 0; }
        st.seen.push(e.uid);
        continue;
      }
      if (!pending && !lost && !won) { st.seen.push(e.uid); continue; }
      if (pending) break; // on attend son résultat avant d'aller plus loin
      if (lost) { st.lossCount += 1; if (st.lossCount >= need) st.armed = true; } else st.lossCount = 0;
      st.seen.push(e.uid);
      continue;
    }

    // types 1 et 2 : séries de même costume (peu importe gagné / perdu)
    if (type === 2 && st.armed) {
      if (pending) { onFire(e); st.armed = false; st.streakSuit = null; st.streakCount = 0; }
      st.seen.push(e.uid);
      continue;
    }
    if (type === 1 && st.waitingSuit) {
      if (e.suit === st.waitingSuit && pending) { onFire(e); st.waitingSuit = null; }
      st.seen.push(e.uid);
      continue;
    }
    if (e.suit === st.streakSuit) st.streakCount += 1;
    else { st.streakSuit = e.suit; st.streakCount = 1; }
    if (st.streakCount >= 2) {
      if (type === 1) st.waitingSuit = e.suit; else st.armed = true;
      st.streakSuit = null; st.streakCount = 0;
    }
    st.seen.push(e.uid);
  }
  if (st.seen.length > 800) st.seen = st.seen.slice(-600);
}

async function setReaction(bot, chatId, messageId, emoji) {
  const reaction = [{ type: 'emoji', emoji }];
  if (typeof bot._request === 'function') {
    return bot._request('setMessageReaction', {
      form: { chat_id: chatId, message_id: messageId, reaction: JSON.stringify(reaction) },
    });
  }
  throw new Error('Cette version de la bibliothèque Telegram ne gère pas les réactions');
}

async function processChannel(bot, id) {
  const k = keyOf(id);
  const key0 = stateKey(id);
  if (!key0) panel.states[k] = newChannelState(id);
  const states = panel.states[key0 || k];
  const entries = entriesOf(id);
  // prédiction (uid) -> plus petit type qui la déclenche (une seule réaction possible par message)
  const fired = new Map();
  for (const type of [1, 2, 3, 4]) {
    if (!states[type]) states[type] = emptyTypeState(entries.map((e) => e.uid));
    runType(type, states[type], entries, (e) => {
      const old = fired.get(e.uid);
      if (!old || type < old.type) fired.set(e.uid, { entry: e, type });
    });
  }
  for (const { entry, type } of fired.values()) {
    const emoji = EMOJIS[type];
    for (const m of (entry.messages || [])) {
      if (m.messageId === null || m.messageId === undefined) continue;
      if (!sameChannel(m.chatId, id)) continue; // uniquement le message du canal coché
      const key = `${m.chatId}:${m.messageId}`;
      if (panel.reacted.includes(key)) continue;
      try {
        await setReaction(bot, m.chatId, m.messageId, emoji);
        panel.reacted.push(key);
        panel.reactedCount += 1; panel.lastReactAt = Date.now();
        panel.history.unshift({ chatId: m.chatId, messageId: m.messageId, type, emoji, target: entry.target, suit: entry.suit, at: Date.now() });
        panel.history = panel.history.slice(0, 50);
        delete panel.attempts[key];
        panel.lastError = null;
      } catch (e) {
        panel.attempts[key] = (panel.attempts[key] || 0) + 1;
        panel.lastError = `${m.chatId} : ${e.message}`;
        if (panel.attempts[key] >= MAX_ATTEMPTS) { panel.reacted.push(key); delete panel.attempts[key]; }
      }
    }
  }
}

async function processReactions() {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot || !panel.channels.length) return;
  for (const id of panel.channels) {
    try { await processChannel(bot, id); } catch (e) { panel.lastError = e.message; }
  }
  if (panel.reacted.length > 1500) panel.reacted = panel.reacted.slice(-1000);
}

let lastScan = 0;
async function tick(opts = {}) {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    if (Date.now() - lastScan > 60000) { scan(); lastScan = Date.now(); }
    await processReactions();
  } catch (e) {
    panel.lastError = e.message;
  } finally {
    persist();
    busy = false;
  }
  return panel;
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const seen = {};
  for (const [id, st] of Object.entries(panel.states)) {
    seen[id] = {};
    for (const t of [1, 2, 3, 4]) seen[id][t] = ((st[t] || {}).seen || []).slice(-300);
  }
  const saved = {
    config: { enabled: panel.enabled }, channels: panel.channels, seen,
    reacted: panel.reacted.slice(-1000), reactedCount: panel.reactedCount, lastReactAt: panel.lastReactAt,
  };
  try { store.patch({ likeReact: saved }); } catch (_) {}
  if (db.ready) db.setSetting('like_react_state', JSON.stringify(saved)).catch((error) => { panel.lastError = error.message; });
}

function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  if (saved.config) panel.enabled = saved.config.enabled !== false;
  panel.channels = parseChannels(saved.channels);
  panel.states = {};
  for (const id of panel.channels) {
    const k = saved.seen && Object.keys(saved.seen).find((x) => sameChannel(x, id));
    // séries / attentes remises à zéro au redémarrage ; les prédictions déjà vues sont conservées.
    // Sans mémoire enregistrée, l'état est créé au premier passage (historique ignoré).
    if (!k) continue;
    const o = saved.seen[k] || {};
    panel.states[keyOf(id)] = {};
    for (const t of [1, 2, 3, 4]) panel.states[keyOf(id)][t] = emptyTypeState(Array.isArray(o[t]) ? o[t].map(String).slice(-300) : []);
  }
  panel.reacted = Array.isArray(saved.reacted) ? saved.reacted.map(String).slice(-1000) : [];
  panel.reactedCount = Number(saved.reactedCount) || 0;
  panel.lastReactAt = saved.lastReactAt || null;
}

// restore() sert aussi après un import : on revérifie alors les canaux.
function restore() {
  try { const saved = (store.read() || {}).likeReact; if (saved) applySaved(saved); } catch (_) {}
  try { scan(); lastScan = Date.now(); } catch (_) {}
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('like_react_state');
    if (raw) applySaved(JSON.parse(raw)); else persist();
  } catch (_) { persist(); }
  return config();
}

// ---------------------------------------------------------------------------
// Vue pour le tableau de bord
// ---------------------------------------------------------------------------
function statusView() {
  return {
    enabled: panel.enabled,
    channels: panel.channels,
    emojis: EMOJIS,
    known: panel.known,
    progress: Object.fromEntries(panel.channels.map((id) => {
      const st = panel.states[keyOf(id)] || {};
      const v = (t) => { const x = st[t] || {}; return { streakSuit: x.streakSuit || null, streakCount: x.streakCount || 0, waitingSuit: x.waitingSuit || null, armed: !!x.armed, lossCount: x.lossCount || 0 }; };
      return [String(id), { 1: v(1), 2: v(2), 3: v(3), 4: v(4) }];
    })),
    reactedCount: panel.reactedCount, lastReactAt: panel.lastReactAt,
    lastScanAt: panel.lastScanAt, lastError: panel.lastError,
    history: panel.history.slice(0, 20),
  };
}

module.exports = {
  panel, EMOJIS, setSender, setChannelSource, tick, scan, discoverChannels, config, configure,
  restore, restoreFromDb, parseChannels, status: statusView,
};
module.exports.persist = persist;
