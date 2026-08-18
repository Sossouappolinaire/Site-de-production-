// pattern-miner.js — découverte de NOUVELLES stratégies (au-delà des stratégies existantes)
//
// Le moteur observe les jeux terminés et cherche lui-même des régularités que
// personne ne lui a apprises :
//   1) « quand le joueur (ou le banquier) a eu 6❤️ au jeu a, ♣️ arrive au jeu a+2 »
//   2) « le costume X est presque toujours suivi du costume Y »
//   3) « quand le point du joueur vaut 8, le costume ♠️ revient 2 jeux plus tard »
//   4) « la séquence J-J-B est suivie de B dans 82% des cas »
//   5) « le jeu d'aujourd'hui ressemble à celui du 20/08/2026 » (répétition de journée)
//   6) remplacement de costume conseillé pour une stratégie EXISTANTE
//      (« quand le déclencheur est vu, remplace ♦️ par ♣️ — d'après mes analyses »)
'use strict';

const SUITS = ['♦️', '❤️', '♣️', '♠️'];
const MAX_OFFSET = 3;          // on regarde a+1, a+2, a+3
const MIN_SUPPORT = 4;         // nombre minimum d'observations
const MIN_RATE = 75;           // % minimum pour parler d'une régularité

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

// "6❤️" / "A♠️" -> { rank:'6', suit:'❤️', token:'6❤️' }
function parseCard(card) {
  const text = String(card || '').trim();
  const suit = SUITS.find((s) => text.includes(s.charAt(0)) && text.includes(s));
  if (!suit) return null;
  const rank = text.replace(suit, '').replace(/\uFE0F/g, '').trim() || '?';
  return { rank, suit, token: `${rank}${suit}` };
}

// CORRECTIF : une colonne DATE renvoyée par PostgreSQL est un objet JS
// `Date` (minuit UTC), pas une chaîne « AAAA-MM-JJ » — `String(dateObj)`
// donne un format non-ISO (« Wed Apr 01 2026 00:00:00 GMT... ») que
// `.slice(0, 10)` coupe n'importe où. Même correctif que fmtDate() (bot.js)
// et isoDate() (ai-auto.js).
function isoDate(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function normalize(rawGames = []) {
  return rawGames
    .map((g) => ({
      n: Number(g.number ?? g.n),
      date: g.played_on ? isoDate(g.played_on) : g.date || null,
      playerCards: (g.player || g.player_cards || []).map(String),
      bankerCards: (g.banker || g.banker_cards || []).map(String),
      playerSuits: (g.playerSuits || g.player_suits || []).map(String),
      bankerSuits: (g.bankerSuits || g.banker_suits || []).map(String),
      playerValue: g.playerValue ?? g.player_value ?? null,
      bankerValue: g.bankerValue ?? g.banker_value ?? null,
      winner: g.winner || null,
    }))
    .filter((g) => Number.isFinite(g.n))
    .sort((a, b) => a.n - b.n); // ordre chronologique croissant
}

function hasSuit(game, suit, hand = 'joueur') {
  const list = hand === 'banquier' ? game.bankerSuits : game.playerSuits;
  return (list || []).includes(suit);
}

// ---------------------------------------------------------------------------
// 1) Carte précise (rang + costume) observée au jeu a → costume au jeu a+k
// ---------------------------------------------------------------------------
function mineCardRules(games) {
  const buckets = new Map(); // clé -> { support, hits:{suit:count}, hand, token, k }
  for (let i = 0; i < games.length; i += 1) {
    const g = games[i];
    for (const hand of ['joueur', 'banquier']) {
      const cards = hand === 'joueur' ? g.playerCards : g.bankerCards;
      const tokens = new Set();
      for (const card of cards) {
        const parsed = parseCard(card);
        if (parsed) tokens.add(parsed.token);
      }
      for (const token of tokens) {
        for (let k = 1; k <= MAX_OFFSET; k += 1) {
          const target = games[i + k];
          if (!target) continue;
          const key = `${hand}|${token}|${k}`;
          if (!buckets.has(key)) buckets.set(key, { hand, token, k, support: 0, hits: {} });
          const b = buckets.get(key);
          b.support += 1;
          for (const suit of SUITS) {
            if (hasSuit(target, suit, 'joueur')) b.hits[suit] = (b.hits[suit] || 0) + 1;
          }
        }
      }
    }
  }
  return rankBuckets(buckets, (b, suit, rate) => ({
    kind: 'carte',
    finding: `Quand le ${b.hand} a ${b.token} au jeu a, ${suit} apparaît dans la main du joueur au jeu a+${b.k} : ${rate}% (${b.hits[suit]}/${b.support}).`,
    proposal: {
      name: `${b.token} (${b.hand}) → ${suit} au jeu a+${b.k}`,
      logic: `Dès que ${b.token} est vu dans la main du ${b.hand} au jeu a, prédire ${suit} sur le jeu a+${b.k} (main du joueur).`,
      trigger: `${b.token} présent dans la main du ${b.hand}`,
      target: `jeu a+${b.k}`,
      suggestedLead: b.k,
      minimumSample: 20,
      evidence: `${b.hits[suit]} confirmations sur ${b.support} observations (${rate}%).`,
      risks: "Régularité observée sur un échantillon court : à laisser tourner en mode silencieux avant publication.",
      compatibleExisting: 'costume',
    },
  }));
}

// ---------------------------------------------------------------------------
// 2) Point du joueur au jeu a → costume au jeu a+k
// ---------------------------------------------------------------------------
function mineValueRules(games) {
  const buckets = new Map();
  for (let i = 0; i < games.length; i += 1) {
    const value = games[i].playerValue;
    if (value == null) continue;
    for (let k = 1; k <= MAX_OFFSET; k += 1) {
      const target = games[i + k];
      if (!target) continue;
      const key = `point|${value}|${k}`;
      if (!buckets.has(key)) buckets.set(key, { hand: 'joueur', token: `point ${value}`, value, k, support: 0, hits: {} });
      const b = buckets.get(key);
      b.support += 1;
      for (const suit of SUITS) if (hasSuit(target, suit, 'joueur')) b.hits[suit] = (b.hits[suit] || 0) + 1;
    }
  }
  return rankBuckets(buckets, (b, suit, rate) => ({
    kind: 'point',
    finding: `Quand le joueur totalise ${b.value} points au jeu a, ${suit} revient au jeu a+${b.k} dans ${rate}% des cas (${b.hits[suit]}/${b.support}).`,
    proposal: {
      name: `Point ${b.value} → ${suit} au jeu a+${b.k}`,
      logic: `Quand le point du joueur vaut ${b.value} au jeu a, prédire ${suit} sur le jeu a+${b.k}.`,
      trigger: `point joueur = ${b.value}`,
      target: `jeu a+${b.k}`,
      suggestedLead: b.k,
      minimumSample: 20,
      evidence: `${b.hits[suit]} confirmations sur ${b.support} observations (${rate}%).`,
      risks: 'Le point du joueur dépend du tirage : contrôler la règle sur les 20 prochains jeux.',
      compatibleExisting: 'costume',
    },
  }));
}

// ---------------------------------------------------------------------------
// 3) Enchaînement de costumes : ♦️ au jeu a → ♣️ au jeu a+1
// ---------------------------------------------------------------------------
function mineSuitChains(games) {
  const buckets = new Map();
  for (let i = 0; i < games.length; i += 1) {
    for (const suit of SUITS) {
      if (!hasSuit(games[i], suit)) continue;
      for (let k = 1; k <= 2; k += 1) {
        const target = games[i + k];
        if (!target) continue;
        const key = `chaine|${suit}|${k}`;
        if (!buckets.has(key)) buckets.set(key, { hand: 'joueur', token: suit, k, support: 0, hits: {} });
        const b = buckets.get(key);
        b.support += 1;
        for (const s of SUITS) if (hasSuit(target, s)) b.hits[s] = (b.hits[s] || 0) + 1;
      }
    }
  }
  return rankBuckets(buckets, (b, suit, rate) => ({
    kind: 'chaine',
    finding: `${b.token} dans la main du joueur est suivi de ${suit} au jeu a+${b.k} : ${rate}% (${b.hits[suit]}/${b.support}).`,
    proposal: {
      name: `Chaîne ${b.token} → ${suit} (a+${b.k})`,
      logic: `Après ${b.token} côté joueur, prédire ${suit} au jeu a+${b.k}.`,
      trigger: `${b.token} vu côté joueur`,
      target: `jeu a+${b.k}`,
      suggestedLead: b.k,
      minimumSample: 25,
      evidence: `${b.hits[suit]} confirmations sur ${b.support} observations.`,
      risks: 'Un enchaînement de costumes peut se casser sans prévenir : garder les rattrapages.',
      compatibleExisting: 'costume',
    },
  }), 88); // exigence plus haute : ces enchaînements sont fréquents
}

function rankBuckets(buckets, build, minRate = MIN_RATE) {
  const out = [];
  for (const b of buckets.values()) {
    if (b.support < MIN_SUPPORT) continue;
    for (const suit of SUITS) {
      const hits = b.hits[suit] || 0;
      const rate = pct(hits, b.support);
      if (rate < minRate) continue;
      const built = build(b, suit, rate);
      if (built.proposal) { built.proposal.rate = rate; built.proposal.support = b.support; }
      const rule = { kind: built.kind, hand: b.hand || 'joueur', token: b.token, value: b.value != null ? b.value : null, k: b.k, suit };
      out.push({ score: rate * Math.log2(b.support + 1), rate, support: b.support, hits: b.hits[suit] || 0, suit, rule, ...built });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// 4) Séquences de vainqueurs : J-J-B → ?
// ---------------------------------------------------------------------------
function letter(winner) {
  if (winner === 'Joueur') return 'J';
  if (winner === 'Banquier') return 'B';
  if (winner === 'Égalité') return 'E';
  return null;
}

function mineWinnerSequences(games) {
  const seq = games.map((g) => letter(g.winner));
  const buckets = new Map();
  for (let i = 0; i + 3 < seq.length; i += 1) {
    const pattern = seq.slice(i, i + 3);
    const next = seq[i + 3];
    if (pattern.some((x) => !x) || !next) continue;
    const key = pattern.join('');
    if (!buckets.has(key)) buckets.set(key, { support: 0, hits: {} });
    const b = buckets.get(key);
    b.support += 1;
    b.hits[next] = (b.hits[next] || 0) + 1;
  }
  const out = [];
  const label = { J: 'Joueur', B: 'Banquier', E: 'Égalité' };
  for (const [pattern, b] of buckets) {
    if (b.support < 5) continue;
    for (const [next, hits] of Object.entries(b.hits)) {
      const rate = pct(hits, b.support);
      if (rate < 75) continue;
      out.push({
        score: rate * Math.log2(b.support + 1),
        kind: 'sequence',
        rate,
        finding: `La séquence ${pattern.split('').map((c) => label[c]).join(' → ')} est suivie de « ${label[next]} » dans ${rate}% des cas (${hits}/${b.support}).`,
        proposal: {
          name: `Séquence ${pattern} → ${label[next]}`,
          logic: `Après la séquence de vainqueurs ${pattern}, prédire ${label[next]} au jeu suivant.`,
          trigger: `trois derniers vainqueurs = ${pattern}`,
          target: 'jeu suivant',
          suggestedLead: 1,
          minimumSample: 25,
          rate,
          support: b.support,
          evidence: `${hits} confirmations sur ${b.support} séquences observées.`,
          risks: 'Les séquences courtes se retournent : vérifier sur un second échantillon.',
          compatibleExisting: null,
        },
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// 5) Répétition de journée : « le jeu du 20/08/2026 revient aujourd'hui »
// ---------------------------------------------------------------------------
function signatureOf(games) {
  return games.map((g) => letter(g.winner)).filter(Boolean).join('');
}

function longestCommonRun(a, b) {
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

function frenchDate(iso) {
  const s = String(iso || '').slice(0, 10);
  const [y, m, d] = s.split('-');
  return d ? `${d}/${m}/${y}` : s;
}

// todayGames : jeux du jour ; pastDays : [{ date, games }]
function compareDays(todayGames, pastDays = []) {
  const today = signatureOf(normalize(todayGames));
  const findings = [];
  const proposals = [];
  if (today.length < 8) return { findings, proposals, matches: [] };
  const matches = [];
  for (const day of pastDays) {
    const sig = signatureOf(normalize(day.games || []));
    if (sig.length < 8) continue;
    const run = longestCommonRun(today, sig);
    const rate = pct(run, Math.min(today.length, sig.length));
    matches.push({ date: day.date, run, rate, length: sig.length });
  }
  matches.sort((a, b) => b.run - a.run || b.rate - a.rate);
  const best = matches[0];
  if (best && best.run >= 6) {
    findings.push(
      `Répétition de journée : la partie du ${frenchDate(best.date)} revient aujourd'hui — ${best.run} jeux identiques d'affilée (${best.rate}% de la journée).`
    );
    proposals.push({
      name: `Rejouer la journée du ${frenchDate(best.date)}`,
      logic: `La suite des vainqueurs d'aujourd'hui reproduit celle du ${frenchDate(best.date)} : suivre les jeux de cette date pour anticiper les prochains tours.`,
      trigger: `${best.run} jeux consécutifs identiques à la journée du ${frenchDate(best.date)}`,
      target: 'jeux suivants de la journée de référence',
      suggestedLead: 1,
      minimumSample: 20,
      rate: best.rate,
      support: best.run,
      evidence: `Correspondance de ${best.run} jeux consécutifs (${best.rate}% de recouvrement).`,
      risks: 'Une correspondance de journée peut se rompre à tout moment : recontrôler après chaque jeu.',
      compatibleExisting: null,
    });
  }
  return { findings, proposals, matches: matches.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// 6) Remplacement de costume conseillé pour une stratégie EXISTANTE
// ---------------------------------------------------------------------------
// Pour chaque costume prédit habituellement, on regarde ce qui SORT réellement
// au jeu ciblé. Si un autre costume est nettement plus fréquent, l'analyseur
// conseille de le remplacer : « quand le déclencheur est vu, prédis ♣️ à la
// place de ♦️ — d'après mes analyses ».
function suitReplacements(games, lead = 2) {
  const out = [];
  for (const suit of SUITS) {
    const hits = {};
    let support = 0;
    for (let i = 0; i < games.length; i += 1) {
      if (!hasSuit(games[i], suit)) continue;
      const target = games[i + lead];
      if (!target) continue;
      support += 1;
      for (const s of SUITS) if (hasSuit(target, s)) hits[s] = (hits[s] || 0) + 1;
    }
    if (support < MIN_SUPPORT) continue;
    const ranked = SUITS.map((s) => ({ suit: s, rate: pct(hits[s] || 0, support), hits: hits[s] || 0 }))
      .sort((a, b) => b.rate - a.rate);
    const current = ranked.find((r) => r.suit === suit);
    const best = ranked[0];
    if (best.suit !== suit && best.rate - current.rate >= 15 && best.rate >= 60) {
      out.push({
        trigger: suit,
        from: suit,
        to: best.suit,
        lead,
        rate: best.rate,
        currentRate: current.rate,
        support,
        text:
          `D'après mes analyses : quand ${suit} est vu côté joueur, remplace la prédiction ${suit} ` +
          `par ${best.suit} sur le jeu a+${lead} — ${best.rate}% de réussite contre ${current.rate}% ` +
          `(${best.hits}/${support} observations).`,
      });
    }
  }
  return out.sort((a, b) => b.rate - a.rate);
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------
function mine(rawGames = [], options = {}) {
  const games = normalize(rawGames);
  const lead = Number(options.lead) || 2;
  if (games.length < 12) {
    return {
      sample: games.length,
      findings: [],
      proposals: [],
      replacements: [],
      dayMatches: [],
      note: `Découverte en attente : ${games.length} jeu(x) analysés, il en faut au moins 12.`,
    };
  }

  const discovered = [
    ...mineCardRules(games),
    ...mineValueRules(games),
    ...mineSuitChains(games),
    ...mineWinnerSequences(games),
  ].sort((a, b) => b.score - a.score);

  const kept = [];
  const seen = new Set();
  for (const item of discovered) {
    const key = item.proposal ? item.proposal.name : item.finding;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
    if (kept.length >= 8) break;
  }

  const day = compareDays(options.todayGames || rawGames, options.pastDays || []);

  return {
    sample: games.length,
    findings: [...day.findings, ...kept.map((k) => k.finding)],
    proposals: [...day.proposals, ...kept.map((k) => k.proposal)],
    discoveries: kept.map(({ kind, rate, support, hits, suit, rule, finding, proposal }) => ({ kind, rate, support: support || 0, hits: hits || 0, suit, rule: rule || null, finding, proposal })),
    replacements: suitReplacements(games, lead),
    dayMatches: day.matches,
    note: null,
  };
}

module.exports = { mine, compareDays, suitReplacements, normalize, SUITS };
