// statistics.js — nouveau bouton « Statistiques » (demande admin) : ce
// panneau n'est PAS un panneau de prédiction. Il relaie tel quel, vers un
// canal Telegram configuré, les cartes/costumes BRUTS reçus de l'API Baccara
// (les mêmes données déjà visibles dans le bouton « Canaux »/diagnostics),
// mis en forme selon la notation demandée :
//
//   #N<numéro>. [✅]<point joueur>(<cartes joueur>) [-|🔰] [✅]<point banquier>(<cartes banquier>) #T<total> <couleur>[#X][ #R]
//
//   ⏰   : jeu EN COURS (pas encore terminé) — préfixe le message.
//   ▶️   : placé devant le point de la main qui est en train de tirer sa
//          3ᵉ carte (calculé à partir des règles officielles du baccara —
//          voir drawingSide() plus bas — puisque l'API ne l'indique pas
//          explicitement avant l'arrivée effective de la carte).
//   ✅   : placé devant le point de la main GAGNANTE, une fois le jeu
//          terminé et si ce n'est pas un match nul.
//   🔰   : remplace le « - » entre les deux mains quand joueur et banquier
//          ont le MÊME point après la fin du jeu (égalité).
//   #T   : total = point joueur + point banquier (une fois le jeu terminé).
//   #X   : ajouté (collé à l'émoji couleur, sans espace) quand le jeu est
//          un match nul.
//   #R   : ajouté (avec un espace) quand, une fois le jeu terminé, les DEUX
//          mains n'ont reçu QUE 2 cartes chacune (aucun tirage de 3ᵉ carte).
//   couleur : 🔵 joueur gagnant, 🔴 banquier gagnant, 🟣 match nul.
//
// Un jeu qui n'a pas encore commencé (aucune carte reçue) n'est jamais
// envoyé. Dès qu'il démarre, un message est envoyé puis ÉDITÉ au fil des
// mises à jour (arrivée des cartes, 3ᵉ carte, fin de jeu) — jamais renvoyé
// en double.
'use strict';

const store = require('./store');
const db = require('./db');
const { state } = require('./predictor');

const panel = {
  enabled: true,
  channels: [],
  sentCount: 0,
  lastSentAt: null,
  lastScanAt: null,
  lastError: null,
  // suivi des jeux déjà envoyés/édités durant le sabot en cours : numéro de
  // jeu -> { messages: [{chatId, messageId}], signature, finished }.
  tracked: {},
};

let sender = null;
function setSender(fn) { sender = fn; }
let busy = false;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function parseChannels(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n) && n !== 0 && !out.includes(n)) out.push(n);
    } else {
      const name = t.startsWith('@') ? t : `@${t.replace(/^https?:\/\/t\.me\//i, '')}`;
      if (name.length > 2 && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) panel.enabled = !!patch.enabled;
  if (patch.channels !== undefined) panel.channels = parseChannels(patch.channels);
  persist();
  return config();
}

function config() {
  return { enabled: panel.enabled, channels: panel.channels };
}

// ---------------------------------------------------------------------------
// Règles officielles du baccara — détecte quelle main est en train de tirer
// sa 3ᵉ carte, à partir des DEUX cartes déjà connues (et, si le joueur a déjà
// tiré, de la valeur exacte de sa 3ᵉ carte pour le tableau du banquier).
// ---------------------------------------------------------------------------
function cardBaccaratValue(label) {
  if (!label) return 0;
  const m = String(label).match(/^(10|[2-9]|[AJQKajqk])/);
  if (!m) return 0;
  const t = m[1].toUpperCase();
  if (t === 'A') return 1;
  if (t === 'J' || t === 'Q' || t === 'K' || t === '10') return 0;
  return Number(t);
}

function drawingSide(g) {
  if (g.finished) return null;
  if ((g.playerCards || 0) < 2 || (g.bankerCards || 0) < 2) return null;
  const pv = g.playerValue, bv = g.bankerValue;
  if (pv == null || bv == null) return null;
  if (g.playerCards === 2 && g.bankerCards === 2) {
    if (pv >= 8 || bv >= 8) return null; // naturel (8 ou 9) : personne ne tire
    if (pv <= 5) return 'player';
    // le joueur reste sur 6/7 : le banquier applique alors la même règle
    // simple (pas de 3ᵉ carte joueur à prendre en compte).
    if (bv <= 5) return 'banker';
    return null; // les deux restent : le jeu se termine sans tirage
  }
  if (g.playerCards === 3 && g.bankerCards === 2) {
    // le joueur a tiré sa 3ᵉ carte : tableau officiel du banquier, basé sur
    // SA main de 2 cartes et la valeur exacte de la 3ᵉ carte du joueur.
    if (bv <= 2) return 'banker';
    const p3 = cardBaccaratValue((g.player || [])[2]);
    if (bv === 3) return p3 !== 8 ? 'banker' : null;
    if (bv === 4) return (p3 >= 2 && p3 <= 7) ? 'banker' : null;
    if (bv === 5) return (p3 >= 4 && p3 <= 7) ? 'banker' : null;
    if (bv === 6) return (p3 === 6 || p3 === 7) ? 'banker' : null;
    return null; // banquier à 7 : reste toujours
  }
  return null; // les deux mains ont déjà leurs cartes finales : on attend le résultat
}

// ---------------------------------------------------------------------------
// Rendu du message pour un jeu donné (voir le commentaire d'en-tête pour la
// notation complète).
// ---------------------------------------------------------------------------
function buildLine(g) {
  const pCards = (g.player || []).join('');
  const bCards = (g.banker || []).join('');
  const pv = g.playerValue ?? 0;
  const bv = g.bankerValue ?? 0;
  if (!g.finished) {
    const side = drawingSide(g);
    const playerMark = side === 'player' ? '▶️' : '';
    const dash = side === 'banker' ? '-▶️' : '-';
    return `⏰ #N${g.number}. ${playerMark}${pv}(${pCards}) ${dash} ${bv}(${bCards})`;
  }
  const tie = g.winner === 'Égalité' || pv === bv;
  const playerMark = (!tie && g.winner === 'Joueur') ? '✅' : '';
  const bankerMark = (!tie && g.winner === 'Banquier') ? '✅' : '';
  const sep = tie ? '🔰' : '-';
  const color = tie ? '🟣' : (g.winner === 'Joueur' ? '🔵' : '🔴');
  const hasR = g.playerCards === 2 && g.bankerCards === 2;
  let tail = `#T${pv + bv} ${color}`;
  if (tie) tail += '#X';
  if (hasR) tail += ' #R';
  return `#N${g.number}. ${playerMark}${pv}(${pCards}) ${sep} ${bankerMark}${bv}(${bCards}) ${tail}`;
}

// signature : ne réédite un message QUE si quelque chose de visible a
// réellement changé depuis le dernier envoi/édition (évite les appels
// Telegram inutiles à chaque tick).
function signatureOf(g) {
  return [
    g.playerCards, g.bankerCards, g.playerValue, g.bankerValue,
    g.finished ? 1 : 0, g.winner || '',
  ].join('|');
}

function hasStarted(g) {
  return g.complete !== false && ((g.playerCards || 0) > 0 || (g.bankerCards || 0) > 0);
}

// BLOCAGE (demande admin) : l'API peut renvoyer/fusionner des jeux d'une
// AUTRE table/flux que celle réellement suivie (numérotation qui repart de
// très bas, mélangée aux vrais numéros du jeu en cours — ex. #N1..#N9
// mélangés à #N409/#N410). On ne relaie QUE le jeu réellement EN DIRECT
// (state.live, déjà calculé par predictor.js — c'est lui la référence de
// « quelle table on suit vraiment », pas une simple proximité de numéro) —
// plus, pour finir proprement son édition finale, un jeu déjà suivi (il
// ÉTAIT le jeu en direct à un tour précédent, avant de se terminer). Tout
// le reste est bloqué : il ne vient pas de la table réellement suivie.
function isRealLiveGame(g) {
  if (state.live && g.number === state.live.number) return true;
  if (panel.tracked[g.number]) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Envoi / édition
// ---------------------------------------------------------------------------
async function sendNew(g, text) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return null; }
  if (!panel.channels.length) { panel.lastError = 'Aucun canal configuré pour les statistiques'; return null; }
  const results = await Promise.all(panel.channels.map((id) =>
    bot.sendMessage(id, text)
      .then((m) => ({ ok: true, id, messageId: m.message_id }))
      .catch((e) => ({ ok: false, id, error: e.message }))
  ));
  const sentMessages = results.filter((r) => r.ok).map((r) => ({ chatId: r.id, messageId: r.messageId }));
  const errors = results.filter((r) => !r.ok).map((r) => `${r.id} : ${r.error}`);
  if (!sentMessages.length) { panel.lastError = errors[0] || 'Envoi impossible'; return null; }
  panel.sentCount = (panel.sentCount || 0) + 1;
  panel.lastSentAt = Date.now();
  panel.lastError = errors.length ? errors[0] : null;
  return sentMessages;
}

async function editExisting(messages, text) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return;
  await Promise.all(messages.map((m) =>
    bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId }).catch(() => {})
  ));
}

async function processGame(g) {
  if (!hasStarted(g)) return; // « un jeu qui n'a pas encore commencé n'est pas envoyé »
  if (!isRealLiveGame(g)) return; // pas la table réellement suivie : on bloque
  const sig = signatureOf(g);
  const entry = panel.tracked[g.number];
  const text = buildLine(g);
  if (!entry) {
    const sentMessages = await sendNew(g, text);
    if (sentMessages) panel.tracked[g.number] = { messages: sentMessages, signature: sig, finished: !!g.finished };
    return;
  }
  if (entry.signature === sig) return; // rien de visible n'a changé depuis la dernière fois
  entry.signature = sig;
  entry.finished = !!g.finished;
  await editExisting(entry.messages, text);
}

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------
function persist() {
  const saved = { config: config(), tracked: panel.tracked, sentCount: panel.sentCount, lastSentAt: panel.lastSentAt, lastScanAt: panel.lastScanAt };
  try { store.patch({ statistics: saved }); } catch (_) {}
  if (db.ready) db.setSetting('statistics_state', JSON.stringify(saved)).catch((error) => { panel.lastError = error.message; });
}

function applySaved(saved) {
  if (saved.config) {
    panel.enabled = saved.config.enabled !== false;
    panel.channels = parseChannels(saved.config.channels);
  }
  // les messages suivis (numéro -> ids Telegram) sont conservés pour
  // pouvoir continuer à ÉDITER les jeux en cours après un redémarrage —
  // contrairement aux panneaux de prédiction, ici on ne « repart jamais de
  // zéro » : perdre ce suivi enverrait un doublon du jeu en cours.
  panel.tracked = (saved.tracked && typeof saved.tracked === 'object') ? saved.tracked : {};
  if (Number.isFinite(Number(saved.sentCount))) panel.sentCount = Number(saved.sentCount);
  panel.lastSentAt = saved.lastSentAt || null;
  panel.lastScanAt = saved.lastScanAt || null;
}

function restore() {
  try {
    const saved = (store.read() || {}).statistics;
    if (saved) applySaved(saved);
  } catch (_) {}
  return config();
}

async function restoreFromDb() {
  if (!db.ready) return config();
  try {
    const raw = await db.getSetting('statistics_state');
    if (raw) applySaved(JSON.parse(raw));
    else persist();
  } catch (_) { persist(); }
  return config();
}

const { setOnShoeReset } = require('./predictor');
setOnShoeReset(() => {
  // les numéros de jeu repartent à 1 à chaque nouveau sabot : le suivi de
  // l'ancien sabot n'a plus aucun sens (et créerait des collisions avec les
  // nouveaux numéros).
  panel.tracked = {};
  persist();
});

// ---------------------------------------------------------------------------
// Boucle de traitement
// ---------------------------------------------------------------------------
async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    const games = [...state.games.values()].sort((a, b) => a.number - b.number);
    for (const g of games) await processGame(g);
    // purge : les jeux terminés et déjà édités une dernière fois n'ont plus
    // besoin d'être gardés en mémoire indéfiniment (on garde une marge pour
    // les tours qui reviendraient en correction tardive du flux).
    const numbers = Object.keys(panel.tracked).map(Number).sort((a, b) => a - b);
    if (numbers.length > 400) {
      for (const n of numbers.slice(0, numbers.length - 400)) {
        if (panel.tracked[n] && panel.tracked[n].finished) delete panel.tracked[n];
      }
    }
    panel.lastScanAt = Date.now();
  } catch (e) {
    panel.lastError = e.message;
  } finally {
    persist();
    busy = false;
  }
  return panel;
}

async function test() {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, error: 'Aucun token Telegram configuré' };
  if (!panel.channels.length) return { ok: false, error: 'Aucun canal configuré' };
  const sample = '#N0000. ✅8(6♠️2♦️) - 0(J♠️Q♣️) #T8 🔵 #R';
  const sent = [];
  const errors = [];
  for (const id of panel.channels) {
    try {
      await bot.sendMessage(id, `📊 STATISTIQUES — message de test\n\nExemple de rendu :\n${sample}`);
      sent.push(String(id));
    } catch (e) { errors.push(`${id} : ${e.message}`); }
  }
  return { ok: sent.length > 0, sent, errors };
}

function statusView() {
  return {
    ...config(),
    trackedCount: Object.keys(panel.tracked).length,
    sentCount: panel.sentCount,
    lastSentAt: panel.lastSentAt,
    lastScanAt: panel.lastScanAt,
    lastError: panel.lastError,
  };
}

module.exports = {
  panel, setSender, tick, test, status: statusView, config, configure,
  restore, restoreFromDb, parseChannels, buildLine, drawingSide,
};
