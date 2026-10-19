// draw-two-three.js — nouvelle stratégie « Nul / 2-3 » (demande admin).
//
// Elle prédit TOUJOURS les deux ensemble : le MATCH NUL (noté « X ») ou la distribution 2/3
// (« 2/3 » = joueur 2 cartes, banquier 3 cartes), dans un seul message :
//
//       2/3 100%
//        ┣━ N°532
//       X    95%
//
//  Déclencheurs (jeu terminé N → jeu prédit) :
//    • 2/3 (joueur 2 cartes, banquier 3 cartes)          → N+1
//    • match nul avec joueur 2 / banquier 2 cartes        → N+1
//    • match nul avec joueur 3 / banquier 2 cartes        → N+2
//    • match nul avec joueur 3 / banquier 3 cartes        → N+3
//
//  Vérification (rattrapages configurables) : dès que l'un des deux sort, le message est édité avec le
//  résultat (✅0️⃣ = direct, ✅1️⃣ = 1er rattrapage…) et l'AUTRE est ignoré. Rien ne sort sur tous les
//  rattrapages : les deux sont ❌.
//
//  Règles de départ MODIFIABLES : les 4 déclencheurs ci-dessus sont des « règles ». L'analyse (historique
//  des jeux gardé sur plusieurs sabots) cherche des règles à AJOUTER, à MODIFIER (autre décalage) ou à
//  SUPPRIMER ; chaque trouvaille est envoyée dans le CHAT PRIVÉ de l'administrateur sous forme de liste de
//  boutons cliquables (« Appliquer ») — aussi disponible avec /nul et sur la page du site.
//
//  Pourcentages affichés : probabilité observée (jeux déjà joués du sabot) que 2/3, ou un match nul,
//  sorte dans la fenêtre « jeu prédit + rattrapages » après CE type de déclencheur (lissage de Laplace ;
//  taux général de la fenêtre si l'échantillon est trop petit). La page « Nul / 2-3 » montre aussi
//  l'analyse de la façon dont les matchs nuls viennent.
'use strict';
const strategyRecap = require('./strategy-recap');

const store = require('./store');
const db = require('./db');
const { state, addSiteChannelMessage, siteChannelsView, setOnShoeReset } = require('./predictor');

const STORE_KEY = 'drawTwoThree';
const DB_KEY = 'draw_two_three_state';

// règle = condition sur le jeu terminé (p = cartes joueur, b = cartes banquier, tie : true = nul, false = pas nul, null = peu importe) + décalage
const defaultRules = () => [
  { id: 'T23', p: 2, b: 3, tie: null, offset: 1, enabled: true },
  { id: 'N22', p: 2, b: 2, tie: true, offset: 1, enabled: true },
  { id: 'N32', p: 3, b: 2, tie: true, offset: 2, enabled: true },
  { id: 'N33', p: 3, b: 3, tie: true, offset: 3, enabled: true },
];
const OFFSETS = [1, 2, 3, 4, 5];
const MIN_N = 15;          // échantillon minimal pour qu'une trouvaille soit proposée
const GAIN_POINTS = 10;    // gain minimal (points de %) sur le taux général pour AJOUTER / MODIFIER (réduit si le taux général est déjà très haut, mini 5)
const DELETE_GAP = 5;      // règle sous le taux général de 5 points ou plus → SUPPRIMER
const MAX_FINDINGS = 6;
const ANALYSIS_EVERY = 25; // nouvelle analyse tous les 25 jeux enregistrés
const LOG_MAX = 8000;      // jeux gardés (plusieurs sabots)
const DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const digitEmoji = (n) => { const i = Math.max(0, parseInt(n, 10) || 0); return i < DIGITS.length ? DIGITS[i] : `(${i})`; };

const emptyStats = () => ({ sent: 0, won: 0, lost: 0, w23: 0, wX: 0 });
const panel = {
  enabled: true,
  notify: true,           // l'analyse écrit au chat privé quand elle trouve quelque chose
  channels: [],
  siteChannelId: null,
  maxR: 2,
  rules: defaultRules(),
  pending: [],
  stats: {},
  log: '',                // 1 caractère par jeu : 0-7 (voir codeOf), ? inconnu, | changement de sabot
  lastLogged: 0,
  loggedCount: 0,
  analysisMark: 0,
  notified: {},           // sid → date (trouvailles déjà envoyées)
  dismissed: {},          // sid → date (trouvailles ignorées)
  lastScanned: 0,
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastAnalysisAt: null,
  lastError: null,
};
const statsOf = (id) => panel.stats[id] || (panel.stats[id] = emptyStats());

let sender = null;
let adminIdFn = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
function setAdminId(fn) { adminIdFn = typeof fn === 'function' ? fn : null; }
const siteEntries = new Map(); // entryId → bulle du site
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
    if (/^-?\d+$/.test(t)) { const n = Number(t); if (Number.isFinite(n) && n !== 0 && !out.includes(n)) out.push(n); }
    else { const name = t.startsWith('@') ? t : `@${t.replace(/^https?:\/\/t\.me\//i, '')}`; if (name.length > 2 && !out.includes(name)) out.push(name); }
  }
  return out;
}
function sanitizeSiteChannelId(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value);
}
const sanitizeMaxR = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, Math.min(9, n)) : 2; };

function config() {
  return { enabled: panel.enabled, notify: panel.notify, channels: [...panel.channels], siteChannelId: panel.siteChannelId, maxR: panel.maxR };
}
function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.notify !== undefined) panel.notify = !!patch.notify;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  if (patch.siteChannelId !== undefined) panel.siteChannelId = sanitizeSiteChannelId(patch.siteChannelId);
  if (patch.maxR !== undefined) panel.maxR = sanitizeMaxR(patch.maxR);
  persist();
  return config();
}

// ---------------------------------------------------------------------------
// Persistance (data.json + base), comme cards-count.js
// ---------------------------------------------------------------------------
const trimMap = (o, max = 200) => { const e = Object.entries(o || {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, max); return Object.fromEntries(e); };
function persist() {
  const saved = {
    config: config(), rules: panel.rules, pending: panel.pending, stats: panel.stats, lastScanned: panel.lastScanned,
    log: panel.log, lastLogged: panel.lastLogged, loggedCount: panel.loggedCount, analysisMark: panel.analysisMark,
    notified: trimMap(panel.notified), dismissed: trimMap(panel.dismissed),
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt, lastAnalysisAt: panel.lastAnalysisAt,
  };
  try { store.patch({ [STORE_KEY]: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function sanitizeRule(r) {
  if (!r || typeof r !== 'object') return null;
  const p = r.p === null || r.p === undefined ? null : Number(r.p);
  const b = r.b === null || r.b === undefined ? null : Number(r.b);
  if ((p !== null && p !== 2 && p !== 3) || (b !== null && b !== 2 && b !== 3)) return null;
  const tie = r.tie === true ? true : r.tie === false ? false : null;
  const offset = Math.max(1, Math.min(9, parseInt(r.offset, 10) || 1));
  return { id: String(r.id || `R${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`), p, b, tie, offset, enabled: r.enabled !== false, auto: !!r.auto };
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  if (saved.config) {
    panel.enabled = saved.config.enabled !== false;
    panel.notify = saved.config.notify !== false;
    panel.channels = parseChannels(saved.config.channels);
    panel.siteChannelId = sanitizeSiteChannelId(saved.config.siteChannelId);
    panel.maxR = sanitizeMaxR(saved.config.maxR);
  }
  if (Array.isArray(saved.rules)) { const list = saved.rules.map(sanitizeRule).filter(Boolean); if (list.length) panel.rules = list; }
  if (Array.isArray(saved.pending)) panel.pending = saved.pending.slice(-200);
  if (saved.stats && typeof saved.stats === 'object') panel.stats = Object.fromEntries(Object.entries(saved.stats).map(([k, v]) => [k, { ...emptyStats(), ...(v || {}) }]));
  if (typeof saved.log === 'string') panel.log = saved.log.replace(/[^0-7?|]/g, '').slice(-LOG_MAX);
  for (const k of ['lastScanned', 'lastLogged', 'loggedCount', 'analysisMark', 'sentCount']) if (Number.isFinite(Number(saved[k]))) panel[k] = Number(saved[k]);
  if (saved.notified && typeof saved.notified === 'object') panel.notified = { ...saved.notified };
  if (saved.dismissed && typeof saved.dismissed === 'object') panel.dismissed = { ...saved.dismissed };
  panel.lastSentAt = saved.lastSentAt || null;
  panel.lastScanAt = saved.lastScanAt || null;
  panel.lastAnalysisAt = saved.lastAnalysisAt || null;
}
function restore() { try { applySaved((store.read() || {})[STORE_KEY]); } catch (_) {} return config(); }
async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting(DB_KEY);
    if (raw) applySaved(JSON.parse(raw)); else persist();
  } catch (_) { persist(); }
  return config();
}

// ---------------------------------------------------------------------------
// Lecture des jeux
// ---------------------------------------------------------------------------
const cardCount = (v) => (Array.isArray(v) ? v.length : (Number.isFinite(Number(v)) ? Number(v) : 0));
const usable = (g) => !!g && g.finished && g.complete !== false && cardCount(g.playerCards) > 0 && cardCount(g.bankerCards) > 0;
const isTie = (g) => !!g && (g.winner === 'Égalité' || (g.playerValue != null && g.bankerValue != null && g.playerValue === g.bankerValue));
function maxFinishedGameNumber() { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; }

// code d'un jeu : 4 si match nul + 2 si joueur 3 cartes + 1 si banquier 3 cartes (0-7) ; ? = inconnu
function codeOf(g) {
  if (!usable(g)) return '?';
  const p = cardCount(g.playerCards); const b = cardCount(g.bankerCards);
  if ((p !== 2 && p !== 3) || (b !== 2 && b !== 3)) return '?';
  return String((isTie(g) ? 4 : 0) + (p === 3 ? 2 : 0) + (b === 3 ? 1 : 0));
}
const decode = (ch) => { const c = Number(ch); return { tie: c >= 4, p: (c & 2) ? 3 : 2, b: (c & 1) ? 3 : 2 }; };
const is23c = (d) => d.p === 2 && d.b === 3;
const matchRule = (rule, d) => (rule.p === null || rule.p === d.p) && (rule.b === null || rule.b === d.b) && (rule.tie === null || rule.tie === d.tie);
const ruleLabel = (r) => `${r.tie === true ? 'Nul' : r.tie === false ? 'Hors nul' : 'Jeu'} ${r.p ?? '?'}/${r.b ?? '?'}`;
const ruleText = (r) => `${ruleLabel(r)} → N+${r.offset}`;

// ajoute les nouveaux jeux terminés à l'historique (gardé sur plusieurs sabots)
function appendLog() {
  const maxDone = maxFinishedGameNumber();
  if (maxDone < panel.lastLogged) { panel.log += '|'; panel.lastLogged = 0; } // numéros repartis à 1 sans passer par le reset
  let added = 0;
  for (let n = panel.lastLogged + 1; n <= maxDone; n++) { panel.log += codeOf(state.games.get(n)); added += 1; }
  panel.lastLogged = maxDone;
  panel.loggedCount += added;
  if (panel.log.length > LOG_MAX) panel.log = panel.log.slice(-LOG_MAX);
}
const segments = () => panel.log.split('|').filter((x) => x.length);

// ---------------------------------------------------------------------------
// Taux observés (fenêtre : jeu prédit + rattrapages)
// ---------------------------------------------------------------------------
function windowAt(seg, start, maxR) {
  let h23 = false; let hX = false;
  for (let i = 0; i <= maxR; i++) {
    const ch = seg[start + i];
    if (ch === undefined || ch === '?') return (h23 || hX) ? { h23, hX } : null; // fenêtre pas jouée en entier / inconnue
    const d = decode(ch);
    if (is23c(d)) h23 = true;
    if (d.tie) hX = true;
    if (h23 || hX) return { h23, hX };
  }
  return { h23, hX };
}
function rateFor(match, offset, maxR = panel.maxR) {
  const r = { n: 0, t23: 0, tX: 0, any: 0 };
  for (const seg of segments()) {
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] === '?' || !match(decode(seg[i]))) continue;
      const w = windowAt(seg, i + offset, maxR);
      if (!w) continue;
      r.n += 1; if (w.h23) r.t23 += 1; if (w.hX) r.tX += 1; if (w.h23 || w.hX) r.any += 1;
    }
  }
  return r;
}
function baseRate(maxR = panel.maxR) {
  const r = { n: 0, t23: 0, tX: 0, any: 0 };
  for (const seg of segments()) {
    for (let i = 0; i < seg.length; i++) {
      const w = windowAt(seg, i, maxR);
      if (!w) continue;
      r.n += 1; if (w.h23) r.t23 += 1; if (w.hX) r.tX += 1; if (w.h23 || w.hX) r.any += 1;
    }
  }
  return r;
}
const MIN_SAMPLE = 5;
function pct(hits, n, baseHits, baseN) {
  const use = n >= MIN_SAMPLE ? { h: hits, n } : (baseN > 0 ? { h: baseHits, n: baseN } : { h: 0, n: 0 });
  if (!use.n) return 50;
  return Math.max(1, Math.min(99, Math.round((100 * (use.h + 1)) / (use.n + 2)))); // Laplace
}
function percentsFor(rule) {
  const r = rateFor((d) => matchRule(rule, d), rule.offset);
  const base = baseRate();
  return { p23: pct(r.t23, r.n, base.t23, base.n), pX: pct(r.tX, r.n, base.tX, base.n), n: r.n, observed: r };
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------
function lineFor(entry, key) {
  const label = key === 'x' ? 'X' : '2/3';
  const p = key === 'x' ? entry.pX : entry.p23;
  const hit = entry.hit ? entry.hit[key] : null;
  const mark = hit !== null && hit !== undefined ? ` ✅${digitEmoji(hit)}` : (entry.status === 'perdu' ? ' ❌' : '');
  return `${label}${mark} ${p}%`;
}
function messageText(entry) {
  const hit23 = entry.hit && entry.hit.t23 !== null && entry.hit.t23 !== undefined ? entry.hit.t23 : null;
  const hitX = entry.hit && entry.hit.x !== null && entry.hit.x !== undefined ? entry.hit.x : null;
  const keys = [{ k: 't23', v: entry.p23 }, { k: 'x', v: entry.pX }].sort((a, b) => b.v - a.v).map((x) => x.k); // le plus probable en haut
  const tail = entry.status === 'en attente' ? '⏳' : '';
  const num = ` ┣━ N°${entry.target}${tail}`;
  const won = hit23 !== null || hitX !== null;
  const shown = won ? keys.filter((k) => (k === 't23' ? hit23 !== null : hitX !== null)) : keys; // gagné : l'autre est ignoré
  const lines = [];
  shown.forEach((k, i) => {
    lines.push(lineFor(entry, k));
    if (i === 0 && shown.length > 1) lines.push(num);
  });
  if (shown.length === 1) lines.splice(1, 0, num);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Envoi / édition
// ---------------------------------------------------------------------------
async function sendEntry(entry) {
  const targetChannels = panel.channels;
  const targetSite = panel.siteChannelId;
  if (!targetChannels.length && (targetSite === null || targetSite === undefined || targetSite === '')) {
    panel.lastError = 'Aucun canal configuré pour « Nul / 2-3 »';
    return false;
  }
  const text = messageText(entry);
  const errors = [];
  let ok = false;
  if (targetChannels.length) {
    const bot = sender ? sender() : null;
    if (!bot) errors.push('Aucun token Telegram configuré');
    else {
      for (const id of targetChannels) {
        try { const m = await bot.sendMessage(id, text); entry.messages.push({ chatId: id, messageId: m.message_id }); ok = true; }
        catch (e) { errors.push(`${id} : ${e.message}`); }
      }
    }
  }
  if (targetSite !== null && targetSite !== undefined && targetSite !== '') {
    const posted = addSiteChannelMessage(targetSite, { sender: 'Nul / 2-3', text });
    if (posted) { ok = true; siteEntries.set(entry.id, posted); } else errors.push(`Canal du site introuvable (id ${targetSite})`);
  }
  if (!ok) { panel.lastError = errors[0] || 'Envoi impossible'; return false; }
  entry.usedChannels = [...targetChannels];
  entry.usedSite = targetSite ?? null;
  panel.sentCount += 1; panel.lastSentAt = Date.now();
  panel.lastError = errors.length ? errors[0] : null;
  return true;
}
function editEntry(entry) {
  const text = messageText(entry);
  const siteMsg = siteEntries.get(entry.id);
  if (siteMsg) { siteMsg.text = text; if (entry.status !== 'en attente') siteEntries.delete(entry.id); }
  const bot = sender ? sender() : null;
  if (!bot) return;
  for (const m of entry.messages) bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Détection des déclencheurs (règles)
// ---------------------------------------------------------------------------
const alreadyHave = (target) => panel.pending.some((e) => e.target === target && e.status !== 'annulé');
async function scanTriggers() {
  const maxDone = maxFinishedGameNumber();
  if (!panel.lastScanned || panel.lastScanned > maxDone) { panel.lastScanned = maxDone; return; } // 1er passage : pas de rattrapage du passé
  for (let n = panel.lastScanned + 1; n <= maxDone; n++) {
    const ch = codeOf(state.games.get(n));
    if (ch === '?') continue;
    const d = decode(ch);
    for (const rule of panel.rules) {
      if (!rule.enabled || !matchRule(rule, d)) continue;
      const target = n + rule.offset;
      if (alreadyHave(target)) continue;
      const tg = state.games.get(target);
      if (target <= maxDone || (tg && (tg.finished || cardCount(tg.playerCards) > 0 || cardCount(tg.bankerCards) > 0))) continue; // trop tard : jeu déjà joué / distribué
      const p = percentsFor(rule);
      const entry = {
        id: `dt-${target}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        trigger: rule.id, ruleLabel: ruleText(rule), source: n, target, p23: p.p23, pX: p.pX, sample: p.n,
        status: 'en attente', step: 0, gap: 0, skipped: 0, maxR: panel.maxR,
        hit: { t23: null, x: null }, messages: [], usedChannels: [], usedSite: null,
        createdAt: Date.now(), sentAt: null, resolvedAt: null,
      };
      if (await sendEntry(entry)) {
        entry.sentAt = Date.now();
        panel.pending.push(entry);
        statsOf(rule.id).sent += 1;
      }
    }
  }
  panel.lastScanned = maxDone;
}

// ---------------------------------------------------------------------------
// Vérification (rattrapages)
// ---------------------------------------------------------------------------
function verifyPending() {
  const maxDone = maxFinishedGameNumber();
  for (const entry of panel.pending) {
    if (entry.status !== 'en attente') continue;
    let guard = 0;
    while (entry.status === 'en attente' && guard++ <= entry.maxR + entry.gap + 8) {
      const num = entry.target + entry.step + entry.gap;
      const g = state.games.get(num);
      if (!usable(g)) {
        if (num + 2 <= maxDone) { // jeu manquant : on décale
          entry.gap += 1; entry.skipped += 1;
          if (entry.skipped > 6) { entry.status = 'annulé'; entry.resolvedAt = Date.now(); break; }
          continue;
        }
        break;
      }
      const h23 = cardCount(g.playerCards) === 2 && cardCount(g.bankerCards) === 3; const hX = isTie(g);
      if (h23 || hX) { // l'un des deux est sorti : l'autre est ignoré
        if (h23) entry.hit.t23 = entry.step;
        if (hX) entry.hit.x = entry.step;
        entry.status = 'gagné'; entry.resolvedAt = Date.now(); strategyRecap.noteEntry(entry);
        const st = statsOf(entry.trigger);
        st.won += 1; if (h23) st.w23 += 1; if (hX) st.wX += 1;
        editEntry(entry); break;
      }
      if (entry.step >= entry.maxR) {
        entry.status = 'perdu'; entry.resolvedAt = Date.now(); strategyRecap.noteEntry(entry);
        statsOf(entry.trigger).lost += 1;
        editEntry(entry); break;
      }
      entry.step += 1;
    }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pending = panel.pending.filter((e) => e.status === 'en attente' || !e.resolvedAt || e.resolvedAt >= cutoff);
}

setOnShoeReset(() => {
  panel.lastScanned = 0;
  panel.lastLogged = 0;
  if (panel.log && !panel.log.endsWith('|')) panel.log += '|'; // nouveau sabot : séparateur dans l'historique
  for (const e of panel.pending) if (e.status === 'en attente') { e.status = 'annulé'; e.resolvedAt = Date.now(); }
  persist();
});

// ---------------------------------------------------------------------------
// Trouvailles de l'analyse : règles à AJOUTER / MODIFIER / SUPPRIMER
// ---------------------------------------------------------------------------
const hash = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0; return h.toString(36); };
const ratePct = (r) => (r && r.n ? (100 * r.any) / r.n : null);
const r0 = (v) => Math.round(v);
const covers = (rule, cand) => rule.enabled && rule.offset === cand.offset
  && (rule.p === null || rule.p === cand.p) && (rule.b === null || rule.b === cand.b) && (rule.tie === null || rule.tie === cand.tie);

function computeFindings() {
  const maxR = panel.maxR;
  const base = baseRate(maxR);
  if (!base.n || base.n < MIN_N) return [];
  const baseAny = ratePct(base);
  const gainNeeded = Math.max(5, Math.min(GAIN_POINTS, 0.5 * (100 - baseAny))); // taux général déjà haut : le gain possible est plus petit
  const out = [];
  const modded = new Set();
  for (const rule of panel.rules) {
    const m = (d) => matchRule(rule, d);
    const cur = rateFor(m, rule.offset, maxR);
    let best = null;
    for (const o of OFFSETS) {
      if (o === rule.offset) continue;
      if (panel.rules.some((x) => x.id !== rule.id && x.enabled && x.offset === o && x.p === rule.p && x.b === rule.b && x.tie === rule.tie)) continue; // doublon exact
      const r = rateFor(m, o, maxR);
      if (r.n >= MIN_N && (!best || ratePct(r) > ratePct(best.r))) best = { o, r };
    }
    const curPct = cur.n >= MIN_N ? ratePct(cur) : null;
    if (best && ratePct(best.r) - (curPct ?? baseAny) >= gainNeeded) {
      const key = `mod|${rule.id}|${best.o}`;
      out.push({ sid: hash(key), type: 'mod', key, n: best.r.n, rate: r0(ratePct(best.r)), base: r0(baseAny), score: (ratePct(best.r) - (curPct ?? baseAny)) * Math.sqrt(best.r.n),
        title: `✏️ ${ruleLabel(rule)} : N+${rule.offset} → N+${best.o} · ${r0(ratePct(best.r))}% (n=${best.r.n})`,
        detail: `Modifier « ${ruleText(rule)} » en « ${ruleLabel(rule)} → N+${best.o} » : ${r0(ratePct(best.r))}% de réussite sur ${best.r.n} cas, contre ${curPct === null ? r0(baseAny) + '% (taux général)' : r0(curPct) + '%'} avec le décalage actuel.`,
        patch: { ruleId: rule.id, offset: best.o } });
      modded.add(rule.id);
    }
  }
  for (const rule of panel.rules) {
    if (modded.has(rule.id)) continue;
    const cur = rateFor((d) => matchRule(rule, d), rule.offset, maxR);
    if (cur.n >= MIN_N && ratePct(cur) <= baseAny - DELETE_GAP) {
      const key = `del|${rule.id}`;
      out.push({ sid: hash(key), type: 'del', key, n: cur.n, rate: r0(ratePct(cur)), base: r0(baseAny), score: (baseAny - ratePct(cur)) * Math.sqrt(cur.n),
        title: `🗑️ Supprimer ${ruleText(rule)} · ${r0(ratePct(cur))}% (n=${cur.n})`,
        detail: `Supprimer « ${ruleText(rule)} » : ${r0(ratePct(cur))}% de réussite sur ${cur.n} cas, sous le taux général (${r0(baseAny)}%).`,
        patch: { ruleId: rule.id } });
    }
  }
  const adds = [];
  for (const p of [2, 3]) for (const b of [2, 3]) for (const tie of [true, false]) for (const o of OFFSETS.slice(0, 4)) {
    const cand = { p, b, tie, offset: o };
    if (panel.rules.some((r) => covers(r, cand))) continue;
    const r = rateFor((d) => d.p === p && d.b === b && d.tie === tie, o, maxR);
    if (r.n < MIN_N || ratePct(r) - baseAny < gainNeeded) continue;
    const key = `add|${tie}|${p}|${b}|${o}`;
    const label = ruleLabel({ p, b, tie });
    adds.push({ sid: hash(key), type: 'add', key, n: r.n, rate: r0(ratePct(r)), base: r0(baseAny), score: (ratePct(r) - baseAny) * Math.sqrt(r.n),
      title: `➕ Ajouter ${label} → N+${o} · ${r0(ratePct(r))}% (n=${r.n})`,
      detail: `Ajouter la règle « ${label} → N+${o} » : ${r0(ratePct(r))}% de réussite sur ${r.n} cas, contre ${r0(baseAny)}% de taux général.`,
      patch: { rule: { p, b, tie, offset: o } } });
  }
  adds.sort((a, b) => b.score - a.score);
  const list = out.concat(adds.slice(0, 3)).filter((f) => !panel.dismissed[f.sid]);
  list.sort((a, b) => b.score - a.score);
  return list.slice(0, MAX_FINDINGS);
}

function applyFinding(f) {
  if (!f) return { ok: false, text: 'Trouvaille introuvable (la liste a changé).' };
  if (f.type === 'add') {
    const rule = sanitizeRule({ ...f.patch.rule, auto: true, enabled: true });
    if (!rule) return { ok: false, text: 'Règle invalide.' };
    if (panel.rules.some((r) => covers(r, rule))) return { ok: false, text: 'Cette règle existe déjà.' };
    panel.rules.push(rule);
    return { ok: true, text: `Règle ajoutée : ${ruleText(rule)}` };
  }
  const rule = panel.rules.find((r) => r.id === f.patch.ruleId);
  if (!rule) return { ok: false, text: 'La règle n\'existe plus.' };
  if (f.type === 'mod') { const old = ruleText(rule); rule.offset = f.patch.offset; return { ok: true, text: `Règle modifiée : ${old} → ${ruleText(rule)}` }; }
  if (f.type === 'del') {
    if (panel.rules.length <= 1) return { ok: false, text: 'Impossible : il doit rester au moins une règle.' };
    panel.rules = panel.rules.filter((r) => r.id !== rule.id);
    return { ok: true, text: `Règle supprimée : ${ruleText(rule)}` };
  }
  return { ok: false, text: 'Type inconnu.' };
}
function applyBySid(sid) {
  const f = computeFindings().find((x) => x.sid === sid);
  const r = applyFinding(f);
  if (r.ok) { panel.dismissed[sid] = Date.now(); persist(); }
  return r;
}

// ---------------------------------------------------------------------------
// Chat privé : liste cliquable
// ---------------------------------------------------------------------------
function rulesSummary() {
  return panel.rules.map((r) => `• ${ruleText(r)}${r.enabled ? '' : ' (désactivée)'}`).join('\n');
}
function listView(findings, prefix = '') {
  const list = findings || computeFindings();
  const head = prefix ? `${prefix}\n\n` : '';
  if (!list.length) {
    return { text: `${head}⚖️ Nul / 2-3 — aucune modification à proposer pour l'instant.\n\nRègles actuelles :\n${rulesSummary()}`, markup: { inline_keyboard: [[{ text: '🔄 Actualiser', callback_data: 'dtn:l' }]] } };
  }
  const rows = list.map((f) => [{ text: f.title.slice(0, 60), callback_data: `dtn:a:${f.sid}` }]);
  rows.push([{ text: '✅ Tout appliquer', callback_data: 'dtn:all' }, { text: '🙈 Tout ignorer', callback_data: 'dtn:ig' }]);
  rows.push([{ text: '🔄 Actualiser', callback_data: 'dtn:l' }]);
  const text = `${head}🔎 Nul / 2-3 — l'analyse a trouvé ${list.length} changement(s) possible(s) :\n\n${list.map((f, i) => `${i + 1}. ${f.detail}`).join('\n\n')}\n\nRègles actuelles :\n${rulesSummary()}\n\nTouche un bouton pour l'appliquer.`;
  return { text, markup: { inline_keyboard: rows } };
}
async function toAdmin(view) {
  try {
    const bot = sender ? sender() : null;
    const adminId = adminIdFn ? adminIdFn() : null;
    if (!bot || !adminId) { panel.lastError = !adminId ? 'ADMIN_ID non renseigné (chat privé inconnu)' : 'Aucun token Telegram configuré'; return false; }
    const raw = bot.sendMessageUnguarded || bot.sendMessage.bind(bot);
    await raw(adminId, view.text, { reply_markup: view.markup });
    return true;
  } catch (e) { panel.lastError = e.message; return false; }
}
async function sendListToAdmin() { return toAdmin(listView()); }

// réponse à un bouton du chat privé (callback_data « dtn:… »)
function handleCallback(data) {
  const parts = String(data || '').split(':');
  const act = parts[1];
  if (act === 'a') {
    const r = applyBySid(parts[2]);
    return { answer: r.ok ? '✅ Appliqué' : '⚠️ ' + r.text, ...listView(null, `${r.ok ? '✅' : '⚠️'} ${r.text}`) };
  }
  if (act === 'all') {
    const done = [];
    for (const f of computeFindings()) {
      const r = applyFinding(f);
      if (r.ok) { panel.dismissed[f.sid] = Date.now(); done.push(r.text); }
    }
    persist();
    return { answer: done.length ? `✅ ${done.length} appliqué(s)` : 'Rien à appliquer', ...listView(null, done.length ? `✅ Appliqué :\n${done.join('\n')}` : 'Rien à appliquer.') };
  }
  if (act === 'ig') {
    const list = computeFindings();
    for (const f of list) panel.dismissed[f.sid] = Date.now();
    persist();
    return { answer: '🙈 Ignoré', ...listView(null, `🙈 ${list.length} trouvaille(s) ignorée(s).`) };
  }
  return { answer: 'Liste actualisée', ...listView() };
}

// analyse automatique : tous les ANALYSIS_EVERY jeux enregistrés → notification au chat privé si du nouveau
async function maybeAnalyze(force = false) {
  if (!force && panel.loggedCount - panel.analysisMark < ANALYSIS_EVERY) return;
  panel.analysisMark = panel.loggedCount;
  panel.lastAnalysisAt = Date.now();
  const list = computeFindings();
  const fresh = list.filter((f) => !panel.notified[f.sid]);
  if (panel.notify && fresh.length) {
    if (await toAdmin(listView(list))) for (const f of list) panel.notified[f.sid] = Date.now();
  }
}

async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    appendLog();
    await scanTriggers();
    verifyPending();
    await maybeAnalyze();
    panel.lastScanAt = Date.now();
  } catch (e) { panel.lastError = e.message; }
  finally { persist(); busy = false; }
  return panel;
}

async function test() {
  const bot = sender ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré', errors: ['Aucun token Telegram configuré'] };
  if (!panel.channels.length) return { ok: false, error: 'Aucun canal configuré', errors: ['Aucun canal configuré'] };
  const preview = { target: (maxFinishedGameNumber() || 530) + 2, p23: 100, pX: 95, status: 'en attente', hit: { t23: null, x: null } };
  const won = { ...preview, status: 'gagné', hit: { t23: null, x: 1 } };
  const sent = []; const errors = [];
  for (const id of panel.channels) {
    try {
      await bot.sendMessage(id, `🧪 Nul / 2-3 — message de test\n\n${messageText(preview)}\n\nAprès un résultat (ici le nul au 1er rattrapage) :\n\n${messageText(won)}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

// ---------------------------------------------------------------------------
// Analyse : comment les matchs nuls viennent
// ---------------------------------------------------------------------------
function analysis() {
  const segs = segments();
  let games = 0; let ties = 0; let all23 = 0;
  const byCards = { '2/2': 0, '3/2': 0, '2/3': 0, '3/3': 0 };
  const gaps = []; const after = [1, 2, 3].map((k) => ({ k, n: 0, hits: 0 }));
  let lastTies = []; let sinceLastTie = null;
  segs.forEach((seg, si) => {
    let prevTie = null; const tiesHere = [];
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] === '?') continue;
      const d = decode(seg[i]); games += 1;
      if (is23c(d)) all23 += 1;
      if (d.tie) {
        ties += 1; tiesHere.push(i + 1);
        byCards[`${d.p}/${d.b}`] += 1;
        if (prevTie !== null) gaps.push(i - prevTie);
        prevTie = i;
        for (const a of after) { const nx = seg[i + a.k]; if (nx !== undefined && nx !== '?') { a.n += 1; if (decode(nx).tie) a.hits += 1; } }
      }
    }
    if (si === segs.length - 1) { lastTies = tiesHere.slice(-10); sinceLastTie = tiesHere.length ? seg.length - tiesHere[tiesHere.length - 1] : null; }
  });
  const base = baseRate();
  return {
    games, ties, tiePct: games ? Math.round((1000 * ties) / games) / 10 : null,
    all23, all23Pct: games ? Math.round((1000 * all23) / games) / 10 : null,
    byCards, lastTies, sinceLastTie, shoes: segs.length,
    avgGap: gaps.length ? Math.round((10 * gaps.reduce((a, b) => a + b, 0)) / gaps.length) / 10 : null,
    maxGap: gaps.length ? Math.max(...gaps) : null,
    afterTie: after.map((a) => ({ ...a, pct: a.n ? Math.round((100 * a.hits) / a.n) : null })),
    window: { maxR: panel.maxR, base },
    rules: panel.rules.map((r) => {
      const p = percentsFor(r); const s = statsOf(r.id);
      return { id: r.id, label: ruleLabel(r), offset: r.offset, auto: !!r.auto, enabled: r.enabled, observed: p.observed, p23: p.p23, pX: p.pX, sent: s.sent, won: s.won, lost: s.lost, w23: s.w23, wX: s.wX };
    }),
  };
}

function statusView() {
  const resolved = panel.pending.filter((e) => e.status === 'gagné' || e.status === 'perdu');
  return {
    ...config(),
    siteChannels: siteChannelsView().map((c) => ({ id: c.id, name: c.name })),
    live: state.live && Number.isFinite(Number(state.live.number)) ? Number(state.live.number) : maxFinishedGameNumber(),
    rules: panel.rules.map((r) => ({ id: r.id, label: ruleLabel(r), offset: r.offset, enabled: r.enabled, auto: !!r.auto })),
    findings: computeFindings().map((f) => ({ sid: f.sid, type: f.type, title: f.title, detail: f.detail, n: f.n, rate: f.rate, base: f.base })),
    pending: panel.pending.slice(-30).map((e) => ({
      id: e.id, trigger: e.trigger, ruleLabel: e.ruleLabel, source: e.source, target: e.target, p23: e.p23, pX: e.pX, status: e.status,
      step: e.step, maxR: e.maxR, hit: e.hit, sentAt: e.sentAt, resolvedAt: e.resolvedAt, usedChannels: e.usedChannels || [], usedSite: e.usedSite ?? null,
    })),
    analysis: analysis(),
    won: resolved.filter((e) => e.status === 'gagné').length,
    lost: resolved.filter((e) => e.status === 'perdu').length,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt, lastAnalysisAt: panel.lastAnalysisAt, lastError: panel.lastError,
  };
}

function resetStats() {
  panel.stats = {};
  panel.pending = [];
  panel.rules = defaultRules();
  panel.notified = {}; panel.dismissed = {};
  persist();
  return statusView();
}

module.exports = {
  panel, setSender, setAdminId, tick, test, status: statusView, config, configure, persist,
  restore, restoreFromDb, parseChannels, resetStats, analysis, messageText,
  computeFindings, applyBySid, listView, sendListToAdmin, handleCallback, maybeAnalyze, ruleText,
};
