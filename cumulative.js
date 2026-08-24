// cumulative.js — analyse CUMULATIVE par paliers de 4 jeux
//  • Palier 4  : avis sur les jeux 1 → 4
//  • Palier 8  : avis sur les jeux 1 → 8 (le cumul, pas seulement 5→8)
//  • Palier 12 : avis sur les jeux 1 → 12 … et ainsi de suite jusqu'à 1440.
//  • Chaque palier est enregistré pour la DATE du jour (table cumulative_analyses).
//  • Si la stratégie change (réglages modifiés), les paliers calculés avec
//    l'ancienne stratégie sont effacés puis recalculés : on n'archive jamais
//    une analyse qui n'est plus juste.
'use strict';

const crypto = require('crypto');
const ai = require('./ai-analyzer');
const db = require('./db');
const strategiesLib = require('./strategies');
const { state } = require('./predictor');

const STEP = 4;         // taille d'un palier
const MAX_GAMES = 1440; // dernier palier de la journée
const MEM_KEEP = 400;   // paliers gardés en mémoire

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cumulative_analyses (
  id           BIGSERIAL PRIMARY KEY,
  played_on    DATE        NOT NULL,
  up_to        INT         NOT NULL,
  first_game   BIGINT,
  last_game    BIGINT,
  sample       INT         NOT NULL DEFAULT 0,
  strategy_sig TEXT        NOT NULL DEFAULT '',
  verdict      TEXT,
  payload      JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (played_on, up_to)
);
CREATE INDEX IF NOT EXISTS cumulative_played_on_idx ON cumulative_analyses (played_on, up_to);
`;

const runtime = {
  date: today(),
  current: null,
  signature: '',
  checkpoints: [],   // { upTo, firstGame, lastGame, sample, verdict, findings, strategies, generatedAt }
  lastRunAt: null,
  lastError: null,
  purged: 0,
  schemaReady: false,
};

function today() { return new Date().toISOString().slice(0, 10); }

// signature des stratégies actives : sert à détecter un changement de stratégie
function strategySignature() {
  const rows = (strategiesLib.LIST || []).map((d) => {
    const cfg = (state.strategies && state.strategies[d.key]) || {};
    return [d.key, cfg.enabled === false ? 0 : 1, JSON.stringify(cfg)].join(':');
  });
  return crypto.createHash('sha1').update(rows.join('|')).digest('hex').slice(0, 16);
}

async function ensureSchema() {
  if (runtime.schemaReady || !db.ready) return runtime.schemaReady;
  const ok = await db.exec(SCHEMA);
  runtime.schemaReady = !!ok;
  return runtime.schemaReady;
}

function numberOf(g) { return Number(g.number ?? g.n); }

// liste ASCENDANTE, dédupliquée, des jeux terminés de la journée
async function todayGames() {
  const map = new Map();
  if (db.ready) {
    const rows = await db.gamesByDate(runtime.date, MAX_GAMES);
    for (const r of rows || []) {
      const n = numberOf(r);
      if (Number.isFinite(n)) map.set(n, r);
    }
  }
  for (const g of state.history || []) {
    if (g.finished === false) continue;
    const n = numberOf(g);
    if (Number.isFinite(n) && !map.has(n)) map.set(n, g);
  }
  return [...map.values()].sort((a, b) => numberOf(a) - numberOf(b)).slice(0, MAX_GAMES);
}

function verdictOf(result) {
  const parts = [];
  if (result.title) parts.push(result.title);
  if (result.observation) parts.push(result.observation);
  return parts.join(' — ').slice(0, 600);
}

// libellé lisible : « jeux #1 → #178 (178 jeux) »
function rangeLabel(firstGame, lastGame, sample) {
  if (!sample) return 'aucun jeu analysé';
  return `jeux #${firstGame ?? '?'} → #${lastGame ?? '?'} (${sample} jeu${sample > 1 ? 'x' : ''} analysé${sample > 1 ? 's' : ''})`;
}

function buildCheckpoint(gamesAsc, upTo, signature) {
  const slice = gamesAsc.slice(0, upTo);
  // localAnalysis attend les jeux du plus récent au plus ancien
  const result = ai.localAnalysis([...slice].reverse(), { maxGames: MAX_GAMES });
  return {
    date: runtime.date,
    upTo,
    firstGame: numberOf(slice[0]) || null,
    lastGame: numberOf(slice[slice.length - 1]) || null,
    sample: slice.length,
    range: rangeLabel(numberOf(slice[0]) || null, numberOf(slice[slice.length - 1]) || null, slice.length),
    signature,
    verdict: verdictOf(result),
    confidence: result.confidence || null,
    findings: result.findings || [],
    strategies: (result.strategies || []).map((s) => s.name).filter(Boolean),
    summary: result.localSummary || null,
    generatedAt: new Date().toISOString(),
  };
}

async function saveCheckpoint(cp) {
  if (!(await ensureSchema())) return false;
  const payload = {
    findings: cp.findings, strategies: cp.strategies,
    summary: cp.summary, confidence: cp.confidence,
  };
  const r = await db.exec(
    `INSERT INTO cumulative_analyses
       (played_on, up_to, first_game, last_game, sample, strategy_sig, verdict, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (played_on, up_to) DO UPDATE SET
       first_game = EXCLUDED.first_game, last_game = EXCLUDED.last_game,
       sample = EXCLUDED.sample, strategy_sig = EXCLUDED.strategy_sig,
       verdict = EXCLUDED.verdict, payload = EXCLUDED.payload, created_at = now()`,
    [cp.date, cp.upTo, cp.firstGame, cp.lastGame, cp.sample, cp.signature, cp.verdict, JSON.stringify(payload)]
  );
  return !!r;
}

// la stratégie a changé : on efface tout ce qui a été analysé avec l'ancienne
async function purgeStaleFor(signature) {
  const before = runtime.checkpoints.length;
  runtime.checkpoints = runtime.checkpoints.filter((c) => c.signature === signature);
  const removed = before - runtime.checkpoints.length;
  if (db.ready && (await ensureSchema())) {
    await db.exec(
      `DELETE FROM cumulative_analyses WHERE played_on = $1 AND strategy_sig <> $2`,
      [runtime.date, signature]
    );
  }
  runtime.purged += removed;
  return removed;
}

async function loadFromDb() {
  if (!(await ensureSchema())) return runtime.checkpoints;
  const rows = await db.rows(
    `SELECT * FROM cumulative_analyses WHERE played_on = $1 ORDER BY up_to ASC`,
    [runtime.date]
  );
  runtime.checkpoints = (rows || []).map((r) => ({
    date: runtime.date,
    upTo: r.up_to,
    firstGame: r.first_game != null ? Number(r.first_game) : null,
    lastGame: r.last_game != null ? Number(r.last_game) : null,
    sample: r.sample,
    range: rangeLabel(r.first_game != null ? Number(r.first_game) : null, r.last_game != null ? Number(r.last_game) : null, r.sample),
    signature: r.strategy_sig,
    verdict: r.verdict,
    confidence: (r.payload || {}).confidence || null,
    findings: (r.payload || {}).findings || [],
    strategies: (r.payload || {}).strategies || [],
    summary: (r.payload || {}).summary || null,
    generatedAt: r.created_at,
  }));
  return runtime.checkpoints;
}

let loaded = false;

// boucle principale : appelée à chaque jeu terminé / chaque tick d'analyse
async function tick() {
  try {
    const date = today();
    if (date !== runtime.date) {   // nouvelle journée : on repart de zéro
      runtime.date = date;
      runtime.checkpoints = [];
      loaded = false;
    }
    if (!loaded && db.ready) { await loadFromDb(); loaded = true; }

    const signature = strategySignature();
    if (runtime.signature && runtime.signature !== signature) {
      await purgeStaleFor(signature);       // stratégie modifiée → on efface l'incorrect
    }
    runtime.signature = signature;

    const games = await todayGames();
    const total = Math.min(games.length, MAX_GAMES);
    const done = new Set(runtime.checkpoints.map((c) => c.upTo));
    const created = [];

    for (let upTo = STEP; upTo <= total; upTo += STEP) {
      if (done.has(upTo)) continue;
      const cp = buildCheckpoint(games, upTo, signature);
      runtime.checkpoints.push(cp);
      created.push(cp);
      await saveCheckpoint(cp);
    }

    // palier « en cours » : couvre TOUS les jeux du jour, même hors multiple de 4
    // (ex. 178 jeux → « jeux #1 → #178 »). Il n'est pas enregistré en base.
    runtime.current = total
      ? { ...buildCheckpoint(games, total, signature), partial: total % STEP !== 0 }
      : null;

    runtime.checkpoints.sort((a, b) => a.upTo - b.upTo);
    if (runtime.checkpoints.length > MEM_KEEP) {
      runtime.checkpoints = runtime.checkpoints.slice(-MEM_KEEP);
    }
    runtime.lastRunAt = Date.now();
    runtime.lastError = null;
    return { created, total, date: runtime.date };
  } catch (e) {
    runtime.lastError = e.message;
    return { created: [], total: 0, date: runtime.date, error: e.message };
  }
}

async function byDate(date) {
  const d = date || runtime.date;
  if (d === runtime.date && runtime.checkpoints.length) return runtime.checkpoints;
  if (!(await ensureSchema())) return [];
  const rows = await db.rows(
    `SELECT * FROM cumulative_analyses WHERE played_on = $1 ORDER BY up_to ASC`, [d]
  );
  return (rows || []).map((r) => ({
    date: d, upTo: r.up_to, sample: r.sample,
    firstGame: r.first_game != null ? Number(r.first_game) : null,
    lastGame: r.last_game != null ? Number(r.last_game) : null,
    signature: r.strategy_sig, verdict: r.verdict,
    range: rangeLabel(r.first_game != null ? Number(r.first_game) : null, r.last_game != null ? Number(r.last_game) : null, r.sample),
    findings: (r.payload || {}).findings || [],
    strategies: (r.payload || {}).strategies || [],
    confidence: (r.payload || {}).confidence || null,
    generatedAt: r.created_at,
  }));
}

function status() {
  const last = runtime.checkpoints[runtime.checkpoints.length - 1] || null;
  const current = runtime.current || last;
  return {
    current,
    coverage: current
      ? { firstGame: current.firstGame, lastGame: current.lastGame, sample: current.sample, label: current.range }
      : { firstGame: null, lastGame: null, sample: 0, label: rangeLabel(null, null, 0) },
    date: runtime.date,
    step: STEP,
    maxGames: MAX_GAMES,
    signature: runtime.signature,
    count: runtime.checkpoints.length,
    purged: runtime.purged,
    lastRunAt: runtime.lastRunAt,
    lastError: runtime.lastError,
    last,
    checkpoints: runtime.checkpoints.slice(-20).reverse(),
  };
}

module.exports = { tick, status, byDate, rangeLabel, purgeStaleFor, strategySignature, STEP, MAX_GAMES, runtime };
