// analyse-manque.js — bouton « Analyse manque » (demande admin, v133).
//
// Surveille la main du JOUEUR : quand un costume (❤️ ♠️ ♦️ ♣️) manque 4 jeux de suite (seuil réglable), un message
// « 🚨 ALERTE JOUEUR » part ; quand il revient, un message « ✅ RÉAPPARITION JOUEUR » indique combien de jeux il a manqué.
//   🚨 ALERTE JOUEUR - Jeu N°314 🚨 / N311: ♠️ ♦️ | N312: … / Carte(s) disparue(s): ♥️ / 🔴 Disparition commencée au Jeu N°314
//   ✅ RÉAPPARITION JOUEUR ✅ / ♥️ : Disparue au N°314 -> Revenue au N°316 (manqué 5 jeux) / Jeu actuel: N°316 -> ♥️ ♣️
// v138 : à chaque RÉAPPARITION, le bot regarde aussi la RÉPARTITION des cartes du jeu où le costume revient et signale un 2/3
// (joueur 2 cartes, banquier 3 cartes) ou un NUL (égalité) dans le message de réapparition. Rien d'autre n'est analysé pour ce signal.
// Les messages sont reçus par le bot dont on saisit l'API token sur la page, dans SON CHAT PRIVÉ (la personne qui a écrit /start à ce bot,
// administrateur du site ou non — détecté automatiquement). Token laissé vide = bot principal du site. Un ID de chat / canal peut
// aussi être imposé. Désactivé par défaut. Un nouveau sabot remet tout à zéro.
'use strict';

const store = require('./store');
const db = require('./db');
const predictor = require('./predictor');

const SUITS = ['♠️', '♥️', '♦️', '♣️']; // ordre d'affichage
const DEFAULT_THRESHOLD = 4;
const MAX_LOG = 40;
const MAX_RECENT = 12;

const panel = {
  enabled: false,
  token: '',      // API token du bot qui reçoit les alertes (vide = bot principal du site)
  botName: '',
  chatId: '',     // ID imposé (facultatif)
  privateChatId: '', // chat privé détecté après /start
  threshold: DEFAULT_THRESHOLD,
  log: [],        // { at, kind: 'alerte'|'retour', suits, number, sent }
  open: {},       // suit → { alertGame, since } (alertes envoyées, en attente de réapparition)
  lastError: null,
};
let counters = null;   // suit → { count, since }
let recent = [];       // [{ number, suits: [..] }] du plus ancien au plus récent
let lastNumber = null;
const silent = {};     // suit → true : déjà au seuil au démarrage, jamais signalé (pas de message de retour)

// ---------------------------------------------------------------------------
// Persistance (data.json + base)
// ---------------------------------------------------------------------------
function persist() {
  const saved = { enabled: panel.enabled, token: panel.token, botName: panel.botName, chatId: panel.chatId, privateChatId: panel.privateChatId, threshold: panel.threshold, open: panel.open, log: panel.log.slice(-MAX_LOG) };
  try { store.patch({ analyseManque: saved }); } catch (_) {}
  if (db.ready) db.setSetting('analyse_manque_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(s) {
  if (!s || typeof s !== 'object') return;
  panel.enabled = s.enabled === true;
  panel.token = typeof s.token === 'string' ? s.token.trim() : '';
  panel.botName = typeof s.botName === 'string' ? s.botName : '';
  panel.chatId = s.chatId != null ? String(s.chatId).trim() : '';
  panel.privateChatId = s.privateChatId != null ? String(s.privateChatId).trim() : '';
  const th = Math.round(Number(s.threshold));
  panel.threshold = Number.isFinite(th) && th >= 2 && th <= 50 ? th : DEFAULT_THRESHOLD;
  panel.open = s.open && typeof s.open === 'object' ? s.open : {};
  panel.log = (Array.isArray(s.log) ? s.log : []).filter((x) => x && x.kind).slice(-MAX_LOG);
}
function restore() { try { const s = (store.read() || {}).analyseManque; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting('analyse_manque_state'); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}
// export / import de la configuration : le jeton n'en fait JAMAIS partie
function config() { return { enabled: panel.enabled, threshold: panel.threshold }; }
function configure() { persist(); }

// ---------------------------------------------------------------------------
// Lecture des cartes (main du joueur)
// ---------------------------------------------------------------------------
function normSuit(s) {
  const raw = String(s == null ? '' : s).replace(/\uFE0F/g, '').trim();
  if (raw === '♥' || raw === '❤') return '♥️';
  if (raw === '♦') return '♦️';
  if (raw === '♣') return '♣️';
  if (raw === '♠') return '♠️';
  return null;
}
function playerSuits(r) {
  const list = r && (r.playerSuits || r.player_suits);
  const set = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) { const s = normSuit(raw); if (s) set.add(s); }
  return SUITS.filter((s) => set.has(s));
}
const numberOf = (r) => Number(r && (r.number != null ? r.number : r.n));
// répartition des cartes d'un jeu terminé : '2/3' (joueur 2 cartes, banquier 3 cartes), 'nul' (égalité) ou null (rien à signaler)
const cardCount = (v) => (Array.isArray(v) ? v.length : (Number.isFinite(Number(v)) ? Number(v) : 0));
function distributionOf(r) {
  if (!r) return null;
  const p = cardCount(r.playerCards); const b = cardCount(r.bankerCards);
  const pv = r.playerValue; const bv = r.bankerValue;
  const tie = r.winner === 'Égalité' || (pv != null && bv != null && pv === bv);
  if (tie) return { kind: 'nul', p, b };
  if (p === 2 && b === 3) return { kind: '2/3', p, b };
  return null;
}
const emptyCounters = () => Object.fromEntries(SUITS.map((s) => [s, { count: 0, since: null }]));

function fullReset() {
  counters = emptyCounters(); recent = []; lastNumber = null;
  for (const k of Object.keys(silent)) delete silent[k];
  panel.open = {};
}

// premier appel après un démarrage : séries en cours reconstruites depuis l'historique (le plus récent en premier)
function seedFromHistory(history) {
  counters = emptyCounters();
  const games = (Array.isArray(history) ? history : []).filter((r) => r && Number.isFinite(numberOf(r)) && playerSuits(r).length);
  for (const suit of SUITS) {
    let count = 0; let since = null;
    for (const g of games) {
      if (playerSuits(g).includes(suit)) break;
      count += 1; since = numberOf(g);
    }
    counters[suit] = { count, since };
    if (count >= panel.threshold && !panel.open[suit]) silent[suit] = true; // déjà au seuil sans alerte envoyée : pas de faux « retour »
    if (count < panel.threshold) delete panel.open[suit];
  }
  recent = games.slice(0, MAX_RECENT).reverse().map((g) => ({ number: numberOf(g), suits: playerSuits(g) }));
  lastNumber = games.length ? numberOf(games[0]) : null;
}

// ---------------------------------------------------------------------------
// Envoi par le bot dédié (API Telegram directe)
// ---------------------------------------------------------------------------
let sender = null;
let adminIdFn = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
function setAdminId(fn) { adminIdFn = typeof fn === 'function' ? fn : null; }
const siteBot = () => (sender ? sender() : null);

// appel direct à l'API Telegram avec le token saisi sur la page
async function tg(method, body, token) {
  const tk = token || panel.token;
  if (!tk) throw new Error('API token non renseigné.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${tk}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctl.signal });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || `Telegram HTTP ${res.status}`);
    return j.result;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Telegram ne répond pas (20 s).' : e.message);
  } finally { clearTimeout(timer); }
}

// chat privé du bot : la dernière personne qui lui a écrit (/start), qu'elle soit administrateur du site ou non
async function detectChat() {
  const ups = await tg('getUpdates', { limit: 100, allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
  const chats = [];
  for (const u of (Array.isArray(ups) ? ups : []).reverse()) {
    const c = (u.message && u.message.chat) || (u.channel_post && u.channel_post.chat) || (u.my_chat_member && u.my_chat_member.chat);
    if (c && c.id != null && !chats.some((x) => x.id === c.id)) chats.push({ id: c.id, title: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id), type: c.type });
  }
  if (!chats.length) throw new Error('Aucun chat trouvé : ouvre le bot dans Telegram, écris-lui /start, puis clique « Détecter ».');
  const priv = chats.find((c) => c.type === 'private') || chats[0];
  panel.privateChatId = String(priv.id);
  persist();
  return { chat: priv, chats };
}

async function send(text) {
  try {
    if (panel.token) { // bot saisi sur la page → chat privé (ou ID imposé)
      let to = panel.chatId || panel.privateChatId;
      if (!to) { try { await detectChat(); to = panel.privateChatId; } catch (e) { panel.lastError = e.message; return false; } }
      try { await tg('sendMessage', { chat_id: to, text, parse_mode: 'HTML' }); }
      catch (e) {
        if (!panel.chatId && /chat not found|blocked|deactivated/i.test(e.message)) { panel.privateChatId = ''; persist(); }
        throw e;
      }
      panel.lastError = null; return true;
    }
    // aucun token saisi : bot principal du site, vers le chat imposé ou l'administrateur
    const bot = siteBot();
    if (!bot) { panel.lastError = 'API token non renseigné (et aucun token configuré sur le site).'; return false; }
    const to = panel.chatId || (adminIdFn ? adminIdFn() : '') || '';
    if (!to) { panel.lastError = 'Aucun destinataire : saisis l\'API token d\'un bot puis écris-lui /start.'; return false; }
    const raw = bot.sendMessageUnguarded || bot.sendMessage.bind(bot);
    await raw(to, text, { parse_mode: 'HTML' });
    panel.lastError = null;
    return true;
  } catch (e) { panel.lastError = e.message; return false; }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
const LINE = '━━━━━━━━━━━━━━━';
const plural = (n, w) => `${n} ${w}${n > 1 ? 'x' : ''}`;
function buildAlert(number, suits) {
  // pour chaque costume : début réel de la disparition (le 1er jeu où il manque), pas le jeu où le seuil est atteint
  const lines = suits.map((s) => { const c = counters[s] || {}; const since = c.since != null ? c.since : number; const n = c.count || panel.threshold;
    return `❌ <b>Carte disparue :</b>  ${s}\n🔴 Disparition commencée au <b>Jeu N°${since}</b>\n📊 Absente <b>${n} fois</b> de suite : du <b>N°${since}</b> au <b>N°${number}</b>`; }).join('\n\n');
  const rows = recent.slice(-panel.threshold).map((g) => `▫️ N°${g.number}  ➜  ${g.suits.join(' ')}`).join('\n');
  return `🚨 <b>ALERTE JOUEUR</b> 🚨\n${LINE}\n🎯 <b>Jeu N°${number}</b>\n${LINE}\n\n` +
    `🎴 <b>Derniers jeux</b> (main du joueur)\n${rows}\n\n` +
    `${lines}\n\n` +
    `🔕 <i>Plus aucun message jusqu'à la réapparition.</i>`;
}
function buildReturn(number, returned, nowSuits, dist) {
  const blocks = returned.map((r) => `${r.suit} <b>est de retour !</b>\n   ├ Disparue au N°${r.since}\n   ├ Absente du N°${r.since} au N°${r.lastAbsent} (${r.missed} fois)\n   ├ Revenue au N°${number}\n   └ Manqué <b>${plural(r.missed, 'jeu')}</b>`).join('\n\n');
  return `✅ <b>RÉAPPARITION JOUEUR</b> ✅\n${LINE}\n🎯 <b>Jeu N°${number}</b>\n${LINE}\n\n${blocks}\n\n` +
    `🎴 <b>Jeu actuel</b> N°${number}  ➜  ${nowSuits.join(' ')}` + buildDistribution(dist);
}
// ligne ajoutée au message de réapparition quand le jeu est un 2/3 ou un nul
function buildDistribution(dist) {
  if (!dist) return '';
  if (dist.kind === '2/3') return `\n\n🃏 <b>RÉPARTITION 2/3</b> — joueur 2 cartes · banquier 3 cartes`;
  const sc = (dist.p === 2 || dist.p === 3) && (dist.b === 2 || dist.b === 3) ? ` (joueur ${dist.p} cartes · banquier ${dist.b} cartes)` : '';
  return `\n\n🤝 <b>MATCH NUL</b>${sc}`;
}

// ---------------------------------------------------------------------------
// Chaque jeu terminé (appelé par bot.js via setOnFinished)
// ---------------------------------------------------------------------------
async function onFinished(round) {
  try {
    if (!round || round.finished === false) return;
    const number = numberOf(round);
    if (!Number.isFinite(number)) return;
    if (!counters) { seedFromHistory(predictor.state.history); return; } // l'historique contient déjà ce jeu
    if (lastNumber != null && number <= lastNumber) { fullReset(); persist(); } // numérotation repartie de 1 : nouveau sabot
    const now = playerSuits(round);
    if (!now.length) return; // cartes illisibles : jeu ignoré
    const prevNumber = lastNumber;
    lastNumber = number;
    recent.push({ number, suits: now });
    if (recent.length > MAX_RECENT) recent = recent.slice(-MAX_RECENT);

    const returned = []; const fresh = [];
    for (const suit of SUITS) {
      const c = counters[suit];
      if (now.includes(suit)) {
        const open = panel.open[suit];
        if (open) returned.push({ suit, alertGame: open.alertGame, since: open.since, lastAbsent: prevNumber != null ? prevNumber : number - 1, missed: c.count });
        delete panel.open[suit]; delete silent[suit];
        c.count = 0; c.since = null;
        continue;
      }
      c.count += 1;
      if (c.since == null) c.since = number;
      if (c.count >= panel.threshold && !panel.open[suit] && !silent[suit]) { panel.open[suit] = { alertGame: number, since: c.since }; fresh.push(suit); }
    }
    const dist = returned.length ? distributionOf(round) : null; // répartition regardée uniquement au niveau d'une réapparition
    let changed = returned.length > 0 || fresh.length > 0;
    if (panel.enabled) {
      if (returned.length) { const ok = await send(buildReturn(number, returned, now, dist)); panel.log.push({ at: Date.now(), kind: 'retour', suits: returned.map((r) => r.suit), number, sent: ok, dist: dist ? dist.kind : null }); }
      if (fresh.length) { const ok = await send(buildAlert(number, fresh)); panel.log.push({ at: Date.now(), kind: 'alerte', suits: fresh, number, sent: ok }); }
    }
    if (changed) { panel.log = panel.log.slice(-MAX_LOG); persist(); }
  } catch (e) { panel.lastError = e.message; }
}

if (typeof predictor.setOnShoeReset === 'function') predictor.setOnShoeReset(() => { fullReset(); persist(); });

// ---------------------------------------------------------------------------
// Réglages (site)
// ---------------------------------------------------------------------------
async function setToken(v) {
  const tk = String(v == null ? '' : v).trim();
  if (!tk) { panel.token = ''; panel.botName = ''; panel.privateChatId = ''; persist(); return ''; }
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(tk)) throw new Error('API token invalide : format attendu 123456789:AAxxxxxxxx… (donné par @BotFather).');
  const me = await tg('getMe', {}, tk).catch((e) => { throw new Error(`Token refusé par Telegram : ${e.message}`); });
  if (tk !== panel.token) panel.privateChatId = ''; // autre bot : l'ancien chat privé ne vaut plus
  panel.token = tk; panel.botName = me && me.username ? `@${me.username}` : '';
  panel.lastError = null;
  persist();
  return panel.botName;
}
function setChatId(v) {
  const s = String(v == null ? '' : v).trim();
  if (s && !/^(-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{3,})$/.test(s)) throw new Error('ID invalide : un nombre (ex. 123456789 ou -1001234567890) ou @nom_du_canal.');
  panel.chatId = s; persist(); return panel.chatId;
}
function setThreshold(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 2 || n > 50) throw new Error('Seuil invalide : entre 2 et 50 jeux.');
  panel.threshold = n; persist(); return n;
}
function setEnabled(on) { panel.enabled = !!on; persist(); return panel.enabled; }

async function testAlert() {
  const ok = await send(`🧪 <b>Test — Analyse manque</b>\nAlerte quand un costume manque ${panel.threshold} jeux de suite (main du joueur) ; à la réapparition, signale aussi un 2/3 ou un nul.`);
  return { ok, error: ok ? null : panel.lastError };
}

function status() {
  if (!counters) seedFromHistory(predictor.state.history);
  const tk = panel.token;
  const dest = panel.chatId || (tk ? panel.privateChatId : (adminIdFn ? adminIdFn() : '')) || '';
  return {
    enabled: panel.enabled, threshold: panel.threshold, chatId: panel.chatId, privateChatId: panel.privateChatId, target: String(dest),
    ownToken: !!tk, tokenSet: !!tk || !!siteBot(), botName: panel.botName,
    tokenHint: tk ? `${tk.split(':')[0]}:••••${tk.slice(-4)}` : '',
    lastGame: lastNumber,
    suits: SUITS.map((suit) => ({ suit, count: counters[suit].count, since: counters[suit].since, open: panel.open[suit] || null })),
    recent: recent.slice(-panel.threshold),
    log: panel.log.slice().reverse().slice(0, 15), lastError: panel.lastError,
  };
}

module.exports = {
  panel, config, configure, restore, restoreFromDb, persist, onFinished, status,
  setSender, setAdminId, setToken, setChatId, setThreshold, setEnabled, detectChat, testAlert, buildAlert, buildReturn, distributionOf,
};
