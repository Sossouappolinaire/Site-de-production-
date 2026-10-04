// early-verify.js — VÉRIFICATION ANTICIPÉE (demande admin).
//
// Règle : dès que le costume prédit apparaît dans la main du JOUEUR, la
// prédiction est validée tout de suite (✅ + numéro de rattrapage), même si le
// jeu n'est pas encore terminé. Si le costume n'est pas (encore) là, on attend
// la fin du jeu comme avant : seule la VALIDATION est anticipée, jamais la perte
// — une perte n'est prononcée qu'une fois le tour terminé (la 3ᵉ carte du joueur
// peut encore arriver).
//
// Ne s'applique qu'aux prédictions de COSTUME sur la main du joueur. Restent
// vérifiées en fin de jeu : parité (le total change avec la 3ᵉ carte), nombre de
// cartes, et les vérifications sur la main du banquier.
//
// STRICT : seul un tour non terminé dont les cartes du joueur sont déjà arrivées
// est concerné ; un tour terminé suit le chemin habituel.
//
// Désactivation : variable d'environnement EARLY_VERIFY=off.
'use strict';

const NOT_PLAYER_SUIT = new Set(['parity', 'cards', 'carte-banquier', 'suit-banquier']);

function enabled() {
  return !/^(off|0|false)$/i.test(String(process.env.EARLY_VERIFY || ''));
}

// g          : tour (state.games)
// kind       : type de prédiction (facultatif)
// matchesFn  : (g) => boolean — le test de victoire propre au module appelant
function hit(g, kind, matchesFn) {
  if (!enabled() || !g || g.finished) return false;
  if (kind && NOT_PLAYER_SUIT.has(kind)) return false;
  if (!Array.isArray(g.player) || g.player.length === 0) return false; // cartes du joueur pas encore arrivées
  try { return !!matchesFn(g); } catch (_) { return false; }
}

module.exports = { hit, enabled };
