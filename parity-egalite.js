// parity-egalite.js — « Palier parité égalité » (nouvelle stratégie, demande admin), branchée sur le « Compte parité ».
//
// Elle lit le même PALIER que « Palier parité » (une ligne par fin de numéro 0-9, pourcentage de chaque costume dans la main du
// JOUEUR, ex. « #511 ➔ (❤️40%) (♦️30%) (♠️15%) (♣️15%) »), mais elle ne prédit que les lignes où DEUX costumes (ou plus) sont à égalité
// au taux le plus FAIBLE.
//
// Règles :
//   • ligne déclenchante : au moins deux costumes au même taux le plus faible (comparaison sur les pourcentages entiers affichés) ;
//   • costume prédit : on ne prédit PAS un des costumes à égalité, mais celui du DEUXIÈME taux parmi les 4 (le taux juste au-dessus du
//     taux faible commun). Si ce deuxième taux est lui aussi partagé par plusieurs costumes (ou s'il n'existe pas : 4 taux égaux),
//     pas de prédiction pour cette fin de numéro ;
//   • jeu visé : la ligne « fin d » du palier de la dizaine passée vise le jeu de même fin dans la dizaine suivante, plus le DÉCALAGE
//     choisi (+0 ou +3). Palier #510-#519, ligne #511 : +0 → jeu 521 ; +3 → jeu 524 ;
//   • envoi : la prédiction part quand le jeu en direct est à « Envoi à N jeux avant » (2 par défaut) du jeu visé : jeu visé 521 →
//     envoyée au jeu 519 (jeu visé 10 → envoyée au jeu 8). Si le palier n'est pas encore figé à ce moment-là, elle part dès qu'il l'est ;
//   • palier figé par dizaine, comme « Palier parité » : dès que la main du joueur du jeu finissant par 9 est terminée (sans attendre le
//     banquier) ; il ne bouge plus ensuite ;
//   • rattrapages (3 par défaut : jeu N, N+1, N+2, N+3) ; résultat ✅ dès que le costume apparaît dans la main du joueur, ❌ quand la
//     main est terminée au dernier rattrapage ; le message est édité ;
//   • pas d'enchaînement : plusieurs prédictions peuvent être en cours en même temps ;
//   • un jeu déjà commencé n'est jamais prédit. Main du joueur uniquement.
//   • v132 — RÉGLAGE « Costume déjà venu N fois de suite → son inverse » (0 = désactivé) : avant l'envoi, si le costume à prédire est venu dans
//     la main du joueur à chacun des N jeux juste avant le jeu visé (ex. réglage 2 : ❤️ aux jeux 10 et 11, prédiction ❤️ au jeu 12) → on
//     prédit l'INVERSE à la place (❤️ → ♣️, ♦️ → ♠️, et réciproquement). Tant que ces jeux ne sont pas tous connus, la prédiction attend
//     (voir suit-consecutive.js).
'use strict';
const strategyRecap = require('./strategy-recap');

const store = require('./store');
const db = require('./db');
const fmt = require('./formats');
const config = require('./config');
const loss = require('./loss-return'); // liste d'ID de canaux (parseChannels)
const parityCounter = require('./parity-counter');
const consecutive = require('./suit-consecutive'); // v132 : costume venu N fois de suite → inverse
const { state, hasSuit, setOnShoeReset } = require('./predictor');

const DB_KEY = 'parity_egalite_state';
const STORE_KEY = 'parityEgalite';
const CFG_ID = 'parity-egalite';
const NAME = 'Palier parité égalité';
const DEFAULT_MAXR = 3, DEFAULT_MINN = 1, DEFAULT_SENDAT = 2, DEFAULT_OFFSET = 0, DEFAULT_CONSEC = 0, QUEUE_MAX = 60;
const OFFSETS = [0, 3];
const SENT_RESOLVED_MAX = 100;

const panel = {
  enabled: false, channels: [], format: config.DEFAULT_FORMAT, maxR: DEFAULT_MAXR, minN: DEFAULT_MINN, sendAt: DEFAULT_SENDAT, offset: DEFAULT_OFFSET, consec: DEFAULT_CONSEC,
  frozen: null,        // palier figé { source: 510, rows: [{ digit, total, cells }] }
  queue: [],           // lignes retenues au gel du palier : { source, digit, suit, pct, done }
  pendingMessages: [], // prédictions envoyées (en attente puis résolues)
  stats: null, sentCount: 0, lastSentAt: null, duplicatesBlocked: 0, lastError: null, channelTitles: {},
};
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
const bot = () => (typeof sender === 'function' ? sender() : null);
const SEND_MAX_MS = 20000, TICK_MAX_MS = 90000, PENDING_MAX_MS = 20 * 60 * 1000;
// v124 : un envoi / une édition Telegram qui ne répond jamais ne doit plus figer le panneau
const withTimeout = (p, ms, label) => { let t; const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} : délai de ${Math.round(ms / 1000)} s dépassé`)), ms); }); return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t)); };

const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const clampOffset = (v) => { const n = parseInt(v, 10); return OFFSETS.includes(n) ? n : DEFAULT_OFFSET; };
const maxKnownGameNumber = () => { let m = 0; for (const g of state.games.values()) if ((g.finished || g.dealing) && g.number > m) m = g.number; return m; };
// main du joueur terminée sans attendre le banquier : 3 cartes, ou 2 cartes valant 6+ (il reste), cartes déjà arrivées
const playerFinal = (g) => !!g && (g.finished ? g.complete !== false : (Number(g.playerCards) >= 3 || (Number(g.playerCards) === 2 && Number(g.playerValue) >= 6)));
const hasPlayerCards = (g) => !!g && Array.isArray(g.player) && g.player.length > 0;
const maxPlayerFinalNumber = () => { let m = 0; for (const g of state.games.values()) if (playerFinal(g) && g.number > m) m = g.number; return m; };
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const emptyStats = () => ({ sent: 0, won: 0, lost: 0, swapped: 0, byStep: {} });
const statsOf = () => { panel.stats = panel.stats && typeof panel.stats === 'object' ? { ...emptyStats(), ...panel.stats } : emptyStats(); return panel.stats; };

// ── choix du costume d'une ligne du palier ──────────────────────────────────
// cells : [{ suit, count, pct }] (pourcentages entiers). Renvoie { suit, pct } (costume du DEUXIÈME taux) ou { reason } si pas de prédiction.
function analyse(cells, minN = 1, total = null) {
  if (!Array.isArray(cells) || cells.length < 2) return { reason: 'pas de données' };
  const sum = total != null ? total : cells.reduce((n, c) => n + (c.count || 0), 0);
  if (!sum || sum < minN) return { reason: 'pas assez de données' };
  const rates = [...new Set(cells.map((c) => c.pct))].sort((a, b) => a - b);
  if (cells.filter((c) => c.pct === rates[0]).length < 2) return { reason: 'un seul taux le plus faible' };
  if (rates.length < 2) return { reason: 'les 4 taux sont égaux' };
  const second = cells.filter((c) => c.pct === rates[1]);
  if (second.length !== 1) return { reason: 'égalité au deuxième taux' };
  return { suit: second[0].suit, pct: second[0].pct };
}
const pickSecond = (cells, minN = 1, total = null) => { const r = analyse(cells, minN, total); return r.suit ? { suit: r.suit, pct: r.pct } : null; };

// fige le palier de la dizaine `source` et retient les lignes à prédire (le jeu visé est calculé à l'envoi avec le décalage en vigueur)
function freezePalier(source) {
  const rows = parityCounter.palier('player');
  const g = state.games.get(source + 9);
  if (g && hasPlayerCards(g) && parityCounter.state.lastGameNumber !== g.number) {
    const row = rows[9];
    for (const x of g.playerSuits || []) { const c = row.cells.find((cc) => cc.suit === x); if (c) { c.count += 1; row.total += 1; } }
    for (const c of row.cells) c.pct = row.total ? Math.round((c.count / row.total) * 100) : 0;
  }
  panel.frozen = { source, at: Date.now(), rows };
  for (const r of rows) {
    const pick = pickSecond(r.cells, panel.minN, r.total);
    if (pick) panel.queue.push({ source, digit: r.digit, suit: pick.suit, pct: pick.pct, done: false });
  }
  panel.queue = panel.queue.slice(-QUEUE_MAX);
}

// ── envoi / édition ─────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, { gameNumber: entry.target, suit: entry.suit, strategy: NAME, maxR: entry.maxR, status: statusFr, rattrapage: entry.step || 0 }, null);
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

// comparaison avant toute prédiction : jeu en direct supérieur au numéro à prédire → ignorée ; main du joueur déjà arrivée → ignorée
function canTarget(target) {
  const live = maxKnownGameNumber();
  if (live > target) return false;
  return !hasPlayerCards(state.games.get(target));
}
const inflight = new Set();
// v123 : un numéro de jeu revient chaque jour (le sabot repart à #1 à 00h00) : un doublon n'existe que dans le sabot en cours
const DUP_WINDOW_MS = 2 * 3600 * 1000;
const isDuplicate = (target, suit) => panel.pendingMessages.some((s) => s.target === target && s.suit === suit && (s.status === 'en attente' || Date.now() - (Number(s.createdAt) || 0) < DUP_WINDOW_MS));
async function launch(target, digit, suit, lowPct, meta) {
  if (!panel.channels.length) return false;
  if (!canTarget(target)) return false;
  const key = `${target}:${suit}`;
  if (isDuplicate(target, suit) || inflight.has(key)) { panel.duplicatesBlocked += 1; return false; }
  inflight.add(key);
  try {
    const entry = { id: `pe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: CFG_ID, suit, target, digit, pct: lowPct, maxR: panel.maxR, format: panel.format, step: 0, status: 'en attente', messages: [], createdAt: Date.now(), resolvedAt: null };
    if (meta && meta.swapped) { entry.from = meta.from; entry.swapped = true; entry.streak = panel.consec; } // v132 : costume remplacé par son inverse
    entry.messages = await sendToChannels(renderFor(entry, null));
    if (!entry.messages.length) return false;
    panel.pendingMessages.push(entry);
    const st = statsOf(); st.sent += 1; if (entry.swapped) st.swapped = (st.swapped || 0) + 1; panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null;
    return true;
  } finally { inflight.delete(key); }
}
const targetOf = (q) => q.source + 10 + q.digit + panel.offset;

// ── nouveau sabot (v123) ────────────────────────────────────────────────────
// À 00h00 (heure d'Abidjan) le jeu repart à #1 : le palier figé, les lignes retenues (jeux visés ≈ #1440) et les prédictions en attente
// de la veille ne peuvent plus servir. Elles sont retirées ; le premier palier du nouveau sabot se fige au jeu 9.
const STALE_AHEAD = 60;
function resetForNewShoe() {
  let changed = false;
  for (const s of panel.pendingMessages) if (s.status === 'en attente') { s.status = 'annulé'; s.resolvedAt = Date.now(); changed = true; }
  if (panel.queue.length) { panel.queue = []; changed = true; }
  if (panel.frozen) { panel.frozen = null; changed = true; }
  inflight.clear();
  if (changed) persist();
  return changed;
}
setOnShoeReset(() => { try { resetForNewShoe(); } catch (e) { panel.lastError = e.message; } });

// ── cycle (appelé à chaque passage du bot) ──────────────────────────────────
let ticking = false, tickStartedAt = 0, tickSeq = 0;
async function tick() {
  if (ticking) {
    // v124 : un passage resté bloqué (envoi Telegram sans réponse…) est abandonné au bout de 90 s : le suivant reprend la main
    if (Date.now() - tickStartedAt < TICK_MAX_MS) return;
    panel.lastError = 'passage bloqué : reprise forcée'; inflight.clear();
  }
  ticking = true; tickStartedAt = Date.now(); const myTick = ++tickSeq;
  try {
    let changed = false;
    // sécurité : état resté d'un sabot précédent (relance du serveur pendant le changement de jour…)
    const knownNow = maxKnownGameNumber();
    if (knownNow) {
      const staleFrozen = panel.frozen && panel.frozen.source > knownNow + 20;
      const stalePending = panel.pendingMessages.some((s) => s.status === 'en attente' && s.target > knownNow + STALE_AHEAD);
      if (staleFrozen || stalePending) { resetForNewShoe(); changed = true; }
    }
    // v124 : une prédiction « en attente » trop ancienne (jeu jamais reçu, redémarrage, coupure…) est libérée : elle ne bloque plus la suivante
    for (const s of panel.pendingMessages) if (s.status === 'en attente' && Date.now() - (Number(s.createdAt) || 0) > PENDING_MAX_MS) { s.status = 'annulé'; s.resolvedAt = Date.now(); changed = true; }
    const maxDone = maxPlayerFinalNumber();
    // 0) palier de la dizaine passée : figé dès que la main du joueur du jeu x9 est terminée
    for (let src = Math.floor(maxKnownGameNumber() / 10) * 10; src >= 0 && src > ((panel.frozen && panel.frozen.source) ?? -1); src -= 10) {
      if (playerFinal(state.games.get(src + 9))) { freezePalier(src); changed = true; break; }
    }
    // 1) résultat des prédictions envoyées (jeu N puis rattrapages N+1 … N+maxR)
    if (maxDone) {
      const verdictOf = (e) => {
        let verdict = null; let hitAt = -1;
        for (let k = 0; k <= e.maxR; k++) {
          const g = state.games.get(e.target + k);
          if (!hasPlayerCards(g)) { if (e.target + k + 2 <= maxDone) verdict = 'annulé'; break; }
          if (hasSuit(g, e.suit)) { verdict = 'gagné'; hitAt = k; break; }
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
        const st = statsOf();
        if (r.verdict === 'gagné') { st.won += 1; st.byStep[s.step] = (st.byStep[s.step] || 0) + 1; } else { st.lost += 1; }
      }
      for (const s of panel.pendingMessages) {
        if (!s.editFail || Date.now() - s.editFail < 8000) continue;
        s.editFail = null;
        if (s.status === 'gagné' || s.status === 'perdu') editSent(s, s.status); else if (s.status === 'en attente') editSent(s, null);
      }
    }
    // 2) nouvelles prédictions : chaque ligne retenue part quand le jeu en direct est à `sendAt` jeux du jeu visé (jeu 8 → jeu 10)
    if (panel.enabled && panel.channels.length) {
      const known = maxKnownGameNumber();
      if (known) {
        for (const q of panel.queue) {
          if (q.done) continue;
          const target = targetOf(q);
          if (known > target) { q.done = true; changed = true; continue; } // jeu déjà commencé : plus à prédire
          if (known < target - panel.sendAt) continue;                       // trop tôt
          // v132 : réglage « costume venu N fois de suite → inverse » ; les jeux précédents pas tous connus → on attend (réessai au passage suivant)
          const dec = consecutive.decide(target, q.suit, panel.consec);
          if (dec.wait) continue;
          const sentOk = await launch(target, q.digit, dec.suit, q.pct, dec);
          q.tries = (Number(q.tries) || 0) + 1;
          // v124 : une prédiction qui n'a pas pu partir (envoi refusé / délai dépassé) est retentée au passage suivant, jusqu'au début du jeu visé
          if (sentOk || isDuplicate(target, dec.suit) || q.tries >= 30) q.done = true;
          changed = true;
        }
      }
    }
    panel.queue = panel.queue.filter((q) => !q.done).concat(panel.queue.filter((q) => q.done).slice(-20));
    const before = panel.pendingMessages.length;
    panel.pendingMessages = [...panel.pendingMessages.filter((s) => s.status !== 'en attente').slice(-SENT_RESOLVED_MAX), ...panel.pendingMessages.filter((s) => s.status === 'en attente')];
    if (changed || panel.pendingMessages.length !== before) persist();
  } catch (e) { panel.lastError = e.message; }
  finally { if (tickSeq === myTick) ticking = false; }
}

// ── réglages ────────────────────────────────────────────────────────────────
function config_() { return { enabled: panel.enabled, channels: [...panel.channels], format: panel.format, maxR: panel.maxR, minN: panel.minN, sendAt: panel.sendAt, offset: panel.offset, consec: panel.consec }; }
function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = loss.parseChannels(patch.channels);
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.maxR !== undefined) panel.maxR = clampInt(patch.maxR, 0, 9, DEFAULT_MAXR);
  if (patch.minN !== undefined) panel.minN = clampInt(patch.minN, 1, 5000, DEFAULT_MINN);
  if (patch.sendAt !== undefined) panel.sendAt = clampInt(patch.sendAt, 1, 10, DEFAULT_SENDAT);
  if (patch.offset !== undefined) panel.offset = clampOffset(patch.offset);
  if (patch.consec !== undefined) panel.consec = consecutive.clampNeed(patch.consec, DEFAULT_CONSEC);
  persist();
  return config_();
}
// v124 : libère TOUT ce qui était « en attente » (prédictions jamais vérifiées) ; les lignes retenues non échues restent
function unblockAll() {
  let n = 0;
  for (const s of panel.pendingMessages) if (s.status === 'en attente') { s.status = 'annulé'; s.resolvedAt = Date.now(); n += 1; }
  inflight.clear(); panel.lastError = null;
  return n;
}
function unblock() { const n = unblockAll(); persist(); return n; }
function resetStats() { panel.stats = emptyStats(); unblockAll(); panel.frozen = null; panel.queue = []; persist(); }
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }

async function test() {
  if (!panel.channels.length) return { ok: false, error: 'Renseigne le canal où envoyer les prédictions.' };
  const out = renderFor({ format: panel.format, target: 1234, suit: '♦️', maxR: panel.maxR, step: 0 }, null);
  const sent = await sendToChannels({ ...out, text: `🧪 Test\n${out.text}` });
  return sent.length ? { ok: true, sent: sent.map((m) => m.chatId) } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

function status() {
  const st = statsOf(); const resolved = st.won + st.lost;
  const fz = panel.frozen; const base = fz ? fz.source : null;
  const rows = (fz ? fz.rows : []).map((r) => {
    const a = analyse(r.cells, panel.minN, r.total);
    const sorted = r.cells.map((c, i) => ({ ...c, i })).sort((x, y) => y.count - x.count || x.i - y.i);
    return {
      digit: r.digit, label: base != null ? `#${base + r.digit}` : String(r.digit), total: r.total, cells: sorted.map(({ suit, pct: p }) => ({ suit, pct: p })),
      pick: a.suit || null, target: a.suit && base != null ? base + 10 + r.digit + panel.offset : null, reason: a.suit ? '' : a.reason,
    };
  });
  const waiting = panel.pendingMessages.filter((s) => s.status === 'en attente');
  const upcoming = panel.queue.filter((q) => !q.done).slice(0, 10).map((q) => ({ target: targetOf(q), digit: q.digit, suit: q.suit, pct: q.pct })).sort((a, b) => a.target - b.target);
  return {
    ...config_(), rows, frozenSource: fz ? fz.source : null, upcoming,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, duplicatesBlocked: panel.duplicatesBlocked, won: st.won, lost: st.lost, swapped: st.swapped || 0, resolved, rate: pct(st.won, resolved),
    steps: Object.entries(st.byStep || {}).map(([k, n]) => ({ step: Number(k), n: Number(n) })).sort((a, b) => a.step - b.step),
    waiting: waiting.length,
    recent: panel.pendingMessages.slice(-12).reverse().map((s) => ({ target: s.target, digit: s.digit, suit: s.suit, from: s.from || null, pct: s.pct, status: s.status, step: s.step, maxR: s.maxR })),
    channelNames: panel.channels.map((id) => panel.channelTitles[String(id)] || String(id)), lastError: panel.lastError,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { config: config_(), frozen: panel.frozen, queue: panel.queue, pendingMessages: panel.pendingMessages, stats: panel.stats, sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, channelTitles: panel.channelTitles };
  try { store.patch({ [STORE_KEY]: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  const c = saved.config || {};
  panel.enabled = c.enabled === true; panel.channels = loss.parseChannels(c.channels);
  panel.format = fmt.clampFormat(c.format || config.DEFAULT_FORMAT); panel.maxR = clampInt(c.maxR, 0, 9, DEFAULT_MAXR);
  panel.minN = clampInt(c.minN, 1, 5000, DEFAULT_MINN); panel.sendAt = clampInt(c.sendAt, 1, 10, DEFAULT_SENDAT); panel.offset = clampOffset(c.offset); panel.consec = consecutive.clampNeed(c.consec, DEFAULT_CONSEC);
  panel.frozen = saved.frozen && Array.isArray(saved.frozen.rows) && saved.frozen.rows.length === 10 ? saved.frozen : null;
  panel.queue = Array.isArray(saved.queue) ? saved.queue.filter((q) => q && Number.isInteger(q.source) && Number.isInteger(q.digit) && q.suit).slice(-QUEUE_MAX) : [];
  panel.pendingMessages = Array.isArray(saved.pendingMessages) ? saved.pendingMessages.filter((s) => s && s.id).slice(-(SENT_RESOLVED_MAX + 50)) : [];
  panel.stats = saved.stats && typeof saved.stats === 'object' ? saved.stats : null;
  panel.sentCount = Number(saved.sentCount) || 0; panel.lastSentAt = saved.lastSentAt || null;
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
  unblockAll(); // v124 : au redémarrage, rien ne reste bloqué « en attente »
}
function restore() { try { const s = (store.read() || {})[STORE_KEY]; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting(DB_KEY); if (raw) { applySaved(JSON.parse(raw)); persist(); } else persist(); } catch (_) { persist(); }
}

module.exports = { panel, setSender, restore, restoreFromDb, persist, tick, status, test, config: config_, configure, resetStats, unblock, setChannelTitle, pickSecond, analyse };
