// predictor.js — moteur multi-stratégies (main du JOUEUR uniquement)
//
//  • Chaque stratégie possède sa propre configuration (activation, format,
//    rattrapages, compteur B, canaux) enregistrée en base de données.
//  • La vérification se fait TOUJOURS sur la main du joueur :
//      – kind 'suit'  → le costume prédit apparaît-il dans les cartes du joueur ?
//      – kind 'cards' → le joueur a-t-il le nombre de cartes prédit (et le
//        banquier aussi, pour la distribution) ?
//  • La main du banquier n'est utilisée que pour les filtres/statistiques et
//    l'archivage en base de données.
const config = require('./config');
const fmt = require('./formats');
const strategies = require('./strategies');

const BADGES = ['0⃣', '1⃣', '2⃣', '3⃣', '4⃣', '5⃣', '6⃣', '7⃣', '8⃣', '9⃣'];
const SUITS = strategies.SUITS;
const normSuit = strategies.normSuit;

const state = {
  // réglages globaux (compat : ils pilotent la stratégie « costume »)
  B: config.DEFAULT_B,
  maxR: config.DEFAULT_MAX_R,
  hand: 'joueur',
  format: config.DEFAULT_FORMAT,
  template: null,
  channels: [],
  activeChannels: [],
  strategies: {},          // key -> config
  history: [],
  games: new Map(),
  counters: { '♦️': 0, '❤️': 0, '♣️': 0, '♠️': 0 },
  predictions: [],
  aiAnalyses: [],
  aiStrategies: [],
  triggersDone: {},        // "clé:déclencheur" -> true (règle 1 : un seul traitement)
  live: null,
  lastFinished: null,
  lastError: null,
  sendErrors: {},          // clé de stratégie -> dernière erreur d'envoi Telegram
  gates: {},               // clé de stratégie -> filtre d'envoi « double perte »
  autoGates: {},           // clé de stratégie -> déclencheur automatique (perte/rattrapage + N)
  freshFinished: [],       // tours terminés depuis la dernière évaluation
  startedAt: Date.now(),
  announcements: [],       // historique des annonces de position (filtre « double perte »)
  siteChannels: [],        // canaux « vitrine » du site (voir section dédiée plus bas)
};

// ---------------------------------------------------------------------------
// Configuration des stratégies
// ---------------------------------------------------------------------------
function initStrategies() {
  for (const s of strategies.LIST) {
    const def = strategies.defaultsFor(s.key);
    const cur = state.strategies[s.key];
    if (!cur) { state.strategies[s.key] = def; continue; }
    // une configuration enregistrée avant l'ajout d'un réglage (mode silencieux,
    // fenêtre de pertes…) est complétée sans écraser les choix de l'utilisateur
    for (const [k, v] of Object.entries(def)) if (cur[k] === undefined) cur[k] = v;
    // Migration douce : l'ancien champ `channels` devient le canal public.
    if (!Array.isArray(cur.publishedChannels)) cur.publishedChannels = Array.isArray(cur.channels) ? cur.channels : [];
    if (!Array.isArray(cur.shadowChannels)) cur.shadowChannels = [];
    // Nettoyage : le mode d'activation silencieux (2ᵉ mode) a été retiré du
    // projet, et le mode silencieux 1 (`silent`) est désormais réservé à la
    // stratégie « ombre ». On purge toute trace d'une config antérieure.
    for (const f of ['silenceMode', 'silenceTrigger', 'silenceLossCount', 'silenceRatLevel',
      'silenceRatCount', 'silenceOffset', 'silenceInterval', 'silenceCount',
      'silenceChannels', 'silenceChannelInfos']) delete cur[f];
    if (s.key === 'ombre') { cur.silent = true; cur.autoUnlockMin = 0; } else cur.silent = false;
  }
  syncCostume();
  return state.strategies;
}

// la stratégie « costume » reste pilotée par les réglages globaux (compat /setb…)
function syncCostume() {
  const c = state.strategies.costume;
  if (!c) return;
  c.b = state.B;
  c.maxR = state.maxR;
  c.format = state.format;
  c.template = state.template;
}

function pullCostume() {
  const c = state.strategies.costume;
  if (!c) return;
  state.B = c.b;
  state.maxR = c.maxR;
  state.format = c.format;
  state.template = c.template || null;
}

function strategyConfig(key) {
  return state.strategies[key] || null;
}

// "-1001234, -1005678" ou [ -100... ] -> [ -1001234, -1005678 ]
// Accepte les identifiants numériques (-1001234567890) ET les noms publics
// (@mon_canal) : Telegram gère les deux comme chat_id.
function parseChannels(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;]+/);
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

function setStrategyConfig(key, patch = {}) {
  const def = strategies.BY_KEY[key];
  if (!def) return null;
  const cur = state.strategies[key] || strategies.defaultsFor(key);
  const next = { ...cur };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.format !== undefined) next.format = fmt.clampFormat(patch.format);
  if (patch.formatDistribution !== undefined) next.formatDistribution = fmt.clampFormat(patch.formatDistribution);
  if (patch.maxR !== undefined) next.maxR = Math.max(0, Math.min(9, parseInt(patch.maxR, 10) || 0));
  if (patch.b !== undefined) next.b = Math.max(0, parseInt(patch.b, 10) || 0);
  if (patch.lead !== undefined) next.lead = Math.max(1, Math.min(9, parseInt(patch.lead, 10) || 1));
  // paramètres de la stratégie Pair / Impair (VAR)
  if (patch.startGame !== undefined) next.startGame = Math.max(1, parseInt(patch.startGame, 10) || 1);
  if (patch.varStep !== undefined) next.varStep = Math.max(0, Math.min(99, parseInt(patch.varStep, 10) || 0));
  if (patch.decalage !== undefined) next.decalage = Math.max(1, Math.min(99, parseInt(patch.decalage, 10) || 1));
  // stratégie « Carte absente » : nombre de jeux consécutifs sans le costume
  if (patch.streak !== undefined) next.streak = Math.max(2, Math.min(10, parseInt(patch.streak, 10) || 3));
  // stratégie « Prédiction dans l'ombre » : jeux d'absence minimum + périmètre
  if (patch.absence !== undefined) next.absence = Math.max(1, Math.min(30, parseInt(patch.absence, 10) || 4));
  if (patch.scope !== undefined) next.scope = patch.scope === 'joueur' ? 'joueur' : 'tous';
  // mode silencieux 1 — RÉSERVÉ à la stratégie « ombre », et OBLIGATOIRE pour
  // elle : ombre fonctionne exclusivement via ce filtre, `silent` ne peut donc
  // jamais y être désactivé (patch.silent est ignoré pour cette clé). Pour
  // toute autre stratégie, ces champs sont ignorés et forcés à leur valeur
  // neutre : plus aucun mode silencieux configurable ailleurs dans le projet.
  if (key === 'ombre') {
    next.silent = true;
    // aucun déblocage automatique : le mode silencieux garde la priorité
    next.autoUnlockMin = 0;
    if (patch.lossWindow !== undefined) next.lossWindow = Math.max(1, Math.min(20, parseInt(patch.lossWindow, 10) || 3));
    if (patch.resetOnWin !== undefined) next.resetOnWin = !!patch.resetOnWin;
    if (patch.lossTrigger !== undefined) next.lossTrigger = Math.max(1, Math.min(5, parseInt(patch.lossTrigger, 10) || 2));
    if (patch.lossInterval !== undefined) next.lossInterval = Math.max(0, Math.min(20, parseInt(patch.lossInterval, 10) || 0));
    if (patch.sendOnlyNext !== undefined) next.sendOnlyNext = !!patch.sendOnlyNext;

  } else {
    next.silent = false;
  }
  // déclencheur automatique (perte / rattrapage + nombre de prédictions)
  if (patch.autoEnabled !== undefined) next.autoEnabled = key === 'ombre' ? false : !!patch.autoEnabled;
  if (patch.autoTrigger !== undefined) next.autoTrigger = patch.autoTrigger === 'rattrapage' ? 'rattrapage' : 'perte';
  if (patch.autoRattrapage !== undefined) next.autoRattrapage = Math.max(1, Math.min(9, parseInt(patch.autoRattrapage, 10) || 1));
  if (patch.autoSkip !== undefined) next.autoSkip = Math.max(0, Math.min(20, parseInt(patch.autoSkip, 10) || 0));
  if (patch.autoSend !== undefined) next.autoSend = Math.max(1, Math.min(10, parseInt(patch.autoSend, 10) || 1));
  // Mode d'activation silencieux (2ᵉ mode) SUPPRIMÉ : plus aucun champ
  // `silence*` n'est accepté ici, pour aucune stratégie.
  if (patch.template !== undefined) next.template = patch.template ? String(patch.template) : null;
  if (patch.channels !== undefined || patch.channelId !== undefined || patch.publishedChannels !== undefined) {
    const value = patch.publishedChannels !== undefined
      ? patch.publishedChannels
      : patch.channels !== undefined ? patch.channels : patch.channelId;
    next.publishedChannels = parseChannels(value);
    next.channels = next.publishedChannels;
    if (JSON.stringify(next.publishedChannels) !== JSON.stringify(cur.publishedChannels || cur.channels || [])) {
      next.channelInfos = [];
      next.publishedChannelInfos = [];
    }
  }
  if (patch.shadowChannels !== undefined || patch.shadowChannelId !== undefined) {
    const value = patch.shadowChannels !== undefined ? patch.shadowChannels : patch.shadowChannelId;
    next.shadowChannels = parseChannels(value);
    if (JSON.stringify(next.shadowChannels) !== JSON.stringify(cur.shadowChannels || [])) {
      next.shadowChannelInfos = [];
    }
  }
  if (patch.channelInfos !== undefined) next.channelInfos = patch.channelInfos || [];
  if (patch.publishedChannelInfos !== undefined) next.publishedChannelInfos = patch.publishedChannelInfos || [];
  if (patch.shadowChannelInfos !== undefined) next.shadowChannelInfos = patch.shadowChannelInfos || [];
  // un seul token API pour toute l'application (réglages) : plus de token par stratégie
  delete next.token;
  if (patch.bilan !== undefined) next.bilan = !!patch.bilan;
  state.strategies[key] = next;
  // ⚠️ Chaque mode possède ses PROPRES réglages : on ne remet à zéro l'état
  // d'un mode que si l'une de SES valeurs a réellement changé. Un simple
  // enregistrement du panneau ne détruit donc plus la progression en cours.
  const changed = (f) => JSON.stringify(cur[f]) !== JSON.stringify(next[f]);
  if (['autoEnabled', 'autoTrigger', 'autoRattrapage', 'autoSkip', 'autoSend'].some(changed)) {
    resetAutoGate(key);
  }
  // mode silencieux 1 (filtre pertes) — réglages `loss*` uniquement
  if (['silent', 'lossInterval', 'lossTrigger', 'lossWindow'].some(changed)) {
    resetGate(key);
  }
  if (key === 'costume') pullCostume();
  return next;
}

function resetStrategy(key) {
  if (!strategies.BY_KEY[key]) return null;
  state.strategies[key] = strategies.defaultsFor(key);
  if (key === 'costume') pullCostume();
  return state.strategies[key];
}

function strategyChannels(key, mode = 'published') {
  const c = state.strategies[key];
  if (!c) return mode === 'published' ? state.activeChannels : [];
  const configured = Array.isArray(c.publishedChannels)
    ? c.publishedChannels
    : Array.isArray(c.channels) && c.channels.length ? c.channels : state.activeChannels;
  // Un canal ne reçoit jamais les deux catégories pour une même stratégie.
  // En cas de doublon, le canal PUBLIC est prioritaire : auparavant la liste
  // publique était vidée et PLUS AUCUNE prédiction publique ne partait.
  if (mode === 'shadow') {
    const pub = new Set(configured);
    return (Array.isArray(c.shadowChannels) ? c.shadowChannels : []).filter((id) => !pub.has(id));
  }
  return configured;
}


// ---------------------------------------------------------------------------
// Filtre d'envoi « double perte » (mode silencieux)
// ---------------------------------------------------------------------------
// Tant que le mode silencieux est actif, la stratégie travaille dans l'ombre :
// elle calcule et vérifie ses prédictions SANS rien envoyer dans le canal.
//   1) une 1ʳᵉ perte ouvre une fenêtre de vérification ;
//   2) la fenêtre autorise au MAXIMUM `lossWindow` prédictions terminées ;
//   3) si une 2ᵉ perte tombe dans cette fenêtre → l'envoi est ACTIVÉ
//      (perte+perte = 1 prédiction dans la fenêtre, perte/gagné/perte = 2…) ;
//   4) si la fenêtre est dépassée sans 2ᵉ perte → tout repart à zéro ;
//   5) une fois l'envoi activé, une prédiction gagnée referme l'envoi
//      (réglage `resetOnWin`, activé par défaut) et on repart à zéro.
// Déblocage automatique : une stratégie bloquée (mode silencieux, en attente de
// pertes) est AUTOMATIQUEMENT débloquée au bout de `autoUnlockMin` minutes
// (10 min par défaut). Le blocage ne peut donc jamais durer indéfiniment.
const AUTO_UNLOCK_DEFAULT_MIN = 10;

function autoUnlockMs(cfg) {
  const min = cfg && cfg.autoUnlockMin !== undefined
    ? parseInt(cfg.autoUnlockMin, 10)
    : AUTO_UNLOCK_DEFAULT_MIN;
  if (!Number.isFinite(min) || min <= 0) return 0; // 0 = déblocage auto désactivé
  return Math.min(240, min) * 60 * 1000;
}

function emptyGate() {
  return {
    armed: false, losses: 0, window: 0, since: null,
    counting: false, need: 0, seen: 0,
    blockedSince: Date.now(), autoUnlockedAt: null,
    // CORRECTIF file d'attente « ombre » : plusieurs positions confirmées
    // (phase 2 → 3) peuvent désormais patienter EN MÊME TEMPS, chacune avec
    // son propre décompte. `queue[0]` est toujours la plus ANCIENNE — c'est
    // elle qui doit partir en premier dans le canal public (voir canSend()) ;
    // les suivantes patientent leur tour, sans jamais être ignorées.
    //   entrée : { id, need, seen, refNumber, ready }
    queue: [],
  };
}

// ---------------------------------------------------------------------------
// Persistance du filtre « double perte » (state.gates) : sans ce hook, l'état
// (pertes de référence, phase, écart mesuré…) ne vit qu'en RAM et repart de
// zéro à chaque redémarrage du process (ex. veille/redéploiement Render Free),
// même si 2 pertes viennent réellement de tomber. On notifie donc l'appelant
// (bot.js) à chaque mutation d'un gate pour qu'il le sauvegarde en base.
let onGateChangeHook = null;
function setOnGateChange(fn) { onGateChangeHook = fn; }
function emitGateChange(key) {
  if (onGateChangeHook) { try { onGateChangeHook(key, state.gates[key]); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Annonce publique de la CONFIRMATION (phase 2 → phase 3) : dès qu'une 2ᵉ perte
// confirme la mesure, on notifie immédiatement le canal public de la position
// (1ʳᵉ/2ᵉ/3ᵉ/4ᵉ…) qu'occupera la prochaine prédiction publique — AVANT même que
// le décompte silencieux ne commence. Ce hook est distinct de `onGateChange`
// (qui se déclenche à CHAQUE mutation du filtre) pour ne notifier bot.js que
// sur cet événement précis.
let onConfirmHook = null;
function setOnConfirm(fn) { onConfirmHook = fn; }
function emitConfirm(key, entry) {
  if (onConfirmHook) { try { onConfirmHook(key, entry); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Persistance des annonces (state.announcements) : mêmes symptômes que pour
// les gates avant leur correctif — sans ceci, la liste ne vivait qu'en RAM et
// repartait de zéro à chaque redémarrage du process (veille/redéploiement
// Render Free), même si le filtre (persisté, lui) restait en phase 2/3.
// Résultat observé : /ombreannonces affichait « Aucune annonce pour l'instant »
// alors que /ombrecompte montrait une confirmation déjà en cours. Deux hooks,
// sur le même principe que onGateChange : un pour sauvegarder (créée/mise à
// jour), un pour supprimer (annonce annulée avant son envoi).
let onAnnouncementSaveHook = null;
let onAnnouncementDeleteHook = null;
function setOnAnnouncementSave(fn) { onAnnouncementSaveHook = fn; }
function setOnAnnouncementDelete(fn) { onAnnouncementDeleteHook = fn; }
function emitAnnouncementSave(entry) {
  if (onAnnouncementSaveHook) { try { onAnnouncementSaveHook(entry); } catch (_) {} }
}
function emitAnnouncementDelete(id) {
  if (onAnnouncementDeleteHook) { try { onAnnouncementDeleteHook(id); } catch (_) {} }
}

// restauration au démarrage (voir applyDbConfigs dans bot.js) : recharge la
// liste et repositionne le compteur d'id après le plus grand id connu, pour
// ne jamais réutiliser un id déjà attribué avant le redémarrage.
function restoreAnnouncements(list) {
  state.announcements = Array.isArray(list) ? list.slice() : [];
  announcementSeq = state.announcements.reduce((max, a) => Math.max(max, a.id || 0), 0);
}

// ---------------------------------------------------------------------------
// Historique des annonces de position (une entrée par confirmation) :
//   'en_attente' → l'annonce a été publiée, la phase 3 compte les prédictions
//                  « ombre » (gagné ou perdu, sans distinction) jusqu'à la
//                  position annoncée, sans jamais s'interrompre ;
//   'envoyee'    → la prédiction de la position annoncée est réellement partie
//                  dans le canal public (voir fulfillAnnouncement).
const ANNOUNCEMENTS_MAX = 200; // taille max conservée en mémoire
let announcementSeq = 0;

function pushAnnouncement(key, info) {
  const entry = {
    id: ++announcementSeq,
    strategy: key,
    refNumber: info.refNumber,
    position: info.position,
    createdAt: Date.now(),
    status: 'en_attente',
    sentNumber: null,
    sentAt: null,
  };
  state.announcements.push(entry);
  if (state.announcements.length > ANNOUNCEMENTS_MAX) {
    const removed = state.announcements.splice(0, state.announcements.length - ANNOUNCEMENTS_MAX);
    for (const r of removed) emitAnnouncementDelete(r.id);
  }
  emitAnnouncementSave(entry);
  return entry;
}

// la prédiction annoncée finit par partir réellement dans le canal public
function fulfillAnnouncement(key, gameNumber) {
  // CORRECTIF (priorité) : on résout désormais l'annonce dont la position en
  // file est la PLUS PRIORITAIRE au sens de priorityQueue() — la plus tôt
  // devenue prête, pas forcément la plus ancienne à être entrée en file. Une
  // position arrivée en dernier peut donc bien être résolue avant une
  // position plus ancienne encore en décompte, comme voulu.
  const g = gate(key);
  const ordered = priorityQueue(g).filter((q) => q.ready);
  const readyIds = new Set(ordered.map((q) => q.id));
  const entry = state.announcements
    .filter((a) => a.strategy === key && a.status === 'en_attente' && readyIds.has(a.id))
    .sort((a, b) => ordered.findIndex((q) => q.id === a.id) - ordered.findIndex((q) => q.id === b.id))[0];
  if (!entry) return null;
  entry.status = 'envoyee';
  entry.sentNumber = gameNumber;
  entry.sentAt = Date.now();
  emitAnnouncementSave(entry);
  // retire l'entrée correspondante de la file d'attente interne (phase 3) :
  // sa position vient de partir réellement dans le canal public — la
  // suivante (s'il y en a une) devient la nouvelle tête de file.
  const idx = g.queue.findIndex((q) => q.id === entry.id);
  if (idx !== -1) { g.queue.splice(idx, 1); emitGateChange(key); }
  return entry;
}

function announcementsFor(key, limit = 20) {
  return state.announcements
    .filter((a) => a.strategy === key)
    .slice(-Math.max(1, Math.min(100, limit)))
    .reverse(); // plus récentes en premier
}

function gate(key) {
  if (!state.gates[key]) state.gates[key] = emptyGate();
  const g = state.gates[key];
  if (g.blockedSince == null) g.blockedSince = Date.now();
  if (g.counting === undefined) { g.counting = false; g.need = 0; g.seen = 0; }
  // MIGRATION (« ombre » uniquement) : anciens gates persistés (avant la file
  // d'attente multi-positions) — on convertit l'unique position en cours
  // (s'il y en avait une) en première entrée de la nouvelle file, pour ne
  // rien perdre au premier redémarrage après la mise à jour. Les autres
  // stratégies gardent leur format d'origine (armed/counting/need/seen).
  if (key === 'ombre' && !Array.isArray(g.queue)) {
    g.queue = (g.counting || g.armed) && g.need
      ? [{ id: 0, need: g.need, seen: g.seen || 0, refNumber: g.since, ready: !!g.armed }]
      : [];
  }
  if (!Array.isArray(g.queue)) g.queue = [];
  return g;
}

// annule TOUTES les annonces encore « en_attente » (il peut désormais y en
// avoir plusieurs empilées, une par position confirmée dans la file d'attente)
function cancelAllPendingAnnouncements(key) {
  const pending = state.announcements.filter((a) => a.strategy === key && a.status === 'en_attente');
  for (const entry of pending) {
    const idx = state.announcements.indexOf(entry);
    if (idx !== -1) state.announcements.splice(idx, 1);
    emitAnnouncementDelete(entry.id);
  }
  return pending;
}

// reset COMPLET et volontaire (changement de réglages, déblocage manuel qui
// repart de zéro, etc.) : ici, contrairement à un simple écart dépassé, on
// vide aussi la file d'attente — l'utilisateur a explicitement demandé à
// repartir de zéro.
function resetGate(key) {
  if (key === 'ombre') cancelAllPendingAnnouncements(key);
  state.gates[key] = emptyGate();
  emitGateChange(key);
  return state.gates[key];
}

// reset de la seule mesure de référence (phases 1/2), utilisé quand l'écart
// dépasse l'intervalle maximum : contrairement à resetGate(), la file
// d'attente des positions déjà confirmées (phase 3) n'est JAMAIS touchée —
// rien de ce qui est déjà en file ne doit être perdu ou ignoré.
function resetReference(g) {
  g.losses = 0;
  g.window = 0;
  g.since = null;
  g.blockedSince = Date.now();
  g.autoUnlockReason = null;
}

// déblocage manuel (bouton du panneau / commande Telegram)
function unlockGate(key, manual = true) {
  const g = gate(key);
  if (key === 'ombre') {
    // débloque la position PRIORITAIRE si elle existe (voir priorityQueue —
    // pas forcément la plus ancienne arrivée), sinon en crée une nouvelle
    // immédiate (position 1)
    if (g.queue.length) {
      const target = priorityQueue(g)[0];
      target.ready = true;
      target.readyAt = target.readyAt ?? Date.now();
    } else {
      const entry = pushAnnouncement(key, { position: 1, refNumber: g.since });
      g.queue.push({ id: entry.id, need: 1, seen: 0, refNumber: entry.refNumber, ready: true, readyAt: Date.now() });
    }
    g.losses = Math.max(g.losses, 1);
    g.blockedSince = null;
    g.autoUnlockedAt = Date.now();
    g.autoUnlockReason = manual ? 'déblocage manuel' : 'déblocage automatique (10 min)';
    emitGateChange(key);
    return g;
  }
  g.armed = true;
  g.losses = Math.max(g.losses, 1);
  g.window = 0;
  g.blockedSince = null;
  g.autoUnlockedAt = Date.now();
  g.autoUnlockReason = manual ? 'déblocage manuel' : 'déblocage automatique (10 min)';
  const cfg = state.strategies[key];
  if (cfg && cfg.autoEnabled) { const a = autoGate(key); a.armed = true; a.counting = false; a.reason = 'déblocage manuel'; }
  emitGateChange(key);
  return g;
}

// applique le déblocage automatique si le délai est écoulé
function applyAutoUnlock(key) {
  const cfg = state.strategies[key];
  if (!cfg || !cfg.silent) return false;
  // « ombre » : le mode silencieux est PRIORITAIRE et ne peut jamais être
  // contourné par un déblocage automatique — seules les phases 1/2/3 ouvrent
  // l'envoi public (un déblocage manuel reste possible via /debloquer).
  if (key === 'ombre') return false;
  const g = gate(key);
  if (g.armed) return false;
  const delay = autoUnlockMs(cfg);
  if (!delay) return false;
  if (g.blockedSince == null) { g.blockedSince = Date.now(); return false; }
  if (Date.now() - g.blockedSince < delay) return false;
  unlockGate(key, false);
  return true;
}

// balayage périodique de toutes les stratégies (appelé par la boucle du bot)
function sweepAutoUnlock() {
  const freed = [];
  for (const key of Object.keys(state.strategies || {})) {
    if (applyAutoUnlock(key)) freed.push(key);
  }
  return freed;
}

function windowSize(cfg) {
  return Math.max(1, Math.min(20, parseInt(cfg && cfg.lossWindow, 10) || 3));
}

// intervalle MAXIMUM (écart, en nombre de prédictions terminées) autorisé entre
// la perte de référence et la perte suivante pour que celle-ci CONFIRME.
// Intervalle configuré 0-4 (max = 4) :
//   • écart ≤ 4  → perte confirmée (N = écart) ;
//   • écart > 4  → perte trop loin : retour intégral en phase 1 (aucune référence).
// 0 = aucune limite (toute perte suivante confirme).
function lossIntervalMax(cfg) {
  return Math.max(0, Math.min(20, parseInt(cfg && cfg.lossInterval, 10) || 0));
}

// (compat) ancien nom conservé pour les appels externes
function lossIntervalMin(cfg) { return lossIntervalMax(cfg); }

// phase 2 : cette perte devient la référence, la fenêtre d'écart repart de 0
// (ne touche JAMAIS à la file d'attente — voir resetReference()/confirmQueueEntry())
function startWindow(key, target) {
  const g = gate(key);
  g.losses = 1;
  g.window = 0;
  g.since = target;
  if (g.blockedSince == null) g.blockedSince = Date.now();
  g.autoUnlockReason = null;
  return g;
}

// mise à jour du filtre à chaque prédiction terminée
function noteClosed(pred) {
  try { noteClosedInner(pred); } finally { emitGateChange(pred.strategy); }
}

function noteClosedInner(pred) {
  const cfg = state.strategies[pred.strategy];
  if (!cfg) return;
  // le déclencheur automatique « perte/rattrapage + N » est générique et
  // s'applique à TOUTES les stratégies (indépendant du filtre ci-dessous).
  noteClosedAuto(pred);

  // ── À PARTIR D'ICI : réservé EXCLUSIVEMENT à la stratégie « ombre » ──────
  // Le filtre « double perte » (phases 1→2→3) et les annonces de position
  // (« 🔔 La prochaine après... ») ne concernent QUE « ombre ». Avant ce
  // garde-fou, la machinerie tournait pour toutes les stratégies : une autre
  // stratégie accumulant 2 pertes dans sa fenêtre pouvait déclencher elle
  // aussi une annonce publique et polluer son propre canal — un comportement
  // jamais voulu, puisque `canSend()` n'utilise ce filtre que pour « ombre ».
  if (pred.strategy !== 'ombre') return;

  const g = gate(pred.strategy);
  const win = pred.status === 'gagné';

  // nombre de pertes nécessaires avant d'ouvrir l'envoi (1 = envoi dès la 1ʳᵉ perte)
  const need = Math.max(1, Math.min(5, parseInt(cfg.lossTrigger, 10) || 2));
  const maxGap = lossIntervalMax(cfg);

  // --- CORRECTIF FILE D'ATTENTE -------------------------------------------
  // Avant ce correctif, dès qu'une position était confirmée (phase 2 → 3),
  // le filtre entrait en « comptage silencieux » ÉTANCHE : toute nouvelle
  // perte de référence pendant ce décompte était totalement IGNORÉE — la
  // mesure de l'écart (phase 1/2) ne reprenait qu'une fois la position en
  // cours envoyée. Résultat : impossible d'avoir 2 positions en attente en
  // même temps, et une perte survenue pendant le décompte silencieux était
  // purement et simplement perdue.
  //
  // Nouveau fonctionnement :
  //  1) la file d'attente (phase 3) avance TOUJOURS, sur CHAQUE prédiction
  //     « ombre » qui se termine (gagnée ou perdue) — chaque position déjà
  //     confirmée compte indépendamment, dans l'ordre où elle a été ajoutée ;
  //  2) la mesure de référence (phases 1 → 2) ne s'arrête JAMAIS : elle
  //     continue de tourner MÊME pendant qu'une ou plusieurs positions
  //     patientent déjà en file, afin de pouvoir en confirmer une deuxième
  //     (ou plus) sans jamais ignorer une perte ;
  //  3) dès qu'une confirmation a lieu, la perte qui vient de confirmer sert
  //     IMMÉDIATEMENT de nouvelle référence : le filtre repart directement
  //     en phase 2 (PAS en phase 1) et continue son travail. Tant qu'il y a
  //     des pertes dans l'intervalle, il reste en phase 2 pour alimenter la
  //     file ; seul un écart supérieur à l'intervalle max le fait revenir en
  //     phase 1 — et cela ne touche QUE la mesure de référence, jamais la
  //     file d'attente déjà constituée (rien de ce qui y est n'est perdu).
  advanceQueue(g, pred);

  // une prédiction réellement ENVOYÉE PUBLIQUEMENT qui gagne referme le
  // cycle de référence (si resetOnWin) — la file d'attente, elle, continue
  // de vivre sa vie normalement pour les positions suivantes déjà en cours.
  const wasPublic = !!(pred.messages && pred.messages.length);
  if (win && wasPublic && cfg.resetOnWin !== false) {
    resetReference(g);
    return;
  }

  // --- phase 1 : aucune référence, on attend la 1ʳᵉ perte ----------------
  if (g.losses === 0) { phase1Waiting(pred, g, win, need); return; }

  // --- phase 2 : fenêtre ouverte, on mesure l'écart jusqu'à confirmation --
  phase2Measuring(pred, g, win, need, maxGap);
}

// fait avancer TOUTES les entrées encore en décompte de la file d'attente
// (phase 3) — chacune compte indépendamment depuis sa propre confirmation,
// jusqu'à atteindre sa position N. Une fois prête, une entrée n'avance plus :
// elle attend simplement son tour d'être réellement envoyée (voir canSend()
// et fulfillAnnouncement(), qui la retire de la file une fois partie).
// CORRECTIF (décalage de position) : `entry.refNumber` est désormais mis à
// jour à CHAQUE prédiction « sautée » (pas seulement à la création de
// l'entrée). Sans ça, le « plancher » (voir queueFloor()/bot.js) restait
// bloqué sur le numéro de la perte confirmante, et le mécanisme de rattrapage
// des prédictions silencieuses pouvait renvoyer une prédiction déjà comptée
// dans le décompte (donc une position trop tôt) au lieu d'attendre la vraie
// N-ᵉ prédiction suivante.
function advanceQueue(g, pred) {
  for (const entry of g.queue) {
    if (entry.ready) continue;
    entry.seen += 1;
    if (pred && pred.target != null) entry.refNumber = pred.target;
    if (entry.seen >= Math.max(1, entry.need) - 1) { entry.ready = true; entry.readyAt = Date.now(); }
  }
}

// une confirmation (phase 2 atteinte) : la position N rejoint la file
// d'attente (elle patientera son tour derrière celles déjà présentes, voir
// canSend() qui ne sert jamais que la plus ANCIENNE en premier), PUIS la
// perte qui vient de confirmer sert directement de nouvelle référence pour
// continuer la mesure (retour immédiat en phase 2, sans repasser par la
// phase 1) — comme demandé : tant qu'il y a des pertes dans l'intervalle, on
// reste en phase 2 pour alimenter la file.
// CORRECTIF (numéro affiché faux, ex. « #N47 » au lieu de « #N45 ») :
// `pred.hitNumber` est le numéro du jeu où la perte a été CONFIRMÉE après
// rattrapage (target + step + gap), pas le numéro de la prédiction elle-même.
// La file d'attente et son plancher doivent travailler exclusivement sur
// `pred.target` (le vrai numéro de la prédiction), jamais sur `hitNumber`.
// ordre de PRIORITÉ (et non d'arrivée) de la file « ombre » : une position
// prête passe toujours avant une position encore en décompte — même si elle
// est arrivée APRÈS dans la file — et parmi les positions prêtes, celle
// devenue prête EN PREMIER (readyAt le plus ancien) part en premier. Parmi
// les positions encore en décompte, celle la plus proche de la fin (le moins
// de prédictions restantes avant d'être prête) est classée devant : c'est
// elle qui « peut passer » devant une position arrivée avant elle mais plus
// longue à confirmer.
function queueRemaining(entry) {
  return Math.max(0, Math.max(1, entry.need) - 1 - entry.seen);
}
function priorityQueue(g) {
  return [...g.queue].sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    if (a.ready) return (a.readyAt || 0) - (b.readyAt || 0);
    return queueRemaining(a) - queueRemaining(b);
  });
}

function confirmQueueEntry(pred, g, N) {
  const entry = pushAnnouncement(pred.strategy, { position: N, refNumber: pred.target });
  g.queue.push({ id: entry.id, need: N, seen: 0, refNumber: entry.refNumber, ready: N <= 1, readyAt: N <= 1 ? Date.now() : null });
  emitConfirm(pred.strategy, entry);
  startWindow(pred.strategy, pred.target);
}

// phase 1 : première perte rencontrée → elle devient la référence et ouvre
// la fenêtre de mesure (phase 2). Avec lossTrigger=1, cette perte seule
// suffit à confirmer : elle rejoint directement la file en position 1.
function phase1Waiting(pred, g, win, need) {
  if (win) return;
  if (need <= 1) { confirmQueueEntry(pred, g, 1); return; }
  startWindow(pred.strategy, pred.target);
}

// phase 2 : mesure l'écart (en prédictions terminées) entre la perte de
// référence et la perte suivante. Écart STRICTEMENT supérieur à l'intervalle
// configuré (gain OU perte, peu importe) → la mesure de référence REPART en
// phase 1 (aucune référence) — SANS jamais toucher à la file d'attente déjà
// constituée : rien de ce qui y est déjà n'est ignoré ou annulé.
// Un écart ÉGAL à l'intervalle reste valide (pas de retour en phase 1) : si
// c'est une perte, elle peut confirmer normalement et rejoindre la file.
// Sinon, dès que `need` pertes sont réunies dans la fenêtre, l'écart mesuré
// devient la position N, elle rejoint la file, et la mesure repart aussitôt
// en phase 2 (voir confirmQueueEntry).
function phase2Measuring(pred, g, win, need, maxGap) {
  g.window += 1;
  if (maxGap && g.window > maxGap) {
    resetReference(g);
    return;
  }
  if (win) return;
  g.losses += 1;
  if (g.losses >= need) {
    const N = Math.max(1, g.window);
    confirmQueueEntry(pred, g, N);
    return;
  }
  // sans intervalle max configuré, on garde la limite « lossWindow » (fenêtre
  // dépassée sans confirmation → seule la référence repart à zéro, la file
  // d'attente déjà constituée reste intacte).
  const max = windowSize(state.strategies[pred.strategy]);
  if (!maxGap && g.window >= max) resetReference(g);
}


// ---------------------------------------------------------------------------
// Déclencheur automatique : « perte + N prédictions » ou « rattrapage X + N »
// ---------------------------------------------------------------------------
// Fonctionnement (commun à TOUTES les stratégies, indépendant du mode silencieux) :
//   1) le bot attend l'ÉVÉNEMENT déclencheur configuré :
//        • autoTrigger = 'perte'      → une prédiction perdue (❌)
//        • autoTrigger = 'rattrapage' → une prédiction terminée AU rattrapage
//          demandé ou au-delà (ex. rattrapage 2 → gagnée en 2 ou perdue après 2)
//   2) après ce déclencheur il COMPTE `autoSkip` prédictions terminées, qui
//      restent silencieuses (visibles sur le site / canal silencieux) ;
//   3) la prédiction SUIVANTE part automatiquement dans le canal public ;
//      `autoSend` permet d'en envoyer plusieurs d'affilée (1 par défaut) ;
//   4) le compteur repart ensuite à zéro et attend un nouveau déclencheur.
// Exemples : « perte + 3 prédictions » → ❌ · P1 P2 P3 (silence) · P4 ENVOYÉE.
//            « rattrapage 2 + 3 prédictions » → ✅2 · P1 P2 P3 · P4 ENVOYÉE.
function autoCfg(cfg) {
  return {
    enabled: !!(cfg && cfg.autoEnabled),
    trigger: cfg && cfg.autoTrigger === 'rattrapage' ? 'rattrapage' : 'perte',
    level: Math.max(1, Math.min(9, parseInt(cfg && cfg.autoRattrapage, 10) || 2)),
    skip: Math.max(0, Math.min(20, parseInt(cfg && cfg.autoSkip, 10) || 0)),
    send: Math.max(1, Math.min(10, parseInt(cfg && cfg.autoSend, 10) || 1)),
  };
}

function autoGate(key) {
  if (!state.autoGates[key]) state.autoGates[key] = { armed: false, counting: false, seen: 0, sent: 0, triggeredAt: null, reason: null };
  return state.autoGates[key];
}

function resetAutoGate(key) {
  state.autoGates[key] = { armed: false, counting: false, seen: 0, sent: 0, triggeredAt: null, reason: null };
  return state.autoGates[key];
}

function isAutoTrigger(pred, a) {
  if (a.trigger === 'perte') return pred.status === 'perdu';
  return (pred.step || 0) >= a.level;    // rattrapage atteint (gagné ou perdu)
}

// mise à jour du déclencheur automatique à chaque prédiction terminée
function noteClosedAuto(pred) {
  const a = autoCfg(state.strategies[pred.strategy]);
  if (!a.enabled) return;
  const g = autoGate(pred.strategy);
  if (g.armed) return;                    // une prédiction est déjà autorisée
  if (isAutoTrigger(pred, a)) {
    g.counting = true;
    g.seen = 0;
    g.sent = 0;
    g.triggeredAt = pred.target;
    g.reason = a.trigger === 'perte'
      ? `perte sur #N${pred.target}`
      : `rattrapage ${pred.step} sur #N${pred.target}`;
    if (a.skip === 0) { g.armed = true; g.counting = false; }
    return;
  }
  if (!g.counting) return;
  g.seen += 1;
  if (g.seen >= a.skip) { g.armed = true; g.counting = false; }
}

// consommation : appelée après l'envoi public d'une prédiction
function noteSent(key) {
  const a = autoCfg(state.strategies[key]);
  if (!a.enabled) return;
  const g = autoGate(key);
  if (!g.armed) return;
  g.sent += 1;
  if (g.sent >= a.send) resetAutoGate(key);
}

// état lisible du déclencheur automatique
function autoView(key) {
  const cfg = state.strategies[key] || {};
  const a = autoCfg(cfg);
  const g = autoGate(key);
  const trigLabel = a.trigger === 'perte' ? 'une perte' : `un rattrapage ${a.level}`;
  return {
    enabled: a.enabled,
    trigger: a.trigger,
    rattrapage: a.level,
    skip: a.skip,
    send: a.send,
    counting: !!g.counting,
    seen: g.seen,
    armed: !!g.armed,
    sent: g.sent,
    triggeredAt: g.triggeredAt,
    label: !a.enabled
      ? 'Déclencheur automatique désactivé'
      : g.armed
        ? `Prochaine prédiction ENVOYÉE automatiquement (${g.sent}/${a.send} envoyée(s))`
        : g.counting
          ? `Déclencheur pris (${g.reason}) : ${g.seen}/${a.skip} prédiction(s) comptée(s)`
          : `En attente de ${trigLabel} (puis ${a.skip} prédiction(s) avant l'envoi)`,
  };
}

// (mode d'activation silencieux — 2ᵉ mode — retiré du projet)


// une prédiction de cette stratégie peut-elle partir dans le canal ?
function canSend(key) {
  const cfg = state.strategies[key];
  if (!cfg) return true;
  // « ombre » : seul le mode silencieux 1 décide de l'envoi. Le déclencheur
  // automatique ne s'applique pas à cette stratégie (elle n'a qu'un seul
  // filtre, pas deux qui se cumulent).
  if (key === 'ombre') {
    applyAutoUnlock(key);
    // priorité à la position PRÊTE la plus proche de sa confirmation, jamais
    // seulement à la plus ancienne entrée de la file (voir priorityQueue()).
    const g = gate(key);
    const ordered = priorityQueue(g);
    return !!(ordered.length && ordered[0].ready);
  }
  // le déclencheur automatique remplace le filtre « double perte » quand il est actif
  if (cfg.autoEnabled) return !!autoGate(key).armed;
  if (!cfg.silent) return true;
  applyAutoUnlock(key);
  return !!gate(key).armed;
}

// consommation après un envoi public déclenché par le filtre « double perte » :
// si `sendOnlyNext` est activé, une seule prédiction part puis le filtre repasse
// en silence (attente d'une nouvelle 1ʳᵉ perte) au lieu d'envoyer en continu.
function noteGateSent(key) {
  const cfg = state.strategies[key];
  if (!cfg || cfg.autoEnabled || !cfg.silent || !cfg.sendOnlyNext) return;
  const g = gate(key);
  const wasReady = key === 'ombre' ? true /* fulfillAnnouncement vient de dépiler la tête de file */ : !!g.armed;
  if (!wasReady) return;
  resetGate(key);
}

// plus petit refNumber encore actif pour « ombre » (garde-fou anti-résurrection
// d'une vieille prédiction d'un cycle abandonné, voir bot.js/tick()) : couvre
// aussi bien la file d'attente (positions déjà confirmées) que la mesure de
// référence en cours (g.since), en prenant la plus ancienne des deux.
function queueFloor(key) {
  const g = gate(key);
  const refs = g.queue.map((q) => q.refNumber).filter((n) => n != null);
  if (g.since != null) refs.push(g.since);
  return refs.length ? Math.min(...refs) : null;
}

// état lisible du filtre (panel web / Telegram)
function gateView(key) {
  const cfg = state.strategies[key] || {};
  applyAutoUnlock(key);
  const g = gate(key);
  const max = windowSize(cfg);
  const need = Math.max(1, Math.min(5, parseInt(cfg.lossTrigger, 10) || 2));
  const maxGap = lossIntervalMax(cfg);
  const delay = autoUnlockMs(cfg);
  const waitedMs = g.blockedSince ? Date.now() - g.blockedSince : 0;
  // « ombre » : la file d'attente peut contenir plusieurs positions confirmées
  // en même temps. Pour compatibilité avec tout ce qui lisait déjà armed /
  // counting / position / seen, ces champs reflètent la position PRIORITAIRE
  // (voir priorityQueue() : prête en premier, ou la plus proche de l'être) —
  // pas forcément la plus ancienne entrée dans l'ordre d'arrivée ; `queue`
  // expose la liste complète, elle aussi triée par priorité d'envoi.
  const isOmbre = key === 'ombre';
  const ordered = isOmbre ? priorityQueue(g) : [];
  const front = isOmbre ? (ordered[0] || null) : null;
  const armed = isOmbre ? !!(front && front.ready) : !!g.armed;
  const counting = isOmbre ? !!(front && !front.ready) : !!g.counting;
  const phase = armed ? 3 : counting ? 3 : g.losses >= 1 ? 2 : 1;
  return {
    lossTrigger: need,
    lossInterval: maxGap,
    autoUnlockMin: delay ? Math.round(delay / 60000) : 0,
    autoUnlockInSec: delay && g.blockedSince && !armed ? Math.max(0, Math.round((delay - waitedMs) / 1000)) : null,
    autoUnlocked: !!g.autoUnlockedAt,
    autoUnlockReason: g.autoUnlockReason || null,
    silent: !!cfg.silent,
    auto: autoView(key),
    lossWindow: max,
    resetOnWin: cfg.resetOnWin !== false,
    sendOnlyNext: !!cfg.sendOnlyNext,
    armed,
    losses: g.losses,
    used: g.window,
    phase,
    counting,
    position: front ? front.need : (g.need || null),
    seen: front ? front.seen : (g.seen || 0),
    since: g.since,
    left: g.losses === 1 && !maxGap ? Math.max(0, max - g.window) : null,
    sending: canSend(key),
    // file d'attente complète (« ombre » uniquement) : chaque position en
    // attente, dans l'ordre exact où elle sera envoyée. `refNumber` est le
    // numéro du jeu qui a confirmé (ou fait progresser) cette position —
    // affiché sur le site pour que la file soit visible même AVANT que la
    // prédiction réelle ne soit calculée.
    queueLength: isOmbre ? g.queue.length : undefined,
    queue: isOmbre ? ordered.map((q) => ({ id: q.id, position: q.need, seen: q.seen, ready: q.ready, refNumber: q.refNumber })) : undefined,
    priority: key === 'ombre' ? 'silencieux' : cfg.autoEnabled ? 'auto' : 'direct',
    label: cfg.autoEnabled && key !== 'ombre'
      ? autoView(key).label
      : !cfg.silent
      ? 'Envoi direct (mode silencieux désactivé)'
      : armed
        ? (g.autoUnlockReason
            ? `Envoi ACTIF (${g.autoUnlockReason})`
            : `Phase 3 — prédiction ${front && front.need ? `n°${front.need} ` : ''}ENVOYÉE publiquement${cfg.sendOnlyNext ? ' — puis retour au silence' : ''}` +
              (isOmbre && g.queue.length > 1 ? ` · +${g.queue.length - 1} en attente derrière` : ''))
        : counting
          ? `Phase 3 — décompte silencieux : ${front.seen}/${front.need} avant la position N=${front.need}` +
            (isOmbre && g.queue.length > 1 ? ` · +${g.queue.length - 1} en attente derrière` : '')
          : g.losses >= 1
            ? `Phase 2 — référence #N${g.since} · écart ${g.window}` +
              (maxGap ? ` (confirmation si écart ≤ ${maxGap})` : ` (fenêtre ${g.window}/${max})`) +
              ` — ${g.losses}/${need} perte(s)` +
              (isOmbre && g.queue.length ? ` · ${g.queue.length} position(s) déjà en file` : '')
            : delay
              ? `Phase 1 — on attend la 1ʳᵉ perte (déblocage auto dans ${Math.max(0, Math.round((delay - waitedMs) / 60000))} min)`
              : "Phase 1 — on attend la 1ʳᵉ perte",
  };
}

// ---------------------------------------------------------------------------
// Lecture des mains
// ---------------------------------------------------------------------------
function handSuits(game) {
  if (!game) return [];
  return strategies.suitsOf(game.playerSuits);
}

function hasSuit(game, suit) {
  const want = normSuit(suit);
  if (!want) return false;
  return handSuits(game).includes(want);
}

function suitForNumber(n) {
  return strategies.suitForNumber(n);
}

function nextTarget(current) {
  for (let n = current + config.LEAD; n < current + 40; n++) {
    if (suitForNumber(n)) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Enregistrement des jeux + détection du jeu LIVE
// ---------------------------------------------------------------------------
let onFinishedHook = null;
function setOnFinished(fn) { onFinishedHook = fn; }

// déclenché UNE fois par vrai nouveau sabot (retour du jeu à #N1) — utilisé
// par shoe-report.js pour envoyer le rapport PDF des déclencheurs fiables.
// CORRECTIF : plusieurs modules doivent réagir à un nouveau sabot (bot.js
// pour le rapport PDF, after-loss.js pour remettre à zéro ses compteurs —
// voir plus bas) ; un seul callback à la fois écrasait le précédent, donc
// on garde désormais une LISTE d'écouteurs plutôt qu'un unique callback.
const onShoeResetHooks = [];
function setOnShoeReset(fn) { if (typeof fn === 'function') onShoeResetHooks.push(fn); }

// ---------------------------------------------------------------------------
// Nouveau sabot : la table repart au jeu n°1
// ---------------------------------------------------------------------------
// CORRECTIF : sans remise à zéro, `maxFinishedNumber()` gardait l'ancien numéro
// (ex. 1440) alors que les nouveaux jeux repartent à 1. Toutes les cibles
// calculées étaient donc considérées comme « déjà jouées » et PLUS AUCUNE
// prédiction ne sortait après l'envoi du bilan.
function resetShoe(reason = 'nouveau sabot') {
  state.games.clear();
  state.history = [];
  state.freshFinished = [];
  state.triggersDone = {};
  state.lastFinished = null;
  for (const s of SUITS) state.counters[s] = 0;
  // les prédictions encore en attente visaient l'ancien sabot : elles sont closes
  for (const p of state.predictions) {
    if (p.status === 'en attente') { p.status = 'annulé'; p.badge = '♻️'; }
  }
  state.shoeResetAt = Date.now();
  state.shoeResetReason = reason;
  // compteur de sabots : le bot s'en sert pour publier le bilan complet
  // (toutes les stratégies + prédictions IA) dès que le jeu repart à 1.
  state.shoeSeq = (state.shoeSeq || 0) + 1;
  // asynchrone et volontairement non bloquant : resetShoe() reste synchrone,
  // la génération du PDF et l'envoi Telegram se font en arrière-plan.
  for (const hook of onShoeResetHooks) {
    try { Promise.resolve(hook(reason, state.shoeSeq)).catch(() => {}); } catch (_) {}
  }
  return true;
}

function isNewShoe(incoming) {
  const maxDone = maxFinishedNumber();
  if (!maxDone || !incoming.length) return false;
  const numbers = incoming.map((g) => g.number).filter((n) => Number.isFinite(n));
  if (!numbers.length) return false;
  const minIn = Math.min(...numbers);
  const maxIn = Math.max(...numbers);
  // le flux redescend nettement sous le dernier tour connu → la table a rebouclé
  if (maxIn + 10 < maxDone) return true;
  if (minIn <= 1 && maxDone > 10 && !state.games.has(1)) return true;
  // même numéro de tour mais contenu différent (ou tour redevenu « en cours ») :
  // la table a redistribué depuis le début → nouveau sabot
  for (const g of incoming) {
    const prev = state.games.get(g.number);
    if (!prev || !prev.finished) continue;
    if (!g.finished) return true;
    if (signatureOf(g) !== signatureOf(prev)) return true;
  }
  return false;
}

function signatureOf(g) {
  return [
    (g.player || []).join(','), (g.banker || []).join(','),
    g.playerValue, g.bankerValue, g.winner || '',
  ].join('|');
}

function registerGames(games) {
  if (isNewShoe(games)) resetShoe();
  // CORRECTIF : l'API renvoie les jeux du plus RÉCENT au plus ancien. Il faut les
  // traiter dans l'ordre CROISSANT, sinon « lastFinished » devient le jeu le plus
  // ancien : toutes les cibles calculées semblent déjà jouées et AUCUNE
  // prédiction ne sort jamais.
  const ordered = [...games].sort((a, b) => a.number - b.number);
  for (const g of ordered) {
    const prev = state.games.get(g.number);
    // CORRECTIF « vérifications ratées » : le flux 1xbet renvoie parfois un
    // tour DÉJÀ connu dans une version appauvrie (cartes vidées, tour repassé
    // « en cours »). Écraser la bonne version faisait perdre les cartes du
    // joueur → la vérification comparait du vide et comptait une perte.
    // On ne remplace donc jamais une version complète par une version moins
    // complète du même tour.
    if (prev && prev.finished && prev.complete && !(g.finished && g.complete)) continue;
    if (prev && prev.complete && !g.complete) continue;
    state.games.set(g.number, g);
    if (g.finished && (!prev || !prev.finished)) onFinished(g);
  }
  if (state.games.size > 600) {
    const keys = [...state.games.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, state.games.size - 600)) state.games.delete(k);
  }
  // sécurité : le dernier tour terminé est TOUJOURS le plus grand numéro terminé
  const maxDone = maxFinishedNumber();
  if (maxDone && (!state.lastFinished || state.lastFinished.number !== maxDone)) {
    const g = state.games.get(maxDone);
    if (g) state.lastFinished = g;
  }
  state.live = detectLive();
  return state.live;
}

function detectLive() {
  const all = [...state.games.values()].sort((a, b) => a.number - b.number);
  const dealing = all.filter((g) => !g.finished && g.dealing);
  if (dealing.length) return dealing[0];
  const pending = all.filter((g) => !g.finished);
  if (pending.length) return pending[0];
  return state.lastFinished;
}

function maxFinishedNumber() {
  let max = 0;
  for (const g of state.games.values()) if (g.finished && g.number > max) max = g.number;
  return max;
}

// compteur B : 0 si absent, +1 si présent, repart à 1 après avoir atteint B
function bumpCounters(round) {
  const b = state.B;
  for (const s of SUITS) {
    if (hasSuit(round, s)) {
      if (state.counters[s] >= b) state.counters[s] = 1;
      else state.counters[s] += 1;
      if (state.counters[s] > b) state.counters[s] = b;
    } else {
      state.counters[s] = 0;
    }
  }
}

function onFinished(round) {
  state.lastFinished = round;
  state.history.unshift(round);
  state.history = state.history.slice(0, 200);
  bumpCounters(round);
  state.freshFinished.push(round);
  if (state.freshFinished.length > 20) state.freshFinished = state.freshFinished.slice(-20);
  if (onFinishedHook) { try { onFinishedHook(round); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Prédiction : toutes les stratégies actives sont évaluées
// ---------------------------------------------------------------------------
function evaluate() {
  initStrategies();
  syncCostume();
  const out = [];
  // CORRECTIF : plusieurs tours peuvent se terminer entre deux passages. On
  // évalue CHAQUE tour terminé (dans l'ordre) et plus seulement le dernier,
  // sinon un déclencheur (ex. retour de carte pour la stratégie Ombre) est perdu.
  const fresh = state.freshFinished.length
    ? [...state.freshFinished].sort((a, b) => a.number - b.number)
    : state.lastFinished ? [state.lastFinished] : [];
  state.freshFinished = [];
  const jobs = [];
  for (const def of strategies.LIST) {
    const cfg = state.strategies[def.key];
    if (!cfg || !cfg.enabled) continue;
    if (def.source === 'live') {
      if (state.live) jobs.push([def, cfg, state.live]);
    } else {
      for (const g of fresh) jobs.push([def, cfg, g]);
    }
  }
  for (const [def, cfg, source] of jobs) {
    let hit = null;
    try {
      hit = def.detect(source, cfg, { counters: state.counters, games: state.games });
    } catch (e) {
      state.lastError = `${def.key}: ${e.message}`;
      continue;
    }
    if (!hit) continue;
    if (state.predictions.some((p) => p.strategy === def.key && p.target === hit.target)) continue;
    // règle 1 : un jeu déclencheur n'est traité qu'une seule fois
    const trigKey = hit.trigger != null ? `${def.key}:${hit.trigger}` : null;
    if (trigKey && state.triggersDone[trigKey]) continue;
    if (hit.target <= maxFinishedNumber()) {
      // le tour cible est déjà joué (bot lancé en retard) → on marque le
      // déclencheur comme consommé et on attend le suivant, sans rejouer le passé
      if (trigKey) state.triggersDone[trigKey] = true;
      continue;
    }

    const pred = {
      id: `${def.key}-${hit.target}-${Date.now()}`,
      strategy: def.key,
      strategyName: def.name,
      kind: hit.kind,
      target: hit.target,
      suit: hit.suit ? (hit.kind === 'suit' ? normSuit(hit.suit) : hit.suit) : null,
      cardsLabel: hit.cardsLabel || null,
      wantPlayer: hit.wantPlayer != null ? hit.wantPlayer : null,
      wantBanker: hit.wantBanker != null ? hit.wantBanker : null,
      label: hit.label || hit.suit || '',
      reason: hit.reason || '',
      meta: hit.meta || null,
      hand: 'joueur',
      trigger: hit.trigger != null ? hit.trigger : null,
      from: source.number,
      step: 0,
      maxR: cfg.maxR,
      counter: hit.counter != null ? hit.counter : null,
      b: cfg.b || 0,
      format: hit.format || cfg.format,
      template: cfg.template || null,
      sentAt: Date.now(),
      status: 'en attente',
      badge: null,
      result: null,
      hitNumber: null,
      messages: [],
    };
    if (trigKey) state.triggersDone[trigKey] = true;
    state.predictions.unshift(pred);
    out.push(pred);
  }
  state.predictions = state.predictions.slice(0, 300);
  return out;
}

// ---------------------------------------------------------------------------
// Vérification (main du joueur)
// ---------------------------------------------------------------------------
function parityOf(game) {
  if (!game || game.playerValue == null) return null;
  return game.playerValue % 2 === 0 ? 'pair' : 'impair';
}

function matches(pred, game) {
  if (!game) return false;
  if (pred.kind === 'parity') {
    const par = parityOf(game);
    if (!par) return false;
    return par === pred.suit;
  }
  if (pred.kind === 'cards') {
    if (pred.wantPlayer != null && game.playerCards !== pred.wantPlayer) return false;
    if (pred.wantBanker != null && game.bankerCards !== pred.wantBanker) return false;
    return true;
  }
  return hasSuit(game, pred.suit);
}

function resultText(pred, game) {
  if (!game) return null;
  if (pred.kind === 'parity') return `joueur ${game.playerValue ?? '—'} (${parityOf(game) || '—'})`;
  if (pred.kind === 'cards') return `joueur ${game.playerCards}/banquier ${game.bankerCards}`;
  return handSuits(game).join(' ');
}

function verify() {
  const closed = [];
  const maxDone = maxFinishedNumber();
  // CORRECTIF : state.predictions est trié du plus récent au plus ancien.
  // Le filtre « double perte » doit voir les résultats dans l'ordre CHRONOLOGIQUE,
  // sinon la fenêtre après une perte est comptée à l'envers.
  const queue = [...state.predictions].sort((a, b) => a.target - b.target);
  for (const p of queue) {
    if (p.status !== 'en attente') continue;
    let guard = 0;
    if (p.gap == null) p.gap = 0;
    while (p.status === 'en attente' && guard++ <= p.maxR + p.gap + 8) {
      const num = p.target + p.step + p.gap;
      const g = state.games.get(num);
      // Un tour n'est vérifiable que s'il est TERMINÉ **et** complet (cartes
      // du joueur reçues). Sinon il est considéré comme manquant.
      const usable = !!g && g.finished && g.complete !== false;
      if (!usable) {
        // CORRECTIF MAJEUR « le jeu en live saute » : avant, un tour absent du
        // flux consommait une étape de rattrapage et pouvait clôturer la
        // prédiction en ❌ alors qu'elle n'avait jamais été vérifiée.
        // Désormais un tour manquant est SAUTÉ (décalage `gap`) sans consommer
        // d'étape : la vérification se fera sur le tour suivant réellement lu.
        // On laisse d'abord 2 tours de battement pour que les données arrivent.
        if (num + 2 <= maxDone) {
          p.gap += 1;
          p.skipped = (p.skipped || 0) + 1;
          if (!p.skippedNumbers) p.skippedNumbers = [];
          p.skippedNumbers.push(num);
          // trop de tours illisibles d'affilée : on annule au lieu d'inventer
          // un résultat faux.
          if (p.skipped > 6) {
            p.status = 'annulé';
            p.badge = '♻️';
            p.result = 'tours non lus dans le flux';
            noteClosed(p);
            closed.push(p);
            break;
          }
          continue;
        }
        break; // le tour est encore en cours (ou pas encore lu) : on attend
      }
      if (matches(p, g)) {
        p.status = 'gagné';
        p.badge = BADGES[p.step] || `${p.step}`;
        p.result = resultText(p, g);
        p.hitNumber = num;
        p.game = g;
        noteClosed(p);
        closed.push(p);
        break;
      }
      if (p.step >= p.maxR) {
        p.status = 'perdu';
        p.badge = '❌';
        p.result = resultText(p, g);
        p.hitNumber = num;
        p.game = g;
        noteClosed(p);
        closed.push(p);
        break;
      }
      p.step += 1;
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Rendu des messages
// ---------------------------------------------------------------------------
function predictionText(p) {
  const g = p.game || null;
  return fmt.renderMessage(p.format || state.format, {
    gameNumber: p.target,
    suit: p.suit,
    cardsLabel: p.cardsLabel,
    strategy: p.strategyName || p.strategy,
    maxR: p.maxR != null ? p.maxR : state.maxR,
    status: p.status,
    rattrapage: p.step,
    playerCards: g ? g.player : null,
  }, p.template || null);
}

function predictionMessage(p) {
  return predictionText(p).text;
}

function liveText() {
  const g = state.live;
  if (!g) return '⚠️ Aucun jeu live détecté pour le moment.';
  return (
    `🔴 *JEU LIVE*\n\n` +
    `🔢 Tour : *#N${g.number}*\n` +
    `✋ Main vérifiée : *joueur*\n` +
    `🃏 Costumes joueur : *${handSuits(g).join(' ') || '—'}*\n` +
    `🂠 Cartes : joueur ${(g.player || []).join(' ') || '—'} (${g.playerCards ?? 0}) / banquier ${(g.banker || []).join(' ') || '—'} (${g.bankerCards ?? 0})\n` +
    `🔟 Valeurs : joueur ${g.playerValue ?? '—'} / banquier ${g.bankerValue ?? '—'}\n` +
    `⏳ Phase : ${g.phase || '—'}\n` +
    `📌 État : ${g.finished ? 'terminé' : g.dealing ? 'distribution en cours' : 'en attente des cartes'}\n` +
    `🔢 Compteurs B (${state.B}) : ${SUITS.map((s) => `${s}${state.counters[s]}`).join(' ')}\n` +
    `🧠 Stratégies actives : ${strategies.LIST.filter((s) => state.strategies[s.key] && state.strategies[s.key].enabled).map((s) => s.name).join(', ') || 'aucune'}\n` +
    `✔️ Dernier tour terminé : ${state.lastFinished ? '#N' + state.lastFinished.number : '—'}`
  );
}

function recentGames(limit = 30) {
  return [...state.games.values()].sort((a, b) => b.number - a.number).slice(0, limit);
}

// état courant de la stratégie Pair / Impair (mémoire du moteur, règle 11)
function parityRuntime() {
  const cfg = state.strategies.parite || strategies.defaultsFor('parite');
  const { start, varN, dec } = strategies.normParity(cfg);
  const current = maxFinishedNumber() || (state.live ? state.live.number : 0);
  const last = current >= start ? strategies.lastTriggerAtOrBefore(current, start, varN) : null;
  const next = current >= start ? strategies.nextTriggerAfter(current, start, varN) : start;
  const pending = state.predictions.find((p) => p.strategy === 'parite' && p.status === 'en attente') || null;
  const done = state.predictions.filter((p) => p.strategy === 'parite');
  return {
    enabled: !!cfg.enabled,
    startGame: start,
    varStep: varN,
    varLeft: last != null ? strategies.varCounterAt(strategies.triggerIndexOf(last, start, varN), varN) : varN,
    decalage: dec,
    maxR: cfg.maxR,
    format: cfg.format,
    currentGame: current || null,
    lastTrigger: last,
    nextTrigger: next,
    sequence: strategies.triggerSequence(start, varN, 12, current || null),
    prediction: pending
      ? { target: pending.target, parity: pending.suit, trigger: pending.trigger, step: pending.step, maxR: pending.maxR }
      : null,
    lastClosed: done.find((p) => p.status !== 'en attente') || null,
  };
}

// ---------------------------------------------------------------------------
// Bilan envoyé sur Telegram quand le jeu reprend
// ---------------------------------------------------------------------------
function bilanText(key) {
  const s = stats(key);
  const def = key ? strategies.BY_KEY[key] : null;
  return (
    '📊 STATISTIQUE 📈\n\n' +
    (def ? `🧠 Stratégie : ${def.name}\n\n` : '') +
    `🟢 GAIN : ${s.win}\n` +
    `🔴 PERTE : ${s.loss}\n\n\n` +
    `✅ Taux de réussite : ${s.rate} %`
  );
}

// catégories lisibles d'un tour (vue « bot » du panel)
function gameCategories(g) {
  if (!g) return [];
  const out = [];
  out.push({ label: 'Tour', value: '#N' + g.number, tone: 'info' });
  out.push({
    label: 'Résultat',
    value: g.winner || (g.finished ? '—' : 'en cours'),
    tone: g.winner === 'Joueur' ? 'win' : g.winner === 'Banquier' ? 'loss' : 'wait',
  });
  out.push({ label: 'Costumes joueur', value: handSuits(g).join(' ') || '—', tone: 'suit' });
  out.push({ label: 'Points', value: `J ${g.playerValue ?? '—'} / B ${g.bankerValue ?? '—'}`, tone: 'info' });
  out.push({ label: 'Parité joueur', value: parityOf(g) || '—', tone: 'info' });
  out.push({ label: 'Cartes', value: `${g.playerCards ?? 0}/${g.bankerCards ?? 0}`, tone: 'info' });
  out.push({
    label: 'Phase',
    value: g.finished ? 'terminé' : g.dealing ? 'distribution' : 'attente',
    tone: g.finished ? 'done' : 'live',
  });
  return out;
}

// jeux vus par une stratégie (live + tours récents + prédiction liée)
function gameView(g, key) {
  return {
    number: g.number,
    finished: !!g.finished,
    dealing: !!g.dealing,
    winner: g.winner || null,
    player: g.player || [],
    banker: g.banker || [],
    playerSuits: handSuits(g),
    bankerSuits: strategies.suitsOf(g.bankerSuits),
    playerValue: g.playerValue ?? null,
    bankerValue: g.bankerValue ?? null,
    playerCards: g.playerCards ?? null,
    bankerCards: g.bankerCards ?? null,
    tie: g.playerValue != null && g.bankerValue != null && g.playerValue === g.bankerValue,
    sum: g.playerValue != null && g.bankerValue != null ? g.playerValue + g.bankerValue : null,
    parity: parityOf(g),
    phase: g.phase || null,
    phaseLabel: g.finished ? 'terminé' : g.dealing ? 'distribution en cours' : 'à venir',
    categories: gameCategories(g),
    prediction: (() => {
      const p = state.predictions.find((x) => x.strategy === key && x.target === g.number);
      return p ? { label: p.label, status: p.status, badge: p.badge, step: p.step, maxR: p.maxR } : null;
    })(),
  };
}

// compteur par costume (panneau « Compteur » du tableau de bord)
function counterView() {
  const b = state.B || 1;
  return SUITS.map((s) => ({
    suit: s,
    count: state.counters[s] || 0,
    b,
    ratio: Math.min(100, Math.round(((state.counters[s] || 0) / b) * 100)),
  }));
}

function strategyGames(key, limit = 12) {
  const rows = recentGames(limit).map((g) => gameView(g, key));
  const live = state.live ? gameView(state.live, key) : null;
  // parties à venir : tours connus, non terminés, après le tour live
  const upcoming = [...state.games.values()]
    .filter((g) => !g.finished && (!live || g.number > live.number))
    .sort((a, b) => a.number - b.number)
    .slice(0, 4)
    .map((g) => gameView(g, key));
  return { live, upcoming, games: rows, counters: counterView(), stats: stats(key), bilan: bilanText(key), gate: gateView(key) };
}

function stats(key) {
  const list = key ? state.predictions.filter((p) => p.strategy === key) : state.predictions;
  const done = list.filter((p) => p.status !== 'en attente' && p.status !== 'annulé');
  const win = done.filter((p) => p.status === 'gagné').length;
  return {
    total: list.length,
    win,
    loss: done.length - win,
    pending: list.length - done.length,
    rate: done.length ? Math.round((win / done.length) * 100) : 0,
  };
}


// état courant de la stratégie « Prédiction dans l'ombre » (costumes surveillés)
function shadowRuntime() {
  const cfg = state.strategies.ombre || strategies.defaultsFor('ombre');
  const need = Math.max(1, parseInt(cfg.absence, 10) || 4);
  const scope = cfg.scope === 'joueur' ? 'joueur' : 'tous';
  const last = maxFinishedNumber();
  const suits = SUITS.map((suit) => {
    let gap = 0;
    let holes = 0;
    for (let n = last; n >= 1; n--) {
      const g = state.games.get(n);
      if (!g || !g.finished) { if (++holes > 3) break; continue; }
      holes = 0;
      const list = scope === 'joueur'
        ? strategies.suitsOf(g.playerSuits)
        : [...strategies.suitsOf(g.playerSuits), ...strategies.suitsOf(g.bankerSuits)];
      if (list.includes(suit)) break;
      gap += 1;
    }
    return { suit, absence: gap, watched: gap >= need };
  });
  return {
    enabled: !!cfg.enabled,
    absence: need,
    lead: cfg.lead,
    scope,
    lastGame: last || null,
    suits,
    gate: gateView('ombre'),
    prediction: state.predictions.find((p) => p.strategy === 'ombre' && p.status === 'en attente') || null,
  };
}

// ---------------------------------------------------------------------------
// Panneau « Prédictions » du site : chaque prédiction est listée séparément,
// avec son mode (silencieuse = calculée dans l'ombre, publiée = envoyée dans le
// canal Telegram). Les prédictions silencieuses restent donc VISIBLES sur le
// site même si elles ne partent pas dans le canal.
// ---------------------------------------------------------------------------
function predictionRow(p) {
  return {
    id: p.id,
    strategy: p.strategy,
    strategyName: p.strategyName || p.strategy,
    target: p.target,
    trigger: p.trigger != null ? p.trigger : null,
    label: p.label || p.suit || '',
    suit: p.suit || null,
    kind: p.kind,
    status: p.status,
    badge: p.badge,
    step: p.step,
    maxR: p.maxR,
    reason: p.reason || '',
    format: p.format,
    silent: !!p.silent,
    published: !p.silent && (p.messages || []).length > 0,
    channels: (p.messages || []).map((m) => m.chatId),
    gate: p.gate || null,
    createdAt: p.sentAt || null,
    text: predictionMessage(p),
  };
}

// ---------------------------------------------------------------------------
// « Canaux » du site — vitrines internes (aucun lien avec Telegram) : un
// administrateur crée un canal avec un nom et l'associe à UNE stratégie ; les
// utilisateurs le voient dans la liste « Canaux » du site et, en l'ouvrant,
// retrouvent le fil des prédictions de cette stratégie mis en forme EXACTEMENT
// comme les messages envoyés sur Telegram (même texte, via predictionMessage),
// précédé du bilan courant de la stratégie (même carte que /bilan Telegram).
// ---------------------------------------------------------------------------
let siteChannelSeq = Date.now();

function siteChannelsView() {
  return state.siteChannels.map((c) => {
    const def = strategies.BY_KEY[c.strategy];
    const preds = state.predictions.filter((p) => p.strategy === c.strategy && p.messages && p.messages.length);
    const lastPred = preds[preds.length - 1] || null;
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
    const lastIsMsg = !!lastMsg && (!lastPred || (lastMsg.at || 0) > (lastPred.sentAt || 0));
    const s = stats(c.strategy);
    return {
      id: c.id,
      name: c.name,
      strategy: c.strategy,
      strategyName: def ? def.name : c.strategy,
      lastText: lastIsMsg ? lastMsg.text : (lastPred ? predictionMessage(lastPred) : null),
      lastAt: lastIsMsg ? lastMsg.at : (lastPred ? lastPred.sentAt : null),
      lastStatus: lastIsMsg ? null : (lastPred ? lastPred.status : null),
      stats: s,
    };
  });
}

function addSiteChannel(name, strategyKey) {
  const clean = String(name || '').trim();
  if (!clean) return { ok: false, error: 'Nom du canal requis.' };
  const def = strategies.BY_KEY[strategyKey];
  if (!def) return { ok: false, error: 'Stratégie invalide.' };
  const entry = { id: ++siteChannelSeq, name: clean, strategy: strategyKey, messages: [] };
  state.siteChannels.push(entry);
  return { ok: true, channel: entry };
}

function removeSiteChannel(id) {
  const idx = state.siteChannels.findIndex((c) => String(c.id) === String(id));
  if (idx === -1) return { ok: false, error: 'Canal introuvable.' };
  state.siteChannels.splice(idx, 1);
  return { ok: true };
}

// message écrit par un visiteur (ou par l'IA en réponse) dans le fil de
// discussion d'un canal du site — indépendant des cartes de prédiction,
// stocké et persisté avec le canal (voir persist() dans bot.js, qui
// réécrit déjà state.siteChannels tel quel à chaque sauvegarde).
function addSiteChannelMessage(id, { sender, text, at } = {}) {
  const c = state.siteChannels.find((x) => String(x.id) === String(id));
  if (!c) return null;
  if (!Array.isArray(c.messages)) c.messages = [];
  const entry = { sender: sender || '—', text: String(text || '').trim(), at: at || Date.now() };
  if (!entry.text) return null;
  c.messages.push(entry);
  c.messages = c.messages.slice(-200);
  return entry;
}

// fil affiché à l'ouverture d'un canal : bilan de la stratégie + prédictions
// réellement publiées (celles qui sont réellement parties dans un canal
// Telegram, `messages.length`) MÊLÉES, dans l'ordre chronologique, aux
// messages écrits par les visiteurs et aux réponses de l'IA — comme un vrai
// fil de discussion. `limit` borne le nombre total de bulles renvoyées.
function siteChannelFeed(id, limit = 30) {
  const c = state.siteChannels.find((x) => String(x.id) === String(id));
  if (!c) return null;
  const def = strategies.BY_KEY[c.strategy];
  const predictionItems = state.predictions
    .filter((p) => p.strategy === c.strategy && p.status !== 'en attente' && p.messages && p.messages.length)
    .map((p) => ({
      key: `pred-${p.target}-${p.sentAt || 0}`,
      kind: 'prediction',
      sender: c.name,
      target: p.target,
      status: p.status,
      step: p.step,
      text: predictionMessage(p),
      at: p.sentAt || 0,
    }));
  const chatItems = (Array.isArray(c.messages) ? c.messages : []).map((m, i) => ({
    key: `chat-${i}-${m.at}`,
    kind: 'chat',
    sender: m.sender,
    text: m.text,
    at: m.at,
  }));
  const items = [...predictionItems, ...chatItems]
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .slice(-Math.max(1, Math.min(200, limit)));
  return {
    id: c.id,
    name: c.name,
    strategy: c.strategy,
    strategyName: def ? def.name : c.strategy,
    bilan: bilanText(c.strategy),
    stats: stats(c.strategy),
    items,
  };
}

function predictionsPanel(limit = 60) {
  const all = state.predictions.map(predictionRow);
  const byStrategy = {};
  for (const def of strategies.LIST) {
    const rows = all.filter((r) => r.strategy === def.key);
    byStrategy[def.key] = {
      key: def.key,
      name: def.name,
      silentMode: !!(state.strategies[def.key] && state.strategies[def.key].silent),
      gate: gateView(def.key),
      stats: stats(def.key),
      silent: rows.filter((r) => r.silent).slice(0, limit),
      published: rows.filter((r) => !r.silent).slice(0, limit),
    };
  }
  return {
    total: all.length,
    silentCount: all.filter((r) => r.silent).length,
    publishedCount: all.filter((r) => !r.silent).length,
    pending: all.filter((r) => r.status === 'en attente'),
    silent: all.filter((r) => r.silent).slice(0, limit),
    published: all.filter((r) => !r.silent).slice(0, limit),
    all: all.slice(0, limit),
    byStrategy,
    stats: stats(),
  };
}

module.exports = {
  state,
  SUITS,
  predictionRow,
  predictionsPanel,
  siteChannelsView,
  addSiteChannel,
  removeSiteChannel,
  addSiteChannelMessage,
  siteChannelFeed,
  evaluate,
  verify,
  registerGames,
  setOnFinished,
  setOnShoeReset,
  setOnGateChange,
  setOnConfirm,
  fulfillAnnouncement,
  announcementsFor,
  setOnAnnouncementSave,
  setOnAnnouncementDelete,
  restoreAnnouncements,
  suitForNumber,
  nextTarget,
  handSuits,
  hasSuit,
  predictionText,
  predictionMessage,
  liveText,
  recentGames,
  stats,
  BADGES,
  parityOf,
  parityRuntime,
  initStrategies,
  strategyConfig,
  setStrategyConfig,
  resetStrategy,
  strategyChannels,
  strategyGames,
  gameCategories,
  gameView,
  counterView,
  bilanText,
  parseChannels,
  resetShoe,
  unlockGate,
  applyAutoUnlock,
  sweepAutoUnlock,
  canSend,
  noteGateSent,
  gateView,
  autoView,
  autoGate,
  resetAutoGate,
  noteSent,
  resetGate,
  noteClosed,
  queueFloor,
  shadowRuntime,
  syncCostume,
  pullCostume,
};
