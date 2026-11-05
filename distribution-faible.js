// distribution-faible.js — « Distribution faible » (v125, demande admin), stratégie du bouton Stratégies branchée sur le « Compte distribution ».
//
// Le « Compte distribution » (distribution-counter.js) affiche, depuis son dernier reset, une ligne par fin de numéro
// (« #520 ➔ (3/3 50%) (2/2 25%) (2/3 25%) (3/2 0%) · 2k 50% · 3k 50% ») puis un RÉSUMÉ DISTRIBUTION
// (« 2/2 : 13 · 3/2 : 10 · 3/3 : 18 · 2/3 : 5 | 2k : 18 (39%) · 3k : 28 (61%) »).
//
// Cette stratégie lit le RÉSUMÉ en direct et prédit la distribution au taux le plus FAIBLE.
//
// Distributions prédites : 2/2, 3/2, 3/3, 2k, 3k. Jamais 2/3 (elle reste affichée par le compteur mais n'est ni prédite ni
// prise en compte comme « plus faible »).
//   2k = le joueur a 2 cartes (2/2 + 2/3) ; 3k = le joueur a 3 cartes (3/2 + 3/3).
//
// Une prédiction part SI ET SEULEMENT SI :
//   • au moins 15 jeux sont cumulés depuis le dernier reset du compteur (réglable, 15 par défaut) ;
//   • la distribution au taux le plus faible du RÉSUMÉ est SEULE à ce taux (égalité en bas = pas de prédiction) ;
//   • son taux est compris entre 3 % et 15 % (bornes incluses, pourcentages entiers comme dans le message) ;
//   • aucune distribution de la LIGNE de la fin du jeu visé (#52x) n'affiche ce même taux.
//
// Enchaînement : UNE prédiction à la fois. La suivante n'est envoyée qu'une fois la précédente VÉRIFIÉE, et l'écart avec la dernière
// prédiction est d'au moins 2 numéros (jamais deux numéros consécutifs). Un jeu déjà commencé n'est jamais prédit.
// Vérification : jeu N puis rattrapages N+1 … N+maxR (3 par défaut) ; gagnée dès que la distribution voulue sort (jeu terminé).
'use strict';
const strategyRecap = require('./strategy-recap');

const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const loss = require('./loss-return'); // liste d'ID de canaux (parseChannels)
const distCounter = require('./distribution-counter');
const { state, setOnShoeReset } = require('./predictor');

const DB_KEY = 'distribution_faible_state';
const STORE_KEY = 'distributionFaible';
const LABELS = ['2/2', '3/2', '3/3', '2k', '3k']; // 2/3 n'est JAMAIS prédite
const ALL_LABELS = ['2/2', '3/2', '3/3', '2/3', '2k', '3k'];
const FORMATS = [78, 79, 102, 103, 104, 105, 106]; // formats « distribution » (tg-formats : texte du type « Il y aura distribution 2/2 »)
const DEF = { maxR: 3, lead: 1, minGames: 15, lowMin: 3, lowMax: 15, minGap: 2, format: 102 };
const SENT_RESOLVED_MAX = 100;
const SEND_MAX_MS = 20000, TICK_MAX_MS = 90000, PENDING_MAX_MS = 20 * 60 * 1000, STALE_AHEAD = 60;

const panel = {
  enabled: false, channels: [], format: DEF.format, formats: {}, maxR: DEF.maxR, lead: DEF.lead, minGames: DEF.minGames, lowMin: DEF.lowMin, lowMax: DEF.lowMax, minGap: DEF.minGap,
  cursor: 0,            // plus petit numéro de jeu que la prochaine prédiction a le droit de viser
  lastTarget: null,     // numéro visé par la dernière prédiction envoyée (écart minimum entre deux prédictions)
  pendingMessages: [],  // prédictions envoyées (en attente puis résolues)
  stats: null, sentCount: 0, lastSentAt: null, duplicatesBlocked: 0, lastError: null, channelTitles: {},
};
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
const bot = () => (typeof sender === 'function' ? sender() : null);
const withTimeout = (p, ms, label) => { let t; const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} : délai de ${Math.round(ms / 1000)} s dépassé`)), ms); }); return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t)); };

const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const clampFormat = (v) => { const n = parseInt(v, 10); return FORMATS.includes(n) ? n : DEF.format; };
const FORMAT_LABELS = ['2/2', '3/3', '3/2']; // distributions qui ont leur propre format (2k et 3k suivent le format par défaut)
// format d'une distribution : le sien s'il est réglé, sinon le format par défaut
const formatFor = (label) => { const n = parseInt((panel.formats || {})[label], 10); return FORMATS.includes(n) ? n : panel.format; };
function cleanFormats(o) { const r = {}; if (o && typeof o === 'object') for (const k of FORMAT_LABELS) { const n = parseInt(o[k], 10); if (FORMATS.includes(n)) r[k] = n; } return r; }
const maxFinishedGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; };
const maxKnownGameNumber = () => { let m = 0; for (const g of state.games.values()) if ((g.finished || g.dealing) && g.number > m) m = g.number; return m; };
const hasPlayerCards = (g) => !!g && Array.isArray(g.player) && g.player.length > 0;
// jeu terminé ET distribution connue (nombre de cartes joueur / banquier)
const isDone = (g) => !!g && g.finished && g.complete !== false && Number.isFinite(Number(g.playerCards)) && Number.isFinite(Number(g.bankerCards));
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const emptyStats = () => ({ sent: 0, won: 0, lost: 0, byStep: {} });
const statsOf = () => { panel.stats = panel.stats && typeof panel.stats === 'object' ? { ...emptyStats(), ...panel.stats } : emptyStats(); return panel.stats; };

// la distribution voulue est-elle sortie dans ce jeu terminé ?
function hit(label, g) {
  const p = Number(g.playerCards), b = Number(g.bankerCards);
  if (label === '2k') return p === 2;
  if (label === '3k') return p === 3;
  return `${p}/${b}` === label;
}

// ── décision ───────────────────────────────────────────────────────────────
const ratesOf = (counts, total) => { const o = {}; for (const k of ALL_LABELS) o[k] = pct(counts[k] || 0, total); return o; };
// target : numéro du jeu visé (pour la ligne de sa fin) ; null = aperçu sans ligne
// renvoie { pick: { label, pct } } ou { reason }
function decide(target) {
  const s = distCounter.summary('player');
  const base = { games: s.games, all: s.all };
  if (!s.all || s.games < panel.minGames) return { ...base, reason: `moins de ${panel.minGames} jeux cumulés (${s.games})` };
  const rates = ratesOf(s.counts, s.all);
  const ranked = LABELS.map((k) => ({ k, pct: rates[k] }));
  const min = Math.min(...ranked.map((r) => r.pct));
  const lows = ranked.filter((r) => r.pct === min);
  if (lows.length > 1) return { ...base, reason: `égalité au plus faible taux (${lows.map((r) => r.k).join(' = ')} à ${min} %)` };
  const low = lows[0];
  if (low.pct < panel.lowMin || low.pct > panel.lowMax) return { ...base, reason: `taux faible ${low.k} à ${low.pct} %, hors de ${panel.lowMin}–${panel.lowMax} %` };
  if (target != null && Number.isInteger(Number(target))) {
    const d = ((Number(target) % 10) + 10) % 10;
    const row = s.rows[d];
    if (row && row.total) {
      const lr = ratesOf(row.counts, row.total);
      const clash = ALL_LABELS.find((k) => lr[k] === low.pct);
      if (clash) return { ...base, reason: `la fin ${d} a déjà ${clash} à ${low.pct} %` };
    }
  }
  return { ...base, pick: { label: low.k, pct: low.pct } };
}

// ── envoi / édition ────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, { gameNumber: entry.target, suit: null, cardsLabel: entry.label, strategy: 'Distribution faible', maxR: entry.maxR, status: statusFr, rattrapage: entry.step || 0 }, null);
}
async function sendToChannels(out) {
  const b = bot();
  if (!b) { panel.lastError = 'Aucun token Telegram configuré'; return []; }
  const results = await Promise.all((panel.channels || []).map((id) => withTimeout(b.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {}), SEND_MAX_MS, 'envoi Telegram')
    .then((m) => (m && m.skipped ? { ok: false, skipped: true, id } : { ok: true, id, messageId: m.message_id }))
    .catch((e) => ({ ok: false, id, error: e.message }))));
  const sent = [];
  for (const r of results) { if (r.ok) sent.push({ chatId: r.id, messageId: r.messageId }); else if (!r.skipped) panel.lastError = `${r.id} : ${r.error}`; }
  return sent;
}
function editSent(entry, statusFr) {
  const b = bot(); if (!b) return;
  const out = renderFor(entry, statusFr);
  for (const m of entry.messages || []) {
    Promise.resolve().then(() => withTimeout(b.editMessageText(out.text, { chat_id: m.chatId, message_id: m.messageId, ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}) }), SEND_MAX_MS, 'édition Telegram'))
      .then(() => { entry.editFail = null; })
      .catch((e) => {
        const msg = String((e && e.message) || e);
        if (/message is not modified/i.test(msg)) { entry.editFail = null; return; }
        if (/not found|can't be edited|chat not found|kicked|not a member|forbidden|blocked/i.test(msg)) return;
        entry.editTries = (Number(entry.editTries) || 0) + 1;
        if (entry.editTries <= 20) entry.editFail = Date.now();
      });
  }
}

// un jeu déjà commencé n'est jamais prédit ; le jeu en direct ne doit pas dépasser le numéro visé
function canTarget(target) {
  if (maxKnownGameNumber() > target) return false;
  return !hasPlayerCards(state.games.get(target));
}
const inflight = new Set();
const DUP_WINDOW_MS = 2 * 3600 * 1000;
const isDuplicate = (target, label) => panel.pendingMessages.some((s) => s.target === target && s.label === label && (s.status === 'en attente' || Date.now() - (Number(s.createdAt) || 0) < DUP_WINDOW_MS));
async function launch(target, label, lowPct) {
  if (!panel.channels.length) return false;
  if (!canTarget(target)) return false;
  const key = `${target}:${label}`;
  if (isDuplicate(target, label) || inflight.has(key)) { panel.duplicatesBlocked += 1; return false; }
  inflight.add(key);
  try {
    const entry = { id: `df-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: 'distribution-faible', label, target, pct: lowPct, maxR: panel.maxR, format: formatFor(label), step: 0, status: 'en attente', messages: [], createdAt: Date.now(), resolvedAt: null };
    entry.messages = await sendToChannels(renderFor(entry, null));
    if (!entry.messages.length) return false;
    panel.pendingMessages.push(entry);
    panel.lastTarget = target;
    const st = statsOf(); st.sent += 1; panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null;
    return true;
  } finally { inflight.delete(key); }
}

// ── nouveau sabot (le jeu repart à #1 à 00h00) ─────────────────────────────
function rebaseForNewShoe() {
  let changed = false;
  for (const s of panel.pendingMessages) if (s.status === 'en attente') { s.status = 'annulé'; s.resolvedAt = Date.now(); changed = true; }
  if (panel.cursor) { panel.cursor = 0; changed = true; }
  if (panel.lastTarget != null) { panel.lastTarget = null; changed = true; }
  inflight.clear();
  if (changed) persist();
  return changed;
}
setOnShoeReset(() => { try { rebaseForNewShoe(); } catch (e) { panel.lastError = e.message; } });

// prochain numéro qu'une prédiction peut viser : jamais un jeu commencé, après le curseur, écart minimum avec la dernière prédiction
function nextTargetNumber(known) {
  const gapFloor = panel.lastTarget != null ? panel.lastTarget + panel.minGap : 0;
  return Math.max(Number(panel.cursor) || 0, known + panel.lead, gapFloor);
}

// ── cycle (appelé à chaque passage du bot) ─────────────────────────────────
let ticking = false, tickStartedAt = 0, tickSeq = 0;
async function tick() {
  if (ticking) {
    if (Date.now() - tickStartedAt < TICK_MAX_MS) return;
    panel.lastError = 'passage bloqué : reprise forcée'; inflight.clear();
  }
  ticking = true; tickStartedAt = Date.now(); const myTick = ++tickSeq;
  try {
    let changed = false;
    const knownNow = maxKnownGameNumber();
    if (knownNow) {
      const stalePending = panel.pendingMessages.some((s) => s.status === 'en attente' && s.target > knownNow + STALE_AHEAD);
      if (stalePending || (Number(panel.cursor) || 0) > knownNow + STALE_AHEAD || (panel.lastTarget != null && panel.lastTarget > knownNow + STALE_AHEAD)) { rebaseForNewShoe(); changed = true; }
    }
    for (const s of panel.pendingMessages) if (s.status === 'en attente' && Date.now() - (Number(s.createdAt) || 0) > PENDING_MAX_MS) { s.status = 'annulé'; s.resolvedAt = Date.now(); changed = true; }
    const maxDone = maxFinishedGameNumber();
    // 1) résultat des prédictions envoyées (jeu N puis rattrapages N+1 … N+maxR) + enchaînement
    if (maxDone) {
      const verdictOf = (e) => {
        let verdict = null; let hitAt = -1;
        for (let k = 0; k <= e.maxR; k++) {
          const g = state.games.get(e.target + k);
          if (!isDone(g)) { if (e.target + k + 2 <= maxDone) verdict = 'annulé'; break; } // jeu manquant alors que les suivants sont finis
          if (hit(e.label, g)) { verdict = 'gagné'; hitAt = k; break; }
          if (k === e.maxR) verdict = 'perdu';
          else if ((e.step || 0) < k + 1) { e.step = k + 1; changed = true; if (e.messages) editSent(e, null); }
        }
        return verdict ? { verdict, hitAt } : null;
      };
      for (const s of panel.pendingMessages) {
        if (s.status !== 'en attente') continue;
        const r = verdictOf(s); if (!r) continue;
        changed = true; s.status = r.verdict; s.resolvedAt = Date.now();
        if (r.verdict === 'gagné') s.step = r.hitAt;
        if (r.verdict === 'annulé') continue;
        // jamais deux numéros consécutifs : le curseur est au moins à N + écart minimum ; il dépasse aussi le dernier jeu utilisé (N + rattrapage)
        const lastUsed = s.target + (r.verdict === 'gagné' ? r.hitAt : s.maxR);
        panel.cursor = Math.max(Number(panel.cursor) || 0, lastUsed + 1, s.target + panel.minGap);
        strategyRecap.noteEntry(s);
        editSent(s, r.verdict);
        const st = statsOf();
        if (r.verdict === 'gagné') { st.won += 1; st.byStep[s.step] = (st.byStep[s.step] || 0) + 1; } else { st.lost += 1; }
      }
      for (const s of panel.pendingMessages) {
        if (!s.editFail || Date.now() - s.editFail < 8000) continue;
        s.editFail = null;
        if (s.status === 'gagné' || s.status === 'perdu') editSent(s, s.status); else if (s.status === 'en attente') editSent(s, null);
      }
    }
    // 2) nouvelle prédiction : UNE à la fois, seulement quand la précédente est vérifiée
    if (panel.enabled && panel.channels.length && !panel.pendingMessages.some((s) => s.status === 'en attente')) {
      const known = maxKnownGameNumber();
      if (known) {
        const target = nextTargetNumber(known);
        const d = decide(target);
        if (d.pick && await launch(target, d.pick.label, d.pick.pct)) changed = true;
        // pas de décision favorable pour ce numéro : on réessaie au jeu suivant
      }
    }
    const before = panel.pendingMessages.length;
    panel.pendingMessages = [...panel.pendingMessages.filter((s) => s.status !== 'en attente').slice(-SENT_RESOLVED_MAX), ...panel.pendingMessages.filter((s) => s.status === 'en attente')];
    if (changed || panel.pendingMessages.length !== before) persist();
  } catch (e) { panel.lastError = e.message; }
  finally { if (tickSeq === myTick) ticking = false; }
}

// ── réglages ───────────────────────────────────────────────────────────────
function config_() { return { enabled: panel.enabled, channels: [...panel.channels], format: panel.format, formats: { ...panel.formats }, maxR: panel.maxR, lead: panel.lead, minGames: panel.minGames, lowMin: panel.lowMin, lowMax: panel.lowMax, minGap: panel.minGap }; }
function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = loss.parseChannels(patch.channels);
  if (patch.format !== undefined) panel.format = clampFormat(patch.format);
  if (patch.formats !== undefined) panel.formats = cleanFormats(patch.formats);
  if (patch.maxR !== undefined) panel.maxR = clampInt(patch.maxR, 0, 9, DEF.maxR);
  if (patch.lead !== undefined) panel.lead = clampInt(patch.lead, 1, 20, DEF.lead);
  if (patch.minGames !== undefined) panel.minGames = clampInt(patch.minGames, 1, 5000, DEF.minGames);
  if (patch.lowMin !== undefined) panel.lowMin = clampInt(patch.lowMin, 0, 100, DEF.lowMin);
  if (patch.lowMax !== undefined) panel.lowMax = clampInt(patch.lowMax, 0, 100, DEF.lowMax);
  if (panel.lowMax < panel.lowMin) { const x = panel.lowMin; panel.lowMin = panel.lowMax; panel.lowMax = x; }
  if (patch.minGap !== undefined) panel.minGap = clampInt(patch.minGap, 1, 20, DEF.minGap);
  persist();
  return config_();
}
function unblockAll() {
  let n = 0;
  for (const s of panel.pendingMessages) if (s.status === 'en attente') { s.status = 'annulé'; s.resolvedAt = Date.now(); n += 1; }
  panel.cursor = 0; panel.lastTarget = null; inflight.clear(); panel.lastError = null;
  return n;
}
function unblock() { const n = unblockAll(); persist(); return n; }
function resetStats() { panel.stats = emptyStats(); unblockAll(); persist(); }
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }

async function test() {
  if (!panel.channels.length) return { ok: false, error: 'Renseigne le canal où envoyer les prédictions.' };
  let sent = [];
  for (const label of FORMAT_LABELS) {
    const out = renderFor({ format: formatFor(label), target: 1234, label, maxR: panel.maxR, step: 0 }, null);
    sent = sent.concat(await sendToChannels({ ...out, text: `🧪 Test ${label}\n${out.text}` }));
  }
  return sent.length ? { ok: true, sent: sent.map((m) => m.chatId) } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

function status() {
  const st = statsOf(); const resolved = st.won + st.lost;
  const known = maxKnownGameNumber();
  const waiting = panel.pendingMessages.filter((s) => s.status === 'en attente');
  const nextTarget = known ? nextTargetNumber(known) : null;
  const s = distCounter.summary('player');
  const rates = ratesOf(s.counts, s.all);
  const d = decide(nextTarget);
  return {
    ...config_(), previews: Object.fromEntries(FORMAT_LABELS.map((k) => { let p = ''; try { p = fmt.formatPreview(formatFor(k), { cardsLabel: k, gameNumber: 1234, maxR: panel.maxR, status: null }); } catch (_) {} return [k, { format: formatFor(k), text: p }]; })), nextTarget, cursor: panel.cursor || 0, lastTarget: panel.lastTarget,
    games: s.games, all: s.all,
    rates: ALL_LABELS.map((k) => ({ label: k, count: s.counts[k] || 0, pct: rates[k], predicted: LABELS.includes(k) })),
    decision: d.pick ? { pick: d.pick.label, pct: d.pick.pct, reason: '' } : { pick: null, pct: null, reason: d.reason || '' },
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, duplicatesBlocked: panel.duplicatesBlocked, won: st.won, lost: st.lost, resolved, rate: pct(st.won, resolved),
    steps: Object.entries(st.byStep || {}).map(([k, n]) => ({ step: Number(k), n: Number(n) })).sort((a, b) => a.step - b.step),
    waiting: waiting.length,
    recent: panel.pendingMessages.slice(-12).reverse().map((e) => ({ target: e.target, label: e.label, pct: e.pct, status: e.status, step: e.step, maxR: e.maxR })),
    channelNames: panel.channels.map((id) => panel.channelTitles[String(id)] || String(id)), lastError: panel.lastError,
  };
}

// ── persistance ────────────────────────────────────────────────────────────
function persist() {
  const saved = { config: config_(), cursor: panel.cursor, lastTarget: panel.lastTarget, pendingMessages: panel.pendingMessages, stats: panel.stats, sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, channelTitles: panel.channelTitles };
  try { store.patch({ [STORE_KEY]: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  const c = saved.config || {};
  panel.enabled = c.enabled === true; panel.channels = loss.parseChannels(c.channels);
  panel.format = clampFormat(c.format); panel.formats = cleanFormats(c.formats); panel.maxR = clampInt(c.maxR, 0, 9, DEF.maxR); panel.lead = clampInt(c.lead, 1, 20, DEF.lead);
  panel.minGames = clampInt(c.minGames, 1, 5000, DEF.minGames); panel.lowMin = clampInt(c.lowMin, 0, 100, DEF.lowMin); panel.lowMax = clampInt(c.lowMax, 0, 100, DEF.lowMax);
  panel.minGap = clampInt(c.minGap, 1, 20, DEF.minGap);
  panel.cursor = Number(saved.cursor) || 0; panel.lastTarget = saved.lastTarget != null ? Number(saved.lastTarget) || null : null;
  panel.pendingMessages = Array.isArray(saved.pendingMessages) ? saved.pendingMessages.filter((s) => s && s.id).slice(-(SENT_RESOLVED_MAX + 50)) : [];
  panel.stats = saved.stats && typeof saved.stats === 'object' ? saved.stats : null;
  panel.sentCount = Number(saved.sentCount) || 0; panel.lastSentAt = saved.lastSentAt || null;
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
  unblockAll(); // au redémarrage, rien ne reste bloqué « en attente »
}
function restore() { try { const s = (store.read() || {})[STORE_KEY]; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting(DB_KEY); if (raw) { applySaved(JSON.parse(raw)); persist(); } else persist(); } catch (_) { persist(); }
}

module.exports = { panel, setSender, restore, restoreFromDb, persist, tick, status, test, config: config_, configure, resetStats, unblock, setChannelTitle, decide, hit };
