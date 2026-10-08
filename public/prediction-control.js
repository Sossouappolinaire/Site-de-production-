// prediction-control.js — interrupteur « arrêter / démarrer / planifier
// les prédictions » : GLOBAL depuis le site ou en message privé à l'admin, et
// PAR CANAL quand la commande est tapée dans un canal (n'arrête que lui). Commandable directement depuis un canal Telegram par
// l'administrateur de ce canal (demande admin).
//
// Portée volontairement large : quand `paused` est vrai, bot.js saute
// ENTIÈREMENT la génération + l'envoi de nouvelles prédictions (stratégies
// existantes ET tous les panneaux : Prédit, après perte, combinaisons, série
// de costume, comptage 2/2, VIP, formation, jeu 21) — voir le garde-fou dans
// tick() (bot.js). Ça n'arrête PAS la lecture des jeux en direct ni la
// vérification des prédictions déjà envoyées avant la pause (elles restent
// suivies normalement par predictor.js) : seules les NOUVELLES prédictions
// sont retenues.
//
// Qui peut commander : n'importe quel message posté DIRECTEMENT dans un
// canal Telegram où le bot est présent (event Telegram « channel_post »).
// Telegram interdit déjà nativement à quiconque n'est pas administrateur
// d'un canal d'y publier un message — la simple présence d'un channel_post
// est donc déjà la preuve qu'il vient d'un administrateur de CE canal. En
// plus de ça, l'administrateur général du bot (état.adminId) garde la main
// en message privé, comme les autres commandes du bot.
'use strict';

const db = require('./db');
const store = require('./store');

const state = {
  paused: false,
  pausedAt: null,
  pauseReason: null,   // texte libre optionnel donné avec la commande
  pausedBy: null,       // « canal <id> » ou « admin (DM) »
  resumedAt: null,
  resumedBy: null,
  // planification quotidienne facultative : arrêt et reprise automatiques à
  // heure fixe (heure du serveur). null = pas de planification active.
  schedule: null,        // { stopAt: 'HH:MM', startAt: 'HH:MM' }
  // anti-double-déclenchement : dernière minute où l'automatique a agi, pour
  // ne pas re-déclencher pause()/resume() en boucle pendant la même minute.
  lastAutoKey: null,
  // ARRÊT PAR CANAL (demande admin) : /stop, /start, /planifier tapés DANS un
  // canal ne concernent QUE ce canal — les autres canaux continuent de
  // recevoir leurs prédictions. Clé = id du canal en texte ; chaque entrée :
  // { id, username, title, paused, pausedAt, reason, by, resumedAt,
  //   resumedBy, schedule, lastAutoKey }.
  channels: {},
};

function chatKey(chat) {
  const id = chat && typeof chat === 'object' ? chat.id : chat;
  return String(id == null ? '' : id).trim();
}
function chatUsername(chat) {
  const u = chat && typeof chat === 'object' ? chat.username : null;
  return u ? `@${String(u).replace(/^@/, '').toLowerCase()}` : null;
}
function channelEntry(chat, create) {
  const key = chatKey(chat);
  if (!key) return null;
  let e = state.channels[key];
  if (!e && create) {
    e = state.channels[key] = {
      id: key, username: null, title: null, paused: false, pausedAt: null, reason: null, by: null,
      resumedAt: null, resumedBy: null, schedule: null, lastAutoKey: null,
    };
  }
  if (e && chat && typeof chat === 'object') {
    const u = chatUsername(chat);
    if (u) e.username = u;
    if (chat.title) e.title = String(chat.title);
  }
  return e || null;
}
// vrai si CE canal (id numérique ou @nom) est arrêté individuellement.
function isChannelPaused(chatId) {
  const key = chatKey(chatId);
  if (!key) return false;
  const direct = state.channels[key];
  if (direct) return !!direct.paused;
  if (key.startsWith('@')) {
    const low = key.toLowerCase();
    for (const e of Object.values(state.channels)) if (e.paused && e.username === low) return true;
  }
  return false;
}

function isPaused() { return !!state.paused; }

function sanitizeTime(t) {
  const m = String(t == null ? '' : t).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function pause(reason, by) {
  state.paused = true;
  state.pausedAt = Date.now();
  state.pauseReason = reason ? String(reason).trim().slice(0, 200) || null : null;
  state.pausedBy = by || null;
  persist();
  return status();
}

function resume(by) {
  state.paused = false;
  state.resumedAt = Date.now();
  state.resumedBy = by || null;
  persist();
  return status();
}

// planifie un arrêt et une reprise quotidiens automatiques (heures locales du
// serveur). Passer stopAt=null (ou startAt=null) désactive la planification.
function setSchedule(stopAt, startAt) {
  const s = sanitizeTime(stopAt);
  const e = sanitizeTime(startAt);
  if (!s || !e) {
    const err = new Error("Heures invalides — format attendu HH:MM pour l'arrêt et la reprise (ex. 23:00 07:00).");
    throw err;
  }
  state.schedule = { stopAt: s, startAt: e };
  state.lastAutoKey = null;
  persist();
  return status();
}

function clearSchedule() {
  state.schedule = null;
  state.lastAutoKey = null;
  persist();
  return status();
}


function pauseChannel(chat, reason, by) {
  const e = channelEntry(chat, true);
  if (!e) throw new Error('Canal inconnu.');
  e.paused = true;
  e.pausedAt = Date.now();
  e.reason = reason ? String(reason).trim().slice(0, 200) || null : null;
  e.by = by || null;
  persist();
  return channelStatus(chat);
}
function resumeChannel(chat, by) {
  const e = channelEntry(chat, true);
  if (!e) throw new Error('Canal inconnu.');
  e.paused = false;
  e.resumedAt = Date.now();
  e.resumedBy = by || null;
  persist();
  return channelStatus(chat);
}
function setChannelSchedule(chat, stopAt, startAt) {
  const a = sanitizeTime(stopAt);
  const b = sanitizeTime(startAt);
  if (!a || !b) throw new Error("Heures invalides — format attendu HH:MM pour l'arrêt et la reprise (ex. 23:00 07:00).");
  const e = channelEntry(chat, true);
  e.schedule = { stopAt: a, startAt: b };
  e.lastAutoKey = null;
  persist();
  return channelStatus(chat);
}
function clearChannelSchedule(chat) {
  const e = channelEntry(chat, false);
  if (e) { e.schedule = null; e.lastAutoKey = null; persist(); }
  return channelStatus(chat);
}
function channelStatus(chat) {
  const e = channelEntry(chat, false);
  return {
    id: chatKey(chat),
    paused: !!(e && e.paused),
    pausedAt: e ? e.pausedAt : null,
    pauseReason: e ? e.reason : null,
    pausedBy: e ? e.by : null,
    resumedAt: e ? e.resumedAt : null,
    resumedBy: e ? e.resumedBy : null,
    schedule: e ? e.schedule : null,
  };
}
function channelStatusText(chat) {
  const s = channelStatus(chat);
  const lines = [];
  lines.push(s.paused ? '⏸️ Prédictions ARRÊTÉES pour CE canal (les autres canaux continuent).' : '▶️ Prédictions ACTIVES pour ce canal.');
  if (s.paused && s.pausedAt) {
    lines.push(`Depuis le ${new Date(s.pausedAt).toLocaleString('fr-FR')}${s.pauseReason ? ` — ${s.pauseReason}` : ''}.`);
  }
  lines.push(s.schedule
    ? `📅 Planification de ce canal : arrêt automatique à ${s.schedule.stopAt}, reprise automatique à ${s.schedule.startAt}.`
    : '📅 Aucune planification pour ce canal.');
  if (state.paused) lines.push('⚠️ L\'interrupteur GLOBAL est aussi actif : plus aucune nouvelle prédiction sur aucun canal.');
  return lines.join('\n');
}
function pausedChannels() {
  return Object.values(state.channels).filter((e) => e.paused).map((e) => ({
    id: e.id, username: e.username, title: e.title, pausedAt: e.pausedAt, reason: e.reason, by: e.by, schedule: e.schedule,
  }));
}

function status() {
  return {
    paused: state.paused,
    pausedAt: state.pausedAt,
    pauseReason: state.pauseReason,
    pausedBy: state.pausedBy,
    resumedAt: state.resumedAt,
    resumedBy: state.resumedBy,
    schedule: state.schedule,
    pausedChannels: pausedChannels(),
    channelSchedules: Object.values(state.channels).filter((e) => e.schedule).map((e) => ({ id: e.id, title: e.title, schedule: e.schedule })),
  };
}

// texte prêt à renvoyer dans le canal/chat qui a passé la commande.
function statusText() {
  const s = status();
  const lines = [];
  lines.push(s.paused ? '⏸️ Prédictions ARRÊTÉES.' : '▶️ Prédictions ACTIVES.');
  if (s.paused && s.pausedAt) {
    lines.push(`Depuis le ${new Date(s.pausedAt).toLocaleString('fr-FR')}${s.pausedBy ? ` (par ${s.pausedBy})` : ''}${s.pauseReason ? ` — ${s.pauseReason}` : ''}.`);
  } else if (!s.paused && s.resumedAt) {
    lines.push(`Reprises le ${new Date(s.resumedAt).toLocaleString('fr-FR')}${s.resumedBy ? ` (par ${s.resumedBy})` : ''}.`);
  }
  lines.push(s.schedule
    ? `📅 Planification quotidienne active : arrêt automatique à ${s.schedule.stopAt}, reprise automatique à ${s.schedule.startAt}.`
    : '📅 Aucune planification automatique.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tick planification — à appeler régulièrement (voir bot.js tick()) : bascule
// pause()/resume() automatiquement une fois l'heure atteinte, une seule fois
// par occurrence (lastAutoKey empêche de redéclencher en boucle pendant la
// même minute tant que le tick tourne plusieurs fois dedans).
// ---------------------------------------------------------------------------
function tickChannelSchedules() {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dayKey = now.toDateString();
  for (const e of Object.values(state.channels)) {
    const sch = e.schedule;
    if (!sch) continue;
    if (hhmm === sch.stopAt) {
      const key = `stop-${dayKey}-${hhmm}`;
      if (!e.paused && e.lastAutoKey !== key) { e.lastAutoKey = key; e.paused = true; e.pausedAt = Date.now(); e.reason = 'Arrêt automatique planifié'; e.by = 'planification'; persist(); }
    } else if (hhmm === sch.startAt) {
      const key = `start-${dayKey}-${hhmm}`;
      if (e.paused && e.lastAutoKey !== key) { e.lastAutoKey = key; e.paused = false; e.resumedAt = Date.now(); e.resumedBy = 'planification'; persist(); }
    }
  }
}

function tickSchedule() {
  tickChannelSchedules();
  const sch = state.schedule;
  if (!sch) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dayKey = now.toDateString();
  if (hhmm === sch.stopAt) {
    const key = `stop-${dayKey}-${hhmm}`;
    if (!state.paused && state.lastAutoKey !== key) {
      state.lastAutoKey = key;
      pause('Arrêt automatique planifié', 'planification');
    }
  } else if (hhmm === sch.startAt) {
    const key = `start-${dayKey}-${hhmm}`;
    if (state.paused && state.lastAutoKey !== key) {
      state.lastAutoKey = key;
      resume('planification');
    }
  }
}

// ---------------------------------------------------------------------------
// Persistance (mémoire + base), même schéma que les autres panneaux.
// ---------------------------------------------------------------------------
function persist() {
  try { store.patch({ predictionControl: state }); } catch (_) {}
  if (db.ready) db.savePredictionControlState(state).catch(() => {});
}

function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  state.paused = !!saved.paused;
  state.pausedAt = saved.pausedAt || null;
  state.pauseReason = saved.pauseReason || null;
  state.pausedBy = saved.pausedBy || null;
  state.resumedAt = saved.resumedAt || null;
  state.resumedBy = saved.resumedBy || null;
  state.schedule = (saved.schedule && sanitizeTime(saved.schedule.stopAt) && sanitizeTime(saved.schedule.startAt))
    ? { stopAt: sanitizeTime(saved.schedule.stopAt), startAt: sanitizeTime(saved.schedule.startAt) }
    : null;
  state.channels = {};
  if (saved.channels && typeof saved.channels === 'object') {
    for (const [k, e] of Object.entries(saved.channels)) {
      if (!e || typeof e !== 'object') continue;
      state.channels[String(k)] = {
        id: String(k), username: e.username || null, title: e.title || null, paused: !!e.paused,
        pausedAt: e.pausedAt || null, reason: e.reason || null, by: e.by || null,
        resumedAt: e.resumedAt || null, resumedBy: e.resumedBy || null,
        schedule: (e.schedule && sanitizeTime(e.schedule.stopAt) && sanitizeTime(e.schedule.startAt))
          ? { stopAt: sanitizeTime(e.schedule.stopAt), startAt: sanitizeTime(e.schedule.startAt) } : null,
        lastAutoKey: null,
      };
    }
  }
  state.lastAutoKey = null; // on réévalue proprement au prochain tick après un redémarrage
}

function restore() {
  try {
    const saved = (store.read() || {}).predictionControl;
    if (saved) applySaved(saved);
  } catch (_) {}
  return status();
}

async function restoreFromDb() {
  if (!db.ready) return status();
  const saved = await db.loadPredictionControlState();
  if (saved) applySaved(saved);
  return status();
}

module.exports = {
  isChannelPaused, pauseChannel, resumeChannel, setChannelSchedule, clearChannelSchedule,
  channelStatus, channelStatusText, pausedChannels,
  isPaused, pause, resume, setSchedule, clearSchedule, status, statusText,
  tickSchedule, restore, restoreFromDb,
};
