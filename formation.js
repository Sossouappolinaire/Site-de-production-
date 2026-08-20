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

function findingText(name, events, rates) {
  const lines = [];
  if (!rates.length) return lines;
  const best = bestFormation(rates);
  if (best) {
    if (best.n === 1) {
      lines.push(
        `J'ai remarqué que pour « ${name} », quand une prédiction perd ou passe par un rattrapage, ` +
        `la prédiction suivante est validée dans ${best.rate}% des cas (${best.hits}/${best.support} observations).`
      );
    } else {
      lines.push(
        `J'ai remarqué que pour « ${name} », quand une prédiction perd ou passe par un rattrapage, ` +
        `les ${best.n} prédictions suivantes sont validées d'affilée dans ${best.rate}% des cas ` +
        `(${best.hits}/${best.support} observations) — une formation probable de ${best.n}.`
      );
    }
  }
  if (rates.length > 1) {
    lines.push(`Détail par palier : ${rates.map((r) => `${r.n} suivante(s) validée(s) → ${r.rate}% (${r.hits}/${r.support})`).join(' · ')}.`);
  }
  lines.push(`Basé sur ${events.length} perte(s)/rattrapage(s) observé(s) au total pour cette stratégie.`);
  return lines;
}

function buildEntry(key, name, list) {
  const { events, doneCount } = troubleRuns(list);
  const rates = chainRates(events);
  const best = bestFormation(rates);
  return {
    key,
    name,
    sample: doneCount,
    troubleEvents: events.length,
    formationLength: best ? best.n : null,
    rate: best ? best.rate : null,
    support: best ? best.support : 0,
    reliable: !!best,
    findings: findingText(name, events, rates),
    rates,
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
      out.push(buildEntry(def.key, def.name, list));
    }
    // stratégie IA « Prédit » : vit dans son propre module (predit.js), pas
    // dans strategies.LIST — traitée séparément mais avec le même moteur.
    const preditList = (predit.panel.predictions || []).map((p) => ({ target: p.target, status: p.status, step: p.step }));
    out.push(buildEntry('predit', 'Prédit (IA)', preditList));

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
