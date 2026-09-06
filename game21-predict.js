// game21-predict.js — panneau « Prédiction IA jeu 21 »
//
// Ce panneau publie des prédictions sur les jeux « 21 » de 1xbet à partir des
// DÉCLENCHEURS IA déjà calculés par game21.js (dernière carte visible d'un
// tour → ce qui tombe au tour suivant) ET des stratégies IA du 21 créées par
// l'admin (game21-strategies.js).
//
// Règles demandées :
//   • le « 21 classique » est prédit À PART du « 21 » (variante simple) ;
//   • pour chaque variante, on ne prédit QUE deux choses :
//       – la CARTE EXACTE (ex. K♦️)
//       – la CARTE DE VALEUR (A, K, Q ou J, sans costume)
//   • le taux de fiabilité minimum accordé est de 70 % ;
//   • les CARTES EXACTES ont leur propre format de message et leur propre
//     canal Telegram ; les CARTES DE VALEUR ont les leurs. Les deux flux ne
//     se mélangent jamais.
'use strict';

const store = require('./store');
const fmt = require('./formats');
const game21 = require('./game21');
const g21Strategies = require('./game21-strategies');

const VARIANTS = ['classique', 'simple'];
const VALUE_RANKS = ['A', 'K', 'Q', 'J'];
const MAX_PREDICTIONS = 200;

const panel = {
  enabled: true,
  minRate: 70,          // pourcentage accordé (demande admin : 70 %)
  minSample: 3,         // observations minimum d'un déclencheur
  useStrategies: true,  // utiliser aussi les stratégies IA du 21 activées
  variants: { classique: true, simple: true },

  // flux « carte exacte » : format + canaux qui lui sont propres
  exactFormat: 1,
  exactChannels: [],

  // flux « carte de valeur » : format + canaux qui lui sont propres
  valueFormat: 1,
  valueChannels: [],

  predictions: [],
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
  if (patch.useStrategies !== undefined) panel.useStrategies = !!patch.useStrategies;
  if (patch.minRate !== undefined) {
    const v = parseInt(patch.minRate, 10);
    panel.minRate = Math.max(70, Math.min(100, Number.isFinite(v) ? v : 70));
  }
  if (patch.minSample !== undefined) {
    panel.minSample = Math.max(2, Math.min(40, parseInt(patch.minSample, 10) || 3));
  }
  if (patch.exactFormat !== undefined) panel.exactFormat = fmt.clampFormat(patch.exactFormat);
  if (patch.valueFormat !== undefined) panel.valueFormat = fmt.clampFormat(patch.valueFormat);
  if (patch.exactChannels !== undefined) panel.exactChannels = parseChannels(patch.exactChannels);
  if (patch.valueChannels !== undefined) panel.valueChannels = parseChannels(patch.valueChannels);
  if (patch.variants !== undefined && patch.variants && typeof patch.variants === 'object') {
    panel.variants = {
      classique: patch.variants.classique !== false,
      simple: patch.variants.simple !== false,
    };
  }
  persist();
  return config();
}

function config() {
  return {
    enabled: panel.enabled,
    minRate: panel.minRate,
    minSample: panel.minSample,
    useStrategies: panel.useStrategies,
    variants: panel.variants,
    exactFormat: panel.exactFormat,
    exactChannels: panel.exactChannels,
    valueFormat: panel.valueFormat,
    valueChannels: panel.valueChannels,
  };
}

function persist() {
  try { store.patch({ game21Predict: config() }); } catch (_) {}
}

function restore() {
  try {
    const saved = (store.read() || {}).game21Predict;
    if (saved) configure({ ...saved });
  } catch (_) {}
  return config();
}

// ---------------------------------------------------------------------------
// Lecture des tours
// ---------------------------------------------------------------------------
function cardsOf(g) {
  return [...(g.player || []), ...(g.dealer || [])];
}
function ranksOf(g) {
  return [...(g.playerRanks || []), ...(g.dealerRanks || [])];
}
function hasValueCard(g) {
  return ranksOf(g).some((r) => VALUE_RANKS.includes(r));
}
function timeOf(g) {
  return g ? (g.startsAt || g.at || 0) : 0;
}
function suitOfCard(card) {
  const m = String(card || '').match(/[♠♣♦❤♥]\uFE0F?/);
  return m ? m[0] : '♦️';
}
function rankOfCard(card) {
  return String(card || '').replace(/[♠♣♦❤♥\uFE0F]/g, '');
}

// ---------------------------------------------------------------------------
// Choix des prédictions (déclencheurs IA + stratégies IA du 21)
// ---------------------------------------------------------------------------
function candidatesFor(variant) {
  const out = [];
  const analysis = game21.analysis({ variant, minSample: panel.minSample });
  if (!analysis.rounds) return out;
  const last = game21.historyOf(variant)[0];
  const trigger = last ? game21.triggerOf(last) : null;
  if (!trigger) return out;

  // 1) déclencheur IA → carte exacte
  const exact = (analysis.exactTriggers || [])
    .filter((t) => t.trigger === trigger && t.total >= panel.minSample && t.rate >= panel.minRate)
    .sort((a, b) => b.rate - a.rate || b.total - a.total)[0];
  if (exact) {
    out.push({
      kind: 'exacte', variant, trigger, card: exact.card,
      rate: exact.rate, hit: exact.hit, sample: exact.total, source: 'Déclencheur IA',
    });
  }

  // 2) déclencheur IA → carte de valeur
  const value = (analysis.valueTriggers || [])
    .find((t) => t.trigger === trigger && t.total >= panel.minSample && t.rate >= panel.minRate);
  if (value) {
    out.push({
      kind: 'valeur', variant, trigger, card: null,
      rate: value.rate, hit: value.hit, sample: value.total, source: 'Déclencheur IA',
    });
  }

  // 3) stratégies IA du 21 activées dont le déclencheur est actif
  if (panel.useStrategies) {
    let signals = [];
    try { signals = g21Strategies.signals() || []; } catch (_) { signals = []; }
    for (const s of signals) {
      if (!s.enabled || !s.active) continue;
      if ((s.variant || 'simple') !== variant) continue;
      if (!(s.rate >= panel.minRate)) continue;
      const kind = s.target && s.target.type === 'exacte' ? 'exacte' : 'valeur';
      const card = kind === 'exacte' ? (s.target && s.target.card) : null;
      if (kind === 'exacte' && !card) continue;
      if (out.some((c) => c.kind === kind && c.card === card)) continue;
      out.push({
        kind, variant, trigger: s.trigger, card,
        rate: s.rate, hit: s.hit, sample: s.sample, source: `Stratégie IA · ${s.name}`,
      });
    }
  }

  return out.map((c) => ({
    ...c,
    fromRoundId: last.id,
    fromRoundNumber: last.number,
    fromRoundAt: timeOf(last),
    tableName: last.tableName,
    variantLabel: game21.variantLabel(variant),
  }));
}

function alreadyPredicted(c) {
  return panel.predictions.some(
    (p) => p.fromRoundId === c.fromRoundId && p.kind === c.kind && p.card === c.card && p.variant === c.variant,
  );
}

// ---------------------------------------------------------------------------
// Messages Telegram — format propre à chaque flux
// ---------------------------------------------------------------------------
function formatOf(kind) {
  return kind === 'exacte' ? panel.exactFormat : panel.valueFormat;
}
function channelsOf(kind) {
  return kind === 'exacte' ? panel.exactChannels : panel.valueChannels;
}

function predictionText(pred) {
  const suit = pred.kind === 'exacte' ? suitOfCard(pred.card) : '♦️';
  const base = fmt.renderMessage(formatOf(pred.kind), {
    gameNumber: pred.fromRoundNumber != null ? pred.fromRoundNumber + 1 : pred.fromRoundNumber,
    suit,
    strategy: pred.kind === 'exacte' ? 'Carte exacte' : 'Carte de valeur',
    maxR: 0,
    status: pred.status,
    rattrapage: 0,
  });
  const cible = pred.kind === 'exacte'
    ? `Carte exacte ${pred.card} (${rankOfCard(pred.card)})`
    : 'Carte de valeur (A, K, Q ou J)';
  const detail = [
    `🃏 ${pred.variantLabel}`,
    `🎯 ${cible}`,
    `📈 Fiabilité ${pred.rate}%`,
  ].join('\n');
  return { text: `${base.text}\n\n${detail}`, parse_mode: base.parse_mode };
}

async function send(pred) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return false; }
  const channels = channelsOf(pred.kind);
  if (!channels.length) {
    panel.lastError = `Aucun canal configuré pour les ${pred.kind === 'exacte' ? 'cartes exactes' : 'cartes de valeur'}`;
    return false;
  }
  const out = predictionText(pred);
  let ok = false;
  for (const id of channels) {
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
}

// ---------------------------------------------------------------------------
// Vérification : le tour suivant de la même variante
// ---------------------------------------------------------------------------
async function verify() {
  for (const pred of panel.predictions) {
    if (pred.status !== 'en attente') continue;
    const history = game21.historyOf(pred.variant);
    const next = [...history]
      .filter((g) => timeOf(g) > pred.fromRoundAt && g.id !== pred.fromRoundId)
      .sort((a, b) => timeOf(a) - timeOf(b))[0];
    if (!next) continue;
    const win = pred.kind === 'exacte'
      ? cardsOf(next).includes(pred.card)
      : hasValueCard(next);
    pred.status = win ? 'gagné' : 'perdu';
    pred.resolvedAt = Date.now();
    pred.resultRound = next.number;
    pred.resultCards = cardsOf(next);
    await update(pred);
  }
}

// ---------------------------------------------------------------------------
// Boucle
// ---------------------------------------------------------------------------
async function tick() {
  panel.lastScanAt = Date.now();
  if (!panel.enabled) return status();
  try {
    if (!game21.state.updatedAt) await game21.refresh();
    await verify();
    for (const variant of VARIANTS) {
      if (panel.variants[variant] === false) continue;
      for (const c of candidatesFor(variant)) {
        if (alreadyPredicted(c)) continue;
        const pred = {
          id: `g21p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          createdAt: Date.now(),
          status: 'en attente',
          messages: [],
          ...c,
        };
        panel.predictions.unshift(pred);
        panel.predictions = panel.predictions.slice(0, MAX_PREDICTIONS);
        await send(pred);
      }
    }
  } catch (e) {
    panel.lastError = e.message;
  }
  return status();
}

// envoi de test dans les deux canaux configurés
async function test() {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  const results = [];
  for (const kind of ['exacte', 'valeur']) {
    const channels = channelsOf(kind);
    for (const id of channels) {
      const demo = {
        kind, variant: 'classique', variantLabel: game21.variantLabel('classique'),
        card: kind === 'exacte' ? 'K♦️' : null, rate: panel.minRate,
        fromRoundNumber: 1234, status: null,
      };
      const out = predictionText(demo);
      try {
        await bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {});
        results.push({ kind, channel: id, ok: true });
      } catch (e) {
        results.push({ kind, channel: id, ok: false, error: e.message });
      }
    }
  }
  if (!results.length) return { ok: false, error: 'Aucun canal configuré' };
  return { ok: results.some((r) => r.ok), results };
}

function bilanOf(list) {
  const done = list.filter((p) => p.status === 'gagné' || p.status === 'perdu');
  const win = done.filter((p) => p.status === 'gagné').length;
  return {
    total: list.length,
    win,
    loss: done.length - win,
    pending: list.filter((p) => p.status === 'en attente').length,
    rate: done.length ? Math.round((win / done.length) * 100) : 0,
  };
}

function status() {
  const preds = panel.predictions;
  const view = (variant, kind) => {
    const list = preds.filter((p) => p.variant === variant && p.kind === kind);
    return { list: list.slice(0, 30), bilan: bilanOf(list) };
  };
  return {
    config: config(),
    running: panel.enabled,
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
    rounds21: {
      classique: game21.historyOf('classique').length,
      simple: game21.historyOf('simple').length,
    },
    classique: { exacte: view('classique', 'exacte'), valeur: view('classique', 'valeur') },
    simple: { exacte: view('simple', 'exacte'), valeur: view('simple', 'valeur') },
    bilan: bilanOf(preds),
    predictions: preds.slice(0, 40),
  };
}

module.exports = {
  panel, config, configure, restore, persist, setSender,
  parseChannels, tick, test, status,
};
