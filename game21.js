// game21.js — lecture des jeux « 21 » (TwentyOne) de 1xbet + moteur d'analyse
// des DÉCLENCHEURS pour les cartes de valeur (A, K, Q, J) et pour les cartes
// de valeur EXACTE (♦️/♠️/❤️/♣️ × A, K, Q, J).
//
// Source : même API que le Baccara (LiveFeed), mais sport 146 « TwentyOne ».
//   • LiveFeed/GetChampsZip?sport=146  → la liste des tables en direct
//   • LiveFeed/GetChampZip?champ=<LI>  → les tours de la table
// Les cartes arrivent dans SC.S sous les clés P1 (joueur) et P2 (croupier)
// au format {"CS":2,"CV":12,"V":3} : CS = costume, CV = rang, V = points.
//
// API VÉRIFIÉE le 07/09/2026 sur https://1xbet.cd/service-api :
//   • GetChampsZip?sport=146&lng=en&country=96 → 200 (les variantes 21 Classics,
//     TwentyOne Game, 21 Dota). Attention : ajouter virtualSports/groupChamps à
//     CET appel renvoie 406, d'où les replis de requêtes plus bas.
//   • GetChampZip?champ=<LI>&lng=en&country=96&groupChamps=true → 200.
//   • Barème réel relevé sur les tours en direct (FS.S1/S2 = somme des V) :
//     6..10 = valeur nominale, J = 2, Q = 3, K = 4, A = 11. Ce n'est PAS le
//     barème du blackjack (où J/Q/K valent 10) — c'est le « 21 » russe.
'use strict';

const config = require('./config');
const ai = require('./ai-analyzer');

const SPORT_ID = 146; // TwentyOne
const SUIT_MAP = { 0: '♠️', 1: '♣️', 2: '♦️', 3: '❤️' };
const RANK_MAP = {
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8',
  9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};
// Barème officiel du « 21 » 1xbet (vérifié : la somme des V d'une main est
// exactement égale au score FS.S1/FS.S2 renvoyé par l'API).
const CARD_POINTS = {
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10,
  11: 2,  // J
  12: 3,  // Q
  13: 4,  // K
  14: 11, // A
  1: 11,  // A (si l'API renvoie 1 au lieu de 14)
};

const VALUE_RANKS = ['A', 'K', 'Q', 'J'];       // les « cartes de valeur »
const SUITS = ['♦️', '♠️', '❤️', '♣️'];          // ordre demandé
const HISTORY_MAX = 400;                        // tours gardés par table

// ---------------------------------------------------------------------------
// VARIANTES : la liste 1xbet du sport 146 mélange le « 21 classique »
// (Classic TwentyOne / 21 Classic) et le « 21 » simple. On les sépare pour que
// chaque analyse porte bien sur la variante annoncée.
// ---------------------------------------------------------------------------
const VARIANTS = {
  classique: { key: 'classique', label: '21 classique' },
  simple: { key: 'simple', label: '21' },
  dota: { key: 'dota', label: '21 Dota' },
};
function classifyTable(name) {
  const n = String(name || '').toLowerCase();
  if (/classi/.test(n)) return 'classique';
  if (/dota/.test(n)) return 'dota';
  return 'simple';
}
function variantLabel(key) {
  return (VARIANTS[key] || VARIANTS.simple).label;
}

const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'content-type': 'application/json',
  'is-srv': 'false',
  'x-app-n': 'BETTING_APP',
  'x-requested-with': 'XMLHttpRequest',
  'x-svc-source': 'BETTING_APP',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// ---------------------------------------------------------------------------
// Lecture bas niveau
// ---------------------------------------------------------------------------
async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function getAny(paths) {
  for (const host of config.API_HOSTS) {
    for (const p of paths) {
      const data = await get(`${host}${p}`);
      if (data && data.Success !== false) return data;
    }
  }
  // repli par proxy public si tous les miroirs directs refusent
  for (const p of paths) {
    for (const proxy of config.PROXIES) {
      const data = await get(proxy(`${config.API_HOSTS[0]}${p}`));
      if (data && data.Success !== false) return data;
    }
  }
  return null;
}

function rankOf(c) {
  const v = [c && c.CV, c && c.V, c && c.R, c && c.Rank, c && c.value].find((x) => x != null);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function suitOf(c) {
  const v = [c && c.CS, c && c.S, c && c.Suit, c && c.suit].find((x) => x != null);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function rankLabel(c) {
  const r = rankOf(c);
  return RANK_MAP[r] || (r != null ? String(r) : '?');
}
function suitLabel(c) {
  return SUIT_MAP[suitOf(c)] || '';
}
function cardLabel(c) {
  return `${rankLabel(c)}${suitLabel(c)}`;
}
// Points d'une carte : on fait CONFIANCE au champ V de l'API quand il est
// présent (c'est lui qui compose le score officiel FS.S1/FS.S2), sinon on
// applique le barème CARD_POINTS.
function cardPoints(c) {
  const v = c && (c.V != null ? c.V : c.value);
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const r = rankOf(c);
  return CARD_POINTS[r] != null ? CARD_POINTS[r] : (Number.isFinite(r) ? r : 0);
}

// Valeur d'une main au « 21 » de 1xbet : simple somme des points. Il n'y a PAS
// de repli de l'As à 1 comme au blackjack — au-delà de 21 la main est brûlée.
function handValue(list) {
  let total = 0;
  for (const c of list || []) total += cardPoints(c);
  return total;
}

function scEntry(scS, key) {
  const e = (scS || []).find((x) => x.Key === key);
  return e ? e.Value : null;
}
function parseHand(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

const STATE_LABEL = {
  0: 'Paris ouverts',
  1: 'Distribution',
  2: 'Tour du joueur',
  3: 'Tour du croupier',
  4: 'Tour terminé',
};

function parseChamp(data, table) {
  const games = data && data.Value && data.Value.G;
  if (!Array.isArray(games)) return [];
  const out = [];
  for (const g of games) {
    const sc = g.SC || {};
    const scS = sc.S || [];
    const player = parseHand(scEntry(scS, 'P1'));
    const dealer = parseHand(scEntry(scS, 'P2'));
    const st = Number(scEntry(scS, 'STATE'));
    const number = parseInt(g.DI, 10);
    const fs = sc.FS || {};
    // L'API renvoie CPS traduit selon lng (« Game finished » / « Jeu terminé »)
    // → on teste les deux langues au lieu du seul libellé anglais.
    const label = `${sc.CPS || ''} ${sc.I || ''}`;
    const finished = !!g.F || st === 4 || /finish|fini|termin/i.test(label);
    const playerValue = player.length ? handValue(player) : (Number.isFinite(Number(fs.S1)) ? Number(fs.S1) : null);
    const dealerValue = dealer.length ? handValue(dealer) : (Number.isFinite(Number(fs.S2)) ? Number(fs.S2) : null);
    let winner = null;
    if (finished && playerValue != null) {
      const pb = playerValue > 21, db = dealerValue != null && dealerValue > 21;
      if (pb && db) winner = 'Égalité';
      else if (pb) winner = 'Croupier';
      else if (db || dealerValue == null) winner = 'Joueur';
      else if (playerValue > dealerValue) winner = 'Joueur';
      else if (playerValue < dealerValue) winner = 'Croupier';
      else winner = 'Égalité';
    }
    out.push({
      id: `${table.id}:${g.I}`,
      tableId: table.id,
      tableName: table.name,
      variant: table.variant || classifyTable(table.name),
      variantLabel: variantLabel(table.variant || classifyTable(table.name)),
      gameId: g.I,
      number: Number.isFinite(number) ? number : null,
      startsAt: g.S ? g.S * 1000 : null,
      player: player.map(cardLabel),
      dealer: dealer.map(cardLabel),
      playerRanks: player.map(rankLabel),
      dealerRanks: dealer.map(rankLabel),
      playerSuits: player.map(suitLabel),
      dealerSuits: dealer.map(suitLabel),
      playerValue,
      dealerValue,
      winner,
      state: Number.isFinite(st) ? st : null,
      phaseLabel: sc.SLS || STATE_LABEL[st] || sc.CPS || sc.I || '',
      finished,
      dealing: player.length > 0 || dealer.length > 0,
      complete: finished && player.length > 0,
      at: Date.now(),
    });
  }
  return out;
}

async function fetchTables() {
  const data = await getAny([
    `/LiveFeed/GetChampsZip?sport=${SPORT_ID}&lng=en&country=96`,
    `/LiveFeed/GetChampsZip?sport=${SPORT_ID}&lng=fr&country=96`,
    `/LiveFeed/GetChampsZip?sport=${SPORT_ID}&lng=fr`,
    `/LiveFeed/GetChampsZip?sport=${SPORT_ID}`,
  ]);
  const list = (data && data.Value) || [];
  const tables = list
    .map((c) => {
      const name = c.L || c.LE || `Table ${c.LI}`;
      const variant = classifyTable(name);
      return { id: Number(c.LI), name, games: Number(c.GC || 0), variant, variantLabel: variantLabel(variant) };
    })
    // Le sport 146 contient aussi « 21 Dota » : un affrontement e-sport SANS
    // cartes (l'API n'y renvoie que des scores de manches, jamais de P1/P2),
    // ce qui polluerait les statistiques de déclencheurs → on l'écarte.
    .filter((t) => Number.isFinite(t.id) && t.id > 0 && t.variant !== 'dota');
  if (!tables.length) throw new Error('API 1xbet « 21 » injoignable');
  return tables;
}

async function fetchTableGames(table) {
  const data = await getAny([
    `/LiveFeed/GetChampZip?champ=${table.id}&lng=en&country=96&groupChamps=true`,
    `/LiveFeed/GetChampZip?champ=${table.id}&lng=fr&country=96&mode=4&getEmpty=true`,
    `/LiveFeed/GetChampZip?champ=${table.id}&lng=fr`,
  ]);
  return data ? parseChamp(data, table) : [];
}

// ---------------------------------------------------------------------------
// Mémoire tournante : l'API ne renvoie que 2-3 tours par table, on accumule
// l'historique pour pouvoir chercher des déclencheurs.
// ---------------------------------------------------------------------------
const state = {
  tables: [],
  live: [],          // tours en cours / à venir
  history: [],       // tours terminés, du plus récent au plus ancien
  updatedAt: 0,
  error: null,
  lastAi: null,      // dernier avis IA
};

const seen = new Map(); // id -> tour terminé

function remember(games) {
  for (const g of games) {
    if (!g.finished || !g.player.length) continue;
    const prev = seen.get(g.id);
    if (!prev || (g.player.length + g.dealer.length) > (prev.player.length + prev.dealer.length)) {
      seen.set(g.id, g);
    }
  }
  const all = [...seen.values()].sort((a, b) => (b.startsAt || b.at) - (a.startsAt || a.at));
  const kept = all.slice(0, HISTORY_MAX);
  seen.clear();
  for (const g of kept) seen.set(g.id, g);
  state.history = kept;
}

async function refresh() {
  try {
    const tables = await fetchTables();
    state.tables = tables;
    const lists = await Promise.all(tables.map((t) => fetchTableGames(t).catch(() => [])));
    const flat = lists.flat();
    remember(flat);
    state.live = flat
      .filter((g) => !g.finished)
      .sort((a, b) => (a.startsAt || 0) - (b.startsAt || 0));
    state.updatedAt = Date.now();
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  return snapshot();
}

let loop = null;
function startLoop(intervalMs = 6000) {
  if (loop) return;
  refresh().catch(() => {});
  loop = setInterval(() => { refresh().catch(() => {}); }, intervalMs);
  if (loop.unref) loop.unref();
}

// ---------------------------------------------------------------------------
// Moteur de déclencheurs
//
// Principe (identique dans l'esprit à ce qui est fait pour le Baccara) :
// pour chaque tour terminé, on regarde la DERNIÈRE carte visible du tour
// (le « déclencheur ») puis on vérifie si le tour SUIVANT contient :
//   • une carte de valeur      (A, K, Q, J — n'importe quel costume)
//   • une carte de valeur EXACTE (ex. ♦️K)
// On garde les déclencheurs les plus fiables (taux le plus élevé).
// ---------------------------------------------------------------------------
function cardsOf(g) {
  return [...(g.player || []), ...(g.dealer || [])];
}
function ranksOf(g) {
  return [...(g.playerRanks || []), ...(g.dealerRanks || [])];
}
function hasValueCard(g) {
  return ranksOf(g).some((r) => VALUE_RANKS.includes(r));
}
function exactCards(g) {
  return cardsOf(g).filter((c) => VALUE_RANKS.includes(c.replace(/[♠️♣️♦️❤️\uFE0F]/g, '')));
}
function triggerOf(g) {
  const list = cardsOf(g);
  return list.length ? list[list.length - 1] : null;
}

function rate(hit, total) {
  return total ? Math.round((hit / total) * 1000) / 10 : 0;
}

function buildTriggers(history, { minSample = 3 } = {}) {
  // history : du plus récent au plus ancien → on remet en ordre chronologique
  const chrono = [...history].reverse();
  const value = new Map();  // déclencheur -> {total, hit}
  const exact = new Map();  // déclencheur -> Map(carteExacte -> hits)
  for (let i = 0; i < chrono.length - 1; i += 1) {
    const trig = triggerOf(chrono[i]);
    if (!trig) continue;
    const next = chrono[i + 1];
    const v = value.get(trig) || { total: 0, hit: 0 };
    v.total += 1;
    if (hasValueCard(next)) v.hit += 1;
    value.set(trig, v);

    const m = exact.get(trig) || new Map();
    for (const c of new Set(exactCards(next))) m.set(c, (m.get(c) || 0) + 1);
    exact.set(trig, m);
  }

  const valueTriggers = [...value.entries()]
    .filter(([, v]) => v.total >= minSample)
    .map(([trigger, v]) => ({ trigger, total: v.total, hit: v.hit, rate: rate(v.hit, v.total) }))
    .sort((a, b) => b.rate - a.rate || b.total - a.total)
    .slice(0, 12);

  const exactTriggers = [];
  for (const [trigger, m] of exact.entries()) {
    const total = (value.get(trigger) || { total: 0 }).total;
    if (total < minSample) continue;
    for (const [card, hit] of m.entries()) {
      exactTriggers.push({ trigger, card, total, hit, rate: rate(hit, total) });
    }
  }
  exactTriggers.sort((a, b) => b.rate - a.rate || b.total - a.total);

  // répartition par costume × rang, utile pour l'affichage
  const grid = SUITS.map((suit) => ({
    suit,
    ranks: VALUE_RANKS.map((rank) => {
      const label = `${rank}${suit}`;
      const count = chrono.reduce((s, g) => s + cardsOf(g).filter((c) => c === label).length, 0);
      return { rank, card: label, count };
    }),
  }));

  const rounds = chrono.length;
  const withValue = chrono.filter(hasValueCard).length;

  return {
    rounds,
    withValue,
    valueRate: rate(withValue, rounds),
    valueTriggers,
    exactTriggers: exactTriggers.slice(0, 24),
    grid,
  };
}

function historyOf(variant) {
  if (!variant || variant === 'tous') return state.history;
  return state.history.filter((g) => (g.variant || 'simple') === variant);
}

function analysis(opts = {}) {
  const a = buildTriggers(historyOf(opts.variant), opts);
  a.variant = opts.variant || 'tous';
  a.variantLabel = opts.variant ? variantLabel(opts.variant) : 'Toutes les variantes';
  return a;
}

// Analyse séparée « 21 classique » vs « 21 » : c'est cette vue qui permet de
// vérifier sur quelle variante porte réellement chaque déclencheur.
function analysisByVariant(opts = {}) {
  return Object.keys(VARIANTS).map((key) => {
    const a = analysis({ ...opts, variant: key });
    return {
      variant: key,
      label: VARIANTS[key].label,
      tables: state.tables.filter((t) => t.variant === key).map((t) => t.name),
      analysis: a,
      prediction: localPrediction(a, key),
    };
  });
}

// Prédiction locale : à partir de la dernière carte connue, ce que les
// déclencheurs annoncent pour le prochain tour.
function localPrediction(a = analysis(), variant = null) {
  const last = historyOf(variant)[0];
  const trig = last ? triggerOf(last) : null;
  if (!trig) return null;
  const v = a.valueTriggers.find((x) => x.trigger === trig);
  const exact = a.exactTriggers.filter((x) => x.trigger === trig).slice(0, 3);
  return {
    trigger: trig,
    fromRound: last.number,
    tableName: last.tableName,
    variant: last.variant || 'simple',
    variantLabel: last.variantLabel || variantLabel(last.variant),
    valueRate: v ? v.rate : null,
    valueSample: v ? v.total : 0,
    exact,
  };
}

// ---------------------------------------------------------------------------
// Avis de l'IA
// ---------------------------------------------------------------------------
function compact(g) {
  return `#${g.number ?? '?'} ${g.tableName} [${g.variantLabel || ''}] | joueur ${g.player.join(' ')} (${g.playerValue}) | croupier ${g.dealer.join(' ')} (${g.dealerValue}) | ${g.winner || '—'}`;
}

async function aiOpinion({ limit = 40, variant = null } = {}) {
  const a = analysis({ variant });
  if (!a.rounds) throw new Error('Aucun tour « 21 » enregistré pour le moment.');
  const local = localPrediction(a, variant);
  const system = [
    `Tu es un analyste du jeu de cartes « ${a.variantLabel} » (TwentyOne) de 1xbet.`,
    'Ne parle que de cette variante : ne mélange jamais le « 21 classique » et le « 21 ».',
    'Tu cherches des DÉCLENCHEURS : une carte observée dans un tour qui annonce,',
    'au tour suivant, une carte de valeur (A, K, Q, J) ou une carte de valeur EXACTE',
    'avec son costume (♦️ ♠️ ❤️ ♣️).',
    'Réponds en français, court et concret : 3 déclencheurs maximum, chacun avec',
    'sa cible (carte de valeur ou carte exacte) et un niveau de confiance en %.',
    "N'invente pas de chiffres : appuie-toi uniquement sur les statistiques fournies.",
  ].join(' ');
  const user = [
    `Tours analysés : ${a.rounds} (dont ${a.withValue} contenant une carte de valeur, ${a.valueRate}%).`,
    '',
    'Déclencheurs → carte de valeur (A,K,Q,J) :',
    ...a.valueTriggers.map((t) => `  ${t.trigger} → ${t.hit}/${t.total} = ${t.rate}%`),
    '',
    'Déclencheurs → carte de valeur EXACTE :',
    ...a.exactTriggers.slice(0, 15).map((t) => `  ${t.trigger} → ${t.card} : ${t.hit}/${t.total} = ${t.rate}%`),
    '',
    'Derniers tours :',
    ...historyOf(variant).slice(0, limit).map(compact),
    '',
    local ? `Dernière carte visible (déclencheur en cours) : ${local.trigger}.` : '',
    'Donne les déclencheurs les plus fiables et ce qu\'il faut attendre au prochain tour.',
  ].join('\n');

  const text = await ai.chat({ system, user, temperature: 0.2, timeoutMs: 25000 });
  state.lastAi = { at: Date.now(), text: String(text || '').trim(), rounds: a.rounds, variant: a.variant, variantLabel: a.variantLabel };
  return state.lastAi;
}

function snapshot({ limit = 30, variant = null } = {}) {
  const a = analysis({ variant });
  return {
    tables: state.tables,
    variants: analysisByVariant(),
    live: variant ? state.live.filter((g) => (g.variant || 'simple') === variant) : state.live,
    games: historyOf(variant).slice(0, limit),
    updatedAt: state.updatedAt,
    error: state.error,
    analysis: a,
    prediction: localPrediction(a, variant),
    ai: state.lastAi,
  };
}

module.exports = {
  SPORT_ID, SUIT_MAP, RANK_MAP, VALUE_RANKS, SUITS,
  VARIANTS, classifyTable, variantLabel, historyOf, analysisByVariant, triggerOf,
  fetchTables, fetchTableGames, parseChamp, handValue, cardPoints, CARD_POINTS, cardLabel,
  refresh, startLoop, snapshot, analysis, localPrediction, aiOpinion, state,
};
