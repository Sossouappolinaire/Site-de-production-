// parity-palier.js — « Palier parité » (v114, demande admin), stratégie du bouton Stratégies branchée sur le « Compte parité ».
//
// Le « Compte parité » affiche un PALIER : une ligne par fin de numéro (0 à 9), avec le pourcentage de chaque costume dans la main du
// JOUEUR, par exemple « #531 ➔ (♦️31%) (♠️25%) (♣️25%) (❤️19%) ». Cette stratégie lit ce palier en direct et prédit le costume au PLUS
// FAIBLE pourcentage de la ligne.
//
// Règles :
//   • v122 : le costume au plus faible pourcentage (le 4ᵉ, le faible) est prédit quand il est SEUL en bas ET que la ligne est soit sans
//     aucune égalité, soit avec une égalité EN HAUT : 1ᵉʳ = 2ᵉ (3ᵉ ≠ 4ᵉ), ou 1ᵉʳ = 2ᵉ = 3ᵉ (le 4ᵉ plus bas). Pas de prédiction si le 3ᵉ et le
//     4ᵉ sont à égalité (faible non unique) ni si l'égalité est seulement au milieu (2ᵉ = 3ᵉ).
//   • un seul costume doit être au plus faible pourcentage. Si deux costumes ou plus sont à égalité tout en bas (ex. « #530 ➔ ♦️36 ❤️21
//     ♠️21 ♣️21 », « #532 ➔ ♠️50 ♣️25 ❤️13 ♦️13 », « #537 » à 25 % partout) → pas de prédiction pour cette fin de numéro, on passe à la
//     suivante (même principe pour les lignes à 0 % : seules les lignes dont UN SEUL costume est à 0 % — ex. #1271 et #1276 — donnent
//     une prédiction) ;
//   • la comparaison se fait sur les pourcentages entiers affichés dans le message (ce que tu vois est ce que le bot compare) ;
//   • le costume de la ligne « fin d » est prédit au prochain jeu dont le numéro finit par d (qui n'a pas encore commencé), avec 3
//     rattrapages par défaut (jeu N, N+1, N+2, N+3) ; le message est édité (✅ / ❌) ;
//   • enchaînement : UNE prédiction à la fois. Costume venu au jeu N (✅0️⃣) → la prédiction suivante vise le jeu N+1 ; venu à +1 → N+2
//     (le jeu N+1 est déjà « utilisé ») ; venu à +2 → N+3 ; venu à +3 → N+4 ; jamais venu (❌, 3 rattrapages) → N+4 ;
//   • un jeu déjà commencé n'est jamais prédit (même règle que les autres stratégies) : « Avance » = nombre de jeux d'écart minimum
//     avec le jeu en direct (1 par défaut) ;
//   • PAR DIZAINE : le palier de la dizaine PASSÉE est figé dès que la main du joueur du jeu finissant par 9 est terminée, puis il sert à
//     prédire TOUTE la dizaine suivante (palier #510-#519 → prédictions des jeux 520 à 529 : la ligne #511 prédit le jeu 521, etc.) ;
//     la première prédiction d'une dizaine part donc dès que le joueur a fini de tirer au jeu x9, sans attendre le banquier ;
//   • le bot n'attend JAMAIS le banquier : la main du joueur est terminée quand il a 3 cartes, ou 2 cartes valant 6 ou plus (il reste sur
//     6-7 ou naturel 8-9) ; le résultat (✅ dès que le costume apparaît, ❌ quand la main est terminée) et l'envoi de la prédiction
//     suivante partent à ce moment-là ;
//   • le palier figé ne bouge plus pendant la dizaine (un reset du Compte parité en cours de dizaine ne le touche pas).
//   • DEUX MODES au choix (réglage « Mode d'envoi ») :
//       « Une à la fois » (par défaut) : la prédiction suivante n'est envoyée qu'une fois la précédente VÉRIFIÉE (enchaînement ci-dessus) ;
//       « Liste » : toutes les prédictions de la dizaine sont envoyées sans attendre les résultats : chaque numéro à prédire part quand le
//       jeu en direct est à « Envoi à N jeux avant » (2 par défaut) de ce numéro ; si le palier de la dizaine n'est pas encore figé (jeux
//       x0 et x1), elles partent dès qu'il l'est ;
//   • AVANT TOUTE PRÉDICTION on compare le numéro à prédire au jeu en direct : si le jeu en direct est SUPÉRIEUR au numéro à prédire, la
//     prédiction est ignorée (et un jeu dont la main du joueur est déjà arrivée n'est jamais prédit).
//   • v132 — RÉGLAGE « Costume déjà venu N fois de suite → son inverse » (0 = désactivé) : avant d'envoyer la prédiction du jeu N en X, on
//     regarde les N jeux juste avant dans la main du joueur ; si X est venu dans chacun d'eux (ex. réglage 2 : ❤️ aux jeux 10 et 11 et
//     prédiction ❤️ au jeu 12) → on prédit l'INVERSE à la place (❤️ → ♣️, ♦️ → ♠️, et réciproquement). Tant que les jeux précédents ne sont
//     pas tous connus, la prédiction attend (voir suit-consecutive.js).
// Main du joueur uniquement.
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

const DB_KEY = 'parity_palier_state';
const STORE_KEY = 'parityPalier';
const DEFAULT_MAXR = 3, DEFAULT_LEAD = 1, DEFAULT_MINN = 1, DEFAULT_SENDAT = 2, DEFAULT_CONSEC = 0, DONE_MAX = 200;
const MODES = ['sequence', 'list'];
const SENT_RESOLVED_MAX = 100;

const panel = {
  enabled: false, channels: [], format: config.DEFAULT_FORMAT, maxR: DEFAULT_MAXR, lead: DEFAULT_LEAD, minN: DEFAULT_MINN, mode: 'sequence', sendAt: DEFAULT_SENDAT, consec: DEFAULT_CONSEC,
  done: [],            // numéros déjà traités en mode « Liste » (envoyés ou sans prédiction)
  frozen: null,        // palier figé { source: 510, rows: [{ digit, total, cells }] } : sert à prédire les jeux 520-529
  cursor: 0,           // plus petit numéro de jeu que la prochaine prédiction a le droit de viser (enchaînement)
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
const isDone = (g) => !!g && g.finished && g.complete !== false;
const maxFinishedGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; };
const maxKnownGameNumber = () => { let m = 0; for (const g of state.games.values()) if ((g.finished || g.dealing) && g.number > m) m = g.number; return m; };
// main du joueur terminée sans attendre le banquier : 3 cartes, ou 2 cartes valant 6+ (il reste), cartes déjà arrivées
const playerFinal = (g) => !!g && (g.finished ? g.complete !== false : (Number(g.playerCards) >= 3 || (Number(g.playerCards) === 2 && Number(g.playerValue) >= 6)));
const hasPlayerCards = (g) => !!g && Array.isArray(g.player) && g.player.length > 0;
const maxPlayerFinalNumber = () => { let m = 0; for (const g of state.games.values()) if (playerFinal(g) && g.number > m) m = g.number; return m; };
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const emptyStats = () => ({ sent: 0, won: 0, lost: 0, swapped: 0, byStep: {} });
const statsOf = () => { panel.stats = panel.stats && typeof panel.stats === 'object' ? { ...emptyStats(), ...panel.stats } : emptyStats(); return panel.stats; };

// ── choix du costume d'une ligne du palier ──────────────────────────────────
// cells : [{ suit, count, pct }] (pourcentages entiers). Renvoie { suit, pct } si UN SEUL costume est au plus faible pourcentage,
// sinon null (égalité en bas du classement, ou aucune donnée).
function pickLowest(cells, minN = 1, total = null) {
  if (!Array.isArray(cells) || cells.length < 2) return null;
  const sum = total != null ? total : cells.reduce((n, c) => n + (c.count || 0), 0);
  if (!sum || sum < minN) return null;
  // v122 : classé du plus haut au plus bas (r1 ≥ r2 ≥ r3 ≥ r4), le 4ᵉ (le faible) doit être seul en bas (r3 > r4) ; une égalité n'est permise
  // qu'en haut (r1 = r2, ou r1 = r2 = r3) ; une égalité au milieu seule (r1 > r2 = r3) = pas de prédiction
  const r = cells.map((c) => c.pct).sort((a, b) => b - a);
  if (r.length >= 3) {
    if (r[r.length - 1] === r[r.length - 2]) return null;
    if (r[1] === r[2] && r[0] !== r[1]) return null;
  }
  const min = Math.min(...cells.map((c) => c.pct));
  const lows = cells.filter((c) => c.pct === min);
  return lows.length === 1 ? { suit: lows[0].suit, pct: lows[0].pct } : null;
}
function pickForDigit(digit) {
  const row = panel.frozen && panel.frozen.rows && panel.frozen.rows[digit];
  if (!row) return null;
  return pickLowest(row.cells, panel.minN, row.total);
}
// fige le palier de la dizaine `source` (ex. 510) : compteur parité en direct + main du joueur du jeu x9 si le compteur ne l'a pas encore
// compté (il ne compte qu'à la fin du jeu, donc après le banquier)
function freezePalier(source) {
  const rows = parityCounter.palier('player');
  const g = state.games.get(source + 9);
  if (g && hasPlayerCards(g) && parityCounter.state.lastGameNumber !== g.number) {
    const row = rows[9];
    for (const x of g.playerSuits || []) { const c = row.cells.find((cc) => cc.suit === x); if (c) { c.count += 1; row.total += 1; } }
    for (const c of row.cells) c.pct = row.total ? Math.round((c.count / row.total) * 100) : 0;
  }
  panel.frozen = { source, at: Date.now(), rows };
}

// ── envoi / édition ─────────────────────────────────────────────────────────
function renderFor(entry, statusFr) {
  return fmt.renderMessage(entry.format, { gameNumber: entry.target, suit: entry.suit, strategy: 'Palier parité', maxR: entry.maxR, status: statusFr, rattrapage: entry.step || 0 }, null);
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
// v123 : un numéro de jeu revient chaque jour (le sabot repart à #1 à 00h00) : un doublon n'existe que dans le sabot en cours,
// jamais avec une prédiction de la veille encore gardée dans l'historique
const DUP_WINDOW_MS = 2 * 3600 * 1000;
const isDuplicate = (target, suit) => panel.pendingMessages.some((s) => s.target === target && s.suit === suit && (s.status === 'en attente' || Date.now() - (Number(s.createdAt) || 0) < DUP_WINDOW_MS));
async function launch(target, digit, suit, lowPct, meta) {
  if (!panel.channels.length) return false;
  if (!canTarget(target)) return false; // jeu en direct > numéro à prédire : ignorée
  const key = `${target}:${suit}`;
  if (isDuplicate(target, suit) || inflight.has(key)) { panel.duplicatesBlocked += 1; return false; }
  inflight.add(key);
  try {
    const entry = { id: `pp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: 'parity-palier', suit, target, digit, pct: lowPct, maxR: panel.maxR, format: panel.format, step: 0, status: 'en attente', messages: [], createdAt: Date.now(), resolvedAt: null };
    if (meta && meta.swapped) { entry.from = meta.from; entry.swapped = true; entry.streak = panel.consec; } // v132 : costume remplacé par son inverse
    entry.messages = await sendToChannels(renderFor(entry, null));
    if (!entry.messages.length) return false;
    panel.pendingMessages.push(entry);
    const st = statsOf(); st.sent += 1; if (entry.swapped) st.swapped = (st.swapped || 0) + 1; panel.sentCount += 1; panel.lastSentAt = Date.now(); panel.lastError = null;
    return true;
  } finally { inflight.delete(key); }
}

// ── nouveau sabot (v123) ────────────────────────────────────────────────────
// À 00h00 (heure d'Abidjan) le jeu repart à #1. Avant ce correctif rien ne remettait ce panneau à zéro : le curseur d'enchaînement
// restait vers #1440, la prédiction de la veille restait « en attente » (jeu jamais rejoué) et, en mode « Une à la fois », plus
// aucune prédiction ne partait de la journée.
//   • les prédictions en attente de l'ancien sabot sont annulées, le curseur et la liste « Liste » repartent à zéro ;
//   • le dernier palier figé (historique de la veille) est conservé et sert de palier pour la 1ʳᵉ dizaine (jeux 1 à 9) ; il est
//     remplacé par le vrai palier dès que la main du joueur du jeu 9 est terminée.
const STALE_AHEAD = 60; // une prédiction qui vise plus de 60 jeux au-delà du jeu en direct vient forcément d'un sabot précédent
function rebaseForNewShoe() {
  let changed = false;
  for (const s of panel.pendingMessages) if (s.status === 'en attente') { s.status = 'annulé'; s.resolvedAt = Date.now(); changed = true; }
  if (panel.cursor) { panel.cursor = 0; changed = true; }
  if (panel.done.length) { panel.done = []; changed = true; }
  if (panel.frozen && panel.frozen.source !== -10) { panel.frozen = { ...panel.frozen, origin: panel.frozen.origin != null ? panel.frozen.origin : panel.frozen.source, source: -10, carried: true }; changed = true; }
  inflight.clear();
  if (changed) persist();
  return changed;
}
setOnShoeReset(() => { try { rebaseForNewShoe(); } catch (e) { panel.lastError = e.message; } });

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
    // sécurité : état resté d'un sabot précédent (relance du serveur pendant le changement de jour, jeux relus après une coupure…)
    const knownNow = maxKnownGameNumber();
    if (knownNow) {
      const staleFrozen = panel.frozen && panel.frozen.source > knownNow + 20;
      const stalePending = panel.pendingMessages.some((s) => s.status === 'en attente' && s.target > knownNow + STALE_AHEAD);
      if (staleFrozen || stalePending || (Number(panel.cursor) || 0) > knownNow + STALE_AHEAD) { rebaseForNewShoe(); changed = true; }
    }
    // v124 : une prédiction « en attente » trop ancienne (jeu jamais reçu, redémarrage, coupure…) est libérée : elle ne bloque plus la suivante
    for (const s of panel.pendingMessages) if (s.status === 'en attente' && Date.now() - (Number(s.createdAt) || 0) > PENDING_MAX_MS) { s.status = 'annulé'; s.resolvedAt = Date.now(); changed = true; }
    const maxDone = maxPlayerFinalNumber();
    // 0) palier de la dizaine passée : figé dès que la main du joueur du jeu x9 est terminée
    for (let src = Math.floor(maxKnownGameNumber() / 10) * 10; src >= 0 && src > ((panel.frozen && panel.frozen.source) ?? -1); src -= 10) {
      if (playerFinal(state.games.get(src + 9))) { freezePalier(src); changed = true; break; }
    }
    // 1) résultat des prédictions envoyées (jeu N puis rattrapages N+1 … N+maxR) + enchaînement
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
        // costume venu à +k → la prédiction suivante vise au plus tôt N+k+1 ; jamais venu → N+maxR+1
        panel.cursor = Math.max(Number(panel.cursor) || 0, s.target + (r.verdict === 'gagné' ? r.hitAt : s.maxR) + 1);
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
    // 2) nouvelles prédictions
    if (panel.enabled && panel.channels.length) {
      const known = maxKnownGameNumber();
      if (panel.mode === 'list') {
        // mode « Liste » : chaque numéro de la dizaine suivant le palier figé part quand le jeu en direct est à `sendAt` jeux de ce numéro
        const fz = panel.frozen;
        if (known && fz) {
          for (let n = known; n <= known + panel.sendAt; n++) {
            if (Math.floor(n / 10) * 10 !== fz.source + 10) continue; // palier de cette dizaine pas encore figé : on attend
            if (panel.done.includes(n)) continue;
            if (!canTarget(n)) continue;
            const pick = pickForDigit(n % 10); // égalité ou palier vide : pas de prédiction pour ce numéro
            // v124 : le numéro n'est marqué « traité » que si la prédiction est partie (ou n'existe pas) ; un envoi raté est retenté au passage suivant
            // v132 : réglage « costume venu N fois de suite → inverse » ; les jeux précédents pas tous connus → on attend (réessai au passage suivant)
            const dec = pick ? consecutive.decide(n, pick.suit, panel.consec) : null;
            if (dec && dec.wait) continue;
            if (pick && !(await launch(n, n % 10, dec.suit, pick.pct, dec)) && !isDuplicate(n, dec.suit)) continue;
            panel.done.push(n); if (panel.done.length > DONE_MAX) panel.done = panel.done.slice(-DONE_MAX); changed = true;
          }
        }
      } else if (!panel.pendingMessages.some((s) => s.status === 'en attente') && known) {
        // mode « Une à la fois » : la suivante n'part qu'une fois la précédente vérifiée, sur le premier jeu autorisé pas encore commencé
        const target = Math.max(Number(panel.cursor) || 0, known + panel.lead);
        const digit = target % 10;
        // seul le palier de la dizaine juste avant sert : la cible doit être dans la dizaine suivant le palier figé
        const pick = panel.frozen && Math.floor(target / 10) * 10 === panel.frozen.source + 10 ? pickForDigit(digit) : null;
        if (pick) {
          // v132 : réglage « costume venu N fois de suite → inverse » ; tant que les jeux précédents ne sont pas tous connus, on attend
          const dec = consecutive.decide(target, pick.suit, panel.consec);
          if (!dec.wait && await launch(target, digit, dec.suit, pick.pct, dec)) changed = true;
        }
        // égalité ou palier vide pour cette fin de numéro : pas de prédiction, on passe au jeu suivant quand il commence
      }
    }
    const before = panel.pendingMessages.length;
    panel.pendingMessages = [...panel.pendingMessages.filter((s) => s.status !== 'en attente').slice(-SENT_RESOLVED_MAX), ...panel.pendingMessages.filter((s) => s.status === 'en attente')];
    if (changed || panel.pendingMessages.length !== before) persist();
  } catch (e) { panel.lastError = e.message; }
  finally { if (tickSeq === myTick) ticking = false; }
}

// ── réglages ────────────────────────────────────────────────────────────────
function config_() { return { enabled: panel.enabled, channels: [...panel.channels], format: panel.format, maxR: panel.maxR, lead: panel.lead, minN: panel.minN, mode: panel.mode, sendAt: panel.sendAt, consec: panel.consec }; }
function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = loss.parseChannels(patch.channels);
  if (patch.format !== undefined) panel.format = fmt.clampFormat(patch.format);
  if (patch.maxR !== undefined) panel.maxR = clampInt(patch.maxR, 0, 9, DEFAULT_MAXR);
  if (patch.lead !== undefined) panel.lead = clampInt(patch.lead, 1, 20, DEFAULT_LEAD);
  if (patch.minN !== undefined) panel.minN = clampInt(patch.minN, 1, 5000, DEFAULT_MINN);
  if (patch.mode !== undefined) panel.mode = MODES.includes(patch.mode) ? patch.mode : 'sequence';
  if (patch.sendAt !== undefined) panel.sendAt = clampInt(patch.sendAt, 1, 10, DEFAULT_SENDAT);
  if (patch.consec !== undefined) panel.consec = consecutive.clampNeed(patch.consec, DEFAULT_CONSEC);
  persist();
  return config_();
}
// v124 : libère TOUT ce qui était « en attente » (prédictions jamais vérifiées), remet le curseur et la liste « Liste » à zéro
function unblockAll() {
  let n = 0;
  for (const s of panel.pendingMessages) if (s.status === 'en attente') { s.status = 'annulé'; s.resolvedAt = Date.now(); n += 1; }
  panel.cursor = 0; panel.done = []; inflight.clear(); panel.lastError = null;
  return n;
}
function unblock() { const n = unblockAll(); persist(); return n; }
function resetStats() { panel.stats = emptyStats(); unblockAll(); panel.frozen = null; persist(); }
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
    const pick = pickLowest(r.cells, panel.minN, r.total);
    const sorted = r.cells.map((c, i) => ({ ...c, i })).sort((a, b) => b.count - a.count || a.i - b.i);
    return {
      digit: r.digit, label: base != null ? `#${(fz.origin != null ? fz.origin : base) + r.digit}` : String(r.digit), total: r.total, cells: sorted.map(({ suit, pct: p }) => ({ suit, pct: p })),
      pick: pick ? pick.suit : null, reason: pick ? '' : (r.total < panel.minN || !r.total ? 'pas assez de données' : 'égalité (faible non unique ou égalité au milieu)'),
    };
  });
  const known = maxKnownGameNumber();
  const waiting = panel.pendingMessages.filter((s) => s.status === 'en attente');
  const nextTarget = known ? Math.max(Number(panel.cursor) || 0, known + panel.lead) : null;
  return {
    ...config_(), rows, frozenSource: fz ? (fz.origin != null ? fz.origin : fz.source) : null, cursor: panel.cursor || 0, nextTarget,
    sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, duplicatesBlocked: panel.duplicatesBlocked, won: st.won, lost: st.lost, swapped: st.swapped || 0, resolved, rate: pct(st.won, resolved),
    steps: Object.entries(st.byStep || {}).map(([k, n]) => ({ step: Number(k), n: Number(n) })).sort((a, b) => a.step - b.step),
    waiting: waiting.length,
    recent: panel.pendingMessages.slice(-12).reverse().map((s) => ({ target: s.target, digit: s.digit, suit: s.suit, from: s.from || null, pct: s.pct, status: s.status, step: s.step, maxR: s.maxR })),
    channelNames: panel.channels.map((id) => panel.channelTitles[String(id)] || String(id)), lastError: panel.lastError,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { config: config_(), frozen: panel.frozen, cursor: panel.cursor, pendingMessages: panel.pendingMessages, stats: panel.stats, sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, channelTitles: panel.channelTitles };
  try { store.patch({ [STORE_KEY]: saved }); } catch (_) {}
  if (db.ready) db.setSetting(DB_KEY, JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  const c = saved.config || {};
  panel.enabled = c.enabled === true; panel.channels = loss.parseChannels(c.channels);
  panel.format = fmt.clampFormat(c.format || config.DEFAULT_FORMAT); panel.maxR = clampInt(c.maxR, 0, 9, DEFAULT_MAXR);
  panel.lead = clampInt(c.lead, 1, 20, DEFAULT_LEAD); panel.minN = clampInt(c.minN, 1, 5000, DEFAULT_MINN);
  panel.mode = MODES.includes(c.mode) ? c.mode : 'sequence'; panel.sendAt = clampInt(c.sendAt, 1, 10, DEFAULT_SENDAT); panel.consec = consecutive.clampNeed(c.consec, DEFAULT_CONSEC);
  panel.frozen = saved.frozen && Array.isArray(saved.frozen.rows) && saved.frozen.rows.length === 10 ? saved.frozen : null;
  panel.cursor = Number(saved.cursor) || 0;
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

module.exports = { panel, setSender, restore, restoreFromDb, persist, tick, status, test, config: config_, configure, resetStats, unblock, setChannelTitle, pickLowest };
