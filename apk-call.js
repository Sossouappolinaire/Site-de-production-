// apk-call.js — bouton « 📞 Appel APK » (v145, demande admin).
//
// L'application Android (projet « AppelPredictions », compilée sur GitHub Actions) se connecte à la base Supabase du site et lit la table
// « apk_calls » (sur les DEUX bases : principale + secours, voir db.js). Sur la page du bouton on CHOISIT le ou les canaux que l'APK doit surveiller : dès qu'une prédiction est LANCÉE dans un de
// ces canaux (envoyée par le bot du site, ou publiée par un autre bot dans un canal que le bot du site lit), une ligne est écrite dans
// « apk_calls » ; l'APK la voit en quelques secondes et fait sonner le téléphone comme un appel entrant, jusqu'à ce qu'on décroche.
//
//  • Une ligne par prédiction lancée (jeu, costume(s), canal). Jamais de doublon pour le même canal + jeu + costume.
//  • Les prédictions sont lues depuis le point d'envoi unique de bot.js (onOwnPost) et depuis les publications de canal (onChannelPost),
//    avec la même lecture que « Confirmation » / « Relance après perte » (loss-return.js parsePost). Les messages de test (🧪) sont ignorés.
//  • La table est créée par le site au démarrage (CREATE TABLE IF NOT EXISTS) avec lecture seule pour l'APK (clé publique « anon » + RLS).
//    Si la création automatique échoue, le SQL de secours (apk-call.sql) est affiché sur la page.
//  • Remise à zéro de 00h00 : les lignes du jour sont effacées, les réglages (canaux choisis) sont conservés.
'use strict';

const store = require('./store');
const db = require('./db');
const loss = require('./loss-return'); // parseChannels, parsePost

const DB_KEY = 'apk_call_state';
const STORE_KEY = 'apkCall';
const DEDUPE_MS = 15 * 60 * 1000;
const RECENT_MAX = 12;
const REF = 'kmvbsntmzjkpwwqgkqhz'; // projet Supabase du site (voir db-link.js)

const panel = {
  enabled: false, channels: [], channelTitles: {},
  sentCount: 0, lastAt: null, lastError: null,
  tableReady: false, tableError: null, tableTriedAt: 0,
  tableBases: {}, // { principale: true, secours: true } : table apk_calls prête sur chaque base
  recent: [], seen: {}, // seen : { 'canal:jeu:costumes' : timestamp }
};

const SQL = [
  `CREATE TABLE IF NOT EXISTS public.apk_calls (
     id           BIGSERIAL PRIMARY KEY,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     channel_id   TEXT NOT NULL,
     channel_name TEXT NOT NULL DEFAULT '',
     game_number  INTEGER,
     suit         TEXT NOT NULL DEFAULT '',
     kind         TEXT NOT NULL DEFAULT 'prediction',
     message      TEXT NOT NULL DEFAULT ''
   )`,
  'ALTER TABLE public.apk_calls ENABLE ROW LEVEL SECURITY',
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apk_calls' AND policyname = 'apk_calls_lecture') THEN
       CREATE POLICY apk_calls_lecture ON public.apk_calls FOR SELECT TO anon USING (true);
     END IF;
   END $$`,
  'GRANT SELECT ON public.apk_calls TO anon',
  "NOTIFY pgrst, 'reload schema'",
];
const SQL_TEXT = `${SQL.join(';\n\n')};`;

const clean = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, n);
const keyOf = (id) => String(id == null ? '' : id).trim();

// La table doit exister sur CHAQUE base saine (principale + secours) : l'appli Android lit les deux.
async function ensureTable() {
  if (!db.ready) { panel.tableReady = false; return false; }
  const okNames = db.status().bases.filter((b) => b.etat === 'ok').map((b) => b.nom);
  const readyNow = () => okNames.some((n) => panel.tableBases[n]);
  const missing = okNames.filter((n) => !panel.tableBases[n]);
  if (!missing.length) { panel.tableReady = readyNow(); return panel.tableReady; }
  if (Date.now() - panel.tableTriedAt < 60000) { panel.tableReady = readyNow(); return panel.tableReady; }
  panel.tableTriedAt = Date.now();
  const errors = [];
  await db.eachBase(async (query, nom) => {
    if (panel.tableBases[nom]) return;
    // table déjà créée (par le site ou à la main dans Supabase) : rien à refaire, les droits sont déjà posés
    const there = await query("SELECT to_regclass('public.apk_calls') AS t");
    if (there && there.rows[0] && there.rows[0].t) { panel.tableBases[nom] = true; return; }
    let failed = null;
    for (const sql of SQL) {
      const r = await query(sql);
      if (r === null) { failed = sql.split('\n')[0].slice(0, 60); if (/^CREATE TABLE/.test(sql)) break; }
    }
    const check = await query("SELECT to_regclass('public.apk_calls') AS t");
    panel.tableBases[nom] = !!(check && check.rows[0] && check.rows[0].t);
    if (!panel.tableBases[nom]) errors.push(`base ${nom} : création de la table impossible : exécute le SQL de secours dans Supabase (SQL Editor)`);
    else if (failed) errors.push(`base ${nom} : table créée, mais « ${failed} » a échoué : exécute le SQL de secours dans Supabase (SQL Editor)`);
  });
  panel.tableReady = readyNow();
  panel.tableError = errors.length ? errors.join(' • ') : null;
  return panel.tableReady;
}

// Une ligne par appel sur CHAQUE base saine (principale + secours) : l'APK lit les deux et ignore le doublon.
async function insertCall(channelId, channelName, gameNumber, suit, kind, message) {
  if (!(await ensureTable())) { panel.lastError = panel.tableError || 'Base Supabase non connectée'; return false; }
  const params = [String(channelId), clean(channelName, 120), gameNumber == null ? null : Number(gameNumber), suit, kind, clean(message, 300)];
  const res = await db.eachBase(async (query, nom) => {
    if (!panel.tableBases[nom]) return null;
    return query('INSERT INTO public.apk_calls (channel_id, channel_name, game_number, suit, kind, message) VALUES ($1,$2,$3,$4,$5,$6)', params);
  });
  if (!res.some((x) => x.ok && x.result)) { panel.lastError = 'écriture dans Supabase impossible (principale et secours)'; return false; }
  panel.lastError = null;
  return true;
}

function isChosen(chatId, username) {
  const id = keyOf(chatId); const un = username ? `@${String(username).toLowerCase()}` : null;
  return (panel.channels || []).some((c) => String(c) === id || (un && String(c).toLowerCase() === un));
}

// prédiction vue dans un canal choisi (envoyée par ce bot ou publiée par un autre bot) → ligne dans apk_calls
function observe(chat, text) {
  try {
    if (!panel.enabled || !chat || chat.id == null || !isChosen(chat.id, chat.username)) return false;
    const post = loss.parsePost(text);
    if (!post) return false;
    const suits = post.suits.join(' ');
    const k = `${keyOf(chat.id)}:${post.target}:${suits}`;
    const now = Date.now();
    if (panel.seen[k] && now - panel.seen[k] < DEDUPE_MS) return false;
    panel.seen[k] = now;
    for (const [kk, t] of Object.entries(panel.seen)) if (now - t > DEDUPE_MS) delete panel.seen[kk];
    const name = (chat.title ? String(chat.title) : '') || panel.channelTitles[keyOf(chat.id)] || keyOf(chat.id);
    if (chat.title) panel.channelTitles[keyOf(chat.id)] = String(chat.title).slice(0, 120);
    insertCall(chat.id, name, post.target, suits, 'prediction', text).then((ok) => {
      if (!ok) return;
      panel.sentCount += 1; panel.lastAt = Date.now();
      panel.recent.unshift({ at: panel.lastAt, channel: name, target: post.target, suit: suits });
      panel.recent = panel.recent.slice(0, RECENT_MAX);
      persist();
    });
    return true;
  } catch (e) { panel.lastError = e.message; return false; }
}
const onOwnPost = (chatId, text) => observe({ id: chatId }, text);
const onChannelPost = (chat, text) => observe(chat, text);

// appelé à chaque passage du bot : crée la table dès que la base est connectée, nettoie les lignes de plus de 24 h
let lastPurge = 0;
async function tick() {
  try {
    if (!panel.enabled || !db.ready) return;
    if (!(await ensureTable())) return;
    if (Date.now() - lastPurge > 3600 * 1000) { lastPurge = Date.now(); await db.eachBase(async (query, nom) => (panel.tableBases[nom] ? query("DELETE FROM public.apk_calls WHERE created_at < now() - interval '1 day'") : null)); }
  } catch (e) { panel.lastError = e.message; }
}

// appel de test : l'APK sonne comme pour une vraie prédiction
async function test() {
  const ok = await insertCall('test', 'Test', 0, '♦️', 'test', '🧪 Test d’appel depuis le site');
  if (ok) { panel.recent.unshift({ at: Date.now(), channel: 'Test', target: 0, suit: '♦️', test: true }); panel.recent = panel.recent.slice(0, RECENT_MAX); persist(); }
  return ok ? { ok: true } : { ok: false, error: panel.lastError || panel.tableError || 'Envoi impossible' };
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = loss.parseChannels(patch.channels).map(String);
  persist();
  return config_();
}
function config_() { return { enabled: panel.enabled, channels: [...panel.channels] }; }
function setChannelTitle(id, title) { const k = keyOf(id); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }

function status() {
  return {
    ...config_(), channelNames: panel.channels.map((id) => panel.channelTitles[String(id)] || String(id)), channelTitles: panel.channelTitles,
    sentCount: panel.sentCount, lastAt: panel.lastAt, lastError: panel.lastError,
    dbReady: !!db.ready, tableReady: panel.tableReady, tableError: panel.tableError, bases: db.status().bases, tableBases: { ...panel.tableBases },
    supabaseUrl: `https://${REF}.supabase.co`, sql: SQL_TEXT, recent: panel.recent,
  };
}

let dbDirty = false;
function persist() {
  const saved = { config: config_(), channelTitles: panel.channelTitles, sentCount: panel.sentCount, lastAt: panel.lastAt, recent: panel.recent };
  try { store.patch({ [STORE_KEY]: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).then(() => { dbDirty = false; }).catch((e) => { panel.lastError = e.message; dbDirty = true; });
  else dbDirty = true;
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  const c = saved.config || {};
  panel.enabled = c.enabled === true; panel.channels = loss.parseChannels(c.channels).map(String);
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
  panel.sentCount = Number(saved.sentCount) || 0; panel.lastAt = saved.lastAt || null;
  panel.recent = Array.isArray(saved.recent) ? saved.recent.slice(0, RECENT_MAX) : [];
}
function restore() { try { const s = (store.read() || {})[STORE_KEY]; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  if (dbDirty) { persist(); return; }
  try { const raw = await db.getSetting(DB_KEY); if (raw) { applySaved(JSON.parse(raw)); persist(); } else persist(); } catch (_) { persist(); }
}

// remise à zéro de 00h00 : lignes du jour effacées dans Supabase, réglages conservés
function wipeDay() {
  panel.sentCount = 0; panel.lastAt = null; panel.lastError = null; panel.recent = []; panel.seen = {};
  if (db.ready && panel.tableReady) db.eachBase(async (query, nom) => (panel.tableBases[nom] ? query('DELETE FROM public.apk_calls') : null)).catch(() => {});
  persist();
}

module.exports = { panel, restore, restoreFromDb, persist, tick, status, test, configure, config: config_, setChannelTitle, onOwnPost, onChannelPost, wipeDay, SQL_TEXT };
