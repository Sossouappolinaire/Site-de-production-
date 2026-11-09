// suit-consecutive.js — réglage « Costume déjà venu N fois de suite → prédire son inverse » (v132, demande admin).
//
// Utilisé par les stratégies branchées sur le Compte parité (« Palier parité » et « Palier parité égalité »).
//
// Règle : avant d'envoyer une prédiction pour le jeu N avec le costume X, on regarde les `need` jeux juste avant N (N-1, N-2, …,
// N-need), dans la main du JOUEUR. Si X est venu dans CHACUN de ces jeux (donc `need` fois de suite), le costume est considéré
// comme « déjà venu » et on prédit son INVERSE à la place : ❤️ → ♣️, ♣️ → ❤️, ♦️ → ♠️, ♠️ → ♦️.
//
// Exemple avec le réglage 2 : le bot veut prédire le jeu 12 en ❤️. Au jeu 10 le joueur a eu ❤️ et au jeu 11 le joueur a eu ❤️
// → le bot prédit 12 en ♣️ (le ❤️ est déjà venu deux fois de suite). Si le jeu 11 n'avait pas de ❤️, le bot prédirait 12 en ❤️.
//
// Réglage 0 (par défaut) = fonction désactivée.
//
// Attente : la décision a besoin du résultat des `need` jeux précédents. Tant que l'un d'eux n'est pas encore joué (ou que la main
// du joueur est en cours sans le costume), le résultat est « wait » : l'appelant n'envoie PAS encore la prédiction et réessaie au
// passage suivant. Dès qu'un seul des jeux précédents est connu SANS le costume, la série est rompue : on prédit le costume
// d'origine sans attendre les autres. Un jeu où le costume est déjà dans la main du joueur compte tout de suite (il ne peut plus
// disparaître), sans attendre la fin du jeu.
'use strict';
const strategies = require('./strategies');
const { state, hasSuit } = require('./predictor');

const INVERSE = strategies.INVERSE || { '❤️': '♣️', '♣️': '❤️', '♦️': '♠️', '♠️': '♦️' };
const MAX_NEED = 9;

const bare = (s) => String(s == null ? '' : s).replace(/\uFE0F/g, '');
const inverseOf = (suit) => {
  const b = bare(suit);
  for (const k of Object.keys(INVERSE)) if (bare(k) === b) return INVERSE[k];
  return null;
};
const clampNeed = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, Math.min(MAX_NEED, n)) : d; };

const hasPlayerCards = (g) => !!g && Array.isArray(g.player) && g.player.length > 0;
// main du joueur terminée sans attendre le banquier : 3 cartes, ou 2 cartes valant 6+ (il reste)
const playerFinal = (g) => !!g && (g.finished ? g.complete !== false : (Number(g.playerCards) >= 3 || (Number(g.playerCards) === 2 && Number(g.playerValue) >= 6)));
const maxKnownGameNumber = () => { let m = 0; for (const g of state.games.values()) if ((g.finished || g.dealing) && g.number > m) m = g.number; return m; };

// État du costume dans le jeu m : 'hit' (déjà dans la main du joueur), 'miss' (main terminée sans le costume, ou jeu passé sans
// données), 'open' (jeu pas encore joué ou main du joueur encore en cours sans le costume).
function gameState(m, suit, known) {
  if (m < 1) return 'miss'; // avant le début du sabot : pas de série possible
  const g = state.games.get(m);
  if (hasPlayerCards(g)) {
    if (hasSuit(g, suit)) return 'hit';
    return playerFinal(g) ? 'miss' : 'open';
  }
  return m >= known ? 'open' : 'miss';
}

// decide(target, suit, need) → { suit, swapped, from, wait, hits }
//   wait    : true = ne pas envoyer maintenant, les jeux précédents ne sont pas tous connus (réessayer au passage suivant) ;
//   swapped : true = le costume d'origine (from) est venu `need` fois de suite → `suit` est son inverse.
function decide(target, suit, need) {
  const n = clampNeed(need, 0);
  const out = { suit, swapped: false, from: null, wait: false, hits: 0 };
  if (n < 1) return out;
  const inv = inverseOf(suit);
  if (!inv) return out;
  const known = maxKnownGameNumber();
  let open = false;
  for (let k = 1; k <= n; k++) {
    const st = gameState(target - k, suit, known);
    if (st === 'miss') return out;      // série rompue : on garde le costume d'origine, sans attendre les autres jeux
    if (st === 'open') open = true; else out.hits += 1;
  }
  if (open) { out.wait = true; return out; }
  return { suit: inv, swapped: true, from: suit, wait: false, hits: out.hits };
}

module.exports = { decide, inverseOf, clampNeed, MAX_NEED };
