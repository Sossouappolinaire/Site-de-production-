// loss-relaunch.js — stratégie « Relance après perte » (v63) :
//
//  • On crée une configuration depuis le bouton de l'accueil : on COCHE un ou plusieurs canaux à suivre (ID) — canaux où ce bot
//    publie (toute stratégie ou bouton) ou canaux d'autres bots où il est administrateur.
//  • Le bot OBSERVE les prédictions de ces canaux (N° de jeu + costume) et les vérifie lui-même sur la main du JOUEUR, avec le
//    nombre de rattrapages du canal suivi (N, N+1 … N+R). Costume jamais sorti → prédiction PERDUE.
//  • Dès que la main du joueur du dernier rattrapage est complète et que le costume est absent, le bot prédit le même costume à
//    N + R + D. D = 1 (par défaut) signifie le jeu qui suit la fin des rattrapages. Ex. : 12 ❤️ + 3 rattrapages → si absent au 15,
//    prédiction N°16 ❤️, sans attendre la fin de la main du banquier.
//  • Configuration : canal d'envoi (ID), format de prédiction (1 → 101), nombre de rattrapages de la nouvelle prédiction.
//    La nouvelle prédiction est vérifiée à son tour (N°, N+1 … N+rattrapages) et son message est édité (✅ / ❌).
//  • Canal « Relance » : si un canal coché est celui où une configuration du bouton « Relance » (best-weak-top.js) envoie ses deux
//    costumes + sa relance, on suit la RELANCE de cette configuration (le costume relancé, au jeu de la relance, avec les
//    rattrapages de la relance) et NON la perte du message d'origine : le bot ne reçoit pas ses propres publications de canal,
//    la relance est donc transmise directement (onRelaunchSent). On peut aussi cocher la configuration « Relance » elle-même.
//  • Une configuration n'envoie jamais deux prédictions pour le même numéro de jeu (même costume ou non) ; jamais pour un jeu déjà joué.
//  • Toujours sur la main du JOUEUR (hasSuit), jamais le banquier.
'use strict';

const store = require('./store');
const db = require('./db');
const strategies = require('./strategies');
const fmt = require('./formats');
const loss = require('./loss-return'); // lecture d'une publication de canal (parsePost) et liste d'ID (parseChannels)
const { state, hasSuit } = require('./predictor');

const SUITS = ['♠️', '❤️', '♦️', '♣️'];
const DEFAULT_OFFSET = 1;     // D=1 : prédire au jeu qui suit le dernier jeu de rattrapage
const OFFSET_SCHEMA_VERSION = 2;
const DEFAULT_MAXR = 3;       // rattrapages par défaut (v58)
const SEEN_MAX = 1500;
const PENDING_MAX = 400;
const SENT_RESOLVED_MAX = 100;

const panel = { configs: [], pending: [], pendingMessages: [], seen: [], channelTitles: {}, lastError: null, duplicatesBlocked: 0 };
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
const bot = () => (typeof sender === 'function' ? sender() : null);

// ── utilitaires ─────────────────────────────────────────────────────────────
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const parseChannels = loss.parseChannels;
const sanitizeName = (v) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, 60);
const isDone = (g) => !!g && g.finished && g.complete !== false;
// La perte d'une prédiction de costume dépend uniquement de la main du joueur.
// Au baccarat, après deux cartes le joueur tire encore à 0–5 et s'arrête à 6–9.
// Une troisième carte confirme aussi que sa main est terminée, même si le banquier tire toujours.
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
const maxKnownGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.number > m) m = g.number; return m; };
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const emptyStats = () => ({ sent: 0, won: 0, lost: 0, cancelled: 0, byStep: {}, bySuit: {} });
function statsOf(cfg) { cfg.stats = cfg.stats && typeof cfg.stats === 'object' ? cfg.stats : emptyStats(); return cfg.stats; }
// rattrapages d'une prédiction SUIVIE : ceux de la relance si la source est une relance, sinon ceux du canal suivi (par défaut : ceux de la config)
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)); // Number(null) vaut 0 : à écarter
// rattrapage d'un canal suivi : celui saisi pour CE canal, sinon celui commun aux canaux suivis, sinon celui de la configuration
const chanMaxR = (cfg, key) => { const m = key != null && cfg.srcMaxRBy ? cfg.srcMaxRBy[String(key)] : null; return isNum(m) ? Number(m) : (isNum(cfg.srcMaxR) ? Number(cfg.srcMaxR) : Number(cfg.maxR)); };
const sourceMaxR = (e, cfg) => (isNum(e.maxR) ? Number(e.maxR) : chanMaxR(cfg, e.srcKey != null ? e.srcKey : e.src));
// D est le nombre de jeux après le dernier jeu de rattrapage ; D=1 est valide.
const minOffsetOf = () => 1;

// canaux où une configuration « Relance » du bouton « Meilleur + plus faible » envoie : ils sont suivis par la relance, pas par leurs publications
function relanceChannelIds() {
  try {
    const bw = require('./best-weak-top');
    return new Set(((bw.panel && bw.panel.configs) || []).filter((c) => c.mode === 'relance').flatMap((c) => (c.channels || []).map(String)));
  } catch (_) { return new Set(); }
}

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
    const relCh = relanceChannelIds();
    let changed = false;
    for (const cfg of panel.configs.filter((c) => c.enabled)) {
      const matches = (cfg.sources || []).some((s) => String(s) === src || (uname && String(s).toLowerCase() === uname));
      if (!matches) continue;
      const srcKey = (cfg.sources || []).find((s) => String(s) === src || (uname && String(s).toLowerCase() === uname));
      if ((cfg.channels || []).map(String).includes(src)) continue; // ne jamais suivre son propre canal d'envoi
      // canal « Relance » : le message d'origine à deux costumes est ignoré (on suit la relance, voir onRelaunchSent)
      if (relCh.has(src) && post.suits.length >= 2) continue;
      if (cfg.keyword && !String(text).toLowerCase().includes(cfg.keyword.toLowerCase())) continue; // filtre facultatif (nom de la stratégie…)
      if (chat.title) panel.channelTitles[src] = String(chat.title).slice(0, 120);
      for (const suit of post.suits) {
        const key = `${cfg.id}:${src}:${post.target}:${suit}`;
        if (panel.seen.includes(key)) continue;
        if (panel.pending.some((e) => e.cfgId === cfg.id && e.suit === suit && e.target === post.target)) continue; // même prédiction déjà suivie (autre source)
        panel.seen.push(key); if (panel.seen.length > SEEN_MAX) panel.seen = panel.seen.slice(-SEEN_MAX);
        panel.pending.push({ id: `lrl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: cfg.id, kind: 'post', src, srcKey: srcKey == null ? src : String(srcKey), suit, target: post.target, status: 'en attente', phase: 'verif', at: Date.now() });
        changed = true;
      }
    }
    if (panel.pending.length > PENDING_MAX) panel.pending = panel.pending.slice(-PENDING_MAX);
    if (changed) persist();
    return changed;
  } catch (e) { panel.lastError = e.message; return false; }
}
// message envoyé par le bot lui-même (point d'envoi unique de bot.js) : même lecture que pour une publication de canal
function onOwnPost(chatId, text) { return onChannelPost({ id: chatId }, text); }

// ── observation : relance du bouton « Relance » (transmise directement par best-weak-top.js) ──
// relEntry : la relance (jeu relancé, costume(s) pas venu(s), rattrapages de la relance). On suit CETTE relance, pas la perte d'origine.
function onRelaunchSent(bwCfg, parent, relEntry) {
  try {
    if (!bwCfg || !relEntry || !Array.isArray(relEntry.suits) || !Number.isFinite(Number(relEntry.target))) return false;
    const bwChannels = (bwCfg.channels || []).map(String);
    let changed = false;
    for (const cfg of panel.configs.filter((c) => c.enabled)) {
      const byRelance = (cfg.relances || []).map(String).includes(String(bwCfg.id));
      const byChannel = (cfg.sources || []).some((s) => bwChannels.includes(String(s)));
      if (!byRelance && !byChannel) continue;
      if (bwChannels.length && bwChannels.every((id) => (cfg.channels || []).map(String).includes(id))) continue; // jamais son propre canal d'envoi
      for (const it of relEntry.suits) {
        const suit = strategies.normSuit(it.suit); if (!suit) continue;
        const key = `${cfg.id}:rl:${relEntry.id}:${suit}`;
        if (panel.seen.includes(key)) continue;
        panel.seen.push(key); if (panel.seen.length > SEEN_MAX) panel.seen = panel.seen.slice(-SEEN_MAX);
        panel.pending.push({ id: `lrl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: cfg.id, kind: 'relance', src: `relance:${bwCfg.id}`, relName: bwCfg.name || 'Relance',
          suit, target: Number(relEntry.target), maxR: Number(relEntry.maxR), status: 'en attente', phase: 'verif', at: Date.now() });
        changed = true;
      }
    }
    if (panel.pending.length > PENDING_MAX) panel.pending = panel.pending.slice(-PENDING_MAX);
    if (changed) persist();
    return changed;
  } catch (e) { panel.lastError = e.message; return false; }
}

// ── envoi / édition ─────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, {
    gameNumber: entry.target, suit: entry.suit, strategy: entry.strategyName || 'Relance après perte', maxR: entry.maxR,
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
      .catch((e) => { // v59 : un échec temporaire (limite Telegram, réseau) est retenté au tour suivant ; message supprimé / bot retiré : on abandonne
        const msg = String((e && e.message) || e);
        if (/message is not modified/i.test(msg)) { entry.editFail = null; return; }
        if (/not found|can't be edited|chat not found|kicked|not a member|forbidden|blocked/i.test(msg)) return;
        entry.editTries = (Number(entry.editTries) || 0) + 1;
        if (entry.editTries <= 20) entry.editFail = Date.now();
      });
  }
}

const inflight = new Set();
// Perte constatée après la main du joueur : prédit le même costume à N + R + D.
async function launch(cfg, e) {
  const R = sourceMaxR(e, cfg);
  const target = e.target + R + Math.max(cfg.offset, minOffsetOf()); // D=1 : jeu suivant la fin des rattrapages
  e.launchTarget = target;
  if (target <= maxKnownGameNumber()) { e.launch = 'trop tard (jeu déjà joué)'; cfg.lateSkipped = (cfg.lateSkipped || 0) + 1; panel.lastError = `Relance N°${target} non envoyée : jeu déjà joué.`; return false; }
  if (panel.pendingMessages.some((s) => s.cfgId === cfg.id && s.target === target) || inflight.has(`${cfg.id}:${target}`)) { // un seul message par numéro de jeu et par configuration
    e.launch = 'doublon ignoré'; panel.duplicatesBlocked += 1; return false;
  }
  inflight.add(`${cfg.id}:${target}`);
  try {
    const entry = { id: `lrls-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: cfg.id, suit: e.suit, target, maxR: cfg.maxR, format: cfg.format, step: 0,
      strategyName: cfg.name || 'Relance après perte', status: 'en attente', messages: [], origin: { target: e.target, src: e.src, relName: e.relName || null, kind: e.kind }, createdAt: Date.now(), resolvedAt: null };
    entry.messages = await sendToChannels(cfg, renderFor(entry, null));
    if (!entry.messages.length) { e.launch = 'non envoyé'; return false; }
    panel.pendingMessages.push(entry);
    const st = statsOf(cfg); st.sent += 1; cfg.sentCount = (cfg.sentCount || 0) + 1; cfg.lastSentAt = Date.now(); panel.lastError = null;
    e.launch = `envoyé N°${target}`;
    return true;
  } finally { inflight.delete(`${cfg.id}:${target}`); }
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
    // 1) prédictions SUIVIES : gagnée / perdue / annulée ; une perte déclenche la relance
    for (const e of panel.pending) {
      if (e.phase !== 'verif') continue;
      const cfg = panel.configs.find((c) => c.id === e.cfgId);
      if (!cfg) { e.phase = 'clos'; e.status = 'annulé'; changed = true; continue; }
      const R = sourceMaxR(e, cfg);
      let verdict = null;
      for (let k = 0; k <= R; k++) {
        const g = state.games.get(e.target + k);
        if (!isPlayerHandComplete(g)) { if (e.target + k + 2 <= maxDone) verdict = 'annulé'; break; } // joueur pas encore arrivé à la fin de sa main
        if (hasSuit(g, e.suit)) { verdict = 'gagné'; break; }
        if (k === R) verdict = 'perdu';
      }
      if (!verdict) continue;
      changed = true; e.phase = 'clos'; e.status = verdict; e.closedAt = Date.now();
      if (verdict === 'perdu') { try { await launch(cfg, e); } catch (err) { panel.lastError = err.message; e.launch = 'erreur'; } }
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
      editSent(s, verdict);
      if (cfg) {
        const st = statsOf(cfg);
        if (verdict === 'gagné') { st.won += 1; st.byStep[s.step] = (st.byStep[s.step] || 0) + 1; } else st.lost += 1;
        const bs = st.bySuit[s.suit] || (st.bySuit[s.suit] = { won: 0, lost: 0 });
        if (verdict === 'gagné') bs.won += 1; else bs.lost += 1;
      }
    }
    // v59 : messages dont la dernière édition a échoué : réédités avec le résultat à jour
    for (const s of panel.pendingMessages) {
      if (!s.editFail || Date.now() - s.editFail < 8000) continue;
      s.editFail = null;
      if (s.status === 'gagné' || s.status === 'perdu') editSent(s, s.status); else if (s.status === 'en attente') editSent(s, null);
    }
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
  const stats = c.stats && typeof c.stats === 'object' ? { ...emptyStats(), ...c.stats, byStep: { ...(c.stats.byStep || {}) }, bySuit: { ...(c.stats.bySuit || {}) } } : emptyStats();
  const srcMaxRaw = c.srcMaxR === '' || c.srcMaxR === null || c.srcMaxR === undefined ? null : clampInt(c.srcMaxR, 0, 9, null);
  return {
    offsetVersion: OFFSET_SCHEMA_VERSION,
    id: String(c.id), name: sanitizeName(c.name), enabled: c.enabled !== false,
    sources: parseChannels(c.sources).map(String), relances: (Array.isArray(c.relances) ? c.relances : []).map(String).filter(Boolean), channels: parseChannels(c.channels),
    keyword: sanitizeName(c.keyword).slice(0, 40),
    offset: clampInt(c.offset, 1, 40, DEFAULT_OFFSET), maxR: clampInt(c.maxR, 0, 9, DEFAULT_MAXR), srcMaxR: srcMaxRaw,
    srcMaxRBy: Object.fromEntries(Object.entries(c.srcMaxRBy && typeof c.srcMaxRBy === 'object' ? c.srcMaxRBy : {}).filter(([, v]) => isNum(v)).map(([k, v]) => [String(k), clampInt(v, 0, 9, 0)])),
    format: fmt.clampFormat(c.format),
    stats, sentCount: Number(c.sentCount) || 0, lastSentAt: c.lastSentAt || null, lateSkipped: Number(c.lateSkipped) || 0,
  };
}
function checkConfig(next) {
  const sources = parseChannels(next.sources); const channels = parseChannels(next.channels);
  if (!sources.length && !(Array.isArray(next.relances) && next.relances.length)) throw new Error('Coche au moins un canal ou une relance à suivre.');
  if (!channels.length) throw new Error('Renseigne le canal où envoyer les prédictions.');
  if (sources.some((s) => channels.map(String).includes(String(s)))) throw new Error('Le canal suivi et le canal d’envoi doivent être différents.');
}
function addConfig(input) {
  const base = { ...input, relances: Array.isArray(input.relances) ? input.relances : [] };
  checkConfig(base);
  const cfg0 = normalizeConfig({ ...base, id: `lrl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, stats: {} });
  const cfg = cfg0;
  panel.configs.push(cfg); persist(); return cfg;
}
const EDITABLE = ['name', 'enabled', 'keyword', 'sources', 'relances', 'channels', 'offset', 'maxR', 'srcMaxR', 'srcMaxRBy', 'format'];
function updateConfig(id, patch) {
  const c = panel.configs.find((x) => x.id === id);
  if (!c) throw new Error('Configuration introuvable.');
  const next = { ...c, ...Object.fromEntries(Object.entries(patch || {}).filter(([k]) => EDITABLE.includes(k))) };
  checkConfig(next);
  const out = normalizeConfig({ ...next, stats: patch && patch.resetStats ? {} : c.stats });
  Object.keys(c).forEach((k) => delete c[k]); Object.assign(c, out);
  if (patch && patch.resetStats) { panel.pending = panel.pending.filter((e) => e.cfgId !== id); panel.pendingMessages = panel.pendingMessages.filter((s) => s.cfgId !== id || s.status === 'en attente'); }
  persist(); return c;
}
function removeConfig(id) {
  panel.configs = panel.configs.filter((c) => c.id !== id);
  panel.pending = panel.pending.filter((e) => e.cfgId !== id);
  panel.pendingMessages = panel.pendingMessages.filter((s) => s.cfgId !== id);
  persist(); return true;
}
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }

// test : envoie un exemple de prédiction (jeu fictif) dans le canal d'envoi, marqué 🧪 — il n'est ni suivi ni vérifié
async function test(id) {
  const cfg = panel.configs.find((c) => c.id === id);
  if (!cfg) return { ok: false, error: 'Configuration introuvable.' };
  const sample = { format: cfg.format, target: 1234, suit: '♦️', maxR: cfg.maxR, step: 0, strategyName: cfg.name || 'Relance après perte' };
  const out = renderFor(sample, null);
  const sent = await sendToChannels(cfg, { ...out, text: `🧪 Test\n${out.text}` });
  return sent.length ? { ok: true, sent: sent.map((m) => m.chatId) } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

// ── vue pour le tableau de bord ─────────────────────────────────────────────
function status() {
  return {
    configs: panel.configs.map((c) => {
      const st = statsOf(c);
      const resolved = st.won + st.lost;
      return {
        ...c,
        sourceNames: (c.sources || []).map((id) => panel.channelTitles[String(id)] || String(id)),
        relanceIds: c.relances || [],
        channelNames: (c.channels || []).map((id) => panel.channelTitles[String(id)] || String(id)),
        following: panel.pending.filter((e) => e.cfgId === c.id && e.phase === 'verif').length,
        waiting: panel.pendingMessages.filter((s) => s.cfgId === c.id && s.status === 'en attente').length,
        rate: pct(st.won, resolved), resolved, minOffset: minOffsetOf(c),
        steps: Object.entries(st.byStep || {}).map(([k, n]) => ({ step: Number(k), n: Number(n) })).sort((a, b) => a.step - b.step),
        suits: SUITS.filter((s) => st.bySuit[s]).map((s) => ({ suit: s, won: st.bySuit[s].won, lost: st.bySuit[s].lost })),
        recent: panel.pendingMessages.filter((s) => s.cfgId === c.id).slice(-8).reverse()
          .map((s) => ({ target: s.target, suit: s.suit, status: s.status, step: s.step, originTarget: s.origin && s.origin.target, relName: s.origin && s.origin.relName })),
        lostFollowed: panel.pending.filter((e) => e.cfgId === c.id && e.status === 'perdu').slice(-5).reverse()
          .map((e) => ({ target: e.target, suit: e.suit, launch: e.launch || '', relName: e.relName || null })),
      };
    }),
    relanceChannels: [...relanceChannelIds()],
    duplicatesBlocked: panel.duplicatesBlocked,
    lastError: panel.lastError, channelTitles: panel.channelTitles,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { configs: panel.configs, pending: panel.pending, pendingMessages: panel.pendingMessages, seen: panel.seen, channelTitles: panel.channelTitles };
  try { store.patch({ lossRelaunch: saved }); } catch (_) {}
  if (db.ready) db.setSetting('loss_relaunch_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  let migratedOffset = false;
  panel.configs = (Array.isArray(saved.configs) ? saved.configs : []).filter((c) => c && c.id).map((c) => {
    if (Number(c.offsetVersion) === OFFSET_SCHEMA_VERSION) return normalizeConfig(c);
    // Avant v62, l'interface imposait D >= (plus grand rattrapage + 1).
    // Quand l'ancien réglage était exactement cette limite imposée, il s'agissait
    // du décalage par défaut, pas d'un délai choisi : le convertir en D=1 évite
    // qu'une configuration RAP déjà enregistrée continue d'attendre plusieurs jeux.
    const levels = [isNum(c.maxR) ? Number(c.maxR) : DEFAULT_MAXR];
    if (isNum(c.srcMaxR)) levels.push(Number(c.srcMaxR));
    for (const value of Object.values(c.srcMaxRBy && typeof c.srcMaxRBy === 'object' ? c.srcMaxRBy : {})) {
      if (isNum(value)) levels.push(Number(value));
    }
    const legacyMinimum = Math.max(0, ...levels) + 1;
    const oldOffset = Number.parseInt(c.offset, 10);
    const offset = !Number.isFinite(oldOffset) || oldOffset <= legacyMinimum ? DEFAULT_OFFSET : oldOffset;
    migratedOffset = true;
    return normalizeConfig({ ...c, offset });
  });
  panel.pending = Array.isArray(saved.pending) ? saved.pending.filter((e) => e && e.id).slice(-PENDING_MAX) : [];
  panel.pendingMessages = Array.isArray(saved.pendingMessages) ? saved.pendingMessages.filter((s) => s && s.id).slice(-(SENT_RESOLVED_MAX + PENDING_MAX)) : [];
  panel.seen = Array.isArray(saved.seen) ? saved.seen.slice(-SEEN_MAX) : [];
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
  if (migratedOffset) persist();
}
function restore() { try { const s = (store.read() || {}).lossRelaunch; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting('loss_relaunch_state'); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

module.exports = {
  panel, setSender, restore, restoreFromDb, persist, parseChannels, onChannelPost, onOwnPost, onRelaunchSent, tick, status, test,
  addConfig, updateConfig, removeConfig, setChannelTitle,
};
