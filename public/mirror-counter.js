// mirror-counter.js — « Taux Miroir » : compte, pour CHAQUE carte
// distribuée (pas juste « ce costume apparaît-il dans la main »), le
// costume du JOUEUR et celui du BANQUIER séparément, depuis le dernier
// reset. Publié dans un canal Telegram configuré une fois (bouton
// « Compteur » du tableau de bord) après chaque jeu terminé, et remis à
// zéro automatiquement à chaque heure pile (ex. 14h00, 15h00…), quelle que
// soit l'heure du dernier reset précédent.
'use strict';

const store = require('./store');
const db = require('./db');
// normSuit() = normalisation canonique unique du projet (❤️, pas ♥️ — deux
// caractères Unicode DIFFÉRENTS qui se ressemblent visuellement : U+2764+VS16
// ici, contre U+2665+VS16 pour l'autre). BUG CORRIGÉ : ce fichier utilisait sa
// propre liste SUITS locale avec '♥️' (U+2665), alors que playerSuits/
// bankerSuits (venant du flux de jeu) sont toujours normalisés en '❤️'
// (U+2764) par normSuit() dans strategies.js — donc `state.player['♥️']`
// n'existait jamais et le cœur restait bloqué à 0, quel que soit le nombre
// de cœurs réellement distribués. On réutilise donc normSuit() de
// strategies.js (source canonique unique) dans bump() ci-dessous, au lieu de
// comparer directement le caractère brut reçu.
const { normSuit } = require('./strategies');

// Ordre d'affichage du rapport (inchangé) — mais avec le bon caractère ❤️.
const SUITS = ['♠️', '❤️', '♦️', '♣️'];
const RESET_INTERVAL_MS = 60 * 60 * 1000; // 1 heure

const state = {
  channelId: '',
  player: { '♠️': 0, '❤️': 0, '♦️': 0, '♣️': 0 },
  banker: { '♠️': 0, '❤️': 0, '♦️': 0, '♣️': 0 },
  games: 0,             // nombre de jeux comptés depuis le dernier reset
  lastGameNumber: null, // évite de compter deux fois le même jeu
  sinceAt: Date.now(),
  messageId: null,       // pour ÉDITER le même message plutôt que spammer le canal à chaque jeu
};

let sendFn = null; // enregistrée par bot.js : async (channelId, text, messageId) => nouveau messageId
function setSender(fn) { sendFn = fn; }

// ---------------------------------------------------------------------------
// Persistance du canal choisi (même mécanisme que les autres réglages
// simples du bot : data.json en repli local, base en source de vérité).
// ---------------------------------------------------------------------------
function persist() {
  store.patch({ mirrorCounter: { channelId: state.channelId } });
  if (db.ready) db.setSetting('mirror_counter_channel', state.channelId).catch(() => {});
}

(function loadInitial() {
  try {
    const saved = store.read().mirrorCounter;
    if (saved && saved.channelId) state.channelId = String(saved.channelId);
  } catch (_) { /* pas grave : repli sur la base au démarrage */ }
})();

// appelée depuis bot.js une fois la base confirmée prête (même pattern que
// shop.loadFromDb) : la base prime sur data.json si elle contient une valeur.
async function loadFromDb() {
  if (!db.ready) return false;
  try {
    const v = await db.getSetting('mirror_counter_channel');
    if (v) state.channelId = v;
    return true;
  } catch (_) { return false; }
}

function setChannel(id) {
  state.channelId = String(id || '').trim();
  persist();
  return state.channelId;
}
function getChannel() { return state.channelId; }

function resetCounts() {
  for (const s of SUITS) { state.player[s] = 0; state.banker[s] = 0; }
  state.games = 0;
  state.sinceAt = Date.now();
  state.messageId = null; // prochain envoi = nouveau message, pas une édition de l'ancien
}

// appelée une fois par jeu terminé (voir bot.js, même point que db.saveGame).
function bump(round) {
  if (!round || !round.finished) return;
  if (state.lastGameNumber === round.number) return; // déjà compté
  state.lastGameNumber = round.number;
  // normSuit() absorbe toute variante ('♥', '❤', avec/sans le sélecteur de
  // variante ️) et renvoie toujours le costume canonique du projet — c'est
  // exactement ce qui manquait ici avant.
  for (const raw of (round.playerSuits || [])) { const s = normSuit(raw); if (s && state.player[s] != null) state.player[s] += 1; }
  for (const raw of (round.bankerSuits || [])) { const s = normSuit(raw); if (s && state.banker[s] != null) state.banker[s] += 1; }
  state.games += 1;
}

function pct(count, total) {
  if (!total) return '0.0';
  return ((count / total) * 100).toFixed(1);
}

function block(title, icon, counts) {
  const total = SUITS.reduce((sum, s) => sum + counts[s], 0);
  const lines = [`📈 Taux Miroir — ${icon} ${title}`, '', '━━━━━━━━━━━━━━━━━━', ''];
  for (const s of SUITS) lines.push(`${s} : ${counts[s]}  (${pct(counts[s], total)}%)`);
  lines.push('');
  lines.push(`📊 Total : ${total} cartes`);
  return lines.join('\n');
}

function msUntilNextHour() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next.getTime() - now.getTime();
}

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}min ${sec}s`;
}

function buildMessage(gameNumber) {
  return [
    block('Joueur', '👤', state.player),
    '',
    block('Banquier', '🏦', state.banker),
    '━━━━━━━━━━━━━━━━━━',
    `🎮 Jeu #${gameNumber ?? '—'}  |  📊 ${state.games} jeu(x) depuis dernier reset`,
    `⏭ Reset dans ${formatCountdown(msUntilNextHour())}  (Intervalle 60min)`,
  ].join('\n');
}

// Publie (ou met à jour) le message dans le canal configuré. Éditer le même
// message d'une publication à l'autre évite de spammer le canal à chaque
// jeu ; un nouveau message est recréé après chaque reset horaire (voir
// resetCounts, qui vide messageId) ou si l'édition échoue (message trop
// vieux/supprimé côté Telegram).
async function publish(gameNumber) {
  if (!state.channelId || !sendFn) return;
  const text = buildMessage(gameNumber);
  try {
    // un NOUVEAU message à chaque jeu terminé (pas d'édition) : le canal
    // garde ainsi la trace du compteur jeu après jeu.
    await sendFn(state.channelId, text, null);
  } catch (e) {
    state.messageId = null;
    console.error('Compteur (Taux Miroir) :', e.message);
  }
}

// Reset systématiquement calé sur l'heure PILE (14h00, 15h00…), pas 1h après
// le démarrage du process — recalculé à chaque déclenchement pour rester
// exact même si le serveur redémarre entre-temps.
let resetTimer = null;
function scheduleHourlyReset() {
  if (resetTimer) clearTimeout(resetTimer);
  const fire = () => {
    resetCounts(); // remise à zéro pile à h00, puis on repart de zéro
    resetTimer = setTimeout(fire, RESET_INTERVAL_MS);
  };
  resetTimer = setTimeout(fire, msUntilNextHour());
}

module.exports = {
  SUITS,
  setSender,
  setChannel,
  getChannel,
  bump,
  buildMessage,
  publish,
  resetCounts,
  scheduleHourlyReset,
  loadFromDb,
  state,
};
