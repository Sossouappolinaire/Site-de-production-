// distribution-counter.js — « Compte distribution » (v100, demande admin), jumeau de « Compte parité ».
//
// Même principe que parity-counter.js (fin du numéro de jeu 0 à 9, joueur et banquier séparément, point pair / impair du côté,
// message du côté gagnant à chaque fin de jeu, reset toutes les N minutes avec bilan) mais, au lieu de compter les costumes, on
// compte la DISTRIBUTION des cartes du jeu :
//     2/2  joueur 2 cartes · banquier 2 cartes        3/2  joueur 3 · banquier 2
//     3/3  joueur 3 cartes · banquier 3 cartes        2/3  joueur 2 · banquier 3 (complète la série)
//     2k   le joueur a 2 cartes (2/2 + 2/3)           3k   le joueur a 3 cartes (3/2 + 3/3)
// Le bilan (à chaque reset) ajoute les DÉTAILS : nombre de jeux pair / impair, fins de numéro élevées (5-9) / basses (0-4),
// détail chiffre par chiffre et fin la plus fréquente (counter-details.js). « Compte parité » reçoit les mêmes détails.
'use strict';

const store = require('./store');
const db = require('./db');
const details = require('./counter-details');

const STORE_KEY = 'distributionCounter';
const DB_KEY = 'distribution_counter_state';
const DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const TARGETS = ['both', 'player', 'banker'];
const DISTS = ['2/2', '3/2', '3/3', '2/3'];

const zeros = () => Array(10).fill(0);
const distZeros = () => ({ '2/2': 0, '3/2': 0, '3/3': 0, '2/3': 0 });
const sideZeros = () => ({ pair: zeros(), impair: zeros(), dist: { pair: Array.from({ length: 10 }, distZeros), impair: Array.from({ length: 10 }, distZeros) } });

const state = {
  enabled: true, channelId: '', target: 'both', winnerOnly: true, intervalMin: 60,
  player: sideZeros(), banker: sideZeros(),
  games: 0, lastGameNumber: null, sinceAt: Date.now(), sentCount: 0, lastSentAt: null, lastError: null,
};

let sendFn = null;
function setSender(fn) { sendFn = typeof fn === 'function' ? fn : null; }

const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
function config() { return { enabled: state.enabled, channelId: state.channelId, target: state.target, winnerOnly: state.winnerOnly, intervalMin: state.intervalMin }; }
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
  if (state.intervalMin !== before) { resetCounts(); scheduleReset(); }
  persist();
  return config();
}
function restore() { try { applyConfig((store.read() || {})[STORE_KEY]); } catch (_) {} return config(); }
async function restoreFromDb() {
  if (!db.ready) return config();
  try { const raw = await db.getSetting(DB_KEY); if (raw) applyConfig(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
  scheduleReset();
  return config();
}
restore();

function setChannel(id) { state.channelId = String(id || '').trim(); persist(); return state.channelId; }
const getChannel = () => state.channelId;

// ── comptage ────────────────────────────────────────────────────────────────
function resetCounts() { state.player = sideZeros(); state.banker = sideZeros(); state.games = 0; state.sinceAt = Date.now(); }
const pointParity = (v) => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n >= 0 && n <= 9 ? (n % 2 === 0 ? 'pair' : 'impair') : null; };
// distribution du jeu : « joueur/banquier » en nombre de cartes (2 ou 3) ; null si inconnue
function distributionOf(round) {
  const p = Number(round && round.playerCards); const b = Number(round && round.bankerCards);
  const key = `${p}/${b}`;
  return DISTS.includes(key) ? key : null;
}

function bump(round) {
  if (!round || !round.finished || round.complete === false) return false;
  const num = Number(round.number);
  if (!Number.isInteger(num) || num < 0 || state.lastGameNumber === num) return false;
  const dist = distributionOf(round);
  if (!dist) return false;
  const pp = pointParity(round.playerValue); const bp = pointParity(round.bankerValue);
  if (!pp && !bp) return false;
  state.lastGameNumber = num;
  const d = num % 10;
  if (pp) { state.player[pp][d] += 1; state.player.dist[pp][d][dist] += 1; }
  if (bp) { state.banker[bp][d] += 1; state.banker.dist[bp][d][dist] += 1; }
  state.games += 1;
  return true;
}

// ── mise en forme ───────────────────────────────────────────────────────────
const pctInt = (count, total) => (total ? Math.round((count / total) * 100) : 0);
// une ligne par fin de numéro : « #840 ➔ (2/2 45%) (3/2 30%) (3/3 15%) (2/3 10%) · 2k 75% · 3k 25% » (du plus au moins fréquent)
function distLine(label, cell) {
  const c = cell || distZeros();
  const total = DISTS.reduce((n, k) => n + (c[k] || 0), 0);
  if (!total) return `${label} ➔ —`;
  const sorted = DISTS.map((k, i) => ({ k, n: c[k] || 0, i })).sort((a, b) => b.n - a.n || a.i - b.i);
  const two = (c['2/2'] || 0) + (c['2/3'] || 0); const three = (c['3/2'] || 0) + (c['3/3'] || 0);
  return `${label} ➔ ` + sorted.map((r) => `(${r.k} ${pctInt(r.n, total)}%)`).join(' ') + ` · 2k ${pctInt(two, total)}% · 3k ${pctInt(three, total)}%`;
}
function listBlock(dist, gameNumber) {
  const g = Number(gameNumber);
  const base = gameNumber != null && gameNumber !== '' && Number.isInteger(g) && g >= 0 ? Math.floor(g / 10) * 10 : null;
  return ALL.map((d) => {
    const merged = distZeros();
    for (const k of DISTS) merged[k] = ((dist.pair[d] || {})[k] || 0) + ((dist.impair[d] || {})[k] || 0);
    return distLine(base != null ? `#${base + d}` : DIGITS[d], merged);
  }).join('\n');
}
// total du côté : répartition 2/2 · 3/2 · 3/3 · 2/3 et 2k / 3k
function totals(counts) {
  const t = distZeros();
  for (const par of ['pair', 'impair']) for (const d of ALL) for (const k of DISTS) t[k] += (counts.dist[par][d] || {})[k] || 0;
  const all = DISTS.reduce((n, k) => n + t[k], 0);
  return { ...t, all, twoK: t['2/2'] + t['2/3'], threeK: t['3/2'] + t['3/3'] };
}
function totalsLine(counts) {
  const t = totals(counts);
  return `📈 2/2 : ${t['2/2']} · 3/2 : ${t['3/2']} · 3/3 : ${t['3/3']} · 2/3 : ${t['2/3']} | 2k : ${t.twoK} (${pctInt(t.twoK, t.all)}%) · 3k : ${t.threeK} (${pctInt(t.threeK, t.all)}%)`;
}

function msUntilNextReset(now = new Date()) {
  const n = state.intervalMin;
  const m = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / 60000;
  const boundary = (Math.floor(m / n) + 1) * n;
  return Math.max(1000, Math.round((boundary - m) * 60000));
}
const formatCountdown = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}min ${s % 60}s`; };

const SIDES = { player: { icon: '👤', name: 'Joueur' }, banker: { icon: '🏦', name: 'Banquier' } };
const sidesToSend = () => (state.target === 'player' ? ['player'] : state.target === 'banker' ? ['banker'] : ['player', 'banker']);

function buildMessage(side, gameNumber, opts = {}) {
  const s = SIDES[side]; const counts = state[side];
  const pairTotal = counts.pair.reduce((n, x) => n + x, 0);
  const impairTotal = counts.impair.reduce((n, x) => n + x, 0);
  const bilan = opts && opts.bilan;
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  return [
    ...(bilan ? [`🕐 BILAN DE L'HEURE — DISTRIBUTION — ${pad(now.getHours())}h${pad(now.getMinutes())}`, ''] : []),
    listBlock(counts.dist, gameNumber),
    '',
    ' RÉSUMÉ DISTRIBUTION',
    '━━━━━━━━━━━━━━━',
    `${s.icon} ${s.name} · pair ${pairTotal} jeu${pairTotal > 1 ? 'x' : ''} · impair ${impairTotal} jeu${impairTotal > 1 ? 'x' : ''}`,
    totalsLine(counts),
    ...(bilan ? ['', details.detailsText(counts.pair, counts.impair, `${s.icon} ${s.name}`)] : []),
    `🎮 Jeu #${gameNumber ?? '—'}  |  📊 ${state.games} jeu(x) depuis dernier reset`,
    bilan ? '🔄 Compteur remis à zéro' : `⏭ Reset dans ${formatCountdown(msUntilNextReset())}  (Intervalle ${state.intervalMin}min)`,
  ].join('\n');
}

const winnerSide = (w) => (w === 'Joueur' ? 'player' : w === 'Banquier' ? 'banker' : null);
async function publish(gameNumber, winner) {
  if (!state.enabled || !state.channelId || !sendFn) return false;
  let ok = false;
  const sides = state.winnerOnly ? sidesToSend().filter((sd) => sd === winnerSide(winner)) : sidesToSend();
  for (const side of sides) {
    try { await sendFn(state.channelId, buildMessage(side, gameNumber)); ok = true; state.sentCount += 1; state.lastSentAt = Date.now(); state.lastError = null; }
    catch (e) { state.lastError = e.message; console.error('Compte distribution :', e.message); }
  }
  return ok;
}
async function onFinished(round) { if (state.enabled && bump(round)) await publish(round.number, round.winner); }

async function sendBilan() {
  if (!state.enabled || !state.channelId || !sendFn || !state.games) return false;
  let ok = false;
  for (const side of sidesToSend()) {
    try { await sendFn(state.channelId, buildMessage(side, state.lastGameNumber, { bilan: true })); ok = true; state.sentCount += 1; state.lastSentAt = Date.now(); state.lastError = null; }
    catch (e) { state.lastError = e.message; console.error('Compte distribution (bilan) :', e.message); }
  }
  return ok;
}

let resetTimer = null;
function scheduleReset() {
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(async () => { try { await sendBilan(); } catch (_) {} resetCounts(); scheduleReset(); }, msUntilNextReset());
  if (resetTimer.unref) resetTimer.unref();
}

async function test(gameNumber) {
  if (!state.channelId) return { ok: false, error: 'Aucun canal configuré' };
  if (!sendFn) return { ok: false, error: 'Aucun token Telegram configuré' };
  const errors = []; let sent = 0;
  for (const side of sidesToSend()) {
    try { await sendFn(state.channelId, buildMessage(side, gameNumber, { bilan: true })); sent += 1; } catch (e) { errors.push(e.message); }
  }
  if (errors.length) state.lastError = errors[0];
  return { ok: sent > 0, sent, errors };
}

function status(gameNumber) {
  const view = (c) => {
    const t = totals(c);
    return {
      pair: [...c.pair], impair: [...c.impair],
      pairTotal: c.pair.reduce((s, n) => s + n, 0), impairTotal: c.impair.reduce((s, n) => s + n, 0),
      dist: t, details: details.detailsView(c.pair, c.impair),
      rows: ALL.map((d) => {
        const merged = distZeros(); for (const k of DISTS) merged[k] = ((c.dist.pair[d] || {})[k] || 0) + ((c.dist.impair[d] || {})[k] || 0);
        const total = DISTS.reduce((n, k) => n + merged[k], 0);
        return { digit: d, total, ...merged, twoK: merged['2/2'] + merged['2/3'], threeK: merged['3/2'] + merged['3/3'] };
      }),
    };
  };
  return {
    ...config(), games: state.games, sinceAt: state.sinceAt, nextResetMs: msUntilNextReset(),
    player: view(state.player), banker: view(state.banker),
    previews: sidesToSend().map((side) => ({ side, text: buildMessage(side, gameNumber) })),
    sentCount: state.sentCount, lastSentAt: state.lastSentAt, lastError: state.lastError,
  };
}

module.exports = { state, setSender, setChannel, getChannel, config, configure, persist, restore, restoreFromDb, bump, publish, onFinished, buildMessage, sendBilan, resetCounts, scheduleReset, test, status, distributionOf };
