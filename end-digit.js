// end-digit.js — « Analyse fin de numéro » (bouton de l'accueil).
//
// Pour CHAQUE fin de numéro de jeu (chiffre 0 à 9 : le jeu #1223 finit par 3), analyse quel costume arrive le plus
// souvent dans la main du JOUEUR et dans celle du BANQUIER, puis propose le meilleur costume de chaque chiffre.
// « Arrive » = le costume apparaît au moins une fois dans la main du jeu (c'est ce que vérifient les prédictions).
//
// Source : l'historique des jeux terminés en base de données (plusieurs sabots) quand elle est connectée, complété par
// les jeux du sabot en cours ; sans base, seul le sabot en cours est analysé (l'échantillon est alors petit).
'use strict';

const db = require('./db');
const { state } = require('./predictor');
const { normSuit } = require('./strategies');

const SUITS = ['♠️', '❤️', '♦️', '♣️'];
const MAX_WINDOW = 20000;
const GOOD_N = 30; // échantillon à partir duquel une proposition est jugée fiable

const suitsOfList = (list) => {
  const set = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) { const s = normSuit(raw); if (s) set.add(s); }
  return set;
};

// jeux terminés connus : { number, player: Set, banker: Set }, du plus récent au plus ancien
async function loadGames(windowN) {
  const byNumber = new Map();
  let source = 'sabot en cours';
  if (db.ready) {
    try {
      const rows = await db.rows('SELECT number, player_suits, banker_suits FROM games ORDER BY played_on DESC, number DESC LIMIT $1', [windowN]);
      for (const r of rows) {
        const n = Number(r.number);
        if (!Number.isFinite(n)) continue;
        byNumber.set(n, { number: n, player: suitsOfList(r.player_suits), banker: suitsOfList(r.banker_suits) });
      }
      if (rows.length) source = 'base de données';
    } catch (_) { /* repli sur le sabot en cours */ }
  }
  for (const g of state.games.values()) { // le sabot en cours prime (données les plus fraîches)
    if (!g.finished || g.complete === false || !(Number(g.playerCards) > 0)) continue;
    byNumber.set(g.number, { number: g.number, player: suitsOfList(g.playerSuits), banker: suitsOfList(g.bankerSuits) });
  }
  const list = [...byNumber.values()];
  return { list, source };
}

const emptyCounts = () => ({ '♠️': 0, '❤️': 0, '♦️': 0, '♣️': 0 });
const pc = (c, n) => (n ? Math.round((1000 * c) / n) / 10 : 0);

function rankSide(counts, n, overall, overallN) {
  const ranked = SUITS.map((s) => ({ suit: s, count: counts[s], pct: pc(counts[s], n), base: pc(overall[s], overallN) }))
    .sort((a, b) => b.pct - a.pct || SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit));
  const best = ranked[0];
  return { ranked, best: n ? { ...best, edge: Math.round((best.pct - best.base) * 10) / 10 } : null };
}

async function analyze(windowN = 5000) {
  const w = Math.max(50, Math.min(MAX_WINDOW, parseInt(windowN, 10) || 5000));
  const { list, source } = await loadGames(w);
  list.sort((a, b) => b.number - a.number);
  const used = list.slice(0, w);
  const per = Array.from({ length: 10 }, () => ({ n: 0, player: emptyCounts(), banker: emptyCounts() }));
  const overall = { n: used.length, player: emptyCounts(), banker: emptyCounts() };
  for (const g of used) {
    const d = g.number % 10;
    per[d].n += 1;
    for (const s of g.player) { per[d].player[s] += 1; overall.player[s] += 1; }
    for (const s of g.banker) { per[d].banker[s] += 1; overall.banker[s] += 1; }
  }
  const digits = per.map((x, d) => ({
    digit: d, n: x.n, reliable: x.n >= GOOD_N,
    player: rankSide(x.player, x.n, overall.player, overall.n),
    banker: rankSide(x.banker, x.n, overall.banker, overall.n),
  }));
  // prochain jeu à venir : numéro connu le plus haut + 1
  const maxNum = Math.max(0, ...[...state.games.values()].map((g) => Number(g.number) || 0), state.live ? Number(state.live.number) || 0 : 0);
  const nextNumber = maxNum + 1;
  const nd = digits[nextNumber % 10];
  return {
    source, games: used.length, window: w,
    digits,
    next: { number: nextNumber, digit: nextNumber % 10, n: nd.n, player: nd.player.best, banker: nd.banker.best },
    overall: { n: overall.n, player: SUITS.map((s) => ({ suit: s, pct: pc(overall.player[s], overall.n) })), banker: SUITS.map((s) => ({ suit: s, pct: pc(overall.banker[s], overall.n) })) },
    goodN: GOOD_N,
  };
}

module.exports = { analyze, SUITS };
