// end-digit-trio.js — « Trio fin de numéro » (v127, demande admin), stratégie branchée sur le bouton « Analyse fin de numéro » (end-digit.js).
//
// PAR DIZAINE. Dès que la main du joueur du jeu finissant par 9 est terminée (ex. #1239), le bot relit l'analyse « fin de numéro »
// (main du JOUEUR, historique de la base + sabot en cours) : pour chacune des 10 fins de numéro, le meilleur costume et son taux.
//   • il garde les fins dont le meilleur taux est de 50 % ou plus (réglable), puis prend les 3 PLUS HAUTS taux (réglable) ;
//   • taux de 50 à 59 % (sous le seuil « inverse ») → on prédit CE costume ;
//     taux de 60 % ou plus (seuil réglable, 60 % = comme « Fin de numéro → costume opposé ») → on prédit son INVERSE (♦️ ↔ ♠️, ♣️ ↔ ❤️) ;
//   • chaque prédiction vise le jeu de la dizaine suivante qui finit par ce chiffre (analyse après #1230-#1239 → jeux 1240 à 1249 :
//     la fin 3 vise le #1243) ; elle part quand le jeu en direct est à « avance » jeux du numéro visé (2 par défaut) ;
//   • les fins de numéro prédites à la dizaine PRÉCÉDENTE sont INTERDITES cette fois-ci : on en choisit d'autres ; si aucune autre n'est
//     dans les taux, pas de prédiction ; s'il n'y en a qu'une, une seule part. Elles redeviennent permises à la dizaine d'après ;
//   • échantillon minimum par fin de numéro (30 jeux par défaut) : en dessous, la fin est ignorée.
//
// « SUIVI » (fonction à part, autre canal) : une fois chaque prédiction du trio vérifiée (jeu N puis rattrapages N+1 … N+R) :
//   • le costume n'est PAS venu directement (❌, ou ✅ à un rattrapage : pas ✅0️⃣) → à la dizaine suivante, MÊME fin de numéro, MÊME costume ;
//   • le costume est venu DIRECTEMENT (✅0️⃣) → à la dizaine suivante, MÊME fin de numéro, costume INVERSE (miroir) ;
//   • le suivi ne dépend ni du choix des 3 fins, ni de l'interdiction d'une dizaine à l'autre ; il est envoyé dans SON canal (« canal du suivi »).
//     Un suivi par prédiction du trio : le résultat d'un suivi n'en déclenche pas un autre.
// Chaque prédiction envoyée est vérifiée à son tour (main du joueur, sans attendre le banquier) et son message est édité (✅ / ❌).
'use strict';
const strategyRecap = require('./strategy-recap');

const store = require('./store');
const db = require('./db');
const strategies = require('./strategies');
const fmt = require('./formats');
const config = require('./config');
const loss = require('./loss-return'); // liste d'ID de canaux (parseChannels)
const endDigit = require('./end-digit');
const { state, hasSuit, setOnShoeReset } = require('./predictor');

const DB_KEY = 'end_digit_trio_state';
const STORE_KEY = 'endDigitTrio';
const INVERSE = strategies.INVERSE;
const DEFAULT_MAXR = 2, DEFAULT_LEAD = 2, DEFAULT_MINN = 30, DEFAULT_COUNT = 3, DEFAULT_SAME_MIN = 50, DEFAULT_INVERSE_MIN = 60;
const SENT_RESOLVED_MAX = 100, HISTORY_MAX = 6, FOLLOWS_MAX = 60;
const SEND_MAX_MS = 20000, TICK_MAX_MS = 90000, PENDING_MAX_MS = 20 * 60 * 1000, ANALYSE_MAX_MS = 20000;
const STALE_AHEAD = 60; // une prédiction qui vise plus de 60 jeux au-delà du jeu en direct vient forcément d'un sabot précédent

const panel = {
  enabled: false, channels: [], followChannels: [], format: config.DEFAULT_FORMAT, maxR: DEFAULT_MAXR, lead: DEFAULT_LEAD, minN: DEFAULT_MINN,
  count: DEFAULT_COUNT, sameMin: DEFAULT_SAME_MIN, inverseMin: DEFAULT_INVERSE_MIN,
  plan: null,          // { base, at, picks: [{ digit, target, from, suit, mode, pct, n, state }], rows: [...] } : choix pour la dizaine `base`
  planBase: -1,        // dernière dizaine pour laquelle un choix a été fait
  history: [],         // [{ base, digits: [..] }] : fins de numéro choisies aux dizaines passées (interdites à la dizaine suivante)
  follows: [],         // suivis prévus : { id, digit, target, suit, rule, state }
  pendingMessages: [], // prédictions envoyées (trio + suivi), en attente puis résolues
  stats: null, sentCount: 0, lastSentAt: null, duplicatesBlocked: 0, lastError: null, channelTitles: {},
};
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
const bot = () => (typeof sender === 'function' ? sender() : null);
const withTimeout = (p, ms, label) => { let t; const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} : délai de ${Math.round(ms / 1000)} s dépassé`)), ms); }); return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t)); };

const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const maxFinishedGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; };
const maxKnownGameNumber = () => { let m = 0; for (const g of state.games.values()) if ((g.finished || g.dealing) && g.number > m) m = g.number; return m; };
// main du joueur terminée sans attendre le banquier : 3 cartes, ou 2 cartes valant 6+ (il reste), cartes déjà arrivées
const playerFinal = (g) => !!g && (g.finished ? g.complete !== false : (Number(g.playerCards) >= 3 || (Number(g.playerCards) === 2 && Number(g.playerValue) >= 6)));
const hasPlayerCards = (g) => !!g && Array.isArray(g.player) && g.player.length > 0;
const maxPlayerFinalNumber = () => { let m = 0; for (const g of state.games.values()) if (playerFinal(g) && g.number > m) m = g.number; return m; };
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const emptySide = () => ({ sent: 0, won: 0, lost: 0, byStep: {} });
const statsOf = () => {
  const s = panel.stats && typeof panel.stats === 'object' ? panel.stats : {};
  panel.stats = { main: { ...emptySide(), ...(s.main || {}) }, follow: { ...emptySide(), ...(s.follow || {}) } };
  return panel.stats;
};

// ── choix des fins de numéro pour la dizaine `base` ─────────────────────────
// snap : résultat de end-digit.analyze() ; renvoie { picks, rows }
function choose(snap, base) {
  const prev = panel.history.find((h) => h.base === base - 10);
  const banned = new Set(prev ? prev.digits : []);
  const rows = []; const cands = [];
  for (let digit = 0; digit < 10; digit++) {
    const d = snap.digits[digit];
    const best = d && d.player && Array.isArray(d.player.ranked) ? d.player.ranked[0] : null;
    const from = best ? strategies.normSuit(best.suit) : null;
    const row = { digit, from, pct: best ? Number(best.pct) : null, n: d ? d.n : 0, decision: '' };
    rows.push(row);
    if (base + digit < 1) { row.decision = 'jeu n°0 inexistant'; continue; }
    if (!d || !best || !from) { row.decision = 'pas de données'; continue; }
    if (d.n < panel.minN) { row.decision = `pas assez de jeux (${d.n}/${panel.minN})`; continue; }
    if (!(row.pct >= panel.sameMin)) { row.decision = `taux sous ${panel.sameMin} %`; continue; }
    if (banned.has(digit)) { row.decision = 'interdite (prédite à la dizaine précédente)'; continue; }
    cands.push({ digit, from, pct: row.pct, n: d.n, mode: row.pct >= panel.inverseMin ? 'inverse' : 'meme', row });
  }
  cands.sort((a, b) => b.pct - a.pct || a.digit - b.digit);
  const picks = [];
  for (const [i, c] of cands.entries()) {
    if (i >= panel.count) { c.row.decision = `hors du top ${panel.count}`; continue; }
    const suit = c.mode === 'inverse' ? INVERSE[c.from] : c.from;
    if (!suit) { c.row.decision = 'costume inconnu'; continue; }
    c.row.decision = c.mode === 'inverse' ? `prédit l'inverse ${suit}` : `prédit ${suit}`;
    c.row.suit = suit; c.row.mode = c.mode;
    picks.push({ digit: c.digit, target: base + c.digit, from: c.from, suit, mode: c.mode, pct: c.pct, n: c.n, state: 'prévu' });
  }
  picks.sort((a, b) => a.target - b.target);
  return { picks, rows };
}

let planRetryAt = 0;
// décide s'il faut faire le choix d'une nouvelle dizaine (dizaine passée terminée, pas encore traitée)
async function maybePlan() {
  const F = maxFinishedGameNumber();
  if (!F || Date.now() < planRetryAt) return false;
  const cur = Math.floor(F / 10) * 10;
  const completed = F % 10 === 9 ? cur : cur - 10; // dernière dizaine entièrement terminée
  if (completed < 0) return false; // aucune dizaine terminée dans ce sabot
  const planFor = completed + 10; // dizaine à prédire
  if (planFor <= panel.planBase) return false;
  let snap = null;
  try { snap = await withTimeout(endDigit.analyze(5000), ANALYSE_MAX_MS, 'analyse fin de numéro'); } catch (_) { snap = null; }
  if (!snap || !Array.isArray(snap.digits)) { try { snap = endDigit.cached(); } catch (_) { snap = null; } }
  if (!snap || !Array.isArray(snap.digits) || snap.digits.length < 10) { planRetryAt = Date.now() + 15000; return false; }
  const { picks, rows } = choose(snap, planFor);
  panel.plan = { base: planFor, from: planFor - 10, at: Date.now(), picks, rows };
  panel.planBase = planFor;
  panel.history = [...panel.history.filter((h) => h.base !== planFor), { base: planFor, digits: picks.map((p) => p.digit) }].slice(-HISTORY_MAX);
  return true;
}

// ── envoi / édition ─────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, { gameNumber: entry.target, suit: entry.suit, strategy: entry.kind === 'follow' ? 'Fin de numéro suivi' : 'Fin de numéro trio', maxR: entry.maxR, status: statusFr, rattrapage: entry.step || 0 }, null);
}
async function sendToChannels(out, channels) {
  const b = bot();
  if (!b) { panel.lastError = 'Aucun token Telegram configuré'; return []; }
  const results = await Promise.all((channels || []).map((id) => withTimeout(b.sendMessage(id, out.text, out.parse_mode ? { parse_mode: out.parse_mode } : {}), SEND_MAX_MS, 'envoi Telegram')
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

// jeu en direct supérieur au numéro à prédire → ignorée ; main du joueur déjà arrivée → ignorée
function canTarget(target) {
  if (maxKnownGameNumber() > target) return false;
  return !hasPlayerCards(state.games.get(target));
}
const inflight = new Set();
// un numéro de jeu revient chaque jour (le sabot repart à #1 à 00h00) : un doublon n'existe que dans le sabot en cours
const DUP_WINDOW_MS = 2 * 3600 * 1000;
const isDuplicate = (kind, target, suit) => panel.pendingMessages.some((s) => s.kind === kind && s.target === target && s.suit === suit && (s.status === 'en attente' || Date.now() - (Number(s.createdAt) || 0) < DUP_WINDOW_MS));
async function launch(kind, p) {
  const channels = kind === 'follow' ? panel.followChannels : panel.channels;
  if (!channels.length) return false;
  if (!canTarget(p.target)) return false;
  const key = `${kind}:${p.target}:${p.suit}`;
  if (isDuplicate(kind, p.target, p.suit) || inflight.has(key)) { panel.duplicatesBlocked += 1; return false; }
  inflight.add(key);
  try {
    const entry = { id: `edt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: 'end-digit-trio', kind, suit: p.suit, target: p.target, digit: p.digit, pct: p.pct, mode: p.mode || p.rule || null, maxR: panel.maxR, format: panel.format, step: 0, status: 'en attente', messages: [], createdAt: Date.now(), resolvedAt: null };
    entry.messages = await sendToChannels(renderFor(entry, null), channels);
    if (!entry.messages.length) return false;
    panel.pendingMessages.push(entry);
    const st = statsOf()[kind]; st.sent += 1; panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null;
    return true;
  } finally { inflight.delete(key); }
}

// ── suivi : la prédiction du trio vient d'être vérifiée ─────────────────────
function queueFollow(entry, verdict, hitAt) {
  if (!panel.followChannels.length) return;
  const direct = verdict === 'gagné' && hitAt === 0; // ✅0️⃣ : venu directement
  const suit = direct ? INVERSE[entry.suit] : entry.suit;
  if (!suit) return;
  const target = Math.floor(entry.target / 10) * 10 + 10 + entry.digit; // même fin de numéro, dizaine suivante
  if (panel.follows.some((f) => f.target === target && f.suit === suit && f.state === 'prévu')) return;
  panel.follows.push({ id: `edf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, digit: entry.digit, target, suit, rule: direct ? 'inverse' : 'meme',
    fromTarget: entry.target, fromSuit: entry.suit, result: verdict === 'gagné' ? (hitAt === 0 ? '✅0️⃣' : `✅${hitAt}`) : '❌', state: 'prévu', createdAt: Date.now() });
  if (panel.follows.length > FOLLOWS_MAX) panel.follows = panel.follows.slice(-FOLLOWS_MAX);
}

// ── nouveau sabot ───────────────────────────────────────────────────────────
// À 00h00 (heure d'Abidjan) le jeu repart à #1 : le choix de la veille, les suivis prévus et les prédictions en attente n'ont plus de sens.
function rebaseForNewShoe() {
  let changed = false;
  for (const s of panel.pendingMessages) if (s.status === 'en attente') { s.status = 'annulé'; s.resolvedAt = Date.now(); changed = true; }
  if (panel.plan || panel.planBase !== -1 || panel.history.length || panel.follows.length) changed = true;
  panel.plan = null; panel.planBase = -1; panel.history = []; panel.follows = []; planRetryAt = 0;
  inflight.clear();
  if (changed) persist();
  return changed;
}
setOnShoeReset(() => { try { rebaseForNewShoe(); } catch (e) { panel.lastError = e.message; } });

// ── cycle (appelé à chaque passage du bot) ──────────────────────────────────
let ticking = false, tickStartedAt = 0, tickSeq = 0;
async function tick() {
  if (ticking) {
    if (Date.now() - tickStartedAt < TICK_MAX_MS) return; // un passage resté bloqué est abandonné au bout de 90 s
    panel.lastError = 'passage bloqué : reprise forcée'; inflight.clear();
  }
  ticking = true; tickStartedAt = Date.now(); const myTick = ++tickSeq;
  try {
    let changed = false;
    const knownNow = maxKnownGameNumber();
    if (knownNow) {
      const stalePlan = panel.planBase > knownNow + STALE_AHEAD;
      const stalePending = panel.pendingMessages.some((s) => s.status === 'en attente' && s.target > knownNow + STALE_AHEAD);
      if (stalePlan || stalePending) { rebaseForNewShoe(); changed = true; }
    }
    // une prédiction « en attente » trop ancienne (jeu jamais reçu, redémarrage, coupure…) est libérée
    for (const s of panel.pendingMessages) if (s.status === 'en attente' && Date.now() - (Number(s.createdAt) || 0) > PENDING_MAX_MS) { s.status = 'annulé'; s.resolvedAt = Date.now(); changed = true; }
    const maxDone = maxPlayerFinalNumber();
    // 1) résultat des prédictions envoyées (jeu N puis rattrapages N+1 … N+maxR) ; trio vérifié → suivi prévu
    if (maxDone) {
      const verdictOf = (e) => {
        let verdict = null; let hitAt = -1;
        for (let k = 0; k <= e.maxR; k++) {
          const g = state.games.get(e.target + k);
          if (!hasPlayerCards(g)) { if (e.target + k + 2 <= maxDone) verdict = 'annulé'; break; }
          if (hasSuit(g, e.suit)) { verdict = 'gagné'; hitAt = k; break; } // ✅ dès que le costume est dans la main du joueur
          if (!playerFinal(g)) break; // le joueur peut encore tirer : pas de perte tant que sa main n'est pas terminée
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
        strategyRecap.noteEntry(s);
        editSent(s, r.verdict);
        const st = statsOf()[s.kind === 'follow' ? 'follow' : 'main'];
        if (r.verdict === 'gagné') { st.won += 1; st.byStep[s.step] = (st.byStep[s.step] || 0) + 1; } else { st.lost += 1; }
        if (s.kind !== 'follow') queueFollow(s, r.verdict, r.hitAt);
      }
      for (const s of panel.pendingMessages) {
        if (!s.editFail || Date.now() - s.editFail < 8000) continue;
        s.editFail = null;
        if (s.status === 'gagné' || s.status === 'perdu') editSent(s, s.status); else if (s.status === 'en attente') editSent(s, null);
      }
    }
    // 2) fin de dizaine : choix des fins de numéro de la dizaine suivante
    if (panel.enabled && panel.channels.length && (await maybePlan())) changed = true;
    // 3) envoi des prédictions du trio : quand le jeu en direct est à « avance » jeux du numéro visé
    const known = maxKnownGameNumber();
    if (panel.enabled && panel.channels.length && panel.plan && known) {
      for (const p of panel.plan.picks) {
        if (p.state !== 'prévu') continue;
        if (!canTarget(p.target)) { p.state = 'ignoré'; changed = true; continue; } // jeu déjà commencé / passé
        if (known < p.target - panel.lead) continue;
        const sent = await launch('main', p);
        if (sent || isDuplicate('main', p.target, p.suit)) { p.state = 'envoyé'; changed = true; } // un envoi raté est retenté au passage suivant
      }
    }
    // 4) envoi des suivis (autre canal)
    if (panel.enabled && known) {
      for (const f of panel.follows) {
        if (f.state !== 'prévu') continue;
        if (!panel.followChannels.length || !canTarget(f.target)) { f.state = 'ignoré'; changed = true; continue; }
        if (known < f.target - panel.lead) continue;
        const sent = await launch('follow', f);
        if (sent || isDuplicate('follow', f.target, f.suit)) { f.state = 'envoyé'; changed = true; }
      }
    }
    const before = panel.pendingMessages.length + panel.follows.length;
    panel.pendingMessages = [...panel.pendingMessages.filter((s) => s.status !== 'en attente').slice(-SENT_RESOLVED_MAX), ...panel.pendingMessages.filter((s) => s.status === 'en attente')];
    panel.follows = panel.follows.filter((f) => f.state === 'prévu' || Date.now() - (Number(f.createdAt) || 0) < 24 * 3600 * 1000).slice(-FOLLOWS_MAX);
    if (changed || panel.pendingMessages.length + panel.follows.length !== before) persist();
  } catch (e) { panel.lastError = e.message; }
  finally { if (tickSeq === myTick) ticking = false; }
}

// ── réglages ────────────────────────────────────────────────────────────────
function config_() {
  return { enabled: panel.enabled, channels: [...panel.channels], followChannels: [...panel.followChannels], format: panel.format, maxR: panel.maxR, lead: panel.lead, minN: panel.minN, count: panel.count, sameMin: panel.sameMin, inverseMin: panel.inverseMin };
}
function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = loss.parseChannels(patch.channels);
  if (patch.followChannels !== undefined) panel.followChannels = loss.parseChannels(patch.followChannels);
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.maxR !== undefined) panel.maxR = clampInt(patch.maxR, 0, 9, DEFAULT_MAXR);
  if (patch.lead !== undefined) panel.lead = clampInt(patch.lead, 1, 20, DEFAULT_LEAD);
  if (patch.minN !== undefined) panel.minN = clampInt(patch.minN, 1, 5000, DEFAULT_MINN);
  if (patch.count !== undefined) panel.count = clampInt(patch.count, 1, 10, DEFAULT_COUNT);
  if (patch.sameMin !== undefined) panel.sameMin = clampInt(patch.sameMin, 1, 100, DEFAULT_SAME_MIN);
  if (patch.inverseMin !== undefined) panel.inverseMin = clampInt(patch.inverseMin, 1, 100, DEFAULT_INVERSE_MIN);
  if (panel.inverseMin < panel.sameMin) panel.inverseMin = panel.sameMin;
  persist();
  return config_();
}
function unblockAll() {
  let n = 0;
  for (const s of panel.pendingMessages) if (s.status === 'en attente') { s.status = 'annulé'; s.resolvedAt = Date.now(); n += 1; }
  inflight.clear(); panel.lastError = null;
  return n;
}
function unblock() { const n = unblockAll(); persist(); return n; }
function resetStats() { panel.stats = null; unblockAll(); panel.plan = null; panel.history = []; panel.follows = []; planRetryAt = 0; persist(); } // planBase gardé : le prochain choix a lieu à la fin de la dizaine
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }

async function test() {
  if (!panel.channels.length && !panel.followChannels.length) return { ok: false, error: 'Renseigne le canal où envoyer les prédictions.' };
  const sentTo = [];
  for (const [kind, chans] of [['main', panel.channels], ['follow', panel.followChannels]]) {
    if (!chans.length) continue;
    const out = renderFor({ kind, format: panel.format, target: 1234, suit: '♦️', maxR: panel.maxR, step: 0 }, null);
    const sent = await sendToChannels({ ...out, text: `🧪 Test ${kind === 'follow' ? '(suivi)' : '(trio)'}\n${out.text}` }, chans);
    sent.forEach((m) => sentTo.push(m.chatId));
  }
  return sentTo.length ? { ok: true, sent: sentTo } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

function status() {
  const st = statsOf();
  const side = (x) => { const resolved = x.won + x.lost; return { sent: x.sent, won: x.won, lost: x.lost, resolved, rate: pct(x.won, resolved), steps: Object.entries(x.byStep || {}).map(([k, n]) => ({ step: Number(k), n: Number(n) })).sort((a, b) => a.step - b.step) }; };
  const known = maxKnownGameNumber();
  const waiting = panel.pendingMessages.filter((s) => s.status === 'en attente').length;
  const plan = panel.plan;
  const F = maxFinishedGameNumber();
  return {
    ...config_(),
    plan: plan ? { base: plan.base, from: plan.from, at: plan.at, picks: plan.picks.map((p) => ({ digit: p.digit, target: p.target, from: p.from, suit: p.suit, mode: p.mode, pct: p.pct, n: p.n, state: p.state })), rows: plan.rows } : null,
    nextAnalysisAfter: F ? (Math.floor(F / 10) * 10 + 9) : null,
    forbidden: (panel.history.find((h) => plan && h.base === plan.base) || { digits: [] }).digits,
    follows: panel.follows.filter((f) => f.state === 'prévu').map((f) => ({ digit: f.digit, target: f.target, suit: f.suit, rule: f.rule, fromTarget: f.fromTarget, fromSuit: f.fromSuit, result: f.result })),
    main: side(st.main), follow: side(st.follow), sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, duplicatesBlocked: panel.duplicatesBlocked,
    won: st.main.won + st.follow.won, lost: st.main.lost + st.follow.lost, waiting, live: known || null,
    recent: panel.pendingMessages.slice(-16).reverse().map((s) => ({ kind: s.kind, target: s.target, digit: s.digit, suit: s.suit, pct: s.pct, mode: s.mode, status: s.status, step: s.step, maxR: s.maxR })),
    channelNames: panel.channels.map((id) => panel.channelTitles[String(id)] || String(id)),
    followChannelNames: panel.followChannels.map((id) => panel.channelTitles[String(id)] || String(id)),
    lastError: panel.lastError,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
// v128 : tout est envoyé à Supabase (réglage « end_digit_trio_state »). Si la base est coupée au moment de l'enregistrement,
// l'état local reste « en attente d'envoi » (dbDirty) : à la reconnexion il est POUSSÉ vers Supabase au lieu d'être écrasé par l'ancienne valeur.
let dbDirty = false;
function persist() {
  const saved = { config: config_(), plan: panel.plan, planBase: panel.planBase, history: panel.history, follows: panel.follows, pendingMessages: panel.pendingMessages, stats: panel.stats, sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, channelTitles: panel.channelTitles };
  try { store.patch({ [STORE_KEY]: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).then(() => { dbDirty = false; }).catch((e) => { panel.lastError = e.message; dbDirty = true; });
  else dbDirty = true;
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  const c = saved.config || {};
  panel.enabled = c.enabled === true; panel.channels = loss.parseChannels(c.channels); panel.followChannels = loss.parseChannels(c.followChannels);
  panel.format = fmt.clampFormat(c.format || config.DEFAULT_FORMAT); panel.maxR = clampInt(c.maxR, 0, 9, DEFAULT_MAXR);
  panel.lead = clampInt(c.lead, 1, 20, DEFAULT_LEAD); panel.minN = clampInt(c.minN, 1, 5000, DEFAULT_MINN);
  panel.count = clampInt(c.count, 1, 10, DEFAULT_COUNT); panel.sameMin = clampInt(c.sameMin, 1, 100, DEFAULT_SAME_MIN); panel.inverseMin = clampInt(c.inverseMin, 1, 100, DEFAULT_INVERSE_MIN);
  if (panel.inverseMin < panel.sameMin) panel.inverseMin = panel.sameMin;
  panel.plan = saved.plan && typeof saved.plan === 'object' && Array.isArray(saved.plan.picks) ? saved.plan : null;
  panel.planBase = Number.isInteger(saved.planBase) ? saved.planBase : (panel.plan ? panel.plan.base : -1);
  panel.history = Array.isArray(saved.history) ? saved.history.filter((h) => h && Number.isInteger(h.base) && Array.isArray(h.digits)).slice(-HISTORY_MAX) : [];
  panel.follows = Array.isArray(saved.follows) ? saved.follows.filter((f) => f && f.id).slice(-FOLLOWS_MAX) : [];
  panel.pendingMessages = Array.isArray(saved.pendingMessages) ? saved.pendingMessages.filter((s) => s && s.id).slice(-(SENT_RESOLVED_MAX + 50)) : [];
  panel.stats = saved.stats && typeof saved.stats === 'object' ? saved.stats : null;
  panel.sentCount = Number(saved.sentCount) || 0; panel.lastSentAt = saved.lastSentAt || null;
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
}
function restore() { try { const s = (store.read() || {})[STORE_KEY]; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  if (dbDirty) { persist(); return; } // changements faits pendant la coupure : on les envoie à Supabase, on ne les écrase pas
  try { const raw = await db.getSetting(DB_KEY); if (raw) { applySaved(JSON.parse(raw)); persist(); } else persist(); } catch (_) { persist(); }
}

// v128 : NOUVEAU DÉPART de 00h00 (heure d'Abidjan), appelé par midnight-reset.js. Efface TOUTES les données du jour de cette stratégie
// (choix de la dizaine, fins interdites, suivis, prédictions envoyées, bilans gagné/perdu du trio et du suivi, compteurs) puis envoie l'état vide
// à Supabase. Les RÉGLAGES (canaux, format, rattrapages, seuils, on/off) et les noms de canaux sont conservés.
function wipeDay() {
  panel.plan = null; panel.planBase = -1; panel.history = []; panel.follows = []; panel.pendingMessages = [];
  panel.stats = null; panel.sentCount = 0; panel.lastSentAt = null; panel.duplicatesBlocked = 0; panel.lastError = null;
  planRetryAt = 0; inflight.clear();
  persist();
}

module.exports = { panel, setSender, restore, restoreFromDb, persist, tick, wipeDay, status, test, config: config_, configure, resetStats, unblock, setChannelTitle, choose };
