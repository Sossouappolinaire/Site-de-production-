// send-delay.js — RETARD D'ENVOI des prédictions (demande admin).
//
// Réglage par stratégie (delayEnabled, delaySec — 10 s par défaut). Quand il est
// activé, la prédiction est calculée comme d'habitude (déclencheur, cible, costume)
// mais elle n'est PAS envoyée tout de suite : elle reste « retenue » jusqu'à ce que
// le jeu situé juste AVANT la cible soit en cours, puis on attend encore `delaySec`
// secondes avant de l'envoyer.
//
// Exemple : déclencheur sur le jeu #2, cible #4 (+2). Avec le retard activé, on
// attend que le jeu #3 soit en cours (cartes en distribution ou jeu terminé), puis
// 10 secondes, et seulement alors la prédiction du jeu #4 part.
//
// Sécurités :
//   • si le jeu cible est déjà en cours / terminé avant l'envoi, la prédiction est
//     ANNULÉE (jamais d'annonce d'un jeu déjà distribué) ;
//   • pendant « /stop » (arrêt global) la prédiction reste retenue ;
//   • une prédiction retenue n'est jamais vérifiée avant son envoi.
//
// Variable d'environnement SEND_DELAY=off : désactive la fonction partout.
'use strict';

const NEVER_DELAYED = new Set(['ombre']); // « ombre » a sa propre file d'envoi (voir bot.js)

function enabled() { return !/^(off|0|false)$/i.test(String(process.env.SEND_DELAY || '')); }

function delaySecOf(cfg) {
  const n = parseInt(cfg && cfg.delaySec, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(120, n)) : 10;
}

function shouldHold(key, cfg) {
  return enabled() && !NEVER_DELAYED.has(key) && !!(cfg && cfg.delayEnabled);
}

// à appeler juste après la création de la prédiction
function mark(pred, cfg) {
  pred.holdSend = true;
  pred.holdSec = delaySecOf(cfg);
  pred.holdArmedAt = null;
}

// plus grand numéro de jeu : terminé / en cours de distribution
function progress(games) {
  let done = 0; let dealing = 0;
  for (const g of games.values()) {
    const n = Number(g.number) || 0;
    if (g.finished) { if (n > done) done = n; }
    else if (g.dealing && n > dealing) dealing = n;
  }
  return { done, dealing };
}

// Parcourt les prédictions retenues et libère celles dont l'heure est venue.
// broadcast : (pred) => Promise — l'envoi habituel (bot.js).
async function releaseDue(state, broadcast, now = Date.now()) {
  if (!enabled()) { for (const p of state.predictions) if (p.holdSend) p.holdSend = false; }
  const held = state.predictions.filter((p) => p.holdSend && p.status === 'en attente');
  if (!held.length) return [];
  const { done, dealing } = progress(state.games);
  const sent = [];
  for (const p of held) {
    const target = Number(p.target);
    // le jeu cible a déjà commencé ou est terminé : trop tard, on n'annonce plus
    if (done >= target || dealing >= target) {
      p.holdSend = false;
      p.status = 'annulé';
      p.badge = '♻️';
      p.result = `retard d'envoi dépassé (jeu #N${target} déjà lancé)`;
      continue;
    }
    // le jeu juste avant la cible est-il en cours (ou déjà terminé) ?
    const prevOn = dealing >= target - 1 || done >= target - 1;
    if (!prevOn) continue;
    if (!p.holdArmedAt) p.holdArmedAt = now;
    if (now - p.holdArmedAt < (p.holdSec != null ? p.holdSec : 10) * 1000) continue;
    p.holdSend = false;
    p.sentAt = now;
    try { await broadcast(p); sent.push(p); } catch (_) { /* l'échec d'envoi est journalisé par broadcast */ }
  }
  return sent;
}

module.exports = { enabled, shouldHold, mark, releaseDue, delaySecOf, progress };
