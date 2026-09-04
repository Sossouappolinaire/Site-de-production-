// formation.js — bouton « Formation » (page Analyseur IA)
//
// Idée : pour chaque stratégie (y compris la stratégie IA « Prédit »), on
// repère chaque fois qu'une prédiction a perdu ou est passée par un
// rattrapage (« un incident »), puis on compte COMBIEN de prédictions
// D'AFFILÉE sont validées juste après cet incident, avant la perte
// suivante — un peu comme le mode silencieux (phase de décompte avant
// confirmation). On en déduit la plus longue série (« formation ») dont le
// taux de réussite reste au-dessus du seuil de fiabilité.
//
// Exemple de constat produit : « après une perte ou un rattrapage, les 3
// prédictions suivantes sont validées d'affilée dans 78% des cas ».
//
// Aucune clé IA distante n'est nécessaire : moteur statistique local, dans
// le même esprit que pattern-miner.js mais appliqué aux RÉSULTATS de
// prédictions (gagné/perdu/rattrapage) plutôt qu'aux cartes.
'use strict';

const strategiesLib = require('./strategies');
const db = require('./db');
const { state } = require('./predictor');
const predit = require('./predit');
const ai = require('./ai-analyzer');

// nombre minimum d'incidents (perte/rattrapage) observés avant de publier
// un taux pour un palier donné : sous ce seuil, le chiffre serait instable.
const MIN_SUPPORT = 5;
// taux minimum pour qu'un palier soit considéré comme une « formation »
// fiable plutôt qu'une simple coïncidence.
const THRESHOLD = 65;
// on regarde jusqu'à 5 prédictions d'affilée après l'incident.
const MAX_N = 5;

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

const runtime = {
  lastRunAt: null,
  lastError: null,
  strategies: [],
  sample: 0,
  remote: null,
  remoteAt: null,
};

// classe l'issue d'une prédiction TERMINÉE :
//  - 'perte'      : status perdu
//  - 'rattrapage' : gagné, mais pas du premier coup (step/rattrapage > 0)
//  - 'direct'     : gagné du premier coup (step 0)
//  - null         : prédiction encore en attente (ignorée)
function outcomeOf(status, step) {
  if (status === 'perdu') return 'perte';
  if (status === 'gagné' || status === 'gagne') return (Number(step) || 0) > 0 ? 'rattrapage' : 'direct';
  return null;
}

// pour chaque incident (perte ou rattrapage), compte la série de
// prédictions VALIDÉES (direct ou rattrapage) qui suivent immédiatement,
// jusqu'à la prochaine perte (ou la fin des données disponibles).
// `available` = nombre de prédictions connues après l'incident (sert à ne
// comparer que des incidents ayant assez de « futur » observé pour chaque
// palier N, plutôt que de fausser le taux avec des incidents trop récents).
function troubleRuns(list) {
  const done = (list || [])
    .filter((p) => p && outcomeOf(p.status, p.step) !== null)
    .sort((a, b) => (Number(a.target) || 0) - (Number(b.target) || 0));
  const outcomes = done.map((p) => outcomeOf(p.status, p.step));
  const events = [];
  for (let i = 0; i < outcomes.length; i += 1) {
    if (outcomes[i] !== 'perte' && outcomes[i] !== 'rattrapage') continue;
    const future = outcomes.slice(i + 1);
    let run = 0;
    for (const o of future) {
      if (o === 'perte') break;
      run += 1; // 'direct' ou 'rattrapage' = validée
    }
    events.push({ run, available: future.length });
  }
  return { events, doneCount: done.length };
}

// taux de réussite pour chaque palier N = 1..MAX_N : parmi les incidents
// ayant AU MOINS N prédictions connues ensuite, combien ont vu les N
// premières validées d'affilée.
function chainRates(events) {
  const rates = [];
  for (let n = 1; n <= MAX_N; n += 1) {
    const elig = events.filter((e) => e.available >= n);
    if (!elig.length) break;
    const hits = elig.filter((e) => e.run >= n).length;
    rates.push({ n, support: elig.length, hits, rate: pct(hits, elig.length) });
  }
  return rates;
}

// choisit la formation la plus longue qui reste fiable (échantillon et
// taux suffisants) ; sinon replie sur le palier 1 seul (même sous le seuil,
// pour au moins donner une indication) si l'échantillon existe.
function bestFormation(rates) {
  let best = null;
  for (const r of rates) {
    if (r.support >= MIN_SUPPORT && r.rate >= THRESHOLD) best = r; // garde le plus long qui qualifie
  }
  if (best) return best;
  return rates.find((r) => r.n === 1 && r.support >= MIN_SUPPORT) || null;
}

// CORRECTIF (bug racine) : bestFormation() ci-dessus a un repli (dernière
// ligne) qui renvoie le palier n=1 dès que l'échantillon est suffisant,
// SANS revérifier le taux — un palier à 20% de réussite avec 8 observations
// passait donc ce repli et ressortait comme "best" au même titre qu'un vrai
// palier fiable. Tout code qui décidait de la fiabilité avec `!!best` était
// donc silencieusement faux dans ce cas précis. isReliable() est le SEUL
// endroit qui doit servir à répondre « peut-on faire confiance à ce best ? »
// — n'utilisez plus jamais `!!best` seul pour ça.
function isReliable(best) {
  return !!best && best.support >= MIN_SUPPORT && best.rate >= THRESHOLD;
}

function findingText(name, events, rates) {
  const lines = [];
  if (!rates.length) return lines;
  const best = bestFormation(rates);
  if (best) {
    // CORRECTIF : ne plus affirmer une formation comme si elle était acquise
    // quand `best` vient du repli n=1 (échantillon suffisant mais taux sous
    // le seuil de fiabilité) — voir isReliable() ci-dessus. On garde
    // l'information (utile pour l'admin), mais avec une réserve explicite,
    // au lieu de la présenter avec la même assurance qu'un vrai palier fiable.
    const caveat = isReliable(best) ? '' : ' — échantillon encore faible ou taux sous le seuil de fiabilité, à confirmer';
    if (best.n === 1) {
      lines.push(
        `J'ai remarqué que pour « ${name} », quand une prédiction perd ou passe par un rattrapage, ` +
        `la prédiction suivante est validée dans ${best.rate}% des cas (${best.hits}/${best.support} observations)${caveat}.`
      );
    } else {
      lines.push(
        `J'ai remarqué que pour « ${name} », quand une prédiction perd ou passe par un rattrapage, ` +
        `les ${best.n} prédictions suivantes sont validées d'affilée dans ${best.rate}% des cas ` +
        `(${best.hits}/${best.support} observations) — une formation probable de ${best.n}${caveat}.`
      );
    }
  }
  if (rates.length > 1) {
    lines.push(`Détail par palier : ${rates.map((r) => `${r.n} suivante(s) validée(s) → ${r.rate}% (${r.hits}/${r.support})`).join(' · ')}.`);
  }
  lines.push(`Basé sur ${events.length} perte(s)/rattrapage(s) observé(s) au total pour cette stratégie.`);
  return lines;
}

// ---------------------------------------------------------------------------
// « Retour du costume après une perte » : pour chaque prédiction PERDUE
// d'une stratégie, on regarde si le costume qui avait été prédit (et qui a
// donc raté ce jeu-là) réapparaît sur la main du JOUEUR au jeu +1, +2, +3,
// +4 ou +5 qui suit — et si oui, à quel décalage ça arrive le plus souvent.
// Répond à : « après une perte, le costume prédit revient en général à
// combien de jeux plus tard, dans la majorité des cas ? »
// Source des jeux : table `games` en base (historique complet, tous jours
// confondus) — avec repli sur la mémoire (manche en cours) si la base n'est
// pas connectée ou si un jeu demandé n'y est pas encore.
// ---------------------------------------------------------------------------
const SUIT_RETURN_MAX_N = 5;

// ---------------------------------------------------------------------------
// « Miroir du costume réellement sorti après une perte » (demande admin) :
// pour chaque prédiction PERDUE, on regarde quel costume est VRAIMENT sorti
// sur la main du joueur ce jeu-là (1ère carte de la main), on prend son
// miroir (❤️↔♦️, ♠️↔♣️ — voir strategies.MIRROR), et on vérifie si CE
// costume miroir apparaît ensuite sur la main du joueur au jeu +1 à +5.
// Sert à comparer objectivement cette approche à « suitReturnAfterLoss »
// (rejouer le costume raté lui-même) avant de l'activer en production
// (voir after-loss.js, tracker.repeat.mode = 'miroir').
// ---------------------------------------------------------------------------
async function mirrorAfterLoss(predictions) {
  const losses = (predictions || []).filter(
    (p) => p && p.status === 'perdu' && p.suit && Number.isFinite(Number(p.target))
  );
  if (!losses.length) return null;

  const targets = losses.map((p) => Number(p.target));
  const minG = Math.min(...targets);
  const maxG = Math.max(...targets) + SUIT_RETURN_MAX_N;

  const suitsByNumber = new Map();
  if (db.ready) {
    try {
      const rows = await db.gamesInRange(minG, maxG);
      for (const r of rows) suitsByNumber.set(Number(r.number), r.player_suits || []);
    } catch (_) { /* repli mémoire ci-dessous */ }
  }
  if (!suitsByNumber.size) {
    for (const g of state.games.values()) {
      if (g.number >= minG && g.number <= maxG) suitsByNumber.set(g.number, g.playerSuits || []);
    }
  }
  if (!suitsByNumber.size) return null;

  const perN = Array.from({ length: SUIT_RETURN_MAX_N }, () => ({ hits: 0, support: 0 }));
  let usable = 0;
  for (const p of losses) {
    const t = Number(p.target);
    const actualSuits = strategiesLib.suitsOf(suitsByNumber.get(t) || []);
    const actualSuit = actualSuits[0];
    const mirror = actualSuit ? strategiesLib.MIRROR[actualSuit] : null;
    if (!mirror) continue; // jeu du déclencheur pas (encore) connu, ou costume non reconnu
    usable += 1;
    for (let n = 1; n <= SUIT_RETURN_MAX_N; n += 1) {
      const suits = suitsByNumber.get(t + n);
      if (suits === undefined) continue;
      perN[n - 1].support += 1;
      if (strategiesLib.suitsOf(suits).includes(mirror)) perN[n - 1].hits += 1;
    }
  }
  if (!usable) return null;
  const rates = perN
    .map((e, i) => ({ n: i + 1, support: e.support, hits: e.hits, rate: pct(e.hits, e.support) }))
    .filter((r) => r.support > 0);
  if (!rates.length) return null;

  const qualifying = rates.filter((r) => r.support >= MIN_SUPPORT);
  const best = qualifying.length
    ? qualifying.reduce((acc, r) => (r.rate > acc.rate ? r : acc))
    : rates.slice().sort((a, b) => b.support - a.support)[0];

  return { totalLosses: losses.length, usable, rates, best, reliable: qualifying.length > 0 };
}

function mirrorAfterLossFinding(name, mirror) {
  if (!mirror || !mirror.best) return null;
  const b = mirror.best;
  const detail = mirror.rates.length > 1
    ? ` Détail par décalage : ${mirror.rates.map((r) => `+${r.n} → ${r.rate}% (${r.hits}/${r.support})`).join(' · ')}.`
    : '';
  return (
    `Sur ${mirror.usable} perte(s) exploitable(s) pour « ${name} », le MIROIR du costume réellement sorti ` +
    `(❤️↔♦️, ♠️↔♣️) réapparaît sur la main du joueur au jeu +${b.n} dans ${b.rate}% des cas (${b.hits}/${b.support} observations)` +
    `${mirror.reliable ? '' : ' — échantillon encore faible, à confirmer'}.${detail}`
  );
}


async function suitReturnAfterLoss(predictions) {
  const losses = (predictions || []).filter(
    (p) => p && p.status === 'perdu' && p.suit && Number.isFinite(Number(p.target))
  );
  if (!losses.length) return null;

  const targets = losses.map((p) => Number(p.target));
  const minG = Math.min(...targets) + 1;
  const maxG = Math.max(...targets) + SUIT_RETURN_MAX_N;

  const suitsByNumber = new Map();
  if (db.ready) {
    try {
      const rows = await db.gamesInRange(minG, maxG);
      for (const r of rows) suitsByNumber.set(Number(r.number), r.player_suits || []);
    } catch (_) { /* repli mémoire ci-dessous */ }
  }
  if (!suitsByNumber.size) {
    // repli mémoire : uniquement les jeux encore connus de la manche en
    // cours (state.games est vidé à chaque nouvelle manche).
    for (const g of state.games.values()) {
      if (g.number >= minG && g.number <= maxG) suitsByNumber.set(g.number, g.playerSuits || []);
    }
  }
  if (!suitsByNumber.size) return null;

  const perN = Array.from({ length: SUIT_RETURN_MAX_N }, () => ({ hits: 0, support: 0 }));
  for (const p of losses) {
    const t = Number(p.target);
    const wanted = strategiesLib.normSuit(p.suit);
    if (!wanted) continue;
    for (let n = 1; n <= SUIT_RETURN_MAX_N; n += 1) {
      const suits = suitsByNumber.get(t + n);
      if (suits === undefined) continue; // jeu pas (encore) connu → hors échantillon pour ce palier
      perN[n - 1].support += 1;
      if (strategiesLib.suitsOf(suits).includes(wanted)) perN[n - 1].hits += 1;
    }
  }
  const rates = perN
    .map((e, i) => ({ n: i + 1, support: e.support, hits: e.hits, rate: pct(e.hits, e.support) }))
    .filter((r) => r.support > 0);
  if (!rates.length) return null;

  // meilleur palier = le plus fiable (échantillon suffisant) au taux le plus
  // haut ; à défaut, celui avec le plus d'observations (indication, moins sûre).
  const qualifying = rates.filter((r) => r.support >= MIN_SUPPORT);
  const best = qualifying.length
    ? qualifying.reduce((acc, r) => (r.rate > acc.rate ? r : acc))
    : rates.slice().sort((a, b) => b.support - a.support)[0];

  return { totalLosses: losses.length, rates, best, reliable: qualifying.length > 0 };
}

function suitReturnFinding(name, suitReturn) {
  if (!suitReturn || !suitReturn.best) return null;
  const b = suitReturn.best;
  const detail = suitReturn.rates.length > 1
    ? ` Détail par décalage : ${suitReturn.rates.map((r) => `+${r.n} → ${r.rate}% (${r.hits}/${r.support})`).join(' · ')}.`
    : '';
  return (
    `Sur ${suitReturn.totalLosses} perte(s) observée(s) pour « ${name} », le costume prédit (raté ce jeu-là) ` +
    `réapparaît sur la main du joueur au jeu +${b.n} dans ${b.rate}% des cas (${b.hits}/${b.support} observations)` +
    `${suitReturn.reliable ? '' : ' — échantillon encore faible, à confirmer'}.${detail}`
  );
}

// ---------------------------------------------------------------------------
// Simulation du « mode silencieux 1 » (confirmation par pertes rapprochées,
// voir predictor.js) REJOUÉE sur l'historique de CHAQUE stratégie, pour
// estimer combien des pertes réellement observées auraient été évitées
// (restées silencieuses, jamais envoyées publiquement) si ce filtre avait
// été actif : 1) une 1ʳᵉ perte ouvre une fenêtre de vérification ; 2) si une
// 2ᵉ perte (ou plus, selon `lossTrigger`) tombe dans les `lossWindow`
// prédictions suivantes → l'envoi est ACTIVÉ à partir de LÀ ; 3) une
// prédiction gagnée referme l'envoi et tout repart à zéro. C'est une version
// simplifiée du principe documenté dans predictor.js (sans la file d'attente
// à plusieurs positions, propre à la stratégie « ombre » en production) —
// suffisante pour estimer, stratégie par stratégie, l'effet du filtre.
// ---------------------------------------------------------------------------
function simulateSilentMode(predictions, { lossTrigger = 2, lossWindow = 3 } = {}) {
  const need = Math.max(1, Math.min(5, parseInt(lossTrigger, 10) || 2));
  const window = Math.max(1, Math.min(20, parseInt(lossWindow, 10) || 3));
  const done = (predictions || [])
    .filter((p) => p && outcomeOf(p.status, p.step) !== null && Number.isFinite(Number(p.target)))
    .sort((a, b) => Number(a.target) - Number(b.target));
  if (!done.length) return null;

  let armed = false;
  let lossesInWindow = 0; // pertes comptées vers la confirmation en cours
  let sinceLastLoss = 0;  // prédictions terminées depuis la dernière perte de référence
  let totalLosses = 0;
  let avoided = 0;
  let stillLost = 0;

  for (const p of done) {
    const isLoss = p.status === 'perdu';
    if (isLoss) totalLosses += 1;

    if (armed) {
      if (isLoss) stillLost += 1;
      else armed = false; // gagné → referme l'envoi (resetOnWin)
      continue;
    }

    // pas encore armé : cette prédiction serait restée silencieuse
    if (isLoss) avoided += 1;

    if (isLoss) {
      lossesInWindow += 1;
      sinceLastLoss = 0;
      if (lossesInWindow >= need) armed = true;
    } else if (lossesInWindow > 0) {
      sinceLastLoss += 1;
      if (sinceLastLoss > window) { lossesInWindow = 0; sinceLastLoss = 0; } // fenêtre dépassée → repart à zéro
    }
  }
  if (!totalLosses) return null;
  return { lossTrigger: need, lossWindow: window, totalLosses, avoided, stillLost, avoidedRate: pct(avoided, totalLosses) };
}

function silentModeFinding(name, silent) {
  if (!silent) return null;
  if (!silent.avoided) {
    return `En simulant le mode silencieux (confirmation par ${silent.lossTrigger} perte(s) rapprochée(s), fenêtre de ${silent.lossWindow}) sur « ${name} », aucune des ${silent.totalLosses} perte(s) observée(s) n'aurait été évitée : le filtre les aurait toutes laissées passer.`;
  }
  return `En simulant le mode silencieux (confirmation par ${silent.lossTrigger} perte(s) rapprochée(s), fenêtre de ${silent.lossWindow}) sur « ${name} », ${silent.avoided} perte(s) sur ${silent.totalLosses} (${silent.avoidedRate}%) seraient restées silencieuses au lieu d'être envoyées publiquement — les ${silent.stillLost} autre(s) seraient quand même parties.`;
}

// Même constat que silentModeFinding() ci-dessus, mais formulé pour
// l'ACHETEUR final (message de fin d'achat envoyé depuis le bot, voir
// shop.js — formationFindingsFor/closingMessage) : jamais le nom technique
// « mode silencieux » (terminologie interne du panneau admin), seulement le
// comportement conseillé en langage clair — jouer dès le rattrapage suivant,
// ou attendre une confirmation (une 2ᵉ perte rapprochée) avant de rejouer.
function silentModeFindingCustomer(name, silent) {
  if (!silent) return null;
  if (!silent.avoided) {
    return `Sur « ${name} », attendre une confirmation supplémentaire après une perte n'aurait évité aucune des ${silent.totalLosses} perte(s) observée(s) : mieux vaut rejouer dès le rattrapage suivant plutôt que patienter.`;
  }
  return `Sur « ${name} », attendre qu'une 2ᵉ perte rapprochée confirme le signal avant de rejouer aurait évité ${silent.avoided} perte(s) sur ${silent.totalLosses} (${silent.avoidedRate}%) — mais les ${silent.stillLost} autre(s) seraient quand même survenue(s). À toi de voir si tu préfères jouer directement après un rattrapage, ou patienter un peu pour plus de sécurité.`;
}

async function buildEntry(key, name, list, silentCfg) {
  const { events, doneCount } = troubleRuns(list);
  const rates = chainRates(events);
  const best = bestFormation(rates);
  const suitReturn = await suitReturnAfterLoss(list);
  const mirror = await mirrorAfterLoss(list);
  const silent = simulateSilentMode(list, silentCfg);

  const findings = findingText(name, events, rates);
  const suitReturnLine = suitReturnFinding(name, suitReturn);
  if (suitReturnLine) findings.push(suitReturnLine);
  const mirrorLine = mirrorAfterLossFinding(name, mirror);
  if (mirrorLine) findings.push(mirrorLine);
  const silentLine = silentModeFinding(name, silent);
  if (silentLine) findings.push(silentLine);

  // Constat destiné à l'ACHETEUR (bot, message de fin d'achat) : mêmes
  // observations que ci-dessus, mais sans jamais nommer « mode silencieux ».
  const customerFindings = findingText(name, events, rates);
  if (suitReturnLine) customerFindings.push(suitReturnLine);
  if (mirrorLine) customerFindings.push(mirrorLine);
  const silentLineCustomer = silentModeFindingCustomer(name, silent);
  if (silentLineCustomer) customerFindings.push(silentLineCustomer);

  return {
    key,
    name,
    sample: doneCount,
    troubleEvents: events.length,
    formationLength: best ? best.n : null,
    rate: best ? best.rate : null,
    support: best ? best.support : 0,
    reliable: isReliable(best),
    findings,
    customerFindings,
    rates,
    suitReturn,
    mirror,
    silentModeBacktest: silent,
  };
}

// source mémoire (state.predictions, jusqu'à 300 lignes toutes stratégies
// confondues — peut être tronqué pour une stratégie ancienne/peu active).
function memoryPredictions(key) {
  return (state.predictions || []).filter((p) => p.strategy === key);
}

// source base de données (journée en cours) : échantillon plus complet que
// la mémoire quand PostgreSQL est connecté, car non plafonné à 300 lignes.
async function dbPredictions(key) {
  if (!db.ready) return [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.predictionsByDate(today, 1000);
    return rows
      .filter((r) => r.strategy === key)
      .map((r) => ({ target: r.target, status: r.status, step: r.rattrapage }));
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Enrichissement IA distante (optionnel) : l'IA (Pollinations/Gemini/Groq
// selon la clé configurée) relit les chiffres du moteur LOCAL — elle ne
// calcule rien elle-même — et rend un avis prudent : cohérence des paliers,
// fiabilité de l'échantillon, quelle formation est la plus exploitable en
// ce moment. Reste facultatif : le panneau fonctionne entièrement sans elle.
// ---------------------------------------------------------------------------
function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try { return JSON.parse(candidate); } catch (_) { /* essaie la découpe ci-dessous */ }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch (_) { /* abandonne */ }
  }
  return null;
}

async function runRemote(localStrategies) {
  const system = [
    "Tu es un analyste prudent des prédictions Baccarat.",
    "Tu ne calcules RIEN toi-même : les taux et échantillons fournis viennent déjà d'un moteur statistique local — tu dois seulement les COMMENTER, jamais en inventer de nouveaux.",
    "Pour chaque stratégie, on te donne, pour chaque palier N (1 à 5 prédictions validées d'affilée après une perte ou un rattrapage), le taux mesuré et le nombre d'observations.",
    "Vérifie la cohérence (le taux doit normalement baisser ou rester stable quand N augmente, jamais remonter fortement), signale tout échantillon trop faible pour être fiable, et dis clairement laquelle des stratégies présente la formation la plus exploitable EN CE MOMENT — sans jamais garantir un résultat futur.",
    "Réponds uniquement avec un JSON valide, sans Markdown.",
  ].join(' ');
  const user = {
    demande: "Commente ces constats de formation (série de prédictions validées après une perte/rattrapage) et donne un avis prudent.",
    seuils: { supportMinimum: MIN_SUPPORT, tauxMinimumFiable: THRESHOLD },
    strategies: localStrategies.map((s) => ({
      nom: s.name,
      incidentsObserves: s.troubleEvents,
      formationRetenueLocalement: s.formationLength,
      tauxRetenuLocalement: s.rate,
      paliers: s.rates,
    })),
    formatReponse: {
      title: 'titre court',
      observation: "résumé factuel de ce que montrent les chiffres, prudence incluse",
      meilleureStrategie: 'nom de la stratégie la plus exploitable en ce moment, ou null',
      findings: ['constat 1', 'constat 2'],
      risks: 'limites de cette analyse (échantillon, instabilité...)',
    },
  };
  const text = await ai.chat({ system, user, temperature: 0.2, timeoutMs: 45000 });
  const result = extractJson(text);
  if (!result) {
    const error = new Error("La réponse de l'IA n'est pas un JSON exploitable.");
    error.code = 'AI_INVALID_RESPONSE';
    throw error;
  }
  return { ...result, source: `IA — ${ai.chatRoute() || 'pollinations'}`, generatedAt: new Date().toISOString() };
}

async function run({ remote = false } = {}) {
  try {
    const out = [];
    for (const def of strategiesLib.LIST) {
      const mem = memoryPredictions(def.key);
      const dbRows = await dbPredictions(def.key);
      const list = dbRows.length >= mem.length ? dbRows : mem;
      const cfg = state.strategies && state.strategies[def.key];
      const silentCfg = { lossTrigger: cfg && cfg.lossTrigger, lossWindow: cfg && cfg.lossWindow };
      out.push(await buildEntry(def.key, def.name, list, silentCfg));
    }
    // stratégie IA « Prédit » : vit dans son propre module (predit.js), pas
    // dans strategies.LIST — traitée séparément mais avec le même moteur.
    const preditList = (predit.panel.predictions || []).map((p) => ({ target: p.target, status: p.status, step: p.step, suit: p.suit }));
    out.push(await buildEntry('predit', 'Prédit (IA)', preditList, {}));

    out.sort((a, b) => (Number(b.reliable) - Number(a.reliable)) || (b.formationLength || 0) - (a.formationLength || 0) || (b.rate || 0) - (a.rate || 0));

    runtime.strategies = out;
    runtime.sample = out.reduce((acc, s) => acc + (s.sample || 0), 0);
    runtime.lastRunAt = Date.now();
    runtime.lastError = null;

    if (remote) {
      const withData = out.filter((s) => s.troubleEvents >= MIN_SUPPORT);
      if (!withData.length) {
        runtime.lastError = "Pas encore assez de pertes/rattrapages observés pour demander un avis IA.";
      } else {
        try {
          runtime.remote = await runRemote(withData);
          runtime.remoteAt = Date.now();
        } catch (e) {
          runtime.lastError = e.message;
        }
      }
    }

    return status_();
  } catch (e) {
    runtime.lastError = e.message;
    return status_();
  }
}

function status_() {
  return {
    lastRunAt: runtime.lastRunAt,
    lastError: runtime.lastError,
    sample: runtime.sample,
    minSupport: MIN_SUPPORT,
    threshold: THRESHOLD,
    strategies: runtime.strategies,
    remote: runtime.remote,
    remoteAt: runtime.remoteAt,
  };
}

module.exports = { run, status: status_, runtime };
