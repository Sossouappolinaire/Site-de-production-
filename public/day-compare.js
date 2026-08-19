// day-compare.js — comparaison des statistiques des JOURS ANTÉRIEURS et
// d'AUJOURD'HUI pour créer des stratégies solides.
//
//  • On calcule les statistiques de chaque journée (vainqueurs, costumes,
//    points, parité).
//  • On mesure, jour par jour, les règles « costume X au jeu a → costume Y au
//    jeu a+k ».
//  • Une règle n'est proposée en stratégie que si elle tient AUJOURD'HUI **et**
//    les jours précédents : c'est une régularité stable, pas un hasard du jour.
'use strict';

const miner = require('./pattern-miner');

const SUITS = ['♦️', '❤️', '♣️', '♠️'];
const OFFSETS = [1, 2, 3];
const MIN_SUPPORT_DAY = 4;
const MIN_RATE = 70;

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function frenchDate(iso) {
  const s = String(iso || '').slice(0, 10);
  const [y, m, d] = s.split('-');
  return d ? `${d}/${m}/${y}` : s;
}

function hasSuit(game, suit) {
  return (game.playerSuits || []).includes(suit);
}

// statistiques lisibles d'une journée
function dayStats(rawGames, date = null) {
  const games = miner.normalize(rawGames || []);
  const total = games.length;
  const winners = { Joueur: 0, Banquier: 0, 'Égalité': 0 };
  const suits = {};
  let pair = 0;
  let sumPoints = 0;
  let counted = 0;
  for (const g of games) {
    if (g.winner && winners[g.winner] !== undefined) winners[g.winner] += 1;
    for (const s of SUITS) if (hasSuit(g, s)) suits[s] = (suits[s] || 0) + 1;
    if (g.playerValue != null) {
      counted += 1;
      sumPoints += Number(g.playerValue);
      if (Number(g.playerValue) % 2 === 0) pair += 1;
    }
  }
  return {
    date,
    label: date ? frenchDate(date) : "aujourd'hui",
    total,
    winners: {
      joueur: pct(winners.Joueur, total),
      banquier: pct(winners.Banquier, total),
      egalite: pct(winners['Égalité'], total),
    },
    suits: SUITS.map((s) => ({ suit: s, count: suits[s] || 0, rate: pct(suits[s] || 0, total) })),
    parity: { pair: pct(pair, counted), impair: pct(counted - pair, counted) },
    averagePoint: counted ? Math.round((sumPoints / counted) * 10) / 10 : 0,
  };
}

// toutes les règles « costume X → costume Y au jeu a+k » d'une journée
function dayRules(rawGames) {
  const games = miner.normalize(rawGames || []);
  const out = new Map();
  for (const from of SUITS) {
    for (const k of OFFSETS) {
      let support = 0;
      const hits = {};
      for (let i = 0; i < games.length - k; i += 1) {
        if (!hasSuit(games[i], from)) continue;
        const target = games[i + k];
        if (!target) continue;
        support += 1;
        for (const to of SUITS) if (hasSuit(target, to)) hits[to] = (hits[to] || 0) + 1;
      }
      if (support < MIN_SUPPORT_DAY) continue;
      for (const to of SUITS) {
        out.set(`${from}|${k}|${to}`, { from, k, to, support, hits: hits[to] || 0, rate: pct(hits[to] || 0, support) });
      }
    }
  }
  return out;
}

/**
 * compare — statistiques d'aujourd'hui vs jours antérieurs + stratégies créées.
 * @param {Array} todayGames jeux du jour
 * @param {Array} pastDays [{ date, games }]
 */
function compare(todayGames = [], pastDays = []) {
  const today = dayStats(todayGames);
  const past = (pastDays || []).map((d) => dayStats(d.games, d.date));
  const todayRules = dayRules(todayGames);
  const pastRules = (pastDays || []).map((d) => ({ date: d.date, rules: dayRules(d.games) }));

  // écarts lisibles entre aujourd'hui et la moyenne des jours antérieurs
  const differences = [];
  if (past.length) {
    const avg = (fn) => Math.round((past.reduce((a, d) => a + fn(d), 0) / past.length) * 10) / 10;
    const cmp = (label, now, before, unit = '%') => {
      const gap = Math.round((now - before) * 10) / 10;
      differences.push({
        label,
        today: now,
        past: before,
        gap,
        text: `${label} : ${now}${unit} aujourd'hui contre ${before}${unit} les jours précédents (${gap >= 0 ? '+' : ''}${gap}${unit}).`,
      });
    };
    cmp('Victoires Joueur', today.winners.joueur, avg((d) => d.winners.joueur));
    cmp('Victoires Banquier', today.winners.banquier, avg((d) => d.winners.banquier));
    cmp('Points pairs (joueur)', today.parity.pair, avg((d) => d.parity.pair));
    for (const s of SUITS) {
      const now = (today.suits.find((x) => x.suit === s) || {}).rate || 0;
      const before = avg((d) => (d.suits.find((x) => x.suit === s) || {}).rate || 0);
      cmp(`Présence ${s}`, now, before);
    }
    cmp('Point moyen du joueur', today.averagePoint, avg((d) => d.averagePoint), ' pts');
  }

  // règles stables : bonnes aujourd'hui ET les jours précédents
  const proposals = [];
  const stable = [];
  for (const [key, rule] of todayRules) {
    if (rule.rate < MIN_RATE) continue;
    const history = [];
    for (const day of pastRules) {
      const r = day.rules.get(key);
      if (r) history.push({ date: day.date, rate: r.rate, support: r.support });
    }
    if (history.length < 1) continue;
    const good = history.filter((h) => h.rate >= MIN_RATE);
    if (good.length < Math.max(1, Math.ceil(history.length / 2))) continue;
    const avgPast = Math.round((history.reduce((a, h) => a + h.rate, 0) / history.length) * 10) / 10;
    const item = {
      key,
      from: rule.from,
      to: rule.to,
      k: rule.k,
      todayRate: rule.rate,
      todaySupport: rule.support,
      pastAverage: avgPast,
      days: history.map((h) => ({ date: frenchDate(h.date), rate: h.rate, support: h.support })),
      score: Math.round((rule.rate + avgPast) / 2),
    };
    stable.push(item);
    proposals.push({
      name: `Jour+Jour : ${rule.from} → ${rule.to} au jeu a+${rule.k}`,
      logic: `Quand ${rule.from} sort côté joueur au jeu a, ${rule.to} revient au jeu a+${rule.k}. La règle tient aujourd'hui (${rule.rate}%) et les jours précédents (${avgPast}% de moyenne).`,
      trigger: `${rule.from} vu côté joueur`,
      target: `costume ${rule.to} sur le jeu a+${rule.k}`,
      suggestedLead: rule.k,
      minimumSample: rule.support,
      evidence: `Aujourd'hui : ${rule.rate}% sur ${rule.support} observations. Jours comparés : ${item.days.map((d) => `${d.date} ${d.rate}%`).join(' · ')}.`,
      risks: "Régularité mesurée sur un nombre limité de journées : à surveiller après chaque perte.",
      compatibleExisting: null,
    });
  }
  stable.sort((a, b) => b.score - a.score);
  proposals.sort((a, b) => (b.minimumSample || 0) - (a.minimumSample || 0));

  const findings = [
    ...differences.map((d) => d.text),
    ...stable.slice(0, 6).map(
      (s) => `Régularité stable : ${s.from} → ${s.to} au jeu a+${s.k} — ${s.todayRate}% aujourd'hui, ${s.pastAverage}% les jours précédents.`,
    ),
  ];

  return {
    today,
    past,
    differences,
    stable: stable.slice(0, 12),
    proposals: proposals.slice(0, 8),
    findings,
    daysCompared: past.length,
    generatedAt: new Date().toISOString(),
    note: past.length ? null : "Aucune journée antérieure enregistrée en base : la comparaison se fera dès qu'une journée précédente sera disponible.",
  };
}

module.exports = { compare, dayStats, dayRules };
