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
// table du « miroir » (demande admin, distincte de l'inverse ci-dessus) :
// utilisée par la « répétition après perte » (after-loss.js, mode 'miroir')
// — ❤️↔♦️ (les deux costumes rouges), ♠️↔♣️ (les deux costumes noirs).
const MIRROR = { '❤️': '♦️', '♦️': '❤️', '♠️': '♣️', '♣️': '♠️' };

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
    "(♥️↔♣️, ♦️↔♠️) sur le tour +2. Vérification sur la main du joueur. " +
    "Deux garde-fous avant l'envoi : (1) écart minimum (3 jeux par défaut) " +
    "entre deux prédictions de cette stratégie ; (2) compteur de costumes sur " +
    "3 jeux (le déclencheur et les 2 précédents) — si le costume à prédire " +
    "est apparu sur la main du JOUEUR dans 2 jeux CONSÉCUTIFS parmi ces 3 " +
    "(ex. déclencheur au jeu 23 : venu aux jeux 21 et 22, ou venu aux jeux 22 " +
    "et 23), le déclencheur est ignoré.",
  defaults: { enabled: true, format: 1, maxR: 2, b: 0, lead: 2, gap: 3, template: null, channels: [] },
  usesB: false,
  source: 'finished',
  detect(game, cfg, ctx) {
    if (!game || !game.finished) return null;
    if (game.playerCards !== 3 || game.bankerCards !== 3) return null; // filtre obligatoire
    const six = [...suitsOf(game.playerSuits), ...suitsOf(game.bankerSuits)];
    if (six.length !== 6) return null;
    const { count, dominant: dom, reason } = dominantOf(six);
    if (!dom) return null;
    const suit = INVERSE[dom];
    if (!suit) return null;

    // garde-fou 1 : écart minimum entre deux prédictions « dominant » — on
    // regarde la dernière prédiction déjà émise par CETTE stratégie (la plus
    // récente est en tête, voir predictor.js/evaluate → unshift) et on exige
    // au moins `gap` jeux d'écart entre son déclencheur et celui-ci.
    const gapNeeded = Math.max(1, Math.min(20, parseInt(cfg && cfg.gap, 10) || 3));
    const predictions = (ctx && ctx.predictions) || [];
    const lastDominant = predictions.find((p) => p.strategy === 'dominant');
    if (lastDominant && lastDominant.from != null && (game.number - lastDominant.from) < gapNeeded) {
      return null; // trop proche de la précédente prédiction « dominant »
    }

    // garde-fou 2 : compteur de costumes sur 3 jeux — le déclencheur (n) et
    // les 2 jeux qui le précèdent immédiatement (n-1, n-2). On bloque
    // UNIQUEMENT si le costume à prédire est apparu sur la main du JOUEUR
    // dans 2 jeux CONSÉCUTIFS parmi ces 3 : (n-2 ET n-1) OU (n-1 ET n).
    // Exemple : déclencheur au jeu 23 → on regarde 21, 22 et 23. S'il est
    // venu aux jeux 21 ET 22 → on ignore. S'il est venu aux jeux 22 ET 23 →
    // on ignore aussi. Une seule occurrence isolée (ni consécutive ni
    // répétée) ne bloque pas la prédiction.
    const games = (ctx && ctx.games) || new Map();
    const playerHasSuitAt = (n) => {
      const g = n === game.number ? game : games.get(n);
      return g ? suitsOf(g.playerSuits).includes(suit) : false;
    };
    const atN2 = playerHasSuitAt(game.number - 2);
    const atN1 = playerHasSuitAt(game.number - 1);
    const atN0 = playerHasSuitAt(game.number);
    if ((atN2 && atN1) || (atN1 && atN0)) return null;

    return {
      kind: 'suit',
      target: game.number + (cfg.lead || 2),
      suit,
      label: suit,
      reason: `dominant ${dom} (${reason}) → inverse ${suit}`,
      meta: { dominant: dom, count, gap: gapNeeded },
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
// 5bis) Prédiction dans l'ombre (Banquier) — retour d'un costume sur la main
// du BANQUIER uniquement (demande admin)
// ---------------------------------------------------------------------------
// Règle identique à « Prédiction dans l'ombre (Joueur) » mais inversée :
// on surveille en silence les 4 costumes de la main du BANQUIER UNIQUEMENT
// (le joueur n'entre jamais en compte). Dès qu'un costume est absent de la
// main du banquier pendant AU MOINS `absence` jeux consécutifs (4 par
// défaut), il passe en état « surveillé ». Aucune prédiction n'est émise
// pendant l'absence : le bot attend son RETOUR sur la main du banquier,
// aussi longtemps qu'il faut. Le jeu où il RÉAPPARAÎT devient le
// déclencheur : on prédit ce même costume chez le BANQUIER au jeu
// déclencheur + `lead` (4 par défaut), vérifié sur la main du banquier +
// rattrapages configurés.
//   ❤️ absent (banquier) aux jeux 1-2-3 → rien … ❤️ revient au jeu 7 →
//   prédiction ❤️ chez le banquier sur le jeu 11 (7 + 4).
// Vérification sur la main du BANQUIER (kind 'suit-banquier', voir
// predictor.js/matches()). Pas de mode silencieux 1 : ce mode reste réservé
// à « ombre » (voir public/index.html, `s.key === 'ombre'`) — rien à
// exclure ici, cette stratégie n'a jamais eu ce bloc dans le panneau. Le
// déclencheur automatique générique (perte/rattrapage + N) reste disponible.
const carteBanquier = {
  key: 'carteBanquier',
  name: 'Carte disparue → retour banquier',
  about:
    "Surveillance silencieuse des 4 costumes de la main du BANQUIER " +
    "uniquement (le joueur n'est jamais pris en compte). Un costume absent " +
    "de la main du banquier pendant au moins 3 jeux consécutifs (réglable) " +
    "est mis sous surveillance. Aucune prédiction n'est émise pendant " +
    "l'absence : le bot attend son RETOUR sur la main du banquier, aussi " +
    "longtemps qu'il faut. Le jeu du retour devient le déclencheur et le " +
    "même costume est prédit chez le BANQUIER au jeu +4 (réglable). " +
    "Exemple : ❤️ absent de la main du banquier aux jeux 1 à 3, retour au " +
    "jeu 7 → prédiction ❤️ chez le banquier sur le jeu 11. Pas de mode " +
    "silencieux pour cette stratégie.",
  defaults: {
    enabled: true,
    format: config.DEFAULT_FORMAT,
    maxR: config.DEFAULT_MAX_R,
    b: 0,
    lead: 4,
    absence: 3,
    template: null,
    channels: [],
  },
  usesB: false,
  source: 'finished',
  detect(game, cfg, ctx) {
    if (!game || !game.finished) return null;
    const games = (ctx && ctx.games) || new Map();
    const need = Math.max(1, Math.min(30, parseInt(cfg && cfg.absence, 10) || 3));
    const lead = Math.max(1, Math.min(20, parseInt(cfg && cfg.lead, 10) || 4));
    const scope = 'banquier'; // fixe : uniquement la main du banquier, jamais le joueur
    const present = SUITS.filter((s) => suitPresent(game, s, scope));
    if (!present.length) return null;
    let best = null;
    for (const suit of present) {
      const gap = absenceBefore(games, game.number, suit, scope);
      if (gap >= need && (!best || gap > best.gap)) best = { suit, gap };
    }
    if (!best) return null;
    return {
      kind: 'suit-banquier',
      target: game.number + lead,
      suit: best.suit,
      label: best.suit,
      trigger: game.number,
      reason:
        `${best.suit} absent de la main du BANQUIER pendant ${best.gap} jeux consécutifs ` +
        `(#N${game.number - best.gap} → #N${game.number - 1}), retour au jeu ` +
        `#N${game.number} → prédiction ${best.suit} chez le banquier sur ` +
        `#N${game.number + lead} (+${lead})`,
      meta: { absence: best.gap, need, lead, scope, returnedAt: game.number },
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
  if (scope === 'banquier') return bs.includes(suit);
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

// ---------------------------------------------------------------------------
// 7) Prédiction dans l'ombre (Joueur) — retour d'un costume sur la main du
//    JOUEUR UNIQUEMENT (le banquier n'entre jamais en compte, contrairement à
//    la stratégie « ombre » qui peut surveiller les deux mains).
// ---------------------------------------------------------------------------
// Règle : on surveille en silence les 4 costumes de la main du JOUEUR. Dès
// qu'un costume est absent de la main du joueur pendant AU MOINS `absence`
// jeux consécutifs (4 par défaut), il passe en état « surveillé ». Aucune
// prédiction n'est émise pendant l'absence : le bot attend son RETOUR sur la
// main du joueur, aussi longtemps qu'il faut. Le jeu où il RÉAPPARAÎT devient
// le déclencheur : on prédit ce même costume au jeu déclencheur + `lead`
// (4 par défaut), vérifié sur la main du joueur + rattrapages configurés.
//   ❤️ absent (joueur) aux jeux 1-2-3-4 → rien … ❤️ revient au jeu 8 →
//   prédiction ❤️ sur le jeu 12 (8 + 4).
const ombreJoueur = {
  key: 'ombreJoueur',
  name: "Prédiction dans l'ombre (Joueur)",
  about:
    "Surveillance silencieuse des 4 costumes de la main du JOUEUR uniquement " +
    "(le banquier n'est jamais pris en compte). Un costume absent de la main " +
    "du joueur pendant au moins 4 jeux consécutifs (réglable) est mis sous " +
    "surveillance. Aucune prédiction n'est émise pendant l'absence : le bot " +
    "attend son RETOUR sur la main du joueur, aussi longtemps qu'il faut. Le " +
    "jeu du retour devient le déclencheur et le même costume est prédit au " +
    "jeu +4 (réglable). Exemple : ❤️ absent de la main du joueur aux jeux 1 à " +
    "4, retour au jeu 8 → prédiction ❤️ sur le jeu 12.",
  defaults: {
    enabled: true,
    format: config.DEFAULT_FORMAT,
    maxR: config.DEFAULT_MAX_R,
    b: 0,
    lead: 4,
    absence: 4,
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
    const scope = 'joueur'; // fixe : uniquement la main du joueur, jamais le banquier
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
        `${best.suit} absent de la main du JOUEUR pendant ${best.gap} jeux consécutifs ` +
        `(#N${game.number - best.gap} → #N${game.number - 1}), retour au jeu ` +
        `#N${game.number} → prédiction ${best.suit} sur #N${game.number + lead} (+${lead})`,
      meta: { absence: best.gap, need, lead, scope, returnedAt: game.number },
    };
  },
};

// ---------------------------------------------------------------------------
// 9) Comptage par dizaine — costume faible (demande admin)
// ---------------------------------------------------------------------------
// Découpage du sabot en tranches de 10 jeux (#N1-10, #N11-20, #N21-30…).
// Dès qu'un jeu se termine sur un multiple de 10 (déclencheur, ex. #N10), on
// compte, sur les 10 jeux qui viennent de s'écouler (#N1 à #N10), combien de
// fois chacun des 4 costumes est apparu dans la main du JOUEUR (chaque carte
// compte, pas juste présence/absence). Le costume le PLUS RARE de cette
// dizaine (le « costume faible ») est prédit sur le 4ᵉ jeu de la dizaine
// SUIVANTE, c'est-à-dire déclencheur + 4 (réglable) — ex. dizaine #N1-10 →
// prédiction sur #N14. En cas d'égalité entre plusieurs costumes les plus
// rares, ordre déterministe ♦️❤️♣️♠️ (comme pour « absente »).
const dizaine = {
  key: 'dizaine',
  name: 'Comptage par dizaine — costume faible',
  about:
    "Découpe le sabot en tranches de 10 jeux. À la fin de chaque dizaine " +
    "(#N10, #N20, #N30…), compte combien de fois chacun des 4 costumes est " +
    "apparu dans la main du JOUEUR sur ces 10 jeux — comptage « vote » : un " +
    "costume compte 1 seule fois par main, même s'il apparaît sur 2 cartes " +
    "(ex. ♦️♦️❤️ → 1♦️ + 1❤️, jamais 2♦️) — et retient le costume le PLUS " +
    "RARE (« costume faible »). Ce costume est prédit sur le 4ᵉ jeu de la " +
    "dizaine suivante (déclencheur + 4, réglable) — ex. dizaine #N1 à #N10 " +
    "→ prédiction sur #N14. Nécessite au moins 6 des 10 jeux lisibles pour " +
    "un comptage fiable, sinon aucune prédiction n'est émise pour cette " +
    "dizaine.",
  defaults: {
    enabled: true,
    format: config.DEFAULT_FORMAT,
    maxR: config.DEFAULT_MAX_R,
    b: 0,
    lead: 4,
    template: null,
    channels: [],
  },
  usesB: false,
  source: 'finished',
  detect(game, cfg, ctx) {
    if (!game || !game.finished) return null;
    if (game.number % 10 !== 0) return null; // déclencheur uniquement en fin de dizaine (#N10, #N20…)
    const start = game.number - 9;
    if (start < 1) return null; // pas assez de recul pour la toute première dizaine
    const games = (ctx && ctx.games) || new Map();
    const lead = Math.max(1, Math.min(20, parseInt(cfg && cfg.lead, 10) || 4));
    const counts = { '♦️': 0, '❤️': 0, '♣️': 0, '♠️': 0 };
    let readable = 0;
    for (let n = start; n <= game.number; n++) {
      const g = games.get(n);
      if (!g || !g.finished) continue;
      const suits = new Set(suitsOf(g.playerSuits)); // comptage "vote" : un costume ne compte qu'UNE fois par main, même s'il apparaît sur 2 cartes (ex. ♦️♦️❤️ → 1♦️ + 1❤️)
      if (!suits.size) continue;
      readable += 1;
      for (const s of suits) if (counts[s] !== undefined) counts[s] += 1;
    }
    if (readable < 6) return null; // dizaine trop peu lisible : comptage jugé pas assez fiable
    let weak = null;
    for (const s of SUITS) {
      if (!weak || counts[s] < counts[weak]) weak = s;
    }
    const detail = SUITS.map((s) => `${s}:${counts[s]}`).join(' ');
    return {
      kind: 'suit',
      target: game.number + lead,
      suit: weak,
      label: weak,
      trigger: game.number,
      reason:
        `Dizaine #N${start} à #N${game.number} (${readable}/10 jeux lisibles) — ` +
        `comptage main JOUEUR ${detail} → costume le plus rare : ${weak} → ` +
        `prédiction sur #N${game.number + lead} (+${lead})`,
      meta: { start, end: game.number, readable, counts, lead },
    };
  },
};

// ---------------------------------------------------------------------------
// 10) Costume faible sur 2 cartes (miroir) — demande admin
// ---------------------------------------------------------------------------
// Filtre obligatoire : joueur 2 cartes ET banquier 2 cartes (mains « naturelles »,
// sans 3ᵉ carte). On regroupe les 4 costumes de ces 4 cartes par COULEUR
// (rouge : ❤️+♦️ / noir : ♠️+♣️) et on repère la couleur MINORITAIRE. Le
// costume faible est celui de cette couleur minoritaire qui est réellement
// apparu (le plus souvent si les deux costumes de cette couleur sont
// présents) — ex. joueur ❤️❤️, banquier ♣️♦️ → rouge 3 (❤️❤️♦️), noir 1 (♣️)
// → couleur faible = noir → costume faible = ♣️ (seul costume noir présent).
// On prédit alors le MIROIR (même couleur) de ce costume faible — ici ♠️,
// miroir de ♣️ — sur la main du JOUEUR au tour +2 (réglable).
function weakSuitOf(fourSuits) {
  const count = { '♦️': 0, '❤️': 0, '♣️': 0, '♠️': 0 };
  for (const s of fourSuits) if (count[s] != null) count[s] += 1;
  const red = count['❤️'] + count['♦️'];
  const black = count['♠️'] + count['♣️'];
  if (red === black) return { count, red, black, weak: null, reason: `rouge ${red} / noir ${black} : égalité, aucun signal` };
  const [a, b] = red < black ? ['❤️', '♦️'] : ['♠️', '♣️'];
  let weak;
  if (count[a] > count[b]) weak = a;
  else if (count[b] > count[a]) weak = b;
  else weak = fourSuits.find((s) => s === a || s === b) || null; // égalité au sein de la couleur faible : on garde le 1er apparu
  return { count, red, black, weak, reason: `rouge ${red} / noir ${black} → costume faible : ${weak}` };
}

const costumeFaible = {
  key: 'costumeFaible',
  name: 'Costume faible sur 2 cartes (miroir)',
  about:
    "Filtre obligatoire : joueur 2 cartes ET banquier 2 cartes (mains " +
    "naturelles, sans 3ᵉ carte). On regroupe les 4 costumes des 4 cartes par " +
    "couleur (rouge ❤️+♦️ / noir ♠️+♣️) et on retient la couleur MINORITAIRE. " +
    "Le costume faible est celui, parmi les 2 costumes de cette couleur, qui " +
    "est réellement apparu (le plus présent en cas des 2). On prédit ensuite " +
    "le MIROIR de ce costume faible (❤️↔♦️, ♠️↔♣️) sur la main du JOUEUR au " +
    "tour +2 (réglable) — ex. joueur ❤️❤️ / banquier ♣️♦️ → rouge 3, noir 1 " +
    "→ costume faible ♣️ → prédiction ♠️. Aucune prédiction si les 2 couleurs " +
    "sont à égalité.",
  defaults: {
    enabled: true,
    format: config.DEFAULT_FORMAT,
    maxR: config.DEFAULT_MAX_R,
    b: 0,
    lead: 2,
    template: null,
    channels: [],
  },
  usesB: false,
  source: 'finished',
  detect(game, cfg, ctx) {
    if (!game || !game.finished) return null;
    if (game.playerCards !== 2 || game.bankerCards !== 2) return null; // filtre obligatoire : mains naturelles des 2 côtés
    const four = [...suitsOf(game.playerSuits), ...suitsOf(game.bankerSuits)];
    if (four.length !== 4) return null;
    const { weak, reason } = weakSuitOf(four);
    if (!weak) return null;
    const suit = MIRROR[weak];
    if (!suit) return null;
    const lead = Math.max(1, Math.min(20, parseInt(cfg && cfg.lead, 10) || 2));
    return {
      kind: 'suit',
      target: game.number + lead,
      suit,
      label: suit,
      trigger: game.number,
      reason:
        `Jeu #N${game.number} — joueur ${four.slice(0, 2).join('')} / banquier ${four.slice(2).join('')} — ` +
        `${reason} → miroir : ${suit} → prédiction sur #N${game.number + lead} (+${lead})`,
      meta: { fourSuits: four, weak, lead },
    };
  },
};

// ---------------------------------------------------------------------------
// 11) Collecte IA — relais des meilleures stratégies existantes (demande admin)
// ---------------------------------------------------------------------------
// Ne détecte RIEN par elle-même : à chaque jeu terminé, elle regarde si une
// AUTRE stratégie vient d'émettre une prédiction sur ce même jeu déclencheur
// (voir ctx.predictions, injecté par predictor.js/evaluate() — cette
// stratégie DOIT rester la DERNIÈRE de LIST pour que toutes les autres aient
// déjà pu être évaluées sur ce même jeu avant elle, voir evaluate()). Si
// cette stratégie source a actuellement un CONSEIL DE FORMATION établi
// (formation.js : un « conseil » — combien de prédictions rejouer d'affilée
// après une perte/rattrapage — a pu être dégagé avec un échantillon
// suffisant), la Collecte copie EXACTEMENT la même prédiction
// (costume/carte/parité, MÊME JEU CIBLE — donc le même décalage a+n que la
// source a elle-même déjà calculé, quel qu'il soit : a+1, a+3, a+n…) sous
// son propre nom, avec son propre canal. IMPORTANT : ni le taux de réussite
// des stratégies existantes, ni celui de l'Avis IA (strategy-advisor.js),
// n'entrent en jeu ici — seul compte le conseil de formation APPLIQUÉ. S'il
// y a plusieurs sources avec un conseil établi sur le même jeu déclencheur,
// celle dont la formation est la plus établie (série conseillée la plus
// longue, puis à égalité l'échantillon le plus large — ctx.formationInfo,
// voir predictor.js) est retenue, jamais celle qui affiche le meilleur %.
// Le nombre de RATTRAPAGES envoyés avec la prédiction relayée n'est pas non
// plus un réglage indépendant de la Collecte : il suit exactement le N que
// la Formation a établi pour la stratégie source (formationInfo.length —
// combien de prédictions il faut rejouer d'affilée après une perte/
// rattrapage pour cette stratégie), voir hit.maxR ci-dessous et predictor.js.
const collecte = {
  key: 'collecte',
  name: 'Collecte IA — meilleures stratégies',
  about:
    "Ne détecte rien par elle-même : elle surveille en continu le conseil " +
    "de Formation (formation.js) des autres stratégies — combien de " +
    "prédictions rejouer d'affilée après une perte/rattrapage. Dès qu'une " +
    "stratégie a un conseil de formation ÉTABLI et APPLIQUÉ, la Collecte " +
    "copie EXACTEMENT sa prédiction (costume, carte, ou parité selon le cas " +
    "— même jeu cible, donc le MÊME décalage a+n déjà calculé par la " +
    "source) sous son propre nom. Le nombre de rattrapages envoyés suit " +
    "aussi le conseil de Formation de la source (le N établi), jamais un " +
    "réglage indépendant. S'il y a plusieurs sources avec un conseil établi " +
    "sur le même jeu déclencheur, la formation la plus établie (série la " +
    "plus longue, puis échantillon le plus large) est retenue — jamais un " +
    "taux de réussite, ni celui des stratégies existantes ni celui de " +
    "l'Avis IA. La stratégie « Carte disparue → retour banquier » et la " +
    "stratégie « Pair/Impair » ne sont JAMAIS relayées : la Collecte ne " +
    "prédit et ne vérifie QUE des costumes ('suit') pour le joueur, jamais " +
    "le banquier (suit-banquier), une parité (parity) ou un nombre de " +
    "cartes (cards). Deux prédictions de la Collecte ne peuvent jamais " +
    "tomber à moins de 3 jeux d'écart l'une de l'autre. Pas de réglage de " +
    "costume ou d'absence ici : seuls le format et le canal de diffusion " +
    "se règlent, comme le reste hérite directement de la stratégie source.",
  defaults: {
    enabled: true,
    format: config.DEFAULT_FORMAT,
    maxR: config.DEFAULT_MAX_R,
    b: 0,
    template: null,
    channels: [],
  },
  usesB: false,
  source: 'finished',
  detect(game, cfg, ctx) {
    if (!game || !game.finished) return null;
    const predictions = (ctx && ctx.predictions) || [];
    const bestKeys = (ctx && ctx.bestKeys) || new Set();
    if (!bestKeys.size) return null; // aucune stratégie jugée fiable pour l'instant : rien à relayer
    const candidates = predictions.filter(
      (p) => p.strategy !== 'collecte'
        // la Collecte ne prédit et ne vérifie QUE des COSTUMES pour le
        // JOUEUR (kind 'suit') : ça exclut automatiquement, quel que soit
        // leur taux ou leur formation établie —
        //  • « Carte disparue → retour banquier » (kind 'suit-banquier',
        //    ancien format 'carte-banquier') : prédit/vérifie le banquier ;
        //  • « Pair/Impair » (parite, kind 'parity') : ne prédit pas un
        //    costume, mais la parité de la somme ;
        //  • « Match nul » (matchnul, kind 'cards') : prédit un nombre de
        //    cartes, pas un costume.
        && p.kind === 'suit'
        && p.trigger === game.number
        && bestKeys.has(p.strategy),
    );
    if (!candidates.length) return null;
    // Départage par la FORMATION (conseil établi), jamais par un taux : on
    // garde la série conseillée la plus longue, et à égalité l'échantillon
    // (support) le plus large. bestRates n'est conservé que pour l'afficher
    // à titre informatif dans le message ci-dessous.
    const formationInfo = (ctx && ctx.formationInfo) || {};
    const bestRates = (ctx && ctx.bestRates) || {};
    let source = candidates[0];
    for (const c of candidates) {
      const cur = formationInfo[c.strategy] || { length: 0, support: 0 };
      const best = formationInfo[source.strategy] || { length: 0, support: 0 };
      if (cur.length > best.length || (cur.length === best.length && cur.support > best.support)) source = c;
    }
    const srcFormation = formationInfo[source.strategy];
    // Le nombre de rattrapages de LA prédiction relayée suit le N établi par
    // la Formation pour la stratégie source (srcFormation.length) — jamais
    // le réglage maxR indépendant de la Collecte. Repli sur cfg.maxR
    // uniquement si, cas limite, aucune longueur de formation n'est connue
    // pour cette source (ne devrait pas arriver : bestKeys exige déjà un
    // conseil de formation établi pour entrer dans les candidats).
    const maxR = srcFormation && srcFormation.length > 0 ? srcFormation.length : cfg.maxR;

    // écart minimum de 3 jeux entre deux prédictions Collecte : si le jeu
    // cible retenu tombe à moins de 3 jeux de la dernière prédiction déjà
    // relayée par la Collecte (quelle que soit sa source ou son statut),
    // on ne relaie pas cette occurrence — même si la source elle-même a un
    // conseil de formation établi.
    const lastTarget = predictions
      .filter((p) => p.strategy === 'collecte')
      .reduce((max, p) => (max == null || p.target > max ? p.target : max), null);
    if (lastTarget != null && Math.abs(source.target - lastTarget) < 3) return null;

    return {
      kind: source.kind,
      target: source.target,
      suit: source.suit || null,
      card: source.card || null,
      cardsLabel: source.cardsLabel || null,
      wantPlayer: source.wantPlayer != null ? source.wantPlayer : null,
      wantBanker: source.wantBanker != null ? source.wantBanker : null,
      label: source.label || source.suit || source.card || '',
      trigger: game.number,
      maxR,
      reason:
        `Relais de « ${source.strategyName || source.strategy} » (conseil de formation appliqué` +
        `${srcFormation ? ` : ${srcFormation.length} validation(s) d'affilée conseillée(s) sur ${srcFormation.support} observation(s) → ${maxR} rattrapage(s) suivi(s)` : ''}` +
        `${bestRates[source.strategy] != null ? `, ${bestRates[source.strategy]}% à titre indicatif` : ''}) — ` +
        `même prédiction copiée (même décalage a+n que la source) : ${source.reason || ''}`,
      meta: { sourceStrategy: source.strategy, sourceRef: source.id || null },
    };
  },
};

const LIST = [costume, dominant, matchnul, parite, absente, carteBanquier, ombre, ombreJoueur, dizaine, costumeFaible, collecte];
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
    // --- Ajustement automatique par l'IA (commun à TOUTES les stratégies) ---
    // Désactivé par défaut : la stratégie prédit alors normalement, selon sa
    // seule logique (voir strategies.js). Si activé, et UNIQUEMENT pour les
    // stratégies qui prédisent un COSTUME (kind 'suit' / 'suit-banquier'),
    // predictor.js compare — au moment de chaque nouvelle prédiction — le
    // taux de réussite récent du costume que la stratégie s'apprête à jouer
    // avec celui des 3 autres costumes pour CETTE MÊME stratégie. Si un autre
    // costume affiche un net avantage (échantillon et écart suffisants), il
    // est substitué automatiquement (voir aiSuitOverride() dans predictor.js).
    // Sans quoi (bouton désactivé, ou stratégie sans costume comme « Match nul »
    // ou « Pair/Impair »), rien ne change : comportement normal.
    aiAuto: false,
    // message de perte + formation VIP (voir loss-notice.js) — CASE PAR
    // STRATÉGIE, désactivée par défaut (demande admin) : rien n'est envoyé
    // pour une stratégie tant que l'admin ne l'a pas explicitement activée
    // ici, même si le réglage général (Système → Message de perte) est
    // activé — les deux doivent être vrais à la fois (voir bot.js —
    // updateResult).
    lossNoticeEnabled: false,
    ...JSON.parse(JSON.stringify(s.defaults)),
  };
}

function catalog() {
  return LIST.map((s) => ({ key: s.key, name: s.name, about: s.about, usesB: !!s.usesB, defaults: s.defaults }));
}

module.exports = {
  LIST, BY_KEY, SUITS, INVERSE, MIRROR, normSuit, suitsOf, suitForNumber, dominantOf, defaultsFor, catalog,
  normParity, triggerAt, triggerIndexOf, lastTriggerAtOrBefore, nextTriggerAfter, triggerSequence, varCounterAt,
};
