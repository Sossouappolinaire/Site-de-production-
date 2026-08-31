// predit.js — panneau « Prédit » : prédictions automatiques haute fiabilité
//
//  • SEULES les stratégies CRÉÉES PAR L'IA (règles découvertes par l'analyseur)
//    qui atteignent AU MOINS le seuil configuré (85% par défaut, réglable de
//    50% à 100% via minRate) entrent dans ce panneau. Les stratégies
//    existantes du bot ne sont JAMAIS utilisées ici.
//  • PRIORITÉ AUX DÉCLENCHEURS À 100% : tant qu'au moins une règle certifiée
//    à 100% est disponible (quota non atteint) ou a une prédiction en cours,
//    les règles en dessous de 100% sont mises en attente et ne prédisent
//    pas. Elles ne reprennent que lorsque plus aucune règle à 100% n'est
//    disponible.
//  • Le message envoyé dans le canal utilise le FORMAT DE PRÉDICTION CONFIGURÉ
//    (les 88 formats). Le motif de la prédiction n'apparaît jamais dans le
//    message : il est gardé dans l'historique de la stratégie.
//  • Chaque stratégie certifiée ne prédit qu'un nombre configuré de fois
//    (ex. 2). Ensuite elle est mise en pause et le panneau attend une NOUVELLE
//    stratégie certifiée pour continuer à prédire.
//  • Dès qu'une stratégie certifiée perd, elle est retirée automatiquement.
//  • FILTRE « PERTES RAPPROCHÉES » (optionnel, désactivé par défaut) : une
//    fois activé, une prédiction n'est publiée sur le canal qu'APRÈS avoir
//    observé une série de pertes rapprochées (même principe que le filtre de
//    la stratégie « ombre », jamais nommé ainsi dans les messages envoyés à
//    l'acheteur — voir shop.js). Tant que le filtre n'est pas armé, les
//    prédictions restent suivies en interne (elles alimentent le compteur de
//    pertes) mais ne partent jamais sur Telegram. Une victoire publiée
//    referme le filtre. Voir panel.silentMode / silentLossTrigger /
//    silentLossWindow / silentGate ci-dessous.
'use strict';

const appConfig = require('./config');
const miner = require('./pattern-miner');
const strategies = require('./strategies');
const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const { state } = require('./predictor');
const lossNotice = require('./loss-notice');

const SUITS = ['♦️', '❤️', '♣️', '♠️'];

const panel = {
  enabled: true,
  channels: [],        // canaux Telegram du panneau
  minSample: 6,        // observations minimum pour certifier une règle
  minRate: 85,          // taux de réussite minimum accepté (réglable 50-100 ; 100 = parfait, prioritaire)
  maxR: 1,             // rattrapages autorisés sur une prédiction du panneau
  format: 1,           // format de prédiction utilisé pour les messages
  perStrategy: 2,      // nombre de prédictions autorisées par stratégie créée
  requireCombo: false, // n'envoyer QUE les prédictions confirmées par 2 règles
  minGap: 3,           // écart minimum (en numéro de jeu) exigé entre deux
                        // numéros prédits par le panneau ; un nouveau numéro
                        // trop proche du dernier numéro déjà prédit est bloqué
  // ── Filtre « pertes rapprochées » (même principe que la stratégie « ombre »,
  // jamais nommé ainsi dans les messages envoyés — voir shop.js/formation.js) ──
  // Quand actif, une prédiction du panneau n'est PUBLIÉE qu'après confirmation :
  // tant qu'aucune série de pertes rapprochées n'a été observée, les
  // prédictions restent TRACKÉES en interne (elles alimentent le compteur)
  // mais ne partent jamais sur Telegram. Dès que `silentLossTrigger` pertes
  // tombent dans une fenêtre de `silentLossWindow` prédictions résolues,
  // l'envoi s'active — et le reste actif jusqu'à la prochaine victoire
  // publiée, qui referme le filtre (retour au silence).
  silentMode: false,
  silentLossTrigger: 2,  // nb de pertes rapprochées nécessaires pour activer l'envoi (1-5)
  silentLossWindow: 3,   // écart max (en prédictions résolues) entre ces pertes (1-20)
  silentGate: { armed: false, lossesInWindow: 0, sinceLastLoss: 0 }, // état runtime du filtre ci-dessus
  certified: [],       // règles IA actuellement au-dessus du seuil
  retired: [],         // règles retirées (perdues ou quota atteint)
  predictions: [],     // prédictions du panneau (les 200 dernières)
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
};

let sender = null;
function setSender(fn) { sender = fn; }

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function parseChannels(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n) && n !== 0 && !out.includes(n)) out.push(n);
    } else {
      const name = t.startsWith('@') ? t : `@${t.replace(/^https?:\/\/t\.me\//i, '')}`;
      if (name.length > 2 && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.requireCombo !== undefined) panel.requireCombo = !!patch.requireCombo;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  if (patch.minRate !== undefined) {
    const v = parseInt(patch.minRate, 10);
    panel.minRate = Math.max(50, Math.min(100, Number.isFinite(v) ? v : 85));
  }
  if (patch.minSample !== undefined) panel.minSample = Math.max(3, Math.min(60, parseInt(patch.minSample, 10) || 6));
  if (patch.maxR !== undefined) panel.maxR = Math.max(0, Math.min(5, parseInt(patch.maxR, 10) || 0));
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.perStrategy !== undefined) panel.perStrategy = Math.max(1, Math.min(50, parseInt(patch.perStrategy, 10) || 1));
  if (patch.minGap !== undefined) panel.minGap = Math.max(0, Math.min(30, parseInt(patch.minGap, 10) || 0));
  if (patch.silentMode !== undefined) panel.silentMode = !!patch.silentMode;
  if (patch.silentLossTrigger !== undefined) panel.silentLossTrigger = Math.max(1, Math.min(5, parseInt(patch.silentLossTrigger, 10) || 2));
  if (patch.silentLossWindow !== undefined) panel.silentLossWindow = Math.max(1, Math.min(20, parseInt(patch.silentLossWindow, 10) || 3));
  persist();
  return config();
}

function config() {
  return {
    enabled: panel.enabled,
    channels: panel.channels,
    minSample: panel.minSample,
    minRate: panel.minRate,
    maxR: panel.maxR,
    format: panel.format,
    perStrategy: panel.perStrategy,
    requireCombo: panel.requireCombo,
    minGap: panel.minGap,
    silentMode: panel.silentMode,
    silentLossTrigger: panel.silentLossTrigger,
    silentLossWindow: panel.silentLossWindow,
  };
}

function persist() {
  const saved = {
    config: config(),
    certified: panel.certified,
    retired: panel.retired,
    predictions: panel.predictions,
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    silentGate: panel.silentGate,
  };
  try { store.patch({ predit: config() }); } catch (_) {}
  if (db.ready) db.savePreditState(saved).catch((error) => { panel.lastError = error.message; });
}

function restore() {
  try {
    const saved = (store.read() || {}).predit;
    if (saved) configure({ ...saved });
  } catch (_) {}
  purgeChainRules();
  return config();
}

// La base devient la source de vérité sur les déploiements sans disque persistant.
async function restoreFromDb() {
  if (!db.ready) return config();
  const saved = await db.loadPreditState();
  if (!saved || typeof saved !== 'object') {
    persist();
    return config();
  }
  if (saved.config) {
    panel.enabled = saved.config.enabled !== false;
    panel.requireCombo = !!saved.config.requireCombo;
    panel.channels = parseChannels(saved.config.channels);
    panel.minRate = Math.max(50, Math.min(100, parseInt(saved.config.minRate, 10) || 85));
    panel.minSample = Math.max(3, Math.min(60, parseInt(saved.config.minSample, 10) || 6));
    panel.maxR = Math.max(0, Math.min(5, parseInt(saved.config.maxR, 10) || 0));
    panel.format = fmt.clampFormat(saved.config.format);
    panel.perStrategy = Math.max(1, Math.min(50, parseInt(saved.config.perStrategy, 10) || 1));
    panel.minGap = Math.max(0, Math.min(30, parseInt(saved.config.minGap, 10) || 0));
    panel.silentMode = !!saved.config.silentMode;
    panel.silentLossTrigger = Math.max(1, Math.min(5, parseInt(saved.config.silentLossTrigger, 10) || 2));
    panel.silentLossWindow = Math.max(1, Math.min(20, parseInt(saved.config.silentLossWindow, 10) || 3));
  }
  if (Array.isArray(saved.certified)) panel.certified = saved.certified;
  if (Array.isArray(saved.retired)) panel.retired = saved.retired;
  if (Array.isArray(saved.predictions)) {
    // CORRECTIF (même règle qu'ailleurs) : au redémarrage, on ne rejette pas
    // les entrées encore « en attente » au-delà de 200 — seules les entrées
    // déjà résolues sont plafonnées.
    const keep = [];
    let resolvedCount = 0;
    for (const p of saved.predictions) {
      if (p.status === 'en attente' || resolvedCount < 200) {
        keep.push(p);
        if (p.status !== 'en attente') resolvedCount += 1;
      }
    }
    panel.predictions = keep;
  }
  if (Number.isFinite(Number(saved.sentCount))) panel.sentCount = Number(saved.sentCount);
  panel.lastSentAt = saved.lastSentAt || null;
  panel.lastScanAt = saved.lastScanAt || null;
  if (saved.silentGate && typeof saved.silentGate === 'object') {
    panel.silentGate = {
      armed: !!saved.silentGate.armed,
      lossesInWindow: Number(saved.silentGate.lossesInWindow) || 0,
      sinceLastLoss: Number(saved.silentGate.sinceLastLoss) || 0,
    };
  }
  purgeChainRules();
  return config();
}

// CORRECTIF (demande) : les règles de type « chaine » (enchaînement de
// costumes) ne sont plus proposées par l'analyseur (voir pattern-miner.js),
// et triggered() ne sait plus les évaluer — une règle « chaine » certifiée
// avant ce changement resterait donc inerte pour toujours (ni retirée, ni
// jamais re-déclenchée). On la retire proprement au chargement.
function purgeChainRules() {
  const stale = panel.certified.filter((c) => c.id && c.id.startsWith('ia:chaine:'));
  for (const entry of stale) {
    retire(entry, "Type de déclencheur « enchaînement de costumes » désactivé.");
    dropPredictionsFor(entry.id);
  }
}

// ---------------------------------------------------------------------------
// Lecture des jeux
// ---------------------------------------------------------------------------
function orderedGames() {
  return miner.normalize(state.history || []);
}

function suitsOf(game) {
  return strategies.suitsOf(game && game.playerSuits ? game.playerSuits : []);
}

function cardTokens(game, hand) {
  const cards = hand === 'banquier' ? (game.bankerCards || []) : (game.playerCards || []);
  const out = new Set();
  for (const card of cards) {
    const text = String(card || '');
    const suit = SUITS.find((s) => text.includes(s.charAt(0)));
    if (!suit) continue;
    const rank = text.replace(suit, '').replace(/\uFE0F/g, '').trim() || '?';
    out.add(`${rank}${suit}`);
  }
  return out;
}

// jeton (rang+costume) exactement à la position donnée (0 = 1ère carte, etc.)
// dans la main indiquée, ou null si aucune carte à cette position.
function cardTokenAt(game, hand, pos) {
  const cards = hand === 'banquier' ? (game.bankerCards || []) : (game.playerCards || []);
  const text = String(cards[pos] || '');
  if (!text) return null;
  const suit = SUITS.find((s) => text.includes(s.charAt(0)));
  if (!suit) return null;
  const rank = text.replace(suit, '').replace(/\uFE0F/g, '').trim() || '?';
  return `${rank}${suit}`;
}

// la règle est-elle déclenchée par ce jeu ?
function triggered(rule, game) {
  if (!rule || !game) return false;
  if (rule.kind === 'carte') {
    // règle avec position exacte du déclencheur (ex. « 4❤️ en 2e position du
    // banquier ») : on exige la carte À CETTE position précise, pas ailleurs
    // dans la main — sinon on retombe sur l'ancien comportement (présence
    // n'importe où) pour les règles héritées sans position enregistrée.
    if (rule.pos != null) return cardTokenAt(game, rule.hand, rule.pos) === rule.token;
    return cardTokens(game, rule.hand).has(rule.token);
  }
  if (rule.kind === 'point') return game.playerValue != null && Number(game.playerValue) === Number(rule.value);
  if (rule.kind === 'egalite') return game.winner === 'Égalité' && game.playerValue != null && Number(game.playerValue) === Number(rule.value);
  if (rule.kind === 'forme') {
    return game.playerValue != null && Number(game.playerValue) === Number(rule.value)
      && (game.playerCards || []).length === Number(rule.pCount)
      && (game.bankerCards || []).length === Number(rule.bCount);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Certification : SEULES les stratégies créées par l'IA à 100% entrent ici
// ---------------------------------------------------------------------------
// prédictions du panneau liées à une règle donnée (retirée elles aussi de la
// base de données, puisque panel.predictions est réenregistré en entier par
// persist()/db.savePreditState()).
function dropPredictionsFor(id) {
  panel.predictions = panel.predictions.filter((p) => !(p.sources || []).some((s) => s.id === id));
}

function certifyDiscoveries() {
  const found = miner.mine(state.history || [], { lead: 2 });
  const discoveries = found.discoveries || [];
  const byId = new Map();
  for (const d of discoveries) {
    if (!d.rule) continue;
    byId.set(`ia:${d.rule.kind}:${d.rule.hand}:${d.rule.pos ?? 'any'}:${d.rule.token}:${d.rule.k}:${d.rule.suit}`, d);
  }
  // CORRECTIF : avant, seules les règles ENCORE au-dessus du seuil (85% par
  // défaut) étaient réévaluées ci-dessous (elles étaient filtrées AVANT).
  // Une règle déjà certifiée qui retombait sous le seuil gardait donc pour
  // toujours son ancien taux, n'était jamais retirée, et le panneau
  // n'arrivait plus à « renouveler » ses stratégies. On met maintenant à
  // jour TOUTE règle déjà certifiée qui réapparaît dans l'analyse, et on la
  // retire aussitôt (liste + prédictions en base) si elle repasse sous le seuil.
  for (const entry of panel.certified) {
    const d = byId.get(entry.id);
    if (!d) continue;
    entry.rate = d.rate;
    entry.sample = d.support;
    if (Number(d.rate) < panel.minRate) {
      retire(entry, `Repasse sous le seuil de ${panel.minRate}% (nouveau taux : ${d.rate}%).`);
      dropPredictionsFor(entry.id);
    }
  }
  const list = discoveries.filter(
    (d) => d.rule && Number(d.rate) >= panel.minRate && Number(d.support || 0) >= panel.minSample,
  );
  for (const d of list) {
    const id = `ia:${d.rule.kind}:${d.rule.hand}:${d.rule.pos ?? 'any'}:${d.rule.token}:${d.rule.k}:${d.rule.suit}`;
    if (panel.retired.some((r) => r.id === id)) continue;
    if (panel.certified.some((c) => c.id === id)) continue; // déjà mise à jour ci-dessus
    panel.certified.push({
      id,
      type: 'ia',
      name: (d.proposal && d.proposal.name) || d.finding,
      finding: d.finding,
      motif: (d.proposal && d.proposal.logic) || d.finding,
      trigger: (d.proposal && d.proposal.trigger) || '',
      rule: d.rule,
      rate: d.rate,
      sample: d.support,
      used: 0,
      win: 0,
      loss: 0,
      certifiedAt: new Date().toISOString(),
    });
  }
  dedupeSameTarget();
  return panel.certified;
}

// ---------------------------------------------------------------------------
// Anti-doublon : deux déclencheurs DIFFÉRENTS peuvent tous les deux prédire
// le même costume sur le même écart (ex. « ❤️ au jeu a+2 »). On ne veut pas
// laisser cohabiter deux règles redondantes pour la même cible :
//   • si l'une d'elles est certifiée à 100%, elle seule doit rester — SAUF si
//     une autre règle atteint ELLE AUSSI 100% (les deux sont alors gardées) ;
//   • plus généralement, pour une même cible (costume + écart a+k), seules
//     les règles au taux le PLUS ÉLEVÉ du groupe sont conservées : toute
//     règle strictement en dessous du meilleur taux du groupe est retirée
//     automatiquement (elle n'apporte rien de plus et brouille le panneau).
// ---------------------------------------------------------------------------
function targetKey(rule) { return `${rule.suit}|${rule.k}`; }

function dedupeSameTarget() {
  const groups = new Map();
  for (const c of panel.certified) {
    if (!c.rule) continue;
    const key = targetKey(c.rule);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    const bestRate = Math.max(...entries.map((e) => Number(e.rate) || 0));
    for (const e of entries) {
      if (Number(e.rate) < bestRate) {
        retire(
          e,
          `Doublon retiré : une autre règle prédit déjà ${e.rule.suit} au jeu a+${e.rule.k} avec un ` +
            `meilleur taux (${bestRate}% contre ${e.rate}% pour celle-ci).`,
        );
        dropPredictionsFor(e.id);
      }
    }
  }
}

function retire(entry, reason) {
  panel.certified = panel.certified.filter((c) => c.id !== entry.id);
  panel.retired = [{ ...entry, reason, retiredAt: new Date().toISOString() }, ...panel.retired].slice(0, 30);
}

// stratégies encore au-dessus du seuil ET qui n'ont pas épuisé leur quota,
// triées par fiabilité décroissante : les 100% arrivent toujours en tête.
function activeCertified() {
  return panel.certified
    .filter((c) => c.rate >= panel.minRate && (c.used || 0) < panel.perStrategy)
    .sort((a, b) => b.rate - a.rate);
}

// un déclencheur à 100% est-il disponible pour prédire (quota restant), ou
// a-t-il déjà une prédiction en cours ? Tant que la réponse est oui, les
// déclencheurs en dessous de 100% ne sont PAS prioritaires : ils patientent.
function hasPerfectPriority(active) {
  if (active.some((c) => c.rate >= 100)) return true;
  return panel.predictions.some(
    (p) => p.status === 'en attente' && p.sources.some((s) => s.rate >= 100),
  );
}

// ---------------------------------------------------------------------------
// Prédictions du panneau
// ---------------------------------------------------------------------------
function lastFinishedNumber(games) {
  return games.length ? games[games.length - 1].n : 0;
}

function motifOf(entry, game, target) {
  return [
    entry.trigger ? `Déclencheur : ${entry.trigger}` : null,
    `Vu au jeu #N${game.n} → prédiction sur #N${target}`,
    entry.motif || entry.finding || '',
    `Fiabilité mesurée : ${entry.rate}% sur ${entry.sample} observation(s)`,
  ].filter(Boolean).join(' · ');
}

// dernier numéro de jeu ciblé par une prédiction du panneau (peu importe son
// statut) : sert de référence pour la règle d'écart minimum ci-dessous.
// panel.predictions est alimenté via unshift(), donc l'élément [0] est
// toujours le tout dernier numéro prédit.
function lastPredictedTarget() {
  return panel.predictions.length ? panel.predictions[0].target : null;
}

function makePredictions(games) {
  const last = lastFinishedNumber(games);
  if (!last) return [];
  const created = [];
  const active = activeCertified();
  // priorité au(x) déclencheur(s) à 100% : tant que l'un d'eux est
  // disponible ou a déjà une prédiction en cours, les règles < 100% sont
  // écartées de ce tour (elles ne sont pas supprimées, juste mises en attente).
  const perfectPriority = hasPerfectPriority(active);
  // écart minimum exigé entre le numéro qui va être prédit et le dernier
  // numéro déjà prédit par le panneau : les cibles trop rapprochées (jeux
  // quasi consécutifs) sont bloquées plutôt qu'envoyées.
  const minGap = Math.max(0, Math.min(30, parseInt(panel.minGap, 10) || 0));
  let lastTarget = lastPredictedTarget();
  for (const entry of active) {
    if (!entry.rule) continue;
    if (perfectPriority && entry.rate < 100) continue;
    for (let i = games.length - 1; i >= 0 && i >= games.length - 6; i -= 1) {
      const g = games[i];
      if (!triggered(entry.rule, g)) continue;
      const target = g.n + entry.rule.k;
      if (target <= last) continue; // le jeu cible est déjà joué
      // CORRECTIF (demande) : un jeu va de 1 à appConfig.MAX_GAME_NUMBER (1440)
      // avant le retour à 1 (nouveau sabot) — une cible calculée au-delà ne
      // sera jamais jouée avant le rebouclage, on l'ignore.
      if (target > appConfig.MAX_GAME_NUMBER) continue;
      if (panel.predictions.some((p) => p.source === entry.id && p.target === target)) continue;
      if (minGap > 0 && lastTarget != null && Math.abs(target - lastTarget) < minGap) {
        // numéro trop proche du dernier prédit : cette occurrence est
        // bloquée (on tente quand même un autre jeu déclencheur pour cette
        // règle, plus loin dans la fenêtre de recherche).
        continue;
      }
      const pred = {
        id: `predit-${entry.id}-${target}`,
        source: entry.id,
        sources: [{ id: entry.id, name: entry.name, rate: entry.rate, sample: entry.sample }],
        sourceName: entry.name,
        // le motif reste dans l'historique de la stratégie, jamais dans le message
        motif: motifOf(entry, g, target),
        trigger: g.n,
        target,
        suit: entry.rule.suit,
        step: 0,
        maxR: panel.maxR,
        status: 'en attente',
        combo: false,
        messages: [],
        createdAt: new Date().toISOString(),
      };
      panel.predictions.unshift(pred);
      lastTarget = target; // référence mise à jour pour les règles suivantes de ce même tour
      entry.used = (entry.used || 0) + 1;
      created.push(pred);
      if ((entry.used || 0) >= panel.perStrategy) entry.quotaAt = new Date().toISOString();
      break;
    }
  }
  // CORRECTIF (identique à predictor.js) : ne jamais tronquer une prédiction
  // encore « en attente » — sinon son message Telegram reste bloqué sans
  // vérification pour toujours. Seul le nombre de prédictions déjà RÉSOLUES
  // est plafonné à 200 (les plus récentes conservées en priorité).
  if (panel.predictions.length > 200) {
    const keep = [];
    let resolvedCount = 0;
    for (const p of panel.predictions) {
      if (p.status === 'en attente' || resolvedCount < 200) {
        keep.push(p);
        if (p.status !== 'en attente') resolvedCount += 1;
      }
    }
    panel.predictions = keep;
  }
  return created;
}

// Deux règles certifiées qui visent le même jeu avec le même costume :
// elles prédisent ensemble (double confirmation).
function mergeCombos(created) {
  const out = [];
  for (const pred of created) {
    const twin = panel.predictions.find(
      (p) => p !== pred && p.target === pred.target && p.suit === pred.suit && p.status === 'en attente',
    );
    if (twin) {
      twin.combo = true;
      twin.sources = [...twin.sources, ...pred.sources];
      twin.motif = [twin.motif, pred.motif].filter(Boolean).join('\n');
      panel.predictions = panel.predictions.filter((p) => p !== pred);
      if (!out.includes(twin)) out.push(twin);
      twin.resend = true;
    } else {
      out.push(pred);
    }
  }
  return out;
}

function gameByNumber(games, n) {
  return games.find((g) => g.n === n) || null;
}

// Met à jour le filtre « pertes rapprochées » (silentGate) à partir du
// résultat d'UNE prédiction résolue — appelé pour TOUTES les prédictions
// clôturées, qu'elles aient été publiées ou non : le filtre doit voir le
// vrai historique complet pour détecter une série de pertes, pas seulement
// ce qui a été montré publiquement. Une prédiction 'annulé' (données
// illisibles) est ignorée, comme dans formation.js — ce n'est pas un vrai
// résultat de jeu.
function updateSilentGate(pred) {
  if (pred.status !== 'gagné' && pred.status !== 'perdu') return;
  const g = panel.silentGate;
  const isLoss = pred.status === 'perdu';
  if (g.armed) {
    // une victoire referme le filtre (retour au silence) ; une perte
    // pendant que l'envoi est déjà actif ne change rien, il reste actif.
    if (!isLoss) { g.armed = false; g.lossesInWindow = 0; g.sinceLastLoss = 0; }
    return;
  }
  const need = Math.max(1, Math.min(5, parseInt(panel.silentLossTrigger, 10) || 2));
  const window = Math.max(1, Math.min(20, parseInt(panel.silentLossWindow, 10) || 3));
  if (isLoss) {
    g.lossesInWindow += 1;
    g.sinceLastLoss = 0;
    if (g.lossesInWindow >= need) g.armed = true;
  } else if (g.lossesInWindow > 0) {
    g.sinceLastLoss += 1;
    if (g.sinceLastLoss > window) { g.lossesInWindow = 0; g.sinceLastLoss = 0; } // fenêtre dépassée → repart à zéro
  }
}

function verify(games) {
  const last = lastFinishedNumber(games);
  const closed = [];
  for (const pred of panel.predictions) {
    if (pred.status !== 'en attente') continue;
    if (pred.skipped == null) pred.skipped = 0;
    // CORRECTIF « prédictions IA mal vérifiées » : le curseur de lecture est
    // désormais MÉMORISÉ sur la prédiction. Avant, chaque passage repartait
    // de `target + step`, si bien qu'un jeu déjà contrôlé au tour précédent
    // (lorsqu'un tour du milieu avait été sauté faute de données) était
    // recompté une seconde fois : un rattrapage était consommé pour rien et
    // la prédiction était déclarée perdue trop tôt (ou gagnée sur le mauvais
    // jeu). On avance maintenant un curseur unique, jamais réévalué.
    if (pred.cursor == null || pred.cursor < pred.target) pred.cursor = pred.target + (pred.step || 0);
    while (pred.cursor <= last) {
      const g = gameByNumber(games, pred.cursor);
      // Tour déjà présent mais PAS ENCORE TERMINÉ : on ne le saute pas, on
      // attend simplement le prochain passage. Le sauter reviendrait à
      // vérifier la prédiction sur le mauvais numéro de jeu.
      if (g && (g.finished === false || g.complete === false)) break;
      // Tour absent du flux ou sans cartes lisibles : ignoré, il ne consomme
      // PAS d'étape de rattrapage et ne peut donc pas provoquer une fausse
      // perte. Au-delà de 6 tours illisibles consécutifs, la prédiction est
      // annulée (même règle que predictor.js) au lieu de rester bloquée.
      if (!g || !suitsOf(g).length) {
        pred.cursor += 1;
        pred.skipped += 1;
        if (pred.skipped > 6) {
          pred.status = 'annulé';
          pred.closedAt = new Date().toISOString();
          pred.reasonClosed = 'Tours non lus dans le flux (données illisibles) — annulée automatiquement.';
          closed.push(pred);
          break;
        }
        continue;
      }
      pred.skipped = 0;
      if (suitsOf(g).includes(pred.suit)) {
        pred.status = 'gagné';
        pred.hitOn = pred.cursor;
        pred.closedAt = new Date().toISOString();
        closed.push(pred);
        break;
      }
      if (pred.step >= pred.maxR) {
        pred.status = 'perdu';
        pred.lastCheckedGame = pred.cursor;
        pred.closedAt = new Date().toISOString();
        closed.push(pred);
        break;
      }
      pred.step += 1;   // un rattrapage réellement consommé sur un tour lisible
      pred.cursor += 1;
    }
  }
  // une règle certifiée qui perd sort immédiatement du panneau
  for (const pred of closed) {
    for (const src of pred.sources) {
      const entry = panel.certified.find((c) => c.id === src.id);
      if (!entry) continue;
      if (pred.status === 'gagné') {
        entry.win += 1;
      } else if (pred.status === 'annulé') {
        // Annulée pour données illisibles (voir plus haut) : ce n'est PAS un
        // échec réel de la stratégie — on ne la pénalise pas et on ne la
        // retire pas, contrairement à une vraie perte ci-dessous.
        continue;
      } else {
        entry.loss += 1;
        entry.rate = 0;
        retire(entry, `Prédiction perdue sur le jeu #N${pred.target} : la règle passe sous le seuil de ${panel.minRate}%.`);
        continue;
      }
      // quota atteint : la stratégie sort du service, on attend une nouvelle
      if ((entry.used || 0) >= panel.perStrategy && !panel.predictions.some(
        (p) => p.status === 'en attente' && p.sources.some((s) => s.id === entry.id),
      )) {
        retire(entry, `Quota atteint : ${entry.used} prédiction(s) envoyée(s). Le panneau attend une nouvelle stratégie à ${panel.minRate}% ou plus.`);
      }
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Messages Telegram — format configuré, AUCUN motif visible
// ---------------------------------------------------------------------------
function predictionText(pred) {
  return fmt.renderMessage(panel.format, {
    gameNumber: pred.target,
    suit: pred.suit,
    strategy: 'Prédit',
    maxR: pred.maxR,
    status: pred.status,
    rattrapage: pred.step,
  });
}

async function send(pred) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return false; }
  if (!panel.channels.length) { panel.lastError = 'Aucun canal configuré pour le panneau Prédit'; return false; }
  const out = predictionText(pred);
  let ok = false;
  for (const id of panel.channels) {
    try {
      const m = await bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {});
      pred.messages.push({ chatId: id, messageId: m.message_id });
      panel.sentCount += 1;
      panel.lastSentAt = Date.now();
      panel.lastError = null;
      ok = true;
    } catch (e) {
      panel.lastError = `${id} : ${e.message}`;
    }
  }
  return ok;
}

async function update(pred) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot || !pred.messages.length) return;
  const out = predictionText(pred);
  for (const m of pred.messages) {
    try {
      await bot.editMessageText(out.text, {
        chat_id: m.chatId, message_id: m.messageId,
        ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}),
      });
    } catch (_) {}
  }
  // message de perte + rappel formation VIP (voir loss-notice.js), envoyé
  // dans CES MÊMES canaux — identique à bot.js/updateResult() pour les
  // stratégies existantes, ici pour les prédictions « Prédit IA ».
  if (pred.status === 'perdu' && lossNotice.getSettings().enabled) {
    const noticeText = lossNotice.buildText();
    for (const m of pred.messages) {
      try { await bot.sendMessage(m.chatId, noticeText); } catch (_) {}
    }
  }
}

// Les stratégies existantes du bot ne sont plus reprises dans « Prédit ».
async function mirror() { return false; }

// ---------------------------------------------------------------------------
// Historique séparé par stratégie + bilan par stratégie
// ---------------------------------------------------------------------------
function predRow(p) {
  return {
    target: p.target, suit: p.suit, status: p.status, step: p.step, maxR: p.maxR,
    combo: p.combo, sources: p.sources.map((s) => s.name), motif: p.motif || '',
    createdAt: p.createdAt, published: p.messages.length > 0,
  };
}

function bilanOf(list) {
  // Les prédictions « annulé » (données illisibles, pas un vrai échec de la
  // stratégie — voir verify() ci-dessus) sont exclues des statistiques,
  // comme pour les stratégies existantes (predictor.js).
  const done = list.filter((p) => p.status !== 'en attente' && p.status !== 'annulé');
  const win = done.filter((p) => p.status === 'gagné').length;
  const loss = done.length - win;
  const pending = list.filter((p) => p.status === 'en attente').length;
  return { total: list.length, win, loss, pending, rate: done.length ? Math.round((win / done.length) * 100) : 0 };
}

function bilanText(entry, list) {
  const b = bilanOf(list);
  return (
    '📊 STATISTIQUE 📈\n\n' +
    `🧠 Stratégie IA : ${entry.name}\n\n` +
    `🟢 GAIN : ${b.win}\n` +
    `🔴 PERTE : ${b.loss}\n\n` +
    `✅ Taux de réussite : ${b.rate} %`
  );
}

function strategiesView() {
  const all = [...panel.certified, ...panel.retired];
  const seen = new Set();
  const out = [];
  for (const entry of all) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const list = panel.predictions.filter((p) => p.sources.some((s) => s.id === entry.id));
    out.push({
      id: entry.id,
      name: entry.name,
      motif: entry.motif || entry.finding || '',
      finding: entry.finding || '',
      rate: entry.rate,
      sample: entry.sample,
      used: entry.used || 0,
      quota: panel.perStrategy,
      active: panel.certified.some((c) => c.id === entry.id) && entry.rate >= panel.minRate,
      waiting: (entry.used || 0) >= panel.perStrategy,
      reason: entry.reason || null,
      certifiedAt: entry.certifiedAt,
      bilan: bilanOf(list),
      bilanText: bilanText(entry, list),
      predictions: list.slice(0, 20).map(predRow), // 20 dernières de CETTE stratégie
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boucle
// ---------------------------------------------------------------------------
let busy = false;
async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    const games = orderedGames();
    if (games.length >= 12) certifyDiscoveries();
    const closed = verify(games);
    for (const pred of closed) {
      // Le filtre « pertes rapprochées » voit TOUJOURS le résultat réel,
      // publié ou non (voir updateSilentGate ci-dessus) — sinon il ne
      // pourrait jamais détecter une série de pertes restées silencieuses.
      updateSilentGate(pred);
      if (pred.messages.length) { await update(pred); continue; }
      // Retenue EXPRÈS par le filtre « pertes rapprochées » (silentMode actif
      // et pas encore armé au moment de sa création) : elle reste silencieuse
      // par conception, on ne la publie pas a posteriori.
      if (pred.silentHeld) continue;
      // CORRECTIF « prédiction jamais vue » : une prédiction qui n'a JAMAIS
      // été publiée avant sa résolution pour une AUTRE raison (ex.
      // requireCombo actif et jamais confirmée par une 2ᵉ règle, ou un échec
      // d'envoi Telegram passé inaperçu) était clôturée en silence par
      // verify() ci-dessus — gagnée ou perdue, rien n'apparaissait jamais sur
      // le canal. On publie désormais le résultat final dans ce cas : pour
      // une prédiction jamais envoyée on utilise send() (pas update(), qui ne
      // fait rien sans message existant), avec son statut déjà réglé
      // (gagné/perdu) par verify() — le message affiche directement le
      // résultat, jamais une prédiction « en attente » obsolète.
      if (pred.status === 'gagné' || pred.status === 'perdu') await send(pred);
      // une prédiction 'annulé' (données illisibles, voir verify() plus haut)
      // jamais envoyée n'est PAS publiée a posteriori : ce n'est pas un vrai
      // résultat de jeu, l'annoncer publiquement serait juste trompeur.
    }
    const created = mergeCombos(makePredictions(games));
    // prédictions encore valables mais jamais publiées (canal absent, erreur
    // Telegram, filtre pas encore armé, bot redémarré) : on retente l'envoi
    // à chaque tour — c'est aussi ce qui permet à une prédiction retenue par
    // le filtre « pertes rapprochées » de partir dès que celui-ci s'arme.
    const last = lastFinishedNumber(games);
    const unsent = panel.predictions.filter(
      (p) => p.status === 'en attente' && !p.messages.length && p.target > last && !created.includes(p),
    );
    for (const pred of [...created, ...unsent]) {
      if (panel.requireCombo && !pred.combo) continue;
      if (panel.silentMode && !panel.silentGate.armed) { pred.silentHeld = true; continue; }
      pred.silentHeld = false;
      if (pred.messages.length && !pred.resend) continue;
      pred.resend = false;
      // combo confirmé sur une prédiction DÉJÀ envoyée : on modifie le
      // message existant, on n'en envoie jamais un second (ça créait un
      // doublon visible dans le canal).
      if (pred.messages.length) { await update(pred); continue; }
      await send(pred);
    }
    if (!panel.certified.length) {
      panel.lastError = panel.channels.length
        ? `Aucune stratégie IA au-dessus de ${panel.minRate}% pour l'instant : rien à envoyer.`
        : 'Aucun canal configuré pour le panneau Prédit';
    }
    panel.lastScanAt = Date.now();
  } catch (e) {
    panel.lastError = e.message;
  } finally {
    persist();
    busy = false;
  }
  return panel;
}

// ---------------------------------------------------------------------------
// Bilan complet des prédictions IA (envoyé quand le jeu repart au n°1)
// ---------------------------------------------------------------------------
function globalBilanText() {
  const b = bilanOf(panel.predictions);
  const nb = new Set(panel.predictions.flatMap((p) => p.sources.map((s) => s.id))).size;
  return (
    '📊 BILAN GLOBAL — PRÉDICTIONS IA 🤖\n\n' +
    `🧠 Stratégies IA ayant prédit : ${nb}\n` +
    `🎯 Prédictions : ${b.total}\n\n` +
    `🟢 GAIN : ${b.win}\n` +
    `🔴 PERTE : ${b.loss}\n\n` +
    `✅ Taux de réussite : ${b.rate} %`
  );
}

// Envoie UN SEUL bilan global « Prédit IA » (toutes stratégies confondues),
// puis remet les compteurs à zéro pour repartir sur une nouvelle journée.
// CORRECTIF : avant, un message était envoyé PAR stratégie IA ayant prédit,
// en plus du bilan global — plusieurs bilans au lieu d'un seul.
async function sendBilans() {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  if (!panel.channels.length) return { ok: false, error: 'Aucun canal configuré pour le panneau Prédit' };
  const text = globalBilanText();
  const sent = [];
  const errors = [];
  for (const id of panel.channels) {
    try { await bot.sendMessage(id, text); sent.push(String(id)); panel.sentCount = (panel.sentCount || 0) + 1; }
    catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  panel.lastError = errors.length ? errors[0] : panel.lastError;
  // un bilan par jour, puis on repart à zéro : seules les prédictions encore
  // « en attente » (en cours) restent affichées ; l'historique reste en base.
  panel.predictions = panel.predictions.filter((p) => p.status === 'en attente');
  persist();
  return { ok: sent.length > 0, sent, errors, count: 1 };
}

async function test() {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  if (!panel.channels.length) return { ok: false, error: 'Aucun canal configuré' };
  const preview = fmt.formatPreview(panel.format, { maxR: panel.maxR });
  const sent = [];
  const errors = [];
  for (const id of panel.channels) {
    try {
      await bot.sendMessage(id, `🎯 PRÉDIT — message de test\n\nFormat ${panel.format} :\n\n${preview}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

function status() {
  const active = activeCertified();
  const perfectPriority = hasPerfectPriority(active);
  return {
    ...config(),
    running: panel.enabled,
    formatPreview: fmt.formatPreview(panel.format, { maxR: panel.maxR }),
    silentGate: { ...panel.silentGate },
    certified: panel.certified.map((c) => ({
      id: c.id, type: c.type, name: c.name, finding: c.finding, motif: c.motif || '',
      rate: c.rate, sample: c.sample, used: c.used || 0, quota: panel.perStrategy,
      win: c.win, loss: c.loss, certifiedAt: c.certifiedAt,
      // en attente = règle valide (>= minRate) mais mise en pause ce tour
      // car une règle à 100% est prioritaire
      waitingForPerfect: perfectPriority && c.rate < 100 && (c.used || 0) < panel.perStrategy,
    })),
    retired: panel.retired.slice(0, 10),
    autoDouble: active.length >= 2,
    activeCount: active.length,
    perfectPriorityActive: perfectPriority,
    strategies: strategiesView(),
    globalBilan: bilanOf(panel.predictions),
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
  };
}

module.exports = { panel, status, config, configure, restore, restoreFromDb, setSender, tick, mirror, test, parseChannels, sendBilans, globalBilanText, strategiesView };
