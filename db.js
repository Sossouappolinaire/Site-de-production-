// db.js — persistance PostgreSQL (Render) : jeux passés par date, prédictions, réglages
// Le lien de la base se règle via DATABASE_URL, /setdb dans Telegram, ou le panel web.
// Les tables sont créées automatiquement au premier démarrage.
let Pool = null;
try { Pool = require('pg').Pool; } catch (_) { /* pg installé au déploiement */ }
const config = require('./config');
const store = require('./store');
const { databaseUrl, backupUrl } = require('./database-url');

// Deux bases Supabase : PRINCIPALE (0) et SECOURS (1). Les écritures vont aux deux (miroir), les lectures à la base
// « active ». Si la base active est pleine (lecture seule) ou injoignable, l'autre prend le relais automatiquement.
//   état d'une base : 'ok' (lecture + écriture) · 'ro' (pleine / lecture seule) · 'down' (injoignable ou non configurée)
const targets = [
  { i: 0, name: 'principale', pool: null, url: '', state: 'down', error: null, schemaDone: false, mirrorPending: 0 },
  { i: 1, name: 'secours',    pool: null, url: '', state: 'down', error: null, schemaDone: false, mirrorPending: 0 },
];
let active = 0;      // base lue en priorité
let ready = false;   // au moins une base utilisable
let lastError = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- état complet du site (équivalent de data.json : compteurs, configurations)
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- anti-doublon des messages / prédictions envoyés aux canaux (send-dedupe.js)
CREATE TABLE IF NOT EXISTS sent_dedupe (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  channel    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sent_dedupe_kind_idx ON sent_dedupe (kind);

CREATE TABLE IF NOT EXISTS games (
  number        BIGINT PRIMARY KEY,
  played_on     DATE        NOT NULL,
  played_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  winner        TEXT,                     -- Joueur / Banquier / Égalité
  player_cards  TEXT[]      DEFAULT '{}', -- ex: {"A♠️","7❤️"}
  banker_cards  TEXT[]      DEFAULT '{}',
  player_suits  TEXT[]      DEFAULT '{}', -- costumes de la main joueur
  banker_suits  TEXT[]      DEFAULT '{}',
  player_value  INT,                      -- valeur baccara 0..9
  banker_value  INT,
  player_parity TEXT,                     -- pair / impair
  banker_parity TEXT,
  player_count  INT,                      -- nombre de cartes
  banker_count  INT,
  phase         TEXT,
  raw           JSONB
);
CREATE INDEX IF NOT EXISTS games_played_on_idx ON games (played_on);

CREATE TABLE IF NOT EXISTS predictions (
  id           BIGSERIAL PRIMARY KEY,
  played_on    DATE        NOT NULL DEFAULT current_date,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  target       BIGINT      NOT NULL,
  suit         TEXT        NOT NULL,
  hand         TEXT        NOT NULL,
  b_value      INT,
  b_counter    INT,
  max_r        INT,
  status       TEXT,                       -- attente / gagne / perdu
  rattrapage   INT,
  hit_number   BIGINT,
  closed_at    TIMESTAMPTZ,
  UNIQUE (target, suit, hand)
);

CREATE TABLE IF NOT EXISTS strategies (
  key        TEXT PRIMARY KEY,
  name       TEXT,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  config     JSONB   NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- filtre d'envoi « double perte » (mode silencieux) de chaque stratégie :
-- sans cette table, l'état (phase, pertes de référence, écart mesuré…)
-- ne vivait qu'en RAM et repartait de zéro à chaque redémarrage du process
-- (veille/redéploiement Render Free), même si 2 pertes venaient de tomber.
CREATE TABLE IF NOT EXISTS gates (
  key        TEXT PRIMARY KEY,
  payload    JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- annonces de position de la stratégie « ombre » (bouton /ombreannonces) :
-- sans cette table, la liste ne vivait qu'en RAM (state.announcements) et
-- repartait de zéro à chaque redémarrage du process (veille/redéploiement
-- Render Free) — même quand le filtre « gates » ci-dessus, lui, survivait
-- correctement. Résultat : le panneau affichait « Aucune annonce pour
-- l'instant » alors que la phase 2/3 était bien confirmée. Même logique de
-- persistance que pour « gates », appliquée cette fois à chaque entrée.
CREATE TABLE IF NOT EXISTS announcements (
  id          BIGINT PRIMARY KEY,
  strategy    TEXT NOT NULL,
  ref_number  BIGINT,
  position    INT,
  status      TEXT NOT NULL DEFAULT 'en_attente',
  sent_number BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS announcements_strategy_idx ON announcements (strategy, id DESC);

ALTER TABLE predictions ADD COLUMN IF NOT EXISTS strategy TEXT DEFAULT 'costume';
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS label    TEXT;
-- raison humaine de la prédiction (ex. « ❤️ absent pendant 5 jeux consécutifs
-- … retour au jeu #N959 → prédiction ❤️ sur #N963 »), fournie par detect() dans
-- strategies.js. Persistée pour que le module de questions-réponses IA (voir
-- ai-qa.js) puisse expliquer une prédiction même après un redémarrage/purge
-- mémoire (state.predictions ne garde que les 300 dernières).
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE predictions DROP CONSTRAINT IF EXISTS predictions_target_suit_hand_key;
CREATE UNIQUE INDEX IF NOT EXISTS predictions_uniq_idx ON predictions (strategy, target, suit);

-- stratégies proposées par l'IA (taux >= 75% au moment de la création) :
-- enregistrées durablement, indépendamment du fichier local data.json.
CREATE TABLE IF NOT EXISTS ai_strategies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  logic       TEXT,
  trigger_txt TEXT,
  target_txt  TEXT,
  evidence    TEXT,
  risks       TEXT,
  rate        NUMERIC,
  support     INT,
  minimum_sample INT,
  compatible_existing TEXT,
  origin      TEXT,
  active      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- suivi du taux dans le temps (stratégies IA restées à 90% sans descendre)
ALTER TABLE ai_strategies ADD COLUMN IF NOT EXISTS rate_min NUMERIC;
ALTER TABLE ai_strategies ADD COLUMN IF NOT EXISTS rate_max NUMERIC;
ALTER TABLE ai_strategies ADD COLUMN IF NOT EXISTS observations INT NOT NULL DEFAULT 1;
ALTER TABLE ai_strategies ADD COLUMN IF NOT EXISTS rate_history JSONB;
ALTER TABLE ai_strategies ADD COLUMN IF NOT EXISTS occurrences JSONB;

-- Toutes les analyses IA sont conservées séparément des stratégies proposées.
-- Le payload JSONB garde les découvertes, résumés et résultats complets.
CREATE TABLE IF NOT EXISTS ai_analyses (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL DEFAULT 'local',
  analyzed_on  DATE,
  sample       INT,
  title        TEXT,
  confidence   TEXT,
  observation  TEXT,
  payload      JSONB NOT NULL DEFAULT '{}',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_analyses_generated_idx ON ai_analyses (generated_at DESC);

-- comptes du tableau de bord web : le compte admin fixe (identifier=nom
-- d'utilisateur) et les comptes créés par email @gmail.com (identifier=email).
-- Table dédiée « baccara_users » : la base peut être partagée avec un autre
-- service qui possède déjà sa propre table « users » (colonnes différentes).
-- On ne touche jamais à cette table voisine.
CREATE TABLE IF NOT EXISTS baccara_users (
  id            BIGSERIAL PRIMARY KEY,
  identifier    TEXT UNIQUE NOT NULL,
  email         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  verified      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- codes de confirmation par email (inscription) : un seul code actif par
-- email, remplacé à chaque nouvel envoi, expire après 15 minutes.
CREATE TABLE IF NOT EXISTS email_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- validation manuelle par l'administrateur, après le code email : un compte
-- « user » vérifié par email reste en attente (approved=false) tant que
-- l'administrateur ne l'a pas accepté depuis le panneau « Utilisateurs ».
-- L'admin accorde alors un temps d'accès (access_expires_at) ; une fois ce
-- délai dépassé, le compte est considéré bloqué (blocked=true) et redirigé
-- vers Telegram depuis la page de connexion.
ALTER TABLE baccara_users ADD COLUMN IF NOT EXISTS approved          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE baccara_users ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ;
ALTER TABLE baccara_users ADD COLUMN IF NOT EXISTS blocked           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE baccara_users ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ;
-- le compte admin fixe n'a jamais besoin de validation (au cas où la colonne
-- vient d'être ajoutée sur une base déjà en place, avec l'admin déjà semé).
UPDATE baccara_users SET approved = true, blocked = false WHERE role = 'admin' AND approved = false;

-- ANTI-DOUBLON « prédiction après une perte » (toutes catégories, 1/2/3) :
-- registre PERSISTANT de chaque prédiction relayée par le panneau
-- « Prédiction après une perte ». La clé unique (target, suit) garantit, au
-- niveau de la BASE elle-même, qu'un même numéro de jeu avec le même costume
-- ne peut jamais être envoyé deux fois (même après un redémarrage du bot, une
-- session série/dizaine reprise, ou deux configurations qui tombent sur la
-- même cible).
CREATE TABLE IF NOT EXISTS after_loss_sent (
  id           BIGSERIAL PRIMARY KEY,
  target       BIGINT NOT NULL,
  suit         TEXT   NOT NULL,
  tracker_id   TEXT,
  tracker_name TEXT,
  category     INT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS after_loss_sent_key_idx ON after_loss_sent (target, suit);
`;

function status() {
  const t = targets[active];
  const shown = t.url || (t.i === 0 ? databaseUrl() : backupUrl());
  return {
    configured: !!(databaseUrl() || backupUrl()),
    games: { ...gameSave, pending: pendingGames.length },
    ready,
    error: lastError,
    url: mask(shown),
    active: t.name,
    bases: targets.map((x) => ({
      nom: x.name,
      etat: x.state,
      url: mask(x.url || (x.i === 0 ? databaseUrl() : backupUrl())) || null,
      erreur: x.state === 'ok' ? null : x.error,
    })),
  };
}

function mask(u) {
  if (!u) return null;
  return u.replace(/\/\/([^:]+):[^@]*@/, '//$1:••••@');
}

// ---- classement des erreurs : « base pleine » / « base injoignable » / erreur SQL normale ----
function isFullError(e) {
  const m = String((e && e.message) || '');
  return !!e && (['25006', '53100', '53200'].includes(e.code)
    || /read-only transaction|no space left|could not extend file|disk full|database is full/i.test(m));
}
function isDownError(e) {
  const m = String((e && e.message) || '');
  return !!e && (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', '57P01', '57P02', '57P03', '53300', '08000', '08001', '08003', '08004', '08006'].includes(e.code)
    || /connection terminated|connection timeout|timeout exceeded when trying to connect|connection refused|starting up|shutting down|too many clients|remaining connection slots|tenant or user not found/i.test(m));
}
const isRead = (sql) => /^\s*(SELECT|SHOW|EXPLAIN|WITH)\b/i.test(sql)
  && !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql) && !/\bFOR\s+(UPDATE|SHARE)\b/i.test(sql);

// Choisit la base « active » : on garde l'actuelle tant qu'elle est saine ; sinon l'autre si elle est saine ;
// à défaut une base en lecture seule (lire vaut mieux que rien).
function pickActive() {
  if (targets[active].state !== 'ok') {
    const other = targets[1 - active];
    if (other.state === 'ok') {
      console.log(`🔁 Base ${targets[active].name} ${targets[active].state === 'ro' ? 'pleine' : 'indisponible'} → la base ${other.name} prend le relais`);
      active = other.i;
    } else if (targets[active].state === 'down' && other.state === 'ro') {
      active = other.i;
    }
  }
  ready = targets.some((t) => t.state !== 'down');
  relabel();
}

// v147 : « principale » = la base active (lue en priorité), « secours » = l'autre. L'indice d'une base reste lié au projet
// Supabase (0 = site-production-baccara, 1 = tv-kouame) ; seuls le rôle et le nom changent quand on permute.
function relabel() {
  targets[active].name = 'principale';
  targets[1 - active].name = 'secours';
}

function setState(t, state, err) {
  if (err) t.error = String((err && err.message) || err);
  if (t.state === state) return;
  const before = t.state;
  t.state = state;
  if (state === 'down') t.schemaDone = false;
  console.log(`🗄️ Base ${t.name} : ${before} → ${state}${err ? ' (' + t.error.slice(0, 100) + ')' : ''}`);
  // une base qui (re)devient saine : tout l'état connu est renvoyé une fois (réglages, instantané, prédictions)
  if (state === 'ok') { lastSettings.clear(); lastSnapshot = null; predCache.clear(); }
  pickActive();
}

function makePool(connectionString) {
  const p = new Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    max: 6,
    connectionTimeoutMillis: 10000,   // v133 : une connexion qui ne s'ouvre pas en 10 s échoue au lieu de bloquer le bot
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,         // une requête bloquée est coupée côté Supabase
    query_timeout: 35000,
    keepAlive: true,
  });
  // sans ce récepteur, une connexion coupée par Supabase (inactivité, redémarrage) lève une erreur non gérée
  p.on('error', (e) => { lastError = e.message; });
  return p;
}

// Teste une base : 'ok' (écriture possible), 'ro' (pleine / lecture seule) ou 'down'.
async function probe(t) {
  try {
    const r = await t.pool.query(`SELECT current_setting('transaction_read_only') AS ro, pg_is_in_recovery() AS rec`);
    const row = r.rows[0] || {};
    return (row.ro === 'on' || row.rec === true) ? 'ro' : 'ok';
  } catch (e) {
    t.error = e.message;
    return isFullError(e) ? 'ro' : 'down';
  }
}

async function connectTarget(t) {
  if (!Pool) { t.error = "Module 'pg' absent — lance npm install"; setState(t, 'down'); return; }
  let link = t.i === 0 ? databaseUrl() : backupUrl();
  if (!link || !t.pool || t.state === 'down') {
    // adresse inconnue ou base tombée : on reteste les adresses intégrées (db-link.js)
    try { link = (await require('./db-link').ensureOne(t.i, false)) || ''; } catch (_) { link = ''; }
  }
  if (!link) {
    t.error = t.i === 1 ? 'Base de secours non configurée (mot de passe manquant dans db-link.js)' : 'Aucune adresse de base répond';
    setState(t, 'down');
    return;
  }
  if (t.pool && t.url !== link) { try { await t.pool.end(); } catch (_) {} t.pool = null; t.schemaDone = false; }
  if (!t.pool) { t.pool = makePool(link); t.url = link; }
  const st = await probe(t);
  if (st === 'ok' && !t.schemaDone) {
    try { await t.pool.query(SCHEMA); t.schemaDone = true; }
    catch (e) {
      t.error = e.message;
      setState(t, isFullError(e) ? 'ro' : 'down', e);
      return;
    }
  }
  if (st === 'down') { try { await t.pool.end(); } catch (_) {} t.pool = null; }
  setState(t, st);
}

async function connect(newUrl) { // newUrl ignoré : les liens sont fixés par db-link.js
  lastError = null;
  lastSettings.clear(); lastSnapshot = null; predCache.clear(); // nouvelle connexion : tout est renvoyé une fois
  await Promise.all(targets.map((t) => connectTarget(t).catch((e) => { t.error = e.message; setState(t, 'down', e); })));
  await applyStoredPrimary().catch(() => {}); // v147 : rôle principale/secours choisi par /permuterbases
  await seedEmptyPrimary().catch(() => {});   // v147 : la base vide reçoit les configurations de l'autre
  pickActive();
  startHealth();
  if (!ready) lastError = targets.map((t) => `${t.name} : ${t.error || 'indisponible'}`).join(' • ');
  return status();
}

// Surveillance en arrière-plan (toutes les 30 s) : détecte une base pleine / tombée, reconnecte celle qui est revenue.
let healthTimer = null;
let healthBusy = false;
async function healthTick() {
  if (healthBusy) return;
  healthBusy = true;
  try {
    for (const t of targets) {
      if (t.state === 'down' || !t.pool) { await connectTarget(t); continue; }
      const st = await probe(t);
      if (st === 'ok' && !t.schemaDone) { await connectTarget(t); continue; }
      if (st === 'down') { try { await t.pool.end(); } catch (_) {} t.pool = null; }
      setState(t, st);
    }
  } catch (e) { lastError = e.message; }
  finally { healthBusy = false; }
}
function startHealth() {
  if (healthTimer) return;
  healthTimer = setInterval(() => { healthTick().catch(() => {}); }, 30000);
  if (healthTimer.unref) healthTimer.unref();
}

// Écriture « miroir » sur l'autre base : sans attendre, sans jamais gêner la base active.
function mirror(t, sql, params) {
  if (t.mirrorPending > 200) return; // base secondaire trop lente : on n'empile pas
  t.mirrorPending++;
  t.pool.query(sql, params)
    .catch((e) => {
      if (isFullError(e)) setState(t, 'ro', e);
      else if (isDownError(e)) setState(t, 'down', e);
      // autre erreur SQL sur la copie : ignorée, la base active fait foi
    })
    .finally(() => { t.mirrorPending--; });
}

async function q(sql, params = []) {
  if (!ready) return null;
  const read = isRead(sql);
  // ordre : la base active d'abord, puis l'autre. Lecture : toute base non tombée ; écriture : bases saines uniquement.
  const usable = [targets[active], targets[1 - active]]
    .filter((t) => t.pool && (read ? t.state !== 'down' : t.state === 'ok'));
  for (let k = 0; k < usable.length; k++) {
    const t = usable[k];
    try {
      const r = await t.pool.query(sql, params);
      if (!read) for (const o of usable.slice(k + 1)) mirror(o, sql, params);
      return r;
    } catch (e) {
      lastError = e.message;
      if (isFullError(e)) setState(t, 'ro', e);
      else if (isDownError(e)) setState(t, 'down', e);
      else return null; // erreur SQL normale (pas un problème de base) : aucune bascule
      // base pleine / tombée : on retente tout de suite sur l'autre base
    }
  }
  return null;
}

// Exécute fn sur CHAQUE base saine : query(sql, params) vise cette base seulement (null si l'écriture échoue).
// Sert aux écritures qui doivent exister sur les deux bases (ex. table apk_calls lue par l'appli Android).
async function eachBase(fn) {
  const out = [];
  for (const t of targets) {
    if (!t.pool || t.state !== 'ok') { out.push({ nom: t.name, ok: false, skipped: true }); continue; }
    const query = async (sql, params = []) => {
      try { return await t.pool.query(sql, params); }
      catch (e) {
        lastError = e.message;
        if (isFullError(e)) setState(t, 'ro', e); else if (isDownError(e)) setState(t, 'down', e);
        return null;
      }
    };
    try { out.push({ nom: t.name, ok: true, result: await fn(query, t.name) }); }
    catch (e) { out.push({ nom: t.name, ok: false, error: e.message }); }
  }
  return out;
}

// ---- jeux ------------------------------------------------------------------
// v133/v135 : la base ne garde que les GAMES_KEPT (50) derniers jeux : à chaque jeu enregistré, les plus anciens sont effacés.
const GAMES_KEPT = 50;
let savedSinceTrim = 0;
async function trimGames() {
  return q(`DELETE FROM games WHERE number NOT IN (SELECT number FROM games ORDER BY played_at DESC, number DESC LIMIT ${GAMES_KEPT})`);
}
// v152 : état du dernier enregistrement de jeu (visible dans status().games) + file d'attente des jeux non enregistrés
const gameSave = { lastNumber: null, lastOkAt: null, lastTryAt: null, lastError: null, okCount: 0, failCount: 0, pending: 0, feedAt: null, feedCount: 0, feedMax: null };
const pendingGames = [];
let flushingGames = false;
function noteFeed(count, maxNumber) { gameSave.feedAt = new Date().toISOString(); gameSave.feedCount = count; gameSave.feedMax = maxNumber; }
async function flushPendingGames() {
  if (flushingGames) return;
  flushingGames = true;
  try {
    while (pendingGames.length) {
      const g = pendingGames[0];
      gameSave.lastTryAt = new Date().toISOString();
      const r = await saveGameRaw(g);
      if (!r) { gameSave.lastError = lastError || (ready ? 'écriture refusée' : 'aucune base utilisable'); gameSave.failCount++; break; }
      pendingGames.shift();
      gameSave.lastNumber = g.number; gameSave.lastOkAt = new Date().toISOString(); gameSave.lastError = null; gameSave.okCount++;
      trimGames().catch(() => {}); // v135 : exactement GAMES_KEPT (50) jeux en base
    }
  } finally { gameSave.pending = pendingGames.length; flushingGames = false; }
}
async function saveGame(g) {
  // un jeu EN LIVE (non terminé) n'est jamais enregistré en base
  if (!g || !g.finished) return null;
  const i = pendingGames.findIndex((x) => x.number === g.number);
  if (i >= 0) pendingGames[i] = g; else pendingGames.push(g);
  if (pendingGames.length > 200) pendingGames.shift();
  gameSave.pending = pendingGames.length;
  await flushPendingGames();
  if (pendingGames.length) { console.error(`⚠️ Jeu #${g.number} non enregistré en base (${gameSave.lastError}) : réessai au prochain jeu / dans 20 s`); setTimeout(() => flushPendingGames().catch(() => {}), 20000); }
  return pendingGames.length === 0;
}
async function saveGameRaw(g) {
  return q(
    `INSERT INTO games (number, played_on, winner, player_cards, banker_cards,
        player_suits, banker_suits, player_value, banker_value,
        player_parity, banker_parity, player_count, banker_count, phase, raw)
     VALUES ($1, current_date, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (number) DO UPDATE SET
       winner=EXCLUDED.winner, player_cards=EXCLUDED.player_cards,
       banker_cards=EXCLUDED.banker_cards, player_suits=EXCLUDED.player_suits,
       banker_suits=EXCLUDED.banker_suits, player_value=EXCLUDED.player_value,
       banker_value=EXCLUDED.banker_value, player_parity=EXCLUDED.player_parity,
       banker_parity=EXCLUDED.banker_parity, player_count=EXCLUDED.player_count,
       banker_count=EXCLUDED.banker_count, phase=EXCLUDED.phase, raw=EXCLUDED.raw`,
    [
      g.number, g.winner, g.player, g.banker, g.playerSuits, g.bankerSuits,
      g.playerValue, g.bankerValue, g.playerParity, g.bankerParity,
      g.playerCards, g.bankerCards, g.phase, JSON.stringify(g),
    ]
  );
}

// jeux d'une date (format accepté : 2026-04-02 ou 2/04/2026)
async function gamesByDate(dateStr, limit = 500) {
  const d = normalizeDate(dateStr);
  if (!d) return [];
  const r = await q(
    `SELECT * FROM games WHERE played_on = $1 ORDER BY number DESC LIMIT $2`,
    [d, limit]
  );
  return r ? r.rows : [];
}

async function dailySummary(dateStr) {
  const d = normalizeDate(dateStr);
  if (!d) return null;
  const r = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE winner='Joueur')::int    AS joueur,
            count(*) FILTER (WHERE winner='Banquier')::int  AS banquier,
            count(*) FILTER (WHERE winner='Égalité')::int   AS egalite,
            count(*) FILTER (WHERE player_parity='pair')::int   AS joueur_pair,
            count(*) FILTER (WHERE player_parity='impair')::int AS joueur_impair,
            count(*) FILTER (WHERE banker_parity='pair')::int   AS banquier_pair,
            count(*) FILTER (WHERE banker_parity='impair')::int AS banquier_impair
     FROM games WHERE played_on = $1`,
    [d]
  );
  return r ? { date: d, ...r.rows[0] } : null;
}

function normalizeDate(s) {
  if (!s) return new Date().toISOString().slice(0, 10);
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // 2/04/2026
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// ---- prédictions -----------------------------------------------------------
async function savePrediction(p, bValue) {
  return q(
    `INSERT INTO predictions (target, suit, hand, b_value, b_counter, max_r, status, strategy, label, reason)
     VALUES ($1,$2,$3,$4,$5,$6,'attente',$7,$8,$9)
     ON CONFLICT (strategy, target, suit) DO NOTHING`,
    [p.target, p.suit || p.cardsLabel || '-', p.hand, bValue, p.counter, p.maxR, p.strategy || 'costume', p.label || null, p.reason || null]
  );
}

// v133 : (1) une prédiction annulée n'est plus enregistrée comme « perdue » ; (2) si la clôture arrive AVANT l'insertion
// (prédiction résolue dans le tour même de sa création, l'INSERT étant asynchrone), l'UPDATE ne trouvait aucune ligne et la
// prédiction restait « attente » pour toujours en base (ligne fantôme rechargée comme « non vérifiée » à chaque redémarrage) :
// on réessaie quelques secondes plus tard.
async function closePrediction(p, attempt = 0) {
  const status = p.status === 'gagné' ? 'gagne' : p.status === 'annulé' ? 'annule' : 'perdu';
  const r = await q(
    `UPDATE predictions SET status=$1, rattrapage=$2, hit_number=$3, closed_at=now()
     WHERE strategy=$4 AND target=$5 AND suit=$6 AND status='attente'`,
    [status, p.step, p.hitNumber, p.strategy || 'costume', p.target, p.suit || p.cardsLabel || '-']
  );
  if (r && r.rowCount === 0 && attempt < 3) {
    const t = setTimeout(() => { closePrediction(p, attempt + 1).catch(() => {}); }, 2500);
    if (t.unref) t.unref();
  }
  return r;
}

// recherche une (ou plusieurs, si diffusée par plusieurs stratégies) prédiction(s)
// dont le jeu CIBLÉ (target) correspond au numéro donné — utilisé par le module
// de questions-réponses IA pour répondre à « pourquoi la stratégie X a prédit
// le jeu #N... ». Cherche aussi les jeux dont hit_number correspond, au cas où
// la question porte sur le jeu où la prédiction s'est réalisée plutôt que sur
// le jeu ciblé au départ.
async function predictionsByNumber(number, limit = 10) {
  const r = await q(
    `SELECT * FROM predictions WHERE target = $1 OR hit_number = $1
     ORDER BY created_at DESC LIMIT $2`,
    [number, limit]
  );
  return r ? r.rows : [];
}

// ---- stratégies (configurations persistantes) -------------------------------
async function saveStrategy(key, name, cfg) {
  return q(
    `INSERT INTO strategies (key, name, enabled, config, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, enabled=EXCLUDED.enabled,
       config=EXCLUDED.config, updated_at=now()`,
    [key, name || key, !!cfg.enabled, JSON.stringify(cfg)]
  );
}

async function loadStrategies() {
  const r = await q(`SELECT key, name, enabled, config FROM strategies`);
  if (!r) return {};
  const out = {};
  for (const row of r.rows) {
    const cfg = typeof row.config === 'string' ? JSON.parse(row.config || '{}') : row.config || {};
    out[row.key] = { ...cfg, enabled: row.enabled };
  }
  return out;
}

async function deleteStrategy(key) {
  return q(`DELETE FROM strategies WHERE key = $1`, [key]);
}

// ---- filtre « double perte » (gates) -----------------------------------
async function saveGate(key, payload) {
  return q(
    `INSERT INTO gates (key, payload, updated_at)
     VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now()`,
    [key, JSON.stringify(payload || {})]
  );
}

async function loadGates() {
  const r = await q(`SELECT key, payload FROM gates`);
  if (!r) return {};
  const out = {};
  for (const row of r.rows) {
    out[row.key] = typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : row.payload || {};
  }
  return out;
}

// ---- annonces de position (stratégie « ombre », filtre « double perte ») --
async function saveAnnouncement(entry) {
  return q(
    `INSERT INTO announcements (id, strategy, ref_number, position, status, sent_number, created_at, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8)
     ON CONFLICT (id) DO UPDATE SET
       status=EXCLUDED.status, sent_number=EXCLUDED.sent_number, sent_at=EXCLUDED.sent_at`,
    [
      entry.id, entry.strategy, entry.refNumber, entry.position, entry.status,
      entry.sentNumber, entry.createdAt, entry.sentAt ? new Date(entry.sentAt) : null,
    ]
  );
}

async function deleteAnnouncement(id) {
  return q(`DELETE FROM announcements WHERE id = $1`, [id]);
}

async function loadAnnouncements(limit = 200) {
  const r = await q(
    `SELECT id, strategy, ref_number, position, status, sent_number, created_at, sent_at
       FROM announcements ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  if (!r) return [];
  return r.rows.map((row) => ({
    id: Number(row.id),
    strategy: row.strategy,
    refNumber: row.ref_number == null ? null : Number(row.ref_number),
    position: row.position,
    status: row.status,
    sentNumber: row.sent_number == null ? null : Number(row.sent_number),
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    sentAt: row.sent_at ? new Date(row.sent_at).getTime() : null,
  })).reverse(); // ré-ordonné du plus ancien au plus récent, comme state.announcements
}

// bilan des prédictions par stratégie
async function strategyStats(key) {
  const r = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='gagne')::int   AS gagne,
            count(*) FILTER (WHERE status='perdu')::int   AS perdu,
            count(*) FILTER (WHERE status='attente')::int AS attente
       FROM predictions WHERE strategy = $1`, [key]);
  if (!r) return null;
  const row = r.rows[0];
  const done = row.gagne + row.perdu;
  return { ...row, taux: done ? Math.round((row.gagne / done) * 100) : 0 };
}

// dernières prédictions d'une stratégie
async function strategyPredictions(key, limit = 20) {
  const r = await q(
    `SELECT target, suit, label, max_r, status, rattrapage, hit_number, created_at
       FROM predictions WHERE strategy = $1 ORDER BY id DESC LIMIT $2`, [key, limit]);
  return r ? r.rows : [];
}

// suppression administrateur des prédictions d'une stratégie
async function clearPredictions(key) {
  return key
    ? q(`DELETE FROM predictions WHERE strategy = $1`, [key])
    : q(`DELETE FROM predictions`);
}

// CORRECTIF « bilans remis à zéro après redémarrage » : state.predictions
// (côté predictor.js) ne vit qu'en RAM et repart vide à chaque redémarrage
// du process (veille/redéploiement Render), alors que cette table, elle,
// garde tout durablement. On recharge donc au démarrage : TOUTES les
// prédictions encore « attente » (à re-suivre), + les `limit` dernières
// prédictions résolues (gagne/perdu/annulé), toutes stratégies confondues —
// même logique de plafond que state.predictions en fonctionnement normal.
async function restorePredictions(limit = 300) {
  const r = await q(
    `(SELECT * FROM predictions WHERE status = 'attente')
     UNION ALL
     (SELECT * FROM predictions WHERE status <> 'attente' ORDER BY id DESC LIMIT $1)
     ORDER BY id DESC`,
    [limit]
  );
  return r ? r.rows : [];
}

// ---- stratégies IA (créées automatiquement ou manuellement, >= 75%) --------
async function saveAiStrategy(item) {
  return q(
    `INSERT INTO ai_strategies (id, name, logic, trigger_txt, target_txt, evidence, risks,
        rate, support, minimum_sample, compatible_existing, origin, active, created_at,
        rate_min, rate_max, observations, rate_history, occurrences)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, coalesce($14, now()), $15,$16,$17,$18,$19)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, logic=EXCLUDED.logic, trigger_txt=EXCLUDED.trigger_txt,
       target_txt=EXCLUDED.target_txt, evidence=EXCLUDED.evidence, risks=EXCLUDED.risks,
       rate=EXCLUDED.rate, support=EXCLUDED.support, minimum_sample=EXCLUDED.minimum_sample,
       compatible_existing=EXCLUDED.compatible_existing, origin=EXCLUDED.origin,
       active=EXCLUDED.active, rate_min=EXCLUDED.rate_min, rate_max=EXCLUDED.rate_max,
       observations=EXCLUDED.observations, rate_history=EXCLUDED.rate_history,
       occurrences=EXCLUDED.occurrences`,
    [
      item.id, item.name, item.logic || null, item.trigger || null, item.target || null,
      item.evidence || null, item.risks || null, item.rate, item.support || null,
      item.minimumSample || null, item.compatibleExisting || null, item.origin || null,
      !!item.active, item.createdAt || null,
      item.rateMin != null ? item.rateMin : item.rate,
      item.rateMax != null ? item.rateMax : item.rate,
      item.observations || 1,
      JSON.stringify(item.rateHistory || []),
      JSON.stringify(item.occurrences || []),
    ]
  );
}

async function loadAiStrategies() {
  const r = await q(`SELECT * FROM ai_strategies ORDER BY created_at DESC LIMIT 40`);
  if (!r) return [];
  return r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    logic: row.logic || '',
    trigger: row.trigger_txt || '',
    target: row.target_txt || '',
    evidence: row.evidence || '',
    risks: row.risks || '',
    rate: row.rate == null ? null : Number(row.rate),
    support: row.support,
    minimumSample: row.minimum_sample,
    compatibleExisting: row.compatible_existing,
    origin: row.origin,
    active: row.active,
    createdAt: row.created_at,
    rateMin: row.rate_min == null ? (row.rate == null ? null : Number(row.rate)) : Number(row.rate_min),
    rateMax: row.rate_max == null ? (row.rate == null ? null : Number(row.rate)) : Number(row.rate_max),
    observations: row.observations == null ? 1 : Number(row.observations),
    rateHistory: Array.isArray(row.rate_history) ? row.rate_history : [],
    occurrences: Array.isArray(row.occurrences) ? row.occurrences : [],
  }));
}

async function deleteAiStrategy(id) {
  return q(`DELETE FROM ai_strategies WHERE id = $1`, [id]);
}

// Supprime en base toutes les stratégies IA créées il y a plus de 60 minutes
// (aucune stratégie IA ne doit survivre plus de 60 min, voir ai-auto.js).
// Retourne la liste des id supprimés pour permettre de les retirer aussi de
// l'état en mémoire (state.aiStrategies).
async function pruneAiStrategies() {
  const r = await q(
    `DELETE FROM ai_strategies WHERE created_at < now() - interval '60 minutes' RETURNING id`
  );
  return r ? r.rows.map((row) => row.id) : [];
}

// ---- analyses IA ------------------------------------------------------------
async function saveAiAnalysis(result, date = null) {
  if (!result || typeof result !== 'object') return null;
  const generatedAt = result.generatedAt || new Date().toISOString();
  return q(
    `INSERT INTO ai_analyses
       (source, analyzed_on, sample, title, confidence, observation, payload, generated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      result.source || 'local',
      normalizeDate(date || result.date) || null,
      Number.isFinite(Number(result.sample)) ? Number(result.sample) : null,
      result.title || null,
      result.confidence || null,
      result.observation || null,
      JSON.stringify(result),
      generatedAt,
    ]
  );
}

async function loadAiAnalyses(limit = 12) {
  const r = await q(
    `SELECT payload, generated_at FROM ai_analyses ORDER BY id DESC LIMIT $1`,
    [Math.max(1, Math.min(100, Number(limit) || 12))]
  );
  if (!r) return [];
  return r.rows.map((row) => {
    let payload = row.payload || {};
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload || '{}'); } catch (_) { payload = {}; }
    }
    return { ...payload, generatedAt: payload.generatedAt || row.generated_at };
  });
}

// ---- réglages --------------------------------------------------------------
const lastSettings = new Map(); // v133 : dernière valeur envoyée par clé (vidé à chaque connexion)
async function setSetting(key, value) {
  const v = String(value);
  if (lastSettings.get(key) === v) return { rowCount: 0, skipped: true }; // identique à la dernière écriture : rien à envoyer à Supabase
  const r = await setSettingRaw(key, v);
  if (r) lastSettings.set(key, v);
  return r;
}
async function setSettingRaw(key, value) {
  return q(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [key, String(value)]
  );
}

async function getSetting(key) {
  const r = await q(`SELECT value FROM settings WHERE key=$1`, [key]);
  return r && r.rows[0] ? r.rows[0].value : null;
}


// ---- état complet du site (miroir de data.json) ----------------------------
// Supabase/PostgreSQL est la source durable : compteurs, panneaux et
// configurations survivent aux redémarrages (disque Render éphémère).
let lastSnapshot = null;
async function saveStoreSnapshot(data) {
  const clean = { ...(data || {}) };
  delete clean.databaseUrl; // le lien de la base ne doit jamais être stocké dans la base
  const json = JSON.stringify(clean);
  if (json === lastSnapshot) return { rowCount: 0, skipped: true }; // état inchangé depuis le dernier envoi
  const r = await saveStoreSnapshotRaw(json);
  if (r) lastSnapshot = json;
  return r;
}
async function saveStoreSnapshotRaw(json) {
  return q(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('store', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [json]
  );
}

async function loadStoreSnapshot() {
  const r = await q(`SELECT value, updated_at FROM app_state WHERE key = 'store'`);
  if (!r || !r.rows[0]) return null;
  let value = r.rows[0].value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { return null; } }
  return { value, updatedAt: r.rows[0].updated_at };
}


// ---- configuration de l'application (token, canaux, admin, réglages) -------
// Tout est enregistré en base : après un redémarrage, le bot repart avec le
// token, l'ID administrateur, les canaux et les réglages déjà configurés.
async function saveAppConfig(cfg = {}) {
  return setSetting('app_config', JSON.stringify(cfg));
}

async function loadAppConfig() {
  const raw = await getSetting('app_config');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function savePreditState(value) {
  return setSetting('predit_state', JSON.stringify(value || {}));
}

async function loadPreditState() {
  const raw = await getSetting('predit_state');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function saveAfterLossState(value) {
  return setSetting('after_loss_state', JSON.stringify(value || {}));
}

async function loadAfterLossState() {
  const raw = await getSetting('after_loss_state');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ---- ANTI-DOUBLON des prédictions « après une perte » ----------------------
// Lecture/écriture DIRECTE en base (pas seulement en mémoire) : c'est la base
// qui fait foi, donc le contrôle survit aux redémarrages et aux sessions
// série (catégorie 3) / dizaine (catégorie 1) reprises en cours de route.

// true si une prédiction pour ce numéro + ce costume a déjà été envoyée,
// que ce soit par le panneau « après une perte » (after_loss_sent) ou par la
// stratégie source elle-même (table predictions).
async function afterLossSendExists(target, suit) {
  const r = await q(
    `SELECT 1
       FROM after_loss_sent WHERE target = $1 AND suit = $2
      UNION ALL
     SELECT 1
       FROM predictions     WHERE target = $1 AND suit = $2
      LIMIT 1`,
    [Number(target) || 0, String(suit || '')]
  );
  return !!(r && r.rowCount);
}

// Réservation ATOMIQUE : insère la clé (target, suit) et renvoie true seulement
// si elle n'existait pas encore. Deux envois simultanés ne peuvent donc pas
// passer tous les deux.
async function reserveAfterLossSend(entry = {}) {
  const r = await q(
    `INSERT INTO after_loss_sent (target, suit, tracker_id, tracker_name, category)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (target, suit) DO NOTHING
     RETURNING id`,
    [
      Number(entry.target) || 0,
      String(entry.suit || ''),
      entry.trackerId != null ? String(entry.trackerId) : null,
      entry.trackerName || null,
      Number(entry.category) || 0,
    ]
  );
  return !!(r && r.rowCount);
}

// Libère la réservation quand l'envoi Telegram a finalement échoué.
async function releaseAfterLossSend(target, suit) {
  return q(`DELETE FROM after_loss_sent WHERE target = $1 AND suit = $2`,
    [Number(target) || 0, String(suit || '')]);
}

// Nouveau sabot : les numéros de jeu repartent de 1, le registre est vidé.
async function clearAfterLossSent() {
  return q(`DELETE FROM after_loss_sent`);
}

async function listAfterLossSent(limit = 100) {
  const r = await q(`SELECT target, suit, tracker_name, category, sent_at
                       FROM after_loss_sent ORDER BY sent_at DESC LIMIT $1`,
    [Math.max(1, Math.min(500, parseInt(limit, 10) || 100))]);
  return r ? r.rows : [];
}



// ---- interrupteur global « arrêter/démarrer/planifier les prédictions » ----
async function savePredictionControlState(value) {
  return setSetting('prediction_control_state', JSON.stringify(value || {}));
}

async function loadPredictionControlState() {
  const raw = await getSetting('prediction_control_state');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ---- panneau base de données : tout ce qui est stocké ----------------------
async function allSettings() {
  const r = await q(`SELECT key, value FROM settings ORDER BY key`);
  if (!r) return [];
  return r.rows.map((row) => ({
    key: row.key,
    // le token n'est jamais renvoyé en clair au navigateur
    value: /token/i.test(row.key) ? '••••••' : maskConfig(row.key, row.value),
  }));
}

function maskConfig(key, value) {
  if (key !== 'app_config') return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed.botToken) parsed.botToken = parsed.botToken.slice(0, 8) + '••••••';
    return JSON.stringify(parsed);
  } catch (_) { return value; }
}

async function tableCounts() {
  const r = await q(
    `SELECT (SELECT count(*)::int FROM games)          AS games,
            (SELECT count(*)::int FROM predictions)    AS predictions,
            (SELECT count(*)::int FROM settings)       AS settings,
            (SELECT count(*)::int FROM strategies)     AS strategies,
            (SELECT count(*)::int FROM ai_strategies)  AS ai_strategies,
            (SELECT count(*)::int FROM ai_analyses)    AS ai_analyses`);
  return r ? r.rows[0] : null;
}

// contenu complet et lisible de la base (panneau « Base de données »)
async function dump(limit = 25) {
  return {
    status: status(),
    counts: await tableCounts(),
    overview: await overview(),
    dates: await availableDates(15),
    games: await lastGames(limit),
    predictions: await lastPredictions(limit),
    strategies: await strategyRows(),
    settings: await allSettings(),
    aiAnalyses: await loadAiAnalyses(Math.min(limit, 50)),
    preditState: await loadPreditState(),
  };
}

async function lastPredictions(limit = 25) {
  const r = await q(
    `SELECT id, strategy, target, suit, label, hand, max_r, status, rattrapage,
            hit_number, played_on, created_at
       FROM predictions ORDER BY id DESC LIMIT $1`, [limit]);
  return r ? r.rows : [];
}

async function strategyRows() {
  const r = await q(`SELECT key, name, enabled, config, updated_at FROM strategies ORDER BY key`);
  if (!r) return [];
  return r.rows.map((row) => ({
    key: row.key,
    name: row.name,
    enabled: row.enabled,
    updated_at: row.updated_at,
    config: typeof row.config === 'string' ? JSON.parse(row.config || '{}') : row.config || {},
  }));
}

// ---- lecture / vérification des données ------------------------------------
// dernier jeux enregistrés (toutes dates)
async function lastGames(limit = 10) {
  const r = await q(
    `SELECT number, played_on, winner, player_cards, player_suits, player_value,
            player_parity, player_count, banker_cards, banker_value, phase
       FROM games ORDER BY number DESC LIMIT $1`, [limit]);
  return r ? r.rows : [];
}

// un jeu précis
async function gameByNumber(n) {
  const r = await q(`SELECT * FROM games WHERE number = $1`, [Number(n)]);
  return r && r.rows[0] ? r.rows[0] : null;
}

// plage de jeux [minNumber, maxNumber] (bornes incluses), triés par numéro —
// utilisé par formation.js pour vérifier, en UNE requête, si un costume perdu
// réapparaît sur la main du joueur aux jeux qui suivent une perte.
async function gamesInRange(minNumber, maxNumber) {
  const r = await q(
    `SELECT number, player_suits FROM games WHERE number >= $1 AND number <= $2 ORDER BY number`,
    [Number(minNumber), Number(maxNumber)]
  );
  return r ? r.rows : [];
}

// prédictions d'une date
// v133 : cache de 45 s. La Formation relançait cette requête (jusqu'à 1000 lignes) UNE FOIS PAR STRATÉGIE (19 fois) toutes les
// 60 s, plus les Conseils : 413 000 appels et 311 millions de lignes lues en base. Un seul résultat partagé suffit.
const predCache = new Map(); // "date|limit" → { at, rows }
async function predictionsByDate(dateStr, limit = 200) {
  const d = normalizeDate(dateStr);
  if (!d) return [];
  const key = `${d}|${limit}`;
  const hit = predCache.get(key);
  if (hit && Date.now() - hit.at < 45000) return hit.rows.slice();
  const rows = await predictionsByDateRaw(d, limit);
  predCache.set(key, { at: Date.now(), rows });
  if (predCache.size > 20) predCache.delete(predCache.keys().next().value);
  return rows.slice();
}
async function predictionsByDateRaw(d, limit) {
  const r = await q(
    `SELECT target, suit, hand, max_r, status, rattrapage, hit_number, created_at, strategy
       FROM predictions WHERE played_on = $1 ORDER BY target DESC LIMIT $2`, [d, limit]);
  return r ? r.rows : [];
}

// bilan des prédictions d'une date
async function predictionSummary(dateStr) {
  const d = normalizeDate(dateStr);
  if (!d) return null;
  const r = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='gagne')::int   AS gagne,
            count(*) FILTER (WHERE status='perdu')::int   AS perdu,
            count(*) FILTER (WHERE status='attente')::int AS attente,
            coalesce(round(avg(rattrapage) FILTER (WHERE status='gagne')::numeric, 2), 0) AS r_moyen
       FROM predictions WHERE played_on = $1`, [d]);
  if (!r) return null;
  const row = r.rows[0];
  const done = row.gagne + row.perdu;
  return { date: d, ...row, taux: done ? Math.round((row.gagne / done) * 100) : 0 };
}

// état global des tables (vérification rapide de la base)
async function overview() {
  const r = await q(
    `SELECT (SELECT count(*)::int FROM games)            AS games,
            (SELECT count(*)::int FROM predictions)      AS predictions,
            (SELECT count(*)::int FROM settings)         AS settings,
            (SELECT max(number)   FROM games)            AS dernier_jeu,
            (SELECT min(played_on) FROM games)           AS depuis,
            (SELECT max(played_on) FROM games)           AS jusqua`);
  return r ? r.rows[0] : null;
}

// dates disponibles
async function availableDates(limit = 15) {
  const r = await q(
    `SELECT played_on, count(*)::int AS total FROM games
      GROUP BY played_on ORDER BY played_on DESC LIMIT $1`, [limit]);
  return r ? r.rows : [];
}

// requête SELECT libre (lecture seule) — pratique pour vérifier les données
async function readOnlyQuery(sql, limit = 50) {
  const clean = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!/^select\s/i.test(clean)) return { error: 'Seules les requêtes SELECT sont autorisées.' };
  if (/\b(insert|update|delete|drop|alter|truncate|grant|create)\b/i.test(clean))
    return { error: 'Requête refusée : lecture seule.' };
  const r = await q(`SELECT * FROM (${clean}) AS sub LIMIT ${Math.max(1, Math.min(200, limit))}`);
  if (!r) return { error: lastError || 'Requête échouée' };
  return { rows: r.rows, count: r.rowCount };
}

// helpers génériques (utilisés par l'analyse cumulative)
async function exec(sql, params = []) { return q(sql, params); }
async function rows(sql, params = []) { const r = await q(sql, params); return r ? r.rows : []; }

// ---- v147 : copie des configurations + permutation principale / secours --------------------------------
// Configurations = réglages (token, canaux, panneaux, états), instantané du site, stratégies et stratégies IA.
// Pas d'historique (prédictions, analyses IA, anti-doublons) : seulement les 50 derniers jeux, en option.
const CONFIG_TABLES = [
  { table: 'settings',      pk: ['key'] },
  { table: 'app_state',     pk: ['key'] },
  { table: 'strategies',    pk: ['key'] },
  { table: 'ai_strategies', pk: ['id'] },
];
const GAMES_TABLE = { table: 'games', pk: ['number'] };

// Copie (upsert, rien n'est supprimé sur la destination) les lignes d'une table d'une base vers l'autre.
async function copyTable(src, dst, { table, pk }) {
  const r = await src.pool.query(`SELECT * FROM ${table}`);
  const cols = r.fields.map((f) => f.name);
  const jsonCols = new Set(r.fields.filter((f) => f.dataTypeID === 3802).map((f) => f.name)); // jsonb
  const set = cols.filter((c) => !pk.includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const ph = cols.map((c, i) => (jsonCols.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph}) ON CONFLICT (${pk.join(', ')}) DO ${set ? 'UPDATE SET ' + set : 'NOTHING'}`;
  for (const row of r.rows) {
    const vals = cols.map((c) => (jsonCols.has(c) && row[c] !== null && row[c] !== undefined ? JSON.stringify(row[c]) : row[c]));
    await dst.pool.query(sql, vals);
  }
  return r.rows.length;
}

// Copie les configurations de la base PRINCIPALE (active) vers la base de SECOURS.
async function copyConfig(opts = {}) {
  const src = opts.reverse ? targets[1 - active] : targets[active];
  const dst = opts.reverse ? targets[active] : targets[1 - active];
  if (src.state !== 'ok' || !src.pool) return { ok: false, error: `La base ${src.name} n'est pas disponible (${src.state}).` };
  if (dst.state !== 'ok' || !dst.pool) {
    return { ok: false, error: `La base ${dst.name} n'est pas disponible (${dst.state}${dst.error ? ' : ' + String(dst.error).slice(0, 120) : ''}).` };
  }
  const tables = opts.games ? [...CONFIG_TABLES, GAMES_TABLE] : CONFIG_TABLES;
  const counts = {};
  try {
    await dst.pool.query(SCHEMA); // sécurité : les tables existent côté destination
    for (const t of tables) counts[t.table] = await copyTable(src, dst, t);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200), copied: counts };
  }
  lastSettings.clear(); lastSnapshot = null; // la suite des écritures repart d'un état connu des deux côtés
  return { ok: true, from: src.name, to: dst.name, copied: counts };
}

// Au démarrage : la base qui est VIDE (aucun état du site) reçoit les configurations de l'autre base, avant toute écriture.
// Sans cela, un état vide serait renvoyé sur les deux bases et écraserait la configuration de celle qui est remplie.
// Les deux vides : rien à copier (l'état local du site est envoyé comme d'habitude). Les deux remplies : rien ne bouge.
async function seedEmptyPrimary() {
  const a = targets[active];
  const o = targets[1 - active];
  if (a.state !== 'ok' || o.state !== 'ok' || !a.pool || !o.pool) return;
  const has = async (t) => {
    const r = await t.pool.query(`SELECT (SELECT count(*) FROM app_state WHERE key='store') + (SELECT count(*) FROM settings WHERE key='app_config') AS n`);
    return Number(r.rows[0].n) > 0;
  };
  const [aFull, oFull] = [await has(a), await has(o)];
  if (aFull === oFull) return;
  const r = await copyConfig({ reverse: !aFull }); // principale vide → reprise depuis le secours ; secours vide → envoi vers le secours
  const [from, to] = aFull ? [a, o] : [o, a];
  console.log(r.ok ? `🌱 Base ${to.name} vide : configurations envoyées depuis la base ${from.name}` : `⚠️ Envoi des configurations impossible : ${r.error}`);
}

// Mémorise (sur les deux bases) quelle base est la principale : valeur « indice|date ».
async function persistPrimary() {
  const value = `${active}|${new Date().toISOString()}`;
  let wrote = 0;
  for (const t of targets) {
    if (!t.pool || t.state !== 'ok') continue;
    try {
      await t.pool.query(`INSERT INTO settings (key, value) VALUES ('db_primary', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [value]);
      wrote++;
    } catch (_) { /* ignoré : l'autre base garde la valeur */ }
  }
  return wrote;
}

// Au démarrage : reprend le rôle mémorisé (la valeur la plus récente des deux bases fait foi).
async function applyStoredPrimary() {
  let best = null;
  for (const t of targets) {
    if (!t.pool || t.state === 'down') continue;
    try {
      const r = await t.pool.query(`SELECT value FROM settings WHERE key = 'db_primary'`);
      const m = /^([01])\|(.+)$/.exec((r.rows[0] && r.rows[0].value) || '');
      if (m && (!best || m[2] > best.at)) best = { i: Number(m[1]), at: m[2] };
    } catch (_) { /* table absente : rien à reprendre */ }
  }
  if (best && targets[best.i]) { active = best.i; relabel(); }
}

// Permute : copie d'abord les configurations principale → secours (et les vérifie), puis la base de secours devient la
// principale et l'ancienne principale devient le secours. Les écritures continuent d'aller sur les deux bases.
async function swapPrimary(opts = {}) {
  const old = targets[active];
  const next = targets[1 - active];
  const copy = await copyConfig(opts);
  if (!copy.ok) return { ok: false, step: 'copie', ...copy };
  // vérification : même nombre de lignes de configuration des deux côtés
  const check = {};
  for (const t of CONFIG_TABLES) {
    const a = await old.pool.query(`SELECT count(*)::int AS n FROM ${t.table}`);
    const b = await next.pool.query(`SELECT count(*)::int AS n FROM ${t.table}`);
    check[t.table] = { principale: a.rows[0].n, secours: b.rows[0].n };
    if (b.rows[0].n < a.rows[0].n) return { ok: false, step: 'verification', error: `Table ${t.table} incomplète sur la base de secours (${b.rows[0].n}/${a.rows[0].n}).`, check };
  }
  active = next.i;
  relabel();
  lastSettings.clear(); lastSnapshot = null; predCache.clear();
  const saved = await persistPrimary();
  console.log(`🔁 Permutation : la base ${next.i === 0 ? 'site-production-baccara' : 'tv-kouame'} est maintenant la PRINCIPALE`);
  return { ok: true, copied: copy.copied, check, nouvellePrincipale: next.i === 0 ? 'site-production-baccara' : 'tv-kouame', memorise: saved };
}

module.exports = {
  connect, status, eachBase, saveGame, noteFeed, flushPendingGames, gamesByDate, dailySummary, exec, rows,
  savePrediction, closePrediction, predictionsByNumber, setSetting, getSetting, normalizeDate,
  saveStrategy, loadStrategies, deleteStrategy, strategyStats, strategyPredictions, clearPredictions,
  restorePredictions,
  saveGate, loadGates,
  saveAnnouncement, deleteAnnouncement, loadAnnouncements,
  saveAiStrategy, loadAiStrategies, deleteAiStrategy, pruneAiStrategies,
  saveAiAnalysis, loadAiAnalyses,
  lastGames, gameByNumber, gamesInRange, predictionsByDate, predictionSummary,
  overview, availableDates, readOnlyQuery,
  saveStoreSnapshot, loadStoreSnapshot,
  saveAppConfig, loadAppConfig, savePreditState, loadPreditState, saveAfterLossState, loadAfterLossState,
  afterLossSendExists, reserveAfterLossSend, releaseAfterLossSend, clearAfterLossSent, listAfterLossSent,
  savePredictionControlState, loadPredictionControlState,
  dump, allSettings, lastPredictions, strategyRows, tableCounts,
  copyConfig, swapPrimary,
  get ready() { return ready; },
};
