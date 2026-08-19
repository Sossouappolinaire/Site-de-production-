// strategies.js — catalogue des stratégies de prédiction (main du JOUEUR uniquement)
//
// Chaque stratégie expose :
//   key         identifiant technique (clé en base de données)
//   name        nom affiché
//   about       explication de la règle
//   defaults    configuration par défaut (format, rattrapages, lead, …)
//   detect(g)   analyse un tour terminé et renvoie une prédiction ou null
//
// Deux natures de prédiction :
//   kind: 'suit'  → on vérifie qu'un costume apparaît dans la main du JOUEUR
//   kind: 'cards' → on vérifie le nombre de cartes (ex: joueur 3 / banquier 3)
'use strict';

const config = require('./config');

const SUITS = ['♦️', '❤️', '♣️', '♠️'];

// table des inverses (Stratégie Dominant)
const INVERSE = { '❤️': '♣️', '♣️': '❤️', '♦️': '♠️', '♠️': '♦️' };

// normalisation d'un costume : '❤' '♥' '♥️' → '❤️'
function normSuit(s) {
  if (!s) return null;
  const raw = String(s).replace(/\uFE0F/g, '').trim();
  if (raw === '♥' || raw === '❤') return '❤️';
  if (raw === '♦') return '♦️';
  if (raw === '♣') return '♣️';
  if (raw === '♠') return '♠️';
  return null;
}

const suitsOf = (list) => (list || []).map(normSuit).filter(Boolean);

// ---------------------------------------------------------------------------
// 1) Costume par numéro (stratégie historique)
// ---------------------------------------------------------------------------
function suitForNumber(n) {
  return normSuit(config.SUIT_BY_LAST_DIGIT[n % 10]) || null;
}

const costume = {
  key: 'costume',
  name: 'Costume par numéro',
  about:
    "Le costume est imposé par le dernier chiffre du numéro de tour " +
    "(2→♦️, 5→❤️, 6→♣️, 9→♠️). Le compteur B bloque la prédiction quand " +
    "le costume est déjà en pleine série. Vérification sur la main du joueur.",
  defaults: { enabled: true, format: config.DEFAULT_FORMAT, maxR: config.DEFAULT_MAX_R, b: config.DEFAULT_B, lead: config.LEAD, template: null, channels: [] },
  usesB: true,
  // pour cette stratégie on analyse le tour LIVE (prédiction 2 tours à l'avance)
  source: 'live',
  detect(game, cfg, ctx) {
    if (!game) return null;
    const target = game.number + (cfg.lead || config.LEAD);
    const suit = suitForNumber(target);
    if (!suit) return null;
    const counters = (ctx && ctx.counters) || {};
    if ((counters[suit] || 0) >= (cfg.b || config.DEFAULT_B)) return null; // série en cours
    return {
      kind: 'suit',
      target,
      suit,
      label: suit,
      counter: counters[suit] || 0,
      reason: `costume imposé par le numéro ${target}`,
    };
  },
};

// ---------------------------------------------------------------------------
// 2) Dominant Baccarat — filtre 3/3, mélange des 6 cartes, on joue l'INVERSE
// ---------------------------------------------------------------------------
function dominantOf(sixSuits) {
  const count = { '♦️': 0, '❤️': 0, '♣️': 0, '♠️': 0 };
  for (const s of sixSuits) if (count[s] != null) count[s] += 1;
  const values = Object.values(count).sort((a, b) => b - a);
  const max = values[0];
  // dominant fort : au moins 2 fois ET pas d'égalité avec une autre couleur
  if (max < 2) return { count, dominant: null, reason: '1-1-1-1 : aucun signal' };
  if (values[1] === max) return { count, dominant: null, reason: `${values.join('-')} : égalité instable` };
  const dominant = Object.keys(count).find((k) => count[k] === max) || null;
  return { count, dominant, reason: `configuration ${values.join('-')} valide` };
}

const dominant = {
  key: 'dominant',
  name: 'Dominant Baccarat',
  about:
    "Filtre obligatoire : joueur 3 cartes ET banquier 3 cartes. On mélange les " +
    "6 cartes, on compte les couleurs. S'il y a un dominant fort (une couleur " +
    "au moins 2 fois, sans égalité), on joue TOUJOURS son inverse " +
    "(♥️↔♣️, ♦️↔♠️) sur le tour +2. Vérification sur la main du joueur.",
  defaults: { enabled: true, format: 1, maxR: 2, b: 0, lead: 2, template: null, channels: [] },
  usesB: false,
  source: 'finished',
  detect(game, cfg) {
    if (!game || !game.finished) return null;
    if (game.playerCards !== 3 || game.bankerCards !== 3) return null; // filtre obligatoire
    const six = [...suitsOf(game.playerSuits), ...suitsOf(game.bankerSuits)];
    if (six.length !== 6) return null;
    const { count, dominant: dom, reason } = dominantOf(six);
    if (!dom) return null;
    const suit = INVERSE[dom];
    if (!suit) return null;
    return {
      kind: 'suit',
      target: game.number + (cfg.lead || 2),
      suit,
      label: suit,
      reason: `dominant ${dom} (${reason}) → inverse ${suit}`,
      meta: { dominant: dom, count },
    };
  },
};

// ---------------------------------------------------------------------------
// 3) Match nul — égalité de points : somme > 5 → distribution (+1), sinon 3/3 (+2)
// ---------------------------------------------------------------------------
const matchnul = {
  key: 'matchnul',
  name: 'Match nul (points égaux)',
  about:
    "Quand les points du joueur sont égaux à ceux du banquier (match nul), on " +
    "additionne les deux points. Somme > 5 → on prédit une DISTRIBUTION au tour " +
    "+1 (joueur 2 cartes et banquier 2 cartes). Sinon → on prédit 3 cartes " +
    "joueur et 3 cartes banquier au tour +2.",
  defaults: { enabled: true, format: 78, formatDistribution: 79, maxR: 2, b: 0, lead: 1, template: null, channels: [] },
  usesB: false,
  source: 'finished',
  detect(game, cfg) {
    if (!game || !game.finished) return null;
    // MATCH NUL = POINTS ÉGAUX (jamais un nombre de cartes égal !)
    const pv = game.playerValue;
    const bv = game.bankerValue;
    if (pv == null || bv == null) return null;
    const tie = pv === bv || game.winner === 'Égalité';
    if (!tie) return null;                            // uniquement les matchs nuls
    // le total des points joueur + banquier décide de la prédiction
    const sum = pv + bv;
    if (sum > 5) {
      return {
        kind: 'cards',
        target: game.number + 1,
        wantPlayer: 2,
        wantBanker: 2,
        cardsLabel: '2/2',
        suit: 'deux',
        label: 'distribution 2/2',
        format: cfg.formatDistribution || 79,
        reason: `match nul ${pv}=${bv}, somme ${sum} > 5 → distribution au +1`,
      };
    }
    return {
      kind: 'cards',
      target: game.number + 2,
      wantPlayer: 3,
      wantBanker: 3,
      cardsLabel: '3/3',
      suit: 'trois',
      label: '3 cartes / 3 cartes',
      reason: `match nul ${pv}=${bv}, somme ${sum} ≤ 5 → 3/3 au +2`,
    };
  },
};


// ---------------------------------------------------------------------------
// 4) Pair / Impair (VAR) — séquence de déclencheurs Jeu de départ + VAR
// ---------------------------------------------------------------------------
// Séquence : trigger(0) = jeu de départ, puis chaque pas vaut +10, sauf tous
// les VAR pas où le pas vaut +9 (décalage de -1 imposé par la remise à zéro
// du compteur VAR).  Exemple start=1, VAR=2 :
//   1 → 11 → 20 → 30 → 39 → 49 → 58 → 68 → 77 → 87 → 96 → 106 …
//   (écarts 10, 9, 10, 9, 10, 9 …)
// Formule fermée : trigger(n) = start + 10n - floor(n / VAR)   (VAR ≥ 1)
function normParity(cfg = {}) {
  const start = Math.max(1, parseInt(cfg.startGame, 10) || 1);
  const varN = Math.max(0, parseInt(cfg.varStep, 10) || 0);
  const dec = Math.max(1, parseInt(cfg.decalage, 10) || 1);
  return { start, varN, dec };
}

function triggerAt(n, start, varN) {
  if (n < 0) return null;
  return start + 10 * n - (varN >= 1 ? Math.floor(n / varN) : 0);
}

// index du déclencheur si `number` appartient à la séquence, sinon -1
function triggerIndexOf(number, start, varN) {
  if (number < start) return -1;
  // borne basse sûre : triggerAt(n) >= start + 9n  →  n <= (number - start) / 9
  let n = 0;
  let guard = 0;
  while (guard++ < 100000) {
    const v = triggerAt(n, start, varN);
    if (v === number) return n;
    if (v > number) return -1;
    n += 1;
  }
  return -1;
}

// dernier déclencheur <= number (null si la séquence n'a pas encore commencé)
function lastTriggerAtOrBefore(number, start, varN) {
  if (number < start) return null;
  let n = 0;
  let last = start;
  let guard = 0;
  while (guard++ < 100000) {
    const v = triggerAt(n, start, varN);
    if (v > number) break;
    last = v;
    n += 1;
  }
  return last;
}

function nextTriggerAfter(number, start, varN) {
  const last = lastTriggerAtOrBefore(number, start, varN);
  if (last == null) return start;
  const idx = triggerIndexOf(last, start, varN);
  return triggerAt(idx + 1, start, varN);
}

// séquence lisible (utilisée par /parite et le panel web)
function triggerSequence(start, varN, count = 12, from = null) {
  const out = [];
  let n = from == null ? 0 : Math.max(0, triggerIndexOf(lastTriggerAtOrBefore(from, start, varN), start, varN));
  for (let i = 0; i < count; i++) out.push(triggerAt(n + i, start, varN));
  return out;
}

// VAR restant affiché : VAR, VAR-1, … 0 puis nouveau cycle
function varCounterAt(index, varN) {
  if (varN < 1) return 0;
  return varN - (index % varN);
}

const parite = {
  key: 'parite',
  name: 'Pair / Impair (VAR)',
  about:
    "Jeu de départ + VAR + Décalage + Rattrapage. Le bot calcule la séquence " +
    "des jeux déclencheurs (ex. départ 1 / VAR 2 → 1, 11, 20, 30, 39, 49, 58 …). " +
    "Sur chaque déclencheur il lit le POINT DU JOUEUR : point pair → prédiction " +
    "IMPAIR, point impair → prédiction PAIR. Le jeu cible est déclencheur + " +
    "décalage, et la vérification porte sur la parité du point du joueur du jeu " +
    "cible, puis sur les rattrapages configurés. Au redémarrage la séquence est " +
    "reconstruite mathématiquement : le bot attend simplement le prochain " +
    "déclencheur, sans rejouer le passé.",
  defaults: {
    enabled: true,
    format: 80,
    maxR: 3,
    b: 0,
    lead: 1,
    startGame: 1,
    varStep: 2,
    decalage: 1,
    template: null,
    channels: [],
  },
  usesB: false,
  source: 'finished',
  detect(game, cfg, ctx) {
    if (!game || !game.finished) return null;
    const { start, varN, dec } = normParity(cfg);
    if (game.number < start) return null;                 // pas encore démarré
    // Règle : la prédiction part IMMÉDIATEMENT sur le jeu déclencheur lui-même.
    // Si le jeu terminé n'appartient pas à la séquence, on n'invente rien.
    if (triggerIndexOf(game.number, start, varN) < 0) return null;
    const trig = game.number;
    const src = game;
    const pv = src.playerValue;
    if (pv == null) return null;
    const pair = pv % 2 === 0;
    const suit = pair ? 'impair' : 'pair';                // règle 7 : on inverse
    const idx = triggerIndexOf(trig, start, varN);
    return {
      kind: 'parity',
      target: trig + dec,
      suit,
      label: suit === 'pair' ? 'PAIR' : 'IMPAIR',
      trigger: trig,
      reason:
        `déclencheur #N${trig} • point joueur ${pv} (${pair ? 'pair' : 'impair'}) → ` +
        `prédiction ${suit.toUpperCase()} sur #N${trig + dec} (décalage ${dec})`,
      meta: {
        trigger: trig,
        index: idx,
        playerValue: pv,
        varLeft: varCounterAt(idx, varN),
        nextTrigger: nextTriggerAfter(trig, start, varN),
        start, varN, dec,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 5) Carte absente (joueur ET banquier) — 3 jeux consécutifs sans le costume
// ---------------------------------------------------------------------------
// Règle : un costume doit être ABSENT de la main du JOUEUR pendant N jeux
// consécutifs (N = 3 par défaut) ET ABSENT de la main du BANQUIER pendant ces
// mêmes N jeux. On prédit alors ce costume au tour +2, vérifié sur la main du
// joueur, avec les rattrapages configurés.
function absenceStreaks(games, lastNumber, need) {
  const rounds = [];
  for (let n = lastNumber - need + 1; n <= lastNumber; n++) {
    const g = n === lastNumber ? games.get(n) : games.get(n);
    if (!g || !g.finished) return null;                 // série non consécutive
    const ps = suitsOf(g.playerSuits);
    const bs = suitsOf(g.bankerSuits);
    if (!ps.length || !bs.length) return null;          // cartes non lisibles
    rounds.push({ number: n, ps, bs });
  }
  const missing = [];
  for (const s of SUITS) {
    const absent = rounds.every((r) => !r.ps.includes(s) && !r.bs.includes(s));
    if (absent) missing.push(s);
  }
  return { rounds, missing };
}

const absente = {
  key: 'absente',
  name: 'Carte absente (3 jeux)',
  about:
    "On surveille les 4 costumes. Si un costume est ABSENT de la main du JOUEUR " +
    "pendant 3 jeux consécutifs ET absent de la main du BANQUIER pendant ces " +
    "mêmes 3 jeux, on prédit ce costume au tour +2. La vérification se fait sur " +
    "la main du joueur, puis sur les rattrapages configurés. Le nombre de jeux " +
    "consécutifs (3) est réglable.",
  defaults: {
    enabled: true,
    format: config.DEFAULT_FORMAT,
    maxR: 2,
    b: 0,
    lead: 2,
    streak: 3,
    template: null,
    channels: [],
  },
  usesB: false,
  source: 'finished',
  detect(game, cfg, ctx) {
    if (!game || !game.finished) return null;
    const need = Math.max(2, Math.min(10, parseInt(cfg && cfg.streak, 10) || 3));
    const games = (ctx && ctx.games) || new Map();
    const res = absenceStreaks(games, game.number, need);
    if (!res || !res.missing.length) return null;
    // « une seule carte manquante » : on ne joue que s'il reste un candidat clair.
    // Si plusieurs costumes sont absents, on prend le premier dans l'ordre
    // ♦️ ❤️ ♣️ ♠️ pour rester déterministe.
    const suit = res.missing[0];
    const lead = Math.max(1, parseInt(cfg && cfg.lead, 10) || 2);
    return {
      kind: 'suit',
      target: game.number + lead,
      suit,
      label: suit,
      trigger: game.number,
      reason:
        `${suit} absent du joueur ET du banquier sur ${need} jeux consécutifs ` +
        `(#N${game.number - need + 1} → #N${game.number}) → prédiction ${suit} sur ` +
        `#N${game.number + lead}`,
      meta: {
        streak: need,
        missing: res.missing,
        from: game.number - need + 1,
        to: game.number,
        rounds: res.rounds.map((r) => ({ number: r.number, player: r.ps, banker: r.bs })),
      },
    };
  },
};


// ---------------------------------------------------------------------------
// 6) Prédiction dans l'ombre — retour d'une carte après une longue absence
// ---------------------------------------------------------------------------
// Règle : on surveille les 4 costumes en silence. Dès qu'un costume est absent
// pendant AU MOINS `absence` jeux consécutifs (4 par défaut), il passe en état
// « surveillé ». Aucune prédiction n'est émise tant qu'il ne revient pas.
// Le jeu où il RÉAPPARAÎT devient le déclencheur : on prédit ce même costume
// au jeu déclencheur + `lead` (4 par défaut).
//   ❤️ absent aux jeux 1-2-3-4 → rien … ❤️ revient au jeu 8 → prédiction ❤️
//   sur le jeu 12 (8 + 4), vérifiée sur la main du joueur + rattrapages.
function suitPresent(g, suit, scope) {
  const ps = suitsOf(g.playerSuits);
  const bs = suitsOf(g.bankerSuits);
  if (scope === 'joueur') return ps.includes(suit);
  return ps.includes(suit) || bs.includes(suit);
}

// nombre de jeux consécutifs terminés, juste avant `number`, sans le costume
// CORRECTIF : un simple trou dans le flux (jeu absent de la mémoire) arrêtait le
// comptage à 0 et la stratégie ne prédisait JAMAIS. On parcourt désormais la
// liste des jeux TERMINÉS réellement connus, du plus récent au plus ancien, en
// ignorant les numéros manquants (jusqu'à `holeMax` trous consécutifs).
function absenceBefore(games, number, suit, scope, max = 60, holeMax = 3) {
  let count = 0;
  let holes = 0;
  for (let n = number - 1; n >= 1 && count < max; n--) {
    const g = games.get(n);
    if (!g || !g.finished) {
      holes += 1;
      if (holes > holeMax) break;                  // trop de trous → on arrête
      continue;                                    // jeu inconnu : on l'ignore
    }
    holes = 0;
    const ps = suitsOf(g.playerSuits);
    const bs = suitsOf(g.bankerSuits);
    if (!ps.length && !bs.length) continue;        // cartes non lisibles : ignoré
    if (suitPresent(g, suit, scope)) break;        // le costume était là
    count += 1;
  }
  return count;
}

const ombre = {
  key: 'ombre',
  name: "Prédiction dans l'ombre",
  about:
    "Surveillance silencieuse des 4 costumes. Un costume absent pendant au " +
    "moins 4 jeux consécutifs (réglable) est mis sous surveillance. Aucune " +
    "prédiction n'est émise pendant l'absence : le bot attend son RETOUR, " +
    "aussi longtemps qu'il faut. Le jeu du retour devient le déclencheur et " +
    "le même costume est prédit au jeu +4 (réglable). Exemple : ❤️ absent aux " +
    "jeux 1 à 4, retour au jeu 8 → prédiction ❤️ sur le jeu 12.",
  defaults: {
    enabled: true,
    format: 88,
    maxR: 2,
    b: 0,
    lead: 4,
    absence: 4,
    scope: 'tous',        // 'tous' = joueur + banquier, 'joueur' = main du joueur
    silent: true,         // mode silencieux : envoi seulement après double perte
    lossTrigger: 2,        // nombre de pertes nécessaires avant de confirmer une position (2 = double perte)
    lossWindow: 6,         // nombre de prédictions suivies après une perte (6 par défaut)
    lossInterval: 5,      // écart max toléré entre la perte de référence et la perte de confirmation
    resetOnWin: true,
    template: null,
    channels: [],
  },
  usesB: false,
  source: 'finished',
  detect(game, cfg, ctx) {
    if (!game || !game.finished) return null;
    const games = (ctx && ctx.games) || new Map();
    const need = Math.max(1, Math.min(30, parseInt(cfg && cfg.absence, 10) || 4));
    const lead = Math.max(1, Math.min(20, parseInt(cfg && cfg.lead, 10) || 4));
    const scope = cfg && cfg.scope === 'joueur' ? 'joueur' : 'tous';
    const present = SUITS.filter((s) => suitPresent(game, s, scope));
    if (!present.length) return null;
    let best = null;
    for (const suit of present) {
      const gap = absenceBefore(games, game.number, suit, scope);
      if (gap >= need && (!best || gap > best.gap)) best = { suit, gap };
    }
    if (!best) return null;
    return {
      kind: 'suit',
      target: game.number + lead,
      suit: best.suit,
      label: best.suit,
      trigger: game.number,
      reason:
        `${best.suit} absent pendant ${best.gap} jeux consécutifs ` +
        `(#N${game.number - best.gap} → #N${game.number - 1}), retour au jeu ` +
        `#N${game.number} → prédiction ${best.suit} sur #N${game.number + lead} (+${lead})`,
      meta: { absence: best.gap, need, lead, scope, returnedAt: game.number },
    };
  },
};

const LIST = [costume, dominant, matchnul, parite, absente, ombre];
const BY_KEY = Object.fromEntries(LIST.map((s) => [s.key, s]));

function defaultsFor(key) {
  const s = BY_KEY[key];
  if (!s) return null;
  // token / canal / bilan : réglables stratégie par stratégie
  // réglages communs à TOUTES les stratégies :
  //   silent        → mode silencieux 1 (envoi seulement après confirmation par
  //                   pertes). RÉSERVÉ à la stratégie « ombre » : pour toute
  //                   autre stratégie, ce réglage est ignoré et reste à false.
  //   lossWindow    → nombre MAX de prédictions attendues après une perte
  //   lossInterval  → intervalle MAXIMUM (écart) autorisé entre la perte de
  //                   référence et la perte de confirmation (0-4 → max 4)
  //                   pour que celle-ci compte comme confirmation (0 = aucun minimum)
  //   resetOnWin    → après activation, une prédiction gagnée referme l'envoi
  //   sendOnlyNext  → une fois confirmé, n'envoie QUE la prédiction suivante puis
  //                   repasse en silence (au lieu d'envoyer en continu jusqu'au gain)
  return {
    token: null,
    bilan: true,
    silent: false,
    lossWindow: 3,
    lossTrigger: 2,     // nb de pertes avant d'ouvrir l'envoi (1 = dès la 1ʳᵉ perte)
    lossInterval: 4,    // intervalle MAX (écart) entre la perte de référence et la perte de confirmation
    autoUnlockMin: 0,   // 0 = pas de déblocage auto (le mode silencieux 1 suit strictement ses phases)
    resetOnWin: true,
    sendOnlyNext: false, // n'envoyer que la prédiction suivante après confirmation
    // --- Déclencheur automatique (commun à TOUTES les stratégies) -----------
    //  autoEnabled     → active le mode « déclencheur + N prédictions »
    //  autoTrigger     → 'perte' ou 'rattrapage'
    //  autoRattrapage  → niveau de rattrapage déclencheur (si autoTrigger = 'rattrapage')
    //  autoSkip        → nombre de prédictions comptées après le déclencheur
    //  autoSend        → nombre de prédictions envoyées une fois le compte atteint
    autoEnabled: false,
    autoTrigger: 'perte',
    autoRattrapage: 2,
    autoSkip: 3,
    autoSend: 1,
    // Mode d'activation silencieux (2ᵉ mode) SUPPRIMÉ du projet : seul le mode
    // silencieux 1 (silent / loss*) subsiste, et uniquement pour la stratégie
    // « ombre ». Aucun autre mode silencieux configurable n'existe.
    publishedChannels: [],
    shadowChannels: [],
    publishedChannelInfos: [],
    shadowChannelInfos: [],
    ...JSON.parse(JSON.stringify(s.defaults)),
  };
}

function catalog() {
  return LIST.map((s) => ({ key: s.key, name: s.name, about: s.about, usesB: !!s.usesB, defaults: s.defaults }));
}

module.exports = {
  LIST, BY_KEY, SUITS, INVERSE, normSuit, suitsOf, suitForNumber, dominantOf, defaultsFor, catalog,
  normParity, triggerAt, triggerIndexOf, lastTriggerAtOrBefore, nextTriggerAfter, triggerSequence, varCounterAt,
};
