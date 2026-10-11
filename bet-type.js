// bet-type.js — bouton « Type de mise » (demande admin).
//
// Deux parties :
//
//  1. « Créer » : une CONFIGURATION surveille les prédictions publiées par un
//     ou plusieurs canaux déjà connus du site (liste « nom · id ») et, selon
//     son TYPE, renvoie une prédiction dans SON canal de destination :
//
//       Type 1 — deux prédictions consécutives du canal ont le MÊME costume :
//                on attend que ce même costume soit prédit à nouveau, et c'est
//                cette prédiction-là qui est envoyée.
//       Type 2 — deux prédictions consécutives de même costume : on envoie la
//                PROCHAINE prédiction du canal (quel que soit son costume).
//       Type 3 — après 2 pertes consécutives du canal : on envoie sa prochaine
//                prédiction.
//       Type 4 — après 1 perte du canal : on envoie sa prochaine prédiction.
//
//     Chaque configuration a son propre taux de réussite (gagné / perdu des
//     prédictions qu'elle a elle-même envoyées).
//
//  2. « Meilleur type de mise » : canal (id), rattrapage et format propres.
//     Il envoie les prédictions de la configuration qui a le MEILLEUR taux de
//     réussite au moment où elle déclenche, et publie le classement des taux
//     de réussite à chaque fois qu'il change.
'use strict';

const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const { state, hasSuit, setOnShoeReset } = require('./predictor');
const earlyVerify = require('./early-verify');
const copyAnnounce = require('./copy-announce');

const TYPES = {
  1: { label: 'Type 1 — même costume deux fois, puis attendre son retour' },
  2: { label: 'Type 2 — même costume deux fois, puis la prédiction suivante' },
  3: { label: 'Type 3 — après 2 pertes consécutives' },
  4: { label: 'Type 4 — après 1 perte' },
};

const panel = {
  enabled: true,
  trackers: [], // les configurations (nom `trackers` : effacées/zéro à minuit par midnight-reset.js)
  best: { enabled: true, channels: [], format: 1, maxR: 1, minSample: 3, announceRates: true, bilanEnabled: true, bilanEveryMin: 60, lastBilanAt: null, sentCount: 0, wins: 0, losses: 0, lastSnapshot: '', lastRatesAt: null },
  pendingMessages: [],
  channelTitles: {},
  history: [],
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
};

let sender = null;
function setSender(fn) { sender = fn; }
let busy = false;

const newId = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const sameChannel = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function parseChannels(value) { return copyAnnounce.parseChannels(value); }

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------
function sanitizeType(v) {
  const n = parseInt(v, 10);
  return n >= 1 && n <= 4 ? n : 1;
}

function sanitizeSources(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim();
    if (t && !out.some((x) => sameChannel(x, t))) out.push(t);
  }
  return out;
}

function sanitizeLink(v) {
  const t = String(v == null ? '' : v).trim().slice(0, 200);
  return /^(https?:\/\/)?(t\.me|telegram\.me)\//i.test(t) ? t : '';
}

// lien public t.me/nom -> ['@nom'] ; un lien d'invitation privé (+xxx) ne donne pas d'id
function channelFromLink(link) {
  const m = /(?:t|telegram)\.me\/([A-Za-z0-9_]{4,})\/?$/i.exec(link);
  return m ? parseChannels(['@' + m[1]]) : [];
}

function emptyState() {
  return { seen: [], streakSuit: null, streakCount: 0, waitingSuit: null, armed: false, lossCount: 0, refs: [], trigRefs: [] };
}

function currentUids(sourceId) {
  return copyAnnounce.sourceEntries(`channel:${sourceId}`).map((e) => e.uid);
}

function buildConfig(body, previous) {
  const sources = body.sources !== undefined ? sanitizeSources(body.sources) : (previous ? previous.sources : []);
  if (!sources.length) throw new Error('Sélectionne au moins un canal à surveiller.');
  const dest = body.destChannels !== undefined ? parseChannels(body.destChannels) : (previous ? previous.destChannels : []);
  if (!dest.length) throw new Error("Indique l'ID du canal où envoyer les prédictions.");
  for (const d of dest) {
    if (sources.some((s) => sameChannel(s, d))) throw new Error('Le canal de destination ne peut pas être aussi un canal surveillé (boucle infinie).');
  }
  const type = body.type !== undefined ? sanitizeType(body.type) : (previous ? previous.type : 1);
  // Canal du « meilleur » propre à cette configuration (id et/ou lien) : reçoit
  // ses prédictions quand elle est la meilleure. Si seul le lien public est
  // donné (t.me/nom), l'id (@nom) en est déduit.
  const bestLink = body.bestLink !== undefined ? sanitizeLink(body.bestLink) : (previous ? previous.bestLink : '');
  let bestChannels = body.bestChannels !== undefined ? parseChannels(body.bestChannels) : (previous ? previous.bestChannels : []);
  if (!bestChannels.length && bestLink) bestChannels = channelFromLink(bestLink);
  for (const d of bestChannels) {
    if (sources.some((x) => sameChannel(x, d))) throw new Error('Le canal du meilleur ne peut pas être aussi un canal surveillé (boucle infinie).');
  }
  const cfg = {
    id: (previous && previous.id) || newId('bt'),
    name: String(body.name !== undefined ? body.name : (previous ? previous.name : '')).trim().slice(0, 80),
    type, sources, destChannels: dest, bestChannels, bestLink,
    format: body.format !== undefined ? fmt.clampFormat(body.format) : (previous ? previous.format : 1),
    maxR: body.maxR !== undefined ? Math.max(0, Math.min(9, parseInt(body.maxR, 10) || 0)) : (previous ? previous.maxR : 1),
    enabled: body.enabled !== undefined ? !!body.enabled : (previous ? previous.enabled : true),
    states: {},
    wins: previous ? previous.wins : 0,
    losses: previous ? previous.losses : 0,
    sentCount: previous ? previous.sentCount : 0,
    lastWin: previous ? previous.lastWin : null,
    lastWins: previous ? previous.lastWins : [],
    lastSentAt: previous ? previous.lastSentAt : null,
    createdAt: previous ? previous.createdAt : Date.now(),
  };
  if (!cfg.name) cfg.name = `Type ${type} · ${sources.length} canal(aux)`;
  const typeChanged = previous && previous.type !== type;
  for (const s of sources) {
    const old = previous && previous.states && previous.states[s];
    if (old && !typeChanged) cfg.states[s] = old;
    else {
      // nouveau canal (ou nouveau type) : on ignore tout l'historique déjà publié
      cfg.states[s] = emptyState();
      cfg.states[s].seen = currentUids(s);
    }
  }
  return cfg;
}

// Anti-doublon : même type + mêmes canaux surveillés + même canal d'envoi.
function findDuplicate(cfg) {
  const norm = (list) => list.map((x) => String(x).toLowerCase()).sort().join('|');
  return panel.trackers.find((c) => c.id !== cfg.id && c.type === cfg.type
    && norm(c.sources) === norm(cfg.sources) && norm(c.destChannels) === norm(cfg.destChannels)) || null;
}

function addConfig(body) {
  const cfg = buildConfig(body || {}, null);
  const dup = findDuplicate(cfg);
  if (dup) throw new Error(`Doublon : la configuration « ${dup.name} » a déjà le même type, les mêmes canaux surveillés et le même canal d'envoi.`);
  panel.trackers.push(cfg);
  persist();
  return cfg;
}

function updateConfig(id, body) {
  const i = panel.trackers.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const next = buildConfig(body || {}, panel.trackers[i]);
  const dup = findDuplicate(next);
  if (dup) throw new Error(`Doublon : la configuration « ${dup.name} » a déjà le même type, les mêmes canaux surveillés et le même canal d'envoi.`);
  panel.trackers[i] = next;
  persist();
  return panel.trackers[i];
}

function removeConfig(id) {
  panel.trackers = panel.trackers.filter((c) => c.id !== id);
  panel.pendingMessages = panel.pendingMessages.filter((e) => e.trackerId !== id);
  persist();
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  persist();
  return { enabled: panel.enabled };
}

function configureBest(patch = {}) {
  const b = panel.best;
  if (patch.enabled !== undefined) b.enabled = !!patch.enabled;
  if (patch.channels !== undefined) b.channels = parseChannels(patch.channels);
  if (patch.format !== undefined) b.format = fmt.clampFormat(patch.format);
  if (patch.maxR !== undefined) b.maxR = Math.max(0, Math.min(9, parseInt(patch.maxR, 10) || 0));
  if (patch.minSample !== undefined) b.minSample = Math.max(1, Math.min(100, parseInt(patch.minSample, 10) || 1));
  if (patch.announceRates !== undefined) b.announceRates = !!patch.announceRates;
  if (patch.bilanEnabled !== undefined) b.bilanEnabled = !!patch.bilanEnabled;
  if (patch.bilanEveryMin !== undefined) b.bilanEveryMin = Math.max(1, Math.min(1440, parseInt(patch.bilanEveryMin, 10) || 60));
  persist();
  return b;
}

// ---------------------------------------------------------------------------
// Taux de réussite et « meilleur »
// ---------------------------------------------------------------------------
function rateOf(c) {
  const total = (c.wins || 0) + (c.losses || 0);
  return total ? Math.round((c.wins / total) * 1000) / 10 : null;
}

function ranking() {
  return panel.trackers
    .filter((c) => (c.wins || 0) + (c.losses || 0) > 0)
    .map((c) => ({ id: c.id, name: c.name, type: c.type, wins: c.wins, losses: c.losses, total: c.wins + c.losses, rate: rateOf(c) }))
    .sort((a, b) => b.rate - a.rate || b.total - a.total);
}

function bestConfig() {
  const cand = ranking().filter((r) => {
    const c = panel.trackers.find((x) => x.id === r.id);
    return c && c.enabled && r.total >= panel.best.minSample;
  });
  return cand.length ? cand[0] : null;
}

// ---------------------------------------------------------------------------
// Traitement
// ---------------------------------------------------------------------------
async function processConfig(cfg) {
  for (const sourceId of cfg.sources) {
    const st = cfg.states[sourceId] || (cfg.states[sourceId] = emptyState());
    const entries = copyAnnounce.sourceEntries(`channel:${sourceId}`)
      .filter((e) => e.suit)
      .sort((a, b) => a.target - b.target);
    for (const e of entries) {
      if (st.seen.includes(e.uid)) continue;
      const pending = e.status === 'en attente';
      const lost = e.status === 'perdu';
      const won = e.status === 'gagné';
      if (e.status === 'annulé') { st.seen.push(e.uid); continue; }

      if (cfg.type === 3 || cfg.type === 4) {
        const need = cfg.type === 3 ? 2 : 1;
        if (st.armed) {
          // une prédiction déjà terminée ne peut plus être jouée : on reste armé
          if (pending) { await fire(cfg, e, sourceId, { kind: cfg.type === 3 ? 'loss2' : 'loss1', refs: st.refs }); st.armed = false; st.lossCount = 0; st.refs = []; }
          st.seen.push(e.uid);
          continue;
        }
        if (!pending && !lost && !won) { st.seen.push(e.uid); continue; }
        if (pending) break; // on attend son résultat avant d'aller plus loin
        if (lost) { st.lossCount += 1; st.refs.push({ target: e.target, suit: e.suit }); if (st.lossCount >= need) st.armed = true; }
        else { st.lossCount = 0; st.refs = []; }
        st.seen.push(e.uid);
        continue;
      }

      // types 1 et 2 : séries de même costume (peu importe gagné / perdu)
      if (cfg.type === 2 && st.armed) {
        if (pending) { await fire(cfg, e, sourceId, { kind: 'streak-next', suit: st.trigSuit, refs: st.trigRefs }); st.armed = false; st.streakSuit = null; st.streakCount = 0; }
        st.seen.push(e.uid);
        continue;
      }
      if (cfg.type === 1 && st.waitingSuit) {
        if (e.suit === st.waitingSuit) {
          if (pending) { await fire(cfg, e, sourceId, { kind: 'streak-back', suit: e.suit, refs: st.trigRefs }); st.waitingSuit = null; }
        }
        st.seen.push(e.uid);
        continue;
      }
      if (e.suit === st.streakSuit) { st.streakCount += 1; st.refs.push({ target: e.target, suit: e.suit }); }
      else { st.streakSuit = e.suit; st.streakCount = 1; st.refs = [{ target: e.target, suit: e.suit }]; }
      if (st.streakCount >= 2) {
        if (cfg.type === 1) st.waitingSuit = e.suit; else { st.armed = true; st.trigSuit = e.suit; }
        st.trigRefs = st.refs.slice(); st.refs = [];
        st.streakSuit = null; st.streakCount = 0;
      }
      st.seen.push(e.uid);
    }
    if (st.seen.length > 800) st.seen = st.seen.slice(-600);
  }
}

// Canaux qui reçoivent le « meilleur » : ceux propres à la configuration s'il y
// en a, sinon ceux du panneau « Meilleur type de mise ».
function bestTargetsFor(cfg) {
  return (cfg.bestChannels && cfg.bestChannels.length) ? cfg.bestChannels : panel.best.channels;
}

// Tous les canaux « meilleur » (panneau + configurations), sans doublon.
function allBestChannels() {
  const out = [];
  for (const id of [...panel.best.channels, ...panel.trackers.flatMap((c) => c.bestChannels || [])]) {
    if (!out.some((x) => sameChannel(x, id))) out.push(id);
  }
  return out;
}

async function fire(cfg, entry, sourceId, trigger) {
  const syn = { target: entry.target, suit: entry.suit, sourceId, trigger: trigger || null };
  await send(cfg, syn, 'config');
  const best = bestConfig();
  if (best && best.id === cfg.id && panel.best.enabled && bestTargetsFor(cfg).length) {
    await send(cfg, syn, 'best');
  }
}

function render(strategyName, syn, format, maxR, statusFr, step) {
  return fmt.renderMessage(format, {
    gameNumber: syn.target, suit: syn.suit, strategy: strategyName,
    maxR, status: statusFr, rattrapage: step || 0,
  }, null);
}

async function sendTo(channels, out) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { sent: [], errors: ['Aucun token Telegram configuré'] };
  const results = await Promise.all(channels.map((id) =>
    bot.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {})
      .then((m) => (m && m.skipped ? { ok: false, skipped: true, id } : { ok: true, id, messageId: m.message_id }))
      .catch((e) => ({ ok: false, id, error: e.message }))));
  const sent = []; const errors = [];
  for (const r of results) {
    if (r.ok) sent.push({ chatId: r.id, messageId: r.messageId });
    else if (!r.skipped) errors.push(`${r.id} : ${r.error}`);
  }
  return { sent, errors };
}

async function send(cfg, syn, scope) {
  const isBest = scope === 'best';
  const channels = isBest ? bestTargetsFor(cfg) : cfg.destChannels;
  const format = isBest ? panel.best.format : cfg.format;
  const maxR = isBest ? panel.best.maxR : cfg.maxR;
  const label = isBest ? `${cfg.name} (meilleur type de mise)` : `${cfg.name} (type de mise)`;
  const out = render(label, syn, format, maxR, 'en attente', 0);
  const { sent, errors } = await sendTo(channels, out);
  if (!sent.length) { if (errors.length) panel.lastError = errors[0]; return false; }
  panel.lastError = errors[0] || null;
  panel.sentCount += 1; panel.lastSentAt = Date.now();
  if (isBest) panel.best.sentCount += 1;
  else { cfg.sentCount += 1; cfg.lastSentAt = Date.now(); }
  panel.history.unshift({ trackerId: cfg.id, trackerName: cfg.name, scope, target: syn.target, suit: syn.suit, sentAt: Date.now() });
  panel.history = panel.history.slice(0, 100);
  panel.pendingMessages.push({
    id: newId('p'), trackerId: cfg.id, scope, target: syn.target, suit: syn.suit, strategyName: label,
    trigger: syn.trigger || null, sourceId: syn.sourceId || null,
    format, maxR, step: 0, gap: 0, skipped: 0, status: 'en attente', messages: sent,
    createdAt: Date.now(), resolvedAt: null,
  });
  if (panel.pendingMessages.length > 300) {
    panel.pendingMessages = panel.pendingMessages.filter((e) => e.status === 'en attente').concat(
      panel.pendingMessages.filter((e) => e.status !== 'en attente').slice(-200));
  }
  return true;
}

function editPending(entry, statusFr) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  const out = render(entry.strategyName, entry, entry.format, entry.maxR, statusFr, entry.step);
  for (const m of entry.messages) {
    bot.editMessageText(out.text, {
      chat_id: m.chatId, message_id: m.messageId,
      ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}),
    }).catch(() => {});
  }
}

function recordResult(entry, won) {
  if (entry.scope === 'best') {
    if (won) panel.best.wins += 1; else panel.best.losses += 1;
    return;
  }
  const cfg = panel.trackers.find((c) => c.id === entry.trackerId);
  if (!cfg) return;
  if (won) {
    cfg.wins += 1;
    // dernier suivi réussi : sert d'exemple dans la commande /meri
    const win = { target: entry.target, suit: entry.suit, step: entry.step, at: Date.now(), trigger: entry.trigger || null, sourceId: entry.sourceId || null };
    cfg.lastWins = [win, ...(cfg.lastWins || [])].slice(0, 3);
    cfg.lastWin = win;
  } else cfg.losses += 1;
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
      const usable = (!!g && g.finished && g.complete !== false)
        || earlyVerify.hit(g, undefined, (gg) => hasSuit(gg, entry.suit));
      if (!usable) {
        if (num + 2 <= maxDone) {
          entry.gap += 1;
          entry.skipped = (entry.skipped || 0) + 1;
          if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); break; }
          continue;
        }
        break;
      }
      if (hasSuit(g, entry.suit)) { entry.status = 'gagné'; entry.resolvedAt = Date.now(); recordResult(entry, true); editPending(entry, 'gagné'); break; }
      if (entry.step >= entry.maxR) { entry.status = 'perdu'; entry.resolvedAt = Date.now(); recordResult(entry, false); editPending(entry, 'perdu'); break; }
      entry.step += 1;
    }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pendingMessages = panel.pendingMessages.filter((e) => e.status === 'en attente' || !e.resolvedAt || e.resolvedAt >= cutoff);
}

// Publie le classement des taux de réussite quand il a changé.
function ratesText(rank, bestId) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = ['📊 TAUX DE RÉUSSITE — TYPE DE MISE', ''];
  rank.forEach((r, i) => {
    lines.push(`${medals[i] || '▫️'} ${r.name} (type ${r.type}) : ${r.rate}% — ${r.wins}✅ ${r.losses}❌${r.id === bestId ? ' ⭐ meilleur' : ''}`);
  });
  return lines.join('\n');
}

async function announceRates() {
  const b = panel.best;
  const targets = allBestChannels();
  if (!b.enabled || !b.announceRates || !targets.length) return;
  const rank = ranking();
  if (!rank.length) return;
  const snapshot = rank.map((r) => `${r.id}:${r.wins}:${r.losses}`).join('|');
  if (snapshot === b.lastSnapshot) return;
  const best = bestConfig();
  const { sent, errors } = await sendTo(targets, { text: ratesText(rank, best && best.id) });
  if (sent.length) { b.lastSnapshot = snapshot; b.lastRatesAt = Date.now(); panel.lastError = errors[0] || null; }
  else if (errors.length) panel.lastError = errors[0];
}

// ---------------------------------------------------------------------------
// Commande /meri tapée DANS un canal surveillé : explique le meilleur type de
// mise (français puis russe) avec l'exemple du dernier suivi réussi.
// ---------------------------------------------------------------------------
const EXPLAIN = {
  1: {
    fr: 'Le bot surveille le canal. Quand deux prédictions consécutives ont le même costume, il attend que ce même costume soit prédit à nouveau, puis envoie cette prédiction.',
    ru: 'Бот следит за каналом. Когда два прогноза подряд имеют одну и ту же масть, он ждёт, пока эта масть будет предсказана снова, и затем отправляет этот прогноз.',
  },
  2: {
    fr: 'Après deux prédictions consécutives de même costume dans le canal, le bot envoie la prédiction suivante du canal.',
    ru: 'После двух прогнозов подряд одной масти в канале бот отправляет следующий прогноз канала.',
  },
  3: {
    fr: 'Après 2 pertes consécutives du canal, le bot envoie sa prochaine prédiction.',
    ru: 'После 2 проигрышей подряд в канале бот отправляет его следующий прогноз.',
  },
  4: {
    fr: 'Après 1 perte du canal, le bot envoie sa prochaine prédiction.',
    ru: 'После 1 проигрыша в канале бот отправляет его следующий прогноз.',
  },
};

function triggerText(trigger, lang) {
  const k = trigger && trigger.kind;
  const suit = (trigger && trigger.suit) || '';
  const fr = lang === 'fr';
  if (k === 'streak-back') return fr ? `deux prédictions ${suit} d'affilée, puis ${suit} a été prédit à nouveau` : `два прогноза ${suit} подряд, затем ${suit} снова предсказана`;
  if (k === 'streak-next') return fr ? `deux prédictions ${suit} d'affilée, puis la prédiction suivante du canal` : `два прогноза ${suit} подряд, затем следующий прогноз канала`;
  if (k === 'loss2') return fr ? '2 pertes consécutives du canal' : '2 проигрыша подряд в канале';
  if (k === 'loss1') return fr ? '1 perte du canal' : '1 проигрыш в канале';
  return fr ? 'condition du type remplie' : 'условие типа выполнено';
}

function followsChat(cfg, chat) {
  const keys = [chat && chat.id, chat && chat.username ? `@${chat.username}` : null].filter((x) => x != null);
  return cfg.sources.some((s) => keys.some((k) => sameChannel(s, k)));
}

// Analyse comparée : toutes les configurations qui suivent ce canal, classées
// par taux de réussite ; le meilleur est celui retenu.
function analysisLines(best, lang, an) {
  const fr = lang === 'fr';
  const medals = ['🥇', '🥈', '🥉'];
  const out = [];
  out.push(fr
    ? `🔎 Analyse : ${an.compared} configuration(s) comparée(s), ${an.withResults} avec des résultats.`
    : `🔎 Анализ: сравнено конфигураций — ${an.compared}, с результатами — ${an.withResults}.`);
  if (an.ranking.length) {
    an.ranking.slice(0, 5).forEach((c, i) => {
      out.push(`${medals[i] || '▫️'} ${c.name} (${fr ? 'type' : 'тип'} ${c.type}) : ${rateOf(c)}% — ${c.wins}✅ ${c.losses}❌${c === best ? ' ⭐' : ''}`);
    });
  }
  out.push(an.reliable
    ? (fr ? `✅ Retenu : le plus haut taux de réussite avec au moins ${panel.best.minSample} résultat(s).` : `✅ Выбран: самый высокий процент успеха при минимум ${panel.best.minSample} результатах.`)
    : (fr ? `⚠️ Analyse provisoire : pas encore ${panel.best.minSample} résultat(s) pour confirmer le meilleur.` : `⚠️ Предварительный анализ: пока меньше ${panel.best.minSample} результатов для подтверждения лучшего.`));
  return out;
}

function meriBlock(c, lang, an) {
  const fr = lang === 'fr';
  const total = c.wins + c.losses;
  const rate = rateOf(c);
  const lines = [];
  lines.push(fr ? '🇫🇷 MEILLEUR TYPE DE MISE' : '🇷🇺 ЛУЧШИЙ ТИП СТАВКИ');
  lines.push('');
  lines.push(`⭐ ${c.name} — ${fr ? 'Type' : 'Тип'} ${c.type}`);
  lines.push(total
    ? (fr ? `📈 Taux de réussite : ${rate}% (${c.wins}✅ ${c.losses}❌ sur ${total})` : `📈 Процент успеха: ${rate}% (${c.wins}✅ ${c.losses}❌ из ${total})`)
    : (fr ? '📈 Taux de réussite : pas encore de résultat' : '📈 Процент успеха: результатов пока нет'));
  lines.push('');
  lines.push(...analysisLines(c, lang, an));
  lines.push('');
  lines.push(`${fr ? '📖 Explication' : '📖 Объяснение'} : ${EXPLAIN[c.type][lang]}`);
  lines.push('');
  const wins = (c.lastWins && c.lastWins.length) ? c.lastWins : (c.lastWin ? [c.lastWin] : []);
  if (wins.length) {
    lines.push(fr ? '🧪 Exemples de suivis réussis (du plus récent au plus ancien) :' : '🧪 Примеры успешных отслеживаний (от новых к старым):');
    wins.forEach((w, i) => {
      const when = new Date(w.at).toLocaleString(fr ? 'fr-FR' : 'ru-RU', { dateStyle: 'short', timeStyle: 'short' });
      const step = w.step > 0 ? (fr ? ` (rattrapage ${w.step})` : ` (добор ${w.step})`) : '';
      const refs = (w.trigger && w.trigger.refs) || [];
      lines.push('');
      lines.push(`${i + 1}️⃣ ${triggerText(w.trigger, lang)}`);
      if (refs.length) lines.push(fr ? `   👁️ Suivi : ${refs.map((r) => `#N${r.target} ${r.suit}`).join(' → ')}` : `   👁️ Отслеживалось: ${refs.map((r) => `#N${r.target} ${r.suit}`).join(' → ')}`);
      lines.push(fr ? `   🎯 Numéro prédit : #N${w.target} ${w.suit}` : `   🎯 Прогноз на номер: #N${w.target} ${w.suit}`);
      lines.push(fr ? `   ✅ Gagné${step} — ${when}` : `   ✅ Выигрыш${step} — ${when}`);
    });
  } else {
    lines.push(fr ? '🧪 Exemples : aucun suivi réussi pour le moment.' : '🧪 Примеры: успешных отслеживаний пока нет.');
  }
  return lines.join('\n');
}

// Retourne le texte à envoyer ; si ce canal n'est suivi par aucune
// configuration, un message de refus (français + russe).
function meriReply(chat) {
  const mine = panel.trackers.filter((c) => c.enabled && followsChat(c, chat));
  if (!mine.length) {
    return '⛔ Commande refusée : ce canal n\'est suivi par aucune configuration « Type de mise ». Sélectionnez-le dans « Créer » pour utiliser /meri.\n\n⛔ Команда отклонена: этот канал не отслеживается ни одной конфигурацией «Type de mise». Выберите его в разделе «Créer», чтобы использовать /meri.';
  }
  const withRes = mine.filter((c) => c.wins + c.losses > 0)
    .sort((a, b) => rateOf(b) - rateOf(a) || (b.wins + b.losses) - (a.wins + a.losses));
  const eligible = withRes.filter((c) => c.wins + c.losses >= panel.best.minSample);
  const pick = eligible[0] || withRes[0] || mine[0];
  const an = { compared: mine.length, withResults: withRes.length, ranking: withRes, reliable: eligible.length > 0 };
  return `${meriBlock(pick, 'fr', an)}\n\n━━━━━━━━━━\n\n${meriBlock(pick, 'ru', an)}`;
}

// Bilan périodique (par défaut toutes les heures) : taux de réussite de chaque
// configuration envoyé dans SON canal, et classement complet dans le canal du
// « meilleur type de mise ». Envoyé même sans changement, mais pas tant
// qu'aucun résultat n'existe.
function bilanText(c) {
  const total = c.wins + c.losses;
  return `📊 BILAN — ${c.name} (type ${c.type})\n\nTaux de réussite : ${rateOf(c)}%\n✅ ${c.wins} gagné(s) · ❌ ${c.losses} perdu(s) · ${total} résultat(s)`;
}

async function sendBilan() {
  const b = panel.best;
  let sentAny = false;
  const rank = ranking();
  if (!rank.length) return false;
  if (allBestChannels().length) {
    const best = bestConfig();
    const r = await sendTo(allBestChannels(), { text: ratesText(rank, best && best.id) });
    if (r.sent.length) sentAny = true; else if (r.errors.length) panel.lastError = r.errors[0];
  }
  for (const c of panel.trackers) {
    if (!c.enabled || (c.wins + c.losses) === 0 || !c.destChannels.length) continue;
    const r = await sendTo(c.destChannels, { text: bilanText(c) });
    if (r.sent.length) sentAny = true; else if (r.errors.length) panel.lastError = r.errors[0];
  }
  if (sentAny) { panel.sentCount += 1; panel.lastSentAt = Date.now(); }
  return sentAny;
}

async function bilanIfDue() {
  const b = panel.best;
  if (!b.bilanEnabled) return;
  const now = Date.now();
  if (!b.lastBilanAt) { b.lastBilanAt = now; return; } // premier passage : le délai démarre maintenant
  if (now - b.lastBilanAt < b.bilanEveryMin * 60000) return;
  b.lastBilanAt = now;
  await sendBilan();
}

setOnShoeReset(() => {
  for (const c of panel.trackers) for (const s of Object.keys(c.states || {})) {
    const old = c.states[s];
    c.states[s] = { ...emptyState(), seen: (old.seen || []).slice(-600) };
  }
  for (const entry of panel.pendingMessages) {
    if (entry.status !== 'en attente') continue;
    entry.status = 'annulé'; entry.resolvedAt = Date.now();
  }
  persist();
});

async function tick(opts = {}) {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    if (!opts.paused) {
      for (const cfg of panel.trackers) {
        if (!cfg.enabled) continue;
        try { await processConfig(cfg); } catch (e) { panel.lastError = e.message; }
      }
    }
    await verifyPending();
    await announceRates();
    if (!opts.paused) await bilanIfDue();
    panel.lastScanAt = Date.now();
  } catch (e) {
    panel.lastError = e.message;
  } finally {
    persist();
    busy = false;
  }
  return panel;
}

async function test(id) {
  const cfg = panel.trackers.find((c) => c.id === id);
  if (!cfg) return { ok: false, error: 'Configuration introuvable' };
  const { sent, errors } = await sendTo(cfg.destChannels, { text: `🎲 TYPE DE MISE — message de test\n\nConfiguration : ${cfg.name} (type ${cfg.type})` });
  return { ok: sent.length > 0, sent: sent.map((s) => String(s.chatId)), errors };
}

async function testBest() {
  if (!panel.best.channels.length) return { ok: false, error: 'Aucun canal configuré' };
  const preview = fmt.formatPreview(panel.best.format, { maxR: panel.best.maxR });
  const { sent, errors } = await sendTo(panel.best.channels, { text: `⭐ MEILLEUR TYPE DE MISE — message de test\n\nFormat ${panel.best.format} :\n\n${preview}` });
  return { ok: sent.length > 0, sent: sent.map((s) => String(s.chatId)), errors };
}

function setChannelTitle(id, title) {
  const key = String(id == null ? '' : id).trim();
  if (!key || !title) return;
  if (panel.channelTitles[key] === String(title).slice(0, 120)) return;
  panel.channelTitles[key] = String(title).slice(0, 120);
  persist();
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const saved = {
    config: { enabled: panel.enabled }, best: panel.best, trackers: panel.trackers,
    channelTitles: panel.channelTitles, sentCount: panel.sentCount, lastSentAt: panel.lastSentAt,
  };
  try { store.patch({ betType: saved }); } catch (_) {}
  if (db.ready) db.setSetting('bet_type_state', JSON.stringify(saved)).catch((error) => { panel.lastError = error.message; });
}

function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  if (saved.config) panel.enabled = saved.config.enabled !== false;
  if (saved.channelTitles && typeof saved.channelTitles === 'object') panel.channelTitles = { ...saved.channelTitles };
  if (saved.best && typeof saved.best === 'object') {
    const b = saved.best;
    panel.best = {
      enabled: b.enabled !== false, channels: parseChannels(b.channels), format: fmt.clampFormat(b.format),
      maxR: Math.max(0, Math.min(9, parseInt(b.maxR, 10) || 0)),
      minSample: Math.max(1, parseInt(b.minSample, 10) || 3), announceRates: b.announceRates !== false,
      bilanEnabled: b.bilanEnabled !== false, bilanEveryMin: Math.max(1, parseInt(b.bilanEveryMin, 10) || 60), lastBilanAt: b.lastBilanAt || null,
      sentCount: Number(b.sentCount) || 0, wins: Number(b.wins) || 0, losses: Number(b.losses) || 0,
      lastSnapshot: b.lastSnapshot || '', lastRatesAt: b.lastRatesAt || null,
    };
  }
  if (Array.isArray(saved.trackers)) {
    panel.trackers = saved.trackers.map((c) => {
      const sources = sanitizeSources(c.sources);
      const states = {};
      for (const s of sources) {
        const o = (c.states && c.states[s]) || {};
        // série / attente remises à zéro au redémarrage ; les prédictions déjà vues sont conservées
        states[s] = { ...emptyState(), seen: Array.isArray(o.seen) ? o.seen.slice(-600) : [] };
      }
      return {
        id: c.id || newId('bt'), name: c.name || 'Configuration', type: sanitizeType(c.type), sources,
        destChannels: parseChannels(c.destChannels), bestChannels: parseChannels(c.bestChannels), bestLink: sanitizeLink(c.bestLink), format: fmt.clampFormat(c.format),
        maxR: Math.max(0, Math.min(9, parseInt(c.maxR, 10) || 0)), enabled: c.enabled !== false, states,
        wins: Number(c.wins) || 0, losses: Number(c.losses) || 0, sentCount: Number(c.sentCount) || 0,
        lastSentAt: c.lastSentAt || null, lastWin: c.lastWin || null, lastWins: Array.isArray(c.lastWins) ? c.lastWins.slice(0, 3) : (c.lastWin ? [c.lastWin] : []), createdAt: c.createdAt || Date.now(),
      };
    });
  }
  if (Number.isFinite(Number(saved.sentCount))) panel.sentCount = Number(saved.sentCount);
  panel.lastSentAt = saved.lastSentAt || null;
}

function restore() {
  try { const saved = (store.read() || {}).betType; if (saved) applySaved(saved); } catch (_) {}
  return { enabled: panel.enabled };
}

async function restoreFromDb() {
  if (!db.ready) return { enabled: panel.enabled };
  try {
    const raw = await db.getSetting('bet_type_state');
    if (raw) applySaved(JSON.parse(raw)); else persist();
  } catch (_) { persist(); }
  return { enabled: panel.enabled };
}

// ---------------------------------------------------------------------------
// Vue pour le tableau de bord
// ---------------------------------------------------------------------------
function lastPredsFor(id, limit = 3) {
  return panel.pendingMessages
    .filter((e) => e.trackerId === id && e.scope === 'config')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit)
    .map((e) => ({ target: e.target, suit: e.suit, status: e.status, step: e.step }));
}

function statusView() {
  const best = bestConfig();
  return {
    enabled: panel.enabled,
    types: TYPES,
    // `channels` + `trackers[].channels` : lus par configuredChannelList() (server.js)
    channels: panel.best.channels,
    channelTitles: panel.channelTitles,
    trackers: panel.trackers.map((c) => ({
      id: c.id, name: c.name, type: c.type, sources: c.sources, channels: [...c.destChannels, ...(c.bestChannels || [])], destChannels: c.destChannels, bestChannels: c.bestChannels || [], bestLink: c.bestLink || '',
      format: c.format, maxR: c.maxR, enabled: c.enabled,
      wins: c.wins, losses: c.losses, rate: rateOf(c), sentCount: c.sentCount, lastSentAt: c.lastSentAt, lastWin: c.lastWin || null, lastWins: c.lastWins || [],
      isBest: !!(best && best.id === c.id), lastPreds: lastPredsFor(c.id),
      progress: Object.fromEntries(c.sources.map((s) => {
        const st = c.states[s] || emptyState();
        return [s, { streakSuit: st.streakSuit, streakCount: st.streakCount, waitingSuit: st.waitingSuit, armed: st.armed, lossCount: st.lossCount }];
      })),
      createdAt: c.createdAt,
    })),
    best: {
      ...panel.best, lastSnapshot: undefined,
      rate: (panel.best.wins + panel.best.losses) ? Math.round((panel.best.wins / (panel.best.wins + panel.best.losses)) * 1000) / 10 : null,
      current: best,
    },
    ranking: ranking(),
    history: panel.history.slice(0, 30),
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt, lastError: panel.lastError,
  };
}

module.exports = {
  panel, setSender, tick, test, testBest, sendBilan, meriReply, status: statusView,
  configure, configureBest, addConfig, updateConfig, removeConfig,
  restore, restoreFromDb, parseChannels, setChannelTitle,
};

// exposé pour l'effacement de minuit (midnight-reset.js)
module.exports.persist = persist;
