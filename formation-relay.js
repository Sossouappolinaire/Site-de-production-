// formation-relay.js — « Envoyer la formation dans le canal »
//
// Pour CHAQUE stratégie (les stratégies existantes + la stratégie IA
// « Prédit »), on peut cocher une case « Envoyer la formation dans le canal ».
//
// Quand la case est cochée :
//   1. On surveille les prédictions de cette stratégie.
//   2. Dès qu'une prédiction PERD (ex. jeu 10 prédit ❤️ → perdu), on LIT la
//      formation calculée pour cette stratégie (voir formation.js). Exemple :
//      « après une perte, attendre 2 prédictions avant de jouer ».
//   3. On laisse donc passer silencieusement ce nombre de prédictions.
//   4. Quand la prédiction annoncée par la formation arrive, on l'envoie dans
//      le canal configuré : « Jouer cette prédiction, c'est confirmé » avec le
//      JEU prédit, le COSTUME prédit et la mention « sûr à 99% ».
//   5. Si cette prédiction est GAGNÉE, on envoie dans le même canal :
//      « Bingo, Sossou Kouamé l'avait déjà dit ».
//
// Le canal utilisé est celui configuré ici (canal global du panneau
// Formation), ou un canal propre à la stratégie s'il est renseigné.
'use strict';

const strategiesLib = require('./strategies');
const store = require('./store');
const { state } = require('./predictor');
const predit = require('./predit');
const formation = require('./formation');

const panel = {
  enabled: true,
  channels: [],          // canal(aux) Telegram par défaut du panneau Formation
  strategies: {},        // key -> { enabled, channels, counting, needed, seen, armed, pending, lastSeenTarget, sentCount, lastSentAt }
  history: [],           // 100 derniers envois
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
};

let sender = null;
function setSender(fn) { sender = fn; }

// ---------------------------------------------------------------------------
// Stratégies disponibles
// ---------------------------------------------------------------------------
function aiOptions() {
  // Les stratégies créées par l'IA (ai-auto.js) doivent elles aussi avoir
  // leur case « Formation » dans le panneau. Require paresseux pour éviter
  // toute dépendance circulaire au chargement.
  try {
    const aiAuto = require('./ai-auto');
    return (aiAuto.listStrategies() || []).map((s) => ({ key: `ai:${s.id}`, name: s.name, ai: true }));
  } catch (_) { return []; }
}

function options() {
  return [
    ...strategiesLib.LIST.map((s) => ({ key: s.key, name: s.name })),
    { key: 'predit', name: 'Prédit (IA)' },
    ...aiOptions(),
  ];
}

function nameOf(key) {
  const o = options().find((s) => s.key === key);
  return o ? o.name : key;
}

// ---------------------------------------------------------------------------
// Nom de code : un nom volontairement SANS RAPPORT avec ce que fait la
// stratégie (on ne veut pas révéler la logique dans le canal public).
// Le nom est stable : dérivé du hash de la clé, puis mémorisé.
// ---------------------------------------------------------------------------
const CODE_A = ['Zéphyr', 'Cobalt', 'Mistral', 'Onyx', 'Safran', 'Kabylo', 'Ivoire', 'Vulcan',
  'Boréal', 'Cyprès', 'Delta', 'Écarlate', 'Fjord', 'Grenat', 'Halcyon', 'Indigo'];
const CODE_B = ['Panthère', 'Comète', 'Lagune', 'Faucon', 'Sirocco', 'Bambou', 'Nébuleuse', 'Tornade',
  'Corail', 'Mangrove', 'Colibri', 'Météore', 'Baobab', 'Orchidée', 'Sablier', 'Aurore'];

function hashKey(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function codeNameOf(key) {
  const entry = entryFor(key);
  if (entry.codeName) return entry.codeName;
  const h = hashKey(key);
  entry.codeName = `${CODE_A[h % CODE_A.length]} ${CODE_B[Math.floor(h / CODE_A.length) % CODE_B.length]}`;
  return entry.codeName;
}

function parseChannels(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
  return list.map((v) => String(v).trim()).filter(Boolean);
}

function entryFor(key) {
  if (!panel.strategies[key]) {
    panel.strategies[key] = {
      enabled: false,
      channels: [],
      counting: false,
      needed: 0,
      seen: 0,
      armed: false,
      pending: null,        // { target, suit, formationLength } — prédiction annoncée, résultat attendu
      lastSeenTarget: 0,
      sentCount: 0,
      lastSentAt: null,
      codeName: '',
      text: '',            // contenu de la formation écrit par l'admin (facultatif)
      title: '',           // titre de la formation (facultatif)
      autoSend: false,     // publier automatiquement la formation après chaque perte
      manualSentCount: 0,
      lastManualAt: null,
      lastNoticeTarget: 0,   // dernière perte signalée quand la formation n'est PAS cochée
    };
  }
  return panel.strategies[key];
}

function effectiveChannels(entry) {
  return (entry.channels && entry.channels.length) ? entry.channels : panel.channels;
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  try {
    store.patch({
      formationRelay: {
        enabled: panel.enabled,
        channels: panel.channels,
        strategies: panel.strategies,
        history: panel.history.slice(0, 100),
        sentCount: panel.sentCount,
        lastSentAt: panel.lastSentAt,
      },
    });
  } catch (_) { /* la persistance ne doit jamais bloquer l'envoi */ }
}

function restore() {
  try {
    const saved = (store.read() || {}).formationRelay;
    if (!saved) return status();
    panel.enabled = saved.enabled !== false;
    panel.channels = parseChannels(saved.channels);
    panel.strategies = {};
    if (saved.strategies && typeof saved.strategies === 'object') {
      for (const [key, s] of Object.entries(saved.strategies)) {
        const e = entryFor(key);
        e.enabled = !!s.enabled;
        e.channels = parseChannels(s.channels);
        e.counting = !!s.counting;
        e.needed = Number(s.needed) || 0;
        e.seen = Number(s.seen) || 0;
        e.armed = !!s.armed;
        e.pending = s.pending || null;
        e.lastSeenTarget = Number(s.lastSeenTarget) || 0;
        e.sentCount = Number(s.sentCount) || 0;
        e.lastSentAt = s.lastSentAt || null;
        e.codeName = s.codeName || '';
        e.text = typeof s.text === 'string' ? s.text : '';
        e.title = typeof s.title === 'string' ? s.title : '';
        e.autoSend = !!s.autoSend;
        e.manualSentCount = Number(s.manualSentCount) || 0;
        e.lastManualAt = s.lastManualAt || null;
        e.lastNoticeTarget = Number(s.lastNoticeTarget) || 0;
      }
    }
    if (Array.isArray(saved.history)) panel.history = saved.history.slice(0, 100);
    panel.sentCount = Number(saved.sentCount) || 0;
    panel.lastSentAt = saved.lastSentAt || null;
  } catch (_) { /* premier démarrage */ }
  return status();
}

// ---------------------------------------------------------------------------
// Configuration (appelée par l'API)
// ---------------------------------------------------------------------------
function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  persist();
  return status();
}

function setStrategy(key, patch = {}) {
  if (!options().some((o) => o.key === key)) throw new Error('Stratégie inconnue');
  const entry = entryFor(key);
  if (patch.enabled !== undefined) {
    entry.enabled = !!patch.enabled;
    // on repart d'une page blanche à chaque (dé)cochage : pas de relais issu
    // d'une perte survenue avant l'activation.
    entry.counting = false;
    entry.armed = false;
    entry.needed = 0;
    entry.seen = 0;
    entry.pending = null;
    entry.lastSeenTarget = currentMaxTarget(key);
  }
  if (patch.channels !== undefined) entry.channels = parseChannels(patch.channels);
  if (patch.text !== undefined) entry.text = String(patch.text == null ? '' : patch.text);
  if (patch.title !== undefined) entry.title = String(patch.title == null ? '' : patch.title);
  if (patch.autoSend !== undefined) entry.autoSend = !!patch.autoSend;
  persist();
  return status();
}

// ---------------------------------------------------------------------------
// Prédictions de la stratégie suivie
// ---------------------------------------------------------------------------
function predictionsFor(key) {
  const raw = String(key || '').startsWith('ai:') ? String(key).slice(3) : key;
  const list = key === 'predit'
    ? (predit.panel.predictions || [])
    : (state.predictions || []).filter((p) => p.strategy === raw || p.strategy === key);
  return [...list].sort((a, b) => (Number(a.target) || 0) - (Number(b.target) || 0));
}

function currentMaxTarget(key) {
  const list = predictionsFor(key);
  return list.length ? Number(list[list.length - 1].target) || 0 : 0;
}

// « lecture de la formation » : combien de prédictions laisser passer après
// une perte avant de jouer. On prend la formation calculée par formation.js
// (formationLength) ; sans formation fiable, on retombe sur 0 = la toute
// prochaine prédiction.
function formationOf(key) {
  const st = formation.status();
  const found = (st.strategies || []).find((s) => s.key === key);
  if (!found) return { length: 0, rate: null, reliable: false };
  return {
    length: Math.max(0, Number(found.formationLength) || 0),
    rate: found.rate,
    reliable: !!found.reliable,
  };
}

// ---------------------------------------------------------------------------
// Messages envoyés dans le canal
// ---------------------------------------------------------------------------
function confirmText(key, pred, form) {
  const name = codeNameOf(key);
  const suit = pred.suit || pred.card || '—';
  const attente = form.length > 0
    ? `après une perte, attendre ${form.length} prédiction(s) avant de jouer`
    : 'après une perte, jouer la prédiction suivante';
  return [
    '📚 <b>FORMATION CONFIRMÉE</b>',
    '',
    `Jouer cette prédiction, c'est confirmé ✅`,
    '',
    `🎯 Jeu prédit : <b>N°${pred.target}</b>`,
    `🃏 Costume prédit : <b>${suit}</b>`,
    `📊 Sûr à <b>99%</b>`,
    '',
    `📘 Formation « ${name} » : ${attente}.${form.rate ? ` Taux observé : ${form.rate}%.` : ''}`,
  ].join('\n');
}

function bingoText(key, pending) {
  const suit = pending.suit || '—';
  return [
    '🏆 <b>BINGO !</b>',
    '',
    `Sossou Kouamé l'avait déjà dit 😎`,
    '',
    `🎯 Jeu N°${pending.target} · ${suit} ✅ GAGNÉ`,
    `📘 Formation « ${codeNameOf(key)} » confirmée.`,
  ].join('\n');
}

async function send(key, entry, text) {
  const channels = effectiveChannels(entry);
  if (!channels.length) {
    panel.lastError = `Aucun canal configuré pour la formation « ${codeNameOf(key)} »`;
    return false;
  }
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return false; }
  let ok = false;
  for (const id of channels) {
    try {
      await bot.sendMessage(id, text, { parse_mode: 'HTML' });
      ok = true;
    } catch (e) { panel.lastError = `${id} : ${e.message}`; }
  }
  if (ok) {
    panel.sentCount += 1;
    panel.lastSentAt = Date.now();
    entry.sentCount += 1;
    entry.lastSentAt = Date.now();
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Boucle : perte → lecture de la formation → décompte → prédiction confirmée
//          → (si gagnée) message « Bingo »
// ---------------------------------------------------------------------------
async function processStrategy(key) {
  const entry = entryFor(key);
  if (!entry.enabled) return;
  const list = predictionsFor(key);
  if (!list.length) return;

  // 1) résultat de la prédiction déjà annoncée dans le canal ?
  if (entry.pending) {
    const pred = list.find((p) => Number(p.target) === Number(entry.pending.target));
    if (pred && pred.status !== 'en attente') {
      if (pred.status === 'gagné' || pred.status === 'gagne') {
        await send(key, entry, bingoText(key, entry.pending));
        panel.history.unshift({
          key, name: nameOf(key), target: entry.pending.target,
          suit: entry.pending.suit, kind: 'bingo', at: Date.now(),
        });
        panel.history = panel.history.slice(0, 100);
      }
      entry.pending = null;
      persist();
    }
  }

  // 2) suivi des nouvelles prédictions
  for (const pred of list) {
    const target = Number(pred.target) || 0;
    if (target <= entry.lastSeenTarget) continue;

    if (entry.armed) {
      // c'est la prédiction annoncée par la formation : on la publie.
      const form = formationOf(key);
      const sent = await send(key, entry, confirmText(key, pred, form));
      if (sent) {
        entry.pending = { target, suit: pred.suit || pred.card || '', formationLength: form.length };
        panel.history.unshift({
          key, name: nameOf(key), target, suit: pred.suit || pred.card || '',
          kind: 'confirmation', formationLength: form.length, at: Date.now(),
        });
        panel.history = panel.history.slice(0, 100);
      }
      entry.armed = false;
      entry.counting = false;
      entry.needed = 0;
      entry.seen = 0;
      entry.lastSeenTarget = target;
      persist();
      continue;
    }

    // pas encore armé : on n'avance que sur des prédictions déjà résolues.
    if (pred.status === 'en attente') break;
    entry.lastSeenTarget = target;

    if (entry.counting) {
      entry.seen += 1;
      if (entry.seen >= entry.needed) { entry.armed = true; entry.counting = false; }
      continue;
    }

    if (pred.status === 'perdu') {
      // formation envoyée automatiquement (option propre à la stratégie)
      if (entry.autoSend) { try { await send(key, entry, lessonText(key)); } catch (_) { /* ignore */ } }
      // lecture de la formation de CETTE stratégie
      const form = formationOf(key);
      entry.needed = form.length;
      entry.seen = 0;
      if (form.length <= 0) { entry.armed = true; entry.counting = false; }
      else { entry.counting = true; entry.armed = false; }
      persist();
    }
  }
}


// ---------------------------------------------------------------------------
// Stratégie SANS formation cochée : après une perte, on invite simplement à
// écrire à l'administrateur pour prendre la formation de cette stratégie —
// désignée par son NOM DE CODE, jamais par sa logique.
// ---------------------------------------------------------------------------
function adviceText(key, pred) {
  return [
    '📕 <b>FORMATION NON ACTIVÉE</b>',
    '',
    `Stratégie <b>« ${codeNameOf(key)} »</b>`,
    `🎯 Jeu N°${pred.target} · ❌ Perdu`,
    '',
    `✍️ Écrivez à l'administrateur pour prendre la formation de comment jouer à cette stratégie.`,
  ].join('\n');
}

async function processUncheckedStrategy(key) {
  const entry = entryFor(key);
  if (entry.enabled) return;
  if (!panel.channels.length && !(entry.channels || []).length) return;
  const list = predictionsFor(key);
  if (!list.length) return;
  for (const pred of list) {
    const target = Number(pred.target) || 0;
    if (target <= entry.lastNoticeTarget) continue;
    if (pred.status === 'en attente') break;
    entry.lastNoticeTarget = target;
    if (pred.status === 'perdu') {
      await send(key, entry, adviceText(key, pred));
      panel.history.unshift({
        key, name: nameOf(key), codeName: codeNameOf(key), target,
        suit: pred.suit || pred.card || '', kind: 'invitation', at: Date.now(),
      });
      panel.history = panel.history.slice(0, 100);
    }
    persist();
  }
}


// ---------------------------------------------------------------------------
// « Bouton Formation » : CHAQUE stratégie possède une formation, avec sa
// PROPRE configuration (titre, contenu, canal) totalement séparée des
// autres. Si l'admin n'a rien écrit, une formation par défaut est générée
// à partir des statistiques observées (formation.js) — ainsi aucune
// stratégie ne reste sans formation.
// ---------------------------------------------------------------------------
function defaultLesson(key) {
  const form = formationOf(key);
  const wait = form.length > 0
    ? `Après une perte, laisser passer ${form.length} prédiction(s) puis jouer la suivante.`
    : `Après une perte, jouer directement la prédiction suivante.`;
  const fiab = form.reliable && form.rate
    ? `Fiabilité observée : ${form.rate}% sur les relevés du bot.`
    : `Fiabilité encore en cours de mesure : appliquer la mise minimale.`;
  return [
    `1. Attendre le signal de la stratégie dans le canal.`,
    `2. ${wait}`,
    `3. Miser uniquement sur le costume annoncé, jamais sur un autre.`,
    `4. Deux pertes de suite : faire une pause d'un jeu complet avant de reprendre.`,
    `5. ${fiab}`,
  ].join('\n');
}

function lessonOf(key) {
  const entry = entryFor(key);
  return (entry.text && entry.text.trim()) ? entry.text.trim() : defaultLesson(key);
}

function lessonTitleOf(key) {
  const entry = entryFor(key);
  return (entry.title && entry.title.trim()) ? entry.title.trim() : `Formation « ${codeNameOf(key)} »`;
}

function lessonText(key) {
  const form = formationOf(key);
  return [
    '🎓 <b>FORMATION</b>',
    '',
    `<b>${lessonTitleOf(key)}</b>`,
    '',
    lessonOf(key),
    '',
    form.reliable ? `📊 Formation de ${form.length} · taux observé ${form.rate}%.` : '📊 Formation en cours de calibrage.',
    `✍️ Pour toute question, écrivez à l'administrateur.`,
  ].join('\n');
}

// Envoi manuel : publie la formation de CETTE stratégie dans SON canal.
async function sendLesson(key) {
  if (!options().some((o) => o.key === key)) throw new Error('Stratégie inconnue');
  const entry = entryFor(key);
  const ok = await send(key, entry, lessonText(key));
  if (ok) {
    entry.manualSentCount += 1;
    entry.lastManualAt = Date.now();
    panel.history.unshift({
      key, name: nameOf(key), codeName: codeNameOf(key),
      kind: 'formation', at: Date.now(),
    });
    panel.history = panel.history.slice(0, 100);
    persist();
  } else if (panel.lastError) {
    throw new Error(panel.lastError);
  }
  return status();
}

async function tick() {
  if (!panel.enabled) return status();
  try {
    for (const opt of options()) {
      const entry = entryFor(opt.key);
      // chaque stratégie reçoit SON message, séparément des autres
      if (entry.enabled) await processStrategy(opt.key);
      else await processUncheckedStrategy(opt.key);
    }
    panel.lastScanAt = Date.now();
  } catch (e) {
    panel.lastError = e.message;
  }
  return status();
}

function status() {
  return {
    enabled: panel.enabled,
    channels: panel.channels,
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
    history: panel.history.slice(0, 20),
    strategies: options().map((o) => {
      const e = panel.strategies[o.key] || {};
      return {
        key: o.key,
        name: o.name,
        ai: !!o.ai,
        codeName: codeNameOf(o.key),
        enabled: !!e.enabled,
        channels: e.channels || [],
        counting: !!e.counting,
        needed: e.needed || 0,
        seen: e.seen || 0,
        armed: !!e.armed,
        pending: e.pending || null,
        sentCount: e.sentCount || 0,
        lastSentAt: e.lastSentAt || null,
        title: lessonTitleOf(o.key),
        text: e.text || '',
        lesson: lessonOf(o.key),
        custom: !!(e.text && e.text.trim()),
        autoSend: !!e.autoSend,
        manualSentCount: e.manualSentCount || 0,
        lastManualAt: e.lastManualAt || null,
      };
    }),
  };
}

module.exports = { panel, setSender, restore, configure, setStrategy, sendLesson, lessonText, lessonOf, lessonTitleOf, tick, status, options, parseChannels };
