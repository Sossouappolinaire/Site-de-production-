// cleanup.js — NETTOYAGE AUTOMATIQUE pour alléger le site (demande admin).
//
// Pourquoi : sur Render (plan gratuit) le disque est éphémère et la mémoire limitée ; Supabase a une taille
// maximale. Tout ce qui s'accumule sans jamais être effacé finit par alourdir le service (redémarrages,
// quota atteint, base pleine). Ce module efface régulièrement, SANS toucher à aucune configuration :
//
//  1. DISQUE   : sauvegardes de la « Réparation IA » (.repair-backups : on garde les N plus récentes par
//                fichier et rien de plus vieux que X jours), fichiers temporaires oubliés (repair-*,
//                bootstrap-check-*), fichiers .tmp / .bak / .log traînant à la racine du projet.
//  2. BASE     : anti-doublons expirés (sent_dedupe), codes e-mail expirés, sessions expirées, anciennes
//                analyses IA (on garde les dernières), annonces et prédictions de plus de N jours,
//                stratégies IA de plus de 60 min, jeux au-delà de la limite.
//  3. ÉTAT     : listes d'historique démesurées dans data.json (plafonnées aux N dernières entrées).
//  4. MÉMOIRE  : demande un passage du ramasse-miettes si Node a été lancé avec --expose-gc.
//
// Réglages (facultatifs) : data.json → cleanup { enabled, intervalMin, ... } — voir DEFAULTS.
// Désactivation totale : CLEANUP=off.   Lancement manuel : POST /api/cleanup/run (admin).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const BACKUP_DIR = path.join(ROOT, '.repair-backups');

const DEFAULTS = {
  enabled: true,
  intervalMin: 60,          // fréquence du nettoyage
  firstRunDelaySec: 90,     // premier passage peu après le démarrage
  backupKeepPerFile: 3,     // sauvegardes de la Réparation IA gardées par fichier
  backupMaxDays: 3,         // et jamais plus vieilles que ça
  tmpMaxHours: 6,           // fichiers temporaires oubliés
  looseFilesMaxDays: 1,     // *.tmp / *.bak / *.log à la racine
  dedupeHours: 24,          // anti-doublons (table sent_dedupe)
  analysesKeep: 30,         // analyses IA gardées en base
  announcementsDays: 2,     // annonces de position
  predictionsDays: 2,       // prédictions (le « nouveau départ » de minuit les efface déjà chaque jour)
  storeArrayCap: 1500,      // entrées max d'une liste d'historique dans data.json
};

// noms de listes considérées comme des historiques (jamais « catalog », « dialog »… : le nom doit être explicite)
const isHistoryKey = (k) => /histor|journal|archive|recent/i.test(k)
  || /^(log|logs|messages|events|results|resultats|sent)$/i.test(k)
  || /[a-z](Log|Logs|Events|Messages)$/.test(k);

const info = { running: false, lastRunAt: null, lastDurationMs: 0, lastReport: null, runs: 0, totalFreedBytes: 0 };
let timer = null;
let firstTimer = null;

const enabled = () => !/^(off|0|false)$/i.test(String(process.env.CLEANUP || ''));

function cfg() {
  let saved = {};
  try { saved = (require('./store').read() || {}).cleanup || {}; } catch (_) { /* défauts */ }
  const c = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (saved[k] === undefined) continue;
    if (typeof DEFAULTS[k] === 'boolean') c[k] = !!saved[k];
    else if (Number.isFinite(Number(saved[k])) && Number(saved[k]) >= 0) c[k] = Number(saved[k]);
  }
  c.intervalMin = Math.max(5, c.intervalMin);
  c.storeArrayCap = Math.max(100, c.storeArrayCap);
  c.analysesKeep = Math.max(1, Math.floor(c.analysesKeep));
  return c;
}

// ── DISQUE ────────────────────────────────────────────────────────────────────
function listFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else if (e.isFile()) {
      try { const st = fs.statSync(p); out.push({ path: p, size: st.size, mtime: st.mtimeMs }); } catch (_) { /* disparu entre-temps */ }
    }
  }
  return out;
}

function removeEmptyDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
  if (dir !== BACKUP_DIR) { try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch (_) { /* tant pis */ } }
}

function del(file) {
  try { fs.unlinkSync(file.path); return file.size; } catch (_) { return 0; }
}

function cleanBackups(c) {
  const rep = { files: 0, bytes: 0 };
  if (!fs.existsSync(BACKUP_DIR)) return rep;
  const now = Date.now();
  const groups = new Map(); // fichier d'origine → sauvegardes
  for (const f of listFiles(BACKUP_DIR)) {
    const key = f.path.replace(/\.\d{10,}\.bak$/, ''); // enlève « .<horodatage>.bak »
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const files of groups.values()) {
    files.sort((a, b) => b.mtime - a.mtime);
    files.forEach((f, i) => {
      const tooMany = i >= c.backupKeepPerFile;
      const tooOld = now - f.mtime > c.backupMaxDays * 86400000;
      if (tooMany || tooOld) { const b = del(f); if (b || f.size === 0) { rep.files++; rep.bytes += b; } }
    });
  }
  removeEmptyDirs(BACKUP_DIR);
  return rep;
}

function cleanTmp(c) {
  const rep = { files: 0, bytes: 0 };
  const now = Date.now();
  // 1. dossier temporaire du système : seulement NOS fichiers (préfixes connus)
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!/^(repair-|bootstrap-check-)/.test(name)) continue;
      const p = path.join(os.tmpdir(), name);
      let st; try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isFile() && now - st.mtimeMs > c.tmpMaxHours * 3600000) { const b = del({ path: p, size: st.size }); rep.files++; rep.bytes += b; }
    }
  } catch (_) { /* tmp illisible */ }
  // 2. racine du projet : *.tmp / *.bak / *.log oubliés (jamais data.json ni le code)
  try {
    for (const name of fs.readdirSync(ROOT)) {
      if (!/\.(tmp|bak|log|orig)$/i.test(name)) continue;
      const p = path.join(ROOT, name);
      let st; try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isFile() && now - st.mtimeMs > c.looseFilesMaxDays * 86400000) { const b = del({ path: p, size: st.size }); rep.files++; rep.bytes += b; }
    }
  } catch (_) { /* racine illisible */ }
  return rep;
}

// ── ÉTAT (data.json) ──────────────────────────────────────────────────────────
// Plafonne UNIQUEMENT les listes dont le nom ressemble à un historique et qui dépassent le plafond.
// Les listes de configuration (canaux, stratégies, formats…) ne sont jamais raccourcies.
function capHistoryArrays(obj, cap, trail, stats) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj; // les tableaux ne sont traités que via leur clé parente
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v)) {
      if (v.length > cap && isHistoryKey(k)) {
        stats.cut += v.length - cap; stats.lists.push(`${trail}${k}`);
        obj[k] = v.slice(-cap);
      }
    } else if (v && typeof v === 'object' && trail.split('.').length < 5) {
      capHistoryArrays(v, cap, `${trail}${k}.`, stats);
    }
  }
  return obj;
}

function cleanStore(c) {
  const rep = { cut: 0, lists: [], bytesBefore: 0, bytesAfter: 0 };
  try {
    const store = require('./store');
    const data = store.read();
    if (!data || typeof data !== 'object') return rep;
    const before = JSON.stringify(data).length;
    rep.bytesBefore = before;
    const stats = { cut: 0, lists: [] };
    capHistoryArrays(data, c.storeArrayCap, '', stats);
    rep.cut = stats.cut; rep.lists = stats.lists.slice(0, 20);
    if (stats.cut > 0) {
      rep.bytesAfter = JSON.stringify(data).length;
      store.write(data); // écrit data.json et le miroir vers la base
    } else rep.bytesAfter = before;
  } catch (e) { rep.error = e.message; }
  return rep;
}

// ── BASE DE DONNÉES ───────────────────────────────────────────────────────────
async function cleanDb(c) {
  const rep = { ready: false, deleted: {}, errors: [] };
  let db;
  try { db = require('./db'); } catch (e) { rep.errors.push(e.message); return rep; }
  if (!db.ready) return rep;
  rep.ready = true;

  const jobs = [
    ['sent_dedupe',   `DELETE FROM sent_dedupe WHERE created_at < now() - ($1 || ' hours')::interval`, [String(c.dedupeHours)]],
    ['email_codes',   `DELETE FROM email_codes WHERE expires_at < now() - interval '1 hour'`, []],
    ['user_sessions', `DELETE FROM user_sessions WHERE expire < now()`, []],
    ['ai_analyses',   `DELETE FROM ai_analyses WHERE id NOT IN (SELECT id FROM ai_analyses ORDER BY id DESC LIMIT ${c.analysesKeep})`, []],
    ['announcements', `DELETE FROM announcements WHERE created_at < now() - ($1 || ' days')::interval`, [String(c.announcementsDays)]],
    ['predictions',   `DELETE FROM predictions WHERE created_at < now() - ($1 || ' days')::interval`, [String(c.predictionsDays)]],
  ];
  for (const [name, sql, params] of jobs) {
    try {
      const r = await db.exec(sql, params);
      if (r && typeof r.rowCount === 'number') rep.deleted[name] = r.rowCount;
      else if (r === null) rep.deleted[name] = null; // table absente, base en lecture seule ou injoignable : ignoré
    } catch (e) { rep.errors.push(`${name}: ${e.message}`); }
  }
  try { const ids = await db.pruneAiStrategies(); rep.deleted.ai_strategies = Array.isArray(ids) ? ids.length : 0; } catch (e) { rep.errors.push('ai_strategies: ' + e.message); }
  return rep;
}

// ── MÉMOIRE ───────────────────────────────────────────────────────────────────
function memoryMb() {
  const m = process.memoryUsage();
  return { rssMb: Math.round(m.rss / 1048576), heapUsedMb: Math.round(m.heapUsed / 1048576) };
}

function cleanMemory() {
  const before = memoryMb();
  let gc = false;
  try { if (typeof global.gc === 'function') { global.gc(); gc = true; } } catch (_) { /* pas de gc exposé */ }
  return { gc, before, after: memoryMb() };
}

// ── ORCHESTRATION ─────────────────────────────────────────────────────────────
async function runOnce(reason = 'auto') {
  if (info.running) return { skipped: 'déjà en cours', ...info.lastReport };
  info.running = true;
  const t0 = Date.now();
  const c = cfg();
  const report = { reason, at: new Date().toISOString() };
  try {
    report.backups = cleanBackups(c);
    report.tmp = cleanTmp(c);
    report.store = cleanStore(c);
    report.db = await cleanDb(c);
    report.memory = cleanMemory();
    const freed = (report.backups.bytes || 0) + (report.tmp.bytes || 0) + Math.max(0, (report.store.bytesBefore || 0) - (report.store.bytesAfter || 0));
    report.freedBytes = freed;
    info.totalFreedBytes += freed;
  } catch (e) {
    report.error = e.message;
    console.error('⚠️ Nettoyage automatique :', e.message);
  } finally {
    info.running = false;
    info.runs++;
    info.lastRunAt = report.at;
    info.lastDurationMs = Date.now() - t0;
    info.lastReport = report;
  }
  const dbTotal = Object.values(report.db && report.db.deleted || {}).reduce((s, n) => s + (Number(n) || 0), 0);
  console.log(`🧹 Nettoyage (${reason}) : ${report.backups ? report.backups.files : 0} sauvegarde(s) + ${report.tmp ? report.tmp.files : 0} fichier(s) temp. supprimés, ${dbTotal} ligne(s) de base effacée(s), ${report.store ? report.store.cut : 0} entrée(s) d'historique coupée(s) — ${info.lastDurationMs} ms.`);
  return report;
}

function schedule() {
  if (timer) clearInterval(timer);
  const c = cfg();
  timer = setInterval(() => {
    if (!cfg().enabled) return;
    runOnce('auto').catch((e) => console.error('⚠️ Nettoyage :', e.message));
  }, c.intervalMin * 60000);
  if (timer.unref) timer.unref();
}

function start() {
  if (!enabled()) { console.log('🧹 Nettoyage automatique désactivé (CLEANUP=off).'); return; }
  if (timer || firstTimer) return; // déjà démarré
  const c = cfg();
  firstTimer = setTimeout(() => {
    firstTimer = null;
    if (cfg().enabled) runOnce('démarrage').catch((e) => console.error('⚠️ Nettoyage :', e.message));
  }, c.firstRunDelaySec * 1000);
  if (firstTimer.unref) firstTimer.unref();
  schedule();
  console.log(`🧹 Nettoyage automatique actif : toutes les ${c.intervalMin} min.`);
}

function status() {
  return { enabled: enabled() && cfg().enabled, config: cfg(), ...info, memory: memoryMb() };
}

// Modifie les réglages depuis le site (valeurs validées, le reste est ignoré).
function setConfig(partial = {}) {
  const store = require('./store');
  const cur = (store.read() || {}).cleanup || {};
  const next = { ...cur };
  for (const k of Object.keys(DEFAULTS)) {
    if (partial[k] === undefined) continue;
    if (typeof DEFAULTS[k] === 'boolean') next[k] = !!partial[k];
    else if (Number.isFinite(Number(partial[k])) && Number(partial[k]) >= 0) next[k] = Number(partial[k]);
  }
  store.patch({ cleanup: next });
  schedule();
  return cfg();
}

module.exports = { start, runOnce, status, setConfig, DEFAULTS };
