// loss-return.js — bouton « Retour après perte » (v47, demande admin) :
//
//  • On SUIT un ou plusieurs canaux (le bot lit leurs publications, comme pour « Suivi » / « Détection auto »)
//    et on envoie un RAPPORT vers un autre canal.
//  • Chaque prédiction publiée dans le canal suivi (N° de jeu + costume) est vérifiée par le bot lui-même sur la main du
//    JOUEUR, avec le nombre de rattrapages CONFIGURÉ ici (jeu N, N+1 … N+R). Costume jamais sorti → prédiction PERDUE.
//  • Après une perte, on regarde QUAND le costume perdu finit par venir : D = nombre de jeux APRÈS LA FIN DES RATTRAPAGES.
//    Ex. : prédiction 12 ♦️ perdue, 3 rattrapages → 12 + 3 = 15 ; ♦️ sort au jeu 16 → D = 1 (« misez sur le jeu suivant »).
//  • Si le costume n'est pas venu au jeu suivant (D = 1), on note CE QUI EST VENU à la place (miroir ❤️↔♦️ / ♠️↔♣️, inverse
//    ❤️↔♣️ / ♦️↔♠️, ou l'autre costume) — mêmes tables que strategies.js.
//  • Source « Relance » : le bouton peut aussi SURVEILLER une configuration du bouton « Relance » (best-weak-top.js) : le bot
//    ne reçoit pas ses propres publications de canal, donc le message d'origine de la relance est transmis directement
//    (onRelanceSent). On utilise les rattrapages de la relance ; le costume pas venu après le 1ᵉʳ ✅ est la perte observée.
//    Preuve du D : si une relance est partie pour ce costume (onRelaunchSent), on compare le D observé au D de la relance
//    (jeu de la relance − fin des rattrapages) : retour pile sur le jeu de la relance, ou dans sa fenêtre de rattrapages.
//  • Source « canal où le bot publie » : toute prédiction envoyée par le bot (n'importe quelle stratégie ou bouton) passe par
//    son point d'envoi unique (bot.js, installChannelGuard) qui la transmet ici (onOwnPost) : on coche simplement le canal ; la
//    liste indique quelles stratégies / configurations y publient. Filtre facultatif par mot-clé (ex. le nom de la stratégie).
//  • À chaque perte (échantillon minimum atteint) : rapport vers le canal de destination. Tous les X rapports : BILAN avec les taux.
//  • Toujours sur la main du JOUEUR (hasSuit), jamais le banquier.
'use strict';

const store = require('./store');
const db = require('./db');
const strategies = require('./strategies');
const { state, hasSuit } = require('./predictor');

const SUITS = ['♠️', '❤️', '♦️', '♣️'];
const MIRROR = strategies.MIRROR;
const INVERSE = strategies.INVERSE;
const DEFAULT_MAXR = 2;       // rattrapages par défaut
const DEFAULT_MAXD = 10;      // on cherche le retour du costume jusqu'à D = 10 jeux après la fin des rattrapages par défaut
const DEFAULT_BILAN_EVERY = 10; // un bilan tous les 10 rapports (0 = jamais)
const DEFAULT_MIN_SAMPLE = 10; // pertes minimum du costume avant d'envoyer un rapport (0 = toujours)
const SEEN_MAX = 1500;
const PENDING_MAX = 400;

const panel = { configs: [], pending: [], seen: [], channelTitles: {}, lastError: null };
let sender = null;
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }

// ── utilitaires ─────────────────────────────────────────────────────────────
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
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
const sanitizeName = (v) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, 60);
// miss = pertes où le costume n'est PAS venu au jeu suivant (D=1) ; mirror / inverse / missSuits = ce qui est venu à la place
const emptyStats = () => ({ won: 0, lost: 0, resolved: 0, none: 0, miss: 0, mirror: 0, inverse: 0, missSuits: {}, hist: {}, proofN: 0, proofSame: 0, proofWin: 0 });
function statsOf(cfg, suit) { cfg.stats = cfg.stats && typeof cfg.stats === 'object' ? cfg.stats : {}; if (!cfg.stats[suit]) cfg.stats[suit] = emptyStats(); return cfg.stats[suit]; }
const maxFinishedGameNumber = () => { let m = 0; for (const g of state.games.values()) if (g.finished && g.number > m) m = g.number; return m; };
const isDone = (g) => !!g && g.finished && g.complete !== false;

// ── lecture d'une publication de canal ──────────────────────────────────────
// Accepte les formats courants : un seul costume + un numéro (N°1196, №1196, Jeu 1196 …) ; ou le format à deux costumes avec
// pourcentages (♣️ 95% / ┣━ N°1196 / ♦️ 94%). Les messages à plusieurs costumes SANS pourcentage sont ignorés (rapports…).
const NAME_SUIT = [[/carreau/i, '♦️'], [/c(?:o|œ|oe)ur/i, '❤️'], [/tr[èe]fle/i, '♣️'], [/pique/i, '♠️']];
function suitsIn(text) {
  const t = text.replace(/\uFE0F/g, '');
  const found = [];
  const re = /[♦♥❤♣♠]|carreau|c(?:o|œ|oe)ur|tr[èe]fle|pique/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const s = strategies.normSuit(m[0]) || (NAME_SUIT.find(([r]) => r.test(m[0])) || [])[1];
    if (s && !found.includes(s)) found.push(s);
  }
  return found;
}
function parsePost(text) {
  if (typeof text !== 'string' || !text || text.length > 1500 || text.trim().startsWith('/')) return null;
  if (/RETOUR APRÈS PERTE|BILAN RETOUR|D CONSTATÉ|ПОВТОР|🧪/i.test(text)) return null; // nos propres rapports, la fenêtre « RELANCE » de 10 s, les tests
  const t = text.replace(/\uFE0F/g, '');
  const n = /(?:N\s*[°º˚]|№|#)\s*:?\s*(\d{1,4})/i.exec(t) || /\bjeux?\s+(\d{1,4})\b/i.exec(t);
  if (!n) return null;
  const target = Number(n[1]);
  if (!(target > 0)) return null;
  const suits = suitsIn(text);
  if (!suits.length) return null;
  if (suits.length === 1) return { target, suits };
  return /\d\s*%/.test(t) ? { target, suits } : null; // format à deux costumes avec pourcentages
}

// appelé par le bot pour chaque NOUVELLE publication de canal (les modifications — résultats ajoutés — sont ignorées :
// c'est ce module qui vérifie lui-même les résultats sur les jeux réels)
function onChannelPost(chat, text) {
  try {
    if (!chat || chat.id == null) return false;
    const post = parsePost(text);
    if (!post) return false;
    const src = String(chat.id);
    const uname = chat.username ? `@${String(chat.username).toLowerCase()}` : null;
    let changed = false;
    for (const cfg of panel.configs.filter((c) => c.enabled)) {
      const matches = (cfg.sources || []).some((s) => String(s) === src || (uname && String(s).toLowerCase() === uname));
      if (!matches) continue;
      if ((cfg.channels || []).map(String).includes(src)) continue; // ne jamais suivre son propre canal de rapport
      if (cfg.keyword && !String(text).toLowerCase().includes(cfg.keyword.toLowerCase())) continue; // filtre facultatif (nom de la stratégie…)
      if (chat.title) panel.channelTitles[src] = String(chat.title).slice(0, 120);
      for (const suit of post.suits) {
        const key = `${cfg.id}:${src}:${post.target}:${suit}`;
        if (panel.seen.includes(key)) continue;
        if (panel.pending.some((e) => e.cfgId === cfg.id && e.suit === suit && e.target === post.target)) continue; // même prédiction déjà suivie (autre source)
        panel.seen.push(key); if (panel.seen.length > SEEN_MAX) panel.seen = panel.seen.slice(-SEEN_MAX);
        panel.pending.push({ id: `lr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: cfg.id, src, suit, target: post.target, phase: 'verif', status: 'en attente', at: Date.now() });
        changed = true;
      }
    }
    if (panel.pending.length > PENDING_MAX) panel.pending = panel.pending.slice(-PENDING_MAX);
    if (changed) persist();
    return changed;
  } catch (e) { panel.lastError = e.message; return false; }
}

// ── source « Relance » : messages d'origine et relances transmis directement par best-weak-top.js ──
function onRelanceSent(bwCfg, entry) {
  try {
    if (!bwCfg || !entry || !Array.isArray(entry.suits)) return false;
    let changed = false;
    for (const cfg of panel.configs.filter((c) => c.enabled && (c.relances || []).includes(String(bwCfg.id)))) {
      for (const it of entry.suits) {
        const suit = strategies.normSuit(it.suit); if (!suit) continue;
        const key = `${cfg.id}:rel:${entry.id}:${suit}`;
        if (panel.seen.includes(key)) continue;
        const same = panel.pending.find((e) => e.cfgId === cfg.id && e.suit === suit && e.target === Number(entry.target) && !e.bwId);
        if (same) { // déjà vu via l'envoi du canal : on l'enrichit (rattrapages et preuve de la relance) au lieu de le compter deux fois
          panel.seen.push(key); Object.assign(same, { src: `relance:${bwCfg.id}`, relName: bwCfg.name || 'Relance', bwId: entry.id, maxR: Number(entry.maxR) }); changed = true; continue;
        }
        panel.seen.push(key); if (panel.seen.length > SEEN_MAX) panel.seen = panel.seen.slice(-SEEN_MAX);
        panel.pending.push({ id: `lr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cfgId: cfg.id, src: `relance:${bwCfg.id}`, relName: bwCfg.name || 'Relance',
          bwId: entry.id, maxR: Number(entry.maxR), suit, target: Number(entry.target), phase: 'verif', status: 'en attente', at: Date.now() });
        changed = true;
      }
    }
    if (panel.pending.length > PENDING_MAX) panel.pending = panel.pending.slice(-PENDING_MAX);
    if (changed) persist();
    return changed;
  } catch (e) { panel.lastError = e.message; return false; }
}
// une relance est partie pour un costume pas venu : on retient son jeu (et ses rattrapages) pour comparer au D observé
function onRelaunchSent(bwCfg, parent, relEntry) {
  try {
    let changed = false;
    for (const e of panel.pending) {
      if (!parent || e.bwId !== parent.id || !String(e.src || '').startsWith('relance:')) continue;
      if (!(relEntry.suits || []).some((x) => strategies.normSuit(x.suit) === e.suit)) continue;
      e.relTarget = Number(relEntry.target); e.relMaxR = Number(relEntry.maxR) || 0; changed = true;
    }
    if (changed) persist();
    return changed;
  } catch (err) { panel.lastError = err.message; return false; }
}

// message envoyé par le bot lui-même (point d'envoi unique de bot.js) : même lecture que pour une publication de canal
function onOwnPost(chatId, text) { return onChannelPost({ id: chatId }, text); }

// ── analyse ────────────────────────────────────────────────────────────────
function topReturns(st, limit = 3) {
  return Object.entries(st.hist || {}).map(([d, n]) => ({ d: Number(d), n: Number(n) }))
    .sort((a, b) => b.n - a.n || a.d - b.d).slice(0, limit);
}
const pct = (a, b) => (b > 0 ? Math.round((a * 100) / b) : 0);
const rOf = (e, cfg) => (Number.isFinite(Number(e.maxR)) ? Number(e.maxR) : cfg.maxR); // rattrapages de la prédiction (ceux de la relance si la source est une relance)
const gameAfter = (e, cfg, d) => e.target + rOf(e, cfg) + d; // jeu à D après la fin des rattrapages (D=1 → N + R + 1)
// ce qui est venu quand le costume n'est pas venu au jeu suivant : miroir / inverse / autre costume, du plus fréquent au moins fréquent
function missBreakdown(st, suit) {
  const mir = MIRROR[suit]; const inv = INVERSE[suit];
  const label = (x) => (x === mir ? 'miroir' : x === inv ? 'inverse' : 'autre');
  return Object.entries(st.missSuits || {}).map(([x, n]) => ({ suit: x, n: Number(n), rate: pct(Number(n), st.miss), label: label(x) }))
    .sort((a, b) => b.n - a.n);
}
function adviceOf(cfg, suit, st, target) {
  const top = topReturns(st, 1)[0];
  const parts = [];
  if (top) {
    const bet = target ? ` (N°${gameAfter({ target }, cfg, top.d)} pour ce ${suit})` : '';
    parts.push(top.d === 1 ? `si ${suit} est perdu : miser sur le jeu suivant${bet}` : `si ${suit} est perdu : attendre D=${top.d}, soit ${top.d} jeux après la fin des rattrapages${bet}`);
  }
  const mb = missBreakdown(st, suit)[0];
  if (mb && st.miss > 0) parts.push(`si ${suit} n'est pas venu au jeu suivant : ${mb.suit} (${mb.label}) sort le plus souvent (${mb.rate}%)`);
  return { top, mb, parts };
}
function reportText(cfg, suit, target, opts = {}) {
  const R = Number.isFinite(Number(opts.maxR)) ? Number(opts.maxR) : cfg.maxR;
  const st = statsOf(cfg, suit);
  const top = topReturns(st, 3);
  const best = top[0];
  const L = [];
  if (opts.test) L.push('🧪 Test');
  L.push(`📉 RETOUR APRÈS PERTE${cfg.name ? ` — ${cfg.name}` : ''}${opts.relName ? ` · Relance « ${opts.relName} »` : ''}`);
  if (target) L.push(`${suit} perdu au N°${target} (${R} rattrapage${R > 1 ? 's' : ''} → ${target} + ${R} = ${Number(target) + R}, le jeu suivant est le N°${Number(target) + R + 1})`);
  else L.push(`${suit} perdu`);
  L.push('');
  L.push(`📊 ${st.lost} ${suit} perdu${st.lost > 1 ? 's' : ''} · ${st.resolved} retour${st.resolved > 1 ? 's' : ''} observé${st.resolved > 1 ? 's' : ''}${st.none ? ` · ${st.none} non revenu${st.none > 1 ? 's' : ''} en ${cfg.maxD} jeux` : ''}`);
  if (best) {
    L.push(`🎯 Après la perte, D = ${best.d} le plus souvent : ${best.n}/${st.resolved} (${pct(best.n, st.resolved)}%)`);
    if (top.length > 1) L.push(`   puis ${top.slice(1).map((x) => `D=${x.d} (${x.n})`).join(' · ')}`);
    L.push(best.d === 1 ? `👉 Si vous voyez ${suit} perdu : misez sur le jeu suivant${target ? ` (N°${gameAfter({ target, maxR: R }, cfg, 1)})` : ''}` : `👉 Si vous voyez ${suit} perdu : attendez D=${best.d} (${best.d} jeux après la fin des rattrapages)${target ? ` → N°${gameAfter({ target, maxR: R }, cfg, best.d)}` : ''}`);
  } else L.push('🎯 Pas encore de retour observé');
  const mb = missBreakdown(st, suit);
  if (st.miss > 0 && mb.length) L.push(`🔎 Quand ${suit} n'est pas venu au jeu suivant (${st.miss}×) : ${mb.map((x) => `${x.suit} ${x.label} ${x.rate}%`).join(' · ')}`);
  if (st.proofN > 0) L.push(`🧪 Preuve avec la Relance (${st.proofN} cas) : retour pile sur le jeu de la relance ${st.proofSame}× (${pct(st.proofSame, st.proofN)}%) · dans sa fenêtre de rattrapages ${st.proofWin}× (${pct(st.proofWin, st.proofN)}%)`);
  if (opts.test) L.push('(rapport de test : chiffres fictifs)');
  return L.join('\n');
}
// bilan : tous les costumes, avec les taux, et la conduite à tenir après une perte
function bilanText(cfg, opts = {}) {
  const L = [];
  if (opts.test) L.push('🧪 Test');
  L.push(`📊 BILAN RETOUR APRÈS PERTE${cfg.name ? ` — ${cfg.name}` : ''}`);
  L.push(`(${cfg.maxR} rattrapage${cfg.maxR > 1 ? 's' : ''} · D = jeux après la fin des rattrapages)`);
  let any = false;
  for (const suit of SUITS) {
    const st = statsOf(cfg, suit);
    if (!st.lost) continue;
    any = true;
    const adv = adviceOf(cfg, suit, st, null);
    const dists = topReturns(st, 4).map((x) => `D=${x.d} ${pct(x.n, st.resolved)}%`).join(' · ');
    L.push('');
    L.push(`${suit} : ${st.lost} perdu${st.lost > 1 ? 's' : ''} sur ${st.won + st.lost} · ${st.resolved} retour${st.resolved > 1 ? 's' : ''}${st.none ? ` · ${st.none} non revenu${st.none > 1 ? 's' : ''}` : ''}`);
    if (dists) L.push(`🎯 ${dists}`);
    const mb = missBreakdown(st, suit);
    if (st.miss > 0 && mb.length) L.push(`🔎 pas venu au jeu suivant (${st.miss}×) : ${mb.map((x) => `${x.suit} ${x.label} ${x.rate}%`).join(' · ')}`);
    if (st.proofN > 0) L.push(`🧪 Relance : retour pile sur son jeu ${pct(st.proofSame, st.proofN)}% · dans sa fenêtre ${pct(st.proofWin, st.proofN)}% (${st.proofN} cas)`);
    for (const part of adv.parts) L.push(`👉 ${part}`);
  }
  if (!any) L.push('', 'Aucune perte observée pour l’instant.');
  return L.join('\n');
}
async function sendTo(cfg, text) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return []; }
  const out = [];
  const results = await Promise.all((cfg.channels || []).map((id) => bot.sendMessage(id, text, {})
    .then((m) => (m && m.skipped ? { ok: false, skipped: true, id } : { ok: true, id }))
    .catch((e) => ({ ok: false, id, error: e.message }))));
  for (const r of results) { if (r.ok) out.push(r.id); else if (!r.skipped) panel.lastError = `${r.id} : ${r.error}`; }
  return out;
}

// ── vérification (appelée à chaque cycle du bot) ────────────────────────────
async function tick() {
  let changed = false;
  const maxDone = maxFinishedGameNumber();
  if (!maxDone || !panel.pending.length) return;
  for (const e of panel.pending) {
    const cfg = panel.configs.find((c) => c.id === e.cfgId);
    if (!cfg) { if (e.phase !== 'clos') { e.phase = 'clos'; e.status = 'annulé'; changed = true; } continue; }
    if (e.phase === 'verif') {
      let verdict = null;
      const R = rOf(e, cfg);
      for (let k = 0; k <= R; k++) {
        const g = state.games.get(e.target + k);
        if (!isDone(g)) { if (e.target + k + 2 <= maxDone) verdict = 'annulé'; break; } // jeu manquant : on abandonne cette prédiction
        if (hasSuit(g, e.suit)) { verdict = 'gagné'; break; }
        if (k === R) verdict = 'perdu';
      }
      if (!verdict) continue;
      changed = true;
      const st = statsOf(cfg, e.suit);
      if (verdict === 'annulé') { e.phase = 'clos'; e.status = 'annulé'; continue; }
      if (verdict === 'gagné') { st.won += 1; e.phase = 'clos'; e.status = 'gagné'; continue; }
      st.lost += 1;
      e.status = 'perdu'; e.phase = 'retour'; e.scanFrom = e.target + R + 1; e.lostAt = Date.now();
      persist();
      if (st.lost >= (cfg.minSample || 0)) {
        try {
          const sent = await sendTo(cfg, reportText(cfg, e.suit, e.target, { maxR: R, relName: e.relName }));
          if (sent.length) {
            cfg.reportsSent = (cfg.reportsSent || 0) + 1; cfg.sinceBilan = (cfg.sinceBilan || 0) + 1; cfg.lastReportAt = Date.now();
            if (cfg.bilanEvery > 0 && cfg.sinceBilan >= cfg.bilanEvery) { cfg.sinceBilan = 0; await sendTo(cfg, bilanText(cfg)); }
          }
        } catch (err) { panel.lastError = err.message; }
      }
    }
    if (e.phase === 'retour') {
      const st = statsOf(cfg, e.suit);
      const lastGame = gameAfter(e, cfg, cfg.maxD);
      let n = e.scanFrom || gameAfter(e, cfg, 1);
      for (; n <= lastGame; n++) {
        const g = state.games.get(n);
        if (!isDone(g)) { if (n + 2 <= maxDone) continue; break; } // jeu manquant ignoré ; jeu pas encore joué : on attend
        const d = n - (e.target + rOf(e, cfg)); // D : 1 = le jeu suivant la fin des rattrapages
        const hit = hasSuit(g, e.suit);
        if (d === 1 && !e.nextChecked) { // le costume n'est pas venu au jeu suivant : on note ce qui est venu à la place
          e.nextChecked = true;
          if (!hit) { st.miss += 1; for (const x of SUITS) if (x !== e.suit && hasSuit(g, x)) { st.missSuits[x] = (st.missSuits[x] || 0) + 1; if (x === MIRROR[e.suit]) st.mirror += 1; if (x === INVERSE[e.suit]) st.inverse += 1; } }
        }
        if (hit) {
          st.resolved += 1; st.hist[d] = (st.hist[d] || 0) + 1; e.returnD = d; e.phase = 'clos'; changed = true;
          if (Number.isFinite(e.relTarget)) { // preuve du D avec la relance : retour sur le jeu de la relance ?
            st.proofN += 1; if (n === e.relTarget) st.proofSame += 1;
            if (n >= e.relTarget && n <= e.relTarget + (e.relMaxR || 0)) st.proofWin += 1;
          }
          if (e.relName) { // source « Relance » : on confirme le D constaté dans le canal des rapports
            const lines = [`🔎 D CONSTATÉ — Relance « ${e.relName} »`, `${e.suit} perdu au N°${e.target} (${rOf(e, cfg)} rattrapage${rOf(e, cfg) > 1 ? 's' : ''}) · revenu au N°${n} : D = ${d}`];
            if (Number.isFinite(e.relTarget)) lines.push(n === e.relTarget ? `✅ La relance était au N°${e.relTarget} : retour pile sur son jeu` : (n > e.relTarget && n <= e.relTarget + (e.relMaxR || 0)) ? `✅ La relance était au N°${e.relTarget} : retour dans sa fenêtre de rattrapages` : `❌ La relance était au N°${e.relTarget} : retour ${n > e.relTarget ? 'après' : 'avant'} sa fenêtre (D de la relance = ${e.relTarget - (e.target + rOf(e, cfg))})`);
            else lines.push('Aucune relance n’est partie pour ce costume.');
            try { await sendTo(cfg, lines.join('\n')); } catch (err) { panel.lastError = err.message; }
          }
          break;
        }
      }
      if (e.phase === 'retour') {
        if (n > lastGame) { st.none += 1; e.returnD = null; e.phase = 'clos'; changed = true; }
        else if (e.scanFrom !== n) { e.scanFrom = n; changed = true; }
      }
    }
  }
  const before = panel.pending.length;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  panel.pending = panel.pending.filter((e) => e.phase !== 'clos' || (e.lostAt || e.at) > cutoff).slice(-PENDING_MAX);
  if (changed || panel.pending.length !== before) persist();
}

// ── configurations ──────────────────────────────────────────────────────────
function normalizeConfig(c) {
  const maxR = clampInt(c.maxR, 0, 9, DEFAULT_MAXR);
  const maxD = clampInt(c.maxD, 1, 40, DEFAULT_MAXD);
  const stats = {};
  for (const s of SUITS) { const x = (c.stats || {})[s]; if (x && typeof x === 'object') stats[s] = { ...emptyStats(), ...x, hist: x.hist && typeof x.hist === 'object' ? { ...x.hist } : {}, missSuits: x.missSuits && typeof x.missSuits === 'object' ? { ...x.missSuits } : {} }; }
  return {
    id: String(c.id), name: sanitizeName(c.name), enabled: c.enabled !== false,
    sources: parseChannels(c.sources).map(String), relances: (Array.isArray(c.relances) ? c.relances : []).map(String).filter(Boolean), channels: parseChannels(c.channels),
    keyword: sanitizeName(c.keyword).slice(0, 40), maxR, maxD, minSample: clampInt(c.minSample, 0, 500, DEFAULT_MIN_SAMPLE), bilanEvery: clampInt(c.bilanEvery, 0, 500, DEFAULT_BILAN_EVERY), sinceBilan: Number(c.sinceBilan) || 0,
    stats, reportsSent: Number(c.reportsSent) || 0, lastReportAt: c.lastReportAt || null,
  };
}
function addConfig(input) {
  const sources = parseChannels(input.sources); const channels = parseChannels(input.channels);
  const relancesIn = Array.isArray(input.relances) ? input.relances : [];
  if (!sources.length && !relancesIn.length) throw new Error('Coche au moins un canal ou une relance à suivre.');
  if (!channels.length) throw new Error('Renseigne au moins un canal où envoyer le rapport.');
  if (sources.some((s) => channels.map(String).includes(String(s)))) throw new Error('Le canal suivi et le canal du rapport doivent être différents.');
  const cfg = normalizeConfig({ ...input, relances: relancesIn, id: `lr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sources, channels, stats: {} });
  panel.configs.push(cfg); persist(); return cfg;
}
function updateConfig(id, patch) {
  const c = panel.configs.find((x) => x.id === id);
  if (!c) throw new Error('Configuration introuvable.');
  const next = { ...c, ...Object.fromEntries(Object.entries(patch || {}).filter(([k]) => ['name', 'enabled', 'keyword', 'sources', 'relances', 'channels', 'maxR', 'maxD', 'minSample', 'bilanEvery'].includes(k))) };
  if (!parseChannels(next.sources).length && !(Array.isArray(next.relances) && next.relances.length)) throw new Error('Coche au moins un canal ou une relance à suivre.');
  if (!parseChannels(next.channels).length) throw new Error('Renseigne au moins un canal où envoyer le rapport.');
  if (parseChannels(next.sources).some((s) => parseChannels(next.channels).map(String).includes(String(s)))) throw new Error('Le canal suivi et le canal du rapport doivent être différents.');
  const out = normalizeConfig({ ...next, stats: patch && patch.resetStats ? {} : c.stats });
  Object.keys(c).forEach((k) => delete c[k]); Object.assign(c, out);
  if (patch && patch.resetStats) panel.pending = panel.pending.filter((e) => e.cfgId !== id);
  persist(); return c;
}
function removeConfig(id) { panel.configs = panel.configs.filter((c) => c.id !== id); panel.pending = panel.pending.filter((e) => e.cfgId !== id); persist(); return true; }
function setChannelTitle(id, title) { const k = String(id == null ? '' : id).trim(); if (!k || !title) return; panel.channelTitles[k] = String(title).slice(0, 120); persist(); }

function demoConfig(cfg) {
  const demo = normalizeConfig({ ...cfg, stats: {} });
  demo.stats['♦️'] = { ...emptyStats(), won: 20, lost: 34, resolved: 30, none: 2, miss: 19, mirror: 9, inverse: 6, missSuits: { '❤️': 9, '♠️': 6, '♣️': 4 }, hist: { 1: 11, 2: 8, 3: 6, 4: 3, 6: 2 }, proofN: 12, proofSame: 5, proofWin: 8 };
  return demo;
}
async function test(id) {
  const cfg = panel.configs.find((c) => c.id === id);
  if (!cfg) return { ok: false, error: 'Configuration introuvable.' };
  const demo = demoConfig(cfg);
  const sent = await sendTo(cfg, reportText(demo, '♦️', 12, { test: true }));
  await sendTo(cfg, bilanText(demo, { test: true }));
  return sent.length ? { ok: true, sent } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}
async function sendBilan(id) {
  const cfg = panel.configs.find((c) => c.id === id);
  if (!cfg) return { ok: false, error: 'Configuration introuvable.' };
  const sent = await sendTo(cfg, bilanText(cfg));
  if (sent.length) { cfg.sinceBilan = 0; persist(); }
  return sent.length ? { ok: true, sent } : { ok: false, error: panel.lastError || 'Envoi impossible' };
}

// ── vue pour le tableau de bord ─────────────────────────────────────────────
function status() {
  return {
    configs: panel.configs.map((c) => ({
      ...c,
      sourceNames: (c.sources || []).map((id) => panel.channelTitles[String(id)] || String(id)),
      relanceIds: c.relances || [],
      channelNames: (c.channels || []).map((id) => panel.channelTitles[String(id)] || String(id)),
      pending: panel.pending.filter((e) => e.cfgId === c.id && e.phase !== 'clos').length,
      suits: SUITS.map((s) => {
        const st = statsOf(c, s);
        const top = topReturns(st, 4);
        return { suit: s, won: st.won, lost: st.lost, resolved: st.resolved, none: st.none, miss: st.miss, proofN: st.proofN, proofSame: st.proofSame, proofWin: st.proofWin,
          top: top.map((x) => ({ ...x, rate: pct(x.n, st.resolved) })), came: missBreakdown(st, s), advice: adviceOf(c, s, st, null).parts };
      }).filter((x) => x.won || x.lost),
    })),
    lastError: panel.lastError, channelTitles: panel.channelTitles,
  };
}

// ── persistance ─────────────────────────────────────────────────────────────
function persist() {
  const saved = { configs: panel.configs, pending: panel.pending, seen: panel.seen, channelTitles: panel.channelTitles };
  try { store.patch({ lossReturn: saved }); } catch (_) {}
  if (db.ready) db.setSetting('loss_return_state', JSON.stringify(saved)).catch((e) => { panel.lastError = e.message; });
}
function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  panel.configs = (Array.isArray(saved.configs) ? saved.configs : []).filter((c) => c && c.id).map(normalizeConfig);
  panel.pending = Array.isArray(saved.pending) ? saved.pending.filter((e) => e && e.id).slice(-PENDING_MAX) : [];
  panel.seen = Array.isArray(saved.seen) ? saved.seen.slice(-SEEN_MAX) : [];
  panel.channelTitles = saved.channelTitles && typeof saved.channelTitles === 'object' ? saved.channelTitles : {};
}
function restore() { try { const s = (store.read() || {}).lossReturn; if (s) applySaved(s); } catch (_) {} }
async function restoreFromDb() {
  if (!db.ready) return;
  try { const raw = await db.getSetting('loss_return_state'); if (raw) applySaved(JSON.parse(raw)); else persist(); } catch (_) { persist(); }
}

module.exports = {
  panel, setSender, restore, restoreFromDb, persist, parseChannels, parsePost, onChannelPost, onOwnPost, tick, status, test,
  addConfig, updateConfig, removeConfig, setChannelTitle, reportText, bilanText, sendBilan, onRelanceSent, onRelaunchSent,
};
