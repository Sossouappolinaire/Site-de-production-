// analyse-manque.js — bouton « Analyse manque » (demande admin, v133).
//
// Surveille la main du JOUEUR : quand un costume (❤️ ♠️ ♦️ ♣️) manque 4 jeux de suite (seuil réglable), un message
// « 🚨 ALERTE JOUEUR » part ; quand il revient, un message « ✅ RÉAPPARITION JOUEUR » indique combien de jeux il a manqué.
//   🚨 ALERTE JOUEUR - Jeu N°314 🚨 / N311: ♠️ ♦️ | N312: … / Carte(s) disparue(s): ♥️ / 🔴 Disparition commencée au Jeu N°314
//   ✅ RÉAPPARITION JOUEUR ✅ / ♥️ : Disparue au N°314 -> Revenue au N°316 (manqué 5 jeux) / Jeu actuel: N°316 -> ♥️ ♣️
// Les messages partent avec le MÊME token que le reste du site (bot principal) ; seul l'ID du chat / canal destinataire se règle sur la page
// (vide = chat privé de l'administrateur). Désactivé par défaut. Un nouveau sabot remet tout à zéro.
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
  chatId: '',
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
  const saved = { enabled: panel.enabled, chatId: panel.chatId, threshold: panel.threshold, open: panel.open, log: panel.log.slice(-MAX_LOG) };
  try { store.patch({ analyseManque: saved }); } catch (_) {}
  if (db.ready) db.setSetting('analyse_manque_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(s) {
  if (!s || typeof s !== 'object') return;
  panel.enabled = s.enabled === true;
  panel.chatId = s.chatId != null ? String(s.chatId).trim() : '';
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
const target = () => panel.chatId || (adminIdFn ? adminIdFn() : '') || '';
async function send(text) {
  try {
    const bot = sender ? sender() : null;
    if (!bot) { panel.lastError = 'Aucun token Telegram configuré sur le site (page Envois / réglages du bot).'; return false; }
    const to = target();
    if (!to) { panel.lastError = 'Aucun destinataire : renseigne un ID de chat / canal (ou ADMIN_ID pour ton chat privé).'; return false; }
    const raw = bot.sendMessageUnguarded || bot.sendMessage.bind(bot); // jamais bloqué par le garde de canaux
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
  const rows = recent.slice(-panel.threshold).map((g) => `▫️ N°${g.number}  ➜  ${g.suits.join(' ')}`).join('\n');
  return `🚨 <b>ALERTE JOUEUR</b> 🚨\n${LINE}\n🎯 <b>Jeu N°${number}</b>\n${LINE}\n\n` +
    `🎴 <b>Derniers jeux</b> (main du joueur)\n${rows}\n\n` +
    `❌ <b>Carte disparue :</b>  ${suits.join(' ')}\n` +
    `🔴 Disparition commencée au <b>Jeu N°${number}</b>\n\n` +
    `🔕 <i>Plus aucun message jusqu'à la réapparition.</i>`;
}
function buildReturn(number, returned, nowSuits) {
  const blocks = returned.map((r) => `${r.suit} <b>est de retour !</b>\n   ├ Disparue au N°${r.alertGame}\n   ├ Revenue au N°${number}\n   └ Manqué <b>${plural(r.missed, 'jeu')}</b>`).join('\n\n');
  return `✅ <b>RÉAPPARITION JOUEUR</b> ✅\n${LINE}\n🎯 <b>Jeu N°${number}</b>\n${LINE}\n\n${blocks}\n\n` +
    `🎴 <b>Jeu actuel</b> N°${number}  ➜  ${nowSuits.join(' ')}`;
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
    lastNumber = number;
    recent.push({ number, suits: now });
    if (recent.length > MAX_RECENT) recent = recent.slice(-MAX_RECENT);

    const returned = []; const fresh = [];
    for (const suit of SUITS) {
      const c = counters[suit];
      if (now.includes(suit)) {
        const open = panel.open[suit];
        if (open) returned.push({ suit, alertGame: open.alertGame, missed: number - open.since });
        delete panel.open[suit]; delete silent[suit];
        c.count = 0; c.since = null;
        continue;
      }
      c.count += 1;
      if (c.since == null) c.since = number;
      if (c.count >= panel.threshold && !panel.open[suit] && !silent[suit]) { panel.open[suit] = { alertGame: number, since: c.since }; fresh.push(suit); }
    }
    let changed = returned.length > 0 || fresh.length > 0;
    if (panel.enabled) {
      if (returned.length) { const ok = await send(buildReturn(number, returned, now)); panel.log.push({ at: Date.now(), kind: 'retour', suits: returned.map((r) => r.suit), number, sent: ok }); }
      if (fresh.length) { const ok = await send(buildAlert(number, fresh)); panel.log.push({ at: Date.now(), kind: 'alerte', suits: fresh, number, sent: ok }); }
    }
    if (changed) { panel.log = panel.log.slice(-MAX_LOG); persist(); }
  } catch (e) { panel.lastError = e.message; }
}

if (typeof predictor.setOnShoeReset === 'function') predictor.setOnShoeReset(() => { fullReset(); persist(); });

// ---------------------------------------------------------------------------
// Réglages (site)
// ---------------------------------------------------------------------------
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
  const ok = await send(`🧪 <b>Test — Analyse manque</b>\nAlerte quand un costume manque ${panel.threshold} jeux de suite (main du joueur).`);
  return { ok, error: ok ? null : panel.lastError };
}

function status() {
  if (!counters) seedFromHistory(predictor.state.history);
  return {
    enabled: panel.enabled, threshold: panel.threshold, chatId: panel.chatId, target: String(target() || ''), tokenSet: !!(sender && sender()),
    lastGame: lastNumber,
    suits: SUITS.map((suit) => ({ suit, count: counters[suit].count, since: counters[suit].since, open: panel.open[suit] || null })),
    recent: recent.slice(-panel.threshold),
    log: panel.log.slice().reverse().slice(0, 15), lastError: panel.lastError,
  };
}

module.exports = {
  panel, config, configure, restore, restoreFromDb, persist, onFinished, status,
  setSender, setAdminId, setChatId, setThreshold, setEnabled, testAlert, buildAlert, buildReturn,
};
