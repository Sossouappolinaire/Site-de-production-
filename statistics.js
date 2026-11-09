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
  if (patch.channels !== undefined) {
    const next = parseChannels(patch.channels);
    // les identifiants de messages suivis appartiennent aux anciens canaux : on ne doit JAMAIS
    // les éditer dans un autre canal (c'était une source de désordre).
    if (JSON.stringify(next) !== JSON.stringify(panel.channels)) panel.tracked = {};
    panel.channels = next;
  }
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
// (state.live, déjà calculé par predictor.js) — plus, pour finir proprement
// son édition finale, un jeu déjà suivi (il ÉTAIT le jeu en direct à un
// tour précédent, avant de se terminer).
//
// RATTRAPAGE (correctif : « ça saute des jeux ») : certains jeux se
// terminent si vite entre deux sondages (≈1,5 s) qu'ils ne sont JAMAIS
// capturés comme « en direct » — ils apparaissent déjà terminés dès la
// première fois qu'on les voit. Sans rattrapage, isRealLiveGame() les
// bloquerait à tort (ni state.live, ni déjà suivi), créant des trous dans
// le flux (#N448 puis #N451 directement, par exemple). On les accepte donc
// aussi s'ils sont CONTIGUS avec ce qu'on a déjà confirmé comme réellement
// suivi (le jeu en direct actuel, ou le dernier numéro déjà suivi) — une
// autre table, elle, reste à des centaines de numéros d'écart et donc
// bloquée.
const CATCHUP_WINDOW = 15;
function maxTrackedNumber() {
  const nums = Object.keys(panel.tracked).map(Number);
  return nums.length ? Math.max(...nums) : null;
}
function isRealLiveGame(g) {
  if (state.live && g.number === state.live.number) return true;
  if (panel.tracked[g.number]) return true;
  const ref = state.live ? state.live.number : maxTrackedNumber();
  if (ref == null) return true; // rien à comparer encore : on laisse passer prudemment
  return g.finished && g.number < ref && (ref - g.number) <= CATCHUP_WINDOW;
}

// ---------------------------------------------------------------------------
// Envoi / édition
// ---------------------------------------------------------------------------
const realIdCache = new Map(); // saisie du canal (ID ou @nom) -> identifiant réel Telegram
async function sendNew(g, text) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) { panel.lastError = 'Aucun token Telegram configuré'; return null; }
  if (!panel.channels.length) { panel.lastError = 'Aucun canal configuré pour les statistiques'; return null; }
  // envoi canal par canal, dans l'ordre : un même canal réel saisi deux fois (ID + @nom) ne reçoit qu'un message.
  const results = [];
  const reached = new Set();
  for (const id of panel.channels) {
    try {
      // canal déjà reconnu comme identique à un autre (ID + @nom) : on n'envoie même pas
      if (realIdCache.has(String(id)) && reached.has(realIdCache.get(String(id)))) continue;
      const m = await bot.sendMessage(id, text);
      const real = String((m && m.chat && m.chat.id) != null ? m.chat.id : id);
      realIdCache.set(String(id), real);
      if (reached.has(real)) { // doublon de configuration : on supprime le message en trop
        if (m && m.message_id != null) { try { await bot.deleteMessage(real, m.message_id); } catch (_) { /* best-effort */ } }
        continue;
      }
      reached.add(real);
      results.push({ ok: true, id: (m && m.chat && m.chat.id != null) ? m.chat.id : id, messageId: m && m.message_id });
    } catch (e) { results.push({ ok: false, id, error: e.message }); }
  }
  const sentMessages = results.filter((r) => r.ok && r.messageId != null).map((r) => ({ chatId: r.id, messageId: r.messageId }));
  const errors = results.filter((r) => !r.ok).map((r) => `${r.id} : ${r.error}`);
  if (!sentMessages.length) { panel.lastError = errors[0] || 'Envoi impossible'; return null; }
  panel.sentCount = (panel.sentCount || 0) + 1;
  panel.lastSentAt = Date.now();
  panel.lastError = errors.length ? errors[0] : null;
  return sentMessages;
}

// v133 : l'édition rapporte maintenant son résultat. Avant, toute erreur était avalée ET la signature était déjà mise à jour :
// une édition refusée (limite Telegram « trop de requêtes », réseau, message encore en file du mode lent) n'était JAMAIS
// retentée et le message restait bloqué sur « ⏰ … » alors que les jeux suivants passaient (#N1139, #N1140 sur la capture).
//   → { ok: true }                  tous les messages sont à jour (ou ne peuvent plus l'être : supprimés)
//   → { ok: false, retryAfter: s }  à retenter au prochain passage (retryAfter : attente imposée par Telegram)
async function editExisting(messages, text) {
  const bot = typeof sender === 'function' ? sender() : null;
  if (!bot) return { ok: false, retryAfter: 5 };
  let ok = true; let retryAfter = 0;
  await Promise.all(messages.map(async (m) => {
    try {
      await bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/not modified/i.test(msg)) return; // déjà à jour
      if (/message to edit not found|message can't be edited|MESSAGE_ID_INVALID|chat not found/i.test(msg)) return; // message supprimé : rien à rattraper
      ok = false;
      const body = e && e.response && e.response.body;
      const ra = Number((body && body.parameters && body.parameters.retry_after) || ((msg.match(/retry after (\d+)/i) || [])[1]) || 0);
      if (ra > retryAfter) retryAfter = ra;
    }
  }));
  return { ok, retryAfter };
}

const sending = new Set(); // numéros dont le premier envoi est en cours (anti-doublon)
let editPausedUntil = 0;   // jusqu'à cet instant (ms) : aucune édition (limite Telegram)
async function processGame(g) {
  if (!hasStarted(g)) return; // « un jeu qui n'a pas encore commencé n'est pas envoyé »
  if (!isRealLiveGame(g)) return; // pas la table réellement suivie : on bloque
  const sig = signatureOf(g);
  const entry = panel.tracked[g.number];
  const text = buildLine(g);
  if (!entry) {
    if (sending.has(g.number)) return; // déjà en cours d'envoi : jamais deux fois
    // ORDRE STRICT : un jeu plus ancien que le dernier déjà publié n'est jamais envoyé après lui
    // (il apparaîtrait dans le désordre dans le canal).
    let top = maxTrackedNumber();
    // numérotation repartie de très bas sur le jeu EN DIRECT = nouveau sabot non détecté : on repart d'un suivi vide
    if (top != null && g.number < top && state.live && g.number === state.live.number && (top - g.number) > 30) { panel.tracked = {}; top = null; }
    if (top != null && g.number < top) { panel.skippedLate = (panel.skippedLate || 0) + 1; return; }
    sending.add(g.number);
    try {
      const sentMessages = await sendNew(g, text);
      if (sentMessages) {
        panel.tracked[g.number] = { messages: sentMessages, signature: sig, finished: !!g.finished };
        if (!g.finished) panel.tracked[g.number].text = text; // v135 : dernière ligne « ⏰ » envoyée (utile si le jeu disparaît du flux)
        persist(); // mémorisé tout de suite : un redémarrage ne renverra pas ce jeu
      }
    } finally { sending.delete(g.number); }
    return;
  }
  if (entry.signature === sig) return; // rien de visible n'a changé depuis la dernière fois
  if (Date.now() < editPausedUntil) return; // pause imposée par Telegram (limite de requêtes) : on retentera
  const r = await editExisting(entry.messages, text);
  if (r.ok) {
    entry.signature = sig; // la signature n'est retenue QU'APRÈS une édition réussie : sinon on retente au passage suivant
    entry.finished = !!g.finished;
    delete entry.fails;
    delete entry.missingSince; delete entry.dbCheckedAt;
    if (g.finished) delete entry.text; else entry.text = text;
    return;
  }
  entry.fails = (entry.fails || 0) + 1;
  if (r.retryAfter) editPausedUntil = Date.now() + Math.min(60, r.retryAfter) * 1000;
  if (entry.fails >= 12) { entry.signature = sig; entry.finished = !!g.finished; delete entry.fails; } // abandon après 12 essais (message inaccessible)
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
  const previous = panel.tracked;
  panel.tracked = {};
  persist();
  return finalizeEntries(previous); // v135 : les messages encore « ⏰ » de l'ancien sabot sont terminés avant l'oubli
});

// ---------------------------------------------------------------------------
// v135 : finalisation des messages restés bloqués sur « ⏰ »
// ---------------------------------------------------------------------------
// Un message « ⏰ » ne pouvait plus être terminé quand le jeu avait quitté le flux ET que sa version terminée n'était plus en
// mémoire : redémarrage du service (Render), nouveau sabot, remise à zéro de 00h00 (le suivi était effacé sans finaliser).
// Désormais : (1) le jeu terminé est relu dans la table `games` de la base (les 50 derniers jeux) ; (2) avant d'effacer le
// suivi (nouveau sabot, 00h00) les messages encore en cours sont finalisés ; (3) en dernier recours le message n'affiche plus ⏰
// mais « ⚠️ … résultat non reçu » (corrigé tout seul si le vrai résultat arrive ensuite).
const STUCK_AFTER_MS = 15000;      // jeu absent du flux depuis ce délai : on va chercher sa version terminée en base
const GIVE_UP_MS = 180000;         // toujours rien après ce délai : dernier recours (⚠️)
const DB_RECHECK_MS = 30000;       // délai entre deux recherches en base pour un même jeu
const finalizing = new Set();

async function gameFromDb(n) {
  if (!db.ready || typeof db.gameByNumber !== 'function') return null;
  try {
    const row = await db.gameByNumber(n);
    if (!row || !row.raw) return null;
    const g = typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw;
    return g && g.finished && Number(g.number) === Number(n) ? g : null;
  } catch (_) { return null; }
}

function lastResortText(entry) {
  const base = String(entry.text || '').replace(/^⏰\s*/, '');
  return base ? `⚠️ ${base} — résultat non reçu` : null;
}

// termine UN message suivi ; renvoie true si le message n'a plus rien à rattraper
async function finalizeOne(num, entry, { force = false } = {}) {
  if (!entry || entry.finished || finalizing.has(num)) return false;
  finalizing.add(num);
  try {
    let g = state.games.get(num);
    if (!(g && g.finished)) g = ((state.history) || []).find((h) => h && h.finished && h.number === num) || null;
    if (!g) g = await gameFromDb(num);
    if (g && g.finished) {
      const r = await editExisting(entry.messages, buildLine(g));
      if (!r.ok) { if (r.retryAfter) editPausedUntil = Date.now() + Math.min(60, r.retryAfter) * 1000; return false; }
      entry.signature = signatureOf(g); entry.finished = true;
      delete entry.fails; delete entry.missingSince; delete entry.dbCheckedAt; delete entry.text;
      return true;
    }
    const lastAge = Date.now() - (entry.missingSince || Date.now());
    if (!force && lastAge < GIVE_UP_MS) return false;
    const text = lastResortText(entry);
    if (!text) { entry.finished = true; return true; }
    const r = await editExisting(entry.messages, text);
    if (!r.ok) { if (r.retryAfter) editPausedUntil = Date.now() + Math.min(60, r.retryAfter) * 1000; return false; }
    // la signature reste celle d'avant : si le vrai résultat arrive plus tard, processGame() corrigera le message
    entry.finished = true; delete entry.fails; delete entry.missingSince; delete entry.dbCheckedAt; delete entry.text;
    return true;
  } finally { finalizing.delete(num); }
}

// passage régulier (tick) : jeux suivis encore « ⏰ » qui ne sont plus dans le flux
async function sweepStuck(live, hist) {
  const now = Date.now();
  for (const [n, entry] of Object.entries(panel.tracked)) {
    if (!entry || entry.finished) continue;
    const num = Number(n);
    if (live.has(num) || hist.has(num)) { delete entry.missingSince; delete entry.dbCheckedAt; continue; }
    if (!entry.missingSince) { entry.missingSince = now; continue; }
    if (now - entry.missingSince < STUCK_AFTER_MS) continue;
    if (now < editPausedUntil) continue;
    if (entry.dbCheckedAt && now - entry.dbCheckedAt < DB_RECHECK_MS) continue;
    entry.dbCheckedAt = now;
    await finalizeOne(num, entry);
  }
}

// avant d'effacer le suivi (nouveau sabot, 00h00) : tous les messages encore en cours sont finalisés (délai maximum 20 s)
async function finalizeEntries(tracked) {
  const todo = Object.entries(tracked || {}).filter(([, e]) => e && !e.finished);
  if (!todo.length) return 0;
  let done = 0;
  const work = (async () => {
    for (const [n, entry] of todo) { if (await finalizeOne(Number(n), entry, { force: true })) done++; }
  })();
  await Promise.race([work, new Promise((r) => setTimeout(r, 20000))]);
  return done;
}
const finalizeAll = () => finalizeEntries(panel.tracked);

// ---------------------------------------------------------------------------
// Boucle de traitement
// ---------------------------------------------------------------------------
async function tick() {
  if (busy || !panel.enabled) return panel;
  busy = true;
  try {
    const games = [...state.games.values()].sort((a, b) => a.number - b.number);
    // v133 : un jeu suivi mais resté sur « ⏰ » dont le tour a quitté le flux avant d'être édité une dernière fois est
    // terminé à partir de l'historique des tours finis (sinon il restait bloqué en cours pour toujours)
    const live = new Set(games.map((x) => x.number));
    const hist = new Map(((state.history) || []).filter((h) => h && h.finished).map((h) => [h.number, h]));
    for (const [n, entry] of Object.entries(panel.tracked)) {
      const num = Number(n);
      if (entry && !entry.finished && !live.has(num) && hist.has(num)) await processGame(hist.get(num));
    }
    for (const g of games) await processGame(g);
    await sweepStuck(live, hist); // v135 : messages restés sur « ⏰ » alors que le jeu a quitté le flux
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
    skippedLate: panel.skippedLate || 0,
  };
}

module.exports = {
  panel, setSender, tick, test, status: statusView, config, configure,
  restore, restoreFromDb, parseChannels, buildLine, drawingSide, finalizeAll, finalizeEntries,
};

// exposé pour l'effacement de minuit (midnight-reset.js)
module.exports.persist = persist;
