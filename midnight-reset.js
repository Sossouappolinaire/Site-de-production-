// midnight-reset.js — « NOUVEAU DÉPART » chaque jour à 00h00 heure d'Abidjan
// (demande admin).
//
// À 00h00 pile (fuseau RESET_TZ, Africa/Abidjan par défaut) :
//   1. le bot envoie l'export Excel complet de la configuration (la même chose que
//      la commande /exporter) dans le CHAT PRIVÉ de l'administrateur (ADMIN_ID) ;
//   2. puis il EFFACE les données enregistrées pour repartir à neuf :
//        • jeux stockés (mémoire + table `games`),
//        • prédictions stockées (mémoire + table `predictions`) et leurs compteurs,
//        • historiques, messages en attente, bilans/compteurs de chaque panneau,
//          registres anti-doublon, filtres « double perte », annonces de position,
//          analyses cumulées du jour ;
//   3. un message de confirmation est envoyé à l'administrateur.
//
// AUCUNE CONFIGURATION N'EST TOUCHÉE : réglages, canaux, tokens, formats, stratégies
// et leurs réglages, configurations de chaque panneau (Dizaine, Après perte, VIP,
// etc.), stratégies créées par l'IA, règles apprises, comptes utilisateurs, analyses
// IA enregistrées.
//
// Les jeux déjà terminés que le flux renvoie après l'effacement sont simplement
// mémorisés, sans redéclencher de stratégie (aucune prédiction en double).
//
// Rattrapage : si le serveur dormait à 00h00 (veille Render), l'opération a lieu à
// son réveil, tant qu'on est dans les 30 premières minutes de la journée.
// Un seul passage par jour (jour mémorisé en base et en fichier, même après redémarrage).
//
// Désactivation : MIDNIGHT_RESET=off.
'use strict';

const store = require('./store');
const db = require('./db');
const predictor = require('./predictor');
const dataTransfer = require('./data-transfer');

const TZ = process.env.RESET_TZ || 'Africa/Abidjan';
const CATCHUP_MINUTES = 30;
const EXPORT_TRIES = 3;
const EXPORT_RETRY_MS = 15000;

const info = { lastDay: null, lastRunAt: null, lastReport: null, running: false };
let sender = null;
function setSender(fn) { sender = fn; }

const enabled = () => !/^(off|0|false)$/i.test(String(process.env.MIDNIGHT_RESET || ''));

function parts(ms) {
  const f = new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const o = {};
  for (const x of f) o[x.type] = x.value;
  return { key: `${o.year}-${o.month}-${o.day}`, h: Number(o.hour), m: Number(o.minute) };
}

// ── persistance du jour déjà traité ───────────────────────────────────────────
function persistInfo() {
  const v = { lastDay: info.lastDay, lastRunAt: info.lastRunAt, lastReport: info.lastReport };
  try { store.patch({ midnightReset: v }); } catch (_) { /* ignoré */ }
  if (db.ready) db.setSetting('midnight_reset', JSON.stringify(v)).catch(() => {});
}
function restore() {
  try { const s = (store.read() || {}).midnightReset; if (s) Object.assign(info, { lastDay: s.lastDay || null, lastRunAt: s.lastRunAt || null, lastReport: s.lastReport || null }); } catch (_) { /* ignoré */ }
}
async function restoreFromDb() {
  if (!db.ready) return;
  try {
    const raw = await db.getSetting('midnight_reset');
    if (raw) { const s = JSON.parse(raw); if (s && s.lastDay && (!info.lastDay || s.lastDay > info.lastDay)) Object.assign(info, { lastDay: s.lastDay, lastRunAt: s.lastRunAt || null, lastReport: s.lastReport || null }); }
  } catch (_) { /* ignoré */ }
}

// ── 1. export vers le chat privé ──────────────────────────────────────────────
async function sendExport(dayKey) {
  const bot = typeof sender === 'function' ? sender() : null;
  const adminId = predictor.state.adminId;
  if (!bot) return { ok: false, error: 'aucun token Telegram configuré' };
  if (!adminId) return { ok: false, error: 'ADMIN_ID non renseigné (chat privé inconnu)' };
  let lastError = null;
  for (let i = 1; i <= EXPORT_TRIES; i++) {
    try {
      const buffer = await dataTransfer.exportBuffer();
      await bot.sendDocument(
        adminId, buffer,
        { caption: `📦 Export automatique de 00h00 (heure d'Abidjan) — configuration complète, avant le nouveau départ.` },
        { filename: `baccara-config-${dayKey}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      );
      return { ok: true, tries: i };
    } catch (e) {
      lastError = e.message;
      if (i < EXPORT_TRIES) await new Promise((r) => setTimeout(r, EXPORT_RETRY_MS));
    }
  }
  return { ok: false, error: lastError || 'échec inconnu' };
}

// ── 2. effacement des données (jamais les configurations) ─────────────────────
const ARRAYS = ['history', 'pendingMessages', 'pending', 'sentKeys', 'sentFingerprints', 'predictions'];
const OBJECTS = ['tally', 'verified', 'tracked'];
const TRACKER_ZERO = ['wins', 'losses', 'sentCount', 'lastSeenTarget', 'lastRepeatSource', 'lastDecade', 'lastGame', 'lossStreak', 'suitStreak', 'remaining'];
const TRACKER_NULL = ['lastSentAt', 'lastInfo', 'day', 'prevDay', 'seg', 'lastSuit', 'armedKind'];

function wipeTracker(t) {
  if (!t || typeof t !== 'object') return;
  for (const k of TRACKER_ZERO) if (k in t && typeof t[k] === 'number') t[k] = 0;
  for (const k of TRACKER_NULL) if (k in t) t[k] = null;
  // configurations « 4 canaux » : chaque canal a son propre score (les ID et noms restent)
  if (Array.isArray(t.slots)) t.slots.forEach(wipeTracker);
}

function wipePanel(panel) {
  if (!panel || typeof panel !== 'object') return;
  for (const k of ARRAYS) if (Array.isArray(panel[k])) panel[k] = [];
  for (const k of OBJECTS) if (panel[k] && typeof panel[k] === 'object' && !Array.isArray(panel[k])) panel[k] = {};
  panel.sentCount = 0;
  panel.lastSentAt = null;
  panel.lastError = null;
  if (panel.bilan && typeof panel.bilan === 'object' && 'segSince' in panel.bilan) panel.bilan.segSince = null; // compteur du bilan
  if (Array.isArray(panel.trackers)) panel.trackers.forEach(wipeTracker);
  else if (panel.trackers && typeof panel.trackers === 'object') Object.values(panel.trackers).forEach(wipeTracker);
}

const MODULES = ['after-loss', 'combined', 'suit-streak', 'suit-break', 'overlap', 'vip', 'cards-count',
  'dizaine-top', 'costume-faible-top', 'predit', 'formation-relay', 'copy-announce', 'game21-predict', 'statistics'];

async function wipeData() {
  const report = { memory: [], db: [], errors: [] };
  const { state } = predictor;
  state.wiping = true; // rend muets le rapport PDF et le bilan de fin de sabot (voir bot.js)
  try {
    // mémoire du moteur : jeux, historique, compteurs, prédictions (+ table predictions
    // et hooks de remise à zéro de tous les panneaux via resetShoe)
    predictor.resetShoe('minuit 00h00 — nouveau départ');
    state.predictions = [];
    state.announcements = [];
    state.gates = {};
    state.autoGates = {};
    state.sendErrors = {};
    state.baselineNext = true; // les jeux déjà terminés du flux ne redéclenchent rien
    report.memory.push('jeux, historique, compteurs, prédictions, filtres, annonces');

    // compteurs / historiques / registres de chaque panneau (configurations intactes)
    for (const name of MODULES) {
      try {
        const mod = require(`./${name}`);
        if (mod && mod.panel) wipePanel(mod.panel);
        if (mod && typeof mod.persist === 'function') mod.persist();
        report.memory.push(name);
      } catch (e) { report.errors.push(`${name} : ${e.message}`); }
    }

    // base de données : uniquement les tables de DONNÉES
    if (db.ready) {
      for (const [label, sql] of [
        ['games', 'DELETE FROM games'],
        ['predictions', 'DELETE FROM predictions'],
        ['after_loss_sent', 'DELETE FROM after_loss_sent'],
        ['announcements', 'DELETE FROM announcements'],
        ['gates', 'DELETE FROM gates'],
        ['cumulative_analyses', 'DELETE FROM cumulative_analyses'],
      ]) {
        try { await db.exec(sql); report.db.push(label); }
        catch (e) { if (!/does not exist/i.test(e.message)) report.errors.push(`${label} : ${e.message}`); }
      }
    }
  } finally {
    // le drapeau reste levé un court instant : les hooks de fin de sabot s'exécutent en différé
    setTimeout(() => { state.wiping = false; }, 5000);
  }
  return report;
}

// ── exécution complète ────────────────────────────────────────────────────────
async function run(dayKey, { manual = false } = {}) {
  if (info.running) return { ok: false, error: 'déjà en cours' };
  info.running = true;
  try {
    const exportRes = await sendExport(dayKey);
    const wipe = await wipeData();
    info.lastRunAt = Date.now();
    info.lastReport = { day: dayKey, manual, export: exportRes, memory: wipe.memory.length, db: wipe.db, errors: wipe.errors.slice(0, 5) };
    persistInfo();
    const bot = typeof sender === 'function' ? sender() : null;
    const adminId = predictor.state.adminId;
    if (bot && adminId) {
      const lines = [
        manual ? '🧹 Nouveau départ (déclenché manuellement)' : '🧹 Nouveau départ — 00h00 (heure d\'Abidjan)',
        exportRes.ok ? '📦 Export de la configuration envoyé ci-dessus.' : `⚠️ Export non envoyé : ${exportRes.error}`,
        '🗑️ Effacé : jeux stockés, prédictions, compteurs et historiques de tous les panneaux.',
        '✅ Conservé : toutes les configurations (réglages, canaux, stratégies, panneaux, stratégies IA).',
      ];
      if (wipe.errors.length) lines.push(`⚠️ Erreurs : ${wipe.errors.slice(0, 3).join(' · ')}`);
      bot.sendMessage(adminId, lines.join('\n')).catch(() => {});
    }
    return { ok: true, export: exportRes, wipe };
  } catch (e) {
    info.lastReport = { day: dayKey, manual, error: e.message };
    persistInfo();
    return { ok: false, error: e.message };
  } finally {
    info.running = false;
  }
}

// appelé chaque seconde (bot.js)
async function check(now = Date.now()) {
  if (!enabled() || info.running) return;
  const p = parts(now);
  if (p.h !== 0 || p.m >= CATCHUP_MINUTES) return; // hors fenêtre 00h00–00h29
  if (info.lastDay === p.key) return;              // déjà fait aujourd'hui
  info.lastDay = p.key;                            // marqué AVANT : jamais deux passages le même jour
  persistInfo();
  await run(p.key);
}

function status() { return { enabled: enabled(), tz: TZ, lastDay: info.lastDay, lastRunAt: info.lastRunAt, lastReport: info.lastReport, running: info.running }; }

module.exports = { setSender, restore, restoreFromDb, check, run, status, wipeData, wipePanel, parts };
