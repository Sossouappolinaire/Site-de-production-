// game-stability.js — « Stabilité du jeu » (fonction DÉSACTIVÉE PAR DÉFAUT, à activer sur le site : page « Stabilité »).
//
// Source des jeux : les mêmes jeux terminés que ceux lus par l'Analyseur IA (predictor.state.history, main du JOUEUR).
//
// RÈGLE DE STABILITÉ : sur 7 jeux consécutifs analysés (fenêtre glissante), le joueur doit avoir reçu AU MOINS UNE FOIS
// chacun des 4 costumes (♣️ ♦️ ♠️ ❤️). Exemple : jeux 1 à 7 → s'il manque un costume dans l'ensemble des cartes du joueur, le
// jeu est INSTABLE. Moins de 7 jeux (début de sabot) : pas de jugement tant que la fenêtre n'est pas complète.
//
// ENVOIS — UNIQUEMENT dans le CHAT PRIVÉ de l'administrateur (jamais dans un canal) :
//   • « ⚠️ Jeu instable » dès que le jeu devient instable, puis « ✅ Jeu de nouveau stable » avec la DURÉE de l'instabilité ;
//   • un BILAN DE STABILITÉ toutes les heures (à l'heure pile) : de tel jeu à tel jeu c'était stable, de tel jeu à tel jeu instable.
//
// BLOCAGE : si le jeu reste instable 10 minutes, l'envoi des messages dans les canaux dont le blocage est ACTIVÉ est suspendu
// pendant 1 heure (garde central de bot.js : installChannelGuard → isBlocked). Les messages déjà publiés continuent d'être
// vérifiés / édités normalement ; seuls les NOUVEAUX envois sont retenus. Après l'heure, l'envoi reprend ; si le jeu est encore
// instable, un nouveau blocage n'intervient qu'après 10 nouvelles minutes d'instabilité.
'use strict';

const store = require('./store');
const db = require('./db');
const predictor = require('./predictor');

const SUITS = ['♦️', '❤️', '♣️', '♠️'];
const WINDOW = 7;                       // jeux analysés
const BLOCK_AFTER_MS = 10 * 60 * 1000;  // instabilité qui déclenche le blocage
const BLOCK_FOR_MS = 60 * 60 * 1000;    // durée du blocage
const MAX_SEGMENTS = 300;
const TZ = process.env.RESET_TZ || 'Africa/Abidjan';

const panel = {
  enabled: false,              // désactivée par défaut
  blockChannels: [],           // canaux (ID) dont l'envoi est bloqué pendant l'instabilité prolongée
  status: 'unknown',           // 'stable' | 'unstable' | 'unknown' (fenêtre de 7 jeux pas encore complète)
  since: null, lastGame: null, missing: [],
  segments: [],                // { status, fromGame, toGame, from, to } — le dernier est « en cours » (to = null)
  blockedUntil: null, blockRefAt: null, blockCount: 0,
  lastBilanKey: null, lastBilanAt: null, bilanFrom: null,
  lastError: null,
};

let sender = null;
let adminIdFn = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
function setAdminId(fn) { adminIdFn = typeof fn === 'function' ? fn : null; }

// ---------------------------------------------------------------------------
// Persistance (data.json + base) — même principe que les autres panneaux
// ---------------------------------------------------------------------------
const parseIds = (v) => [...new Set((Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean))];
function persist() {
  const saved = { ...panel, blockChannels: panel.blockChannels };
  try { store.patch({ gameStability: saved }); } catch (_) {}
  if (db.ready) db.setSetting('game_stability_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  panel.enabled = saved.enabled === true;
  panel.blockChannels = parseIds(saved.blockChannels);
  panel.status = ['stable', 'unstable'].includes(saved.status) ? saved.status : 'unknown';
  panel.since = Number(saved.since) || null;
  panel.lastGame = Number.isFinite(Number(saved.lastGame)) ? Number(saved.lastGame) : null;
  panel.missing = Array.isArray(saved.missing) ? saved.missing.filter((s) => SUITS.includes(s)) : [];
  panel.segments = (Array.isArray(saved.segments) ? saved.segments : []).filter((s) => s && ['stable', 'unstable'].includes(s.status)).slice(-MAX_SEGMENTS);
  panel.blockedUntil = Number(saved.blockedUntil) || null;
  panel.blockRefAt = Number(saved.blockRefAt) || null;
  panel.blockCount = Number(saved.blockCount) || 0;
  panel.lastBilanKey = saved.lastBilanKey || null;
  panel.lastBilanAt = Number(saved.lastBilanAt) || null;
  panel.bilanFrom = Number(saved.bilanFrom) || null;
}
function restore() { try { const s = (store.read() || {}).gameStability; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting('game_stability_state'); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}
function config() { return { count: panel.blockChannels.length }; }
function configure() { persist(); } // import d'une sauvegarde : réécrit l'état en base

// ---------------------------------------------------------------------------
// Analyse : 7 derniers jeux terminés
// ---------------------------------------------------------------------------
function normSuit(s) {
  const raw = String(s == null ? '' : s).replace(/\uFE0F/g, '').trim();
  if (raw === '♥' || raw === '❤') return '❤️';
  if (raw === '♦') return '♦️';
  if (raw === '♣') return '♣️';
  if (raw === '♠') return '♠️';
  return null;
}
const numberOf = (r) => Number(r && (r.number != null ? r.number : r.n));
const suitsOf = (r) => (Array.isArray(r && (r.playerSuits || r.player_suits)) ? (r.playerSuits || r.player_suits) : []).map(normSuit).filter(Boolean);

// history : jeux terminés, le plus récent en premier. Retourne null tant que 7 jeux complets ne sont pas disponibles.
function analyse(history) {
  const games = (Array.isArray(history) ? history : []).filter((r) => r && Number.isFinite(numberOf(r)) && suitsOf(r).length);
  if (games.length < WINDOW) return null;
  const win = games.slice(0, WINDOW);
  const seen = new Set(win.flatMap(suitsOf));
  const missing = SUITS.filter((s) => !seen.has(s));
  return { stable: missing.length === 0, missing, number: numberOf(win[0]), from: numberOf(win[WINDOW - 1]) };
}

// ---------------------------------------------------------------------------
// Messages (chat privé de l'admin uniquement)
// ---------------------------------------------------------------------------
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${String(s % 60).padStart(2, '0')} s` : ''}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
function fmtClock(ts) {
  const p = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts));
  const g = (t) => (p.find((x) => x.type === t) || {}).value || '00';
  return `${g('hour')}h${g('minute')}`;
}
function hourKey(ts = Date.now()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts));
  const g = (t) => (p.find((x) => x.type === t) || {}).value || '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}`;
}
async function toAdmin(text) {
  try {
    const bot = typeof sender === 'function' ? sender() : null;
    const adminId = adminIdFn ? adminIdFn() : null;
    if (!bot || !adminId) { panel.lastError = !adminId ? 'ADMIN_ID non renseigné (chat privé inconnu)' : 'Aucun token Telegram configuré'; return false; }
    const bypass = bot.sendMessageUnguarded || bot.sendMessage.bind(bot); // jamais bloqué par le garde de canaux
    await bypass(adminId, text);
    panel.lastError = null;
    return true;
  } catch (e) { panel.lastError = e.message; return false; }
}
const channelNames = () => panel.blockChannels.length;

// ---------------------------------------------------------------------------
// Segments : suites de jeux stables / instables
// ---------------------------------------------------------------------------
const openSegment = () => { const l = panel.segments[panel.segments.length - 1]; return l && l.to == null ? l : null; };
function closeOpen(now) { const o = openSegment(); if (o) o.to = now; }

async function onStatus(res, now) {
  const next = res ? (res.stable ? 'stable' : 'unstable') : 'unknown';
  const prev = panel.status;
  if (res) panel.lastGame = res.number;
  panel.missing = res && !res.stable ? res.missing : [];
  if (next === 'unknown') {
    if (prev !== 'unknown') { closeOpen(now); panel.status = 'unknown'; panel.since = null; }
    return;
  }
  const open = openSegment();
  if (prev === next && open) { open.toGame = res.number; return; }
  // changement d'état : on ferme le segment précédent, on en ouvre un nouveau
  const ended = open ? { ...open, to: now } : null;
  closeOpen(now);
  panel.segments.push({ status: next, fromGame: res.number, toGame: res.number, from: now, to: null });
  if (panel.segments.length > MAX_SEGMENTS) panel.segments = panel.segments.slice(-MAX_SEGMENTS);
  panel.status = next; panel.since = now;
  if (!panel.enabled || prev === next) return;
  if (next === 'unstable') {
    await toAdmin(`⚠️ Jeu instable\nDepuis le jeu N°${res.number} (analyse des jeux ${res.from} → ${res.number}).\nCostume(s) absent(s) chez le joueur : ${res.missing.join(' ')}\nDurée : en cours (${fmtClock(now)})${panel.blockChannels.length ? `\nBlocage des prédictions si l'instabilité dure 10 min (${channelNames()} canal(aux) concerné(s)).` : ''}`);
  } else if (prev === 'unstable' && ended) {
    await toAdmin(`✅ Jeu de nouveau stable depuis le jeu N°${res.number}\nInstable du jeu N°${ended.fromGame} au jeu N°${ended.toGame} · durée : ${fmtDur(ended.to - ended.from)} (${fmtClock(ended.from)} → ${fmtClock(ended.to)})`);
  }
}

// ---------------------------------------------------------------------------
// Blocage des canaux
// ---------------------------------------------------------------------------
function isBlocked(chatId) {
  if (!panel.enabled || !panel.blockedUntil || Date.now() >= panel.blockedUntil) return false;
  const id = String(chatId == null ? '' : chatId).trim();
  if (!id) return false;
  const admin = adminIdFn ? adminIdFn() : null;
  if (admin && String(admin) === id) return false; // le chat privé n'est jamais bloqué
  return panel.blockChannels.includes(id);
}
async function checkBlock(now) {
  if (panel.blockedUntil && now >= panel.blockedUntil) {
    panel.blockedUntil = null;
    await toAdmin(`▶️ Fin du blocage : l'envoi des prédictions reprend dans ${channelNames()} canal(aux).${panel.status === 'unstable' ? '\nLe jeu est encore instable : nouveau blocage après 10 min d\'instabilité.' : ''}`);
  }
  if (!panel.enabled || panel.status !== 'unstable' || panel.blockedUntil || !panel.since) return;
  const ref = Math.max(panel.since, panel.blockRefAt || 0);
  if (now - ref < BLOCK_AFTER_MS) return;
  panel.blockedUntil = now + BLOCK_FOR_MS;
  panel.blockRefAt = panel.blockedUntil;
  panel.blockCount += 1;
  await toAdmin(`🚫 Instabilité depuis ${fmtDur(now - panel.since)} : envoi des prédictions bloqué jusqu'à ${fmtClock(panel.blockedUntil)} (1 h) dans ${channelNames()} canal(aux)${panel.blockChannels.length ? ` :\n${panel.blockChannels.join('\n')}` : ' (aucun canal n\'a le blocage activé).'}`);
}

// ---------------------------------------------------------------------------
// Bilan horaire (à l'heure pile)
// ---------------------------------------------------------------------------
function buildBilan(now) {
  const from = panel.lastBilanAt || now - 3600 * 1000;
  const segs = panel.segments.filter((s) => (s.to == null ? now : s.to) > from);
  if (!segs.length) return null;
  let stableMs = 0, unstableMs = 0;
  const lines = segs.map((s, i) => {
    const start = Math.max(s.from, from), end = s.to == null ? now : s.to;
    const dur = end - start;
    if (s.status === 'stable') stableMs += dur; else unstableMs += dur;
    const carried = i === 0 && s.from < from && panel.bilanFrom;
    const fromGame = carried ? panel.bilanFrom : s.fromGame;
    const tail = s.to == null ? ' · en cours' : '';
    return `${s.status === 'stable' ? '✅ Stable  ' : '⚠️ Instable'} : jeux N°${fromGame} → N°${s.toGame} · ${fmtDur(dur)}${carried ? ' (suite)' : ''}${tail}`;
  });
  const total = stableMs + unstableMs;
  const pct = total ? Math.round((stableMs * 100) / total) : null;
  const first = segs[0].from < from && panel.bilanFrom ? panel.bilanFrom : segs[0].fromGame;
  const last = segs[segs.length - 1].toGame;
  const block = panel.blockedUntil && panel.blockedUntil > now ? `\n🚫 Envoi bloqué jusqu'à ${fmtClock(panel.blockedUntil)} dans ${channelNames()} canal(aux).` : '';
  return `📊 Bilan de stabilité — ${fmtClock(now)}\nPériode : ${fmtClock(from)} → ${fmtClock(now)} · jeux N°${first} → N°${last}\n\n${lines.join('\n')}\n\nStable ${pct === null ? '—' : `${pct}%`} du temps · instable ${fmtDur(unstableMs)}${block}`;
}
async function checkBilan(now) {
  if (!panel.enabled) return;
  const key = hourKey(now);
  if (panel.lastBilanKey === key) return;
  const first = !panel.lastBilanKey; // premier passage après l'activation : le premier bilan part à l'heure pile suivante
  panel.lastBilanKey = key;
  if (!first) {
    const text = buildBilan(now);
    if (text) await toAdmin(text);
  }
  panel.lastBilanAt = now;
  panel.bilanFrom = panel.lastGame;
  // on ne garde que le segment en cours et les segments récents
  const cut = now - 25 * 3600 * 1000;
  panel.segments = panel.segments.filter((s) => s.to == null || s.to >= cut);
}

// ---------------------------------------------------------------------------
// Boucle
// ---------------------------------------------------------------------------
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    // l'analyse tourne toujours (état à jour dès l'activation) ; les envois et le blocage exigent l'activation
    const sig = () => JSON.stringify([panel.enabled, panel.status, panel.lastGame, panel.blockedUntil, panel.blockCount, panel.lastBilanKey, panel.segments.length]);
    const before = sig();
    const res = analyse(predictor.state.history);
    const changed = (res ? (res.stable ? 'stable' : 'unstable') : 'unknown') !== panel.status || (res && res.number !== panel.lastGame);
    if (changed) await onStatus(res, now);
    await checkBlock(now);
    await checkBilan(now);
    if (sig() !== before) persist();
  } catch (e) { panel.lastError = e.message; } finally { running = false; }
}
if (typeof predictor.setOnShoeReset === 'function') {
  predictor.setOnShoeReset(() => { // nouveau sabot : la numérotation repart de 1, la fenêtre de 7 jeux aussi
    const now = Date.now();
    closeOpen(now); panel.status = 'unknown'; panel.since = null; panel.lastGame = null; panel.missing = []; panel.bilanFrom = null;
    persist();
  });
}

// ---------------------------------------------------------------------------
// Réglages (site)
// ---------------------------------------------------------------------------
function setEnabled(on) {
  const v = !!on;
  if (v === panel.enabled) return panel.enabled;
  panel.enabled = v;
  if (!v) { panel.blockedUntil = null; panel.blockRefAt = null; panel.lastBilanKey = null; panel.lastBilanAt = null; }
  else { panel.lastBilanKey = null; panel.lastBilanAt = Date.now(); panel.bilanFrom = panel.lastGame; panel.blockRefAt = Date.now(); }
  persist();
  return panel.enabled;
}
function setBlockChannels(list) { panel.blockChannels = parseIds(list); persist(); return panel.blockChannels; }
function toggleChannel(id, on) {
  const k = String(id == null ? '' : id).trim();
  if (!k) throw new Error('Canal invalide.');
  const set = new Set(panel.blockChannels);
  if (on) set.add(k); else set.delete(k);
  return setBlockChannels([...set]);
}
function releaseBlock() { panel.blockedUntil = null; panel.blockRefAt = Date.now(); persist(); }

function status() {
  const now = Date.now();
  const res = analyse(predictor.state.history);
  return {
    enabled: panel.enabled, window: WINDOW, blockAfterMin: BLOCK_AFTER_MS / 60000, blockForMin: BLOCK_FOR_MS / 60000,
    state: panel.status, since: panel.since, sinceText: panel.since ? fmtDur(now - panel.since) : null,
    lastGame: panel.lastGame, missing: panel.missing, windowFrom: res ? res.from : null, windowTo: res ? res.number : null,
    blockChannels: panel.blockChannels, blockedUntil: panel.blockedUntil && panel.blockedUntil > now ? panel.blockedUntil : null,
    blockedUntilText: panel.blockedUntil && panel.blockedUntil > now ? fmtClock(panel.blockedUntil) : null, blockCount: panel.blockCount,
    lastBilanAt: panel.lastBilanAt, lastError: panel.lastError,
    segments: panel.segments.slice(-12).reverse().map((s) => ({ status: s.status, fromGame: s.fromGame, toGame: s.toGame, from: s.from, to: s.to, durText: fmtDur((s.to == null ? now : s.to) - s.from), fromText: fmtClock(s.from) })),
  };
}

module.exports = {
  panel, config, configure, restore, restoreFromDb, persist, setSender, setAdminId, tick, status, analyse, isBlocked,
  setEnabled, setBlockChannels, toggleChannel, releaseBlock, buildBilan,
};
