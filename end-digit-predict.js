// end-digit-predict.js — « Prédiction fin de numéro » (v101, demande admin), branchée sur l'analyse « fin de numéro » (end-digit.js).
//
// Main du JOUEUR uniquement (jamais le banquier). Pour chaque jeu visé N = (jeu en direct + avance, 2 par défaut) :
//   • l'analyse donne, pour la fin de numéro de N, le classement des costumes dans la main du joueur : MEILLEUR (1er) … PLUS FAIBLE (4ᵉ) ;
//   • le bot VÉRIFIE EN PERMANENCE le meilleur, même quand il ne l'envoie pas : à chaque jeu visé, il note en silence si le meilleur costume
//     est sorti (jeu N, puis rattrapages N+1 … N+R) — c'est le « dernier résultat du meilleur » de cette fin de numéro ;
//   • dernier résultat du meilleur = VALIDÉ (✅) ou aucun résultat encore  → il envoie le MEILLEUR dans le canal et continue ainsi ;
//   • dernier résultat du meilleur = NON VALIDÉ (❌)                      → il envoie DEUX prédictions pour ce jeu : le costume le PLUS FAIBLE
//     et l'INVERSE du meilleur (♦️ ↔ ♠️ · ♣️ ↔ ❤️) ; si les deux sont le même costume, un seul message part ;
//   • dès que le meilleur revalide (✅), on repasse sur le meilleur. Chaque fin de numéro (0 à 9) a son propre état.
//   • échantillon minimum (30 jeux pour cette fin de numéro) : en dessous, rien n'est envoyé ni vérifié.
// Chaque prédiction envoyée est vérifiée à son tour (N … N+R) et son message est édité (✅ / ❌). Jamais deux messages pour le même
// costume et le même numéro de jeu, jamais pour un jeu déjà joué.
'use strict';
const strategyRecap = require('./strategy-recap');

const store = require('./store');
const db = require('./db');
const strategies = require('./strategies');
const fmt = require('./formats');
const config = require('./config');
const loss = require('./loss-return'); // liste d'ID de canaux (parseChannels)
const endDigit = require('./end-digit');
const { state, hasSuit } = require('./predictor');

const DB_KEY = 'end_digit_predict_state';
const INVERSE = strategies.INVERSE;
const DEFAULT_MAXR = 2, DEFAULT_LEAD = 2, DEFAULT_MINN = 30;
const WATCH_MAX = 300, SENT_RESOLVED_MAX = 100, DONE_MAX = 200;
const ROLE_LABEL = { meilleur: 'Meilleur', faible: 'Plus faible', inverse: 'Inverse du meilleur', 'faible+inverse': 'Faible = inverse' };

const panel = {
  enabled: false, channels: [], format: config.DEFAULT_FORMAT, maxR: DEFAULT_MAXR, lead: DEFAULT_LEAD, minN: DEFAULT_MINN,
  last: {},            // dernier résultat du meilleur par fin de numéro : { '4': { ok, suit, target, at } }
  digitStats: {},      // { '4': { bestWon, bestLost } } — vérification silencieuse du meilleur
  watches: [],         // vérifications silencieuses du meilleur
  pendingMessages: [], // prédictions envoyées
  done: [],            // jeux visés déjà traités
  stats: null, sentCount: 0, lastSentAt: null, duplicatesBlocked: 0, lastError: null, channelTitles: {},
};
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
const bot = () => (typeof sender === 'function' ? sender() : null);

const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const isDone = (g) => !!g && g.finished && g.complete !== false;
const maxFinishedGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; };
const maxKnownGameNumber = () => { let m = 0; for (const g of state.games.values()) if ((g.finished || g.dealing) && g.number > m) m = g.number; return m; };
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const emptyStats = () => ({ sent: 0, won: 0, lost: 0, byStep: {}, byRole: {} });
const statsOf = () => { panel.stats = panel.stats && typeof panel.stats === 'object' ? { ...emptyStats(), ...panel.stats } : emptyStats(); return panel.stats; };
const modeOf = (digit) => { const l = panel.last[String(digit)]; return l && l.ok === false ? 'repli' : 'meilleur'; };

// ── envoi / édition ─────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, { gameNumber: entry.target, suit: entry.suit, strategy: 'Fin de numéro', maxR: entry.maxR, status: statusFr, rattrapage: entry.step || 0 }, null);
}
async function sendToChannels(out) {
  const b = bot();
  if (!b) { panel.lastError = 'Aucun token Telegram configuré'; return []; }
  const results = await Promise.all((panel.channels || []).map((id) => b.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {})
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
      .catch((e) => {
        const msg = String((e && e.message) || e);
        if (/message is not modified/i.test(msg)) { entry.editFail = null; return; }
        if (/not found|can't be edited|chat not found|kicked|not a member|forbidden|blocked/i.test(msg)) return;
        entry.editTries = (Number(entry.editTries) || 0) + 1;
        if (entry.editTries <= 20) entry.editFail = Date.now();
      });
  }
}

const inflight = new Set();
async function launch(target, digit, suit, role) {
  if (!panel.channels.length) return false;
  if (target <= maxKnownGameNumber()) return false;
  const key = `${target}:${suit}`;
  if (panel.pendingMessages.some((s) => s.target === target && s.suit === suit) || inflight.has(key)) { panel.duplicatesBlocked += 1; return false; }
  inflight.add(key);
  try {
    const entry = { id: `edp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: 'end-digit-predict', suit, target, digit, role, maxR: panel.maxR, format: panel.format, step: 0, status: 'en attente', messages: [], createdAt: Date.now(), resolvedAt: null };
    entry.messages = await sendToChannels(renderFor(entry, null));
    if (!entry.messages.length) return false;
    panel.pendingMessages.push(entry);
    const st = statsOf(); st.sent += 1; panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null;
    return true;
  } finally { inflight.delete(key); }
}

// ── cycle (appelé à chaque passage du bot) ──────────────────────────────────
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    let changed = false;
    // 1) nouveau jeu visé : vérification silencieuse du meilleur + envoi
    const live = maxKnownGameNumber();
    const snap = (panel.enabled || panel.watches.length) ? endDigit.cached() : null;
    if (live && snap && Array.isArray(snap.digits)) {
      const target = live + panel.lead;
      if (!panel.done.includes(target)) {
        panel.done.push(target); if (panel.done.length > DONE_MAX) panel.done = panel.done.slice(-DONE_MAX);
        changed = true;
        const digit = target % 10;
        const info = snap.digits[digit];
        const ranked = (info && info.player && info.player.ranked) || [];
        if (info && info.n >= panel.minN && ranked.length >= 2) {
          const best = strategies.normSuit(ranked[0].suit);
          const weak = strategies.normSuit(ranked[ranked.length - 1].suit);
          const inv = best ? INVERSE[best] : null;
          if (best) {
            if (panel.enabled) {
              const mode = modeOf(digit);
              if (mode === 'meilleur') await launch(target, digit, best, 'meilleur');
              else {
                const picks = [];
                if (weak && weak !== best) picks.push([weak, weak === inv ? 'faible+inverse' : 'faible']);
                if (inv && inv !== weak) picks.push([inv, 'inverse']);
                for (const [suit, role] of picks) await launch(target, digit, suit, role);
              }
            }
            panel.watches.push({ id: `edw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, digit, target, suit: best, pct: ranked[0].pct, maxR: panel.maxR, status: 'en attente', at: Date.now() });
          }
        }
      }
    }
    const maxDone = maxFinishedGameNumber();
    if (maxDone) {
      const verdictOf = (e) => {
        let verdict = null; let hitAt = -1;
        for (let k = 0; k <= e.maxR; k++) {
          const g = state.games.get(e.target + k);
          if (!isDone(g)) { if (e.target + k + 2 <= maxDone) verdict = 'annulé'; break; }
          if (hasSuit(g, e.suit)) { verdict = 'gagné'; hitAt = k; break; }
          if (k === e.maxR) verdict = 'perdu';
          else if ((e.step || 0) < k + 1) { e.step = k + 1; changed = true; if (e.messages) editSent(e, null); }
        }
        return verdict ? { verdict, hitAt } : null;
      };
      // 2) vérification silencieuse du meilleur → dernier résultat par fin de numéro
      for (const w of panel.watches) {
        if (w.status !== 'en attente') continue;
        const r = verdictOf(w); if (!r) continue;
        w.status = r.verdict; w.resolvedAt = Date.now(); changed = true;
        if (r.verdict === 'annulé') continue;
        const k = String(w.digit);
        const ds = panel.digitStats[k] || (panel.digitStats[k] = { bestWon: 0, bestLost: 0 });
        if (r.verdict === 'gagné') ds.bestWon += 1; else ds.bestLost += 1;
        const prev = panel.last[k];
        if (!prev || (Number(prev.target) || 0) <= w.target) panel.last[k] = { ok: r.verdict === 'gagné', suit: w.suit, target: w.target, at: Date.now() };
      }
      // 3) prédictions envoyées
      for (const s of panel.pendingMessages) {
        if (s.status !== 'en attente') continue;
        const r = verdictOf(s); if (!r) continue;
        changed = true; s.status = r.verdict; s.resolvedAt = Date.now();
        if (r.verdict === 'gagné') s.step = r.hitAt;
        if (r.verdict === 'annulé') continue;
        strategyRecap.noteEntry(s);
        editSent(s, r.verdict);
        const st = statsOf();
        const br = st.byRole[s.role] || (st.byRole[s.role] = { won: 0, lost: 0 });
        if (r.verdict === 'gagné') { st.won += 1; st.byStep[s.step] = (st.byStep[s.step] || 0) + 1; br.won += 1; } else { st.lost += 1; br.lost += 1; }
      }
      for (const s of panel.pendingMessages) {
        if (!s.editFail || Date.now() - s.editFail < 8000) continue;
        s.editFail = null;
        if (s.status === 'gagné' || s.status === 'perdu') editSent(s, s.status); else if (s.status === 'en attente') editSent(s, null);
      }
    }
    const before = panel.watches.length + panel.pendingMessages.length;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    panel.watches = panel.watches.filter((w) => w.status === 'en attente' || (w.resolvedAt || w.at) > cutoff).slice(-WATCH_MAX);
    panel.pendingMessages = [...panel.pendingMessages.filter((s) => s.status !== 'en attente').slice(-SENT_RESOLVED_MAX), ...panel.pendingMessages.filter((s) => s.status === 'en attente')];
    if (changed || panel.watches.length + panel.pendingMessages.length !== before) persist();
  } catch (e) { panel.lastError = e.message; }
  finally { ticking = false; }
}

// ── réglages ────────────────────────────────────────────────────────────────
function config_() { return { enabled: panel.enabled, channels: [...panel.channels], format: panel.format, maxR: panel.maxR, lead: panel.lead, minN: panel.minN }; }
function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = loss.parseChannels(patch.channels);
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.maxR !== undefined) panel.maxR = clampInt(patch.maxR, 0, 9, DEFAULT_MAXR);
  if (patch.lead !== undefined) panel.lead = clampInt(patch.lead, 1, 20, DEFAULT_LEAD);
  if (patch.minN !== undefined) panel.minN = clampInt(patch.minN, 1, 5000, DEFAULT_MINN);
  persist();
  return config_();
}
function resetStats() { panel.stats = emptyStats(); panel.last = {}; panel.digitStats = {}; panel.watches = []; panel.pendingMessages = panel.pendingMessages.filter((s) => s.status === 'en attente'); persist(); }
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }

async function test() {
  if (!panel.channels.length) return { ok: false, error: 'Renseigne le canal où envoyer les prédictions.' };
  const out = renderFor({ format: panel.format, target: 1234, suit: '♦️', maxR: panel.maxR, step: 0 }, null);
  const sent = await sendToChannels({ ...out, text: `🧪 Test\n${out.text}` });
  return sent.length ? { ok: true, sent: sent.map((m) => m.chatId) } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

function status() {
  const st = statsOf(); const resolved = st.won + st.lost;
  return {
    ...config_(),
    digits: Array.from({ length: 10 }, (_, d) => {
      const ds = panel.digitStats[String(d)] || { bestWon: 0, bestLost: 0 }; const l = panel.last[String(d)] || null;
      return { digit: d, mode: modeOf(d), bestWon: ds.bestWon, bestLost: ds.bestLost, rate: pct(ds.bestWon, ds.bestWon + ds.bestLost), lastOk: l ? l.ok : null, lastSuit: l ? l.suit : null, lastTarget: l ? l.target : null };
    }),
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, duplicatesBlocked: panel.duplicatesBlocked, won: st.won, lost: st.lost, resolved, rate: pct(st.won, resolved),
    steps: Object.entries(st.byStep || {}).map(([k, n]) => ({ step: Number(k), n: Number(n) })).sort((a, b) => a.step - b.step),
    roles: Object.entries(st.byRole || {}).map(([k, v]) => ({ role: k, label: ROLE_LABEL[k] || k, won: v.won, lost: v.lost, rate: pct(v.won, v.won + v.lost) })),
    waiting: panel.pendingMessages.filter((s) => s.status === 'en attente').length,
    recent: panel.pendingMessages.slice(-12).reverse().map((s) => ({ target: s.target, digit: s.digit, suit: s.suit, role: ROLE_LABEL[s.role] || s.role, status: s.status, step: s.step, maxR: s.maxR })),
    channelNames: panel.channels.map((id) => panel.channelTitles[String(id)] || String(id)), lastError: panel.lastError,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { config: config_(), last: panel.last, digitStats: panel.digitStats, watches: panel.watches, pendingMessages: panel.pendingMessages, done: panel.done, stats: panel.stats, sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, channelTitles: panel.channelTitles };
  try { store.patch({ endDigitPredict: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  const c = saved.config || {};
  panel.enabled = c.enabled === true; panel.channels = loss.parseChannels(c.channels);
  panel.format = fmt.clampFormat(c.format || config.DEFAULT_FORMAT); panel.maxR = clampInt(c.maxR, 0, 9, DEFAULT_MAXR);
  panel.lead = clampInt(c.lead, 1, 20, DEFAULT_LEAD); panel.minN = clampInt(c.minN, 1, 5000, DEFAULT_MINN);
  panel.last = saved.last && typeof saved.last === 'object' ? saved.last : {};
  panel.digitStats = saved.digitStats && typeof saved.digitStats === 'object' ? saved.digitStats : {};
  panel.watches = Array.isArray(saved.watches) ? saved.watches.filter((e) => e && e.id).slice(-WATCH_MAX) : [];
  panel.pendingMessages = Array.isArray(saved.pendingMessages) ? saved.pendingMessages.filter((s) => s && s.id).slice(-(SENT_RESOLVED_MAX + WATCH_MAX)) : [];
  panel.done = Array.isArray(saved.done) ? saved.done.slice(-DONE_MAX) : [];
  panel.stats = saved.stats && typeof saved.stats === 'object' ? saved.stats : null;
  panel.sentCount = Number(saved.sentCount) || 0; panel.lastSentAt = saved.lastSentAt || null;
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
}
function restore() { try { const s = (store.read() || {}).endDigitPredict; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting(DB_KEY); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

module.exports = { panel, setSender, restore, restoreFromDb, persist, tick, status, test, config: config_, configure, resetStats, setChannelTitle, modeOf };
