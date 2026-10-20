// parity-counter.js — « Compte parité » (bouton de l'accueil).
//
// Compte la FIN DE NUMÉRO DE JEU (chiffre 0 à 9 : le jeu #1223 compte pour le chiffre 3), séparément pour le JOUEUR et
// le BANQUIER. Pour chaque jeu terminé : si le point du joueur est PAIR, le chiffre va dans « Taux parité pair — Joueur » ;
// s'il est IMPAIR, dans « Taux parité impair — Joueur ». Même principe pour le banquier avec son propre point.
// Le pourcentage de chaque chiffre est calculé sur le total de SON bloc.
//
// Envoi (réglage « Envoyer pour ») : le joueur seulement, le banquier seulement, ou les deux — un message par côté,
// posté après chaque jeu terminé dans le canal choisi. Remise à zéro automatique toutes les N minutes (60 par défaut,
// calée sur l'heure pile), avec le compte à rebours dans le message.
'use strict';

const store = require('./store');
const db = require('./db');

const STORE_KEY = 'parityCounter';
const DB_KEY = 'parity_counter_state';
const DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const TARGETS = ['both', 'player', 'banker'];

const zeros = () => Array(10).fill(0);
const state = {
  enabled: true,
  channelId: '',
  target: 'both',      // both | player | banker
  winnerOnly: true,    // à chaque fin de jeu, n'envoie que le message du côté GAGNANT (nul : rien)
  intervalMin: 60,
  player: { pair: zeros(), impair: zeros() },
  banker: { pair: zeros(), impair: zeros() },
  games: 0,
  lastGameNumber: null,
  sinceAt: Date.now(),
  sentCount: 0,
  lastSentAt: null,
  lastError: null,
};

let sendFn = null; // enregistrée par bot.js : async (channelId, text) => message_id
function setSender(fn) { sendFn = typeof fn === 'function' ? fn : null; }

// ---------------------------------------------------------------------------
// Réglages + persistance (data.json en repli, base en source de vérité)
// ---------------------------------------------------------------------------
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
function config() {
  return { enabled: state.enabled, channelId: state.channelId, target: state.target, winnerOnly: state.winnerOnly, intervalMin: state.intervalMin };
}
function applyConfig(c) {
  if (!c || typeof c !== 'object') return;
  if (c.enabled !== undefined) state.enabled = c.enabled !== false;
  if (c.channelId !== undefined) state.channelId = String(c.channelId == null ? '' : c.channelId).trim();
  if (c.target !== undefined) state.target = TARGETS.includes(c.target) ? c.target : 'both';
  if (c.winnerOnly !== undefined) state.winnerOnly = c.winnerOnly !== false;
  if (c.intervalMin !== undefined) state.intervalMin = clampInt(c.intervalMin, 5, 1440, 60);
}
function persist() {
  const saved = config();
  try { store.patch({ [STORE_KEY]: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { state.lastError = e.message; });
}
function configure(patch = {}) {
  const before = state.intervalMin;
  applyConfig(patch);
  if (state.intervalMin !== before) { resetCounts(); scheduleReset(); } // autre intervalle : on repart de zéro
  persist();
  return config();
}
function restore() { try { applyConfig((store.read() || {})[STORE_KEY]); } catch (_) {} return config(); }
async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting(DB_KEY);
    if (raw) applyConfig(JSON.parse(raw)); else persist();
  } catch (_) { persist(); }
  scheduleReset();
  return config();
}
restore();

function setChannel(id) { state.channelId = String(id || '').trim(); persist(); return state.channelId; }
const getChannel = () => state.channelId;

// ---------------------------------------------------------------------------
// Comptage
// ---------------------------------------------------------------------------
function resetCounts() {
  state.player = { pair: zeros(), impair: zeros() }; state.banker = { pair: zeros(), impair: zeros() };
  state.games = 0;
  state.sinceAt = Date.now();
}

const pointParity = (v) => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n >= 0 && n <= 9 ? (n % 2 === 0 ? 'pair' : 'impair') : null; };

// appelée une fois par jeu terminé (voir bot.js, même point que le Taux Miroir)
function bump(round) {
  if (!round || !round.finished) return false;
  if (round.complete === false) return false;
  const num = Number(round.number);
  if (!Number.isInteger(num) || num < 0) return false;
  if (state.lastGameNumber === num) return false;
  const pp = pointParity(round.playerValue); const bp = pointParity(round.bankerValue);
  if (!pp && !bp) return false;
  state.lastGameNumber = num;
  const d = num % 10; // fin de numéro : 1223 → 3
  if (pp) state.player[pp][d] += 1;
  if (bp) state.banker[bp][d] += 1;
  state.games += 1;
  return true;
}

const pct = (count, total) => (total ? ((count / total) * 100).toFixed(1) : '0.0');
function block(parityName, icon, name, counts, digits = ALL) {
  const total = digits.reduce((s, d) => s + counts[d], 0);
  const lines = [`📈 Taux parité ${parityName} — ${icon} ${name}`, '━━━━━━━━━━━━━━━━━━'];
  for (const d of digits) lines.push(`${DIGITS[d]} : ${counts[d]}  (${pct(counts[d], total)}%)`);
  return lines.join('\n');
}

// prochain reset : calé sur l'horloge locale (toutes les N minutes à partir de minuit ; 60 = heure pile)
function msUntilNextReset(now = new Date()) {
  const n = state.intervalMin;
  const m = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / 60000;
  const boundary = (Math.floor(m / n) + 1) * n;
  return Math.max(1000, Math.round((boundary - m) * 60000));
}
function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSec / 60)}min ${totalSec % 60}s`;
}

const SIDES = {
  player: { icon: '👤', name: 'Joueur' },
  banker: { icon: '🏦', name: 'Banquier' },
};
function sidesToSend() { return state.target === 'player' ? ['player'] : state.target === 'banker' ? ['banker'] : ['player', 'banker']; }

function buildMessage(side, gameNumber) {
  const s = SIDES[side]; const counts = state[side];
  return [
    block('pair', s.icon, s.name, counts.pair),
    '',
    block('impair', s.icon, s.name, counts.impair),
    '',
    `🎮 Jeu #${gameNumber ?? '—'}  |  📊 ${state.games} jeu(x) depuis dernier reset`,
    `⏭ Reset dans ${formatCountdown(msUntilNextReset())}  (Intervalle ${state.intervalMin}min)`,
  ].join('\n');
}

const winnerSide = (w) => (w === 'Joueur' ? 'player' : w === 'Banquier' ? 'banker' : null);
// publie, après chaque jeu terminé, le message du côté GAGNANT (si « gagnant seulement » ; un nul n'envoie rien),
// sinon un message par côté choisi
async function publish(gameNumber, winner) {
  if (!state.enabled || !state.channelId || !sendFn) return false;
  let ok = false;
  const sides = state.winnerOnly ? sidesToSend().filter((sd) => sd === winnerSide(winner)) : sidesToSend();
  for (const side of sides) {
    try { await sendFn(state.channelId, buildMessage(side, gameNumber)); ok = true; state.sentCount += 1; state.lastSentAt = Date.now(); state.lastError = null; }
    catch (e) { state.lastError = e.message; console.error('Compte parité :', e.message); }
  }
  return ok;
}
// à appeler à chaque jeu terminé : compte puis publie
async function onFinished(round) {
  if (!state.enabled) return;
  if (bump(round)) await publish(round.number, round.winner);
}

let resetTimer = null;
function scheduleReset() {
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => { resetCounts(); scheduleReset(); }, msUntilNextReset());
  if (resetTimer.unref) resetTimer.unref();
}

async function test(gameNumber) {
  if (!state.channelId) return { ok: false, error: 'Aucun canal configuré' };
  if (!sendFn) return { ok: false, error: 'Aucun token Telegram configuré' };
  const errors = []; let sent = 0;
  for (const side of sidesToSend()) {
    try { await sendFn(state.channelId, buildMessage(side, gameNumber)); sent += 1; } catch (e) { errors.push(e.message); }
  }
  if (errors.length) state.lastError = errors[0];
  return { ok: sent > 0, sent, errors };
}

function status(gameNumber) {
  const view = (c) => ({
    pair: [...c.pair], impair: [...c.impair],
    pairTotal: c.pair.reduce((s, n) => s + n, 0),
    impairTotal: c.impair.reduce((s, n) => s + n, 0),
  });
  return {
    ...config(),
    games: state.games, sinceAt: state.sinceAt, nextResetMs: msUntilNextReset(),
    player: view(state.player), banker: view(state.banker),
    previews: sidesToSend().map((side) => ({ side, text: buildMessage(side, gameNumber) })),
    sentCount: state.sentCount, lastSentAt: state.lastSentAt, lastError: state.lastError,
  };
}

module.exports = {
  state, setSender, setChannel, getChannel, config, configure, persist, restore, restoreFromDb,
  bump, publish, onFinished, buildMessage, resetCounts, scheduleReset, test, status,
};
