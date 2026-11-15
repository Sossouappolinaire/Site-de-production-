// confirmation.js — bouton « Confirmation » (v140, demande admin) :
//
//  • On crée une configuration depuis le bouton de l'accueil : « Créer » ouvre la liste des canaux qui ont 3 ou 4 rattrapages ;
//    on en COCHE un ou plusieurs (ce sont les canaux SUIVIS), puis on choisit l'autre canal où le bot enverra ses prédictions.
//  • Le bot OBSERVE les prédictions des canaux cochés (N° de jeu + costume) et les vérifie lui-même sur la main du JOUEUR, avec le
//    nombre de rattrapages du canal suivi (N, N+1 … N+R). Costume jamais sorti → prédiction PERDUE.
//  • DÉCLENCHEUR : une PERTE, ou une prédiction GAGNÉE à un rattrapage ÉGAL OU SUPÉRIEUR au rattrapage déclencheur (réglable, 4 par défaut ;
//    v144 : réglé à 3 → ✅3️⃣, ✅4️⃣, ✅5️⃣ … jusqu'au dernier rattrapage du canal suivi, et la perte, déclenchent).
//  • ACTION : le bot prédit alors la PROCHAINE PRÉDICTION DU CANAL : la première prédiction publiée par ce canal après le déclencheur
//    (ou déjà publiée mais pas encore jouée) est envoyée dans l'autre canal, avec le format choisi et les mêmes rattrapages que le
//    canal suivi. Le message est ensuite vérifié et édité (✅ / ❌), comme pour « Relance après perte ».
//  • Un déclencheur = une prédiction suivante envoyée. Jamais deux messages pour le même jeu et le même costume ; jamais pour un jeu
//    déjà joué (dans ce cas on attend la publication suivante du canal).
//  • Toujours sur la main du JOUEUR (hasSuit), jamais le banquier.
'use strict';

const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const loss = require('./loss-return'); // lecture d'une publication de canal (parsePost) et liste d'ID (parseChannels)
const strategyRecap = require('./strategy-recap');
const { state, hasSuit } = require('./predictor');

const SUITS = ['♠️', '❤️', '♦️', '♣️'];
const DEFAULT_TRIGGER_STEP = 4;  // rattrapage à partir duquel un gain déclenche (en plus de la perte)
const DEFAULT_SRC_MAXR = 4;      // rattrapages du canal suivi si rien n'est réglé
const DB_KEY = 'confirmation_state';
const SEEN_MAX = 1500;
const PENDING_MAX = 400;
const SENT_RESOLVED_MAX = 100;

const panel = { configs: [], pending: [], pendingMessages: [], seen: [], armed: {}, channelTitles: {}, lastError: null, duplicatesBlocked: 0 };
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
const bot = () => (typeof sender === 'function' ? sender() : null);

// ── utilitaires ─────────────────────────────────────────────────────────────
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const parseChannels = loss.parseChannels;
const sanitizeName = (v) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, 60);
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const isDone = (g) => !!g && g.finished && g.complete !== false;
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
// Après deux cartes le joueur tire à 0–5 et s'arrête à 6–9 ; une troisième carte confirme aussi que sa main est terminée.
function isPlayerHandComplete(g) {
  if (!g || g.complete === false) return false;
  const count = g.playerCards !== null && g.playerCards !== undefined && Number.isFinite(Number(g.playerCards))
    ? Number(g.playerCards)
    : (Array.isArray(g.player) ? g.player.length : 0);
  if (count < 2) return false;
  if (g.finished) return true;
  if (count >= 3) return true;
  if (count !== 2 || g.playerValue === null || g.playerValue === undefined || g.playerValue === '') return false;
  const total = Number(g.playerValue);
  return Number.isFinite(total) && total >= 6;
}
const maxFinishedGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; };
// « jeu déjà joué » = terminé OU déjà distribué (cartes visibles)
const maxKnownGameNumber = () => { let m = 0; for (const g of state.games.values()) if ((g.finished || g.dealing) && g.number > m) m = g.number; return m; };
const emptyStats = () => ({ sent: 0, won: 0, lost: 0, byStep: {}, bySuit: {}, byReason: {} });
function statsOf(cfg) { cfg.stats = cfg.stats && typeof cfg.stats === 'object' ? cfg.stats : emptyStats(); return cfg.stats; }
// rattrapages d'un canal suivi : celui réglé pour CE canal, sinon celui commun, sinon 4
const chanMaxR = (cfg, key) => { const m = key != null && cfg.srcMaxRBy ? cfg.srcMaxRBy[String(key)] : null; return isNum(m) ? Number(m) : (isNum(cfg.srcMaxR) ? Number(cfg.srcMaxR) : DEFAULT_SRC_MAXR); };
const reasonLabel = (r) => (r === 'perte' ? 'perte' : String(r || ''));

// ── observation : publications de canal ─────────────────────────────────────
// appelé par le bot pour chaque NOUVELLE publication de canal (les modifications — résultats ajoutés — sont ignorées :
// c'est ce module qui vérifie lui-même les résultats sur les jeux réels)
function onChannelPost(chat, text) {
  try {
    if (!chat || chat.id == null) return false;
    const post = loss.parsePost(text);
    if (!post) return false;
    const src = String(chat.id);
    const uname = chat.username ? `@${String(chat.username).toLowerCase()}` : null;
    let changed = false;
    for (const cfg of panel.configs.filter((c) => c.enabled)) {
      const matches = (cfg.sources || []).some((s) => String(s) === src || (uname && String(s).toLowerCase() === uname));
      if (!matches) continue;
      const srcKey = (cfg.sources || []).find((s) => String(s) === src || (uname && String(s).toLowerCase() === uname));
      if ((cfg.channels || []).map(String).includes(src)) continue; // ne jamais suivre son propre canal d'envoi
      if (cfg.keyword && !String(text).toLowerCase().includes(cfg.keyword.toLowerCase())) continue; // filtre facultatif
      if (chat.title) panel.channelTitles[src] = String(chat.title).slice(0, 120);
      for (const suit of post.suits) {
        const key = `${cfg.id}:${src}:${post.target}:${suit}`;
        if (panel.seen.includes(key)) continue;
        if (panel.pending.some((e) => e.cfgId === cfg.id && e.src === src && e.suit === suit && e.target === post.target)) continue;
        panel.seen.push(key); if (panel.seen.length > SEEN_MAX) panel.seen = panel.seen.slice(-SEEN_MAX);
        panel.pending.push({ id: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: cfg.id, src, srcKey: srcKey == null ? src : String(srcKey), suit, target: post.target, status: 'en attente', phase: 'verif', at: Date.now() });
        changed = true;
      }
      // un déclencheur attend la prochaine prédiction de ce canal : c'est elle (si le jeu n'est pas déjà joué)
      const ak = `${cfg.id}:${src}`;
      const arm = panel.armed[ak];
      if (arm && post.target > arm.fromTarget) {
        if (post.target > maxKnownGameNumber()) {
          delete panel.armed[ak]; changed = true;
          const items = panel.pending.filter((x) => x.cfgId === cfg.id && x.src === src && x.target === post.target && !x.forwarded);
          Promise.all(items.map((x) => forwardEntry(cfg, x, arm.reason).catch((err) => { panel.lastError = err.message; }))).then(() => persist());
        } else { cfg.lateSkipped = (cfg.lateSkipped || 0) + 1; changed = true; } // jeu déjà joué : on attend la publication suivante
      }
    }
    if (panel.pending.length > PENDING_MAX) panel.pending = panel.pending.slice(-PENDING_MAX);
    if (changed) persist();
    return changed;
  } catch (e) { panel.lastError = e.message; return false; }
}
// message envoyé par le bot lui-même (point d'envoi unique de bot.js) : même lecture que pour une publication de canal
function onOwnPost(chatId, text) { return onChannelPost({ id: chatId }, text); }

// ── envoi / édition ─────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, {
    gameNumber: entry.target, suit: entry.suit, strategy: entry.strategyName || 'Confirmation', maxR: entry.maxR,
    status: statusFr, rattrapage: entry.step || 0,
  }, null);
}
async function sendToChannels(cfg, out) {
  const b = bot();
  if (!b) { panel.lastError = 'Aucun token Telegram configuré'; return []; }
  const results = await Promise.all((cfg.channels || []).map((id) => b.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {})
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
    Promise.resolve().then(() => b.editMessageText(out.text, { chat_id: m.chatId, message_id: m.messageId, ...(out.parse_mode ? { parse_mode: out.parse_mode } : {}) }))
      .then(() => { entry.editFail = null; })
      .catch((e) => { // échec temporaire (limite Telegram, réseau) : retenté au tour suivant ; message supprimé / bot retiré : on abandonne
        const msg = String((e && e.message) || e);
        if (/message is not modified/i.test(msg)) { entry.editFail = null; return; }
        if (/not found|can't be edited|chat not found|kicked|not a member|forbidden|blocked/i.test(msg)) return;
        entry.editTries = (Number(entry.editTries) || 0) + 1;
        if (entry.editTries <= 20) entry.editFail = Date.now();
      });
  }
}

const inflight = new Set();
// Envoie dans l'autre canal la prédiction suivante du canal suivi (e = prédiction suivie, déjà publiée par le canal).
async function forwardEntry(cfg, e, reason) {
  e.forwarded = true; // posé tout de suite : un même suivi n'est jamais transmis deux fois
  e.forwardReason = reasonLabel(reason);
  const dedupe = `${cfg.id}:${e.target}:${e.suit}`;
  if (inflight.has(dedupe) || panel.pendingMessages.some((s) => s.cfgId === cfg.id && s.target === e.target && s.suit === e.suit)) {
    e.launch = 'doublon ignoré'; panel.duplicatesBlocked += 1; return false;
  }
  if (e.target <= maxKnownGameNumber()) { e.launch = 'trop tard (jeu déjà joué)'; cfg.lateSkipped = (cfg.lateSkipped || 0) + 1; return false; }
  inflight.add(dedupe);
  try {
    const R = chanMaxR(cfg, e.srcKey != null ? e.srcKey : e.src);
    const entry = { id: `cfs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: cfg.id, suit: e.suit, target: e.target, maxR: R, format: cfg.format, step: 0,
      strategyName: cfg.name || 'Confirmation', status: 'en attente', messages: [], origin: { src: e.src, reason: reasonLabel(reason) }, createdAt: Date.now(), resolvedAt: null };
    entry.messages = await sendToChannels(cfg, renderFor(entry, null));
    if (!entry.messages.length) { e.launch = 'non envoyé'; return false; }
    panel.pendingMessages.push(entry);
    const st = statsOf(cfg); st.sent += 1; cfg.sentCount = (cfg.sentCount || 0) + 1; cfg.lastSentAt = Date.now(); panel.lastError = null;
    const rk = reasonLabel(reason); st.byReason[rk] = (st.byReason[rk] || 0) + 1;
    e.launch = `envoyé N°${e.target}`;
    return true;
  } finally { inflight.delete(dedupe); }
}

// Déclencheur constaté sur la prédiction suivie e (perte ou gagnée au rattrapage déclencheur).
async function trigger(cfg, e, reason) {
  e.trigger = reasonLabel(reason);
  cfg.triggers = (cfg.triggers || 0) + 1;
  // la prochaine prédiction du canal est peut-être déjà publiée (et pas encore jouée) : on la transmet tout de suite
  const known = maxKnownGameNumber();
  const later = panel.pending.filter((x) => x.cfgId === cfg.id && x.src === e.src && x.phase === 'verif' && !x.forwarded && x.target > e.target && x.target > known);
  if (later.length) {
    const first = Math.min(...later.map((x) => x.target));
    for (const x of later.filter((y) => y.target === first)) await forwardEntry(cfg, x, reason);
    return;
  }
  panel.armed[`${cfg.id}:${e.src}`] = { reason: reasonLabel(reason), fromTarget: e.target, at: Date.now() }; // sinon : on attend sa prochaine publication
}

// ── vérification (appelée à chaque cycle du bot) ────────────────────────────
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const maxDone = maxFinishedGameNumber();
    if (!maxDone) return;
    let changed = false;
    // 1) prédictions SUIVIES : gagnée / perdue / annulée ; une perte ou un ✅ au rattrapage déclencheur lance la confirmation
    for (const e of panel.pending) {
      if (e.phase !== 'verif') continue;
      const cfg = panel.configs.find((c) => c.id === e.cfgId);
      if (!cfg) { e.phase = 'clos'; e.status = 'annulé'; changed = true; continue; }
      const R = chanMaxR(cfg, e.srcKey != null ? e.srcKey : e.src);
      let verdict = null; let hitAt = -1;
      for (let k = 0; k <= R; k++) {
        const g = state.games.get(e.target + k);
        if (!isPlayerHandComplete(g)) { if (e.target + k + 2 <= maxDone) verdict = 'annulé'; break; } // joueur pas encore arrivé à la fin de sa main
        if (hasSuit(g, e.suit)) { verdict = 'gagné'; hitAt = k; break; }
        if (k === R) verdict = 'perdu';
      }
      if (!verdict) continue;
      changed = true; e.phase = 'clos'; e.status = verdict; e.closedAt = Date.now(); e.hitAt = hitAt >= 0 ? hitAt : null;
      const fire = verdict === 'perdu' ? 'perte' : (verdict === 'gagné' && hitAt >= cfg.triggerStep ? `rattrapage ${hitAt}` : null);
      if (fire) { try { await trigger(cfg, e, fire); } catch (err) { panel.lastError = err.message; e.launch = 'erreur'; } }
    }
    // 2) prédictions ENVOYÉES : rattrapages, résultat, édition du message
    for (const s of panel.pendingMessages) {
      if (s.status !== 'en attente') continue;
      const cfg = panel.configs.find((c) => c.id === s.cfgId);
      let verdict = null; let hitAt = -1;
      for (let k = 0; k <= s.maxR; k++) {
        const g = state.games.get(s.target + k);
        if (!isDone(g)) { if (s.target + k + 2 <= maxDone) verdict = 'annulé'; break; }
        if (hasSuit(g, s.suit)) { verdict = 'gagné'; hitAt = k; break; }
        if (k === s.maxR) verdict = 'perdu';
        else if (s.step < k + 1) { s.step = k + 1; changed = true; editSent(s, null); } // un rattrapage de plus : message « en cours » mis à jour
      }
      if (!verdict) continue;
      changed = true; s.status = verdict; s.resolvedAt = Date.now();
      if (verdict === 'gagné') s.step = hitAt;
      if (verdict === 'annulé') continue;
      strategyRecap.noteEntry(s); // récapitulatif par canal
      editSent(s, verdict);
      if (cfg) {
        const st = statsOf(cfg);
        if (verdict === 'gagné') { st.won += 1; st.byStep[s.step] = (st.byStep[s.step] || 0) + 1; } else st.lost += 1;
        const bs = st.bySuit[s.suit] || (st.bySuit[s.suit] = { won: 0, lost: 0 });
        if (verdict === 'gagné') bs.won += 1; else bs.lost += 1;
      }
    }
    // messages dont la dernière édition a échoué : réédités avec le résultat à jour
    for (const s of panel.pendingMessages) {
      if (!s.editFail || Date.now() - s.editFail < 8000) continue;
      s.editFail = null;
      if (s.status === 'gagné' || s.status === 'perdu') editSent(s, s.status); else if (s.status === 'en attente') editSent(s, null);
    }
    // un déclencheur resté sans suite plus de 12 h est oublié (le canal n'a plus rien publié)
    for (const [k, a] of Object.entries(panel.armed)) if (Date.now() - (a.at || 0) > 12 * 3600 * 1000) { delete panel.armed[k]; changed = true; }
    // nettoyage : on garde les suivis récents et toutes les entrées encore en attente
    const before = panel.pending.length + panel.pendingMessages.length;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    panel.pending = panel.pending.filter((e) => e.phase !== 'clos' || (e.closedAt || e.at) > cutoff).slice(-PENDING_MAX);
    const open = panel.pendingMessages.filter((s) => s.status === 'en attente');
    const done = panel.pendingMessages.filter((s) => s.status !== 'en attente').slice(-SENT_RESOLVED_MAX);
    panel.pendingMessages = [...done, ...open];
    if (changed || panel.pending.length + panel.pendingMessages.length !== before) persist();
  } catch (err) { panel.lastError = err.message; }
  finally { ticking = false; }
}

// ── configurations ──────────────────────────────────────────────────────────
function normalizeConfig(c) {
  const stats = c.stats && typeof c.stats === 'object'
    ? { ...emptyStats(), ...c.stats, byStep: { ...(c.stats.byStep || {}) }, bySuit: { ...(c.stats.bySuit || {}) }, byReason: { ...(c.stats.byReason || {}) } }
    : emptyStats();
  const srcMaxRaw = c.srcMaxR === '' || c.srcMaxR === null || c.srcMaxR === undefined ? null : clampInt(c.srcMaxR, 0, 9, null);
  return {
    id: String(c.id), name: sanitizeName(c.name), enabled: c.enabled !== false,
    sources: parseChannels(c.sources).map(String), channels: parseChannels(c.channels), keyword: sanitizeName(c.keyword).slice(0, 40),
    triggerStep: clampInt(c.triggerStep, 1, 9, DEFAULT_TRIGGER_STEP), srcMaxR: srcMaxRaw,
    srcMaxRBy: Object.fromEntries(Object.entries(c.srcMaxRBy && typeof c.srcMaxRBy === 'object' ? c.srcMaxRBy : {}).filter(([, v]) => isNum(v)).map(([k, v]) => [String(k), clampInt(v, 0, 9, 0)])),
    format: fmt.clampFormat(c.format),
    stats, sentCount: Number(c.sentCount) || 0, lastSentAt: c.lastSentAt || null, lateSkipped: Number(c.lateSkipped) || 0, triggers: Number(c.triggers) || 0,
  };
}
function checkConfig(next) {
  const sources = parseChannels(next.sources); const channels = parseChannels(next.channels);
  if (!sources.length) throw new Error('Coche au moins un canal à suivre.');
  if (!channels.length) throw new Error('Renseigne le canal où envoyer les prédictions.');
  if (sources.some((s) => channels.map(String).includes(String(s)))) throw new Error('Le canal suivi et le canal d’envoi doivent être différents.');
}
function addConfig(input) {
  checkConfig(input);
  const cfg = normalizeConfig({ ...input, id: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, stats: {} });
  panel.configs.push(cfg); persist(); return cfg;
}
const EDITABLE = ['name', 'enabled', 'keyword', 'sources', 'channels', 'srcMaxR', 'srcMaxRBy', 'triggerStep', 'format'];
function updateConfig(id, patch) {
  const c = panel.configs.find((x) => x.id === id);
  if (!c) throw new Error('Configuration introuvable.');
  const next = { ...c, ...Object.fromEntries(Object.entries(patch || {}).filter(([k]) => EDITABLE.includes(k))) };
  checkConfig(next);
  const out = normalizeConfig({ ...next, stats: patch && patch.resetStats ? {} : c.stats });
  Object.keys(c).forEach((k) => delete c[k]); Object.assign(c, out);
  if (patch && patch.resetStats) {
    panel.pending = panel.pending.filter((e) => e.cfgId !== id);
    panel.pendingMessages = panel.pendingMessages.filter((s) => s.cfgId !== id || s.status === 'en attente');
    for (const k of Object.keys(panel.armed)) if (k.startsWith(`${id}:`)) delete panel.armed[k];
  }
  persist(); return c;
}
function removeConfig(id) {
  panel.configs = panel.configs.filter((c) => c.id !== id);
  panel.pending = panel.pending.filter((e) => e.cfgId !== id);
  panel.pendingMessages = panel.pendingMessages.filter((s) => s.cfgId !== id);
  for (const k of Object.keys(panel.armed)) if (k.startsWith(`${id}:`)) delete panel.armed[k];
  persist(); return true;
}
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }

// test : envoie un exemple de prédiction (jeu fictif) dans le canal d'envoi, marqué 🧪 — il n'est ni suivi ni vérifié
async function test(id) {
  const cfg = panel.configs.find((c) => c.id === id);
  if (!cfg) return { ok: false, error: 'Configuration introuvable.' };
  const sample = { format: cfg.format, target: 1234, suit: '♦️', maxR: chanMaxR(cfg, (cfg.sources || [])[0]), step: 0, strategyName: cfg.name || 'Confirmation' };
  const out = renderFor(sample, null);
  const sent = await sendToChannels(cfg, { ...out, text: `🧪 Test\n${out.text}` });
  return sent.length ? { ok: true, sent: sent.map((m) => m.chatId) } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

// ── vue pour le tableau de bord ─────────────────────────────────────────────
function status() {
  return {
    triggerStepDefault: DEFAULT_TRIGGER_STEP, srcMaxRDefault: DEFAULT_SRC_MAXR,
    configs: panel.configs.map((c) => {
      const st = statsOf(c);
      const resolved = st.won + st.lost;
      return {
        ...c,
        sourceNames: (c.sources || []).map((id) => panel.channelTitles[String(id)] || String(id)),
        channelNames: (c.channels || []).map((id) => panel.channelTitles[String(id)] || String(id)),
        following: panel.pending.filter((e) => e.cfgId === c.id && e.phase === 'verif').length,
        waiting: panel.pendingMessages.filter((s) => s.cfgId === c.id && s.status === 'en attente').length,
        armed: Object.entries(panel.armed).filter(([k]) => k.startsWith(`${c.id}:`)).map(([k, a]) => ({ src: k.slice(c.id.length + 1), name: panel.channelTitles[k.slice(c.id.length + 1)] || k.slice(c.id.length + 1), reason: a.reason, fromTarget: a.fromTarget })),
        rate: pct(st.won, resolved), resolved,
        steps: Object.entries(st.byStep || {}).map(([k, n]) => ({ step: Number(k), n: Number(n) })).sort((a, b) => a.step - b.step),
        suits: SUITS.filter((s) => st.bySuit[s]).map((s) => ({ suit: s, won: st.bySuit[s].won, lost: st.bySuit[s].lost })),
        reasons: Object.entries(st.byReason || {}).map(([k, n]) => ({ reason: k, n: Number(n) })),
        recent: panel.pendingMessages.filter((s) => s.cfgId === c.id).slice(-8).reverse()
          .map((s) => ({ target: s.target, suit: s.suit, status: s.status, step: s.step, reason: s.origin && s.origin.reason })),
      };
    }),
    duplicatesBlocked: panel.duplicatesBlocked, lastError: panel.lastError, channelTitles: panel.channelTitles,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { configs: panel.configs, pending: panel.pending, pendingMessages: panel.pendingMessages, seen: panel.seen, armed: panel.armed, channelTitles: panel.channelTitles };
  try { store.patch({ confirmation: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  panel.configs = (Array.isArray(saved.configs) ? saved.configs : []).filter((c) => c && c.id).map(normalizeConfig);
  panel.pending = Array.isArray(saved.pending) ? saved.pending.filter((e) => e && e.id).slice(-PENDING_MAX) : [];
  panel.pendingMessages = Array.isArray(saved.pendingMessages) ? saved.pendingMessages.filter((s) => s && s.id).slice(-(SENT_RESOLVED_MAX + PENDING_MAX)) : [];
  panel.seen = Array.isArray(saved.seen) ? saved.seen.slice(-SEEN_MAX) : [];
  panel.armed = saved.armed && typeof saved.armed === 'object' && !Array.isArray(saved.armed) ? saved.armed : {};
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
}
function restore() { try { const s = (store.read() || {}).confirmation; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting(DB_KEY); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

// remise à zéro de 00h00 : données du jour effacées, configurations conservées
function wipeDay() { panel.pending = []; panel.pendingMessages = []; panel.seen = []; panel.armed = {}; panel.lastError = null; persist(); }

module.exports = { wipeDay,
  panel, setSender, restore, restoreFromDb, persist, parseChannels, onChannelPost, onOwnPost, tick, status, test,
  addConfig, updateConfig, removeConfig, setChannelTitle,
};
