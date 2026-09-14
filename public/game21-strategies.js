// game21-strategies.js — création et suivi des STRATÉGIES IA du jeu « 21 ».
//
// Même esprit que la création de stratégie IA du Baccara (ai-repair.js) mais
// appliqué au jeu 21 : la stratégie est construite à partir des DÉCLENCHEURS
// réellement observés (dernière carte d'un tour → carte de valeur A/K/Q/J ou
// carte de valeur EXACTE au tour suivant), pour une variante précise
// (« 21 classique » ou « 21 »). Le texte de la règle est toujours LISIBLE :
// « quand tu vois <déclencheur>, attends <cible> au tour suivant ».
//
// Les stratégies sont enregistrées dans data.json (clé game21Strategies) et
// sont créées DÉSACTIVÉES par sécurité, exactement comme côté Baccara.
'use strict';

const store = require('./store');
const ai = require('./ai-analyzer');
const game21 = require('./game21');

const MAX_STRATEGIES = 60;
const MIN_SAMPLE = 2;

function load() {
  const data = store.read();
  const list = Array.isArray(data.game21Strategies) ? data.game21Strategies : [];
  return list;
}
function save(list) {
  store.patch({ game21Strategies: list.slice(0, MAX_STRATEGIES) });
  return list;
}
function newId() {
  return `g21_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Choix du meilleur déclencheur disponible pour la variante demandée
// ---------------------------------------------------------------------------
function pickTriggers(analysis, wanted) {
  const value = (analysis.valueTriggers || []).filter((t) => t.total >= MIN_SAMPLE);
  const exact = (analysis.exactTriggers || []).filter((t) => t.total >= MIN_SAMPLE && t.hit >= 2);
  if (wanted === 'exacte') return { kind: 'exacte', best: exact[0] || null, exact, value };
  if (wanted === 'valeur') return { kind: 'valeur', best: value[0] || null, exact, value };
  // auto : on garde le taux le plus élevé des deux familles
  const bv = value[0]; const be = exact[0];
  if (bv && (!be || bv.rate >= be.rate)) return { kind: 'valeur', best: bv, exact, value };
  if (be) return { kind: 'exacte', best: be, exact, value };
  return { kind: 'valeur', best: null, exact, value };
}

function wantedKindFrom(description) {
  const d = String(description || '').toLowerCase();
  if (/exact|costume|♦|♠|❤|♣|couleur/.test(d)) return 'exacte';
  if (/valeur|a\b|k\b|q\b|j\b|figure/.test(d)) return 'valeur';
  return 'auto';
}

function readableRule(kind, best, variantLabel) {
  if (kind === 'exacte') {
    return `Sur « ${variantLabel} » : dès que la dernière carte visible d'un tour est ${best.trigger}, `
      + `attends la carte exacte ${best.card} au tour suivant (observé ${best.hit} fois sur ${best.total} → ${best.rate} %).`;
  }
  return `Sur « ${variantLabel} » : dès que la dernière carte visible d'un tour est ${best.trigger}, `
    + `attends une carte de valeur (A, K, Q ou J) au tour suivant (observé ${best.hit} fois sur ${best.total} → ${best.rate} %).`;
}

// ---------------------------------------------------------------------------
// Création
// ---------------------------------------------------------------------------
async function create({ description = '', variant = 'classique' } = {}) {
  const v = game21.VARIANTS[variant] ? variant : 'simple';
  const label = game21.variantLabel(v);
  if (!game21.state.updatedAt) await game21.refresh();
  const analysis = game21.analysis({ variant: v, minSample: MIN_SAMPLE });
  if (!analysis.rounds) {
    throw new Error(`Aucun tour « ${label} » enregistré pour l'instant : laisse tourner la lecture en direct quelques minutes puis réessaie.`);
  }
  const wanted = wantedKindFrom(description);
  const { kind, best, exact, value } = pickTriggers(analysis, wanted);
  if (!best) {
    throw new Error(`Pas encore assez de tours « ${label} » pour dégager un déclencheur fiable (${analysis.rounds} tour(s) analysé(s)).`);
  }

  const target = kind === 'exacte'
    ? { type: 'exacte', card: best.card, label: `carte exacte ${best.card}` }
    : { type: 'valeur', card: null, label: 'carte de valeur (A, K, Q, J)' };

  const rule = readableRule(kind, best, label);

  // Avis IA (facultatif) : nom + explication. Si l'IA n'est pas joignable, la
  // stratégie est quand même créée avec sa règle lisible calculée en local.
  let name = `${best.trigger} → ${target.label} · ${label}`;
  let explanation = '';
  let aiError = null;
  try {
    const system = [
      `Tu crées une stratégie de jeu pour le jeu de cartes « ${label} » (TwentyOne) de 1xbet.`,
      'Tu ne dois utiliser QUE les statistiques de déclencheurs fournies, sans inventer de chiffres.',
      'Réponds en JSON strict : {"name": "...", "explanation": "..."}.',
      'name : titre court en français (max 70 caractères).',
      'explanation : 3 à 5 phrases en français simple qui expliquent quand jouer,',
      'quoi attendre au tour suivant, et quand ne pas jouer.',
    ].join(' ');
    const user = [
      `Demande de l'utilisateur : ${description || 'stratégie sur le déclencheur le plus fiable'}`,
      `Variante : ${label}. Tours analysés : ${analysis.rounds}.`,
      `Déclencheur retenu : ${best.trigger} → ${target.label} (${best.hit}/${best.total} = ${best.rate} %).`,
      '',
      'Autres déclencheurs → carte de valeur :',
      ...value.slice(0, 8).map((t) => `  ${t.trigger} → ${t.hit}/${t.total} = ${t.rate}%`),
      '',
      'Autres déclencheurs → carte exacte :',
      ...exact.slice(0, 8).map((t) => `  ${t.trigger} → ${t.card} : ${t.hit}/${t.total} = ${t.rate}%`),
    ].join('\n');
    const text = await ai.chat({ system, user, temperature: 0.2, timeoutMs: 30000 });
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed.name) name = String(parsed.name).slice(0, 120);
      if (parsed.explanation) explanation = String(parsed.explanation).slice(0, 1500);
    } else if (text) {
      explanation = String(text).slice(0, 1500);
    }
  } catch (e) {
    aiError = e.message;
  }

  const entry = {
    id: newId(),
    createdAt: Date.now(),
    variant: v,
    variantLabel: label,
    name,
    description: String(description || '').slice(0, 500),
    trigger: best.trigger,
    target,
    rule,                 // texte lisible du déclencheur
    hit: best.hit,
    sample: best.total,
    rate: best.rate,
    rounds: analysis.rounds,
    explanation,
    enabled: false,       // sécurité : désactivée à la création
    aiError,
  };

  const list = [entry, ...load()];
  save(list);
  return entry;
}

// ---------------------------------------------------------------------------
// Gestion
// ---------------------------------------------------------------------------
function remove(id) {
  const list = load().filter((s) => s.id !== id);
  save(list);
  return list;
}
function toggle(id, enabled) {
  const list = load().map((s) => (s.id === id ? { ...s, enabled: enabled !== false } : s));
  save(list);
  return list.find((s) => s.id === id) || null;
}

// Relecture en direct : pour chaque stratégie, on regarde si le déclencheur
// est celui du dernier tour terminé de sa variante → signal lisible.
function signals() {
  const list = load();
  return list.map((s) => {
    const last = game21.historyOf(s.variant)[0];
    const current = last ? game21.triggerOf(last) : null;
    const active = !!current && current === s.trigger;
    return {
      ...s,
      currentTrigger: current,
      active,
      message: active
        ? `Déclencheur ${s.trigger} détecté au tour #${last.number ?? '?'} (${last.tableName}) → attends ${s.target.label} au tour suivant.`
        : `En attente du déclencheur ${s.trigger}${current ? ` (dernière carte vue : ${current})` : ''}.`,
    };
  });
}

function status() {
  const list = signals();
  return {
    strategies: list,
    total: list.length,
    enabled: list.filter((s) => s.enabled).length,
    active: list.filter((s) => s.enabled && s.active).length,
  };
}

module.exports = { create, remove, toggle, list: load, signals, status };
