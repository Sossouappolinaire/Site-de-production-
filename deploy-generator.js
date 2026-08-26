// deploy-generator.js — panneau admin « Déploiement » :
//
//  • Génère à la volée (en mémoire, sans écrire sur disque) un fichier ZIP
//    contenant un bot Baccara AUTONOME, minimal, ne comportant QUE la ou les
//    stratégie(s) choisies — déployable sur N'IMPORTE QUELLE plateforme
//    (Render, Railway, Fly.io, VPS…), sans compte utilisateur ni connexion :
//    la seule page du site déployé sert à saisir le TOKEN API Telegram et
//    l'ID du canal.
//  • Les vrais fichiers moteur (api.js, strategies.js, formats.js,
//    tg-formats.js) sont recopiés TELS QUELS depuis ce projet, pour garantir
//    que la logique de détection déployée est identique à celle utilisée ici
//    — jamais réécrite à la main, donc jamais désynchronisée.
//  • Une stratégie « standard » embarque sa configuration ACTUELLE (b, maxR,
//    format, lead, absence, scope, streak…) comme réglage par défaut figé
//    dans le code. Une stratégie « IA » (panneau Analyseur IA, proposition
//    validée à 75%+) est ramenée à sa stratégie de base compatible
//    (`compatibleExisting`, déjà validée à l'enregistrement) et utilise elle
//    aussi les réglages ACTUELS de cette stratégie de base — c'est ce que
//    signifie « utiliser le déclencheur actuel ».
//  • Simplification volontaire : le filtre « double perte » / mode
//    silencieux (réservé à « ombre » dans le bot principal), le
//    déclencheur automatique « perte/rattrapage + N » et le panneau
//    « après perte » ne sont PAS reproduits dans le paquet déployé — chaque
//    prédiction détectée est envoyée directement dans le canal configuré.
'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const strategies = require('./strategies');
const { state } = require('./predictor');

// ---------------------------------------------------------------------------
// Résolution de la sélection envoyée par le panneau admin.
// selection : [{ type: 'base', key } | { type: 'ai', id }]
// ---------------------------------------------------------------------------
const CFG_FIELDS = ['format', 'maxR', 'b', 'lead', 'absence', 'scope', 'streak', 'template'];

function pickCfg(liveCfg, key) {
  const base = strategies.defaultsFor(key) || {};
  const out = { enabled: true };
  for (const f of CFG_FIELDS) {
    const v = (liveCfg && liveCfg[f] !== undefined) ? liveCfg[f] : base[f];
    if (v !== undefined) out[f] = v;
  }
  return out;
}

function resolveSelection(selection) {
  const list = Array.isArray(selection) ? selection : [];
  const resolved = [];
  const seen = new Set();
  for (const sel of list) {
    if (!sel) continue;
    if (sel.type === 'ai') {
      const item = (state.aiStrategies || []).find((s) => s.id === sel.id);
      if (!item || !item.compatibleExisting || !strategies.BY_KEY[item.compatibleExisting]) continue;
      const key = item.compatibleExisting;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({
        key,
        label: `${item.name} (stratégie IA → ${strategies.BY_KEY[key].name})`,
        cfg: pickCfg(state.strategies[key], key),
        origin: 'ia',
        aiName: item.name,
      });
    } else {
      const key = sel.key;
      if (!key || !strategies.BY_KEY[key] || seen.has(key)) continue;
      seen.add(key);
      resolved.push({
        key,
        label: strategies.BY_KEY[key].name,
        cfg: pickCfg(state.strategies[key], key),
        origin: 'base',
      });
    }
  }
  return resolved;
}

function listSelectable() {
  return {
    base: strategies.LIST.map((s) => ({ key: s.key, name: s.name, about: s.about })),
    ai: (state.aiStrategies || [])
      .filter((s) => s.compatibleExisting && strategies.BY_KEY[s.compatibleExisting])
      .map((s) => ({
        id: s.id,
        name: s.name,
        rate: s.rate,
        compatibleExisting: s.compatibleExisting,
        compatibleExistingName: strategies.BY_KEY[s.compatibleExisting].name,
      })),
  };
}

// ---------------------------------------------------------------------------
// Gabarits des fichiers du paquet généré.
// ---------------------------------------------------------------------------
function slugFor(resolved) {
  const raw = resolved.map((r) => r.key).join('-') || 'strategie';
  return `baccara-bot-${raw}`.slice(0, 60);
}

function buildConfigJs() {
  return `// config.js — généré automatiquement (paquet de déploiement mono-stratégie)
'use strict';
const store = require('./store');

module.exports = {
  get BOT_TOKEN() { return (process.env.BOT_TOKEN || store.read().botToken || '').trim(); },
  get CHANNEL_ID() { return (process.env.CHANNEL_ID || store.read().channelId || '').trim(); },
  PORT: Number(process.env.PORT || 10000),

  // API 1xbet Baccara (LiveFeed/GetChampZip) — identiques au projet d'origine.
  CHAMP_ID: 2050671,
  API_HOSTS: [
    'https://1xbet.cd/service-api',
    'https://1xbet.com/service-api',
    'https://1xbet-africa.com/service-api',
    'https://1xbet.ng/service-api',
  ],
  PROXIES: [
    (u) => \`https://api.allorigins.win/raw?url=\${encodeURIComponent(u)}\`,
    (u) => \`https://api.codetabs.com/v1/proxy?quest=\${encodeURIComponent(u)}\`,
  ],
  POLL_INTERVAL_MS: 1500,

  SUIT_BY_LAST_DIGIT: { 2: '♦️', 5: '❤️', 6: '♣️', 9: '♠️' },
  LEAD: 2,
  DEFAULT_HAND: 'joueur',
  DEFAULT_B: 3,
  DEFAULT_MAX_R: 2,
  DEFAULT_FORMAT: 1,
};
`;
}

function buildStoreJs() {
  return `// store.js — persistance locale (fichier JSON) du token Telegram et du
// canal configurés depuis la page du site. AUCUNE base de données requise.
// ⚠️ Sur certaines plateformes (ex. Render sans disque persistant), ce
// fichier peut être réinitialisé après un redéploiement — définir aussi les
// variables d'environnement BOT_TOKEN / CHANNEL_ID sur la plateforme choisie
// garantit une configuration qui survit à un redéploiement.
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'settings.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; }
}
function write(patch) {
  const next = { ...read(), ...patch };
  try { fs.writeFileSync(FILE, JSON.stringify(next, null, 2)); } catch (_) {}
  return next;
}
module.exports = { read, write };
`;
}

function buildEngineJs(resolved) {
  const enabledKeys = JSON.stringify(resolved.map((r) => r.key));
  const cfgMap = {};
  for (const r of resolved) cfgMap[r.key] = r.cfg;
  const cfgJson = JSON.stringify(cfgMap, null, 2);
  return `// engine.js — moteur de prédiction généré automatiquement, restreint aux
// stratégies suivantes : ${resolved.map((r) => r.label).join(', ') || 'aucune'}.
// Reprend la même logique de détection/vérification que le bot principal
// (via strategies.js, recopié tel quel), sans les fonctionnalités
// multi-stratégies avancées (filtre double perte, déclencheur automatique,
// panneau « après perte ») — simplifications documentées dans le README.
'use strict';
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const api = require('./api');
const fmt = require('./formats');
const strategies = require('./strategies');

const ENABLED_KEYS = ${enabledKeys};
const STRATEGY_CONFIGS = ${cfgJson};

const BADGES = ['0⃣', '1⃣', '2⃣', '3⃣', '4⃣', '5⃣', '6⃣', '7⃣', '8⃣', '9⃣'];
const SUITS = strategies.SUITS;
const normSuit = strategies.normSuit;

const state = {
  games: new Map(),
  counters: { '♦️': 0, '❤️': 0, '♣️': 0, '♠️': 0 },
  predictions: [],
  triggersDone: {},
  freshFinished: [],
  history: [],
  live: null,
  lastFinished: null,
  lastError: null,
};

function handSuits(game) { return game ? strategies.suitsOf(game.playerSuits) : []; }
function hasSuit(game, suit) {
  const want = normSuit(suit);
  return !!want && handSuits(game).includes(want);
}

function maxFinishedNumber() {
  let max = 0;
  for (const g of state.games.values()) if (g.finished && g.number > max) max = g.number;
  return max;
}

function bumpCounters(round) {
  const b = (STRATEGY_CONFIGS.costume && STRATEGY_CONFIGS.costume.b) || config.DEFAULT_B;
  for (const s of SUITS) {
    if (hasSuit(round, s)) {
      state.counters[s] = state.counters[s] >= b ? 1 : state.counters[s] + 1;
      if (state.counters[s] > b) state.counters[s] = b;
    } else {
      state.counters[s] = 0;
    }
  }
}

function signatureOf(g) {
  return [
    (g.player || []).join(','), (g.banker || []).join(','),
    g.playerValue, g.bankerValue, g.winner || '',
  ].join('|');
}

function resetShoe() {
  state.games.clear();
  state.history = [];
  state.freshFinished = [];
  state.triggersDone = {};
  state.lastFinished = null;
  for (const s of SUITS) state.counters[s] = 0;
  for (const p of state.predictions) {
    if (p.status === 'en attente') { p.status = 'annulé'; p.badge = '♻️'; }
  }
}

function isNewShoe(incoming) {
  const maxDone = maxFinishedNumber();
  if (!maxDone || !incoming.length) return false;
  const numbers = incoming.map((g) => g.number).filter((n) => Number.isFinite(n));
  if (!numbers.length) return false;
  const minIn = Math.min(...numbers);
  const maxIn = Math.max(...numbers);
  if (maxIn + 10 < maxDone) return true;
  if (minIn <= 1 && maxDone > 10 && !state.games.has(1)) return true;
  for (const g of incoming) {
    const prev = state.games.get(g.number);
    if (!prev || !prev.finished) continue;
    if (!g.finished) return true;
    if (signatureOf(g) !== signatureOf(prev)) return true;
  }
  return false;
}

function detectLive() {
  const all = [...state.games.values()].sort((a, b) => a.number - b.number);
  const dealing = all.filter((g) => !g.finished && g.dealing);
  if (dealing.length) return dealing[0];
  const pending = all.filter((g) => !g.finished);
  if (pending.length) return pending[0];
  return state.lastFinished;
}

function onFinished(round) {
  state.lastFinished = round;
  state.history.unshift(round);
  state.history = state.history.slice(0, 200);
  bumpCounters(round);
  state.freshFinished.push(round);
  if (state.freshFinished.length > 20) state.freshFinished = state.freshFinished.slice(-20);
}

function registerGames(games) {
  if (isNewShoe(games)) resetShoe();
  const ordered = [...games].sort((a, b) => a.number - b.number);
  for (const g of ordered) {
    const prev = state.games.get(g.number);
    if (prev && prev.finished && prev.complete && !(g.finished && g.complete)) continue;
    if (prev && prev.complete && !g.complete) continue;
    state.games.set(g.number, g);
    if (g.finished && (!prev || !prev.finished)) onFinished(g);
  }
  if (state.games.size > 600) {
    const keys = [...state.games.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, state.games.size - 600)) state.games.delete(k);
  }
  const maxDone = maxFinishedNumber();
  if (maxDone && (!state.lastFinished || state.lastFinished.number !== maxDone)) {
    const g = state.games.get(maxDone);
    if (g) state.lastFinished = g;
  }
  state.live = detectLive();
  return state.live;
}

function evaluate() {
  const out = [];
  const fresh = state.freshFinished.length
    ? [...state.freshFinished].sort((a, b) => a.number - b.number)
    : (state.lastFinished ? [state.lastFinished] : []);
  state.freshFinished = [];
  const jobs = [];
  for (const key of ENABLED_KEYS) {
    const def = strategies.BY_KEY[key];
    const cfg = STRATEGY_CONFIGS[key];
    if (!def || !cfg) continue;
    if (def.source === 'live') { if (state.live) jobs.push([def, cfg, state.live]); }
    else { for (const g of fresh) jobs.push([def, cfg, g]); }
  }
  for (const [def, cfg, source] of jobs) {
    let hit = null;
    try { hit = def.detect(source, cfg, { counters: state.counters, games: state.games }); }
    catch (e) { state.lastError = \`\${def.key}: \${e.message}\`; continue; }
    if (!hit) continue;
    if (state.predictions.some((p) => p.strategy === def.key && p.target === hit.target)) continue;
    const trigKey = hit.trigger != null ? \`\${def.key}:\${hit.trigger}\` : null;
    if (trigKey && state.triggersDone[trigKey]) continue;
    if (hit.target <= maxFinishedNumber()) {
      if (trigKey) state.triggersDone[trigKey] = true;
      continue;
    }
    const pred = {
      id: \`\${def.key}-\${hit.target}-\${Date.now()}\`,
      strategy: def.key,
      strategyName: def.name,
      kind: hit.kind,
      target: hit.target,
      suit: hit.suit ? (hit.kind === 'suit' ? normSuit(hit.suit) : hit.suit) : null,
      // carte précise (rang+costume) — uniquement pour « Carte disparue →
      // retour banquier » (kind 'carte-banquier').
      card: hit.card || null,
      cardsLabel: hit.cardsLabel || null,
      wantPlayer: hit.wantPlayer != null ? hit.wantPlayer : null,
      wantBanker: hit.wantBanker != null ? hit.wantBanker : null,
      label: hit.label || hit.suit || '',
      reason: hit.reason || '',
      from: source.number,
      step: 0,
      maxR: cfg.maxR,
      counter: hit.counter != null ? hit.counter : null,
      b: cfg.b || 0,
      format: hit.format || cfg.format,
      template: cfg.template || null,
      sentAt: Date.now(),
      status: 'en attente',
      badge: null,
      result: null,
      hitNumber: null,
      game: null,
      messages: [],
    };
    if (trigKey) state.triggersDone[trigKey] = true;
    state.predictions.unshift(pred);
    out.push(pred);
  }
  return out;
}

function parityOf(game) {
  if (!game || game.playerValue == null) return null;
  return game.playerValue % 2 === 0 ? 'pair' : 'impair';
}

function matches(pred, game) {
  if (!game) return false;
  if (pred.kind === 'parity') {
    const par = parityOf(game);
    return !!par && par === pred.suit;
  }
  if (pred.kind === 'cards') {
    if (pred.wantPlayer != null && game.playerCards !== pred.wantPlayer) return false;
    if (pred.wantBanker != null && game.bankerCards !== pred.wantBanker) return false;
    return true;
  }
  // « Carte disparue → retour banquier » : carte exacte chez le BANQUIER.
  if (pred.kind === 'carte-banquier') {
    return (game.banker || []).includes(pred.card);
  }
  return hasSuit(game, pred.suit);
}

function resultText(pred, game) {
  if (!game) return null;
  if (pred.kind === 'parity') return \`joueur \${game.playerValue ?? '—'} (\${parityOf(game) || '—'})\`;
  if (pred.kind === 'cards') return \`joueur \${game.playerCards}/banquier \${game.bankerCards}\`;
  if (pred.kind === 'carte-banquier') return \`banquier \${(game.banker || []).join(' ') || '—'}\`;
  return handSuits(game).join(' ');
}

function verify() {
  const closed = [];
  const maxDone = maxFinishedNumber();
  const queue = [...state.predictions].sort((a, b) => a.target - b.target);
  for (const p of queue) {
    if (p.status !== 'en attente') continue;
    let guard = 0;
    if (p.gap == null) p.gap = 0;
    while (p.status === 'en attente' && guard++ <= p.maxR + p.gap + 8) {
      const num = p.target + p.step + p.gap;
      const g = state.games.get(num);
      const usable = !!g && g.finished && g.complete !== false;
      if (!usable) {
        if (num + 2 <= maxDone) {
          p.gap += 1;
          p.skipped = (p.skipped || 0) + 1;
          if (p.skipped > 6) {
            p.status = 'annulé'; p.badge = '♻️'; p.result = 'tours non lus dans le flux';
            closed.push(p); break;
          }
          continue;
        }
        break;
      }
      if (matches(p, g)) {
        p.status = 'gagné'; p.badge = BADGES[p.step] || \`\${p.step}\`;
        p.result = resultText(p, g); p.hitNumber = num; p.game = g;
        closed.push(p); break;
      }
      if (p.step >= p.maxR) {
        p.status = 'perdu'; p.badge = '❌';
        p.result = resultText(p, g); p.hitNumber = num; p.game = g;
        closed.push(p); break;
      }
      p.step += 1;
    }
  }
  return closed;
}

function predictionText(p) {
  return fmt.renderMessage(p.format || config.DEFAULT_FORMAT, {
    gameNumber: p.target,
    suit: p.suit,
    cardsLabel: p.cardsLabel,
    strategy: p.strategyName || p.strategy,
    maxR: p.maxR != null ? p.maxR : config.DEFAULT_MAX_R,
    status: p.status,
    rattrapage: p.step,
    playerCards: p.game ? p.game.player : null,
  }, p.template || null);
}

// --- Telegram ---------------------------------------------------------------
let sender = null;
let senderToken = null;
function getSender() {
  const token = config.BOT_TOKEN;
  if (!token) return null;
  if (sender && senderToken === token) return sender;
  try { sender = new TelegramBot(token, { polling: false }); senderToken = token; }
  catch (e) { state.lastError = \`Token Telegram invalide : \${e.message}\`; sender = null; }
  return sender;
}

async function sendPrediction(pred) {
  const s = getSender();
  const channel = config.CHANNEL_ID;
  if (!s || !channel) return;
  const { text, parse_mode } = predictionText(pred);
  try {
    const m = await s.sendMessage(channel, text, parse_mode ? { parse_mode } : {});
    pred.messages.push({ chatId: channel, messageId: m.message_id });
  } catch (e) { state.lastError = \`Envoi Telegram : \${e.message}\`; }
}

async function updateResult(pred) {
  const s = getSender();
  if (!s) return;
  const { text, parse_mode } = predictionText(pred);
  for (const m of pred.messages) {
    try {
      await s.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId, ...(parse_mode ? { parse_mode } : {}) });
    } catch (_) {
      try { await s.sendMessage(m.chatId, text, parse_mode ? { parse_mode } : {}); } catch (_) {}
    }
  }
}

// --- boucle de scrutation -----------------------------------------------
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const games = await api.fetchGames();
    state.lastError = null;
    registerGames(games);
    const closed = verify();
    for (const p of closed) await updateResult(p);
    const preds = evaluate();
    for (const p of preds) await sendPrediction(p);
  } catch (e) {
    state.lastError = e.message;
  } finally {
    ticking = false;
  }
}

let loopHandle = null;
function startLoop() {
  if (loopHandle) return;
  loopHandle = setInterval(tick, config.POLL_INTERVAL_MS);
  tick();
}
function stopLoop() {
  if (loopHandle) { clearInterval(loopHandle); loopHandle = null; }
}

function status() {
  return {
    running: !!loopHandle,
    tokenSet: !!config.BOT_TOKEN,
    channelSet: !!config.CHANNEL_ID,
    strategies: ENABLED_KEYS.map((k) => (strategies.BY_KEY[k] || {}).name || k),
    liveNumber: state.live ? state.live.number : null,
    lastFinishedNumber: state.lastFinished ? state.lastFinished.number : null,
    lastError: state.lastError,
    predictionsCount: state.predictions.length,
    lastPredictions: state.predictions.slice(0, 10).map((p) => ({
      strategy: p.strategyName, target: p.target, suit: p.suit, status: p.status,
    })),
  };
}

module.exports = { startLoop, stopLoop, status, tick };
`;
}

function buildServerJs() {
  return `// server.js — site de configuration minimal (AUCUN compte, AUCUNE
// connexion) : une seule page pour saisir le token API Telegram et l'ID du
// canal, puis le bot démarre automatiquement.
'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const store = require('./store');
const engine = require('./engine');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/settings', (req, res) => {
  const s = store.read();
  const token = s.botToken || '';
  res.json({
    botToken: token ? token.slice(0, 8) + '••••••' + token.slice(-4) : '',
    channelId: s.channelId || '',
    configured: !!(config.BOT_TOKEN && config.CHANNEL_ID),
  });
});

app.post('/api/settings', (req, res) => {
  const botToken = String((req.body && req.body.botToken) || '').trim();
  const channelId = String((req.body && req.body.channelId) || '').trim();
  if (!botToken || !channelId) return res.status(400).json({ error: 'Le token et l’ID du canal sont requis.' });
  store.write({ botToken, channelId });
  engine.startLoop();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => res.json(engine.status()));

app.listen(config.PORT, () => {
  console.log(\`Bot déployé — écoute sur le port \${config.PORT}\`);
  if (config.BOT_TOKEN && config.CHANNEL_ID) engine.startLoop();
});
`;
}

function buildPublicHtml(resolved) {
  const names = resolved.map((r) => r.label).join(', ') || 'Aucune stratégie';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bot Baccara — Configuration</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#f2f2f2;margin:0;padding:24px}
  .card{max-width:480px;margin:0 auto;background:#171a21;border-radius:14px;padding:24px;box-shadow:0 6px 24px rgba(0,0,0,.4)}
  h1{font-size:20px;margin:0 0 4px}
  p.small{color:#9aa0aa;font-size:13px;line-height:1.5}
  label{display:block;margin:16px 0 6px;font-size:13px;color:#c7cbd4}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2b2f3a;background:#0f1115;color:#fff;font-size:14px}
  button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;background:#6a5cff;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .status{margin-top:22px;padding:14px;border-radius:10px;background:#11141b;font-size:13px;line-height:1.7}
  .tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;margin-left:6px}
  .good{background:#123b23;color:#59d98e}
  .bad{background:#3b1212;color:#ff8080}
  .toast{margin-top:12px;font-size:13px;color:#ffb84d}
</style>
</head>
<body>
  <div class="card">
    <h1>Bot Baccara</h1>
    <p class="small">Stratégie${resolved.length > 1 ? 's' : ''} incluse${resolved.length > 1 ? 's' : ''} dans ce déploiement : <b>${names}</b>. Renseigne le token de ton bot Telegram (via @BotFather) et l'ID (ou @nom) du canal où envoyer les prédictions.</p>
    <label>Token API Telegram</label>
    <input id="botToken" type="password" autocomplete="off" placeholder="123456:AAExemple...">
    <label>ID ou @nom du canal</label>
    <input id="channelId" type="text" autocomplete="off" placeholder="-1001234567890">
    <button id="saveBtn" onclick="save()">Enregistrer et démarrer</button>
    <div class="toast" id="toast"></div>
    <div class="status" id="status">Chargement…</div>
  </div>
<script>
  async function load() {
    const r = await fetch('/api/settings').then(r => r.json());
    document.getElementById('channelId').value = r.channelId || '';
    document.getElementById('botToken').placeholder = r.botToken || '123456:AAExemple...';
  }
  async function save() {
    const botToken = document.getElementById('botToken').value.trim();
    const channelId = document.getElementById('channelId').value.trim();
    const toast = document.getElementById('toast');
    if (!botToken || !channelId) { toast.textContent = 'Renseigne le token ET le canal.'; return; }
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botToken, channelId }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur');
      toast.style.color = '#59d98e';
      toast.textContent = 'Enregistré — le bot démarre.';
      document.getElementById('botToken').value = '';
      load(); refresh();
    } catch (e) { toast.style.color = '#ff8080'; toast.textContent = e.message; }
    finally { btn.disabled = false; }
  }
  async function refresh() {
    try {
      const s = await fetch('/api/status').then(r => r.json());
      const box = document.getElementById('status');
      box.innerHTML =
        '<div>État : <span class="tag ' + (s.running ? 'good' : 'bad') + '">' + (s.running ? 'actif' : 'à l’arrêt') + '</span></div>' +
        '<div>Stratégies : ' + (s.strategies || []).join(', ') + '</div>' +
        '<div>Tour live : #N' + (s.liveNumber ?? '—') + ' · dernier terminé : #N' + (s.lastFinishedNumber ?? '—') + '</div>' +
        '<div>Prédictions suivies : ' + (s.predictionsCount || 0) + '</div>' +
        (s.lastError ? '<div style="color:#ff8080">⚠️ ' + s.lastError + '</div>' : '');
    } catch (_) {}
  }
  load(); refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>
`;
}

function buildPackageJson(slug) {
  return JSON.stringify({
    name: slug,
    version: '1.0.0',
    private: true,
    engines: { node: '>=20' },
    scripts: { start: 'node server.js' },
    dependencies: {
      express: '^4.19.2',
      'node-telegram-bot-api': '^0.66.0',
    },
  }, null, 2) + '\n';
}

function buildRenderYaml(slug) {
  return `services:
  - type: web
    name: ${slug}
    env: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    healthCheckPath: /health
    envVars:
      - key: BOT_TOKEN
        sync: false
      - key: CHANNEL_ID
        sync: false
`;
}

function buildReadme(resolved, slug) {
  const names = resolved.map((r) => `- ${r.label}`).join('\n') || '- (aucune)';
  return `# ${slug}

Bot Telegram autonome généré automatiquement, restreint aux stratégies
suivantes :

${names}

Aucun compte ni connexion : une seule page (accessible dès le démarrage)
permet de renseigner le **token API Telegram** (créé via @BotFather) et
l'**ID ou @nom du canal** où publier les prédictions.

## Déploiement (n'importe quelle plateforme Node ≥ 20)

1. Décompresser ce ZIP et pousser son contenu sur un dépôt Git (ou l'importer
   directement si la plateforme le permet).
2. Créer un nouveau service web Node sur la plateforme choisie :
   - Render : utiliser directement \`render.yaml\` fourni (Blueprint).
   - Railway / Fly.io / VPS : commande de build \`npm install\`, commande de
     démarrage \`npm start\`.
3. Une fois déployé, ouvrir l'URL du service : la page de configuration
   s'affiche automatiquement.
4. Renseigner le token du bot et l'ID du canal, cliquer sur « Enregistrer et
   démarrer ». Le bot commence aussitôt à scruter les tours et à publier ses
   prédictions.

## Persistance de la configuration

Le token et le canal sont enregistrés dans un fichier local
(\`settings.json\`). Sur une plateforme SANS disque persistant (ex. Render
plan gratuit), ce fichier est réinitialisé à chaque redéploiement — dans ce
cas, définir aussi les variables d'environnement \`BOT_TOKEN\` et
\`CHANNEL_ID\` dans les réglages de la plateforme garantit une configuration
qui survit à un redéploiement (elles sont prioritaires sur le fichier local).

## Limites volontaires de ce paquet

Pour rester simple et autonome, ce déploiement NE reproduit PAS :
- le filtre « double perte » / mode silencieux (réservé à la stratégie
  « Prédiction dans l'ombre » dans le bot principal) ;
- le déclencheur automatique « perte/rattrapage + N » ;
- le panneau « Prédiction après perte » ;
- le tableau de bord complet (comptes, statistiques avancées, IA…).

Chaque prédiction détectée est envoyée directement dans le canal configuré.
`;
}

// ---------------------------------------------------------------------------
// Construction du ZIP (entièrement en mémoire, aucune écriture sur disque).
// ---------------------------------------------------------------------------
function buildZipStream(selection) {
  const resolved = resolveSelection(selection);
  if (!resolved.length) {
    const err = new Error('Aucune stratégie valide sélectionnée.');
    err.code = 'EMPTY_SELECTION';
    throw err;
  }
  const slug = slugFor(resolved);
  const archive = archiver('zip', { zlib: { level: 9 } });

  for (const f of ['api.js', 'strategies.js', 'formats.js', 'tg-formats.js']) {
    archive.append(fs.createReadStream(path.join(__dirname, f)), { name: f });
  }
  archive.append(buildConfigJs(), { name: 'config.js' });
  archive.append(buildStoreJs(), { name: 'store.js' });
  archive.append(buildEngineJs(resolved), { name: 'engine.js' });
  archive.append(buildServerJs(), { name: 'server.js' });
  archive.append(buildPublicHtml(resolved), { name: 'public/index.html' });
  archive.append(buildPackageJson(slug), { name: 'package.json' });
  archive.append(buildRenderYaml(slug), { name: 'render.yaml' });
  archive.append(buildReadme(resolved, slug), { name: 'README.md' });
  archive.append('node_modules/\nsettings.json\n.env\n', { name: '.gitignore' });
  archive.finalize();

  return { archive, slug, resolved };
}

module.exports = { listSelectable, resolveSelection, buildZipStream };
