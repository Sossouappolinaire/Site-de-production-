// costume-faible-top.js — stratégie « Costume faible sur 2 cartes (miroir) »
// avec CONFIGURATIONS (demande admin). Même fonctionnement que
// « Dizaine — costume le plus / le moins sorti » (dizaine-top.js) : on crée
// autant de configurations qu'on veut, elles tournent en parallèle, chacune a
// ses réglages (règle de costume, décalage a+n, rattrapages, format, canal),
// un bilan périodique classe les canaux et le meilleur canal est relayé dans
// un canal « meilleures prédictions ».
//
// DÉCLENCHEUR (identique à la stratégie classique, strategies.js/costumeFaible) :
//   jeu terminé, joueur 2 cartes ET banquier 2 cartes (mains naturelles). On
//   regroupe les 4 costumes par couleur (rouge ❤️♦️ / noir ♠️♣️), on prend la
//   couleur minoritaire, et le costume faible est celui de cette couleur qui est
//   réellement sorti. Égalité rouge/noir : aucun signal.
//
// RÈGLE DE PRÉDICTION (réglable par configuration) :
//   • « croise »    : ❤️ → ♠️ et ♠️ → ❤️ ; ♦️ → ♣️ et ♣️ → ♦️
//   • « strategie » : le costume que la stratégie prédit normalement, c'est-à-dire
//                     le miroir du costume faible (❤️ ↔ ♦️, ♠️ ↔ ♣️)
//
// Si le déclencheur est trouvé sur le jeu #a, on prédit sur #a+n (n réglable,
// 1 à 20) sur la main du JOUEUR, avec le nombre de rattrapages configuré.
//
// BILAN / MEILLEURES PRÉDICTIONS : mêmes règles que dizaine-top.js (classement
// de la journée, minimum de prédictions vérifiées, relais de la meilleure
// configuration vers le canal « meilleures prédictions »).
'use strict';

const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const strategies = require('./strategies');
const { state, hasSuit, addSiteChannelMessage, siteChannelsView, setOnShoeReset } = require('./predictor');
const earlyVerify = require('./early-verify');

const SUITS = strategies.SUITS;
// règle « croise » : ❤️↔♠️, ♦️↔♣️
const CROSS = { '❤️': '♠️', '♠️': '❤️', '♦️': '♣️', '♣️': '♦️' };

const panel = {
  enabled: true,
  trackers: [],
  pendingMessages: [],
  channelTitles: {},
  channelLinks: {},
  history: [],
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
  // bilan périodique (voir en-tête)
  bilan: { enabled: true, everyHours: 1, hourlyMigrated: true, minPreds: 5, lastSlot: null, lastSentAt: null, lastResult: null },
  // canal des MEILLEURES prédictions (voir en-tête) : configuré une fois, il reçoit les
  // prédictions de la configuration actuellement en tête du classement du jour.
  best: { enabled: false, channels: [], link: '', welcome: true, recap: true, recapMin: 125, lastRecapAt: null, wins: 0, losses: 0, format: 1, maxR: 2, currentTrackerId: null, switchedAt: null, sentCount: 0, lastSentAt: null },
};

let sender = null;
function setSender(fn) { sender = fn; }
let busy = false;

// ---------------------------------------------------------------------------
// Réglages
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

// ---- MODE « 4 CANAUX » ---------------------------------------------------
// Une configuration peut avoir 4 canaux Telegram (ID + nom), chacun avec son costume :
//   canal 1 = le costume demandé par la règle de la configuration (base)
//   canal 2 = l'inverse du canal 1 (croisé : ❤️↔♠️, ♦️↔♣️)
//   canal 3 = le miroir du canal 1 (❤️↔♦️, ♠️↔♣️)
//   canal 4 = le costume restant (celui qui n'est dans aucun des 3 autres)
const SLOT_COUNT = 4;
const SLOT_ROLES = ['costume demandé', 'inverse (croisé)', 'miroir', 'costume restant'];
function slotSuit(base, i) {
  if (!base) return null;
  if (i === 0) return base;
  if (i === 1) return CROSS[base] || null;
  if (i === 2) return strategies.MIRROR[base] || null;
  const m = strategies.MIRROR[base];
  return m ? (CROSS[m] || null) : null;
}
function normDay(d) {
  return d && d.date ? { date: d.date, wins: Number(d.wins) || 0, losses: Number(d.losses) || 0, rsum: Number(d.rsum) || 0, d0: Number(d.d0) || 0, streak: Number(d.streak) || 0, rmax: Number(d.rmax) || 0, lrun: Number(d.lrun) || 0, lmax: Number(d.lmax) || 0, smax: Number(d.smax) || 0 } : null;
}
function sanitizeSlots(value, previous) {
  const arr = Array.isArray(value) ? value : [];
  const out = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const raw = arr[i] || {};
    const chan = parseChannels(raw.channel == null ? '' : String(raw.channel))[0] || null;
    const prev = (previous && previous[i]) || {};
    out.push({
      channel: chan,
      name: String(raw.name == null ? '' : raw.name).trim().slice(0, 60),
      wins: Number.isFinite(Number(raw.wins)) ? Number(raw.wins) : (Number(prev.wins) || 0),
      losses: Number.isFinite(Number(raw.losses)) ? Number(raw.losses) : (Number(prev.losses) || 0),
      // résultats par journée (bilan) propres à ce canal : chaque canal est une stratégie à part
      day: normDay(raw.day !== undefined ? raw.day : prev.day),
      prevDay: normDay(raw.prevDay !== undefined ? raw.prevDay : prev.prevDay),
    });
  }
  return out;
}
function slotMode(t) { return !!(t && Array.isArray(t.slots) && t.slots.some((x) => x && x.channel != null)); }
function slotChannels(t) { return (t.slots || []).map((x) => x.channel).filter((c) => c != null); }
function allChannels(t) { return slotMode(t) ? slotChannels(t) : (t.channels || []); }
function slotName(t, i) {
  const sl = (t.slots || [])[i] || {};
  return sl.name || `${t.name} · ${SLOT_ROLES[i]}`;
}

function sanitizeSiteChannelId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = String(value).trim();
  return id ? id : null;
}

// règle : « croise » (❤️↔♠️, ♦️↔♣️) ou « strategie » (costume prédit par la stratégie = miroir ❤️↔♦️, ♠️↔♣️)
function sanitizeRule(value) { return value === 'strategie' ? 'strategie' : 'croise'; }
// décalage a+n : 1 à 20 jeux après le déclencheur
function sanitizeLead(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : 2;
}
function sanitizeFormat(value) { return fmt.clampFormat(value); }
function sanitizeMaxR(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(9, n)) : 2;
}

function sanitizeEvery(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(1, Math.min(24, n)) : 1; }
function sanitizeMinPreds(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 5; }

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.bilanEnabled !== undefined) panel.bilan.enabled = !!patch.bilanEnabled;
  if (patch.bilanEveryHours !== undefined) panel.bilan.everyHours = sanitizeEvery(patch.bilanEveryHours);
  if (patch.bilanMinPreds !== undefined) panel.bilan.minPreds = sanitizeMinPreds(patch.bilanMinPreds);
  if (patch.bestEnabled !== undefined) panel.best.enabled = !!patch.bestEnabled;
  if (patch.bestChannels !== undefined) panel.best.channels = parseChannels(patch.bestChannels);
  if (patch.bestLink !== undefined) panel.best.link = sanitizeLink(patch.bestLink);
  if (patch.bestWelcome !== undefined) panel.best.welcome = !!patch.bestWelcome;
  if (patch.bestRecap !== undefined) panel.best.recap = !!patch.bestRecap;
  if (patch.bestRecapMin !== undefined) panel.best.recapMin = sanitizeRecapMin(patch.bestRecapMin);
  if (patch.bestFormat !== undefined) panel.best.format = sanitizeFormat(patch.bestFormat);
  if (patch.bestMaxR !== undefined) panel.best.maxR = sanitizeMaxR(patch.bestMaxR);
  persist();
  return config();
}
function config() {
  return {
    enabled: panel.enabled,
    bilanEnabled: panel.bilan.enabled, bilanEveryHours: panel.bilan.everyHours, bilanMinPreds: panel.bilan.minPreds,
    bestEnabled: panel.best.enabled, bestChannels: panel.best.channels, bestFormat: panel.best.format, bestMaxR: panel.best.maxR,
  };
}

function maxFinishedGameNumber() {
  let max = 0;
  for (const g of state.games.values()) if (g.finished && g.number > max) max = g.number;
  return max;
}

function ruleLabel(rule) {
  return rule === 'strategie' ? 'costume prédit par la stratégie (❤️↔♦️, ♠️↔♣️)' : 'croisé (❤️↔♠️, ♦️↔♣️)';
}
function ruleShort(rule) { return rule === 'strategie' ? 'stratégie' : 'croisé'; }
function defaultName(t) { return `Costume faible ${ruleShort(t.rule)} (a+${t.lead})`; }

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const saved = {
    config: config(), trackers: panel.trackers, history: panel.history,
    pendingMessages: panel.pendingMessages, sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt,
    channelTitles: panel.channelTitles,
    channelLinks: panel.channelLinks,
    bilan: panel.bilan,
    best: panel.best,
  };
  try { store.patch({ costumeFaibleTop: saved }); } catch (_) {}
  if (db.ready) db.setSetting('costume_faible_top_state', JSON.stringify(saved)).catch((error) => { panel.lastError = error.message; });
}

function restore() {
  try {
    const saved = (store.read() || {}).costumeFaibleTop;
    if (saved) applySaved(saved);
  } catch (_) {}
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('costume_faible_top_state');
    if (raw) applySaved(JSON.parse(raw));
    else persist();
  } catch (_) { persist(); }
  return config();
}

function normalizeTracker(t) {
  const base = {
    id: t.id,
    rule: sanitizeRule(t.rule),
    lead: sanitizeLead(t.lead),
    enabled: t.enabled !== false,
    channels: Array.isArray(t.channels) ? parseChannels(t.channels) : [],
    siteChannelId: sanitizeSiteChannelId(t.siteChannelId),
    slots: sanitizeSlots(t.slots),
    format: sanitizeFormat(t.format),
    maxR: sanitizeMaxR(t.maxR),
    // dernier jeu déjà examiné (évite tout renvoi après redémarrage)
    lastGame: Number.isFinite(Number(t.lastGame)) ? Number(t.lastGame) : 0,
    lastInfo: t.lastInfo || null,
    wins: Number.isFinite(Number(t.wins)) ? Number(t.wins) : 0,
    losses: Number.isFinite(Number(t.losses)) ? Number(t.losses) : 0,
    sentCount: Number.isFinite(Number(t.sentCount)) ? Number(t.sentCount) : 0,
    lastSentAt: t.lastSentAt || null,
    createdAt: t.createdAt || Date.now(),
    // résultats par journée (bilan) : jour en cours + veille
    day: t.day && t.day.date ? { date: t.day.date, wins: Number(t.day.wins) || 0, losses: Number(t.day.losses) || 0, rsum: Number(t.day.rsum) || 0, d0: Number(t.day.d0) || 0, streak: Number(t.day.streak) || 0, rmax: Number(t.day.rmax) || 0, lrun: Number(t.day.lrun) || 0, lmax: Number(t.day.lmax) || 0, smax: Number(t.day.smax) || 0 } : null,
    prevDay: t.prevDay && t.prevDay.date ? { date: t.prevDay.date, wins: Number(t.prevDay.wins) || 0, losses: Number(t.prevDay.losses) || 0, rsum: Number(t.prevDay.rsum) || 0, d0: Number(t.prevDay.d0) || 0, streak: Number(t.prevDay.streak) || 0, rmax: Number(t.prevDay.rmax) || 0, lrun: Number(t.prevDay.lrun) || 0, lmax: Number(t.prevDay.lmax) || 0, smax: Number(t.prevDay.smax) || 0 } : null,
  };
  base.name = (t.name && String(t.name).trim()) || defaultName(base);
  return base;
}

function applySaved(saved) {
  if (saved.channelTitles && typeof saved.channelTitles === 'object') panel.channelTitles = { ...saved.channelTitles };
  if (saved.channelLinks && typeof saved.channelLinks === 'object') panel.channelLinks = { ...saved.channelLinks };
  if (saved.config) panel.enabled = saved.config.enabled !== false;
  if (saved.bilan && typeof saved.bilan === 'object') {
    panel.bilan = {
      ...panel.bilan,
      enabled: saved.bilan.enabled !== false,
      // migration unique : passage à un bilan toutes les heures pile (demande admin)
      everyHours: saved.bilan.hourlyMigrated ? sanitizeEvery(saved.bilan.everyHours) : 1,
      hourlyMigrated: true,
      minPreds: sanitizeMinPreds(saved.bilan.minPreds),
      lastSlot: saved.bilan.lastSlot || null,
      lastSentAt: saved.bilan.lastSentAt || null,
    };
  }
  if (saved.best && typeof saved.best === 'object') {
    panel.best = {
      ...panel.best,
      enabled: !!saved.best.enabled,
      channels: parseChannels(saved.best.channels || []),
      link: sanitizeLink(saved.best.link),
      welcome: saved.best.welcome !== false,
      recap: saved.best.recap !== false,
      recapMin: sanitizeRecapMin(saved.best.recapMin == null ? 125 : saved.best.recapMin),
      lastRecapAt: Number(saved.best.lastRecapAt) || null,
      wins: Number(saved.best.wins) || 0,
      losses: Number(saved.best.losses) || 0,
      format: sanitizeFormat(saved.best.format),
      maxR: sanitizeMaxR(saved.best.maxR),
      currentTrackerId: saved.best.currentTrackerId || null,
      switchedAt: saved.best.switchedAt || null,
      sentCount: Number(saved.best.sentCount) || 0,
      lastSentAt: saved.best.lastSentAt || null,
    };
  }
  if (Array.isArray(saved.trackers)) panel.trackers = saved.trackers.filter((t) => t && t.id).map(normalizeTracker);
  // l'historique et les messages en attente ne sont jamais rejoués au démarrage
  panel.history = [];
  panel.pendingMessages = [];
  if (Number.isFinite(Number(saved.sentCount))) panel.sentCount = Number(saved.sentCount);
  panel.lastSentAt = saved.lastSentAt || null;
  panel.lastScanAt = saved.lastScanAt || null;
}

// ---------------------------------------------------------------------------
// Gestion des configurations
// ---------------------------------------------------------------------------
function addTracker(extra = {}) {
  const tracker = normalizeTracker({
    id: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: extra.name,
    rule: extra.rule,
    lead: extra.lead,
    channels: parseChannels(extra.channels),
    slots: extra.slots,
    siteChannelId: extra.siteChannelId,
    format: extra.format,
    maxR: extra.maxR,
    // on n'examine pas les jeux déjà terminés au moment de la création
    lastGame: maxFinishedGameNumber(),
    createdAt: Date.now(),
  });
  if (!tracker.channels.length && !tracker.siteChannelId && !slotMode(tracker)) {
    throw new Error('Renseigne au moins un canal (ID Telegram ou canal du site) pour cette configuration.');
  }
  panel.trackers.push(tracker);
  persist();
  return tracker;
}

function updateTracker(id, patch = {}) {
  const tracker = panel.trackers.find((t) => t.id === id);
  if (!tracker) return null;
  const next = { ...tracker };
  if (patch.rule !== undefined) next.rule = sanitizeRule(patch.rule);
  if (patch.lead !== undefined) next.lead = sanitizeLead(patch.lead);
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.channels !== undefined) next.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) next.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.slots !== undefined) next.slots = sanitizeSlots(patch.slots, tracker.slots);
  if (patch.format !== undefined) next.format = sanitizeFormat(patch.format);
  if (patch.maxR !== undefined) next.maxR = sanitizeMaxR(patch.maxR);
  if (patch.name !== undefined) {
    const clean = String(patch.name || '').trim();
    next.name = clean || defaultName(next);
  }
  if (!next.channels.length && !next.siteChannelId && !slotMode(next)) {
    throw new Error('Renseigne au moins un canal (ID Telegram ou canal du site) pour cette configuration.');
  }
  Object.assign(tracker, next);
  persist();
  return tracker;
}

function removeTracker(id) {
  panel.trackers = panel.trackers.filter((t) => t.id !== id);
  persist();
  return true;
}

// ---------------------------------------------------------------------------
// Déclencheur « costume faible sur 2 cartes » + choix du costume à prédire
// ---------------------------------------------------------------------------
// Retourne null si le jeu ne déclenche pas, sinon { four, weak, reason }.
function triggerOf(game) {
  if (!game || !game.finished) return null;
  if (game.playerCards !== 2 || game.bankerCards !== 2) return null; // mains naturelles des 2 côtés
  const four = [...strategies.suitsOf(game.playerSuits), ...strategies.suitsOf(game.bankerSuits)];
  if (four.length !== 4) return null;
  const { weak, reason } = strategies.weakSuitOf(four);
  if (!weak) return null;
  return { four, weak, reason };
}

// costume à prédire selon la règle de la configuration
function suitFor(weak, rule) {
  return rule === 'strategie' ? (strategies.MIRROR[weak] || null) : (CROSS[weak] || null);
}

// ---------------------------------------------------------------------------
// Boucle de traitement
// ---------------------------------------------------------------------------
async function processTracker(tracker) {
  if (!tracker.enabled) return;
  const maxDone = maxFinishedGameNumber();
  // numéros qui repartent à la baisse = nouveau sabot : on repart de zéro
  if (maxDone < tracker.lastGame) tracker.lastGame = 0;
  if (maxDone <= tracker.lastGame) return;
  const from = tracker.lastGame + 1;
  tracker.lastGame = maxDone; // marqué avant l'envoi : jamais deux fois le même jeu
  for (let n = from; n <= maxDone; n++) {
    const game = state.games.get(n);
    const trig = triggerOf(game);
    if (!trig) continue;
    const suit = suitFor(trig.weak, tracker.rule);
    if (!suit) continue;
    const target = n + tracker.lead;
    tracker.lastInfo = { trigger: n, four: trig.four, weak: trig.weak, suit, target, at: Date.now() };
    if (target <= maxDone) continue; // cible déjà passée : on n'envoie rien de périmé
    if (slotMode(tracker)) {
      // mode 4 canaux : chaque canal reçoit son propre costume
      const parts = [];
      for (let i = 0; i < SLOT_COUNT; i++) {
        const sl = tracker.slots[i];
        const sSuit = slotSuit(suit, i);
        if (!sl || sl.channel == null || !sSuit) continue;
        parts.push(`${i + 1}:${sSuit}`);
        await send(tracker, {
          target, suit: sSuit, slot: i,
          detail: `#N${n} joueur ${trig.four.slice(0, 2).join('')} / banquier ${trig.four.slice(2).join('')} → faible ${trig.weak} → canal ${i + 1} (${SLOT_ROLES[i]}) ${sSuit} (+${tracker.lead})`,
        });
      }
      tracker.lastInfo.slotSuits = parts;
      continue;
    }
    await send(tracker, {
      target, suit,
      detail: `#N${n} joueur ${trig.four.slice(0, 2).join('')} / banquier ${trig.four.slice(2).join('')} → faible ${trig.weak} → ${suit} (+${tracker.lead})`,
    });
  }
}

function effectiveChannels(tracker) { return tracker.channels || []; }

function postToSiteChannel(tracker, text) {
  const id = tracker.siteChannelId;
  if (!id) return false;
  return !!addSiteChannelMessage(id, { sender: tracker.name, text });
}

function messageText(tracker, syn) {
  return fmt.renderMessage(tracker.format, {
    gameNumber: syn.target,
    suit: syn.suit,
    strategy: syn.slot !== undefined ? slotName(tracker, syn.slot) : tracker.name,
    maxR: tracker.maxR,
    status: 'en attente',
    rattrapage: 0,
  }, null);
}

// ---------------------------------------------------------------------------
// Canal des MEILLEURES prédictions
// ---------------------------------------------------------------------------
// Classement du jour (même règle que le bilan : taux, puis moyenne des rattrapages,
// puis nombre de prédictions, puis victoires ; minimum de prédictions vérifiées pour être classée).
// Concurrents : une configuration classique = 1 concurrent ; une configuration « 4 canaux »
// = 1 concurrent PAR canal (chaque canal est une stratégie séparée, avec son propre score).
function contestants() {
  const out = [];
  for (const t of panel.trackers) {
    if (slotMode(t)) {
      t.slots.forEach((sl, i) => {
        if (sl.channel == null) return;
        out.push({ key: `${t.id}#${i}`, tracker: t, slot: i, holder: sl });
      });
    } else out.push({ key: t.id, tracker: t, slot: undefined, holder: t });
  }
  return out;
}
function contestantName(c) {
  if (c.slot === undefined) return c.tracker.name;
  return slotName(c.tracker, c.slot);
}
function contestantByKey(key) { return contestants().find((c) => c.key === key) || null; }

function rankedToday(now = Date.now()) {
  const key = dayKeyOf(now);
  return contestants()
    .map((c) => { const st = dayStats(c.holder, key); return { c, t: c.tracker, ...st, rate: st.total ? st.wins / st.total : 0 }; })
    .filter((r) => r.total >= panel.bilan.minPreds)
    .sort(compareRanking);
}

// Meilleure configuration du moment. Si une autre devient STRICTEMENT meilleure,
// on bascule sur elle (sa prédiction en cours part tout de suite dans le canal des meilleures).
// Tant que personne n'est classé (début de journée), on garde le dernier meilleur connu.
let adminIdFn = null;
function setAdminId(fn) { adminIdFn = typeof fn === 'function' ? fn : null; }

// vrai nom Telegram du canal (à défaut, nom saisi à la main, puis ID)
function contestantRealName(c) {
  if (c.slot !== undefined) {
    const sl = c.tracker.slots[c.slot];
    return panel.channelTitles[String(sl.channel)] || sl.name || String(sl.channel);
  }
  return trackerChannelNames(c.tracker, siteChannelsView()).join(' + ') || c.tracker.name;
}

// Alerte envoyée UNIQUEMENT au chat privé de l'administrateur (jamais dans un canal)
function notifyBestChange(prevKey, top, ranked, reason) {
  try {
    const b = panel.best;
    const adminId = adminIdFn ? adminIdFn() : null;
    const bot = typeof sender === 'function' ? sender() : null;
    if (!b.enabled || !b.channels.length || !adminId || !bot) return;
    const line = (r) => `${contestantRealName(r.c)} — ${pct(r.wins, r.total)} (${r.wins}/${r.total}) · moy. ${avgRattrapage(r)}`;
    const prevRow = prevKey ? ranked.find((r) => r.c.key === prevKey) : null;
    const prevC = prevKey ? contestantByKey(prevKey) : null;
    const dest = b.channels.map((id) => panel.channelTitles[String(id)] || String(id)).join(' + ');
    const text = prevC
      ? `🔄 Nouveau meilleur canal${reason ? `\n⚠️ Cause : ${reason}` : ''}\n\n🏆 ${line(top)}\n↩️ Remplace : ${prevRow ? line(prevRow) : contestantRealName(prevC)}\n\n📣 Ses prédictions partent maintenant dans « ${dest} »`
      : `🏆 Meilleur canal désigné\n\n${line(top)}\n\n📣 Ses prédictions partent dans « ${dest} »`;
    Promise.resolve(bot.sendMessage(adminId, text)).catch(() => {});
  } catch (_) { /* une alerte ratée ne doit jamais bloquer les prédictions */ }
}

function currentBest(now = Date.now(), reason) {
  const b = panel.best;
  const ranked = rankedToday(now);
  if (ranked.length) {
    const top = ranked[0];
    const cur = ranked.find((r) => r.c.key === b.currentTrackerId);
    if (!cur || compareQuality(top, cur) < 0) { // égalité parfaite (taux ET moyenne) : on reste sur le meilleur actuel (pas d'aller-retour)
      const prevKey = b.currentTrackerId;
      b.currentTrackerId = top.c.key;
      b.switchedAt = Date.now();
      if (prevKey !== top.c.key) { notifyBestChange(prevKey, top, ranked, reason); b.lastSuit = null; b.lastTarget = null; relayNewBest(top.c); }
    }
  }
  return contestantByKey(b.currentTrackerId);
}

// ---- BIENVENUE dans le canal des meilleures prédictions ------------------
function bestRecap(title) {
  rollBestDay(); // 00h00 Abidjan : tout repart à zéro
  const w = panel.best.wins || 0; const l = panel.best.losses || 0; const total = w + l;
  const rate = total ? ((w / total) * 100).toFixed(2) : '0.00';
  return `📊 ${title} :\n• 🎮 All games : ${total}\n• ✅ Won : ${w}\n• ❌ Lost : ${l}\n• ${rate}%`;
}
// ---- RÉCAPITULATIF PÉRIODIQUE dans le canal des meilleures prédictions -----
function sanitizeRecapMin(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(5, Math.min(1440, n)) : 125;
}
async function maybeSendRecap(now = Date.now()) {
  const b = panel.best;
  if (!b.enabled || !b.recap || !b.channels.length) return;
  if (!b.lastRecapAt) { b.lastRecapAt = now; return; } // le compteur démarre : 1er récapitulatif après l'intervalle
  if (now - b.lastRecapAt < sanitizeRecapMin(b.recapMin) * 60000) return;
  b.lastRecapAt = now;
  if (((b.wins || 0) + (b.losses || 0)) === 0) return; // rien à récapituler
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  for (const id of b.channels) {
    const title = panel.channelTitles[String(id)] || String(id);
    try { await bot.sendMessage(id, bestRecap(title)); }
    catch (e) { panel.lastError = `Récapitulatif ${id} : ${e.message}`; }
  }
}

function welcomeText(fullName, title) {
  return `👋 ${fullName}, bienvenue dans le canal : ${title}\n\n${bestRecap(title)}`;
}
const welcomeSeen = new Map();
function isBestChat(chat) {
  return panel.best.channels.some((id) => String(id) === String(chat.id)
    || (String(id).startsWith('@') && chat.username && String(id).slice(1).toLowerCase() === String(chat.username).toLowerCase()));
}
// appelé par bot.js pour chaque mise à jour « chat_member » (le bot doit être administrateur du canal)
let lastMember = null; // diagnostic : dernier événement « membre » reçu de Telegram (non sauvegardé)
async function handleMemberUpdate(u) {
  if (u && u.chat && u.new_chat_member) {
    lastMember = {
      at: Date.now(), chat: u.chat.title || String(u.chat.id),
      from: (u.old_chat_member || {}).status || '?', to: u.new_chat_member.status,
      isBest: isBestChat(u.chat),
    };
  }
  const b = panel.best;
  if (!b.enabled || !b.welcome || !b.channels.length || !u || !u.chat || !u.new_chat_member) return false;
  const nm = u.new_chat_member; const old = u.old_chat_member || {};
  const joined = ['member', 'administrator', 'creator'].includes(nm.status) && ['left', 'kicked'].includes(old.status);
  if (!joined || !nm.user || nm.user.is_bot || !isBestChat(u.chat)) return false;
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return false;
  const k = `${u.chat.id}:${nm.user.id}`;
  const now = Date.now();
  if (welcomeSeen.has(k) && now - welcomeSeen.get(k) < 10 * 60 * 1000) return false; // pas de double message
  welcomeSeen.set(k, now);
  if (welcomeSeen.size > 500) for (const [kk, t] of welcomeSeen) if (now - t > 10 * 60 * 1000) welcomeSeen.delete(kk);
  const title = u.chat.title || panel.channelTitles[String(u.chat.id)] || String(u.chat.id);
  if (u.chat.title) setChannelTitle(u.chat.id, u.chat.title);
  const fullName = [nm.user.first_name, nm.user.last_name].filter(Boolean).join(' ').trim() || nm.user.username || 'Nouveau membre';
  try { await bot.sendMessage(u.chat.id, welcomeText(fullName, title)); return true; }
  catch (e) { panel.lastError = `Bienvenue ${u.chat.id} : ${e.message}`; return false; }
}


// Test de la bienvenue : vérifie les droits du bot dans le canal des meilleures et y poste un message d'essai
async function testWelcome() {
  const b = panel.best;
  if (!b.channels.length) return { ok: false, error: 'Aucun canal des meilleures prédictions configuré' };
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  const out = { ok: false, channel: String(b.channels[0]) };
  try {
    const me = await bot.getMe();
    const chat = await bot.getChat(b.channels[0]);
    out.chatType = chat.type;
    const mem = await bot.getChatMember(chat.id, me.id);
    out.botStatus = mem.status; out.canPost = mem.can_post_messages; out.canInvite = mem.can_invite_users;
    const title = chat.title || panel.channelTitles[String(chat.id)] || String(chat.id);
    const m = await bot.sendMessage(chat.id, `🧪 TEST — ${welcomeText('Prénom Nom', title)}`);
    if (m && m.skipped) out.error = 'Envoi ignoré : les prédictions de ce canal sont en pause (/stop)';
    else out.ok = true;
  } catch (e) { out.error = e.message; }
  return out;
}

// ---------------------------------------------------------------------------
// CANAL DES MEILLEURES : journée 00h00 (heure d'Abidjan), anti-doublon de costume, relais au changement
// ---------------------------------------------------------------------------
const BEST_TZ = process.env.RESET_TZ || 'Africa/Abidjan';
function bestDayKey(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BEST_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
// Après 00h00 (Abidjan) : le récapitulatif (All games / Won / Lost) repart de zéro et le dernier costume est oublié.
// Au tout premier passage on ne remet à zéro que si le dernier envoi date d'un jour précédent.
function rollBestDay(now = Date.now()) {
  const b = panel.best;
  const key = bestDayKey(now);
  if (b.day === key) return false;
  const stale = b.day ? true : !!(b.lastSentAt && bestDayKey(b.lastSentAt) !== key);
  b.day = key;
  if (stale) { b.wins = 0; b.losses = 0; b.lastSuit = null; b.lastTarget = null; }
  persist();
  return stale;
}
// prédiction d'origine (celle du canal de la configuration) qui correspond à syn : sert à ne jamais relayer deux fois la même
function findOriginalEntry(tracker, syn) {
  for (let i = panel.pendingMessages.length - 1; i >= 0; i--) {
    const e = panel.pendingMessages[i];
    if (!e.mirror && e.trackerId === tracker.id && (syn.slot === undefined ? e.slot === undefined : e.slot === syn.slot) && e.target === syn.target && String(e.suit) === String(syn.suit)) return e;
  }
  return null;
}

// Envoi réel dans le canal des meilleures (relais). Retourne true seulement si Telegram a VRAIMENT posté le message
// (canal en /stop ou erreur → false → rien n'est compté dans le récapitulatif).
async function postToBest(tracker, syn, orig) {
  const b = panel.best;
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Meilleures prédictions : aucun token Telegram configuré'; return false; }
  if (orig) orig.bestRelayed = true; // marqué TOUT DE SUITE (avant l'envoi) : jamais deux envois de la même prédiction
  const out = fmt.renderMessage(b.format, {
    gameNumber: syn.target, suit: syn.suit, strategy: 'Meilleure prédiction',
    maxR: b.maxR, status: 'en attente', rattrapage: 0,
  }, null);
  const sentMessages = [];
  const res = await Promise.all(b.channels.map((id) =>
    bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {})
      .then((m) => (m && m.skipped ? { skipped: true } : { ok: true, id, messageId: m.message_id }))
      .catch((e) => ({ id, error: e.message }))));
  for (const r of res) {
    if (r.ok) sentMessages.push({ chatId: r.id, messageId: r.messageId });
    else if (!r.skipped) panel.lastError = `Meilleures prédictions ${r.id} : ${r.error}`;
  }
  if (!sentMessages.length) { if (orig) orig.bestRelayed = false; return false; }
  b.sentCount = (b.sentCount || 0) + 1;
  b.lastSentAt = Date.now();
  b.lastSuit = String(syn.suit); // mémoire du dernier costume envoyé (anti-doublon)
  if (Number.isFinite(Number(syn.target))) b.lastTarget = Number(syn.target);
  panel.pendingMessages.push({
    id: `cb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    trackerId: tracker.id, mirror: true, best: true, // relais : ne compte pas deux fois dans les scores
    target: syn.target, suit: syn.suit, strategyName: 'Meilleure prédiction',
    format: b.format, maxR: b.maxR, step: 0, gap: 0, skipped: 0,
    status: 'en attente', messages: sentMessages, createdAt: Date.now(), resolvedAt: null,
  });
  persist();
  return true;
}

// Quand le meilleur CHANGE : sa prédiction en cours (en attente, pas encore en rattrapage) part tout de suite dans le canal
// des meilleures, sans attendre sa prochaine prédiction.
function relayNewBest(c) {
  try {
    const b = panel.best;
    if (!b.enabled || !b.channels.length) return;
    const today = bestDayKey();
    let orig = null;
    for (let i = panel.pendingMessages.length - 1; i >= 0; i--) {
      const e = panel.pendingMessages[i];
      if (!e.mirror && e.trackerId === c.tracker.id && (c.slot === undefined ? e.slot === undefined : e.slot === c.slot) && e.status === 'en attente' && !e.step && !e.bestRelayed && bestDayKey(e.createdAt) === today) { orig = e; break; }
    }
    if (!orig) return;
    // départ IMMÉDIAT : la prédiction est choisie et marquée « relayée » tout de suite (avant tout await)
    postToBest(c.tracker, { target: orig.target, suit: orig.suit, ...(c.slot !== undefined ? { slot: c.slot } : {}) }, orig)
      .catch((e) => { panel.lastError = `Meilleures prédictions : ${e.message}`; });
  } catch (e) { panel.lastError = `Meilleures prédictions : ${e.message}`; }
}

// Prédiction d'une configuration : relayée dans le canal des meilleures SEULEMENT si c'est la meilleure du moment
// ET si son costume est différent de la dernière prédiction envoyée dans ce canal (même costume = ignoré).
async function forwardToBest(tracker, syn) {
  const b = panel.best;
  if (!b.enabled || !b.channels.length) return false;
  rollBestDay();
  const best = currentBest();
  const myKey = syn.slot !== undefined ? `${tracker.id}#${syn.slot}` : tracker.id;
  if (!best || best.key !== myKey) return false; // ce n'est pas la meilleure stratégie (canal) du moment
  const orig = findOriginalEntry(tracker, syn);
  if (orig && orig.bestRelayed) return false; // déjà relayée (par le changement de meilleur)
  // même costume que la précédente ET numéros qui se suivent (écart < 2) : ignorée. Écart d'au moins 2 : envoyée.
  const tNum = Number(syn.target);
  const sameSuit = !!b.lastSuit && String(b.lastSuit) === String(syn.suit);
  const near = Number.isFinite(tNum) && Number.isFinite(b.lastTarget) && Math.abs(tNum - b.lastTarget) < 2;
  if (Number.isFinite(tNum)) b.lastTarget = tNum; // dernier numéro prédit par le meilleur (envoyé ou ignoré)
  if (sameSuit && near) { b.skippedSame = (b.skippedSame || 0) + 1; return false; }
  return postToBest(tracker, syn, orig);
}

async function send(tracker, syn) {
  const isSlot = syn.slot !== undefined;
  const targetChannels = isSlot ? [tracker.slots[syn.slot].channel] : effectiveChannels(tracker);
  const useSite = !!tracker.siteChannelId && (!isSlot || syn.slot === 0);
  if (!targetChannels.length && !useSite) {
    panel.lastError = `Aucun canal configuré pour « ${tracker.name} »`;
    return false;
  }
  const out = messageText(tracker, syn);
  const sentMessages = [];
  const errors = [];
  let ok = false;
  if (targetChannels.length) {
    const bot = typeof sender === 'function' ? sender() : null;
    if (!bot) {
      errors.push('Aucun token Telegram configuré');
    } else {
      const results = await Promise.all(targetChannels.map((id) =>
        bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {})
          // canal arrêté par /stop : faux message (skipped), pas un envoi
          .then((m) => (m && m.skipped ? { ok: false, skipped: true, id } : { ok: true, id, messageId: m.message_id }))
          .catch((e) => ({ ok: false, id, error: e.message }))
      ));
      for (const r of results) {
        if (r.ok) { sentMessages.push({ chatId: r.id, messageId: r.messageId }); ok = true; }
        else if (!r.skipped) errors.push(`${r.id} : ${r.error}`);
      }
    }
  }
  if (useSite) {
    if (postToSiteChannel(tracker, out.text)) ok = true;
    else errors.push(`Canal du site introuvable (id ${tracker.siteChannelId})`);
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
    trackerId: tracker.id, trackerName: isSlot ? slotName(tracker, syn.slot) : tracker.name, target: syn.target, suit: syn.suit,
    detail: syn.detail || '', sentAt: Date.now(),
  });
  panel.history = panel.history.slice(0, 100);
  if (sentMessages.length) {
    panel.pendingMessages.push({
      id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      trackerId: tracker.id, target: syn.target, suit: syn.suit,
      strategyName: isSlot ? slotName(tracker, syn.slot) : tracker.name,
      ...(isSlot ? { slot: syn.slot } : {}),
      format: tracker.format, maxR: tracker.maxR, step: 0, gap: 0, skipped: 0,
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
  // canal des meilleures prédictions : relais si cette configuration est la meilleure du moment
  try { await forwardToBest(tracker, syn); } catch (e) { panel.lastError = `Meilleures prédictions : ${e.message}`; }
  return true;
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

// step = rattrapage auquel la victoire a eu lieu (0 = ✅0️⃣, 1 = ✅1️⃣…) : sert au départage
// des configurations à taux égal (moyenne des rattrapages, voir compareQuality).
function bumpScore(trackerId, field, step = 0) {
  const t = panel.trackers.find((x) => x.id === trackerId);
  if (!t) return;
  t[field] = (t[field] || 0) + 1;
  rollDay(t); // compteur de la journée (bilan)
  t.day[field] = (t.day[field] || 0) + 1;
  if (field === 'wins') {
    t.day.rsum = (t.day.rsum || 0) + (Number(step) || 0);
    if (!Number(step)) t.day.d0 = (t.day.d0 || 0) + 1; // victoire du premier coup
    t.day.streak = (t.day.streak || 0) + 1;
  } else if (field === 'losses') t.day.streak = 0;
  trackDayResult(t.day, field, step);
}

// score d'une prédiction vérifiée. Prédiction d'un canal (slot) : le score va au canal lui-même
// (chaque canal est une stratégie séparée dans le bilan et pour le choix du meilleur).
function bumpEntry(entry, field, step = 0) {
  if (entry.mirror) {
    // relais vers le canal des meilleures : jamais compté dans les scores des canaux,
    // mais il alimente le récapitulatif de CE canal (All games / Won / Lost)
    if (entry.best) {
      rollBestDay();
      if (!entry.createdAt || bestDayKey(entry.createdAt) === panel.best.day) { panel.best[field] = (panel.best[field] || 0) + 1; persist(); }
    }
    return;
  }
  if (entry.slot !== undefined) {
    const t = panel.trackers.find((x) => x.id === entry.trackerId);
    const sl = t && t.slots && t.slots[entry.slot];
    if (!sl) return;
    sl[field] = (sl[field] || 0) + 1;
    rollDay(sl);
    sl.day[field] = (sl.day[field] || 0) + 1;
    if (field === 'wins') {
      sl.day.rsum = (sl.day.rsum || 0) + (Number(step) || 0);
      if (!Number(step)) sl.day.d0 = (sl.day.d0 || 0) + 1; // victoire du premier coup
      sl.day.streak = (sl.day.streak || 0) + 1;
    } else if (field === 'losses') sl.day.streak = 0;
    trackDayResult(sl.day, field, step);
    recalcBest(entry);
    return;
  }
  bumpScore(entry.trackerId, field, step);
  recalcBest(entry);
}

// Perte du meilleur actuel : le classement est recalculé tout de suite, en silence (rien n'est posté dans le
// canal des meilleures ; seule l'alerte privée à l'admin part si le meilleur change). Si l'ancien meilleur reste
// premier, il continue d'envoyer ; sinon ses prochaines prédictions ne sont plus relayées et c'est la prochaine
// prédiction du nouveau meilleur qui part.
// Après CHAQUE résultat (victoire ou perte, de n'importe quelle configuration) : le meilleur est recalculé tout de suite ;
// s'il change, la prédiction en cours du nouveau meilleur part aussitôt dans le canal des meilleures.
function recalcBest(entry) {
  try { currentBest(Date.now(), `résultat sur #N${entry.target}`); } catch (_) { /* jamais bloquant */ }
}
function recalcAfterLoss(entry) {
  try {
    const key = entry.slot !== undefined ? `${entry.trackerId}#${entry.slot}` : entry.trackerId;
    if (panel.best.currentTrackerId === key) currentBest(Date.now(), `perte du meilleur sur #N${entry.target}`);
  } catch (_) { /* jamais bloquant */ }
}

async function verifyPending() {
  const maxDone = maxFinishedGameNumber();
  for (const entry of panel.pendingMessages) {
    if (entry.status !== 'en attente') continue;
    let guard = 0;
    while (entry.status === 'en attente' && guard++ <= entry.maxR + entry.gap + 8) {
      const num = entry.target + entry.step + entry.gap;
      const g = state.games.get(num);
      const usable = (!!g && g.finished && g.complete !== false)
        // vérification anticipée : costume déjà chez le joueur → validé sans attendre la fin du jeu (early-verify.js)
        || earlyVerify.hit(g, entry.kind, (gg) => hasSuit(gg, entry.suit));
      if (!usable) {
        if (num + 2 <= maxDone) {
          entry.gap += 1;
          entry.skipped = (entry.skipped || 0) + 1;
          if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); break; }
          continue;
        }
        break;
      }
      const won = hasSuit(g, entry.suit); // main du JOUEUR
      if (won) {
        entry.status = 'gagné'; entry.resolvedAt = Date.now();
        bumpEntry(entry, 'wins', entry.step);
        editPending(entry, 'gagné');
        break;
      }
      if (entry.step >= entry.maxR) {
        entry.status = 'perdu'; entry.resolvedAt = Date.now();
        bumpEntry(entry, 'losses');
        editPending(entry, 'perdu');
        break;
      }
      entry.step += 1;
    }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pendingMessages = panel.pendingMessages.filter((e) => e.status === 'en attente' || !e.resolvedAt || e.resolvedAt >= cutoff);
}

// nouveau sabot : on repart de zéro et on annule les prédictions en attente
setOnShoeReset(() => {
  for (const t of panel.trackers) { t.lastGame = 0; }
  for (const entry of panel.pendingMessages) {
    if (entry.status !== 'en attente') continue;
    entry.status = 'annulé';
    entry.resolvedAt = Date.now();
  }
  persist();
});

// ---------------------------------------------------------------------------
// BILAN périodique
// ---------------------------------------------------------------------------
const BILAN_TZ = process.env.BILAN_TZ || 'Africa/Porto-Novo';

function localParts(ms) {
  const f = new Intl.DateTimeFormat('fr-FR', {
    timeZone: BILAN_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const o = {};
  for (const x of f) o[x.type] = x.value;
  return { y: o.year, m: o.month, d: o.day, h: Number(o.hour) };
}
const dayKeyOf = (ms) => { const p = localParts(ms); return `${p.y}-${p.m}-${p.d}`; };

// bascule de journée : le jour écoulé devient « veille », un nouveau jour démarre
function rollDay(t, now = Date.now()) {
  const key = dayKeyOf(now);
  if (!t.day) t.day = { date: key, wins: 0, losses: 0, rsum: 0, d0: 0, streak: 0, rmax: 0, lrun: 0, lmax: 0, smax: 0 };
  else if (t.day.date !== key) { t.prevDay = t.day; t.day = { date: key, wins: 0, losses: 0, rsum: 0, d0: 0, streak: 0, rmax: 0, lrun: 0, lmax: 0, smax: 0 }; }
}
function dayStats(t, key) {
  const d = [t.day, t.prevDay].find((x) => x && x.date === key);
  return d
    ? { wins: d.wins, losses: d.losses, total: d.wins + d.losses, rsum: d.rsum || 0, d0: d.d0 || 0, streak: d.streak || 0, rmax: d.rmax || 0, lmax: d.lmax || 0, smax: d.smax || 0 }
    : { wins: 0, losses: 0, total: 0, rsum: 0, d0: 0, streak: 0, rmax: 0, lmax: 0, smax: 0 };
}

// Suivi par journée des critères de départage « fins » (remis à zéro avec la journée) :
//   rmax = pire rattrapage d'une victoire (✅2️⃣ > ✅1️⃣ > ✅0️⃣), lrun/lmax = série de pertes en cours / pire série,
//   smax = meilleure série de victoires. Appelé APRÈS la mise à jour de day.streak.
function trackDayResult(d, field, step = 0) {
  if (!d) return;
  if (field === 'wins') {
    d.rmax = Math.max(d.rmax || 0, Number(step) || 0);
    d.lrun = 0;
    d.smax = Math.max(d.smax || 0, d.streak || 0);
  } else if (field === 'losses') {
    d.lrun = (d.lrun || 0) + 1;
    d.lmax = Math.max(d.lmax || 0, d.lrun);
  }
}

// Qualité d'une configuration : 1) taux de réussite, 2) à taux égal, MOYENNE DES RATTRAPAGES
// des victoires (✅0️⃣ = 0, ✅1️⃣ = 1…) : la plus petite moyenne est la meilleure.
// Comparaisons par produits en croix (exactes, sans erreur d'arrondi).
// 3) 1ers coups, 4) série en cours, 5) pire rattrapage, 6) pire série de pertes, 7) meilleure série de victoires.
// Retour : < 0 si a est meilleure que b, > 0 si b est meilleure, 0 si égalité parfaite.
function compareQuality(a, b) {
  const rate = (a.wins * b.total) - (b.wins * a.total); // > 0 : a a un meilleur taux
  if (a.total && b.total && rate !== 0) return rate > 0 ? -1 : 1;
  if (!a.wins || !b.wins) return 0; // pas de victoire : pas de moyenne à comparer
  const avg = (a.rsum * b.wins) - (b.rsum * a.wins); // < 0 : a a une plus petite moyenne
  if (avg !== 0) return avg < 0 ? -1 : 1;
  // 3) à taux ET moyenne égaux : plus de victoires DU PREMIER COUP (rapportées au nombre de prédictions)
  const d0 = ((a.d0 || 0) * b.total) - ((b.d0 || 0) * a.total);
  if (d0 !== 0) return d0 > 0 ? -1 : 1;
  // 4) encore égaux : la plus longue série de victoires EN COURS (meilleure forme du moment)
  const st = (a.streak || 0) - (b.streak || 0);
  if (st !== 0) return st > 0 ? -1 : 1;
  // 5) encore égaux : le pire rattrapage de la journée (celle qui n'a jamais eu besoin d'un rattrapage plus lourd)
  const rm = (a.rmax || 0) - (b.rmax || 0);
  if (rm !== 0) return rm < 0 ? -1 : 1;
  // 6) encore égaux : la plus petite pire série de pertes (la plus régulière)
  const lm = (a.lmax || 0) - (b.lmax || 0);
  if (lm !== 0) return lm < 0 ? -1 : 1;
  // 7) encore égaux : la meilleure série de victoires de la journée
  const sm = (a.smax || 0) - (b.smax || 0);
  return sm > 0 ? -1 : sm < 0 ? 1 : 0;
}
// Classement complet : qualité, puis plus de prédictions, puis plus de victoires.
// Égalité TOTALE sur tous les critères : le meilleur actuel garde la 1re place (cohérent avec currentBest),
// sinon ordre stable par identifiant : il n'y a plus jamais deux « premiers ».
const rowKey = (r) => String(r.c ? r.c.key : r.t.id);
function holderFirst(a, b) {
  const cur = String(panel.best.currentTrackerId || '');
  const ka = rowKey(a); const kb = rowKey(b);
  if (ka === cur && kb !== cur) return -1;
  if (kb === cur && ka !== cur) return 1;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
function compareRanking(a, b) {
  return compareQuality(a, b) || (b.total - a.total) || (b.wins - a.wins) || holderFirst(a, b);
}
const avgRattrapage = (r) => (r.wins ? (r.rsum / r.wins).toFixed(2).replace('.', ',') : '—');

const NUM_EMOJI = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const pct = (w, n) => (n ? `${((w / n) * 100).toFixed(1).replace('.', ',')} %` : '—');

// Barre de progression (10 cases) ; la couleur suit le taux de réussite.
function progressBar(rate, size = 10) {
  const filled = Math.max(0, Math.min(size, Math.round(rate * size)));
  const on = rate >= 0.8 ? '🟩' : rate >= 0.5 ? '🟨' : '🟥';
  return on.repeat(filled) + '⬜'.repeat(size - filled);
}
// Nom affiché = uniquement le(s) canal(aux), jamais le nom de la stratégie.
const channelLabel = (r) => (r.names.length ? r.names.join(' + ') : 'Canal sans nom');

function trackerChannelNames(t, siteList) {
  const names = [];
  for (const id of allChannels(t)) names.push(panel.channelTitles[String(id)] || String(id));
  if (t.siteChannelId) {
    const sc = siteList.find((c) => String(c.id) === String(t.siteChannelId));
    names.push(sc && sc.name ? sc.name : `canal du site ${t.siteChannelId}`);
  }
  return names;
}

// Texte du bilan. reportKey = jour concerné ; label = ligne d'en-tête.
// title = nom du canal destinataire (affiché dans l'en-tête à la place du nom de la stratégie).
function buildBilanText(now = Date.now(), forceToday = false, title = '') {
  const lp = localParts(now);
  const slotH = Math.floor(lp.h / panel.bilan.everyHours) * panel.bilan.everyHours;
  // au point de minuit (00h) : bilan de la journée qui vient de se terminer
  const closing = !forceToday && slotH === 0;
  const reportKey = dayKeyOf(closing ? now - 30 * 60 * 1000 : now);
  const [ry, rm, rd] = reportKey.split('-');
  const hh = String(slotH).padStart(2, '0');
  const siteList = siteChannelsView();
  const min = panel.bilan.minPreds;
  const rows = contestants().map((c) => {
    const st = dayStats(c.holder, reportKey);
    const t = c.tracker;
    const names = c.slot === undefined
      ? trackerChannelNames(t, siteList)
      : [panel.channelTitles[String(t.slots[c.slot].channel)] || t.slots[c.slot].name || String(t.slots[c.slot].channel)];
    return { c, t, ...st, names, rate: st.total ? st.wins / st.total : 0 };
  }).filter((r) => r.total > 0 || forceToday);
  const ranked = rows.filter((r) => r.total >= min)
    .sort(compareRanking);
  const pending = rows.filter((r) => r.total < min && r.total > 0);
  if (!rows.some((r) => r.total > 0)) return null;
  const lines = [];
  lines.push(title ? `📊 BILAN — ${title}` : '📊 BILAN');
  lines.push(closing ? `🕑 Bilan de la journée du ${rd}/${rm}/${ry}` : `🕑 Point de ${hh}h00 · journée du ${rd}/${rm}/${ry}`);
  lines.push(closing ? '📆 Cumul de toute la journée (00h00 → 24h00)' : `📆 Cumul depuis 00h00 jusqu'à ${hh}h00 · mis à jour toutes les ${panel.bilan.everyHours} h`);
  lines.push('━━━━━━━━━━━━━━━━━━');
  if (ranked.length) {
    const best = ranked[0];
    lines.push(`🏆 Meilleur canal : « ${channelLabel(best)} »`);
    lines.push(`${progressBar(best.rate)} ${pct(best.wins, best.total)}`);
    lines.push(`📈 ${best.wins} ✅ · ${best.losses} ❌ sur ${best.total} prédiction${best.total > 1 ? 's' : ''}`);
    lines.push(`🎯 Rattrapage moyen : ${avgRattrapage(best)}`);
    if (panel.best.enabled && panel.best.channels.length) {
      lines.push('');
      lines.push('🎯 Meilleures prédictions envoyées actuellement dans :');
      for (const id of panel.best.channels) {
        const nm = panel.channelTitles[String(id)] || String(id);
        const lk = (panel.best.link && String(id) === String(panel.best.channels[0])) ? panel.best.link : channelLinkOf(id);
        lines.push(`    📣 « ${nm} »${lk ? `\n    🔗 ${lk}` : ''}`);
      }
      lines.push(`    Taux du meilleur canal : ${pct(best.wins, best.total)} (${best.wins}/${best.total})`);
    }
    lines.push('');
    lines.push('📋 Classement');
    ranked.slice(0, 15).forEach((r, i) => {
      lines.push(`${NUM_EMOJI[i] || `${i + 1}.`} ${channelLabel(r)}`);
      lines.push(`    ${progressBar(r.rate)} ${pct(r.wins, r.total)} · ${r.wins}/${r.total} · moy. ${avgRattrapage(r)} · 1er coup ${r.d0 || 0}`);
    });
  } else {
    lines.push(`ℹ️ Aucun canal n'a encore ${min} prédictions vérifiées : pas de classement pour l'instant.`);
  }
  if (pending.length) {
    lines.push('');
    lines.push('⏳ Pas assez de données');
    pending.slice(0, 10).forEach((r) => lines.push(`• ${channelLabel(r)} — ${progressBar(r.total / min, 5)} ${r.total}/${min}`));
  }
  lines.push('━━━━━━━━━━━━━━━━━━');
  return lines.join('\n');
}

// canaux destinataires : tous ceux des configurations actives (dédoublonnés)
function bilanTargets() {
  const tg = []; const site = [];
  for (const t of panel.trackers) {
    if (t.enabled === false) continue;
    for (const id of allChannels(t)) if (!tg.some((x) => String(x) === String(id))) tg.push(id);
    if (t.siteChannelId && !site.includes(String(t.siteChannelId))) site.push(String(t.siteChannelId));
  }
  return { tg, site };
}

// Rafraîchit TOUJOURS les noms réels des canaux (getChat) juste avant l'envoi :
// un ancien nom en cache (canal renommé, nom saisi à la main) ne reste plus affiché.
// Si getChat échoue, on garde le dernier nom connu.
async function refreshChannelTitles(ids) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot || typeof bot.getChat !== 'function') return;
  const uniq = [...new Set(ids.map((id) => String(id)))];
  await Promise.all(uniq.map(async (id) => {
    try {
      const chat = await bot.getChat(id);
      const title = chat && (chat.title || chat.username || chat.first_name);
      if (title && panel.channelTitles[id] !== String(title).slice(0, 120)) setChannelTitle(id, title);
      // lien : canal public (@nom) sinon lien d'invitation déjà connu de Telegram (jamais d'en créer un : cela
      // révoquerait ou multiplierait les liens existants du canal)
      const link = chat && (chat.username ? `https://t.me/${chat.username}` : (chat.invite_link || null));
      if (link && panel.channelLinks[id] !== link) { panel.channelLinks[id] = link; persist(); }
    } catch (_) { /* on garde le dernier nom connu (ou l'ID) */ }
  }));
}

async function sendBilan({ force = false, now = Date.now() } = {}) {
  const { tg, site } = bilanTargets();
  if (!tg.length && !site.length) return { ok: false, error: 'Aucun canal configuré' };
  // tous les canaux des configurations (même désactivées) apparaissent dans le classement
  const allIds = panel.trackers.flatMap((t) => allChannels(t));
  await refreshChannelTitles([...tg, ...allIds, ...(panel.best.enabled ? panel.best.channels : [])]);
  if (!buildBilanText(now, force)) return { ok: false, error: "Aucune prédiction vérifiée aujourd'hui : bilan non envoyé" };
  // l'en-tête porte le nom du canal qui reçoit le bilan (jamais le nom de la stratégie)
  const textFor = (title) => buildBilanText(now, force, title);
  const tgTitle = (id) => panel.channelTitles[String(id)] || String(id);
  const siteName = (id) => { const sc = siteChannelsView().find((c) => String(c.id) === String(id)); return sc && sc.name ? sc.name : `canal du site ${id}`; };
  const bot = typeof sender === 'function' ? sender() : null;
  const sent = []; const errors = [];
  if (tg.length) {
    if (!bot) errors.push('Aucun token Telegram configuré');
    else {
      const res = await Promise.all(tg.map((id) => bot.sendMessage(id, textFor(tgTitle(id)))
        .then((m) => (m && m.skipped ? { skipped: true } : { ok: true, id }))
        .catch((e) => ({ id, error: e.message }))));
      for (const r of res) { if (r.ok) sent.push(String(r.id)); else if (!r.skipped) errors.push(`${r.id} : ${r.error}`); }
    }
  }
  for (const id of site) { if (addSiteChannelMessage(id, { sender: 'Bilan', text: textFor(siteName(id)) })) sent.push(`site:${id}`); }
  panel.bilan.lastSentAt = Date.now();
  panel.bilan.lastResult = { sent: sent.length, errors: errors.slice(0, 3), at: Date.now() };
  return { ok: sent.length > 0, sent, errors, text: textFor(tg.length ? tgTitle(tg[0]) : siteName(site[0])) };
}

async function bilanTick(now = Date.now()) {
  for (const t of panel.trackers) rollDay(t, now);
  const b = panel.bilan;
  if (!b.enabled) return;
  const lp = localParts(now);
  const slotH = Math.floor(lp.h / b.everyHours) * b.everyHours;
  const slot = `${lp.y}-${lp.m}-${lp.d}T${String(slotH).padStart(2, '0')}`;
  if (b.lastSlot === null) { b.lastSlot = slot; return; } // première activation : on attend le prochain point
  if (b.lastSlot === slot) return;
  b.lastSlot = slot; // marqué avant l'envoi : jamais deux fois le même point
  try { await sendBilan({ now }); } catch (e) { panel.lastError = e.message; }
}

// Envoi À L'HEURE PILE : minuteur dédié (ne dépend pas du rythme du scan).
// Il se réarme sur chaque début d'heure ; bilanTick() ne l'envoie qu'une fois par point.
let bilanTimer = null;
function armBilanTimer() {
  if (bilanTimer) clearTimeout(bilanTimer);
  const HOUR = 3600 * 1000;
  const wait = HOUR - (Date.now() % HOUR) + 300; // +0,3 s : on est sûr d'être dans la nouvelle heure
  bilanTimer = setTimeout(async () => {
    try { await bilanTick(); } catch (e) { panel.lastError = e.message; } finally { persist(); armBilanTimer(); }
  }, wait);
  if (bilanTimer.unref) bilanTimer.unref();
}
armBilanTimer();

async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    rollBestDay();
    for (const tracker of panel.trackers) await processTracker(tracker);
    await verifyPending();
    await bilanTick();
    await maybeSendRecap();
    panel.lastScanAt = Date.now();
  } catch (e) {
    panel.lastError = e.message;
  } finally {
    persist();
    busy = false;
  }
  return panel;
}

// message de test sur les canaux d'UNE configuration
async function test(trackerId) {
  const tracker = panel.trackers.find((t) => t.id === trackerId);
  if (!tracker) return { ok: false, error: 'Configuration introuvable' };
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  const chans = allChannels(tracker);
  if (!chans.length) return { ok: false, error: 'Aucun canal Telegram configuré pour cette configuration' };
  const preview = fmt.formatPreview(tracker.format, { maxR: tracker.maxR });
  const sent = [];
  const errors = [];
  const sm = slotMode(tracker);
  for (let k = 0; k < chans.length; k++) {
    const id = chans[k];
    const label = sm ? slotName(tracker, tracker.slots.findIndex((x) => x.channel === id)) : tracker.name;
    try {
      await bot.sendMessage(id, `🃏 COSTUME FAIBLE — message de test\n${label}\n\nFormat ${tracker.format} :\n\n${preview}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

// lien saisi à la main : https://t.me/..., t.me/..., telegram.me/... ou @nom (vide = aucun)
function sanitizeLink(value) {
  let v = String(value == null ? '' : value).trim().slice(0, 200);
  if (!v) return '';
  if (v.startsWith('@')) return `https://t.me/${v.slice(1)}`;
  if (/^(t\.me|telegram\.me)\//i.test(v)) v = `https://${v}`;
  return /^https?:\/\/(t\.me|telegram\.me)\/\S+$/i.test(v) ? v : '';
}

// lien du canal : celui récupéré par Telegram, sinon @nom saisi à la main
function channelLinkOf(id) {
  const key = String(id == null ? '' : id).trim();
  if (panel.channelLinks[key]) return panel.channelLinks[key];
  if (key.startsWith('@')) return `https://t.me/${key.slice(1)}`;
  return null;
}

function setChannelTitle(id, title) {
  const key = String(id == null ? '' : id).trim();
  if (!key || !title) return;
  panel.channelTitles[key] = String(title).slice(0, 120);
  persist();
}

function lastPredsFor(trackerId, limit = 3, slot) {
  return panel.pendingMessages
    .filter((e) => e.trackerId === trackerId && (slot === undefined || e.slot === slot))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit)
    .map((e) => ({ target: e.target, suit: e.suit, status: e.status, step: e.step, createdAt: e.createdAt, slot: e.slot }));
}

// dernier déclencheur trouvé par la configuration (affiché au centre de la carte)
function triggerView(tracker) {
  const li = tracker.lastInfo;
  if (!li) return null;
  return { trigger: li.trigger, four: li.four, weak: li.weak, suit: li.suit, target: li.target };
}

function statusView() {
  return {
    ...config(),
    siteChannels: siteChannelsView().map((c) => ({ id: c.id, name: c.name })),
    channelTitles: panel.channelTitles,
    formatCount: fmt.FORMAT_COUNT,
    trackers: panel.trackers.map((t) => ({
      id: t.id, name: t.name, rule: t.rule, lead: t.lead, enabled: t.enabled,
      label: `règle ${ruleShort(t.rule)}`, ruleLabel: ruleLabel(t.rule),
      channels: t.channels, siteChannelId: t.siteChannelId, format: t.format, maxR: t.maxR,
      slots: t.slots.map((sl, i) => ({ ...sl, lastPreds: lastPredsFor(t.id, 3, i) })),
      slotMode: slotMode(t), slotRoles: SLOT_ROLES,
      wins: slotMode(t) ? t.slots.reduce((a, x) => a + (x.wins || 0), 0) : (t.wins || 0),
      losses: slotMode(t) ? t.slots.reduce((a, x) => a + (x.losses || 0), 0) : (t.losses || 0),
      lastInfo: t.lastInfo || null, lastGame: t.lastGame || 0,
      view: triggerView(t),
      sentCount: t.sentCount, lastSentAt: t.lastSentAt, createdAt: t.createdAt,
      lastPreds: lastPredsFor(t.id, 3),
    })),
    bilan: { ...panel.bilan, tz: BILAN_TZ },
    best: {
      ...panel.best,
      currentName: (() => { const c = contestantByKey(panel.best.currentTrackerId); return c ? contestantName(c) : null; })(),
      channelNames: panel.best.channels.map((id) => panel.channelTitles[String(id)] || String(id)),
      channelLinks: panel.best.channels.map((id, k) => (k === 0 && panel.best.link) ? panel.best.link : channelLinkOf(id)),
    },
    lastMember,
    history: panel.history.slice(0, 30),
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
  };
}

module.exports = {
  panel, setSender, tick, test, status: statusView, config, configure,
  addTracker, updateTracker, removeTracker,
  restore, restoreFromDb, parseChannels, setChannelTitle,
  // exposés pour les tests
  triggerOf, suitFor, slotSuit,
  sendBilan, buildBilanText, bilanTick, rollDay, compareQuality, compareRanking,
};

// exposé pour l'effacement de minuit (midnight-reset.js)
module.exports.persist = persist;
module.exports.send = send;
module.exports.currentBest = currentBest;
module.exports.setAdminId = setAdminId;
module.exports.handleMemberUpdate = handleMemberUpdate;
module.exports.welcomeText = welcomeText;
module.exports.testWelcome = testWelcome;
module.exports.bumpEntry = bumpEntry;
