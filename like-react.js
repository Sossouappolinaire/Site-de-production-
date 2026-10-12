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
  typeResults: {},        // canal -> type -> prédictions déclenchées et résultat vérifié
  known: [],             // canaux détectés comme envoyant des prédictions : { id, title, sources }
  reacted: [],           // clés « chatId:messageId » déjà traitées
  attempts: {},          // clé -> nombre d'essais ratés
  reactedCount: 0,
  lastReactAt: null,
  lastScanAt: null,
  lastError: null,
  history: [],
  diag: {},              // id canal -> { followed, pending, lastFire, lastError, lastErrorAt }
};

let sender = null;
function setSender(fn) { sender = fn; }

let channelSource = null; // () => [{ id, title, sources }] fourni par server.js (liste complète des canaux)
function setChannelSource(fn) { channelSource = fn; }

let busy = false;

const sameChannel = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// Un même canal peut être saisi « @nom » dans un bouton et « -100… » dans un autre.
// Les messages enregistrent l'identifiant tel qu'il a été saisi : sans cette
// équivalence, un canal coché sous son numéro ne retrouvait pas ses prédictions.
const aliasCache = {};   // '@nom' (minuscules) -> identifiant numérique (texte)
const aliasFailedAt = {}; // '@nom' -> date du dernier échec de résolution
const canon = (x) => { const s = String(x == null ? '' : x).trim().toLowerCase(); return aliasCache[s] || s; };
const sameCh = (a, b) => canon(a) === canon(b);
// toutes les écritures connues du même canal
function aliasesOf(id) {
  const c = canon(id);
  const out = new Set([String(id), c]);
  for (const [name, num] of Object.entries(aliasCache)) if (num === c) out.add(name);
  return [...out];
}
async function refreshAliases(bot) {
  if (!bot || typeof bot.getChat !== 'function') return;
  const names = new Set();
  for (const id of panel.channels) if (typeof id === 'string' && id.startsWith('@')) names.add(id);
  try { for (const r of discoverChannels()) if (String(r.id).startsWith('@')) names.add(String(r.id)); } catch (_) {}
  let n = 0;
  for (const name of names) {
    const k = name.toLowerCase();
    if (aliasCache[k] || (aliasFailedAt[k] && Date.now() - aliasFailedAt[k] < 600000) || n >= 5) continue;
    n += 1;
    try { const chat = await bot.getChat(name); if (chat && chat.id !== undefined) aliasCache[k] = String(chat.id); }
    catch (_) { aliasFailedAt[k] = Date.now(); }
  }
}

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

const MAX_TRACKED_CHANNELS = 4;
function testChannels() {
  const bw = lazy('./best-weak-top');
  const configs = bw && bw.panel && Array.isArray(bw.panel.configs) ? bw.panel.configs : [];
  return [...new Set(configs
    .filter((c) => c && c.enabled !== false && c.mode === 'test')
    .flatMap((c) => Array.isArray(c.channels) ? c.channels.map(String) : []))];
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
// modules dont les messages de prédiction ne passent pas par copy-announce.sourceEntries()
const EXTRA_SOURCES = [
  ['./bet-type', 'pendingMessages', 'bet-type'],
  ['./dizaine-top', 'pendingMessages', 'dizaine'],
  ['./costume-faible-top', 'pendingMessages', 'faible'],
  ['./vip', 'pendingMessages', 'vip'],
  ['./best-weak-top', 'pending', 'bestweak'],
];

function entriesOf(id) {
  const ca = lazy('./copy-announce');
  const entries = [];
  if (ca && typeof ca.sourceEntries === 'function') {
    const seenUid = new Set();
    for (const key of aliasesOf(id)) {
      for (const e of ca.sourceEntries(`channel:${key}`)) { if (!seenUid.has(e.uid)) { seenUid.add(e.uid); entries.push(e); } }
    }
  }

  // « J'aime » est indépendant de « Type de mise » : il lit les prédictions envoyées
  // par TOUS les boutons. copy-announce.sourceEntries() ne couvre que les
  // stratégies et quelques suivis (Après perte, Combinaison, Répétition, Rupture,
  // Chevauchement) : on ajoute ici les messages publiés par Type de mise, Dizaine,
  // Costume faible, VIP, Meilleur + plus faible et les relais de Copie et annonce.
  const have = new Set();
  for (const e of entries) for (const m of (e.messages || [])) have.add(`${canon(m.chatId)}:${m.messageId}`);
  const addExtra = (prefix, e) => {
    const suit = e && (e.suit || (Array.isArray(e.suits) && e.suits[0] && e.suits[0].suit));
    if (!e || !Array.isArray(e.messages) || !suit) return;
    const messages = e.messages.filter((m) => m && m.messageId !== null && m.messageId !== undefined && sameCh(m.chatId, id));
    if (!messages.length) return;
    if (messages.every((m) => have.has(`${canon(m.chatId)}:${m.messageId}`))) return; // déjà lu ailleurs
    messages.forEach((m) => have.add(`${canon(m.chatId)}:${m.messageId}`));
    entries.push({
      uid: `${prefix}:${e.id || e.uid || `${e.trackerId || ''}:${e.scope || ''}:${e.target || ''}:${e.createdAt || ''}`}`,
      target: e.target, suit, status: e.status, step: e.step || 0, messages,
    });
  };
  for (const [file, prop, prefix] of EXTRA_SOURCES) {
    const mod = lazy(file);
    const list = mod && mod.panel && Array.isArray(mod.panel[prop]) ? mod.panel[prop] : [];
    for (const e of list) addExtra(prefix, e);
  }
  const copy = lazy('./copy-announce');
  try { for (const r of ((copy && copy.panel && copy.panel.rules) || [])) for (const e of (r.mirrors || [])) addExtra('copie', e); } catch (_) {}

  return entries.filter((e) => e.suit).sort((a, b) => a.target - b.target);
}
// Un canal qui vient d'être coché relit les prédictions déjà publiées pour
// connaître la situation (séries de même costume, pertes) mais ne réagit jamais
// sur ces anciens messages : seules les nouvelles prédictions reçoivent un emoji.
function newChannelState(id) {
  const st = { 1: emptyTypeState(), 2: emptyTypeState(), 3: emptyTypeState(), 4: emptyTypeState() };
  let entries = [];
  try { entries = id === undefined ? [] : entriesOf(id); } catch (_) {}
  // relecture silencieuse : l'état (séries, pertes) est appris, aucune réaction n'est mise
  for (const type of [1, 2, 3, 4]) runType(type, st[type], entries, () => {});
  return st;
}
const keyOf = (id) => String(id);
const stateKey = (id) => Object.keys(panel.states).find((k) => sameChannel(k, id));

function configure(patch = {}) {
  const next = patch.channels === undefined ? null : parseChannels(patch.channels);
  if (next !== null) {
    if (next.length > MAX_TRACKED_CHANNELS) throw new Error(`J'aime peut suivre au maximum ${MAX_TRACKED_CHANNELS} canaux.`);
    const eligible = testChannels();
    const invalid = next.filter((id) => !eligible.some((x) => sameCh(x, id)) && !panel.channels.some((x) => sameCh(x, id)));
    if (invalid.length) throw new Error('J’aime suit uniquement les canaux configurés dans « Test ». Configure d’abord le canal dans Test.');
  }
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (next !== null) {
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
        // les pertes précédentes ont armé la règle : la première prédiction suivante
        // reçoit la réaction, sans attendre son résultat
        onFire(e); st.armed = false; st.lossCount = 0;
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
      onFire(e); st.armed = false; st.streakSuit = null; st.streakCount = 0;
      st.seen.push(e.uid);
      continue;
    }
    if (type === 1 && st.waitingSuit) {
      if (e.suit === st.waitingSuit) { onFire(e); st.waitingSuit = null; }
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

function errText(e) {
  const body = e && e.response && e.response.body;
  const desc = body && (body.description || (typeof body === 'string' ? body : ''));
  return String(desc || (e && e.message) || e);
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

function rememberTypeResult(channelId, type, entry) {
  const key = keyOf(channelId);
  const channel = panel.typeResults[key] || (panel.typeResults[key] = {});
  const bucket = channel[type] && !Array.isArray(channel[type]) ? channel[type] : (channel[type] = { wins: 0, losses: 0, pending: [] });
  const pending = bucket.pending || (bucket.pending = []);
  if (pending.some((x) => x.uid === entry.uid)) return;
  if (entry.status === 'gagné') bucket.wins = (Number(bucket.wins) || 0) + 1;
  else if (entry.status === 'perdu') bucket.losses = (Number(bucket.losses) || 0) + 1;
  else if (entry.status === 'en attente') pending.push({ uid: entry.uid, target: entry.target, suit: entry.suit, at: Date.now() });
}

function syncTypeResults(channelId, entries) {
  const results = new Map((entries || []).map((e) => [e.uid, e]));
  for (const [id, channel] of Object.entries(panel.typeResults)) {
    if (!sameCh(id, channelId)) continue;
    for (const type of [1, 2, 3, 4]) {
      const bucket = channel[type];
      if (!bucket || Array.isArray(bucket)) continue;
      const keep = [];
      for (const row of (bucket.pending || [])) {
        const current = results.get(row.uid);
        if (!row.at) row.at = Date.now(); // sauvegardes plus anciennes : on date maintenant
        if (!current && Date.now() - row.at > 36 * 3600 * 1000) continue; // plus visible depuis 36 h : abandonnée
        if (!current || current.status === 'en attente') { keep.push(row); continue; }
        if (current.status === 'gagné') bucket.wins = (Number(bucket.wins) || 0) + 1;
        else if (current.status === 'perdu') bucket.losses = (Number(bucket.losses) || 0) + 1;
      }
      bucket.pending = keep;
    }
  }
}

function typeStatsFor(channelId) {
  const rows = {};
  const matching = Object.entries(panel.typeResults).filter(([id]) => sameCh(id, channelId)).map(([, data]) => data);
  for (const type of [1, 2, 3, 4]) {
    const buckets = matching.map((data) => data[type]).filter((x) => x && !Array.isArray(x));
    const wins = buckets.reduce((sum, x) => sum + (Number(x.wins) || 0), 0);
    const losses = buckets.reduce((sum, x) => sum + (Number(x.losses) || 0), 0);
    const pending = buckets.reduce((sum, x) => sum + (Array.isArray(x.pending) ? x.pending.length : 0), 0);
    const verified = wins + losses;
    rows[type] = { total: verified + pending, verified, wins, losses, pending, ratePct: verified ? Math.round(wins * 100 / verified) : null };
  }
  return rows;
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
      rememberTypeResult(id, type, e);
    });
  }
  syncTypeResults(id, entries);
  const dg = panel.diag[k] || (panel.diag[k] = {});
  dg.followed = entries.length;
  dg.pending = entries.filter((e) => e.status === 'en attente').length;
  dg.checkedAt = Date.now();
  dg.recent = entries.slice(-5).map((e) => ({ target: e.target, suit: e.suit, status: e.status }));
  for (const { entry, type } of fired.values()) {
    const emoji = EMOJIS[type];
    dg.lastFire = { type, emoji, target: entry.target, suit: entry.suit, at: Date.now() };
    for (const m of (entry.messages || [])) {
      if (m.messageId === null || m.messageId === undefined) continue;
      if (!sameCh(m.chatId, id)) continue; // uniquement le message du canal coché
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
        panel.lastError = `${m.chatId} : ${errText(e)}`;
        dg.lastError = errText(e); dg.lastErrorAt = Date.now();
        console.error('[J\'aime] réaction refusée', m.chatId, m.messageId, errText(e));
        if (panel.attempts[key] >= MAX_ATTEMPTS) { panel.reacted.push(key); delete panel.attempts[key]; }
      }
    }
  }
}

// Ce que le bot voit dans un canal (sans rien envoyer).
function inspect(channelId) {
  const entries = entriesOf(channelId);
  let last = null;
  for (const e of entries) for (const m of (e.messages || [])) {
    if (sameCh(m.chatId, channelId) && m.messageId !== null && m.messageId !== undefined) {
      if (!last || Number(m.messageId) > Number(last.messageId)) last = { chatId: m.chatId, messageId: m.messageId, target: e.target, suit: e.suit };
    }
  }
  const row = (panel.known || []).find((r) => sameCh(r.id, channelId));
  const dg = panel.diag[String(channelId)] || {};
  return {
    id: String(channelId),
    title: (row && row.title) || '',
    checked: panel.channels.some((c) => sameCh(c, channelId)),
    followed: entries.length,
    pending: entries.filter((e) => e.status === 'en attente').length,
    last,
    lastFire: dg.lastFire || null,
    lastError: dg.lastError || null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test d'un canal : teste les 4 emojis (👍 🔥 ❤ 🍾) sur le dernier message de
// prédiction du canal, vérifie le rôle du bot, puis remet le message comme avant
// (la réaction déjà posée par « J'aime », sinon aucune réaction).
async function testReaction(channelId) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun bot Telegram n\'est connecté (token manquant).' };
  try { await refreshAliases(bot); } catch (_) {}
  const info = inspect(channelId);
  if (!info.last) {
    return { ok: false, info, error: `Aucune prédiction du site n'a été trouvée dans le canal ${channelId} : le bot n'y a encore envoyé aucun message suivi.` };
  }
  const { chatId, messageId } = info.last;

  let role = null;
  try { const me = await bot.getMe(); const mem = await bot.getChatMember(chatId, me.id); role = mem && mem.status; } catch (_) {}

  const results = {};
  let firstError = null;
  for (const type of [1, 2, 3, 4]) {
    const emoji = EMOJIS[type];
    try { await setReaction(bot, chatId, messageId, emoji); results[type] = { type, emoji, ok: true }; }
    catch (e) { const err = errText(e); results[type] = { type, emoji, ok: false, error: err }; if (!firstError) firstError = err; }
    await sleep(350);
  }
  // remise en l'état : la réaction que « J'aime » avait déjà posée sur ce message, sinon aucune
  const had = panel.history.find((h) => String(h.messageId) === String(messageId) && sameCh(h.chatId, chatId));
  try {
    if (had) await setReaction(bot, chatId, messageId, had.emoji);
    else await bot._request('setMessageReaction', { form: { chat_id: chatId, message_id: messageId, reaction: JSON.stringify([]) } });
  } catch (_) {}
  const okAll = Object.values(results).every((r) => r.ok);
  return { ok: okAll, error: okAll ? null : firstError, info, role, messageId, results, emoji: EMOJIS[1] };
}

async function processReactions() {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun bot Telegram connecté (token manquant) : aucune réaction ne peut être mise.'; return; }
  if ((panel.lastError || '').startsWith('Aucun bot')) panel.lastError = null;
  if (!panel.channels.length) return;
  try { await refreshAliases(bot); } catch (_) {}
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
let lastPersisted = '';
function persist() {
  const seen = {};
  for (const [id, st] of Object.entries(panel.states)) {
    seen[id] = {};
    for (const t of [1, 2, 3, 4]) seen[id][t] = ((st[t] || {}).seen || []).slice(-300);
  }
  const saved = {
    config: { enabled: panel.enabled }, channels: panel.channels, seen,
    reacted: panel.reacted.slice(-1000), reactedCount: panel.reactedCount, lastReactAt: panel.lastReactAt,
    typeResults: panel.typeResults,
  };
  const json = JSON.stringify(saved);
  if (json === lastPersisted) return;
  lastPersisted = json;
  try { store.patch({ likeReact: saved }); } catch (_) {}
  if (db.ready) db.setSetting('like_react_state', json).catch((error) => { panel.lastError = error.message; });
}

function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  if (saved.config) panel.enabled = saved.config.enabled !== false;
  // aucun filtre ici : un import ou un redémarrage ne doit jamais vider la sélection (seul le plafond de 4 s'applique)
  panel.channels = parseChannels(saved.channels).slice(0, MAX_TRACKED_CHANNELS);
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
  panel.typeResults = saved.typeResults && typeof saved.typeResults === 'object' ? saved.typeResults : {};
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
    typeStats: Object.fromEntries(panel.channels.map((id) => [String(id), typeStatsFor(id)])),
    diag: panel.diag,
    reactedCount: panel.reactedCount, lastReactAt: panel.lastReactAt,
    lastScanAt: panel.lastScanAt, lastError: panel.lastError,
    history: panel.history.slice(0, 20),
  };
}

module.exports = {
  panel, EMOJIS, testReaction, inspect, setSender, setChannelSource, tick, scan, discoverChannels, config, configure,
  restore, restoreFromDb, parseChannels, status: statusView,
};
module.exports.persist = persist;
