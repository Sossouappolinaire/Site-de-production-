// api.js — lecture de l'API 1xbet Baccara (LiveFeed/GetChampZip)
// Un jeu renvoie TOUTES les cartes et TOUS les costumes des deux mains ;
// la main réellement vérifiée est choisie dans le prédicteur (joueur par défaut).
const config = require('./config');

const SUIT_MAP = { 0: '♠️', 1: '♣️', 2: '♦️', 3: '❤️' };
const RANK_MAP = {
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8',
  9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

// L'API 1xbet renvoie les cartes sous la forme {"S":2,"R":11} :
//   S = costume (0 ♠️, 1 ♣️, 2 ♦️, 3 ❤️)
//   R = rang    (2..10 = valeur, 11 J, 12 Q, 13 K, 14 As)
// Certaines réponses utilisent V / CV / Rank : on accepte toutes les formes.
function rankOf(c) {
  if (c == null) return null;
  if (typeof c === 'number') return c;
  if (typeof c === 'string') {
    const m = c.match(/^(10|[2-9]|[AJQKajqk])/);
    if (!m) return null;
    const t = m[1].toUpperCase();
    if (t === 'A') return 14;
    if (t === 'J') return 11;
    if (t === 'Q') return 12;
    if (t === 'K') return 13;
    return Number(t);
  }
  const v = [c.R, c.V, c.CV, c.Rank, c.rank, c.value].find((x) => x != null);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function suitOf(c) {
  if (c == null || typeof c !== 'object') return null;
  const v = [c.S, c.CS, c.Suit, c.suit].find((x) => x != null);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

const FINISHED_PHASES = ['Win1', 'Win2', 'Tie', 'Match finished'];

function cardLabel(c) {
  if (!c) return null;
  const r = rankOf(c);
  const rank = RANK_MAP[r] || (r != null ? String(r) : '?');
  return `${rank}${SUIT_MAP[suitOf(c)] || ''}`;
}

// valeur baccara d'une carte : A=1, 2..9 = valeur, 10/J/Q/K = 0
function cardValue(c) {
  const r = rankOf(c);
  if (!Number.isFinite(r)) return 0;
  if (r === 14 || r === 1) return 1;   // As = 1
  if (r >= 10) return 0;               // 10, J, Q, K = 0
  return r;
}

function handValue(list) {
  return (list || []).reduce((s, c) => s + cardValue(c), 0) % 10;
}

function suitsOf(list) {
  return (list || []).map((c) => SUIT_MAP[suitOf(c)]).filter(Boolean);
}

function parseCards(scS) {
  const out = { player: [], banker: [] };
  for (const e of scS || []) {
    let cards = [];
    try { cards = JSON.parse(e.Value || '[]'); } catch { cards = []; }
    if (e.Key === 'P') out.player = cards;
    else if (e.Key === 'B') out.banker = cards;
  }
  return out;
}

function phaseOf(scS) {
  const e = (scS || []).find((x) => x.Key === 'S');
  return e ? e.Value : null;
}

function winnerOf(scS) {
  const p = phaseOf(scS);
  if (p === 'Win1') return 'Joueur';
  if (p === 'Win2') return 'Banquier';
  if (p === 'Tie') return 'Égalité';
  return null;
}

const parity = (n) => (n == null ? null : n % 2 === 0 ? 'pair' : 'impair');

function parseChamp(data) {
  const games = data && data.Value && data.Value.G;
  if (!Array.isArray(games)) return [];
  const out = [];
  for (const g of games) {
    const number = parseInt(g.DI, 10);
    if (!Number.isFinite(number) || number <= 0) continue;
    const sc = g.SC || {};
    const scS = sc.S || [];
    const cards = parseCards(scS);
    const ph = phaseOf(scS);
    const finished = !!g.F || sc.CPS === 'Match finished' || FINISHED_PHASES.includes(ph);
    const fs = sc.FS || {};
    const fsP = Number.isFinite(Number(fs.S1)) ? Number(fs.S1) : null;
    const fsB = Number.isFinite(Number(fs.S2)) ? Number(fs.S2) : null;
    // points : calculés à partir des cartes ; à défaut on prend le score
    // officiel FS (S1 = joueur, S2 = banquier) pour ne jamais afficher « ? »
    const playerValue = cards.player.length ? handValue(cards.player) : fsP;
    const bankerValue = cards.banker.length ? handValue(cards.banker) : fsB;

    out.push({
      number,
      // toutes les cartes et tous les costumes des deux mains
      player: cards.player.map(cardLabel),
      banker: cards.banker.map(cardLabel),
      playerSuits: suitsOf(cards.player),
      bankerSuits: suitsOf(cards.banker),
      playerValue,
      bankerValue,
      playerParity: parity(playerValue),
      bankerParity: parity(bankerValue),
      playerCards: cards.player.length,
      bankerCards: cards.banker.length,
      dealing: cards.player.length > 0 || cards.banker.length > 0,
      winner: winnerOf(scS),
      phase: ph,
      finished,
      // CORRECTIF « jeux sautés » : un tour n'est exploitable pour la
      // vérification que si les cartes du joueur sont réellement arrivées.
      // Un tour terminé sans cartes (flux tronqué) ne doit JAMAIS être
      // compté comme une perte : il est marqué incomplet.
      complete: cards.player.length > 0,
      score: sc.FS || {},
      at: Date.now(),
    });
  }
  return out.sort((a, b) => b.number - a.number);
}

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
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

function endpoints() {
  const qs = `champ=${config.CHAMP_ID}&lng=en&country=96&groupChamps=true`;
  return config.API_HOSTS.map((h) => `${h}/LiveFeed/GetChampZip?${qs}`);
}

// CORRECTIF « le jeu en live saute » : un seul miroir 1xbet renvoie parfois une
// fenêtre tronquée (tours manquants, tour terminé sans cartes). On interroge
// donc les miroirs EN PARALLÈLE et on FUSIONNE les réponses : pour chaque
// numéro de tour on garde la version la plus complète (cartes présentes >
// terminé > la plus récente). Plus aucun tour n'est perdu à cause d'un miroir.
function betterGame(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (!!a.complete !== !!b.complete) return a.complete ? a : b;
  if (!!a.finished !== !!b.finished) return a.finished ? a : b;
  if ((a.playerCards + a.bankerCards) !== (b.playerCards + b.bankerCards)) {
    return (a.playerCards + a.bankerCards) > (b.playerCards + b.bankerCards) ? a : b;
  }
  return (a.at || 0) >= (b.at || 0) ? a : b;
}

function merge(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const g of list || []) map.set(g.number, betterGame(map.get(g.number), g));
  }
  return [...map.values()].sort((a, b) => b.number - a.number);
}

async function fetchGames() {
  const direct = await Promise.all(
    endpoints().map(async (url) => {
      const data = await get(url);
      return data ? parseChamp(data) : [];
    }),
  );
  const merged = merge(direct);
  if (merged.length) return merged;

  const viaProxy = [];
  for (const url of endpoints().slice(0, 2)) {
    for (const p of config.PROXIES) {
      const data = await get(p(url));
      const parsed = data ? parseChamp(data) : [];
      if (parsed.length) viaProxy.push(parsed);
    }
    if (viaProxy.length) break;
  }
  const mp = merge(viaProxy);
  if (mp.length) return mp;

  throw new Error('API 1xbet Baccara injoignable');
}

module.exports = { fetchGames, parseChamp, endpoints, SUIT_MAP, RANK_MAP, cardLabel, handValue };

