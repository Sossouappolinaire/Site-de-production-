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
//   Règle : dès qu'un costume est sorti (peu importe le rattrapage : ✅0️⃣, ✅1️⃣, ✅2️⃣…) et que l'autre n'est toujours pas sorti au jeu
//   suivant (N+r+1), le MÊME message est édité : on y ajoute seulement le numéro de la relance : (N+r+1)+2 = N+r+3 (N+3 si direct), le
//   costume pas venu reste ⏳ :
//
//       ♣️✅0️⃣ 95%
//        ┣━ N°1135
//        ┣━ N°1138⏳
//       ♦️⏳ 94%
//
//   Pas de relance si les deux costumes sortent avant, si aucun ne sort (perdu), ou si le jeu visé est déjà joué. La relance annoncée reste,
//   même si l'autre costume sort ensuite à N+2 / N+3. Avec 3 costumes, il en reste 2 dans la relance ; même règle pour la suite
//   (3 relances au maximum). Rattrapages épuisés avant le jeu suivant (ex. 0 rattrapage) : la relance part tout de suite.
//   v35 — NOUVELLE RÈGLE : on attend que le costume pas venu ne sorte pas jusqu'à N+2 (réglable), puis il est relancé à N+7 (réglable).
//   « Analyse auto du +n » : à chaque relance décidée, on regarde pour +3 … +n si le costume pas venu est sorti ; le +k le plus réussi
//   (après 8 situations minimum) est appliqué tout seul. Analyse auto cochée : le N+7 fixe n'est plus utilisé, aucune relance n'est envoyée
//   tant que l'analyse n'a pas rendu son verdict (on observe seulement). Option « relance vers un autre canal » : un message simple par costume relancé,
//   avec son propre format de prédiction et son propre nombre de rattrapages (gagnés / perdus comptés à part).
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
const strategyRecap = require('./strategy-recap');

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

const MODES = ['trigger', 'cycle', 'follow', 'test', 'scan', 'relance', 'lossnext']; // + « multi » (par défaut)
const RELAUNCH_WAIT = 1;      // mode relance : nombre de jeux attendus APRÈS la sortie du 1er costume (v43) : le costume pas sorti ne doit pas venir …
const RELAUNCH_OFFSET = 3;    // … alors il est relancé à (jeu du 1er costume sorti) + 3 par défaut (réglable ; ou choisi par l'analyse auto)
const RELAUNCH_MIN_OFFSET = 3; // analyse auto : on teste les relances de +3 jusqu'à +n
const RELAUNCH_N_MAX = 12;    // +n par défaut de l'analyse auto
const RELAUNCH_MIN_SAMPLE = 8; // nombre minimum de situations observées avant d'appliquer le +n trouvé par l'analyse
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
let adminIdFn = null; // chat privé de l'administrateur (verdict de l'analyse du +n)
function setAdminId(fn) { adminIdFn = typeof fn === 'function' ? fn : null; }

// fournisseurs de pourcentage « en direct » (un par stratégie, enregistrés par les stratégies elles-mêmes)
const pctProviders = {};
function setPctProvider(strategy, fn) { if (typeof fn === 'function') pctProviders[strategy] = fn; }

// fournisseurs de rang (1 meilleur · 2 · 3 · 4 plus faible) d'une configuration, par stratégie
const rankProviders = {};
function setRankProvider(strategy, fn) { if (typeof fn === 'function') rankProviders[strategy] = fn; }
// rang du mode Test (position dans le classement du jour) : même règle que celle qui choisit la prédiction à envoyer
const testRankProviders = {};
function setTestRankProvider(strategy, fn) { if (typeof fn === 'function') testRankProviders[strategy] = fn; }

// ─── Mode « Perte → Xᵉ prédiction » (bouton « Perte → 3ᵉ ») ─────────────────────────────────────────────────────
// SOURCES suivies (une ou plusieurs, au choix à la création) :
//   • 'rank'     : 2 à 4 des 4 meilleurs d'une stratégie (Dizaine ou Costume faible) — clés `rank:1` … `rank:4`
//   • 'strategy' : stratégies existantes du bot / IA / stratégies enregistrées — clé = clé de la stratégie
//   • 'channel'  : canaux Telegram — clé `channel:<id>`
// RÈGLE : dès qu'une source a perdu N fois de suite (N = « pertes avant l'envoi », 1 par défaut ; un gain remet son compte à zéro),
// on la suit : on laisse passer (X-1) de ses prédictions puis la Xᵉ est envoyée dans le canal (X = 3 par défaut : 2 laissées passer).
// Ensuite on n'envoie plus rien tant qu'UNE AUTRE source n'a pas atteint ses N pertes. Une seule prédiction envoyée à la fois.
function loadLossNext(c) {
  c = c || {};
  const kind = c.lnKind === 'strategy' || c.lnKind === 'channel' ? c.lnKind : 'rank';
  const phase = c.lnPhase === 'count' ? 'count' : 'idle';
  const key = (v) => { const t = String(v == null ? '' : v).trim(); return /^\d$/.test(t) ? `rank:${t}` : t; };
  const nth = c.lnNth !== undefined && c.lnNth !== null ? sanitizeLnNth(c.lnNth) : sanitizeLnSkip(c.lnSkip) + 1;
  return {
    lnKind: kind,
    lnSources: kind === 'rank' ? [] : [...new Set((Array.isArray(c.lnSources) ? c.lnSources : String(c.lnSources || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean))],
    lnNth: nth,                                                       // prédiction envoyée après la perte : 1 = la prochaine, 3 = la 3ᵉ…
    lnSkip: nth - 1,                                                  // = prédictions laissées passer
    lnLosses: sanitizeLnLosses(c.lnLosses),                           // pertes de suite avant de déclencher
    lnStreak: c.lnStreak && typeof c.lnStreak === 'object' ? c.lnStreak : {},
    lnPhase: phase,                                                   // idle : on attend · count : on suit une source
    lnFollow: phase === 'count' && c.lnFollow != null ? key(c.lnFollow) : null,
    lnLeft: phase === 'count' ? Math.max(0, Number(c.lnLeft) || 0) : 0, // prédictions encore à laisser passer
    lnLast: c.lnLast != null && c.lnLast !== '' ? key(c.lnLast) : null, // dernière source envoyée (ignorée jusqu'à la perte d'une autre)
    lnCounted: Number.isFinite(Number(c.lnCounted)) ? Number(c.lnCounted) : 0, // dernier jeu cible déjà compté (anti-doublon)
    lnSeen: Array.isArray(c.lnSeen) ? c.lnSeen.slice(-600) : [],      // sources non « rank » : prédictions/résultats déjà lus
    lnBase: c.lnBase && typeof c.lnBase === 'object' ? c.lnBase : {}, // sources non « rank » : historique déjà passé au moment de l'ajout
  };
}
const lnKindOf = (c) => (c && (c.lnKind === 'strategy' || c.lnKind === 'channel') ? c.lnKind : 'rank');
const lossNextBusy = new Set();
const rankKey = (r) => `rank:${r}`;
// résultat (ok = gagné, sinon perdu après tous les rattrapages) d'une source suivie
function lossNextResult(cfg, key, ok) {
  if (cfg.lnPhase === 'count') return; // un suivi est déjà en cours : on n'en ouvre pas un second
  if (cfg.lnLast === key && !ok) return; // « attend qu'un AUTRE ait une perte »
  const st = cfg.lnStreak || (cfg.lnStreak = {});
  if (ok) { if (st[key]) { st[key] = 0; persist(); } return; }
  st[key] = (Number(st[key]) || 0) + 1;
  if (st[key] >= sanitizeLnLosses(cfg.lnLosses)) {
    cfg.lnPhase = 'count'; cfg.lnFollow = key; cfg.lnLeft = sanitizeLnNth(cfg.lnNth) - 1; cfg.lnCounted = 0; cfg.lnStreak = {};
  }
  persist();
}
// nouvelle prédiction d'une source : si c'est la source suivie, on la laisse passer (X-1 fois) puis on envoie la suivante
async function lossNextPrediction(cfg, key, target, suit) {
  if (cfg.lnPhase !== 'count' || key !== cfg.lnFollow) return;
  target = Number(target);
  if (!Number.isFinite(target) || !suit) return;
  if (cyclePending(cfg) || lossNextBusy.has(cfg.id)) return;
  if (target <= (Number(cfg.lnCounted) || 0)) return; // même prédiction déjà comptée
  if (cfg.lnLeft > 0) { cfg.lnLeft -= 1; cfg.lnCounted = target; persist(); return; } // prédiction laissée passer
  lossNextBusy.add(cfg.id);
  try {
    const ok = await sendTrigger(cfg, { target, suit, reason: 'lossnext', role: key });
    if (ok) { cfg.lnLast = key; cfg.lnPhase = 'idle'; cfg.lnFollow = null; cfg.lnLeft = 0; cfg.lnCounted = target; persist(); }
  } finally { lossNextBusy.delete(cfg.id); }
}
// sources « rank » : branchées sur les rangs de la stratégie (voir recordResult / record)
const lossNextRankCfgs = (strategy) => enabledOf(strategy, 'lossnext').filter((c) => lnKindOf(c) === 'rank');
function lossNextOnRankResult(strategy, rank, ok) {
  for (const cfg of lossNextRankCfgs(strategy)) if ((cfg.ranks || []).includes(rank)) lossNextResult(cfg, rankKey(rank), ok);
}
async function handleLossNextPrediction(strategy, rank, data) {
  for (const cfg of lossNextRankCfgs(strategy)) if ((cfg.ranks || []).includes(rank)) await lossNextPrediction(cfg, rankKey(rank), data.target, data.suit);
}
// sources « strategy » / « channel » : lecture régulière des prédictions de la source (mêmes données que « Copie et annonce »)
async function lossNextPoll() {
  const cfgs = panel.configs.filter((c) => c.enabled && modeOf(c) === 'lossnext' && lnKindOf(c) !== 'rank');
  if (!cfgs.length) return;
  let ca; try { ca = require('./copy-announce'); } catch (_) { return; }
  const maxDone = maxFinishedGameNumber();
  for (const cfg of cfgs) {
    const seen = new Set(cfg.lnSeen || []);
    let touched = false;
    for (const key of cfg.lnSources || []) {
      const entries = ca.sourceEntries(lnKindOf(cfg) === 'channel' && !String(key).startsWith('channel:') ? `channel:${key}` : key)
        .filter((e) => e.suit && e.uid).sort((a, b) => a.target - b.target);
      if (!cfg.lnBase[key]) { // première lecture : l'historique déjà joué n'est jamais rejoué
        for (const e of entries) { seen.add(`p:${e.uid}`); if (e.status === 'gagné' || e.status === 'perdu') seen.add(`r:${e.uid}`); }
        cfg.lnBase[key] = Date.now(); touched = true; continue;
      }
      for (const e of entries) {
        if (e.status === 'gagné' || e.status === 'perdu') {
          if (!seen.has(`r:${e.uid}`)) { seen.add(`r:${e.uid}`); touched = true; lossNextResult(cfg, key, e.status === 'gagné'); }
        }
        if (!seen.has(`p:${e.uid}`)) {
          seen.add(`p:${e.uid}`); touched = true;
          if (e.status === 'en attente' && Number(e.target) > maxDone) await lossNextPrediction(cfg, key, e.target, e.suit);
        }
      }
    }
    if (touched) { cfg.lnSeen = [...seen].slice(-600); persist(); }
  }
}
function lossNextSourceName(cfg, key) {
  if (String(key).startsWith('rank:')) return RANK_LABELS[Number(String(key).slice(5))] || key;
  try {
    const ca = require('./copy-announce');
    if (String(key).startsWith('channel:') || lnKindOf(cfg) === 'channel') { const id = String(key).replace(/^channel:/, ''); return `Canal ${panel.channelTitles[id] || (ca.panel && ca.panel.channelTitles && ca.panel.channelTitles[id]) || id}`; }
    const o = ca.options().find((x) => x.key === key); if (o) return o.name;
  } catch (_) { /* nom brut */ }
  return String(key);
}
function lossNextLabel(c) {
  const n = lossNextSourceName(c, c.lnFollow);
  const need = sanitizeLnLosses(c.lnLosses);
  if (c.lnPhase === 'count') {
    const rest = Number(c.lnLeft) || 0;
    return `Perte${need > 1 ? 's' : ''} de « ${n} » : ${rest > 0 ? `encore ${rest} prédiction(s) à laisser passer, puis envoi` : 'la prochaine prédiction de cette source est envoyée'}`;
  }
  return c.lnLast ? `En attente de ${need} perte${need > 1 ? 's' : ''} d'une AUTRE source que « ${lossNextSourceName(c, c.lnLast)} » (dernier envoi)` : `En attente de ${need} perte${need > 1 ? 's' : ''} de suite d'une source cochée`;
}

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
const hasRanksMode = (m) => m === 'multi' || m === 'test' || m === 'relance' || m === 'lossnext';
const LOSSNEXT_DEFAULT_RANKS = [1, 2, 3, 4]; // mode « Perte → Xᵉ prédiction » : les 4 meilleurs cochés par défaut
const LOSSNEXT_SKIP = 2;                     // prédictions laissées passer après la perte : la 3ᵉ est envoyée
const sanitizeLnSkip = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, Math.min(20, n)) : LOSSNEXT_SKIP; };
const sanitizeLnNth = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(1, Math.min(21, n)) : LOSSNEXT_SKIP + 1; }; // Xᵉ prédiction envoyée (3 par défaut)
const sanitizeLnLosses = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 1; };      // pertes de suite avant l'envoi
const defaultRanks = (m) => (m === 'lossnext' ? LOSSNEXT_DEFAULT_RANKS : m === 'test' ? TEST_DEFAULT_RANKS : m === 'relance' ? RELAUNCH_DEFAULT_RANKS : DEFAULT_RANKS).slice();
const srcMode = (c) => SRC_MODES.includes(modeOf(c));
// ── réglages du mode relance : attente (N+2), numéro de la relance (N+7), analyse auto du +n, envoi vers un autre canal ──
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
function relaunchFields(input, cur) {
  const o = cur || {};
  const g = (k) => (input && input[k] !== undefined ? input[k] : o[k]);
  const relWait = clampInt(g('relWait'), 0, 6, RELAUNCH_WAIT);
  const relOffset = clampInt(g('relOffset'), RELAUNCH_MIN_OFFSET, 40, RELAUNCH_OFFSET);
  const relMaxN = clampInt(g('relMaxN'), RELAUNCH_MIN_OFFSET, 40, RELAUNCH_N_MAX);
  if (relOffset <= relWait) throw new Error(`La relance (N+${relOffset}) doit venir après l'attente (N+${relWait}).`);
  if (relMaxN <= relWait) throw new Error(`Le +n de l'analyse (+${relMaxN}) doit être plus grand que l'attente (N+${relWait}).`);
  return {
    relWait, relOffset, relMaxN, relAuto: !!g('relAuto'),
    relChannels: parseChannels(g('relChannels')), relFormat: sanitizeFormat(g('relFormat')), relMaxR: sanitizeMaxR(g('relMaxR')),
  };
}
function loadRelaunch(c) { // configuration enregistrée : valeurs par défaut si un réglage manque ou est invalide
  let f; try { f = relaunchFields(c, null); } catch (_) { f = relaunchFields({}, null); }
  const stats = {};
  if (c.relStats && typeof c.relStats === 'object') for (const [k, v] of Object.entries(c.relStats)) if (v && Number(v.n) > 0) stats[String(Number(k))] = { n: Number(v.n), hit: Number(v.hit) || 0 };
  return { ...f, relStats: stats, relObs: Array.isArray(c.relObs) ? c.relObs.slice(-80) : [], relOffsetAuto: Number(c.relOffsetAuto) >= RELAUNCH_MIN_OFFSET ? Number(c.relOffsetAuto) : null,
    relOutWins: Number(c.relOutWins) || 0, relOutLosses: Number(c.relOutLosses) || 0, relOutSent: Number(c.relOutSent) || 0 };
}
// v43 : numéro du jeu où le 1er costume est sorti (base de la relance) ; repli pour les anciennes entrées : jeu visé + rattrapage + décalage
function relaunchBase(e) {
  if (Number.isFinite(Number(e.firstGame))) return Number(e.firstGame);
  const hits = (e.suits || []).map((s) => Number(s.resGame)).filter((n) => Number.isFinite(n));
  if (hits.length) return Math.min(...hits);
  return Number(e.target) + (Number(e.firstRes) || 0) + (Number(e.gap) || 0);
}
const relaunchWait = (c) => { const n = Number(c && c.relWait); return Number.isFinite(n) ? n : RELAUNCH_WAIT; };
// numéro de la relance : +n trouvé par l'analyse auto (si activée et assez de situations observées), sinon le réglage fixe
// analyse auto cochée mais pas encore de verdict : aucune relance n'est envoyée (on observe seulement), le N+7 fixe n'est PAS utilisé
const relaunchAwaitingVerdict = (c) => !!(c && c.relAuto && !(Number(c.relOffsetAuto) >= RELAUNCH_MIN_OFFSET));
function relaunchOffset(c) {
  if (c && c.relAuto && Number(c.relOffsetAuto) >= RELAUNCH_MIN_OFFSET) return Number(c.relOffsetAuto);
  return c && Number(c.relOffset) >= RELAUNCH_MIN_OFFSET ? Number(c.relOffset) : RELAUNCH_OFFSET;
}
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
    const o = {
      id: String(c.id), mode, name: sanitizeName(c.name), strategy: src ? mode : (sanitizeStrategy(c.strategy) || 'dizaine'), channels: parseChannels(c.channels),
      sources: src ? parseChannels(c.sources).map(String) : [], rot: c.rot && typeof c.rot === 'object' ? c.rot : {},
      maxR: sanitizeMaxR(c.maxR), format: sanitizeFormat(c.format),
      cycleRole: CYCLE_ORDER.includes(Number(c.cycleRole)) ? Number(c.cycleRole) : 1, cycleWaiting: !!c.cycleWaiting,
      cycleDone: Array.isArray(c.cycleDone) ? c.cycleDone.map(Number).filter((r) => CYCLE_ORDER.includes(r)) : [],
      ranks: !hasRanksMode(mode) ? [] : (() => { try { return sanitizeRanks(c.ranks, mode); } catch (_) { return defaultRanks(mode); } })(),
      enabled: c.enabled !== false, sentCount: Number(c.sentCount) || 0, wins: Number(c.wins) || 0, losses: Number(c.losses) || 0, lastSentAt: c.lastSentAt || null,
      lossGate: mode === 'test' && !!c.lossGate, gateFrom: [1, 2, 3, 4].includes(Number(c.gateFrom)) ? Number(c.gateFrom) : null,
    };
    if (mode === 'lossnext') Object.assign(o, loadLossNext(c));
    if (mode === 'relance') Object.assign(o, loadRelaunch(c));
    return o;
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
const configKey = (c) => `${modeOf(c)}|${c.strategy}|${modeOf(c) === 'lossnext' && lnKindOf(c) !== 'rank' ? `${lnKindOf(c)}:${[...(c.lnSources || [])].map(String).sort().join(',')}` : ''}|${hasRanksMode(modeOf(c)) ? (c.ranks || []).join('') : (srcMode(c) ? [...(c.sources || [])].map(String).sort().join(',') : '')}${modeOf(c) === 'test' && c.lossGate ? '|gate' : ''}`;
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
  const lnFree = mode === 'lossnext' && (input.lnKind === 'strategy' || input.lnKind === 'channel'); // sources : stratégies existantes / canaux (pas de classement)
  const strategy = src ? mode : (lnFree ? 'dizaine' : sanitizeStrategy(input.strategy));
  if (!strategy) throw new Error('Choisis la stratégie (Dizaine ou Costume faible).');
  const sources = src ? parseChannels(input.sources).map(String) : [];
  if (src && !sources.length) throw new Error(mode === 'scan' ? 'Sélectionne au moins un canal détecté.' : 'Coche au moins un canal à suivre.');
  const channels = parseChannels(input.channels);
  if (!channels.length) throw new Error('Renseigne au moins un ID de canal.');
  const cfg = {
    id: `bw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, mode, name: sanitizeName(input.name) || ({ trigger: 'Déclencheur', cycle: 'Cycle', follow: 'Suivi', test: 'Test', scan: 'Détection auto', relance: 'Relance', lossnext: 'Perte → prédiction suivante' }[mode] || ''),
    strategy, channels, sources, rot: {}, maxR: sanitizeMaxR(input.maxR), format: sanitizeFormat(input.format),
    ranks: !hasRanksMode(mode) || lnFree ? [] : (input.ranks === undefined ? defaultRanks(mode) : sanitizeRanks(input.ranks, mode)),
    cycleRole: 1, cycleWaiting: false, cycleDone: [],
    enabled: true, sentCount: 0, wins: 0, losses: 0, lastSentAt: null,
    lossGate: mode === 'test' && !!input.lossGate, gateFrom: null,
  };
  if (mode === 'lossnext') {
    Object.assign(cfg, loadLossNext({ lnKind: input.lnKind, lnSources: input.lnSources, lnNth: input.lnNth, lnSkip: input.lnSkip, lnLosses: input.lnLosses }));
    if (lnFree) {
      if (!cfg.lnSources.length) throw new Error(cfg.lnKind === 'channel' ? 'Coche au moins un canal à suivre.' : 'Coche au moins une stratégie à suivre.');
      if (cfg.lnKind === 'strategy') { const known = new Set(require('./copy-announce').options().map((o) => o.key)); const bad = cfg.lnSources.find((k) => !known.has(k)); if (bad) throw new Error(`Stratégie inconnue : ${bad}`); }
      if (cfg.lnKind === 'channel') { cfg.lnSources = cfg.lnSources.map((k) => String(k).replace(/^channel:/, '')); if (cfg.lnSources.some((id) => channels.some((d) => String(d).toLowerCase() === String(id).toLowerCase()))) throw new Error("Le canal d'envoi ne peut pas être l'un des canaux suivis (boucle infinie)."); }
    }
  }
  if (mode === 'relance') Object.assign(cfg, relaunchFields(input), { relStats: {}, relObs: [], relOffsetAuto: null, relOutWins: 0, relOutLosses: 0, relOutSent: 0 });
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
    if (patch.strategy !== undefined && !srcMode(c) && !(modeOf(c) === 'lossnext' && lnKindOf(c) !== 'rank')) { const s = sanitizeStrategy(patch.strategy); if (!s) throw new Error('Stratégie invalide.'); c.strategy = s; }
    if (patch.channels !== undefined) { const ch = parseChannels(patch.channels); if (!ch.length) throw new Error('Renseigne au moins un ID de canal.'); c.channels = ch; }
    if (patch.maxR !== undefined) c.maxR = sanitizeMaxR(patch.maxR);
    if (patch.name !== undefined) c.name = sanitizeName(patch.name) || c.name;
    if (patch.format !== undefined) c.format = sanitizeFormat(patch.format);
    if (patch.ranks !== undefined && hasRanksMode(modeOf(c)) && !(modeOf(c) === 'lossnext' && lnKindOf(c) !== 'rank')) {
      c.ranks = sanitizeRanks(patch.ranks, modeOf(c));
      if (modeOf(c) === 'test' && !c.ranks.includes(Number(c.testRank))) c.testRank = c.ranks[0];
    }
    if (modeOf(c) === 'lossnext') {
      let reset = false;
      if (patch.lnNth !== undefined) { c.lnNth = sanitizeLnNth(patch.lnNth); c.lnSkip = c.lnNth - 1; reset = true; }
      else if (patch.lnSkip !== undefined) { c.lnSkip = sanitizeLnSkip(patch.lnSkip); c.lnNth = c.lnSkip + 1; reset = true; }
      if (patch.lnLosses !== undefined) { c.lnLosses = sanitizeLnLosses(patch.lnLosses); reset = true; }
      if (patch.lnSources !== undefined && lnKindOf(c) !== 'rank') {
        const list = [...new Set((Array.isArray(patch.lnSources) ? patch.lnSources : String(patch.lnSources).split(/[\s,;]+/)).map((x) => String(x).trim().replace(/^channel:/, lnKindOf(c) === 'channel' ? '' : 'channel:')).filter(Boolean))];
        if (!list.length) throw new Error(lnKindOf(c) === 'channel' ? 'Coche au moins un canal à suivre.' : 'Coche au moins une stratégie à suivre.');
        c.lnSources = list; c.lnBase = {}; reset = true;
      }
      if (reset) { c.lnPhase = 'idle'; c.lnFollow = null; c.lnLeft = 0; c.lnStreak = {}; c.lnCounted = 0; }
    }
    if (patch.lossGate !== undefined && modeOf(c) === 'test') { c.lossGate = !!patch.lossGate; c.gateFrom = null; }
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
    if (modeOf(c) === 'relance') {
      if (['relWait', 'relOffset', 'relMaxN', 'relAuto', 'relChannels', 'relFormat', 'relMaxR'].some((k) => patch[k] !== undefined)) Object.assign(c, relaunchFields(patch, c));
      if (patch.relResetStats) { c.relStats = {}; c.relObs = []; c.relOffsetAuto = null; }
    }
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
  // v41 : les relances (et leurs envois vers un autre canal) ne comptent pas ici : elles ont leur propre clé (voir relaunchAlreadySent),
  // sinon une relance à N+3 bloquait la prédiction normale du jeu N+3 (et l'inverse).
  return inflight.has(k) || panel.recentSent.includes(k) || panel.pending.some((e) => e.configId === cfgId && !e.relaunch && !e.relayOut && Number(e.target) === Number(target));
}
const relaunchKey = (cfgId, target) => `${cfgId}:rel:${Number(target)}`;
function relaunchAlreadySent(cfgId, target) {
  return panel.recentSent.includes(relaunchKey(cfgId, target)) || panel.pending.some((e) => e.configId === cfgId && e.relaunch && Number(e.target) === Number(target));
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
  return rows.join('\n'); // texte normal (pas de bloc <pre> / code) : envoyé en HTML sans balise
}
// Mode « relance » : message avec relance(s). Chaque numéro de jeu est placé À CÔTÉ du costume auquel il se rapporte :
//   - le N° du message d'origine (✅ dès qu'un costume est sorti) se place contre le costume sorti à l'origine ;
//   - le N° de la relance (⏳ → ✅ / ❌) se place contre le costume relancé.
//       ♦️⏳ 95%                     ♦️✅0️⃣ 95%
//        ┣━ N°1084⏳                  ┣━ N°1081✅
//        ┣━ N°1081✅                  ┣━ N°1084⏳
//       ♣️✅0️⃣ 94%                   ♣️⏳ 94%
// items : costumes (ordre meilleur → plus faible) avec leur résultat ; owners[i] : index (dans la chaîne) de la ligne N° du costume i ;
// lines : une ligne ` ┣━ N°…` par entrée de la chaîne (origine d'abord, puis chaque relance).
// v44 : nouvelle mise en forme (sans pourcentage) :
//       ♣️✅0️⃣N°: 1158              ♣️✅0️⃣N°: 1158
//        ┣━ N°1158✅                  ┣━ N°1158✅
//        ┣━♦️ N°1161⏳               ┣━ N°1161✅     (relance jouée : le costume n'est plus rappelé sur la ligne)
//       ♦️⏳                         ♦️✅0️⃣N°: 1161
// Texte normal en HTML (jamais de <pre> / <code>) : la police de Telegram n'est pas à chasse fixe, l'alignement vient donc d'une structure
// identique sur chaque ligne (symbole · espace · résultat) et non d'espaces de remplissage.
// targets[k] : numéro de jeu de la ligne k de la chaîne ; le N° affiché à côté d'un costume sorti est celui de SA ligne (rattrapage compté depuis lui).
function relaunchText(items, owners, lines, targets) {
  const suitLines = items.map((s, i) => {
    const hit = Number.isFinite(Number(s.res)) && s.res !== null && s.res >= 0;
    const lost = s.res !== undefined && s.res !== null && s.res < 0;
    const n = Array.isArray(targets) ? targets[owners[i]] : undefined;
    if (hit && n !== undefined) return `${s.suit}${suitMark(s, true)}N°: ${n}`; // v47 : sans espace (♣️✅0️⃣N°: 1158)
    if (owners[i] > 0 && n !== undefined && s.cancelled) return `${s.suit}➖N°: ${n}`; // v59 : relance annulée
    if (owners[i] > 0 && n !== undefined) return lost ? `${s.suit}❌N°: ${n}` : `${s.suit}N°: ${n}⏳`; // v55 : costume relancé en attente → ♠️N°: 1126⏳
    return `${s.suit}${suitMark(s, true)}`;
  });
  let boundaries = 0;
  for (let i = 1; i < items.length; i++) if (owners[i] !== owners[i - 1]) boundaries++;
  if (!boundaries) { // un seul groupe : toutes les lignes N° après la moitié des costumes (comportement d'avant)
    const cut = Math.ceil(suitLines.length / 2);
    return [...suitLines.slice(0, cut), ...lines, ...suitLines.slice(cut)].join('\n');
  }
  const emitted = new Set();
  const out = [];
  let lastBoundary = -1;
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && owners[i] !== owners[i - 1]) {
      for (const o of [owners[i - 1], owners[i]].sort((a, b) => a - b)) if (!emitted.has(o)) { emitted.add(o); out.push(lines[o]); } // v55 : toujours dans l'ordre de la chaîne (origine d'abord, puis la relance)
      lastBoundary = out.length; // position juste après les lignes N° de cette frontière
    }
    out.push(suitLines[i]);
  }
  const rest = lines.filter((_, k) => !emitted.has(k)); // ligne sans costume propre : accrochée à la dernière frontière
  if (rest.length) out.splice(lastBoundary, 0, ...rest);
  return out.join('\n');
}
// message simple du mode « déclencheur » (même moteur de formats que les autres stratégies)
function triggerMessage(entryLike, statusFr) {
  return fmt.renderMessage(entryLike.format, {
    gameNumber: entryLike.target, suit: entryLike.suits[0].suit, strategy: entryLike.strategyName || 'Déclencheur',
    maxR: entryLike.maxR, status: statusFr, rattrapage: entryLike.step || 0,
  }, null);
}

async function sendToChannels(cfg, text, parseMode, channels) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return []; }
  const out = [];
  const results = await Promise.all((channels || cfg.channels).map((id) => bot.sendMessage(id, text, parseMode ? { parse_mode: parseMode } : {})
    .then((m) => (m && m.skipped ? { ok: false, skipped: true, id } : { ok: true, id, messageId: m.message_id }))
    .catch((e) => ({ ok: false, id, error: e.message }))));
  for (const r of results) { if (r.ok) out.push({ chatId: r.id, messageId: r.messageId }); else if (!r.skipped) panel.lastError = `${r.id} : ${r.error}`; }
  return out;
}
// v59 : une édition qui échoue (limite Telegram, coupure réseau…) n'est plus avalée en silence : le message restait alors figé sur ⏳.
// L'échec est mémorisé (entry.editFail) et retenté au tour suivant (retryFailedEdits) avec le texte À JOUR, jusqu'à 20 fois.
const EDIT_FINAL_ERR = /message to edit not found|message can't be edited|chat not found|bot was kicked|bot is not a member|forbidden|blocked/i;
function editAll(entry, text, parseMode) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  for (const m of entry.messages || []) {
    Promise.resolve()
      .then(() => bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId, ...(parseMode ? { parse_mode: parseMode } : {}) }))
      .then(() => { if (entry.editFail) { entry.editFail = null; entry.editTries = 0; } })
      .catch((e) => {
        const msg = String((e && e.message) || e);
        if (/message is not modified/i.test(msg)) { entry.editFail = null; return; } // déjà à jour
        if (EDIT_FINAL_ERR.test(msg)) { panel.lastError = `Édition impossible (${m.chatId}) : ${msg}`; return; } // définitif : inutile de réessayer
        entry.editTries = (Number(entry.editTries) || 0) + 1;
        if (entry.editTries <= 20) entry.editFail = Date.now();
        panel.lastError = `Édition du message ${m.chatId}/${m.messageId} : ${msg}`;
      });
  }
}
// réédite (texte à jour) les messages dont la dernière édition a échoué
function retryFailedEdits() {
  const now = Date.now();
  for (const e of panel.pending) {
    if (!e.editFail || now - e.editFail < 8000) continue;
    e.editFail = null;
    try {
      if (e.mode === 'multi' || e.mode === 'relance') { if (!e.relaunch) editMulti(e); }
      else if (e.status === 'gagné' || e.status === 'perdu') editTrigger(e, e.status);
    } catch (err) { panel.lastError = err.message; }
  }
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
    // mode « Perte → Xᵉ prédiction » (sources « rang ») : gain ou perte d'un des rangs cochés
    if ((field === 'losses' || field === 'wins') && (testRankProviders[strategy] || rankProviders[strategy]) && lossNextRankCfgs(strategy).length) {
      const rk = Number((testRankProviders[strategy] || rankProviders[strategy])(ref));
      if (rk >= 1 && rk <= 4) lossNextOnRankResult(strategy, rk, field === 'wins');
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
    await handleLossNextPrediction(strategy, validTest ? testRank : rank, data).catch((e) => { panel.lastError = e.message; });
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
        if (entry.mode === 'relance') { try { require('./loss-return').onRelanceSent(cfg, entry); } catch (_) { /* bouton « Retour après perte » : suivi seulement */ } }
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
// Résultat affiché d'un costume + ligne N° à laquelle il se rattache : celui du message d'origine, sinon celui de la relance qui le reprend
// (⏳ tant qu'elle est en cours). Si le costume est sorti au jeu même visé par la relance (ou après), le résultat compte pour la RELANCE :
// relancé à N°1115 et sorti à 1115 → ✅0️⃣ (rattrapage compté depuis le jeu de la relance, pas depuis le jeu d'origine → pas de ✅3️⃣).
function chainResolve(chain, suit) {
  // v55 : tant qu'une relance est annoncée pour ce costume et pas encore jouée, la ligne du costume suit la RELANCE (♠️N°: 1126⏳),
  // même s'il est sorti entre-temps dans les rattrapages du message d'origine. Relance jouée : son résultat (✅ / ❌) ; relance perdue mais
  // costume déjà sorti à l'origine : le ✅ d'origine est conservé.
  let last = -1;
  for (let k = 0; k < chain.length; k++) if (chain[k].suits.some((x) => x.suit === suit)) last = k;
  if (last < 0) return { res: null, owner: 0 };
  const rootS = chain[0].suits.find((x) => x.suit === suit);
  const rootHit = !!rootS && rootS.res !== undefined && rootS.res !== null && rootS.res >= 0;
  if (last === 0) return { res: rootS.res, owner: 0 };
  const e = chain[last]; const s = e.suits.find((x) => x.suit === suit);
  if (s.res !== undefined && s.res !== null && s.res >= 0) return { res: s.res, owner: last }; // relance gagnée
  if (e.status === 'annulé' && (s.res === undefined || s.res === null)) return { res: undefined, owner: last, cancelled: true }; // v59 : relance abandonnée (jeu manquant, nouveau sabot) : plus de ⏳ éternel
  if (e.status === 'en attente' || s.res === undefined || s.res === null) return { res: undefined, owner: last }; // relance en cours
  return rootHit ? { res: rootS.res, owner: 0 } : { res: s.res, owner: last }; // relance perdue
}
function firstHitSuits(e) { // v55 : costume(s) sortis au 1er jeu gagnant du message d'origine (ex. ♣️ N°1119✅)
  const first = Number.isFinite(Number(e.firstGame)) ? Number(e.firstGame) : null;
  return (e.suits || []).filter((x) => x.res !== undefined && x.res !== null && x.res >= 0 && (first === null || Number(x.resGame) === first)).map((x) => x.suit).join('');
}
function editMulti(entry) {
  const chain = relaunchChain(entry);
  const root = chain[0];
  if (chain.length === 1) { editAll(root, predictionText(root.target, root.suits, true, !!root.relaunch), 'HTML'); return; }
  const resolved = root.suits.map((s) => ({ s, ...chainResolve(chain, s.suit) }));
  const items = resolved.map((r) => ({ ...r.s, res: r.res, cancelled: !!r.cancelled }));
  const owners = resolved.map((r) => r.owner); // ligne N° de chaque costume
  const pendingSuits = (e) => e.suits.filter((x) => x.res === undefined || x.res === null).map((x) => x.suit).join('');
  const lines = chain.map((e, k) => (k === 0
    ? ` ┣━${firstHitSuits(e)} N°${e.target}✅` // jeu d'origine : le costume sorti (c'est ce qui a déclenché la relance) est rappelé devant le N°
    : e.status === 'gagné' ? ` ┣━ N°${e.target}✅`
      : e.status === 'perdu' ? ` ┣━ N°${e.target}❌`
        : e.status === 'annulé' ? ` ┣━ N°${e.target}➖`
          : ` ┣━${pendingSuits(e)} N°${e.target}⏳`)); // relance en cours : le costume relancé est rappelé devant son N°
  editAll(root, relaunchText(items, owners, lines, chain.map((e) => e.target)), 'HTML');
}
function verifyMulti(entry, cfg, maxDone) {
  let changed = false;
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
        if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); changed = true; try { editMulti(entry); } catch (_) {} break; }
        continue;
      }
      break;
    }
    const newly = unresolved().filter((s) => hasSuit(g, s.suit));
    for (const s of newly) { s.res = entry.step; s.resGame = num; } // resGame : numéro du jeu où le costume est sorti
    if (newly.length) {
      changed = true;
      if (entry.firstRes === undefined || entry.firstRes === null) { entry.firstRes = entry.step; entry.firstGame = num; } // rattrapage ET numéro du jeu où le 1er costume est sorti (mode relance)
      if (!entry.won) { entry.won = true; if (cfg) cfg.wins = (cfg.wins || 0) + 1; }
    }
    const rest = unresolved();
    if (!rest.length) { // les deux (tous) sont vérifiés
      entry.status = 'gagné'; entry.resolvedAt = Date.now(); strategyRecap.noteEntry(entry); changed = true; editMulti(entry); break;
    }
    if (newly.length) editMulti(entry); // un costume vient de sortir : on affiche son résultat, l'autre reste en vérification
    if (!done) break; // validation anticipée : le tour n'est pas fini, les autres ne peuvent pas être déclarés perdus
    // mode « relance » (v43) : un costume est sorti (✅0️⃣, ✅1️⃣, ✅2️⃣…) : on attend le(s) jeu(x) suivant(s) (réglage, 1 par défaut) pour voir si l'autre sort.
    // S'il n'est toujours pas sorti, il est relancé à (numéro du jeu où le 1er est sorti) + n (réglable, ou +n choisi par l'analyse auto).
    // Les deux sortis, ou aucun : pas de relance. Si les rattrapages sont épuisés avant la fin de l'attente (ex. 0 rattrapage), la relance part tout de suite.
    if (entry.mode === 'relance' && cfg && !entry.relaunched && rest.length && entry.firstRes !== undefined && entry.firstRes !== null
      && entry.step >= Math.min(Number(entry.firstRes) + relaunchWait(cfg), entry.maxR)) { // v43 : attente comptée APRÈS la sortie du 1er costume (✅0️⃣ ou ✅1️⃣ ou ✅2️⃣ : on regarde le jeu suivant)
      // v41 : « relancé » n'est posé que si la relance est vraiment partie (avant : posé d'office, une relance refusée était perdue pour de bon)
      if (!entry.relObserved) { entry.relObserved = true; changed = true; try { observeRelaunch(cfg, entry, rest); } catch (e) { panel.lastError = e.message; } } // alimente l'analyse du +n (une seule fois)
      let sentOk = false;
      try { sentOk = sendRelaunch(cfg, entry, rest); } catch (e) { panel.lastError = e.message; }
      if (sentOk) { entry.relaunched = true; changed = true; }
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
  if (relaunchAwaitingVerdict(cfg)) return false; // analyse auto : on attend son verdict avant de relancer
  const depth = (Number(parent.depth) || 0) + 1;
  if (depth > RELAUNCH_MAX_DEPTH || !remaining.length) return false;
  const target = relaunchBase(parent) + relaunchOffset(cfg); // (jeu où le 1er costume est sorti) + n (ou le +n de l'analyse auto)
  if (target <= maxFinishedGameNumber()) { panel.lastError = `Relance N°${target} non envoyée : jeu déjà joué.`; return false; } // jeu déjà joué : trop tard
  if (relaunchAlreadySent(cfg.id, target)) return false; // cette relance existe déjà (pas une erreur)
  // v55 : UNE SEULE relance à la fois par costume : si une relance de ce costume est déjà en cours pour cette configuration
  // (autre message d'origine), on n'en lance pas une deuxième (plus de prédictions en double) ; le message d'origine reste tel quel.
  if (remaining.some((r) => panel.pending.some((e) => e.configId === cfg.id && e.relaunch && e.status === 'en attente' && e.suits.some((x) => x.suit === r.suit)))) {
    panel.relaunchSkipped = (panel.relaunchSkipped || 0) + 1; parent.relaunchSkipped = true;
    return true; // traité (ignoré volontairement) : pas de nouvel essai à chaque tour
  }
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
  panel.pending.push(entry); panel.recentSent.push(relaunchKey(cfg.id, target));
  try { require('./loss-return').onRelaunchSent(cfg, parent, entry); } catch (_) { /* bouton « Retour après perte » : suivi seulement */ }
  try { require('./loss-relaunch').onRelaunchSent(cfg, parent, entry); } catch (_) { /* bouton « Relance après perte » : suivi seulement */ }
  if (panel.recentSent.length > 500) panel.recentSent = panel.recentSent.slice(-500);
  cfg.sentCount = (cfg.sentCount || 0) + 1; cfg.lastSentAt = now;
  panel.lastError = null;
  editMulti(entry); // ajoute « ├ N°{target} » dans le message d'origine
  flashRelaunch(cfg, target, items).catch((e) => { panel.lastError = e.message; }); // fenêtre « Prédit … » qui disparaît après 10 s
  if (cfg.relChannels && cfg.relChannels.length) {
    entry.relayTodo = []; // rempli si l'envoi vers le 2ᵉ canal échoue : retenté par retryRelayOut
    sendRelayOut(cfg, items, target).then((failed) => { if (failed && failed.length) { entry.relayTodo = failed; entry.relayTries = 1; entry.relayTryAt = Date.now(); persist(); } }).catch((e) => { panel.lastError = e.message; entry.relayTodo = items.map((x) => ({ suit: x.suit })); entry.relayTries = 1; entry.relayTryAt = Date.now(); });
  }
  persist();
  return true;
}
// Fenêtre envoyée dans le canal à chaque relance, supprimée automatiquement après 20 secondes (v59) :
//   🎮GAME: #N473
//   🃏Carte ❤️:⌛
//   🔁 Rattrapages : 3  ·  Догоны : 3
const FLASH_MS = 20 * 1000;
async function flashRelaunch(cfg, target, items) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  const suits = items.map((it) => it.suit).join(' ');
  const r = Number.isFinite(Number(cfg.maxR)) ? Number(cfg.maxR) : 0;
  const text = [
    `🎮GAME: #N${target}`,
    `🃏Carte ${suits}:⌛`,
    `🔁 Rattrapages : ${r}  ·  Догоны : ${r}`,
  ].join('\n');
  const sent = await sendToChannels(cfg, text, null);
  if (!sent.length || typeof bot.deleteMessage !== 'function') return;
  const t = setTimeout(() => { for (const m of sent) Promise.resolve(bot.deleteMessage(m.chatId, m.messageId)).catch(() => {}); }, FLASH_MS);
  if (t && typeof t.unref === 'function') t.unref(); // ne retient pas l'arrêt du serveur
}
// Relance aussi vers un AUTRE canal : un message simple par costume relancé, au format de prédiction et avec le nombre de rattrapages
// choisis pour ce canal (vérifié comme une prédiction à part ; gagnés / perdus comptés à part).
// v59 : renvoie les costumes dont l'envoi a échoué (canal en pause / jeu instable / bot non administrateur / erreur Telegram) :
// ils sont retentés (retryRelayOut) tant que le jeu relancé n'est pas joué, et l'erreur est visible (panel.lastError + chat privé).
async function sendRelayOut(cfg, items, target) {
  const failed = [];
  for (const it of items) {
    const entry = {
      id: `bwo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, configId: cfg.id, mode: 'relaycanal', relayOut: true, strategy: cfg.strategy, target: Number(target),
      suits: [{ suit: it.suit }], format: cfg.relFormat, strategyName: `${cfg.name || 'Relance'} · relance`, maxR: cfg.relMaxR,
      step: 0, gap: 0, skipped: 0, status: 'en attente', messages: [], createdAt: Date.now(), resolvedAt: null,
    };
    const out = triggerMessage(entry, 'en attente');
    entry.messages = await sendToChannels(cfg, out.text, out.parse_mode, cfg.relChannels);
    if (!entry.messages.length) { failed.push({ suit: it.suit }); continue; }
    panel.pending.push(entry); cfg.relOutSent = (cfg.relOutSent || 0) + 1; panel.lastError = null;
  }
  if (failed.length) panel.lastError = `Relance N°${target} non envoyée vers ${(cfg.relChannels || []).join(', ')} (canal en pause, jeu instable, bot non administrateur ou erreur Telegram)`;
  persist();
  return failed;
}
const RELAY_RETRY_MAX = 6;
async function retryRelayOut() {
  for (const e of panel.pending.slice()) {
    if (!e.relaunch || !Array.isArray(e.relayTodo) || !e.relayTodo.length || e.status !== 'en attente') continue;
    const cfg = panel.configs.find((c) => c.id === e.configId);
    if (!cfg || !(cfg.relChannels || []).length) { e.relayTodo = []; continue; }
    if (Date.now() - (e.relayTryAt || 0) < 20000) continue;
    if (Number(e.target) <= maxFinishedGameNumber()) { // jeu relancé déjà joué : trop tard pour le prédire
      e.relayTodo = []; panel.lastError = `Relance N°${e.target} abandonnée vers ${cfg.relChannels.join(', ')} : jeu déjà joué.`; notifyAdminRelay(cfg, e, 'jeu déjà joué'); continue;
    }
    e.relayTries = (Number(e.relayTries) || 0) + 1; e.relayTryAt = Date.now();
    const failed = await sendRelayOut(cfg, e.relayTodo, e.target).catch((err) => { panel.lastError = err.message; return e.relayTodo; });
    e.relayTodo = failed;
    if (failed.length && e.relayTries >= RELAY_RETRY_MAX) { e.relayTodo = []; notifyAdminRelay(cfg, e, `${RELAY_RETRY_MAX} essais sans succès`); }
  }
}
function notifyAdminRelay(cfg, e, why) {
  try {
    const bot = typeof sender === 'function' ? sender() : null; const adminId = adminIdFn ? adminIdFn() : null;
    if (!bot || !adminId) return;
    const raw = typeof bot.sendMessageUnguarded === 'function' ? bot.sendMessageUnguarded : bot.sendMessage.bind(bot);
    Promise.resolve(raw(adminId, `⚠️ Relance « ${cfg.name || 'Relance'} » : la prédiction N°${e.target} n'a pas pu être envoyée vers ${(cfg.relChannels || []).join(', ')} (${why}). Vérifie que le bot est administrateur du canal et que le canal n'est pas en pause.`)).catch(() => {});
  } catch (_) { /* information seulement */ }
}
// ── Analyse du +n : à chaque relance décidée, on note le costume pas venu ; quand les jeux N+3 … N+n sont joués, on regarde pour chaque +k
// s'il est sorti (au jeu N+k ou dans ses rattrapages). Le +k qui réussit le plus est retenu (et appliqué tout seul si « analyse auto »). ──
function observeRelaunch(cfg, parent, rest) {
  if (!Array.isArray(cfg.relObs)) cfg.relObs = [];
  const lo = Math.max(RELAUNCH_MIN_OFFSET, relaunchWait(cfg) + 1);
  cfg.relObs.push({ base: relaunchBase(parent), suits: rest.map((x) => x.suit), lo, hi: Math.max(lo, Number(cfg.relMaxN) || RELAUNCH_N_MAX), maxR: cfg.maxR, res: {}, at: Date.now() });
  if (cfg.relObs.length > 80) cfg.relObs = cfg.relObs.slice(-80);
}
function relHit(num, suit, maxR, maxDone) { // 1 sorti · 0 pas sorti · undefined pas encore joué
  for (let s = 0; s <= maxR; s++) {
    const n = num + s; const g = state.games.get(n);
    if (g && g.finished && g.complete !== false) { if (hasSuit(g, suit)) return 1; continue; }
    if (n + 2 <= maxDone) continue; // jeu manquant : ignoré
    return undefined;
  }
  return 0;
}
function bestRelaunchOffset(cfg) {
  let best = null;
  for (const [k, st] of Object.entries(cfg.relStats || {})) {
    if (Number(k) > (Number(cfg.relMaxN) || RELAUNCH_N_MAX) || st.n < RELAUNCH_MIN_SAMPLE) continue;
    const rate = st.hit / st.n;
    if (!best || rate > best.rate + 1e-9 || (Math.abs(rate - best.rate) < 1e-9 && st.n > best.n)) best = { k: Number(k), rate, n: st.n }; // égalité : le plus petit +k
  }
  return best ? best.k : null;
}
// Verdict de l'analyse du +n : envoyé AUSSI au chat privé de l'administrateur (jamais dans un canal), à chaque fois que le +n retenu change
function notifyVerdict(cfg, prev) {
  try {
    const bot = typeof sender === 'function' ? sender() : null;
    const adminId = adminIdFn ? adminIdFn() : null;
    if (!bot || !adminId) return;
    const rows = Object.entries(cfg.relStats || {}).map(([k, st]) => ({ k: Number(k), n: st.n, hit: st.hit, rate: st.n ? Math.round(st.hit * 100 / st.n) : 0 }))
      .filter((r) => r.k <= (Number(cfg.relMaxN) || RELAUNCH_N_MAX)).sort((a, b) => a.k - b.k);
    const win = rows.find((r) => r.k === cfg.relOffsetAuto);
    const dest = cfg.channels.map((id) => panel.channelTitles[String(id)] || String(id)).join(' + ');
    const text = `🧠 Verdict de l'analyse du +n — ${cfg.name || 'Relance'}\n\n`
      + `${prev ? `Le +n change : +${prev} → +${cfg.relOffsetAuto}` : `Premier verdict : les relances partent maintenant à N+${cfg.relOffsetAuto}`}\n`
      + `${win ? `✅ +${win.k} : ${win.rate}% (${win.hit}/${win.n})\n` : ''}\n`
      + `${rows.map((r) => `${r.k === cfg.relOffsetAuto ? '👉' : '▫️'} +${r.k} : ${r.rate}% (${r.hit}/${r.n})`).join('\n')}\n\n`
      + `Canal : ${dest}`;
    const raw = bot.sendMessageUnguarded || bot.sendMessage.bind(bot);
    Promise.resolve(raw(adminId, text)).catch(() => {});
  } catch (_) { /* une alerte ratée ne doit jamais bloquer les prédictions */ }
}
function resolveRelObs(maxDone) {
  let changed = false;
  for (const cfg of panel.configs) {
    if (modeOf(cfg) !== 'relance' || !Array.isArray(cfg.relObs) || !cfg.relObs.length) continue;
    if (!cfg.relStats || typeof cfg.relStats !== 'object') cfg.relStats = {};
    const keep = []; let touched = false;
    for (const ob of cfg.relObs) {
      let open = 0;
      for (const suit of ob.suits) for (let k = ob.lo; k <= ob.hi; k++) {
        const key = `${suit}|${k}`;
        if (key in ob.res) continue;
        const r = relHit(ob.base + k, suit, ob.maxR, maxDone);
        if (r === undefined) { open++; continue; }
        ob.res[key] = r; touched = true;
        const st = (cfg.relStats[k] = cfg.relStats[k] || { n: 0, hit: 0 }); st.n += 1; st.hit += r;
      }
      if (open && Date.now() - ob.at < 6 * 3600 * 1000) keep.push(ob);
    }
    cfg.relObs = keep;
    if (touched) {
      const prev = cfg.relOffsetAuto || null;
      cfg.relOffsetAuto = bestRelaunchOffset(cfg); changed = true;
      if (cfg.relAuto && cfg.relOffsetAuto && cfg.relOffsetAuto !== prev) notifyVerdict(cfg, prev);
    }
  }
  return changed;
}
function verifyPending() {
  const maxDone = maxFinishedGameNumber();
  let changed = false;
  try { if (resolveRelObs(maxDone)) changed = true; } catch (e) { panel.lastError = e.message; }
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
        entry.status = 'gagné'; entry.resolvedAt = Date.now(); strategyRecap.noteEntry(entry); changed = true;
        if (cfg) { if (entry.relayOut) cfg.relOutWins = (cfg.relOutWins || 0) + 1; else cfg.wins = (cfg.wins || 0) + 1; }
        if (isTrigger) editTrigger(entry, 'gagné');
        if (entry.mode === 'follow') advanceFollow(cfg, entry);
        if (entry.mode === 'cycle' && cfg) advanceCycle(cfg, entry);
        else if (entry.mode === 'test') { if (cfg) advanceTest(cfg, entry); } // le format choisi est déjà mis à jour par editTrigger
        break;
      }
      if (entry.step >= entry.maxR) {
        entry.status = 'perdu'; entry.resolvedAt = Date.now(); strategyRecap.noteEntry(entry); changed = true;
        if (cfg) { if (entry.relayOut) cfg.relOutLosses = (cfg.relOutLosses || 0) + 1; else cfg.losses = (cfg.losses || 0) + 1; }
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
  try { retryFailedEdits(); } catch (e) { panel.lastError = e.message; }
  try { await retryRelayOut(); } catch (e) { panel.lastError = e.message; }
  try { await checkAbsence(); } catch (e) { panel.lastError = e.message; }
  try { await checkPatterns(); } catch (e) { panel.lastError = e.message; }
  try { await lossNextPoll(); } catch (e) { panel.lastError = e.message; }
}
setOnShoeReset(() => {
  collector.clear();
  panel.watch = panel.watch.filter((w) => w.kind !== 'scan'); // la numérotation repart de zéro
  for (const c of panel.configs) if (Array.isArray(c.relObs)) c.relObs = []; // observations du +n : la numérotation repart de zéro
  panel.trig.armed = {}; panel.trig.absenceFired = {}; // nouveau sabot : la numérotation repart de zéro
  const cancelled = [];
  for (const e of panel.pending) if (e.status === 'en attente') { e.status = 'annulé'; e.resolvedAt = Date.now(); cancelled.push(e); }
  for (const e of cancelled) { try { if ((e.mode === 'multi' || e.mode === 'relance') && e.relaunch) editMulti(e); } catch (_) {} } // v59 : le ⏳ de la relance annulée est remplacé
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
      const lines = [` ┣━${sample[0].suit} N°464✅`, ` ┣━${sample.slice(1).map((x) => x.suit).join('')} N°${464 + relaunchOffset(cfg)}⏳`];
      await sendToChannels(cfg, `🧪 Test (un costume sorti, l'autre pas venu jusqu'à N+${relaunchWait(cfg)} : relance à N+${relaunchOffset(cfg)}, le N° est placé à côté du costume relancé)\n${relaunchText(sample, sample.map((_, i) => (i === 0 ? 0 : 1)), lines, [464, 464 + relaunchOffset(cfg)])}`, 'HTML');
      if (cfg.relChannels && cfg.relChannels.length) {
        const o = triggerMessage({ format: cfg.relFormat, target: 464 + relaunchOffset(cfg), suits: [{ suit: sample[1].suit }], strategyName: `${cfg.name || 'Relance'} · relance`, maxR: cfg.relMaxR, step: 0 }, 'en attente');
        const r2 = await sendToChannels(cfg, `🧪 Test (relance vers l'autre canal)\n${o.text}`, o.parse_mode, cfg.relChannels);
        if (!r2.length) return { ok: false, error: panel.lastError || 'Envoi impossible vers le canal de relance' };
      }
    }
  }
  return msgs.length ? { ok: true, sent: msgs.length } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

function status() {
  return {
    strategies: STRATEGIES, rankLabels: RANK_LABELS, triggerLabel: TRIGGER_LABEL, cycleLabel: `Cycle : ${CYCLE_ORDER.map((r) => RANK_LABELS[r]).join(' → ')}`, formatCount: fmt.FORMAT_COUNT,
    configs: panel.configs.map((c) => ({
      ...c, mode: modeOf(c), strategyLabel: modeOf(c) === 'lossnext' && lnKindOf(c) !== 'rank' ? (lnKindOf(c) === 'channel' ? 'Canaux suivis' : 'Stratégies existantes suivies') : modeOf(c) === 'follow' ? 'Suivi des canaux cochés' : (modeOf(c) === 'scan' ? 'Détection auto des canaux' : STRATEGIES[c.strategy]), sourceNames: (c.sources || []).map((id) => panel.channelTitles[String(id)] || String(id)),
      ranksLabel: modeOf(c) === 'follow' ? `Suit : ${(c.sources || []).map((id) => panel.channelTitles[String(id)] || String(id)).join(', ')}` : modeOf(c) === 'scan' ? `Surveille : ${(c.sources || []).map((id) => panel.channelTitles[String(id)] || String(id)).join(', ')} · un costume ✅0️⃣ → l'autre à N+2` : modeOf(c) === 'trigger' ? TRIGGER_LABEL : (modeOf(c) === 'cycle' ? `Cycle : ${CYCLE_ORDER.map((r) => RANK_LABELS[r]).join(' → ')}` : (modeOf(c) === 'relance' ? `Costumes : ${(c.ranks && c.ranks.length ? c.ranks : RELAUNCH_DEFAULT_RANKS).map((r) => RANK_LABELS[r]).join(' + ')} · un costume sorti, l'autre pas venu jusqu'à N+${relaunchWait(c)} → relancé à ${c.relAuto ? (relaunchAwaitingVerdict(c) ? `N+? (analyse auto de +${RELAUNCH_MIN_OFFSET} à +${c.relMaxN} : en attente du verdict)` : `N+${relaunchOffset(c)} (choisi par l'analyse auto)`) : `N+${relaunchOffset(c)}`}${(c.relChannels || []).length ? ` · aussi vers ${c.relChannels.map((id) => panel.channelTitles[String(id)] || String(id)).join(', ')}` : ''}` : modeOf(c) === 'test' ? `Rangs : ${(c.ranks && c.ranks.length ? c.ranks : TEST_DEFAULT_RANKS).map((r) => RANK_LABELS[r]).join(' → ')} · rang suivant après une perte` : (c.ranks || DEFAULT_RANKS).map((r) => RANK_LABELS[r]).join(' + '))),
      testLabel: modeOf(c) === 'test' ? (c.lossGate ? (c.gateFrom ? `Perte du « ${RANK_LABELS[c.gateFrom]} » → prochaine source : ${RANK_LABELS[(c.ranks || TEST_DEFAULT_RANKS)[((c.ranks || TEST_DEFAULT_RANKS).indexOf(c.gateFrom) + 1) % (c.ranks || TEST_DEFAULT_RANKS).length]]}` : 'Envoi après une perte : en attente d’une perte parmi les rangs choisis') : `Prochaine source : ${RANK_LABELS[c.testRank] || RANK_LABELS[1]}`) : null,
      lossNextLabel: modeOf(c) === 'lossnext' ? lossNextLabel(c) : null,
      lnSourceNames: modeOf(c) === 'lossnext' && lnKindOf(c) !== 'rank' ? (c.lnSources || []).map((k) => lossNextSourceName(c, k)) : [],
      cycleLabel: modeOf(c) === 'cycle' ? (c.cycleWaiting ? 'Les 4 sont passées : en attente d’une perte parmi les 4' : `Suit actuellement : ${RANK_LABELS[c.cycleRole] || RANK_LABELS[1]}${(c.cycleDone || []).length ? ` (déjà passés : ${c.cycleDone.map((r) => RANK_LABELS[r]).join(', ')})` : ''}`) : null,
      channelNames: c.channels.map((id) => panel.channelTitles[String(id)] || String(id)),
      relObs: undefined, relObsCount: Array.isArray(c.relObs) ? c.relObs.length : 0,
      relaunch: modeOf(c) === 'relance' ? {
        wait: relaunchWait(c), offset: Number(c.relOffset) || RELAUNCH_OFFSET, effective: relaunchAwaitingVerdict(c) ? null : relaunchOffset(c), awaiting: relaunchAwaitingVerdict(c), auto: !!c.relAuto, maxN: Number(c.relMaxN) || RELAUNCH_N_MAX,
        minSample: RELAUNCH_MIN_SAMPLE, autoOffset: c.relOffsetAuto || null,
        analysis: Object.entries(c.relStats || {}).map(([k, st]) => ({ k: Number(k), n: st.n, hit: st.hit, rate: st.n ? Math.round(st.hit * 100 / st.n) : 0 })).filter((r) => r.k <= (Number(c.relMaxN) || RELAUNCH_N_MAX)).sort((a, b) => a.k - b.k),
        channelNames: (c.relChannels || []).map((id) => panel.channelTitles[String(id)] || String(id)),
      } : null,
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
  panel, config, configure, setSender, setAdminId, setPctProvider, setRankProvider, setTestRankProvider, restore, restoreFromDb, persist, addConfig, updateConfig, removeConfig, setChannelTitle,
  hasEnabled, hasMultiChannels, record, recordResult, tick, test, status, parseChannels, STRATEGIES, findDuplicate, dedupeConfigs,
  onChannelPost, parseDuo, detectedList, predictionText,
};
