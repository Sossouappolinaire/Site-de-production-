// prediction-control.js — interrupteur GLOBAL « arrêter / démarrer / planifier
// les prédictions », commandable directement depuis un canal Telegram par
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
};

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

function status() {
  return {
    paused: state.paused,
    pausedAt: state.pausedAt,
    pauseReason: state.pauseReason,
    pausedBy: state.pausedBy,
    resumedAt: state.resumedAt,
    resumedBy: state.resumedBy,
    schedule: state.schedule,
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
function tickSchedule() {
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
  isPaused, pause, resume, setSchedule, clearSchedule, status, statusText,
  tickSchedule, restore, restoreFromDb,
};
