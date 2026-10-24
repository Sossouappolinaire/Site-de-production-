// channel-uniform.js — « Canal Telegram » (v103) : liste de TOUS les canaux qui reçoivent des prédictions, cochés au lieu d'être créés.
//
//  • Un canal COCHÉ = suivi (statistiques de canal-telegram.js) + format de prédiction UNIQUE + rattrapage UNIQUE + bilan toutes les 2 h
//    (strategy-recap.js). Peu importe la stratégie ou la configuration (Meilleur / Dizaine / Relance / Répétition…) qui publie dans ce canal.
//  • FORMAT : réécrit au point d'envoi unique de bot.js (installChannelGuard) — à l'envoi ET à l'édition du résultat. Le message d'origine
//    est retrouvé dans le registre de formats.js (texte exact → données de la prédiction : jeu, costume, statut, rattrapage), donc rien
//    n'est « deviné » en lisant le texte. Si le message n'est pas reconnu (rapport, bilan, message composite…), il part tel quel.
//  • RATTRAPAGE : imposé aux stratégies du moteur (predictor.js) dont le canal est coché ; vérifié à l'identique par canal-telegram.js.
//    Les panneaux automatiques (Meilleur, Dizaine, Relance…) gardent leur propre réglage de rattrapage : ils sont seulement mis au même
//    format ; la page montre, par canal, les formats et rattrapages réellement observés pour repérer ce qui diffère.
//  • MODE DU JOUR par canal coché (v105) : « favorable » (tout passe), « instable 1 » (après une perte, la prédiction SUIVANTE part),
//    « instable 2 » (après une perte, les DEUX prédictions suivantes partent). Entre deux pertes, le canal retient ses prédictions.
//    Les prédictions du canal passent toutes par ce bouton, qui décide de les laisser partir ou de les retenir (elles restent calculées
//    et vérifiées en interne). Perte = résultat d'une prédiction des stratégies du moteur dans ce canal, envoyée ou retenue ; chaque
//    perte (même celle d'une prédiction autorisée) redonne le plein d'autorisations ; les compteurs repartent à zéro chaque jour
//    (fuseau RESET_TZ). Même repère de « prédiction » que channel-loss-gate.js (numéro de jeu futur).
//  • Jamais bloquant : toute erreur laisse le message d'origine partir.
'use strict';

const store = require('./store');
const db = require('./db');
const fmt = require('./formats');

const DB_KEY = 'channel_uniform_state';
const OBS_MAX_CHANNELS = 200;
const SUITS = new Set(['♠', '♥', '♦', '♣']);

const MODES = ['favorable', 'instable2', 'instable1'];
const GRANT = { favorable: 0, instable1: 1, instable2: 2 }; // prédictions autorisées après chaque perte
const MODE_LABEL = { favorable: 'Favorable', instable1: 'Instable 1 (prédit 1 fois après une perte)', instable2: 'Instable 2 (prédit 2 fois après une perte)' };
const TZ = process.env.RESET_TZ || 'Africa/Abidjan';

const data = { channels: {}, obs: {}, savedAt: 0 };
const run = { day: null, credits: {}, held: {}, passed: {}, lastLoss: {} };
let saveTimer = null;

const key = (id) => String(id == null ? '' : id).trim().toLowerCase();
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const normMode = (v) => (MODES.includes(String(v)) ? String(v) : 'favorable');
const optInt = (v, lo, hi) => (v === null || v === undefined || v === '' ? null : clampInt(v, lo, hi, null));

// ── réglages par canal ──────────────────────────────────────────────────────
function get(id) { return data.channels[key(id)] || null; }
function setChannel(id, patch = {}) {
  const k = key(id);
  if (!k) throw new Error('Canal manquant.');
  const cur = data.channels[k] || { id: String(id).trim(), enabled: false, format: null, maxR: null, mode: 'favorable' };
  if (patch.enabled !== undefined) cur.enabled = !!patch.enabled;
  if (patch.format !== undefined) cur.format = optInt(patch.format, 1, fmt.FORMAT_COUNT);
  if (patch.maxR !== undefined) cur.maxR = optInt(patch.maxR, 0, 9);
  if (patch.mode !== undefined) cur.mode = normMode(patch.mode);
  data.channels[k] = cur;
  persistNow();
  return cur;
}
function applyAll(patch = {}) {
  const out = [];
  for (const c of Object.values(data.channels)) {
    if (!c.enabled) continue;
    if (patch.format !== undefined) c.format = optInt(patch.format, 1, fmt.FORMAT_COUNT);
    if (patch.maxR !== undefined) c.maxR = optInt(patch.maxR, 0, 9);
    if (patch.mode !== undefined) c.mode = normMode(patch.mode);
    out.push(c);
  }
  persistNow();
  return out;
}

// rattrapage imposé à une prédiction du moteur : le plus grand réglage parmi ses canaux cochés, sinon la valeur d'origine
function maxRFor(ids, fallback) {
  try {
    let best = null;
    for (const id of ids || []) {
      const c = data.channels[key(id)];
      if (c && c.enabled && c.maxR != null) best = best == null ? c.maxR : Math.max(best, c.maxR);
    }
    return best == null ? fallback : best;
  } catch (_) { return fallback; }
}

// ── observation : formats / rattrapages réellement envoyés par canal ────────
function observe(chatId, rec) {
  const k = key(chatId); if (!k || !rec) return;
  let o = data.obs[k];
  if (!o) {
    if (Object.keys(data.obs).length >= OBS_MAX_CHANNELS) return;
    o = data.obs[k] = { formats: {}, rs: {}, n: 0, at: 0 };
  }
  // une prédiction est comptée une seule fois : à son envoi (statut « en cours »), pas à l'édition du résultat
  if (rec.payload && rec.payload.status) return;
  o.n += 1; o.at = Date.now();
  o.formats[rec.formatId] = (o.formats[rec.formatId] || 0) + 1;
  const r = rec.payload && rec.payload.maxR != null ? rec.payload.maxR : null;
  if (r != null) o.rs[r] = (o.rs[r] || 0) + 1;
  persistSoon();
}
function observedOf(id) {
  const o = data.obs[key(id)];
  if (!o) return { formats: [], rs: [], n: 0, at: null };
  const top = (m) => Object.entries(m || {}).map(([k, n]) => ({ id: Number(k), n })).sort((a, b) => b.n - a.n).slice(0, 8);
  return { formats: top(o.formats), rs: top(o.rs), n: o.n, at: o.at || null };
}
function resetObserved(id) { if (id) delete data.obs[key(id)]; else data.obs = {}; persistNow(); }

// ── réécriture d'un message sortant (envoi ou édition) ──────────────────────
const withParse = (opts, pm) => { const o = { ...(opts || {}) }; if (pm) o.parse_mode = pm; else delete o.parse_mode; return o; };

// renvoie { text, opts } si le message doit être remplacé, sinon null
function rewrite(chatId, text, opts) {
  try {
    if (typeof text !== 'string' || !text) return null;
    const hit = fmt.locateRendered(text);
    if (!hit) return null;
    observe(chatId, hit.rec);
    const cfg = get(chatId);
    if (!cfg || !cfg.enabled || cfg.format == null) return null;
    const p = hit.rec.payload || {};
    if (hit.rec.formatId === cfg.format) return null;
    if (!SUITS.has(p.suit) || p.cardsLabel) return null; // parité, carte précise, distribution 2/2… : formats propres, non remplaçables
    const out = fmt.renderMessage(cfg.format, { ...p }, null, { noRecord: true });
    if (!out || !out.text) return null;
    if (hit.exact) return { text: out.text, opts: withParse(opts, out.parse_mode) };
    // message composite (décor autour de la prédiction) : on remplace seulement la partie prédiction, si le mode d'affichage est compatible
    const orig = (opts && opts.parse_mode) || null; const next = out.parse_mode || null;
    const compatible = orig === next || (orig === 'HTML' && !next && !/[<>&]/.test(out.text));
    if (!compatible) return null;
    return { text: text.replace(hit.key, () => out.text), opts: opts || {} };
  } catch (_) { return null; }
}

// ── persistance ─────────────────────────────────────────────────────────────
function snapshot() { return { channels: data.channels, obs: data.obs, savedAt: data.savedAt }; }
function persistNow() {
  data.savedAt = Date.now();
  const v = snapshot();
  try { store.patch({ channelUniform: v }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(v)).catch(() => {});
}
function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 10000);
  if (saveTimer.unref) saveTimer.unref();
}
function load(s) {
  if (!s || typeof s !== 'object') return;
  const chans = {};
  for (const [k, c] of Object.entries(s.channels || {})) {
    if (!c || typeof c !== 'object') continue;
    chans[k] = { id: String(c.id || k), enabled: !!c.enabled, format: optInt(c.format, 1, fmt.FORMAT_COUNT), maxR: optInt(c.maxR, 0, 9), mode: normMode(c.mode) };
  }
  data.channels = chans;
  data.obs = s.obs && typeof s.obs === 'object' ? s.obs : {};
  data.savedAt = Number(s.savedAt) || 0;
}
function restore() { try { load((store.read() || {}).channelUniform); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try {
    const raw = await db.getSetting(DB_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && (Number(s.savedAt) || 0) > (data.savedAt || 0)) load(s);
  } catch (_) {}
}

// ── mode du jour : favorable / instable 2 / instable 1 ──────────────────────
function todayKey(ts = Date.now()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ts));
  const g = (t) => (p.find((x) => x.type === t) || {}).value || '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function rollDay() {
  const d = todayKey();
  if (run.day !== d) { run.day = d; run.credits = {}; run.held = {}; run.passed = {}; run.lastLoss = {}; }
}
// appelée par le point d'envoi unique (bot.js) : true = cette prédiction est retenue
function shouldBlock(chatId, text) {
  try {
    const c = get(chatId);
    if (!c || !c.enabled) return false;
    if (!GRANT[normMode(c.mode)]) return false; // favorable : tout passe
    if (!require('./channel-loss-gate').isPredictionText(text)) return false; // bilans, rapports… passent toujours
    rollDay();
    const k = key(chatId);
    if ((run.credits[k] || 0) > 0) { run.credits[k] -= 1; run.passed[k] = (run.passed[k] || 0) + 1; return false; } // autorisation donnée par une perte
    run.held[k] = (run.held[k] || 0) + 1;
    return true;
  } catch (_) { return false; }
}
// appelée à chaque prédiction vérifiée (bot.js → updateResult), envoyée OU retenue
function recordResult(chatId, status) {
  try {
    const c = get(chatId);
    if (!c || !c.enabled) return;
    rollDay();
    const k = key(chatId);
    if (status === 'perdu') { run.credits[k] = GRANT[normMode(c.mode)]; run.lastLoss[k] = Date.now(); } // une perte rouvre le canal : 1 (instable 1) ou 2 (instable 2) prédictions
  } catch (_) { /* suivi seulement */ }
}
function modeState(chatId) {
  rollDay();
  const c = get(chatId); const k = key(chatId);
  const mode = c ? normMode(c.mode) : 'favorable';
  const credits = run.credits[k] || 0;
  return { mode, modeLabel: MODE_LABEL[mode], credits, grant: GRANT[mode], waiting: !!(c && c.enabled && GRANT[mode] && credits === 0), held: run.held[k] || 0, passed: run.passed[k] || 0, lastLoss: run.lastLoss[k] || null };
}

module.exports = { shouldBlock, recordResult, modeState, MODES, MODE_LABEL, get, setChannel, applyAll, maxRFor, rewrite, observedOf, resetObserved, restore, restoreFromDb, data };
