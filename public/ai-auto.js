// ai-auto.js — analyseur automatique en temps réel
//  • Le moteur local tourne en continu sur les jeux terminés.
//  • Chaque constat est publié dans « Résultats ».
//  • Chaque stratégie trouvée est enregistrée dans « Stratégies IA créées ».
//  • Pollinations.ai enrichit l'analyse à intervalle plus large (clé d'environnement).
'use strict';

const config = require('./config');
const ai = require('./ai-analyzer');
const strategies = require('./strategies');
const db = require('./db');
const { state } = require('./predictor');
const cumulative = require('./cumulative');
const advisor = require('./strategy-advisor');

const auto = {
  enabled: config.AI_AUTO_ENABLED !== false,
  running: false,
  lastLocalAt: null,
  lastRemoteAt: null,
  lastError: null,
  lastGame: null,
  createdCount: 0,
};

function signature(result) {
  return [result.source, ...(result.findings || [])].join('|');
}

function slug(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Enregistre une stratégie trouvée par l'analyseur (sans jamais l'activer seule)
// Seuil minimum de réussite : une stratégie n'est enregistrée dans
// « Stratégies IA » que si l'analyse lui mesure au moins 75% de réussite.
const MIN_STRATEGY_RATE = 75;

function proposalRate(proposal) {
  const r = Number(proposal && proposal.rate);
  return Number.isFinite(r) ? r : null;
}

// Suivi de la qualité d'une stratégie IA dans le temps :
//  • rateMin  = taux le plus BAS jamais observé (sert au filtre « 90% sans descendre »)
//  • rateMax  = meilleur taux observé
//  • observations = nombre de mesures
function trackRate(item, rate) {
  if (!Number.isFinite(rate)) return item;
  item.rate = rate;
  item.rateMin = Number.isFinite(item.rateMin) ? Math.min(item.rateMin, rate) : rate;
  item.rateMax = Number.isFinite(item.rateMax) ? Math.max(item.rateMax, rate) : rate;
  item.observations = (item.observations || 0) + 1;
  item.rateHistory = [...(item.rateHistory || []), { rate, at: new Date().toISOString() }].slice(-30);
  item.lastRateAt = new Date().toISOString();
  return item;
}

function saveProposal(proposal, origin = 'auto-local') {
  if (!proposal || !proposal.name) return null;
  const rate = proposalRate(proposal);
  if (rate == null) return null;
  const name = String(proposal.name).slice(0, 100);
  // CORRECTIF : le seuil ne doit filtrer que la CRÉATION d'une nouvelle
  // stratégie. Avant, il coupait aussi la mise à jour d'une stratégie déjà
  // connue dès que sa nouvelle mesure retombait sous le seuil : son taux ne
  // bougeait donc plus jamais vers le bas, et elle n'était jamais retirée
  // (« ça n'arrive plus à renouveler »). On met maintenant TOUJOURS le taux à
  // jour pour une stratégie existante, puis on la retire immédiatement (liste
  // + base de données) si elle repasse sous le seuil.
  const existing = (state.aiStrategies || []).find((s) => slug(s.name) === slug(name));
  if (existing) {
    trackRate(existing, rate);
    existing.support = Number(proposal.support) || existing.support || null;
    if (rate < MIN_STRATEGY_RATE) {
      state.aiStrategies = (state.aiStrategies || []).filter((s) => s.id !== existing.id);
      if (db.ready) db.deleteAiStrategy(existing.id).catch(() => {});
    } else if (db.ready) {
      db.saveAiStrategy(existing).catch(() => {});
    }
    return null;
  }
  if (rate < MIN_STRATEGY_RATE) return null;
  const item = {
    id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    logic: String(proposal.logic || '').slice(0, 1000),
    trigger: String(proposal.trigger || '').slice(0, 400),
    target: String(proposal.target || '').slice(0, 400),
    evidence: String(proposal.evidence || '').slice(0, 1000),
    risks: String(proposal.risks || '').slice(0, 1000),
    minimumSample: proposal.minimumSample || null,
    rate,
    support: Number(proposal.support) || null,
    compatibleExisting: strategies.BY_KEY[proposal.compatibleExisting] ? proposal.compatibleExisting : null,
    origin,
    createdAt: new Date().toISOString(),
    active: false,
  };
  trackRate(item, rate);
  item.observations = 1;
  state.aiStrategies = [item, ...(state.aiStrategies || [])].slice(0, 40);
  auto.createdCount += 1;
  // Enregistrement durable en base : sans ça, la stratégie ne survivait qu'en
  // mémoire/data.json et disparaissait au redémarrage du serveur (Render).
  if (db.ready) db.saveAiStrategy(item).catch(() => {});
  return item;
}

// Liste complète des stratégies créées par l'IA (la plus récente d'abord)
function listStrategies() {
  return [...(state.aiStrategies || [])].map((s) => ({
    ...s,
    rateMin: Number.isFinite(s.rateMin) ? s.rateMin : (Number.isFinite(s.rate) ? s.rate : null),
    rateMax: Number.isFinite(s.rateMax) ? s.rateMax : (Number.isFinite(s.rate) ? s.rate : null),
    observations: s.observations || 1,
  }));
}

// ---------------------------------------------------------------------------
// Expiration automatique (1h) : aucune stratégie créée par l'IA ne doit
// rester en base (ni en mémoire) plus de 60 minutes après sa création.
// Un timer dédié vérifie chaque minute et supprime tout ce qui a dépassé
// l'âge maximum — en base ET dans state.aiStrategies (sinon la liste
// mémoire resterait affichée jusqu'au prochain redémarrage).
// ---------------------------------------------------------------------------
const AI_STRATEGY_MAX_AGE_MS = 60 * 60 * 1000; // 60 min
const PRUNE_CHECK_INTERVAL_MS = 60 * 1000; // vérification chaque minute

async function pruneExpiredStrategies() {
  const cutoff = Date.now() - AI_STRATEGY_MAX_AGE_MS;
  const list = state.aiStrategies || [];
  const expired = list.filter((s) => {
    const t = Date.parse(s.createdAt);
    return Number.isFinite(t) && t <= cutoff;
  });
  if (!expired.length) return [];
  const expiredIds = new Set(expired.map((s) => s.id));
  state.aiStrategies = list.filter((s) => !expiredIds.has(s.id));
  if (db.ready) {
    try {
      await db.pruneAiStrategies();
    } catch (_) {
      // secours si la requête groupée échoue : suppression une par une
      for (const s of expired) { try { await db.deleteAiStrategy(s.id); } catch (_) {} }
    }
  }
  return expired.map((s) => s.name);
}

let pruneTimer = null;

// Stratégies « au-dessus de la barre » : taux actuel >= seuil ET jamais
// descendues sous ce seuil depuis leur création (rateMin >= seuil).
function eliteStrategies(threshold = 90) {
  return listStrategies()
    .filter((s) => Number.isFinite(s.rate) && s.rate >= threshold && Number.isFinite(s.rateMin) && s.rateMin >= threshold)
    .sort((a, b) => (b.rate - a.rate) || (b.rateMin - a.rateMin));
}

function pushResult(result) {
  const previous = state.aiAnalyses[0];
  if (previous && signature(previous) === signature(result) && previous.source === result.source) {
    // même constat qu'au tour précédent : on met simplement l'horodatage à jour
    previous.generatedAt = result.generatedAt;
    previous.sample = result.sample;
    return false;
  }
  state.aiAnalyses = [result, ...state.aiAnalyses].slice(0, 12);
  if (db.ready) {
    db.saveAiAnalysis(result).catch((error) => { auto.lastError = error.message; });
  }
  return true;
}

// journées déjà jouées (base de données) : sert à repérer « le jeu d'hier
// revient aujourd'hui » ou « la partie du 20/08/2026 se rejoue ».
let pastDays = [];
let pastDaysAt = 0;

// CORRECTIF : PostgreSQL renvoie une colonne DATE comme un objet JS `Date`
// (minuit UTC), pas comme une chaîne « AAAA-MM-JJ ». `String(dateObj)`
// produit un format du type « Wed Apr 01 2026 00:00:00 GMT... », que
// `.slice(0, 10)` tronque n'importe comment (« Wed Apr 01 » au lieu de
// « 2026-04-01 »). Résultat : `normalizeDate()` (voir db.js) ne reconnaissait
// jamais cette date, `gamesByDate()` renvoyait alors [] pour CHAQUE journée
// antérieure — la comparaison entre aujourd'hui et les jours précédents
// portait donc toujours sur un historique vide (0 jour comparé). Même
// correctif que `fmtDate()` dans bot.js.
function isoDate(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

async function refreshPastDays(force = false) {
  if (!db.ready) { pastDays = []; return pastDays; }
  if (!force && Date.now() - pastDaysAt < 5 * 60 * 1000) return pastDays;
  try {
    const dates = await db.availableDates(8);
    const today = isoDate(new Date());
    const out = [];
    for (const row of dates) {
      const date = isoDate(row.played_on);
      if (!date || date === today) continue;
      out.push({ date, games: await db.gamesByDate(date, 400) });
      if (out.length >= 6) break;
    }
    pastDays = out;
    pastDaysAt = Date.now();
  } catch (e) { auto.lastError = e.message; }
  return pastDays;
}

function runLocal() {
  const games = [...(state.history || [])].slice(0, ai.MAX_GAMES);
  const result = ai.localAnalysis(games, { pastDays });
  auto.lastLocalAt = Date.now();
  auto.lastGame = state.lastFinished ? state.lastFinished.number : null;
  const isNew = pushResult(result);
  const created = [];
  for (const proposal of result.strategies || []) {
    const saved = saveProposal(proposal, 'auto-local');
    if (saved) created.push(saved);
  }
  return { result, isNew, created };
}

async function runRemote() {
  if (!ai.keyLooksValid()) return null;
  const games = [...(state.history || [])].slice(0, 60);
  if (games.length < 6) return null;
  try {
    await refreshPastDays();
    const result = await ai.analyze({
      games,
      pastDays,
      objective: "Analyse automatique en temps réel : cherche aussi des régularités nouvelles (carte précise suivie d'un costume, décalages a+1/a+2/a+3, répétition d'une journée déjà jouée) et propose les remplacements de costume utiles aux stratégies existantes.",
    });
    auto.lastRemoteAt = Date.now();
    auto.lastError = null;
    pushResult(result);
    for (const proposal of result.strategies || []) saveProposal(proposal, 'auto-pollinations');
    return result;
  } catch (error) {
    auto.lastError = error.message;
    auto.lastRemoteAt = Date.now();
    return null;
  }
}

let localTimer = null;
let remoteTimer = null;

function start(onChange) {
  if (auto.running || !auto.enabled) return auto;
  auto.running = true;
  const tickLocal = () => {
    try { const r = runLocal(); if (r.isNew && onChange) onChange(); }
    catch (e) { auto.lastError = e.message; }
    // analyse cumulative par paliers de 4 jeux (1→4, 1→8, 1→12 … 1→1440)
    cumulative.tick().then((r) => {
      // avis cumulé sur les stratégies existantes (panneau « Avis IA »)
      advisor.run({ remote: false }).catch(() => {});
      if (r && r.created && r.created.length && onChange) onChange();
    }).catch((e) => { auto.lastError = e.message; });
  };
  const tickRemote = () => {
    refreshPastDays()
      .then(() => runRemote())
      .then((r) => { if (r && onChange) onChange(); })
      .catch((e) => { auto.lastError = e.message; auto.lastRemoteAt = Date.now(); });
  };
  tickLocal();
  localTimer = setInterval(tickLocal, config.AI_LOCAL_INTERVAL_MS);
  remoteTimer = setInterval(tickRemote, config.AI_REMOTE_INTERVAL_MS);
  setTimeout(tickRemote, 20000);
  pruneExpiredStrategies().catch((e) => { auto.lastError = e.message; });
  pruneTimer = setInterval(() => {
    pruneExpiredStrategies().catch((e) => { auto.lastError = e.message; });
  }, PRUNE_CHECK_INTERVAL_MS);
  return auto;
}

function stop() {
  auto.running = false;
  if (localTimer) clearInterval(localTimer);
  if (remoteTimer) clearInterval(remoteTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  localTimer = remoteTimer = pruneTimer = null;
  return auto;
}

function status() {
  return {
    ...auto,
    keyConfigured: ai.keyLooksValid(),
    model: config.POLLINATIONS.MODEL,
    localIntervalMs: config.AI_LOCAL_INTERVAL_MS,
    remoteIntervalMs: config.AI_REMOTE_INTERVAL_MS,
    results: state.aiAnalyses.slice(0, 6),
    strategies: state.aiStrategies || [],
    cumulative: cumulative.status(),
  };
}

module.exports = { MIN_STRATEGY_RATE, listStrategies, eliteStrategies, trackRate, start, stop, status, cumulative, runLocal, runRemote, saveProposal, refreshPastDays, getPastDays: () => pastDays, auto, pruneExpiredStrategies };
