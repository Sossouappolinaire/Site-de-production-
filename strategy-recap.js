// strategy-recap.js — « Récapitulatif des prédictions » PAR CANAL.
//
// Quand un canal a le récapitulatif activé, il reçoit :
//   • toutes les N heures (2 h par défaut ; réglable par stratégie, ex. 5 h → 05h, 10h, 15h, 20h) — heure RECAP_TZ, par défaut celle
//     de la remise à zéro (Africa/Abidjan) — le récapitulatif de la journée ;
//   • à 00h00 : le BILAN DE LA JOURNÉE, puis les compteurs de ce canal repartent à zéro.
//
// Le comptage est fait CANAL PAR CANAL : sont comptées uniquement les prédictions réellement envoyées dans ce canal (message
// parti dans le canal), quelle que soit la source — stratégies, « Meilleur + plus faible », Relance, Dizaine, Costume faible,
// Prédit IA, etc. Si deux boutons ou configurations publient dans le même canal, un SEUL récapitulatif est envoyé et il additionne
// ce qui a été envoyé dans ce canal (jamais deux récapitulatifs, jamais de prédiction comptée pour un autre canal).
//
// Activation : case « Récapitulatif » d'une stratégie (active ses canaux publics) ou case du canal dans Envois → Organisation par canal.
// Les compteurs tournent toujours (case cochée ou non) : cocher en milieu de journée donne tout de suite le total depuis 00h.
// Aucun message n'est envoyé tant que le canal n'a aucune prédiction terminée dans la journée.
'use strict';

const store = require('./store');
const db = require('./db');

const TZ = process.env.RECAP_TZ || process.env.RESET_TZ || 'Africa/Abidjan';
const DEFAULT_HOURS = 2;      // un récapitulatif toutes les 2 heures par défaut (réglable par stratégie : « recapHours », ex. 5 h)
const CATCHUP_MINUTES = 20;   // rattrapage si le serveur dormait pile à l'heure du créneau

// counts[canal] = { day, win, loss, steps: { 0: n, 1: n … } }   (steps = rattrapage auquel la prédiction a été gagnée)
// sent[canal]   = { day, slot }                                   (dernier créneau déjà envoyé)
// finals        = bilans de journées terminées, en attente d'envoi : [{ chat, day, win, loss, steps }]
// enabled[canal]= true                                            (case cochée sur le canal)
const data = { counts: {}, sent: {}, finals: [], enabled: {}, savedAt: 0 };
let ctx = null;
let running = false;
let saveTimer = null;

function setContext(c) { ctx = c; }

function parts(ms = Date.now()) {
  const f = new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const o = {};
  for (const p of f) o[p.type] = p.value;
  return { key: `${o.year}-${o.month}-${o.day}`, h: parseInt(o.hour, 10) % 24, m: parseInt(o.minute, 10) };
}

// ── persistance (fichier + base, comme midnight-reset.js) ─────────────────────────────────────────────
function persistNow() {
  data.savedAt = Date.now();
  const v = { counts: data.counts, sent: data.sent, finals: data.finals, enabled: data.enabled, savedAt: data.savedAt };
  try { store.patch({ strategyRecap: v }); } catch (_) { /* ignoré */ }
  if (db.ready) db.setSetting('strategy_recap', JSON.stringify(v)).catch(() => {});
}
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 1500);
}
function load(s) {
  if (!s || typeof s !== 'object') return;
  data.counts = s.counts || {};
  data.sent = s.sent || {};
  data.finals = Array.isArray(s.finals) ? s.finals.filter((f) => f && f.chat) : [];
  data.enabled = s.enabled || {};
  data.savedAt = s.savedAt || 0;
  // enregistrements de la v67 (comptés par stratégie, pas par canal) : ignorés, les compteurs repartent proprement par canal
  const isChan = (k) => /^-?\d+$/.test(k) || /^@/.test(k);
  for (const k of Object.keys(data.counts)) if (!isChan(k) || !data.counts[k] || typeof data.counts[k].win !== 'number') delete data.counts[k];
  for (const k of Object.keys(data.sent)) if (!isChan(k)) delete data.sent[k];
}
function restore() {
  try { load((store.read() || {}).strategyRecap); } catch (_) { /* ignoré */ }
}
async function restoreFromDb() {
  if (!db.ready) return;
  try {
    const raw = await db.getSetting('strategy_recap');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && (s.savedAt || 0) > (data.savedAt || 0)) load(s);
  } catch (_) { /* ignoré */ }
}

// ── activation par canal ──────────────────────────────────────────────────────────────────────────────
const chanId = (v) => String(v == null ? '' : v).trim();
// canaux publics des stratégies dont la case « Récapitulatif » est cochée → intervalle en heures (le plus court si plusieurs stratégies)
function strategyChannelHours() {
  const map = new Map();
  if (!ctx || !ctx.state || !ctx.strategyChannels) return map;
  for (const [key, cfg] of Object.entries(ctx.state.strategies || {})) {
    if (!cfg || cfg.recap !== true) continue;
    const h = Math.max(1, Math.min(12, parseInt(cfg.recapHours, 10) || DEFAULT_HOURS));
    try { for (const id of ctx.strategyChannels(key)) { const k = chanId(id); if (k) map.set(k, Math.min(map.get(k) || 99, h)); } } catch (_) { /* ignoré */ }
  }
  return map;
}
const strategyEnabledChannels = () => new Set(strategyChannelHours().keys());
function isEnabled(id) { const k = chanId(id); return !!(k && (data.enabled[k] || strategyChannelHours().has(k))); }
// intervalle du récapitulatif d'un canal (heures) : celui de la stratégie qui l'active, sinon 2 h
function hoursFor(id) { return strategyChannelHours().get(chanId(id)) || DEFAULT_HOURS; }
function setChannelEnabled(id, on) {
  const k = chanId(id); if (!k) return false;
  if (on) data.enabled[k] = true; else delete data.enabled[k];
  persistNow();
  return true;
}

// ── comptage ───────────────────────────────────────────────────────────────────────────────────────────
// si le jour a changé : les compteurs du canal pour la journée finie partent en « bilan final » à envoyer, puis repartent à zéro
function rollIfNewDay(chat, today) {
  const c = data.counts[chat];
  if (c && c.day !== today) {
    if (c.win + c.loss > 0) data.finals.push({ chat, day: c.day, win: c.win, loss: c.loss, steps: c.steps || {} });
    delete data.counts[chat];
  }
}
function counterFor(chat, today) {
  rollIfNewDay(chat, today);
  if (!data.counts[chat]) data.counts[chat] = { day: today, win: 0, loss: 0, steps: {} };
  return data.counts[chat];
}
// une prédiction terminée, envoyée dans ces canaux
function noteResult({ channels, status, step }) {
  if (status !== 'gagné' && status !== 'perdu') return;
  const today = parts().key;
  for (const raw of new Set((channels || []).map(chanId).filter(Boolean))) {
    const c = counterFor(raw, today);
    if (status === 'gagné') {
      c.win += 1;
      const st = Math.max(0, parseInt(step, 10) || 0);
      c.steps[st] = (c.steps[st] || 0) + 1;
    } else c.loss += 1;
  }
  persist();
}
// point d'entrée commun à TOUS les boutons : la prédiction (entry) vient de passer à gagné / perdu.
// Les canaux sont ceux où son message est réellement parti (entry.messages[].chatId) : rien d'envoyé = rien de compté.
function noteEntry(entry) {
  try {
    if (!entry || entry._recapDone) return;
    if (entry.status !== 'gagné' && entry.status !== 'perdu') return;
    if (entry.silent === true) return;
    const chats = (Array.isArray(entry.messages) ? entry.messages : []).map((m) => m && (m.chatId != null ? m.chatId : m.chat_id)).filter((v) => v != null);
    if (!chats.length) return;
    entry._recapDone = true;
    noteResult({ channels: chats, status: entry.status, step: entry.step });
  } catch (_) { /* le récapitulatif ne doit jamais bloquer un bouton */ }
}

// ── texte du récapitulatif ───────────────────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
function recapText({ label, win, loss, steps, final }) {
  const total = win + loss;
  const rate = total ? Math.round((win / total) * 100) : 0;
  const lines = [final ? `🌙 BILAN DE LA JOURNÉE — ${label}` : `📊 RÉCAPITULATIF — ${label}`, 'Prédictions envoyées dans ce canal', '',
    `🟢 GAIN : ${win}`, `🔴 PERTE : ${loss}`, `🎯 Total : ${total} · Réussite : ${rate} %`];
  const detail = Object.keys(steps || {}).map(Number).sort((a, b) => a - b).filter((k) => steps[k] > 0)
    .map((k) => `${k === 0 ? 'direct' : `R${k}`} ${steps[k]}`);
  if (detail.length > 1 || (detail.length === 1 && detail[0].indexOf('direct') !== 0)) lines.push(`↪️ Gains : ${detail.join(' · ')}`);
  if (final) lines.push('', '🔄 Compteurs remis à zéro');
  return lines.join('\n');
}

async function deliver(chat, text) {
  if (!ctx) return;
  if (ctx.isPaused && ctx.isPaused()) return;
  const sender = ctx.senderFor();
  if (!sender) return;
  try { await sender.sendMessage(chat, text); }
  catch (e) { console.error('Récapitulatif non envoyé', chat, e.message); }
}

// appelé toutes les ~20 s (bot.js)
async function tick(now = Date.now()) {
  if (!ctx || running) return;
  running = true;
  try {
    const p = parts(now);
    // 1) bilans finaux des journées terminées (00h00) — jamais deux fois : retirés de la file AVANT l'envoi
    for (const chat of Object.keys(data.counts)) rollIfNewDay(chat, p.key);
    if (data.finals.length) {
      const todo = data.finals.splice(0);
      persistNow();
      for (const f of todo) {
        if (!isEnabled(f.chat)) continue;
        await deliver(f.chat, recapText({ label: '00h00', win: f.win, loss: f.loss, steps: f.steps, final: true }));
      }
    }
    // 2) récapitulatif toutes les N heures (2 h par défaut, 5 h pour « 2/3 → distribution 2/2 »)
    const minutes = p.h * 60 + p.m;
    const hoursMap = strategyChannelHours();
    for (const chat of Object.keys(data.counts)) {
      if (!data.enabled[chat] && !hoursMap.has(chat)) continue;
      const hours = hoursMap.get(chat) || DEFAULT_HOURS;
      const slotMin = hours * 60;
      const slot = Math.floor(minutes / slotMin);                        // 2 h : 02h, 04h … 22h · 5 h : 05h, 10h, 15h, 20h
      if (slot < 1 || minutes - slot * slotMin >= CATCHUP_MINUTES) continue;
      const done = data.sent[chat];
      if (done && done.day === p.key && done.hours === hours && done.slot >= slot) continue;
      const c = data.counts[chat];
      if (!c || c.day !== p.key || c.win + c.loss === 0) continue;       // rien à récapituler
      data.sent[chat] = { day: p.key, slot, hours };                      // marqué AVANT l'envoi : jamais deux fois le même créneau
      persistNow();
      await deliver(chat, recapText({ label: `${pad(slot * hours)}h00`, win: c.win, loss: c.loss, steps: c.steps }));
    }
  } catch (e) {
    console.error('Récapitulatif :', e.message);
  } finally {
    running = false;
  }
}

function status() {
  return { tz: TZ, enabled: { ...data.enabled }, viaStrategies: [...strategyEnabledChannels()], hours: Object.fromEntries(strategyChannelHours()), counts: data.counts, pendingFinals: data.finals.length };
}

module.exports = { setContext, restore, restoreFromDb, noteEntry, noteResult, isEnabled, setChannelEnabled, tick, recapText, status };
