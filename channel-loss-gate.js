// channel-loss-gate.js — « Envoi après perte » PAR CANAL, planifié jour par jour dans le fichier Excel (demande admin).
//
// Quand plusieurs stratégies publient dans un même canal, cette fonction surveille le canal et BLOQUE toute prédiction qui devait y
// être envoyée, tant qu'aucune perte n'a eu lieu dans ce canal. Elle ne bloque que les PRÉDICTIONS (messages portant un numéro de
// jeu futur) : bilans, statistiques et autres messages passent normalement.
//
// PLANNING (feuille « PlanningEnvoi » du classeur Excel, une ligne par date et par canal) :
//     Date        | Canal           | Mode
//     23/10/2026  | -1001234567890  | Libre
//     24/10/2026  | -1001234567890  | Après perte
//     25/10/2026  | -1001234567890  | Après perte
//     26/10/2026  | -1001234567890  | Libre
//   • Canal = identifiant du canal Telegram (ou @nom), ou « * » pour TOUS les canaux (une ligne « * » vaut pour chaque canal du bot).
//   • Mode « Libre » : toutes les prédictions du canal partent normalement ce jour-là.
//   • Mode « Après perte » : les prédictions sont retenues (elles sont toujours calculées et vérifiées en interne) ; une prédiction ne
//     part dans le canal que si la DERNIÈRE prédiction vérifiée de ce canal (envoyée ou retenue) est une perte. Après une perte, la
//     prochaine prédiction part ; si elle gagne, on attend de nouveau une perte ; si elle perd, la suivante part aussi.
//   • Date absente du planning (canal présent dans le planning) : mode par défaut réglable (« Après perte » par sécurité).
//   • Un canal qui n'apparaît dans AUCUNE ligne du planning (et sans ligne « * ») n'est jamais touché.
//   • Chaque nouveau jour (fuseau RESET_TZ, Abidjan par défaut) repart de zéro : en mode « Après perte », on attend une perte du jour.
//
// ACTIVATION : la fonction est DÉSACTIVÉE PAR DÉFAUT. Désactivée, le planning est ignoré et tout part librement. L'administrateur peut
// la désactiver à tout moment (page « Envoi après perte »), ou débloquer un canal à la main (« Débloquer maintenant »).
//
// « Perte » = une prédiction des stratégies (bouton « Stratégie ») dont le résultat final est perdu, qu'elle ait été envoyée ou retenue.
'use strict';

const store = require('./store');
const db = require('./db');
const predictor = require('./predictor');

const TZ = process.env.RESET_TZ || 'Africa/Abidjan';
const MAX_PLAN = 3000;
const MODES = ['libre', 'apres_perte'];

const cfg = { enabled: false, defaultMode: 'apres_perte', plan: [] }; // plan : { date: 'AAAA-MM-JJ', channel: 'clé', mode }
const runtime = { day: null, released: {}, held: {}, passed: {}, lastLoss: {}, lastError: null };

const keyOf = (id) => String(id == null ? '' : id).trim().toLowerCase();

// ---------------------------------------------------------------------------
// Dates et modes (lecture tolérante de l'Excel)
// ---------------------------------------------------------------------------
function todayKey(ts = Date.now()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ts));
  const g = (t) => (p.find((x) => x.type === t) || {}).value || '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}
const pad = (n) => String(n).padStart(2, '0');
function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}
// accepte : AAAA-MM-JJ, JJ/MM/AAAA, JJ-MM-AAAA, JJ.MM.AAAA, objet Date, numéro de série Excel
function normDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return validYmd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'number' && Number.isFinite(v) && v > 20000 && v < 80000) { // numéro de série Excel (jours depuis 1899-12-30)
    const dt = new Date(Math.round((v - 25569) * 86400000));
    return validYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return validYmd(Number(m[3]), Number(m[2]), Number(m[1]));
  if (/^\d{5}$/.test(s)) return normDate(Number(s));
  return null;
}
function normMode(v) {
  const s = String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (!s) return null;
  if (/(libre|free|envoi|normal|oui)/.test(s) && !/perte/.test(s)) return 'libre';
  if (/(perte|attend|bloq|apres|wait|loss)/.test(s)) return 'apres_perte';
  return null;
}
function normChannel(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (s === '*' || /^(tous|toutes|all)$/i.test(s)) return '*';
  return keyOf(s);
}
const modeLabel = (m) => (m === 'libre' ? 'Libre' : 'Après perte');

function cleanPlan(rows) {
  const seen = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r) continue;
    const date = normDate(r.date !== undefined ? r.date : r.Date);
    const channel = normChannel(r.channel !== undefined ? r.channel : (r.canal !== undefined ? r.canal : r.Canal));
    const mode = normMode(r.mode !== undefined ? r.mode : r.Mode);
    if (!date || !channel || !mode) continue;
    seen.set(`${date}|${channel}`, { date, channel, mode }); // la dernière ligne gagne
  }
  return [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.channel < b.channel ? -1 : 1)).slice(-MAX_PLAN);
}

// ---------------------------------------------------------------------------
// Persistance (data.json + base)
// ---------------------------------------------------------------------------
function persist() {
  const saved = { enabled: cfg.enabled, defaultMode: cfg.defaultMode, plan: cfg.plan };
  try { store.patch({ channelLossGate: saved }); } catch (_) {}
  if (db.ready) db.setSetting('channel_loss_gate', JSON.stringify(saved)).catch((e) => { runtime.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  cfg.enabled = saved.enabled === true;
  cfg.defaultMode = MODES.includes(saved.defaultMode) ? saved.defaultMode : 'apres_perte';
  cfg.plan = cleanPlan(saved.plan);
}
function restore() { try { const s = (store.read() || {}).channelLossGate; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting('channel_loss_gate'); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}
function config() { return { enabled: cfg.enabled, rows: cfg.plan.length }; }
function configure() { persist(); } // import d'une sauvegarde : réécrit l'état en base

// ---------------------------------------------------------------------------
// Décision
// ---------------------------------------------------------------------------
function rollDay(now = Date.now()) {
  const day = todayKey(now);
  if (runtime.day !== day) { runtime.day = day; runtime.released = {}; runtime.held = {}; runtime.passed = {}; runtime.lastLoss = {}; }
  return day;
}
// le canal figure-t-il dans le planning ? (sinon il n'est jamais touché)
function inPlan(ck) { return cfg.plan.some((r) => r.channel === ck || r.channel === '*'); }
// mode du jour pour ce canal : ligne exacte > ligne « * » > mode par défaut (canal présent dans le planning mais pas ce jour-là)
function modeFor(ck, day) {
  const exact = cfg.plan.find((r) => r.date === day && r.channel === ck);
  if (exact) return exact.mode;
  const all = cfg.plan.find((r) => r.date === day && r.channel === '*');
  if (all) return all.mode;
  return cfg.defaultMode;
}
function activeMode(chatId, now = Date.now()) {
  if (!cfg.enabled) return null;
  const ck = keyOf(chatId);
  if (!ck || !inPlan(ck)) return null;
  const day = rollDay(now);
  return modeFor(ck, day);
}

// un message est une « prédiction » s'il porte un numéro de jeu futur (N°…, №…, #…) : même repère que le ralentisseur
function liveNumber() {
  const st = predictor.state;
  let max = st.live ? Number(st.live.number) || 0 : 0;
  for (const g of st.games.values()) if (g.finished && g.number > max) max = g.number;
  return max;
}
function isPredictionText(text) {
  if (typeof text !== 'string') return false;
  const live = liveNumber();
  if (!live) return false;
  const re = /(?:N°|№|#)\s*(\d{1,6})/g;
  let m;
  while ((m = re.exec(text))) { const n = Number(m[1]); if (n > live && n - live <= 300) return true; }
  return false;
}

// appelée par le point d'envoi unique (installChannelGuard de bot.js) : true = cette prédiction est retenue
function shouldBlock(chatId, text) {
  try {
    const mode = activeMode(chatId);
    if (mode !== 'apres_perte') { if (mode === 'libre') { const ck = keyOf(chatId); runtime.passed[ck] = (runtime.passed[ck] || 0) + 1; } return false; }
    if (!isPredictionText(text)) return false;
    const ck = keyOf(chatId);
    if (runtime.released[ck]) { runtime.passed[ck] = (runtime.passed[ck] || 0) + 1; return false; } // la dernière prédiction vérifiée du canal est une perte
    runtime.held[ck] = (runtime.held[ck] || 0) + 1;
    return true;
  } catch (e) { runtime.lastError = e.message; return false; }
}

// appelée à chaque prédiction vérifiée (bot.js → updateResult) pour chaque canal de la prédiction
function recordResult(chatId, status) {
  try {
    const ck = keyOf(chatId);
    if (!ck || !cfg.enabled || !inPlan(ck)) return;
    rollDay();
    if (status === 'perdu') { runtime.released[ck] = true; runtime.lastLoss[ck] = Date.now(); }
    else if (status === 'gagne' || status === 'gagné') runtime.released[ck] = false;
  } catch (e) { runtime.lastError = e.message; }
}

// ---------------------------------------------------------------------------
// Réglages (site)
// ---------------------------------------------------------------------------
function setEnabled(on) {
  const v = !!on;
  if (v !== cfg.enabled) { runtime.released = {}; runtime.held = {}; runtime.passed = {}; runtime.lastLoss = {}; }
  cfg.enabled = v;
  persist();
  return cfg.enabled;
}
function setDefaultMode(m) {
  const mode = normMode(m);
  if (!mode) throw new Error('Mode invalide : « Libre » ou « Après perte ».');
  cfg.defaultMode = mode;
  persist();
  return cfg.defaultMode;
}
function setPlan(rows) { cfg.plan = cleanPlan(rows); persist(); return cfg.plan; }
function addRows(rows) { cfg.plan = cleanPlan([...cfg.plan, ...(Array.isArray(rows) ? rows : [])]); persist(); return cfg.plan; }
function removeRow(date, channel) {
  const d = normDate(date); const c = normChannel(channel);
  cfg.plan = cfg.plan.filter((r) => !(r.date === d && r.channel === c));
  persist();
  return cfg.plan;
}
function release(chatId) { // débloque un canal à la main (comme si une perte venait d'avoir lieu)
  rollDay();
  if (chatId === undefined || chatId === null || chatId === '' || chatId === '*') {
    for (const r of cfg.plan) if (r.channel !== '*') runtime.released[r.channel] = true;
    for (const k of Object.keys(runtime.held)) runtime.released[k] = true;
  } else runtime.released[keyOf(chatId)] = true;
  return true;
}

// lignes pour la feuille Excel « PlanningEnvoi » (aucune ligne d'exemple : un export vide ne doit jamais créer de planning à l'import)
function sheetRows() {
  return cfg.plan.map((r) => ({ Date: r.date, Canal: r.channel, Mode: modeLabel(r.mode) }));
}
const SHEET_NAME = 'PlanningEnvoi';
const SHEET_HEADER = ['Date', 'Canal', 'Mode'];
// notice écrite dans le classeur téléchargé depuis le site (ignorée à l'import)
const HELP_ROWS = [
  ['Feuille « PlanningEnvoi » — envoi libre ou après perte, jour par jour'],
  ['Une ligne par date et par canal : Date | Canal | Mode.'],
  ['Date : JJ/MM/AAAA ou AAAA-MM-JJ.'],
  ['Canal : identifiant du canal Telegram (ex. -1001234567890), @nom du canal, ou * pour tous les canaux.'],
  ['Mode : Libre (les prédictions partent normalement) ou Après perte (les prédictions attendent une perte dans le canal).'],
  ['Date absente du planning : mode par défaut réglé sur le site (Après perte par défaut).'],
  ['La fonction doit être ACTIVÉE sur le site (page « Envoi après perte ») : désactivée, ce planning est ignoré et tout part librement.'],
];

function status() {
  const day = rollDay();
  const channels = [...new Set([...cfg.plan.map((r) => r.channel).filter((c) => c !== '*'), ...Object.keys(runtime.held), ...Object.keys(runtime.passed), ...Object.keys(runtime.released)])];
  const today = channels.map((ck) => {
    const mode = modeFor(ck, day);
    return {
      channel: ck, mode, modeLabel: modeLabel(mode),
      waiting: cfg.enabled && mode === 'apres_perte' && !runtime.released[ck],
      released: !!runtime.released[ck], held: runtime.held[ck] || 0, passed: runtime.passed[ck] || 0,
      lastLoss: runtime.lastLoss[ck] || null,
    };
  });
  return {
    enabled: cfg.enabled, defaultMode: cfg.defaultMode, defaultModeLabel: modeLabel(cfg.defaultMode), tz: TZ, today: day,
    allMode: cfg.plan.some((r) => r.channel === '*') ? modeFor('*', day) : null,
    rows: cfg.plan.length, plan: cfg.plan.map((r) => ({ ...r, modeLabel: modeLabel(r.mode) })), channels: today, lastError: runtime.lastError,
  };
}

module.exports = {
  cfg, config, configure, restore, restoreFromDb, persist, shouldBlock, recordResult, isPredictionText, activeMode, modeFor,
  setEnabled, setDefaultMode, setPlan, addRows, removeRow, release, sheetRows, status, cleanPlan, normDate, normMode, todayKey,
  SHEET_NAME, SHEET_HEADER, HELP_ROWS,
};
