// absence-alert.js — « Alerte absence de costume » (demande admin).
//
// Compte, pour chacun des 4 costumes (❤️ ♠️ ♦️ ♣️), le nombre de jeux CONSÉCUTIFS où il n'est pas sorti. Quand un costume atteint
// le seuil (15 jeux par défaut), un message part dans le CHAT PRIVÉ de l'administrateur (jamais dans un canal) :
//   « ⚠️ ♦️ absent 15 fois (main du joueur) — depuis le jeu #812, dernier jeu #826 »
// Dès que le costume sort, son compteur repart à 0 (et l'alerte est de nouveau possible pour la série suivante).
//
// Réglages (page « Alerte absence ») : activation (désactivée par défaut), seuil, côté surveillé (joueur / banquier / les deux),
// « répéter » (OFF = UNE seule alerte au seuil par série ; ON = un message à chaque jeu supplémentaire : 16, 17, 18…).
// Les compteurs tournent toujours (ils sont à jour dès l'activation) ; seuls les envois exigent l'activation.
// Un nouveau sabot (numérotation qui repart de 1) remet tous les compteurs à zéro.
'use strict';

const store = require('./store');
const db = require('./db');
const predictor = require('./predictor');

const SUITS = ['❤️', '♠️', '♦️', '♣️'];
const SIDES = ['joueur', 'banquier'];
const DEFAULT_THRESHOLD = 15;
const MAX_LOG = 40;

const panel = {
  enabled: false,
  threshold: DEFAULT_THRESHOLD,
  sides: { joueur: true, banquier: false }, // côtés surveillés
  repeat: false,
  log: [],            // dernières alertes { at, side, suit, count, since, number }
  lastError: null,
};
// compteurs en mémoire : side → suit → { count, since }
let counters = null;
const alerted = {};   // `${side}|${suit}` → true (alerte déjà envoyée pour la série en cours)
let lastNumber = null;

let sender = null;
let adminIdFn = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
function setAdminId(fn) { adminIdFn = typeof fn === 'function' ? fn : null; }

// ---------------------------------------------------------------------------
// Persistance (data.json + base) — réglages et journal uniquement ; les compteurs sont recalculés depuis l'historique
// ---------------------------------------------------------------------------
function persist() {
  const saved = { enabled: panel.enabled, threshold: panel.threshold, sides: panel.sides, repeat: panel.repeat, log: panel.log.slice(-MAX_LOG) };
  try { store.patch({ absenceAlert: saved }); } catch (_) {}
  if (db.ready) db.setSetting('absence_alert_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  panel.enabled = saved.enabled === true;
  const th = Math.round(Number(saved.threshold));
  panel.threshold = Number.isFinite(th) && th >= 2 && th <= 200 ? th : DEFAULT_THRESHOLD;
  const sd = saved.sides && typeof saved.sides === 'object' ? saved.sides : {};
  panel.sides = { joueur: sd.joueur !== false, banquier: sd.banquier === true };
  if (!panel.sides.joueur && !panel.sides.banquier) panel.sides.joueur = true;
  panel.repeat = saved.repeat === true;
  panel.log = (Array.isArray(saved.log) ? saved.log : []).filter((x) => x && x.suit).slice(-MAX_LOG);
}
function restore() { try { const s = (store.read() || {}).absenceAlert; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting('absence_alert_state'); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}
function config() { return { enabled: panel.enabled, threshold: panel.threshold }; }
function configure() { persist(); } // import d'une sauvegarde : réécrit l'état en base

// ---------------------------------------------------------------------------
// Lecture des cartes
// ---------------------------------------------------------------------------
function normSuit(s) {
  const raw = String(s == null ? '' : s).replace(/\uFE0F/g, '').trim();
  if (raw === '♥' || raw === '❤') return '❤️';
  if (raw === '♦') return '♦️';
  if (raw === '♣') return '♣️';
  if (raw === '♠') return '♠️';
  return null;
}
const suitSet = (r, side) => {
  const list = side === 'banquier' ? (r && (r.bankerSuits || r.banker_suits)) : (r && (r.playerSuits || r.player_suits));
  const set = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) { const s = normSuit(raw); if (s) set.add(s); }
  return set;
};
const numberOf = (r) => Number(r && (r.number != null ? r.number : r.n));
const emptyCounters = () => ({
  joueur: Object.fromEntries(SUITS.map((s) => [s, { count: 0, since: null }])),
  banquier: Object.fromEntries(SUITS.map((s) => [s, { count: 0, since: null }])),
});

// premier appel après un démarrage : on reconstruit les séries en cours depuis l'historique des jeux terminés
// (le plus récent en premier). Les séries déjà au seuil sont considérées comme déjà signalées (pas d'alerte parasite).
function seedFromHistory(history) {
  counters = emptyCounters();
  const games = (Array.isArray(history) ? history : []).filter((r) => r && Number.isFinite(numberOf(r)) && (suitSet(r, 'joueur').size || suitSet(r, 'banquier').size));
  for (const side of SIDES) {
    for (const suit of SUITS) {
      let count = 0; let since = null;
      for (const g of games) {
        const set = suitSet(g, side);
        if (!set.size) continue; // main illisible : on ne juge pas ce jeu
        if (set.has(suit)) break;
        count += 1; since = numberOf(g);
      }
      counters[side][suit] = { count, since };
      alerted[`${side}|${suit}`] = count >= panel.threshold;
    }
  }
  lastNumber = games.length ? numberOf(games[0]) : null;
}

// ---------------------------------------------------------------------------
// Envoi dans le chat privé de l'admin (jamais bloqué par le garde de canaux)
// ---------------------------------------------------------------------------
async function toAdmin(text) {
  try {
    const bot = typeof sender === 'function' ? sender() : null;
    const adminId = adminIdFn ? adminIdFn() : null;
    if (!bot || !adminId) { panel.lastError = !adminId ? 'ADMIN_ID non renseigné (chat privé inconnu)' : 'Aucun token Telegram configuré'; return false; }
    const bypass = bot.sendMessageUnguarded || bot.sendMessage.bind(bot);
    await bypass(adminId, text);
    panel.lastError = null;
    return true;
  } catch (e) { panel.lastError = e.message; return false; }
}
const sideLabel = (side) => (side === 'banquier' ? 'main du banquier' : 'main du joueur');
function buildMessage(side, suit, c, number) {
  return `⚠️ ${suit} absent ${c.count} fois (${sideLabel(side)})\n` +
    `Depuis le jeu #${c.since} • dernier jeu #${number}\n` +
    `Seuil : ${panel.threshold} jeux consécutifs sans ${suit}.`;
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
    if (lastNumber != null && number <= lastNumber) { // numérotation repartie de 1 : nouveau sabot
      counters = emptyCounters();
      for (const k of Object.keys(alerted)) delete alerted[k];
    }
    lastNumber = number;
    const pending = [];
    for (const side of SIDES) {
      const set = suitSet(round, side);
      if (!set.size) continue; // cartes illisibles : jeu ignoré pour ce côté
      for (const suit of SUITS) {
        const c = counters[side][suit];
        const key = `${side}|${suit}`;
        if (set.has(suit)) { c.count = 0; c.since = null; alerted[key] = false; continue; }
        c.count += 1;
        if (c.since == null) c.since = number;
        if (!panel.enabled || !panel.sides[side]) continue;
        const reached = c.count >= panel.threshold;
        if (reached && (!alerted[key] || (panel.repeat && c.count > panel.threshold))) {
          alerted[key] = true;
          pending.push({ side, suit, count: c.count, since: c.since, number });
        }
      }
    }
    for (const a of pending) {
      const ok = await toAdmin(buildMessage(a.side, a.suit, a, a.number));
      panel.log.push({ at: Date.now(), ...a, sent: ok });
    }
    if (pending.length) { panel.log = panel.log.slice(-MAX_LOG); persist(); }
  } catch (e) { panel.lastError = e.message; }
}

// nouveau sabot (remise à zéro de la numérotation)
if (typeof predictor.setOnShoeReset === 'function') {
  predictor.setOnShoeReset(() => { counters = emptyCounters(); lastNumber = null; for (const k of Object.keys(alerted)) delete alerted[k]; });
}

// ---------------------------------------------------------------------------
// Réglages (site)
// ---------------------------------------------------------------------------
function setEnabled(on) {
  panel.enabled = !!on;
  persist();
  return panel.enabled;
}
function setThreshold(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 2 || n > 200) throw new Error('Seuil invalide : entre 2 et 200 jeux.');
  panel.threshold = n;
  if (counters) { // les séries déjà au nouveau seuil sont considérées comme signalées ; les autres pourront l'être
    for (const side of SIDES) for (const suit of SUITS) alerted[`${side}|${suit}`] = counters[side][suit].count >= n && alerted[`${side}|${suit}`] === true;
  }
  persist();
  return panel.threshold;
}
function setSides(patch = {}) {
  const next = { joueur: patch.joueur !== undefined ? !!patch.joueur : panel.sides.joueur, banquier: patch.banquier !== undefined ? !!patch.banquier : panel.sides.banquier };
  if (!next.joueur && !next.banquier) throw new Error('Choisis au moins un côté (joueur ou banquier).');
  panel.sides = next;
  persist();
  return panel.sides;
}
function setRepeat(on) { panel.repeat = !!on; persist(); return panel.repeat; }

async function testAlert() {
  const ok = await toAdmin(`🧪 Test — alerte absence de costume\nSeuil actuel : ${panel.threshold} jeux consécutifs sans le costume.`);
  return { ok, error: ok ? null : panel.lastError };
}

function status() {
  if (!counters) seedFromHistory(predictor.state.history);
  const rows = SIDES.map((side) => ({
    side, watched: !!panel.sides[side],
    suits: SUITS.map((suit) => ({ suit, count: counters[side][suit].count, since: counters[side][suit].since, alerted: !!alerted[`${side}|${suit}`] })),
  }));
  return {
    enabled: panel.enabled, threshold: panel.threshold, sides: panel.sides, repeat: panel.repeat,
    lastGame: lastNumber, counters: rows, log: panel.log.slice().reverse().slice(0, 15), lastError: panel.lastError,
  };
}

module.exports = {
  panel, config, configure, restore, restoreFromDb, persist, setSender, setAdminId, onFinished, status,
  setEnabled, setThreshold, setSides, setRepeat, testAlert, buildMessage,
};
