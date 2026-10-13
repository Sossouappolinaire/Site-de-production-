// best-weak-top.js — « Meilleur + plus faible » : deux modes de configuration, pour les deux stratégies
// « Dizaine — costume le plus / le moins sorti » et « Costume faible sur 2 cartes (miroir) ».
//
// ─── Mode « multi » : UN message de prédiction qui propose 2 à 4 costumes ───────────────────────────────────────
//   On coche au moins 2 parmi : le meilleur (1ᵉʳ), le 2ᵉ, le 3ᵉ meilleur, le plus faible (4ᵉ). Quand tous ceux qui sont
//   cochés ont prédit le MÊME numéro de jeu, un seul message part, avec le pourcentage instantané de chacun :
//
//       ♦️ 85%  ─────┐
//                   ├ N°464
//       ❤️ 78%  ─────┘
//
//   VÉRIFICATION DES DEUX COSTUMES : le message est édité à chaque résultat et garde TOUJOURS les deux costumes, chacun avec
//   son propre résultat (main du JOUEUR, rattrapages N, N+1… jusqu'au nombre configuré) :
//
//       ♦️✅0️⃣ 100%─────┐
//                   ├ N°1438
//       ♣️✅3️⃣ 92% ─────┘
//
//   Un costume pas encore sorti affiche ⏳ tant que l'autre est vérifié ; un costume jamais sorti dans les rattrapages
//   affiche ❌. La configuration compte UNE victoire dès que l'un des costumes sort, une perte si aucun ne sort.
//
// ─── Mode « relance » (🔄 Relance +3) : choisir 1, 2 ou 3 des 4 meilleurs, relancer à +3 ce qui n'est pas sorti ─────
//   « Créer » → stratégie (Dizaine ou Costume faible) → ID du canal, rattrapages, et 1, 2 ou 3 costumes parmi les 4
//   (meilleur, 2ᵉ, 3ᵉ, plus faible). Avec 2 cochés, le message est le même que le mode « multi » :
//
//       ♣️ 95%
//        ┣━ N°1135
//       ♦️ 94%
//
//   Règle : si un costume est sorti directement (✅0️⃣) au jeu N ET que l'autre n'est toujours pas sorti au jeu N+1, le MÊME
//   message est édité : on y ajoute seulement le numéro de la relance (N+3), le costume pas venu reste ⏳ :
//
//       ♣️✅0️⃣ 95%
//        ┣━ N°1135
//        ┣━ N°1138⏳
//       ♦️⏳ 94%
//
//   Pas de relance si les deux costumes sortent, si l'autre sort à N ou N+1, ou si aucun ne sort directement (perdu, ou un
//   seul costume sorti à un rattrapage). Si l'autre sort à N+2 (avant N+3), le N° de la relance est retiré du message.
//   Avec 3 costumes, il en reste 2 dans la relance ; même règle pour la suite (3 relances au maximum). Sans rattrapage (0),
//   on ne peut pas attendre N+1 : la relance part dès le jeu N.
//
// ─── Mode « détection auto » (🔎) : trouver tout seul les canaux qui publient ce format à deux costumes ────────────
//       ♦️ 100%─────┐
//                   ├ N°1438            (avec ou sans résultats ✅0️⃣ / ❌ déjà édités dans le message)
//       ♣️ 92% ─────┘
//   Le bot lit les publications des canaux où il est présent (channel_post) : chaque message de ce format enregistre le canal
//   dans la liste « canaux détectés ». On sélectionne un (ou plusieurs) canal détecté, puis on configure : ID du canal Telegram
//   où envoyer, nombre de rattrapages, format de prédiction. Surveillance : une fois la main du joueur terminée au jeu N,
//   si le PREMIER costume est sorti directement (✅0️⃣) et pas le deuxième → le deuxième est prédit à N+2 ; si c'est le
//   DEUXIÈME qui est sorti directement et pas le premier → le premier est prédit à N+2 (vice-versa). Les deux sortis, ou
//   aucun → rien n'est envoyé.
//
// ─── Mode « déclencheur » (bouton de l'accueil) : prédiction simple, au format choisi ────────────────────────────
//   Le bot surveille les 4 configurations (meilleur, 2ᵉ, 3ᵉ, 4ᵉ) et envoie une prédiction dans le canal quand :
//     1. une configuration vient d'enchaîner 2 PERTES consécutives        → sa prochaine prédiction est envoyée ;
//     2. une configuration a gagné 2 fois de suite au rattrapage 2 ou 3   → sa prochaine prédiction est envoyée ;
//     3. un costume n'est pas sorti (main du joueur) depuis 13 jeux       → ce costume est prédit à N+1 ET à N+5.
//   Le message est ensuite édité au résultat (✅ / ❌) avec le même format.
//
// ─── Mode « cycle » : on suit UNE configuration à la fois, parmi les 4 ──────────────────────────────────────────
//   On suit d'abord le MEILLEUR (A) et on envoie ses prédictions. Tant que chaque prédiction envoyée gagne en ✅0️⃣ ou
//   ✅1️⃣, on reste sur la même configuration. Dès qu'une prédiction finit en ✅2️⃣, ✅3️⃣ (ou plus) ou ❌, on passe à la suivante,
//   dans l'ordre : meilleur → plus faible → 2ᵉ meilleur → 3ᵉ meilleur. Une seule prédiction à la fois.
//   Quand les 4 sont passées, le cycle NE recommence PAS tout seul : on attend qu'une des 4 configurations PERDE (une des
//   prédictions à venir). Celle qui perd est alors suivie : sa prochaine prédiction est envoyée, et les mêmes règles
//   s'appliquent (elle reste tant que ✅0️⃣/✅1️⃣, puis on enchaîne dans l'ordre jusqu'à avoir refait le tour des 4).
//
// ─── Mode « suivi » (bouton « Créer » de l'accueil) : suivre les messages à plusieurs costumes du bot ────────────
//   On coche, dans la liste de tous les canaux qui reçoivent des prédictions, ceux à suivre. Chaque message à plusieurs
//   costumes que CE bot publie dans un canal coché (♦️ 95% / ♣️ 93% / N°884) donne une prédiction simple, au format choisi :
//     • rotation (selon le résultat) : on prédit le costume au meilleur taux (1ᵉʳ) ; tant que notre prédiction gagne en
//       ✅0️⃣ ou ✅1️⃣ on reste sur lui ; si le résultat est ✅2️⃣/✅3️⃣… ou ❌, le message suivant utilise le 2ᵉ costume (puis le 3ᵉ,
//       puis retour au 1ᵉʳ), et ainsi de suite. Le compteur tourne par canal suivi ;
//     • motif : une fois la main du joueur terminée au jeu N, si UN des deux costumes est sorti directement (✅0️⃣) et pas
//       l'autre, l'autre est prédit au jeu N+2 ; si les deux sont sortis, on ignore.
//
// ─── ANTI-DOUBLONS ─────────────────────────────────────────────────────────────────────────────────────────────
//   • configurations : deux configurations identiques (même mode, même stratégie, mêmes costumes et un canal en commun)
//     sont refusées à la création / modification, et les doublons déjà enregistrés sont fusionnés au chargement ;
//   • prédictions : une configuration n'envoie JAMAIS deux prédictions pour le même numéro de jeu (verrou pendant l'envoi
//     + mémoire persistée des envois, valable après un redémarrage).
'use strict';

const store = require('./store');
const db = require('./db');
const { state, hasSuit, setOnShoeReset } = require('./predictor');
const earlyVerify = require('./early-verify');
const fmt = require('./formats');

const STRATEGIES = {
  dizaine: 'Dizaine — costume le plus / le moins sorti',
  costumeFaible: 'Costume faible sur 2 cartes (miroir)',
};
const RANK_LABELS = { 1: 'Le meilleur', 2: 'Le 2ᵉ meilleur', 3: 'Le 3ᵉ meilleur', 4: 'Le plus faible (4ᵉ)' };
const DEFAULT_RANKS = [1, 4];
const TEST_DEFAULT_RANKS = [1, 2]; // mode Test : le meilleur et le 2ᵉ meilleur par défaut
const SUITS = ['♦️', '❤️', '♣️', '♠️'];
const TRIGGER = { lossRun: 2, bigSteps: [2, 3], bigStepRun: 2, absenceGames: 13, offsets: [1, 5] };
const TRIGGER_LABEL = `${TRIGGER.lossRun} pertes de suite · ${TRIGGER.bigStepRun}× rattrapage 2 ou 3 de suite · costume absent ${TRIGGER.absenceGames} jeux (+${TRIGGER.offsets.join(' et +')})`;
const CYCLE_ORDER = [1, 4, 2, 3]; // meilleur → plus faible → 2ᵉ → 3ᵉ → (retour au meilleur)
const CYCLE_STAY_STEPS = [0, 1];  // ✅0️⃣ ou ✅1️⃣ : on reste sur la même configuration
const TZ = process.env.RESET_TZ || 'Africa/Abidjan';
const KEYCAP = (n) => `${Number(n)}\uFE0F\u20E3`;
const dayKey = (ts = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));

const MODES = ['trigger', 'cycle', 'follow', 'test', 'scan', 'relance']; // + « multi » (par défaut)
const RELAUNCH_OFFSET = 3;   // mode relance : le costume pas sorti est relancé à N+3
const RELAUNCH_MAX_DEPTH = 3; // relances en chaîne (3 costumes → 2 puis 1)
const RELAUNCH_DEFAULT_RANKS = [1, 2];
const SRC_MODES = ['follow', 'scan'];                          // modes qui surveillent des canaux sources (c.sources)
const DETECT_MAX = 200;                                         // canaux détectés conservés

const panel = {
  configs: [], pending: [], recentSent: [], watch: [], detected: {}, duplicatesRemoved: 0, duplicatesBlocked: 0,
  trig: { day: null, results: {}, armed: {}, absenceFired: {} },
  sentCount: 0, lastSentAt: null, lastError: null, channelTitles: {},
};
const inflight = new Set(); // « configuration:jeu » en cours d'envoi (verrou anti-doublon)
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }

// fournisseurs de pourcentage « en direct » (un par stratégie, enregistrés par les stratégies elles-mêmes)
const pctProviders = {};
function setPctProvider(strategy, fn) { if (typeof fn === 'function') pctProviders[strategy] = fn; }

// fournisseurs de rang (1 meilleur · 2 · 3 · 4 plus faible) d'une configuration, par stratégie
const rankProviders = {};
function setRankProvider(strategy, fn) { if (typeof fn === 'function') rankProviders[strategy] = fn; }
// rang du mode Test (position dans le classement du jour) : même règle que celle qui choisit la prédiction à envoyer
const testRankProviders = {};
function setTestRankProvider(strategy, fn) { if (typeof fn === 'function') testRankProviders[strategy] = fn; }

// numéro de jeu → rangs ayant prédit (mode multi, mémoire seulement)
const collector = new Map();

function parseChannels(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    if (/^-?\d+$/.test(t)) { const n = Number(t); if (Number.isFinite(n) && n !== 0 && !out.includes(n)) out.push(n); }
    else { const name = t.startsWith('@') ? t : `@${t.replace(/^https?:\/\/t\.me\//i, '')}`; if (name.length > 2 && !out.includes(name)) out.push(name); }
  }
  return out;
}
const sanitizeMaxR = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, Math.min(9, n)) : 2; };
const sanitizeStrategy = (v) => (STRATEGIES[v] ? v : null);
const sanitizeMode = (v) => (MODES.includes(v) ? v : 'multi');
const sanitizeFormat = (v) => fmt.clampFormat(v);
const sanitizeName = (v) => String(v == null ? '' : v).trim().slice(0, 60);
const modeOf = (c) => (c && MODES.includes(c.mode) ? c.mode : 'multi');
const multiLike = (c) => modeOf(c) === 'multi' || modeOf(c) === 'relance'; // messages à plusieurs costumes (♦️ 95% ─┐ / N° / ♣️ 94% ─┘)
const simpleMode = (c) => !multiLike(c); // tout sauf « multi » et « relance » : message simple au format choisi
const hasRanksMode = (m) => m === 'multi' || m === 'test' || m === 'relance';
const defaultRanks = (m) => (m === 'test' ? TEST_DEFAULT_RANKS : m === 'relance' ? RELAUNCH_DEFAULT_RANKS : DEFAULT_RANKS).slice();
const srcMode = (c) => SRC_MODES.includes(modeOf(c));
// rangs choisis (mode multi) : au moins 2, au plus 4, parmi 1 (meilleur) · 2 · 3 · 4 (plus faible)
function sanitizeRanks(v, mode) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;]+/);
  const out = [...new Set(list.map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 4))].sort((a, b) => a - b);
  if (mode === 'relance') { // relance : 1, 2 ou 3 costumes parmi les 4 meilleurs
    if (out.length < 1 || out.length > 3) throw new Error('Coche 1, 2 ou 3 costumes parmi les 4 meilleurs.');
    return out;
  }
  if (out.length < 2) throw new Error('Coche au moins 2 costumes (meilleur, 2ᵉ, 3ᵉ ou plus faible).');
  return out;
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const saved = {
    configs: panel.configs, pending: panel.pending, recentSent: panel.recentSent, watch: panel.watch, detected: panel.detected, trig: panel.trig,
    duplicatesRemoved: panel.duplicatesRemoved, duplicatesBlocked: panel.duplicatesBlocked,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, channelTitles: panel.channelTitles,
  };
  try { store.patch({ bestWeakTop: saved }); } catch (_) {}
  if (db.ready) db.setSetting('best_weak_top_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  panel.configs = (Array.isArray(saved.configs) ? saved.configs : []).map((c) => {
    const mode = modeOf(c);
    const src = SRC_MODES.includes(mode);
    return {
      id: String(c.id), mode, name: sanitizeName(c.name), strategy: src ? mode : (sanitizeStrategy(c.strategy) || 'dizaine'), channels: parseChannels(c.channels),
      sources: src ? parseChannels(c.sources).map(String) : [], rot: c.rot && typeof c.rot === 'object' ? c.rot : {},
      maxR: sanitizeMaxR(c.maxR), format: sanitizeFormat(c.format),
      cycleRole: CYCLE_ORDER.includes(Number(c.cycleRole)) ? Number(c.cycleRole) : 1, cycleWaiting: !!c.cycleWaiting,
      cycleDone: Array.isArray(c.cycleDone) ? c.cycleDone.map(Number).filter((r) => CYCLE_ORDER.includes(r)) : [],
      ranks: !hasRanksMode(mode) ? [] : (() => { try { return sanitizeRanks(c.ranks, mode); } catch (_) { return defaultRanks(mode); } })(),
      enabled: c.enabled !== false, sentCount: Number(c.sentCount) || 0, wins: Number(c.wins) || 0, losses: Number(c.losses) || 0, lastSentAt: c.lastSentAt || null,
      lossGate: mode === 'test' && !!c.lossGate, gateFrom: [1, 2, 3, 4].includes(Number(c.gateFrom)) ? Number(c.gateFrom) : null,
    };
  }).filter((c) => c.channels.length);
  for (const c of panel.configs) if (modeOf(c) === 'test') c.testRank = (c.ranks || TEST_DEFAULT_RANKS).includes(Number(c.testRank)) ? Number(c.testRank) : (c.ranks || TEST_DEFAULT_RANKS)[0];
  panel.pending = Array.isArray(saved.pending) ? saved.pending.slice(-300) : [];
  panel.recentSent = Array.isArray(saved.recentSent) ? saved.recentSent.slice(-500) : [];
  panel.watch = Array.isArray(saved.watch) ? saved.watch.slice(-100) : [];
  panel.detected = saved.detected && typeof saved.detected === 'object' ? saved.detected : {};
  const t = saved.trig && typeof saved.trig === 'object' ? saved.trig : {};
  panel.trig = { day: t.day || null, results: t.results || {}, armed: t.armed || {}, absenceFired: t.absenceFired || {} };
  panel.duplicatesRemoved = Number(saved.duplicatesRemoved) || 0;
  panel.duplicatesBlocked = Number(saved.duplicatesBlocked) || 0;
  panel.sentCount = Number(saved.sentCount) || 0;
  panel.lastSentAt = saved.lastSentAt || null;
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
  dedupeConfigs();
}
function restore() { try { const s = (store.read() || {}).bestWeakTop; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting('best_weak_top_state'); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

// ---------------------------------------------------------------------------
// Configurations + ANTI-DOUBLONS DE CONFIGURATION
// ---------------------------------------------------------------------------
const configKey = (c) => `${modeOf(c)}|${c.strategy}|${hasRanksMode(modeOf(c)) ? (c.ranks || []).join('') : (srcMode(c) ? [...(c.sources || [])].map(String).sort().join(',') : '')}${modeOf(c) === 'test' && c.lossGate ? '|gate' : ''}`;
const shareChannel = (a, b) => { const mine = new Set((a.channels || []).map(String)); return (b.channels || []).some((ch) => mine.has(String(ch))); };
function findDuplicate(cfg, excludeId) {
  return panel.configs.find((o) => o.id !== excludeId && configKey(o) === configKey(cfg) && shareChannel(o, cfg)) || null;
}
const duplicateError = (d) => new Error(`Doublon : une configuration identique envoie déjà dans ce canal${d.name ? ` (« ${d.name} »)` : ''}. Modifie-la ou supprime-la d'abord.`);
// fusionne les doublons déjà enregistrés : on garde la plus ancienne, on additionne ses compteurs
function dedupeConfigs() {
  const kept = []; let removed = 0;
  for (const c of panel.configs) {
    const dup = kept.find((o) => configKey(o) === configKey(c) && shareChannel(o, c));
    if (dup) {
      dup.sentCount = (dup.sentCount || 0) + (c.sentCount || 0); dup.wins = (dup.wins || 0) + (c.wins || 0); dup.losses = (dup.losses || 0) + (c.losses || 0);
      for (const e of panel.pending) if (e.configId === c.id) e.configId = dup.id;
      removed += 1;
    } else kept.push(c);
  }
  if (removed) { panel.configs = kept; panel.duplicatesRemoved += removed; }
  return removed;
}
function addConfig(input = {}) {
  const mode = sanitizeMode(input.mode);
  const src = SRC_MODES.includes(mode);
  const strategy = src ? mode : sanitizeStrategy(input.strategy);
  if (!strategy) throw new Error('Choisis la stratégie (Dizaine ou Costume faible).');
  const sources = src ? parseChannels(input.sources).map(String) : [];
  if (src && !sources.length) throw new Error(mode === 'scan' ? 'Sélectionne au moins un canal détecté.' : 'Coche au moins un canal à suivre.');
  const channels = parseChannels(input.channels);
  if (!channels.length) throw new Error('Renseigne au moins un ID de canal.');
  const cfg = {
    id: `bw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, mode, name: sanitizeName(input.name) || ({ trigger: 'Déclencheur', cycle: 'Cycle', follow: 'Suivi', test: 'Test', scan: 'Détection auto', relance: 'Relance +3' }[mode] || ''),
    strategy, channels, sources, rot: {}, maxR: sanitizeMaxR(input.maxR), format: sanitizeFormat(input.format),
    ranks: !hasRanksMode(mode) ? [] : (input.ranks === undefined ? defaultRanks(mode) : sanitizeRanks(input.ranks, mode)),
    cycleRole: 1, cycleWaiting: false, cycleDone: [],
    enabled: true, sentCount: 0, wins: 0, losses: 0, lastSentAt: null,
    lossGate: mode === 'test' && !!input.lossGate, gateFrom: null,
  };
  if (mode === 'test') cfg.testRank = cfg.ranks[0]; // on commence par le premier rang choisi (normalement le meilleur)
  const dup = findDuplicate(cfg);
  if (dup) throw duplicateError(dup);
  panel.configs.push(cfg); persist(); return cfg;
}
function updateConfig(id, patch = {}) {
  const c = panel.configs.find((x) => x.id === id);
  if (!c) return null;
  const old = JSON.parse(JSON.stringify(c));
  try {
    if (patch.sources !== undefined && srcMode(c)) { const src = parseChannels(patch.sources).map(String); if (!src.length) throw new Error('Choisis au moins un canal à suivre.'); c.sources = src; }
    if (patch.strategy !== undefined && !srcMode(c)) { const s = sanitizeStrategy(patch.strategy); if (!s) throw new Error('Stratégie invalide.'); c.strategy = s; }
    if (patch.channels !== undefined) { const ch = parseChannels(patch.channels); if (!ch.length) throw new Error('Renseigne au moins un ID de canal.'); c.channels = ch; }
    if (patch.maxR !== undefined) c.maxR = sanitizeMaxR(patch.maxR);
    if (patch.name !== undefined) c.name = sanitizeName(patch.name) || c.name;
    if (patch.format !== undefined) c.format = sanitizeFormat(patch.format);
    if (patch.ranks !== undefined && hasRanksMode(modeOf(c))) {
      c.ranks = sanitizeRanks(patch.ranks, modeOf(c));
      if (modeOf(c) === 'test' && !c.ranks.includes(Number(c.testRank))) c.testRank = c.ranks[0];
    }
    if (patch.lossGate !== undefined && modeOf(c) === 'test') { c.lossGate = !!patch.lossGate; c.gateFrom = null; }
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
    const dup = findDuplicate(c, c.id);
    if (dup) throw duplicateError(dup);
  } catch (e) { Object.assign(c, old); throw e; }
  persist(); return c;
}
function removeConfig(id) { panel.configs = panel.configs.filter((c) => c.id !== id); persist(); return true; }
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }
const enabledOf = (strategy, mode) => panel.configs.filter((c) => c.enabled && c.strategy === strategy && modeOf(c) === mode);
const multiConfigs = (strategy) => panel.configs.filter((c) => c.enabled && c.strategy === strategy && multiLike(c)); // « multi » + « relance »
// canaux qui reçoivent aujourd'hui des messages à plusieurs costumes (utile pour guider le choix du suivi)
const hasMultiChannels = () => [...new Set(panel.configs.filter((c) => c.enabled && multiLike(c) && (c.ranks || []).length >= 2).flatMap((c) => c.channels.map(String)))];
const hasEnabled = (strategy) => panel.configs.some((c) => c.enabled && c.strategy === strategy);

// ---------------------------------------------------------------------------
// ANTI-DOUBLONS DE PRÉDICTION : une configuration, un jeu → une seule prédiction
// ---------------------------------------------------------------------------
const sentKey = (cfgId, target) => `${cfgId}:${Number(target)}`;
function alreadySent(cfgId, target) {
  const k = sentKey(cfgId, target);
  return inflight.has(k) || panel.recentSent.includes(k) || panel.pending.some((e) => e.configId === cfgId && Number(e.target) === Number(target));
}
function rememberSent(cfgId, target) {
  panel.recentSent.push(sentKey(cfgId, target));
  if (panel.recentSent.length > 500) panel.recentSent = panel.recentSent.slice(-500);
}
const blocked = () => { panel.duplicatesBlocked += 1; };

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
const pctText = (p) => (Number.isFinite(p) ? `${Math.round(p)}%` : '--%');
// Résultat d'un costume dans le message : '' (pas encore de résultat) · ⏳ (encore en vérification, un autre est déjà sorti)
// · ✅N (sorti au rattrapage N) · ❌ (jamais sorti)
function suitMark(s, anyDone) {
  if (s.res === undefined || s.res === null) return anyDone ? '⏳' : '';
  return s.res >= 0 ? `✅${KEYCAP(s.res)}` : '❌';
}
// items : [{ suit, pct, res? }] dans l'ordre meilleur → plus faible (1 à 4). Format « arbre » : un costume par ligne, et les
// numéros de jeu en branche (┣━ N°…) entre les costumes. withResults : affiche le résultat de chaque costume (vérification).
//   ♦️✅0️⃣ 94%
//    ┣━ N°1250
//    ┣━ N°1253⏳        ← relance (extraTargets), chaque relance ajoute seulement son numéro
//   ❤️✅0️⃣ 94%
function predictionText(target, items, withResults, forcePending, extraTargets) {
  const anyDone = !!withResults && (!!forcePending || items.some((s) => s.res !== undefined && s.res !== null));
  const lines = items.map((s) => `${s.suit}${withResults ? suitMark(s, anyDone) : ''} ${pctText(s.pct)}`);
  const branches = [` ┣━ N°${target}`, ...(Array.isArray(extraTargets) ? extraTargets : []).map((t) => ` ┣━ N°${t}`)];
  const cut = Math.ceil(lines.length / 2); // les numéros se placent après la moitié des costumes (1 costume : en tête)
  const rows = [...lines.slice(0, cut), ...branches, ...lines.slice(cut)];
  return `<pre>${rows.join('\n')}</pre>`;
}
// message simple du mode « déclencheur » (même moteur de formats que les autres stratégies)
function triggerMessage(entryLike, statusFr) {
  return fmt.renderMessage(entryLike.format, {
    gameNumber: entryLike.target, suit: entryLike.suits[0].suit, strategy: entryLike.strategyName || 'Déclencheur',
    maxR: entryLike.maxR, status: statusFr, rattrapage: entryLike.step || 0,
  }, null);
}

async function sendToChannels(cfg, text, parseMode) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return []; }
  const out = [];
  const results = await Promise.all(cfg.channels.map((id) => bot.sendMessage(id, text, parseMode ? { parse_mode: parseMode } : {})
    .then((m) => (m && m.skipped ? { ok: false, skipped: true, id } : { ok: true, id, messageId: m.message_id }))
    .catch((e) => ({ ok: false, id, error: e.message }))));
  for (const r of results) { if (r.ok) out.push({ chatId: r.id, messageId: r.messageId }); else if (!r.skipped) panel.lastError = `${r.id} : ${r.error}`; }
  return out;
}
function editAll(entry, text, parseMode) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  for (const m of entry.messages || []) bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId, ...(parseMode ? { parse_mode: parseMode } : {}) }).catch(() => {});
}
function editTrigger(entry, statusFr) { const o = triggerMessage(entry, statusFr); editAll(entry, o.text, o.parse_mode); }

// ---------------------------------------------------------------------------
// Mode « déclencheur » : envoi d'une prédiction simple
// ---------------------------------------------------------------------------
async function sendTrigger(cfg, { target, suit, reason, role, src }) {
  if (!Number.isFinite(Number(target)) || !suit) return false;
  if (alreadySent(cfg.id, target)) { blocked(); return false; } // doublon de prédiction
  const k = sentKey(cfg.id, target);
  inflight.add(k);
  try {
    const entry = {
      id: `bwt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, configId: cfg.id, mode: modeOf(cfg), reason, role: role || null, src: src == null ? null : String(src), strategy: cfg.strategy,
      target: Number(target), suits: [{ suit }], format: cfg.format, strategyName: cfg.name || (modeOf(cfg) === 'test' ? 'Test meilleur / 2ᵉ' : 'Déclencheur'),
      maxR: cfg.maxR, step: 0, gap: 0, skipped: 0, status: 'en attente', messages: [], createdAt: Date.now(), resolvedAt: null,
    };
    const out = triggerMessage(entry, 'en attente');
    entry.messages = await sendToChannels(cfg, out.text, out.parse_mode);
    if (!entry.messages.length) return false;
    panel.pending.push(entry); rememberSent(cfg.id, target);
    cfg.sentCount = (cfg.sentCount || 0) + 1; cfg.lastSentAt = Date.now();
    panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null;
    persist();
    return true;
  } catch (e) { panel.lastError = e.message; return false; } finally { inflight.delete(k); }
}
function ensureTrigDay() {
  const d = dayKey();
  if (panel.trig.day !== d) panel.trig = { day: d, results: {}, armed: {}, absenceFired: panel.trig.absenceFired || {} };
  return panel.trig;
}
// résultat d'une configuration (appelé par les stratégies à chaque prédiction vérifiée, hors relais)
function recordResult(strategy, ref, field, step) {
  try {
    if (ref == null) return;
    // mode cycle : une fois les 4 passées, on attend qu'une des 4 configurations PERDE ; celle qui perd est suivie
    if (field === 'losses') {
      const waiting = enabledOf(strategy, 'cycle').filter((cfg) => cfg.cycleWaiting);
      const rank = waiting.length && rankProviders[strategy] ? rankProviders[strategy](ref) : null;
      if (rank) {
        for (const cfg of waiting) { cfg.cycleWaiting = false; cfg.cycleRole = rank; cfg.cycleDone = []; }
        persist();
      }
    }
    // mode Test avec « envoyer après une perte » : la perte d'un des rangs choisis ouvre l'envoi pour le rang suivant
    if (field === 'losses' && (testRankProviders[strategy] || rankProviders[strategy])) {
      const gated = enabledOf(strategy, 'test').filter((cfg) => cfg.lossGate);
      const lostRank = gated.length ? Number((testRankProviders[strategy] || rankProviders[strategy])(ref)) : null;
      if (lostRank) {
        let touched = false;
        for (const cfg of gated) { if ((cfg.ranks || []).includes(lostRank)) { cfg.gateFrom = lostRank; touched = true; } }
        if (touched) persist();
      }
    }
    if (!enabledOf(strategy, 'trigger').length) return;
    const ts = ensureTrigDay();
    const key = `${strategy}:${ref}`;
    const list = (ts.results[key] = ts.results[key] || []);
    list.push({ ok: field === 'wins', step: Number(step) || 0 });
    if (list.length > 6) list.shift();
    const last = list.slice(-2);
    let reason = null;
    if (last.length === 2 && last.every((r) => !r.ok)) reason = 'pertes';
    else if (last.length === 2 && last.every((r) => r.ok && TRIGGER.bigSteps.includes(r.step))) reason = 'rattrapages';
    if (reason) ts.armed[key] = { reason, at: Date.now() }; else delete ts.armed[key];
    persist();
  } catch (e) { panel.lastError = e.message; }
}
// mode « suivi » : après le résultat de NOTRE prédiction — ✅0️⃣/✅1️⃣ → même rang au prochain message ; sinon → rang suivant
function advanceFollow(cfg, entry) {
  if (!cfg || modeOf(cfg) !== 'follow' || entry.reason !== 'rotation' || entry.src == null) return;
  const stay = entry.status === 'gagné' && CYCLE_STAY_STEPS.includes(Number(entry.step));
  if (stay) return;
  cfg.rot = cfg.rot || {};
  cfg.rot[entry.src] = (cfg.rot[entry.src] || 0) + 1;
}
const cyclePending = (cfg) => panel.pending.some((e) => e.configId === cfg.id && e.status === 'en attente');
// mode cycle : prédiction de la configuration suivie (une seule à la fois ; rien tant qu'on attend une perte)
async function handleCyclePrediction(strategy, rank, data) {
  for (const cfg of enabledOf(strategy, 'cycle')) {
    if (cfg.cycleWaiting || rank !== cfg.cycleRole || cyclePending(cfg)) continue;
    await sendTrigger(cfg, { target: data.target, suit: data.suit, reason: 'cycle', role: rank });
  }
}
// Le mode « Test » commence par le premier rang choisi (le meilleur) et passe au rang suivant après une perte de SA prédiction
// (2 rangs : meilleur ↔ 2ᵉ meilleur ; jusqu'à 4 : meilleur → 2ᵉ → 3ᵉ → plus faible → retour au meilleur).
// Verrou par configuration : pendant l'envoi (asynchrone) d'une prédiction, la suivante n'est pas lancée — sinon deux
// prédictions pouvaient partir avant que la 1ʳᵉ soit marquée « en attente » (le mode Test n'attendait alors pas le résultat).
const testBusy = new Set();
async function handleTestPrediction(strategy, rank, data) {
  for (const cfg of enabledOf(strategy, 'test')) {
    if (cyclePending(cfg) || testBusy.has(cfg.id)) continue;
    if (cfg.lossGate) {
      // « envoyer après une perte » : il faut qu'un des rangs choisis ait perdu ; on prédit alors l'AUTRE rang (le 1ᵉʳ si le 2ᵉ a perdu,
      // le 2ᵉ si le 1ᵉʳ a perdu). Aucune perte → rien n'est envoyé. L'envoi consomme la perte : il en faut une nouvelle pour le suivant.
      const ranks = Array.isArray(cfg.ranks) && cfg.ranks.length >= 2 ? cfg.ranks : TEST_DEFAULT_RANKS;
      const i = ranks.indexOf(Number(cfg.gateFrom));
      if (i < 0 || rank !== ranks[(i + 1) % ranks.length]) continue;
    } else if (rank !== cfg.testRank) continue;
    testBusy.add(cfg.id);
    try {
      const ok = await sendTrigger(cfg, { target: data.target, suit: data.suit, reason: 'test', role: rank });
      if (ok && cfg.lossGate) { cfg.gateFrom = null; persist(); }
    } finally { testBusy.delete(cfg.id); }
  }
}
// résultat de NOTRE prédiction : ✅0️⃣/✅1️⃣ → on reste ; ✅2️⃣/✅3️⃣… ou ❌ → on passe à la suivante ; les 4 passées → attente d'une perte
function advanceCycle(cfg, entry) {
  const stay = entry.status === 'gagné' && CYCLE_STAY_STEPS.includes(Number(entry.step));
  if (stay) return;
  cfg.cycleDone = [...new Set([...(cfg.cycleDone || []), cfg.cycleRole])];
  const start = CYCLE_ORDER.indexOf(cfg.cycleRole);
  for (let i = 1; i <= CYCLE_ORDER.length; i++) {
    const r = CYCLE_ORDER[(start + i) % CYCLE_ORDER.length];
    if (!cfg.cycleDone.includes(r)) { cfg.cycleRole = r; return; }
  }
  cfg.cycleWaiting = true; cfg.cycleDone = []; // les 4 sont passées : on attend qu'une des 4 perde
}
function advanceTest(cfg, entry) {
  if (!cfg || entry.status !== 'perdu') return;
  const ranks = Array.isArray(cfg.ranks) && cfg.ranks.length >= 2 ? cfg.ranks : TEST_DEFAULT_RANKS;
  const i = ranks.indexOf(Number(cfg.testRank));
  cfg.testRank = ranks[(i + 1) % ranks.length]; // dernier rang → retour au premier ; rang inconnu → premier
}
// prochaine prédiction d'une configuration « armée » → envoyée dans les canaux déclencheur
async function handleTriggerPrediction(strategy, data) {
  const ts = ensureTrigDay();
  const key = `${strategy}:${data.ref}`;
  const armed = ts.armed[key];
  if (!armed) return;
  delete ts.armed[key];
  persist();
  for (const cfg of enabledOf(strategy, 'trigger')) await sendTrigger(cfg, { target: data.target, suit: data.suit, reason: armed.reason });
}
// costume absent depuis 13 jeux (main du joueur) → ce costume est prédit à N+1 et à N+5
async function checkAbsence() {
  const cfgs = panel.configs.filter((c) => c.enabled && modeOf(c) === 'trigger');
  if (!cfgs.length) return;
  const maxDone = maxFinishedGameNumber();
  if (!maxDone) return;
  const ts = ensureTrigDay();
  for (const suit of SUITS) {
    let absent = 0; let lastSeen = 0; let contiguous = true;
    for (let n = maxDone; n > 0 && n > maxDone - 60; n--) {
      const g = state.games.get(n);
      if (!g || !g.finished || g.complete === false) { // jeu manquant : si l'absence est déjà assez longue, il sert de repère de série
        if (absent >= TRIGGER.absenceGames) lastSeen = n; else contiguous = false;
        break;
      }
      if (hasSuit(g, suit)) { lastSeen = n; break; }
      absent += 1;
    }
    if (!contiguous || absent < TRIGGER.absenceGames) continue;
    if (ts.absenceFired[suit] === lastSeen) continue; // une seule série de prédictions par absence
    ts.absenceFired[suit] = lastSeen;
    for (const cfg of cfgs) for (const off of TRIGGER.offsets) await sendTrigger(cfg, { target: maxDone + off, suit, reason: 'absence' });
    persist();
  }
}

// ---------------------------------------------------------------------------
// Mode « suivi » : prédictions tirées des messages à plusieurs costumes publiés par le bot dans les canaux cochés
// ---------------------------------------------------------------------------
async function onMultiSent(chatId, entry) {
  const src = String(chatId);
  // nos propres messages à deux costumes sont aussi « détectés » (le bot ne reçoit pas ses propres publications de canal)
  if ((entry.suits || []).length === 2) {
    const duo = { target: Number(entry.target), items: entry.suits.map((x) => ({ suit: x.suit, pct: Number.isFinite(x.pct) ? x.pct : 0 })) };
    registerDetected(src, panel.channelTitles[src] || '', duo, false, true);
    queueScan(src, duo);
  }
  for (const cfg of panel.configs.filter((c) => c.enabled && modeOf(c) === 'follow' && (c.sources || []).map(String).includes(src))) {
    const items = entry.suits || [];
    if (!items.length) continue;
    // 1) rotation pilotée par le RÉSULTAT : on envoie le costume au meilleur taux (n°1) ; on reste dessus tant que notre
    //    prédiction gagne en ✅0️⃣ ou ✅1️⃣ ; on passe au costume suivant (n°2…) seulement si le résultat est ✅2️⃣/✅3️⃣… ou ❌
    //    (voir advanceFollow). Le compteur tourne par canal suivi.
    cfg.rot = cfg.rot || {};
    const idx = (cfg.rot[src] || 0) % items.length;
    await sendTrigger(cfg, { target: entry.target, suit: items[idx].suit, reason: 'rotation', role: idx + 1, src });
    // 2) motif : on attend que le joueur ait fini ses cartes au jeu N ; si UN des deux costumes sort directement (✅0️⃣)
    //    et pas l'autre → l'autre est prédit au jeu N+2 ; si les deux sortent, on ignore (voir checkPatterns)
    if (items.length >= 2 && !panel.watch.some((w) => w.cfgId === cfg.id && w.target === Number(entry.target))) {
      panel.watch.push({ cfgId: cfg.id, target: Number(entry.target), s1: items[0].suit, s2: items[1].suit, src, at: Date.now() });
      if (panel.watch.length > 100) panel.watch = panel.watch.slice(-100);
    }
    persist();
  }
}
async function checkPatterns() {
  if (!panel.watch.length) return;
  const maxDone = maxFinishedGameNumber();
  const keep = [];
  for (const w of panel.watch) {
    const done = (g) => !!g && g.finished && g.complete !== false; // le joueur a fini de prendre ses cartes
    const g0 = state.games.get(w.target);
    if (done(g0)) {
      const cfg = panel.configs.find((c) => c.id === w.cfgId && c.enabled);
      const late = w.kind === 'scan' && maxDone > w.target + 1; // N+2 déjà joué : trop tard pour le prédire
      if (cfg && !late) {
        const a = hasSuit(g0, w.s1); const b = hasSuit(g0, w.s2);
        // un seul des deux est sorti directement (✅0️⃣) → l'autre est prédit à N+2 ; les deux sortis (ou aucun) → on ignore
        if (a && !b) await sendTrigger(cfg, { target: w.target + 2, suit: w.s2, reason: 'motif', src: w.src });
        else if (b && !a) await sendTrigger(cfg, { target: w.target + 2, suit: w.s1, reason: 'motif', src: w.src });
      }
      continue; // motif évalué : on ne le garde plus
    }
    if (maxDone > w.target + 4 || Date.now() - w.at > 6 * 3600 * 1000) continue; // jeux manquants : abandon
    keep.push(w);
  }
  if (keep.length !== panel.watch.length) { panel.watch = keep; persist(); }
}

// ---------------------------------------------------------------------------
// Mode « détection auto » : repérer les canaux qui publient le format à deux costumes, et suivre la règle « N+2 »
// ---------------------------------------------------------------------------
const SUIT_CHARS = { '♦': '♦️', '♥': '❤️', '❤': '❤️', '♣': '♣️', '♠': '♠️' };
// Lit un message au format à DEUX costumes (avec ou sans résultats déjà édités) :
//   ♦️ 100%─────┐ / ├ N°1438 / ♣️ 92% ─────┘      ou      ♦️✅0️⃣ 100%─────┐ / ├ N°1438 / ♣️✅3️⃣ 92% ─────┘
// Renvoie { target, items: [{ suit, pct, res? }] } (items dans l'ordre d'affichage : le PREMIER costume est celui du haut) ou null.
function parseDuo(text) {
  if (typeof text !== 'string' || !text || text.length > 800) return null;
  const t = text.replace(/️/g, ''); // ♦️ → ♦ ; ✅0️⃣ → ✅0⃣
  const re = /([♦♥❤♣♠])[ \t]*(?:(?:✅|✔)[ \t]*(\d)?⃣?|(❌)|⏳)?[ \t]*(\d{1,3})(?:[.,]\d+)?[ \t]*%/g;
  const items = []; let m;
  while ((m = re.exec(t)) !== null) {
    const pct = Number(m[4]);
    if (!(pct >= 0 && pct <= 100)) return null;
    const it = { suit: SUIT_CHARS[m[1]], pct };
    if (m[3]) it.res = -1; else if (m[2] !== undefined) it.res = Number(m[2]);
    items.push(it);
  }
  if (items.length !== 2 || items[0].suit === items[1].suit) return null;
  const n = /N[ \t]*[°º˚][ \t]*(\d{1,4})/i.exec(t) || /№[ \t]*(\d{1,4})/.exec(t);
  if (!n) return null;
  const target = Number(n[1]);
  return target > 0 ? { target, items } : null;
}
function registerDetected(id, title, duo, edited, own) {
  const k = String(id);
  const d = panel.detected[k] || { id: k, title: '', count: 0, firstAt: Date.now() };
  if (title) { d.title = String(title).slice(0, 120); panel.channelTitles[k] = d.title; }
  if (!edited) d.count = (d.count || 0) + 1;
  if (own) d.own = true; // canal où CE bot publie lui-même le format (messages « multi »)
  d.lastAt = Date.now(); d.lastTarget = duo.target;
  d.sample = `${duo.items[0].suit} ${duo.items[0].pct}% · ${duo.items[1].suit} ${duo.items[1].pct}% · N°${duo.target}`;
  panel.detected[k] = d;
  const keys = Object.keys(panel.detected);
  if (keys.length > DETECT_MAX) for (const x of keys.sort((a, b) => (panel.detected[b].lastAt || 0) - (panel.detected[a].lastAt || 0)).slice(DETECT_MAX)) delete panel.detected[x];
}
const detectedList = () => Object.values(panel.detected).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
// un nouveau message à deux costumes arrive dans le canal source `src` : chaque configuration « détection auto » qui le
// suit surveille le jeu N (voir checkPatterns)
function queueScan(src, duo) {
  for (const cfg of panel.configs.filter((c) => c.enabled && modeOf(c) === 'scan' && (c.sources || []).map(String).includes(String(src)))) {
    if (panel.watch.some((w) => w.cfgId === cfg.id && w.target === duo.target)) continue;
    if (alreadySent(cfg.id, duo.target + 2)) continue;
    panel.watch.push({ cfgId: cfg.id, target: duo.target, s1: duo.items[0].suit, s2: duo.items[1].suit, src: String(src), kind: 'scan', at: Date.now() });
    if (panel.watch.length > 100) panel.watch = panel.watch.slice(-100);
  }
}
// appelé par le bot pour CHAQUE publication de canal (channel_post) et chaque modification (edited_channel_post)
function onChannelPost(chat, text, opts = {}) {
  try {
    if (!chat || chat.id == null) return false;
    const duo = parseDuo(text);
    if (!duo) return false;
    const edited = !!opts.edited;
    registerDetected(chat.id, chat.title || (chat.username ? `@${chat.username}` : ''), duo, edited);
    if (!edited) queueScan(chat.id, duo); // une modification (résultats ajoutés) ne relance pas la surveillance
    persist();
    return true;
  } catch (e) { panel.lastError = e.message; return false; }
}

// ---------------------------------------------------------------------------
// Mode « multi » : réception des prédictions des rangs 1 (meilleur), 2, 3 et 4 (plus faible)
// ---------------------------------------------------------------------------
async function record(strategy, rank, data) {
  try {
    rank = Number(rank);
    // Mode Test : rang = POSITION dans le classement du jour (1er, 2ᵉ, 3ᵉ, dernier = 4ᵉ s'il y a au moins 4 configurations),
    // même quand la configuration n'est ni « la meilleure » ni « la plus faible » désignées par les autres modes.
    const testRank = data ? Number(data.testRank) : NaN;
    const validRank = rank >= 1 && rank <= 4;
    const validTest = testRank >= 1 && testRank <= 4;
    if (!hasEnabled(strategy) || !data || !Number.isFinite(Number(data.target)) || !data.suit || !(validRank || validTest)) return;
    if (validRank) {
      await handleTriggerPrediction(strategy, data).catch((e) => { panel.lastError = e.message; });
      await handleCyclePrediction(strategy, rank, data).catch((e) => { panel.lastError = e.message; });
    }
    await handleTestPrediction(strategy, validTest ? testRank : rank, data).catch((e) => { panel.lastError = e.message; });
    if (!validRank || !multiConfigs(strategy).length) return;
    const now = Date.now();
    for (const [k, v] of collector) if (now - v.at > 60 * 60 * 1000) collector.delete(k);
    const key = `${strategy}:${Number(data.target)}`;
    const slot = collector.get(key) || { at: now, ranks: {}, sent: new Set() };
    slot.ranks[rank] = { suit: data.suit, ref: data.ref, pct: Number.isFinite(Number(data.pct)) ? Number(data.pct) : null };
    collector.set(key, slot);
    for (const cfg of multiConfigs(strategy).filter((c) => !slot.sent.has(c.id))) {
      const want = cfg.ranks && cfg.ranks.length ? cfg.ranks : DEFAULT_RANKS;
      if (!want.every((r) => slot.ranks[r])) continue; // tous les costumes cochés doivent avoir prédit ce même jeu
      slot.sent.add(cfg.id);
      if (alreadySent(cfg.id, data.target)) { blocked(); continue; } // doublon de prédiction
      const lock = sentKey(cfg.id, data.target);
      inflight.add(lock);
      try {
        // pourcentages recalculés AU MOMENT de l'envoi (taux instantané), pas à celui de leur prédiction
        const items = want.map((r) => {
          const it = { ...slot.ranks[r], rank: r };
          try { const p = pctProviders[strategy] ? pctProviders[strategy](it.ref) : null; if (Number.isFinite(p)) it.pct = p; } catch (_) { /* dernier connu */ }
          return it;
        });
        const entry = {
          id: `bwp-${now}-${Math.random().toString(36).slice(2, 6)}`, configId: cfg.id, mode: modeOf(cfg), strategy, target: Number(data.target),
          suits: items, maxR: cfg.maxR, step: 0, gap: 0, skipped: 0, status: 'en attente', messages: [], createdAt: now, resolvedAt: null,
        };
        entry.messages = await sendToChannels(cfg, predictionText(entry.target, items), 'HTML');
        if (!entry.messages.length) continue;
        panel.pending.push(entry); rememberSent(cfg.id, data.target);
        cfg.sentCount = (cfg.sentCount || 0) + 1; cfg.lastSentAt = now;
        panel.sentCount += 1; panel.lastSentAt = now; panel.lastError = null;
        if (entry.suits.length >= 2) for (const mm of entry.messages) await onMultiSent(mm.chatId, entry).catch((e) => { panel.lastError = e.message; }); // mode « suivi »
      } finally { inflight.delete(lock); }
    }
    persist();
  } catch (e) { panel.lastError = e.message; }
}

// ---------------------------------------------------------------------------
// Vérification : main du JOUEUR, rattrapages N, N+1, N+2…
// ---------------------------------------------------------------------------
function maxFinishedGameNumber() { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; }
// Mode « multi » : VÉRIFICATION DES DEUX COSTUMES (ou plus). Chaque costume a son propre résultat (s.res : numéro du rattrapage
// où il est sorti, -1 = jamais sorti). Le message est édité à chaque nouveau résultat et garde tous les costumes.
// La configuration compte une victoire dès que l'un des costumes sort, une perte seulement si aucun ne sort.
// Relance : la chaîne = message d'origine (racine) + relances successives (même message, on n'y ajoute que le N°)
function relaunchChain(entry) {
  let root = entry; const seen = new Set();
  while (root.parentId && !seen.has(root.id)) { seen.add(root.id); const par = panel.pending.find((e) => e.id === root.parentId); if (!par) break; root = par; }
  const chain = [root];
  for (let guard = 0; guard < 10; guard++) { const last = chain[chain.length - 1]; const next = panel.pending.find((e) => e.parentId === last.id); if (!next) break; chain.push(next); }
  return chain;
}
// résultat affiché d'un costume : celui du message d'origine, sinon celui de la relance qui le reprend (⏳ tant qu'elle est en cours)
function chainRes(chain, suit) {
  let res = null;
  for (const e of chain) {
    const s = e.suits.find((x) => x.suit === suit);
    if (!s) break;
    res = s.res;
    if (res !== undefined && res !== null && res >= 0) break;
  }
  return res;
}
function editMulti(entry) {
  const chain = relaunchChain(entry);
  const root = chain[0];
  if (chain.length === 1) { editAll(root, predictionText(root.target, root.suits, true, !!root.relaunch), 'HTML'); return; }
  const items = root.suits.map((s) => ({ ...s, res: chainRes(chain, s.suit) }));
  // une relance dont tous les costumes sont déjà sortis avant son jeu n'est plus affichée
  const shown = chain.filter((e, i) => i > 0 && !e.suits.every((s) => chain.slice(0, i).some((p) => p.suits.some((x) => x.suit === s.suit && x.res >= 0))));
  editAll(root, predictionText(root.target, items, true, true, shown.map((e) => `${e.target}${e.status === 'gagné' ? '✅' : e.status === 'perdu' ? '❌' : '⏳'}`)), 'HTML');
}
function verifyMulti(entry, cfg, maxDone) {
  let changed = false;
  if (entry.relaunch && entry.status === 'en attente') { // le costume est sorti entre-temps (rattrapage du message d'origine) : relance sans objet
    const chain = relaunchChain(entry); const idx = chain.indexOf(entry);
    const prev = chain.slice(0, Math.max(0, idx));
    if (entry.suits.every((s) => prev.some((e) => e.suits.some((x) => x.suit === s.suit && x.res >= 0)))) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); return true; }
  }
  const unresolved = () => entry.suits.filter((s) => s.res === undefined || s.res === null);
  let guard = 0;
  while (entry.status === 'en attente' && guard++ <= entry.maxR + entry.gap + 8) {
    const num = entry.target + entry.step + entry.gap;
    const g = state.games.get(num);
    const done = !!g && g.finished && g.complete !== false;
    const early = !done && earlyVerify.hit(g, undefined, (gg) => unresolved().some((s) => hasSuit(gg, s.suit)));
    if (!done && !early) {
      if (num + 2 <= maxDone) { // jeu manquant : on décale
        entry.gap += 1; entry.skipped = (entry.skipped || 0) + 1;
        if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); changed = true; break; }
        continue;
      }
      break;
    }
    const newly = unresolved().filter((s) => hasSuit(g, s.suit));
    for (const s of newly) s.res = entry.step;
    if (newly.length) {
      changed = true;
      if (!entry.won) { entry.won = true; if (cfg) cfg.wins = (cfg.wins || 0) + 1; }
    }
    const rest = unresolved();
    if (!rest.length) { // les deux (tous) sont vérifiés
      entry.status = 'gagné'; entry.resolvedAt = Date.now(); changed = true; editMulti(entry); break;
    }
    if (newly.length) editMulti(entry); // un costume vient de sortir : on affiche son résultat, l'autre reste en vérification
    if (!done) break; // validation anticipée : le tour n'est pas fini, les autres ne peuvent pas être déclarés perdus
    // mode « relance » : un costume est sorti directement (✅0️⃣) au jeu N et l'autre n'est TOUJOURS pas sorti au jeu N+1 → relance à N+3.
    // (si l'autre sort à N ou à N+1 : pas de relance ; sans rattrapage (0), on ne peut pas attendre N+1 : on relance au jeu N)
    if (entry.mode === 'relance' && cfg && entry.step === Math.min(1, entry.maxR) && !entry.relaunched && rest.length && entry.suits.some((s) => s.res === 0)) {
      entry.relaunched = true; changed = true;
      try { sendRelaunch(cfg, entry, rest); } catch (e) { panel.lastError = e.message; }
    }
    if (entry.step >= entry.maxR) { // rattrapages épuisés : ceux qui ne sont pas sortis sont perdus
      for (const s of rest) s.res = -1;
      entry.status = entry.won ? 'gagné' : 'perdu'; entry.resolvedAt = Date.now(); changed = true;
      if (!entry.won && cfg) cfg.losses = (cfg.losses || 0) + 1;
      editMulti(entry);
      break;
    }
    entry.step += 1; changed = true;
  }
  return changed;
}
// Mode « relance » : le MÊME message est édité : on y ajoute seulement le numéro de la relance (├ N°1138) ; le costume qui n'est pas
// encore sorti reste ⏳ et il est vérifié au jeu N+3 par une entrée « relance » (sans nouveau message).
function sendRelaunch(cfg, parent, remaining) {
  const depth = (Number(parent.depth) || 0) + 1;
  if (depth > RELAUNCH_MAX_DEPTH || !remaining.length) return false;
  const target = Number(parent.target) + RELAUNCH_OFFSET;
  if (target <= maxFinishedGameNumber()) return false; // jeu déjà joué : trop tard
  if (alreadySent(cfg.id, target)) { blocked(); return false; } // doublon de prédiction
  const items = remaining.map((s) => {
    const it = { suit: s.suit, pct: s.pct, ref: s.ref, rank: s.rank };
    try { const p = pctProviders[cfg.strategy] && s.ref ? pctProviders[cfg.strategy](s.ref) : null; if (Number.isFinite(p)) it.pct = p; } catch (_) { /* dernier connu */ }
    return it;
  });
  const now = Date.now();
  const entry = {
    id: `bwr-${now}-${Math.random().toString(36).slice(2, 6)}`, configId: cfg.id, mode: 'relance', strategy: cfg.strategy, target,
    suits: items, maxR: cfg.maxR, step: 0, gap: 0, skipped: 0, status: 'en attente', messages: [], createdAt: now, resolvedAt: null,
    relaunch: true, depth, parentId: parent.id, // messages : vide, le message d'origine est modifié
  };
  panel.pending.push(entry); rememberSent(cfg.id, target);
  cfg.sentCount = (cfg.sentCount || 0) + 1; cfg.lastSentAt = now;
  panel.lastError = null;
  editMulti(entry); // ajoute « ├ N°{target} » dans le message d'origine
  persist();
  return true;
}
function verifyPending() {
  const maxDone = maxFinishedGameNumber();
  let changed = false;
  for (const entry of panel.pending) {
    if (entry.status !== 'en attente') continue;
    if (entry.mode === 'multi' || entry.mode === 'relance') { if (verifyMulti(entry, panel.configs.find((c) => c.id === entry.configId), maxDone)) changed = true; continue; }
    const isTrigger = entry.mode !== 'multi' && entry.mode !== 'relance'; // message simple au format choisi (déclencheur, cycle, suivi, test, détection auto)
    let guard = 0;
    while (entry.status === 'en attente' && guard++ <= entry.maxR + entry.gap + 8) {
      const num = entry.target + entry.step + entry.gap;
      const g = state.games.get(num);
      const anySuit = (gg) => entry.suits.some((s) => hasSuit(gg, s.suit));
      const usable = (!!g && g.finished && g.complete !== false) || earlyVerify.hit(g, undefined, anySuit);
      if (!usable) {
        if (num + 2 <= maxDone) {
          entry.gap += 1; entry.skipped = (entry.skipped || 0) + 1;
          if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); changed = true; break; }
          continue;
        }
        break;
      }
      const hit = entry.suits.filter((s) => hasSuit(g, s.suit)).map((s) => s.suit);
      const cfg = panel.configs.find((c) => c.id === entry.configId);
      if (hit.length) {
        entry.status = 'gagné'; entry.resolvedAt = Date.now(); changed = true;
        if (cfg) cfg.wins = (cfg.wins || 0) + 1;
        if (isTrigger) editTrigger(entry, 'gagné');
        if (entry.mode === 'follow') advanceFollow(cfg, entry);
        if (entry.mode === 'cycle' && cfg) advanceCycle(cfg, entry);
        else if (entry.mode === 'test') { if (cfg) advanceTest(cfg, entry); } // le format choisi est déjà mis à jour par editTrigger
        break;
      }
      if (entry.step >= entry.maxR) {
        entry.status = 'perdu'; entry.resolvedAt = Date.now(); changed = true;
        if (cfg) cfg.losses = (cfg.losses || 0) + 1;
        if (isTrigger) editTrigger(entry, 'perdu');
        if (entry.mode === 'follow') advanceFollow(cfg, entry);
        if (entry.mode === 'cycle' && cfg) advanceCycle(cfg, entry);
        else if (entry.mode === 'test') { if (cfg) advanceTest(cfg, entry); }
        break;
      }
      entry.step += 1; changed = true;
      if (isTrigger) editTrigger(entry, 'en attente'); // le message affiche le rattrapage en cours
    }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pending = panel.pending.filter((e) => e.status === 'en attente' || !e.resolvedAt || e.resolvedAt >= cutoff);
  if (changed) persist();
}
async function tick() {
  verifyPending();
  try { await checkAbsence(); } catch (e) { panel.lastError = e.message; }
  try { await checkPatterns(); } catch (e) { panel.lastError = e.message; }
}
setOnShoeReset(() => {
  collector.clear();
  panel.watch = panel.watch.filter((w) => w.kind !== 'scan'); // la numérotation repart de zéro
  panel.trig.armed = {}; panel.trig.absenceFired = {}; // nouveau sabot : la numérotation repart de zéro
  for (const e of panel.pending) if (e.status === 'en attente') { e.status = 'annulé'; e.resolvedAt = Date.now(); }
  persist();
});

async function test(id) {
  const cfg = panel.configs.find((c) => c.id === id);
  if (!cfg) return { ok: false, error: 'Configuration introuvable' };
  let msgs;
  if (simpleMode(cfg)) {
    const o = triggerMessage({ format: cfg.format, target: 464, suits: [{ suit: '♦️' }], strategyName: cfg.name || (modeOf(cfg) === 'test' ? 'Test meilleur / 2ᵉ' : 'Déclencheur'), maxR: cfg.maxR, step: 0 }, 'en attente');
    msgs = await sendToChannels(cfg, `🧪 Test\n${o.text}`, o.parse_mode);
  } else {
    const sample = (cfg.ranks || DEFAULT_RANKS).map((r, i) => ({ suit: SUITS[i], pct: [85, 80, 78, 70][i] }));
    msgs = await sendToChannels(cfg, `🧪 Test\n${predictionText(464, sample)}`, 'HTML');
    if (modeOf(cfg) === 'relance' && sample.length >= 2) { // aperçu de la relance : le 1ᵉʳ est sorti, le reste est relancé à +3
      sample[0].res = 0;
      await sendToChannels(cfg, `🧪 Test (après ✅0️⃣ à N, l'autre pas sorti à N+1 : le même message reçoit le N° de la relance à +${RELAUNCH_OFFSET})\n${predictionText(464, sample, true, true, [`${464 + RELAUNCH_OFFSET}⏳`])}`, 'HTML');
    }
  }
  return msgs.length ? { ok: true, sent: msgs.length } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

function status() {
  return {
    strategies: STRATEGIES, rankLabels: RANK_LABELS, triggerLabel: TRIGGER_LABEL, cycleLabel: `Cycle : ${CYCLE_ORDER.map((r) => RANK_LABELS[r]).join(' → ')}`, formatCount: fmt.FORMAT_COUNT,
    configs: panel.configs.map((c) => ({
      ...c, mode: modeOf(c), strategyLabel: modeOf(c) === 'follow' ? 'Suivi des canaux cochés' : (modeOf(c) === 'scan' ? 'Détection auto des canaux' : STRATEGIES[c.strategy]), sourceNames: (c.sources || []).map((id) => panel.channelTitles[String(id)] || String(id)),
      ranksLabel: modeOf(c) === 'follow' ? `Suit : ${(c.sources || []).map((id) => panel.channelTitles[String(id)] || String(id)).join(', ')}` : modeOf(c) === 'scan' ? `Surveille : ${(c.sources || []).map((id) => panel.channelTitles[String(id)] || String(id)).join(', ')} · un costume ✅0️⃣ → l'autre à N+2` : modeOf(c) === 'trigger' ? TRIGGER_LABEL : (modeOf(c) === 'cycle' ? `Cycle : ${CYCLE_ORDER.map((r) => RANK_LABELS[r]).join(' → ')}` : (modeOf(c) === 'relance' ? `Costumes : ${(c.ranks && c.ranks.length ? c.ranks : RELAUNCH_DEFAULT_RANKS).map((r) => RANK_LABELS[r]).join(' + ')} · un costume ✅0️⃣ → ce qui n'est pas sorti est relancé à N+${RELAUNCH_OFFSET}` : modeOf(c) === 'test' ? `Rangs : ${(c.ranks && c.ranks.length ? c.ranks : TEST_DEFAULT_RANKS).map((r) => RANK_LABELS[r]).join(' → ')} · rang suivant après une perte` : (c.ranks || DEFAULT_RANKS).map((r) => RANK_LABELS[r]).join(' + '))),
      testLabel: modeOf(c) === 'test' ? (c.lossGate ? (c.gateFrom ? `Perte du « ${RANK_LABELS[c.gateFrom]} » → prochaine source : ${RANK_LABELS[(c.ranks || TEST_DEFAULT_RANKS)[((c.ranks || TEST_DEFAULT_RANKS).indexOf(c.gateFrom) + 1) % (c.ranks || TEST_DEFAULT_RANKS).length]]}` : 'Envoi après une perte : en attente d’une perte parmi les rangs choisis') : `Prochaine source : ${RANK_LABELS[c.testRank] || RANK_LABELS[1]}`) : null,
      cycleLabel: modeOf(c) === 'cycle' ? (c.cycleWaiting ? 'Les 4 sont passées : en attente d’une perte parmi les 4' : `Suit actuellement : ${RANK_LABELS[c.cycleRole] || RANK_LABELS[1]}${(c.cycleDone || []).length ? ` (déjà passés : ${c.cycleDone.map((r) => RANK_LABELS[r]).join(', ')})` : ''}`) : null,
      channelNames: c.channels.map((id) => panel.channelTitles[String(id)] || String(id)),
    })),
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastError: panel.lastError, channelTitles: panel.channelTitles,
    detected: detectedList(),
    duplicatesRemoved: panel.duplicatesRemoved, duplicatesBlocked: panel.duplicatesBlocked,
    waiting: panel.pending.filter((e) => e.status === 'en attente').length,
  };
}

function config() { return { count: panel.configs.length }; }
function configure() { persist(); } // import d'une sauvegarde : réécrit l'état en base

module.exports = {
  panel, config, configure, setSender, setPctProvider, setRankProvider, setTestRankProvider, restore, restoreFromDb, persist, addConfig, updateConfig, removeConfig, setChannelTitle,
  hasEnabled, hasMultiChannels, record, recordResult, tick, test, status, parseChannels, STRATEGIES, findDuplicate, dedupeConfigs,
  onChannelPost, parseDuo, detectedList, predictionText,
};
