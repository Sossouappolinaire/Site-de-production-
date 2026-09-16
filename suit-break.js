// suit-break.js — nouveau bouton « Rupture de costume » (demande admin) :
// système INDÉPENDANT de « Série de costume » (suit-streak.js), « Prédit
// après une perte » (after-loss.js) et « Combinaisons » (combined.js), avec
// une sémantique différente des trois :
//
//  • On sélectionne UNE source : n'importe quelle stratégie existante, la
//    stratégie IA « Prédit », OU une Formation (formation-relay.js).
//  • On définit N = nombre de prédictions CONSÉCUTIVES de MÊME COSTUME (peu
//    importe si elles ont été gagnées ou perdues) à observer AVANT d'armer
//    l'attente d'une rupture. Une prédiction d'un AUTRE costume casse la
//    série en cours et en démarre une nouvelle avec ce nouveau costume.
//  • Dès que la série atteint N, on est « armé » : on attend simplement la
//    PROCHAINE prédiction de la source.
//      - Si elle est ENCORE du même costume → la série continue (N+1, N+2…),
//        toujours armé, on attend toujours la rupture.
//      - Si elle est d'un costume DIFFÉRENT → c'est la rupture : on
//        déclenche IMMÉDIATEMENT, sur le MÊME numéro que cette prédiction de
//        rupture (aucun décalage), en prédisant le costume ORIGINAL de la
//        série (pas le nouveau costume observé). Le nombre de rattrapage
//        (maxR) configuré s'applique ensuite normalement pour la
//        vérification (numéro, +1, +2… jusqu'à maxR).
//    Après déclenchement (ou après une rupture qui n'atteignait pas encore
//    N), on repart à zéro : le costume de la prédiction de rupture démarre
//    une nouvelle série (compte 1).
//  • Exemple : source prédit ♦️ au jeu 1052, puis ♦️ au jeu 1053 (N=2
//    atteint, armé). Si le jeu 1054 est ❤️, ♣️ ou ♠️ → rupture → on prédit
//    1054♦️ (avec le rattrapage configuré). Si le jeu 1054 est encore ♦️, on
//    reste armé et on attend la prochaine prédiction ; dès qu'elle est enfin
//    d'un autre costume, c'est CE numéro-là qui déclenche, toujours en ♦️.
//  • Toujours sur la main du JOUEUR : vérification via hasSuit(), jamais
//    hasSuitBanker() (comme suit-streak.js/combined.js).
'use strict';

const strategies = require('./strategies');
const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const { state, hasSuit, addSiteChannelMessage, siteChannelsView, setOnShoeReset } = require('./predictor');
const predit = require('./predit');
const formationRelay = require('./formation-relay');
const delivery = require('./prediction-delivery');

const panel = {
  enabled: true,
  channels: [],
  siteChannelId: null,
  format: 1,
  maxR: 1,
  trackers: [],
  pendingMessages: [],
  history: [],
  // GARDE-FOU ANTI-DOUBLON PERSISTANT (demande admin) : contrairement à
  // history/pendingMessages (vidés à chaque démarrage — voir applySaved),
  // cette liste d'empreintes « déjà envoyées » SURVIT aux redémarrages.
  // Elle bloque un renvoi même si le crash/redémarrage survient juste après
  // l'envoi d'une rupture, avant que le reste de l'état ait pu se
  // recaler correctement.
  sentFingerprints: [],
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
};

let sender = null;
function setSender(fn) { sender = fn; }
let busy = false;

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

function sanitizeSiteChannelId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = String(value).trim();
  return id ? id : null;
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) panel.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.maxR !== undefined) panel.maxR = Math.max(0, Math.min(9, parseInt(patch.maxR, 10) || 0));
  persist();
  return config();
}

function config() {
  return {
    enabled: panel.enabled, channels: panel.channels, siteChannelId: panel.siteChannelId,
    format: panel.format, maxR: panel.maxR,
  };
}

// ---------------------------------------------------------------------------
// Sources disponibles — identique à suit-streak.js : n'importe quelle
// stratégie existante, la stratégie IA « Prédit », les Formations, les
// trackers « après perte » et les combos.
// ---------------------------------------------------------------------------
function afterLossOptions() {
  try {
    const afterLoss = require('./after-loss');
    return (afterLoss.panel.trackers || []).map((t) => ({ key: `after:${t.id}`, name: t.name, group: 'Stratégies enregistrées' }));
  } catch (_) { return []; }
}

function combinedOptions() {
  try {
    const combined = require('./combined');
    return (combined.panel.trackers || []).map((t) => ({ key: `combo:${t.id}`, name: `Combinaison — ${t.name}`, group: 'Combinaisons' }));
  } catch (_) { return []; }
}

function options() {
  const base = [
    ...strategies.LIST.map((s) => ({ key: s.key, name: s.name, group: 'Stratégies' })),
    { key: 'ia', name: 'Stratégie IA (Prédit)', group: 'Stratégies' },
  ];
  const formations = [
    ...strategies.LIST.map((s) => ({ key: `formation:${s.key}`, name: `Formation — ${s.name}`, group: 'Formations' })),
    { key: 'formation:ia', name: 'Formation — Prédit IA', group: 'Formations' },
  ];
  return [...base, ...formations, ...afterLossOptions(), ...combinedOptions()];
}

function optionByKey(key) {
  return options().find((o) => o.key === key) || null;
}

function baseKeyOf(key) {
  return key.startsWith('formation:') ? key.slice('formation:'.length) : key;
}

function isFormationSource(key) {
  return key.startsWith('formation:');
}

function trackerPredictions(key) {
  if (key.startsWith('after:')) {
    try { return require('./after-loss').pendingFor(key.slice('after:'.length)); } catch (_) { return []; }
  }
  if (key.startsWith('combo:')) {
    try { return require('./combined').pendingFor(key.slice('combo:'.length)); } catch (_) { return []; }
  }
  const base = baseKeyOf(key);
  if (base === 'ia') return [...predit.panel.predictions].sort((a, b) => a.target - b.target);
  return state.predictions.filter((p) => p.strategy === base).sort((a, b) => a.target - b.target);
}

function currentMaxTarget(key) {
  const list = trackerPredictions(key);
  return list.length ? list[list.length - 1].target : 0;
}

// une confirmation de CE tracker est-elle déjà en attente de résultat ?
// (voir garde-fou dans processTracker() : on ne publie jamais deux
// prédictions superposées pour la même source suivie)
function alreadyPendingForTracker(tracker) {
  return panel.pendingMessages.some((e) => e.trackerId === tracker.id && e.status === 'en attente');
}

// ---------------------------------------------------------------------------
// Réglages d'une source suivie
// ---------------------------------------------------------------------------
function sanitizeN(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(2, Math.min(20, n)) : 2;
}

function sanitizeTrackerFormat(value) {
  if (value === null || value === undefined || value === '') return null;
  return fmt.clampFormat(value);
}

function sanitizeTrackerMaxR(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(9, n)) : null;
}

function effectiveChannels(tracker) {
  return (tracker.channels && tracker.channels.length) ? tracker.channels : panel.channels;
}

function effectiveSiteChannelId(tracker) {
  return tracker.siteChannelId != null ? tracker.siteChannelId : panel.siteChannelId;
}

function effectiveFormat(tracker) {
  return tracker.format || panel.format;
}

function effectiveMaxR(tracker) {
  return (tracker.maxR === null || tracker.maxR === undefined) ? panel.maxR : tracker.maxR;
}

function postToSiteChannel(tracker, text) {
  const id = effectiveSiteChannelId(tracker);
  if (!id) return false;
  const entry = addSiteChannelMessage(id, { sender: tracker.name, text });
  return !!entry;
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const saved = {
    config: config(), trackers: panel.trackers, history: panel.history,
    pendingMessages: panel.pendingMessages, sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt,
    // celle-ci SURVIT au nettoyage de restore() — voir applySaved().
    sentFingerprints: panel.sentFingerprints,
  };
  try { store.patch({ suitBreak: saved }); } catch (_) {}
  if (db.ready) db.setSetting('suit_break_state', JSON.stringify(saved)).catch((error) => { panel.lastError = error.message; });
}

function restore() {
  try {
    const saved = (store.read() || {}).suitBreak;
    if (saved) applySaved(saved);
  } catch (_) {}
  // on réécrit tout de suite l'état nettoyé : aucune prédiction stockée ne
  // survit au démarrage, ni en mémoire ni en base.
  persist();
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('suit_break_state');
    if (raw) applySaved(JSON.parse(raw));
  } catch (_) {}
  persist();
  return config();
}

function applySaved(saved) {
  if (saved.config) {
    panel.enabled = saved.config.enabled !== false;
    panel.channels = parseChannels(saved.config.channels);
    panel.siteChannelId = sanitizeSiteChannelId(saved.config.siteChannelId);
    panel.format = fmt.clampFormat(saved.config.format);
    panel.maxR = Math.max(0, Math.min(9, parseInt(saved.config.maxR, 10) || 0));
  }
  if (Array.isArray(saved.trackers)) {
    // CORRECTIF « bouton rupture figé sur un costume » (demande admin) :
    // avant, la série (streakSuit/streakCount) ET le curseur lastSeenTarget
    // étaient restaurés depuis la base au démarrage. Or les prédictions des
    // stratégies sont, elles, PURGÉES à chaque nouveau sabot / redémarrage.
    // Résultat : le panneau gardait éternellement « ♦️ ×N » et, comme
    // lastSeenTarget valait un grand numéro de l'ancien sabot, TOUTES les
    // nouvelles prédictions (numéros repartis à 1) étaient ignorées — donc
    // plus aucune rupture correcte, et les relais envoyés ne correspondaient
    // ni aux prédictions ni au numéro réellement prédits.
    // Désormais : AU DÉMARRAGE, aucune prédiction ni série n'est conservée —
    // on repart toujours de zéro, seuls les réglages sont restaurés.
    panel.trackers = saved.trackers.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name || (optionByKey(t.key) || {}).name || t.key,
      n: sanitizeN(t.n),
      channels: Array.isArray(t.channels) ? parseChannels(t.channels) : [],
      siteChannelId: sanitizeSiteChannelId(t.siteChannelId),
      format: t.format ? fmt.clampFormat(t.format) : null,
      maxR: sanitizeTrackerMaxR(t.maxR),
      streakSuit: null,
      streakCount: 0,
      // null = panneau « non amorcé » : au premier passage on se cale sur la
      // dernière prédiction DÉJÀ existante de la source sans la rejouer, pour
      // ne JAMAIS renvoyer d'anciennes prédictions déjà passées dans le canal.
      lastSeenTarget: null,
      seen: [],
      readCount: 0,
      fireCount: 0,
      lastFireAt: null,
      sentCount: 0,
      lastSentAt: null,
      createdAt: t.createdAt || Date.now(),
    }));
  }
  // Aucune prédiction stockée n'est rejouée au démarrage (mémoire ET base) :
  // l'historique et les messages en attente repartent vides.
  panel.history = [];
  panel.pendingMessages = [];
  panel.sentCount = 0;
  panel.lastSentAt = null;
  panel.lastScanAt = null;
  // ... SAUF les empreintes anti-doublon : celles-ci DOIVENT survivre au
  // redémarrage, sinon la protection ne sert à rien pile quand elle est le
  // plus utile (juste après un crash/redémarrage).
  panel.sentFingerprints = Array.isArray(saved.sentFingerprints) ? saved.sentFingerprints.slice(-500) : [];
}

// ---------------------------------------------------------------------------
// Gestion des sources suivies
// ---------------------------------------------------------------------------
function addTracker(key, extra = {}) {
  const opt = optionByKey(key);
  if (!opt) throw new Error('Source inconnue pour la rupture de costume.');
  const tracker = {
    id: `sb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    key: opt.key,
    name: (extra.name && String(extra.name).trim()) || opt.name,
    n: sanitizeN(extra.n),
    channels: parseChannels(extra.channels),
    siteChannelId: sanitizeSiteChannelId(extra.siteChannelId),
    format: sanitizeTrackerFormat(extra.format),
    maxR: sanitizeTrackerMaxR(extra.maxR),
    streakSuit: null,
    streakCount: 0,
    // on ne rejoue pas l'historique déjà passé au moment de l'ajout.
    lastSeenTarget: currentMaxTarget(opt.key),
    seen: [],
    readCount: 0,
    fireCount: 0,
    lastFireAt: null,
    sentCount: 0,
    lastSentAt: null,
    createdAt: Date.now(),
  };
  panel.trackers.push(tracker);
  persist();
  return tracker;
}

function updateTracker(id, patch = {}) {
  const tracker = panel.trackers.find((t) => t.id === id);
  if (!tracker) return null;
  if (patch.name !== undefined) {
    const clean = String(patch.name || '').trim();
    if (clean) tracker.name = clean;
  }
  if (patch.n !== undefined) {
    tracker.n = sanitizeN(patch.n);
    // changement de réglage : on annule la série/l'attente en cours pour
    // repartir proprement sur les nouvelles règles.
    tracker.streakSuit = null;
    tracker.streakCount = 0;
    tracker.seen = [];
  }
  if (patch.channels !== undefined) tracker.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) tracker.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.format !== undefined) tracker.format = sanitizeTrackerFormat(patch.format);
  if (patch.maxR !== undefined) tracker.maxR = sanitizeTrackerMaxR(patch.maxR);
  persist();
  return tracker;
}

function removeTracker(id) {
  panel.trackers = panel.trackers.filter((t) => t.id !== id);
  persist();
  return true;
}

// ---------------------------------------------------------------------------
// Boucle de traitement — voir le commentaire en tête de fichier pour la
// règle complète (série de N même costume, puis attente de la rupture).
// ---------------------------------------------------------------------------
async function processTracker(tracker) {
  if (isFormationSource(tracker.key)) {
    const base = baseKeyOf(tracker.key);
    const trustKey = base === 'ia' ? 'predit' : base; // formation.js utilise la clé 'predit' pour le panneau IA
    const trust = formationRelay.formationTrusted(trustKey);
    if (!trust.ok) return; // formation pas (ou plus) fiable : on ne traite rien ce tour-ci
  }
  const list = trackerPredictions(tracker.key);
  // AMORÇAGE (démarrage / nouveau sabot) : on ne rejoue jamais les
  // prédictions déjà présentes. On se cale simplement sur la dernière et on
  // n'envoie rien ce tour-ci : seules les prédictions FUTURES de la source
  // pourront alimenter la série puis la rupture.
  if (tracker.lastSeenTarget === null || tracker.lastSeenTarget === undefined) {
    tracker.lastSeenTarget = list.length ? list[list.length - 1].target : 0;
    tracker.streakSuit = null;
    tracker.streakCount = 0;
    tracker.seen = [];
    return;
  }
  // CORRECTIF : le numéro de jeu repart à 1 à chaque nouveau sabot. Si la
  // source repart nettement en dessous du curseur, on remet le curseur à zéro
  // au lieu d'ignorer toutes les nouvelles prédictions.
  if (list.length && list[0].target + 10 < tracker.lastSeenTarget) {
    tracker.lastSeenTarget = 0; tracker.streakSuit = null; tracker.streakCount = 0; tracker.seen = [];
  }
  for (const pred of list) {
    if (pred.target <= tracker.lastSeenTarget) continue;
    // CORRECTIF : on ne dépend PLUS du résultat (gagné/perdu) pour compter la
    // prédiction. La règle du panneau est « peu importe gagné/perdu », et
    // attendre la résolution faisait rater les prédictions purgées entre-temps
    // (série bloquée sur un seul costume).
    tracker.lastSeenTarget = pred.target;
    const suit = pred.suit;
    if (!suit) continue; // ce panneau ne suit que les prédictions de costume (parité/cartes non gérées)
    tracker.readCount = (tracker.readCount || 0) + 1;

    let note = '';
    if (suit === tracker.streakSuit) {
      // la série en cours continue (peu importe gagné/perdu).
      tracker.streakCount += 1;
      note = `série ${suit} ×${tracker.streakCount}`;
    } else {
      // rupture par rapport à la série précédente : si elle avait atteint N,
      // c'est LA rupture qui déclenche — sur ce même numéro, avec le
      // costume ORIGINAL de la série (pas le nouveau costume observé ici).
      // GARDE-FOU (demande admin) : ne publier dans le canal QUE les
      // ruptures qui doivent réellement y aller. Si une confirmation
      // précédente de ce même tracker est encore « en attente » de
      // résultat, on ne déclenche pas une deuxième prédiction par-dessus —
      // sinon plusieurs prédictions se retrouvent envoyées en même temps
      // pour la même source, alors qu'une seule est censée être suivie à
      // la fois.
      if (tracker.streakSuit && tracker.streakCount >= tracker.n) {
        if (alreadyPendingForTracker(tracker)) {
          note = `RUPTURE ${tracker.streakSuit} sur #${pred.target} — ignorée : une confirmation de « ${tracker.name} » est déjà en attente de résultat dans le canal`;
        } else {
          note = `RUPTURE → prédiction ${tracker.streakSuit} sur #${pred.target}`;
          tracker.fireCount = (tracker.fireCount || 0) + 1;
          tracker.lastFireAt = Date.now();
          await fire(tracker, pred, tracker.streakSuit);
        }
      } else {
        note = `nouvelle série ${suit} ×1`;
      }
      // le costume de cette prédiction démarre une nouvelle série.
      tracker.streakSuit = suit;
      tracker.streakCount = 1;
    }
    // journal visible dans la configuration : ce que le panneau a réellement lu
    tracker.seen = [{ target: pred.target, suit, status: pred.status || 'en attente', note, at: Date.now() }, ...(tracker.seen || [])].slice(0, 25);
  }
}

// GARDE-FOU ANTI-DOUBLON PERSISTANT (demande admin) : identifie une rupture
// déjà envoyée par SON EMPREINTE (tracker + jeu + costume), indépendamment
// de pendingMessages (qui, lui, est vidé à chaque démarrage). Bloque tout
// renvoi de la MÊME rupture, même après un crash/redémarrage en boucle.
function fingerprintOf(tracker, target, suit) {
  return `${tracker.id}#${target}#${suit}`;
}
function alreadySentFingerprint(tracker, target, suit) {
  return panel.sentFingerprints.includes(fingerprintOf(tracker, target, suit));
}
function markSentFingerprint(tracker, target, suit) {
  panel.sentFingerprints.push(fingerprintOf(tracker, target, suit));
  if (panel.sentFingerprints.length > 500) panel.sentFingerprints = panel.sentFingerprints.slice(-500);
}

async function fire(tracker, pred, suit) {
  if (alreadySentFingerprint(tracker, pred.target, suit)) {
    panel.lastError = `Rupture ${suit} sur #${pred.target} pour « ${tracker.name} » ignorée : déjà envoyée précédemment (protection anti-doublon).`;
    return;
  }
  const ok = await send(tracker, { target: pred.target, suit, sourceTarget: pred.target });
  if (ok) markSentFingerprint(tracker, pred.target, suit);
}

function messageText(tracker, syn) {
  return fmt.renderMessage(effectiveFormat(tracker), {
    gameNumber: syn.target,
    suit: syn.suit,
    strategy: `${tracker.name} (rupture de costume)`,
    maxR: effectiveMaxR(tracker),
    status: 'en attente',
    rattrapage: 0,
  }, null);
}

async function send(tracker, syn) {
  const targetChannels = effectiveChannels(tracker);
  const siteChannelId = effectiveSiteChannelId(tracker);
  if (!targetChannels.length && !siteChannelId) {
    panel.lastError = `Aucun canal configuré pour « ${tracker.name} » (ni Telegram, ni canal du site, sur la source ou le panneau)`;
    return false;
  }
  const out = messageText(tracker, syn);
  const suit = syn.suit || syn.card || '-';
  const sentMessages = [];
  const errors = [];
  let ok = false;
  if (targetChannels.length) {
    const bot = typeof sender === 'function' ? sender() : null;
    if (!bot) {
      errors.push('Aucun token Telegram configuré');
    } else {
      for (const id of targetChannels) {
        const claimed = await delivery.claim({
          target: syn.target,
          suit,
          channel: id,
          source: `suit-break:${tracker.id}`,
        });
        if (!claimed) continue;
        try {
          const m = await bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {});
          sentMessages.push({ chatId: id, messageId: m.message_id });
          await delivery.markSent({ target: syn.target, suit, channel: id });
          ok = true;
        } catch (e) {
          await delivery.release({ target: syn.target, suit, channel: id });
          errors.push(`${id} : ${e.message}`);
        }
      }
    }
  }
  if (siteChannelId) {
    const siteChannel = `site:${siteChannelId}`;
    const claimed = await delivery.claim({
      target: syn.target,
      suit,
      channel: siteChannel,
      source: `suit-break:${tracker.id}`,
    });
    if (claimed) {
      const posted = postToSiteChannel(tracker, out.text);
      if (posted) {
        await delivery.markSent({ target: syn.target, suit, channel: siteChannel });
        ok = true;
      } else {
        await delivery.release({ target: syn.target, suit, channel: siteChannel });
        errors.push(`Canal du site introuvable (id ${siteChannelId})`);
      }
    }
  }
  if (!ok) {
    if (errors.length) panel.lastError = errors[0];
    return false;
  }
  panel.sentCount = (panel.sentCount || 0) + 1;
  panel.lastSentAt = Date.now();
  panel.lastError = errors.length ? errors[0] : null;
  tracker.sentCount = (tracker.sentCount || 0) + 1;
  tracker.lastSentAt = Date.now();
  panel.history.unshift({
    trackerId: tracker.id, trackerName: tracker.name, target: syn.target, suit: syn.suit,
    sourceTarget: syn.sourceTarget, sentAt: Date.now(),
  });
  panel.history = panel.history.slice(0, 100);
  if (sentMessages.length) {
    panel.pendingMessages.push({
      id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      trackerId: tracker.id, target: syn.target, suit: syn.suit, strategyName: tracker.name,
      format: effectiveFormat(tracker), maxR: effectiveMaxR(tracker), step: 0, gap: 0, skipped: 0,
      status: 'en attente', messages: sentMessages, createdAt: Date.now(), resolvedAt: null,
    });
    if (panel.pendingMessages.length > 200) {
      const keep = [];
      let resolvedCount = 0;
      for (let i = panel.pendingMessages.length - 1; i >= 0; i--) {
        const e = panel.pendingMessages[i];
        if (e.status === 'en attente' || resolvedCount < 200) {
          keep.unshift(e);
          if (e.status !== 'en attente') resolvedCount += 1;
        }
      }
      panel.pendingMessages = keep;
    }
  }
  return true;
}

// Vue « prédiction » des relais déjà envoyés par CE panneau, pour une source
// suivie donnée (trackerId) — même forme que les prédictions normales.
function pendingFor(trackerId) {
  return panel.pendingMessages
    .filter((e) => e.trackerId === trackerId)
    .map((e) => ({ target: e.target, suit: e.suit, kind: 'suit', status: e.status, step: e.step, maxR: e.maxR }))
    .sort((a, b) => a.target - b.target);
}

function editPending(entry, statusFr) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  const out = fmt.renderMessage(entry.format, {
    gameNumber: entry.target, suit: entry.suit, strategy: entry.strategyName,
    maxR: entry.maxR, status: statusFr, rattrapage: entry.step,
  }, null);
  for (const m of entry.messages) {
    bot.editMessageText(out.text, {
      chat_id: m.chatId, message_id: m.messageId,
      ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}),
    }).catch(() => {});
  }
}

function maxFinishedGameNumber() {
  let max = 0;
  for (const g of state.games.values()) if (g.finished && g.number > max) max = g.number;
  return max;
}

async function verifyPending() {
  const maxDone = maxFinishedGameNumber();
  for (const entry of panel.pendingMessages) {
    if (entry.status !== 'en attente') continue;
    let guard = 0;
    while (entry.status === 'en attente' && guard++ <= entry.maxR + entry.gap + 8) {
      const num = entry.target + entry.step + entry.gap;
      const g = state.games.get(num);
      const usable = !!g && g.finished && g.complete !== false;
      if (!usable) {
        if (num + 2 <= maxDone) {
          entry.gap += 1;
          entry.skipped = (entry.skipped || 0) + 1;
          if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); break; }
          continue;
        }
        break;
      }
      const won = hasSuit(g, entry.suit);
      if (won) { entry.status = 'gagné'; entry.resolvedAt = Date.now(); editPending(entry, 'gagné'); break; }
      if (entry.step >= entry.maxR) { entry.status = 'perdu'; entry.resolvedAt = Date.now(); editPending(entry, 'perdu'); break; }
      entry.step += 1;
    }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pendingMessages = panel.pendingMessages.filter((e) => e.status === 'en attente' || !e.resolvedAt || e.resolvedAt >= cutoff);
}

// Nouveau sabot (le jeu repart au numéro 1 en direct) : purge TOTALE du
// panneau — plus aucune prédiction stockée en mémoire ni en base, séries et
// compteurs remis à zéro (demande admin).
setOnShoeReset(() => {
  for (const t of panel.trackers) {
    t.lastSeenTarget = null; t.streakSuit = null; t.streakCount = 0;
    t.seen = []; t.readCount = 0; t.fireCount = 0; t.lastFireAt = null;
    t.sentCount = 0; t.lastSentAt = null;
  }
  for (const entry of panel.pendingMessages) {
    if (entry.status === 'en attente') editPending(entry, 'annulé');
  }
  panel.pendingMessages = [];
  panel.history = [];
  panel.sentCount = 0;
  panel.lastSentAt = null;
  persist();
});

async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    for (const tracker of panel.trackers) await processTracker(tracker);
    await verifyPending();
    panel.lastScanAt = Date.now();
  } catch (e) {
    panel.lastError = e.message;
  } finally {
    persist();
    busy = false;
  }
  return panel;
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
      await bot.sendMessage(id, `🎯 RUPTURE DE COSTUME — message de test\n\nFormat ${panel.format} :\n\n${preview}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

function statusView() {
  return {
    ...config(),
    options: options(),
    siteChannels: siteChannelsView().map((c) => ({ id: c.id, name: c.name })),
    trackers: panel.trackers.map((t) => ({
      id: t.id, key: t.key, name: t.name, n: t.n,
      channels: t.channels, siteChannelId: t.siteChannelId, format: t.format, maxR: t.maxR,
      streakSuit: t.streakSuit, streakCount: t.streakCount,
      seen: (t.seen || []).slice(0, 25),
      readCount: t.readCount || 0,
      fireCount: t.fireCount || 0,
      lastFireAt: t.lastFireAt || null,
      lastSeenTarget: t.lastSeenTarget == null ? 0 : t.lastSeenTarget,
      sourcePredictions: trackerPredictions(t.key)
        .slice(-15)
        .map((p) => ({ target: p.target, suit: p.suit || null, status: p.status || 'en attente' }))
        .reverse(),
      pending: pendingFor(t.id).slice().reverse(),
      sentCount: t.sentCount, lastSentAt: t.lastSentAt, createdAt: t.createdAt,
    })),
    history: panel.history.slice(0, 30),
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
  };
}

module.exports = {
  panel, setSender, tick, test, status: statusView, config, configure,
  options, addTracker, updateTracker, removeTracker,
  restore, restoreFromDb, parseChannels, pendingFor,
};
