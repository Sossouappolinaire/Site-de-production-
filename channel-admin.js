// channel-admin.js — commande /envois (chat privé de l'administrateur) : « Envois » dans Telegram.
//
//   /envois            → liste des canaux (avec leur NOM) ; on touche un canal pour voir tout ce qui y est lié
//   /envois <nom|id>   → ouvre directement le canal dont le nom (ou l'identifiant) correspond
//
// Pour un canal : la liste numérotée de tout ce qui y publie — stratégies, configurations de chaque bouton, panneaux — avec leur état
// (🟢 active · ⏸ en pause). On coche UNE OU PLUSIEURS lignes (☑), puis :
//   ▶️ Activer · ⏸ Pause · 🗑 Supprimer · ✏️ Renommer (une seule) · 🔀 Changer de canal
// Supprimer : une configuration créée par l'admin est supprimée ; une stratégie ou un panneau intégré ne se supprime pas, on lui RETIRE
// ce canal (l'écran de confirmation le dit ligne par ligne). Toute suppression passe par une confirmation.
//
// Les données et les modifications sont exactement celles de la page « Envois → Organisation par canal » du site : server.js fournit
// ici les mêmes fonctions (setProvider). Réservé à l'administrateur.
'use strict';

const PAGE_CHANNELS = 8;
const PAGE_ITEMS = 10;
const SESSION_MS = 60 * 60 * 1000;

let provider = null;
// fournit : channels() → [{ id, title, sources }], configs(id) → [...], update(body) → {status, body}, remove(query) → {status, body},
//           resolve(raw) → { ok, chat: { id, title }, error }
function setProvider(p) { provider = p && typeof p === 'object' ? p : null; }

const sessions = new Map(); // chatId → session
function getSession(chatId) {
  const s = sessions.get(String(chatId));
  if (s && Date.now() - s.at > SESSION_MS) { sessions.delete(String(chatId)); return null; }
  return s || null;
}
function newSession(chatId) {
  const s = { chatId: String(chatId), at: Date.now(), channels: [], chPage: 0, channel: null, items: [], sel: new Set(), itPage: 0, awaiting: null, confirm: false };
  sessions.set(String(chatId), s);
  return s;
}
const touch = (s) => { s.at = Date.now(); };

const itemKey = (c) => [c.kind, c.panel || '', c.id, c.mode || ''].join('|');
const stateIcon = (c) => (c.enabled === true ? '🟢' : c.enabled === false ? '⏸' : '•');
const clip = (t, n) => { const x = String(t == null ? '' : t); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const chanLabel = (c) => (c.title ? `${c.title}` : String(c.id));
const renamable = (c) => !c.fixedName && !c.readOnly && ['tracker', 'best-weak', 'loss-return', 'loss-relaunch', 'bet-type', 'copy-announce'].includes(c.kind);

function ready() { return !!provider; }

// ---------------------------------------------------------------------------
// Écrans
// ---------------------------------------------------------------------------
function channelsScreen(s, note) {
  const total = s.channels.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_CHANNELS));
  s.chPage = Math.max(0, Math.min(pages - 1, s.chPage));
  const slice = s.channels.slice(s.chPage * PAGE_CHANNELS, (s.chPage + 1) * PAGE_CHANNELS);
  const rows = slice.map((c, i) => [{ text: clip(`📡 ${chanLabel(c)}${c.count != null ? ` · ${c.count}` : ''}`, 60), callback_data: `cad:c:${s.chPage * PAGE_CHANNELS + i}` }]);
  const nav = [];
  if (s.chPage > 0) nav.push({ text: '◀', callback_data: `cad:p:${s.chPage - 1}` });
  if (pages > 1) nav.push({ text: `${s.chPage + 1}/${pages}`, callback_data: 'cad:noop' });
  if (s.chPage < pages - 1) nav.push({ text: '▶', callback_data: `cad:p:${s.chPage + 1}` });
  if (nav.length) rows.push(nav);
  const text = (note ? `${note}\n\n` : '') + (total
    ? `📡 Canaux (${total}) — touche un canal pour voir les stratégies et configurations qui y sont liées.`
    : "Aucun canal configuré pour le moment.");
  return { text, reply_markup: { inline_keyboard: rows } };
}

function itemsPage(s) {
  const pages = Math.max(1, Math.ceil(s.items.length / PAGE_ITEMS));
  s.itPage = Math.max(0, Math.min(pages - 1, s.itPage));
  return { pages, from: s.itPage * PAGE_ITEMS, list: s.items.slice(s.itPage * PAGE_ITEMS, (s.itPage + 1) * PAGE_ITEMS) };
}

function channelScreen(s, note) {
  const ch = s.channel || {};
  const { pages, from, list } = itemsPage(s);
  const lines = list.map((c, i) => `${s.sel.has(itemKey(c)) ? '☑' : '☐'} ${from + i + 1}. ${stateIcon(c)} ${clip(`${c.group} · ${c.name}`, 90)}${c.readOnly ? ' 🔒' : ''}`);
  const head = `📡 ${chanLabel(ch)}\n🆔 ${ch.id}\n`;
  const body = s.items.length
    ? `Liés à ce canal : ${s.items.length}${pages > 1 ? ` (page ${s.itPage + 1}/${pages})` : ''}\n\n${lines.join('\n')}\n\nCoche une ou plusieurs lignes, puis choisis une action. 🟢 active · ⏸ en pause · 🔒 non modifiable ici.`
    : '\nRien n’est lié à ce canal pour le moment.';
  const rows = list.map((c, i) => [{ text: clip(`${s.sel.has(itemKey(c)) ? '☑' : '☐'} ${from + i + 1}. ${c.group} · ${c.name}`, 60), callback_data: `cad:t:${from + i}` }]);
  if (pages > 1) {
    const nav = [];
    if (s.itPage > 0) nav.push({ text: '◀', callback_data: `cad:ip:${s.itPage - 1}` });
    nav.push({ text: `${s.itPage + 1}/${pages}`, callback_data: 'cad:noop' });
    if (s.itPage < pages - 1) nav.push({ text: '▶', callback_data: `cad:ip:${s.itPage + 1}` });
    rows.push(nav);
  }
  if (s.items.length) {
    rows.push([{ text: '☑ Tout', callback_data: 'cad:all' }, { text: '☐ Aucun', callback_data: 'cad:none' }]);
    const n = s.sel.size;
    rows.push([{ text: `▶️ Activer${n ? ` (${n})` : ''}`, callback_data: 'cad:en' }, { text: `⏸ Pause${n ? ` (${n})` : ''}`, callback_data: 'cad:dis' }]);
    rows.push([{ text: `🗑 Supprimer${n ? ` (${n})` : ''}`, callback_data: 'cad:del' }]);
    rows.push([{ text: '✏️ Renommer', callback_data: 'cad:ren' }, { text: '🔀 Changer de canal', callback_data: 'cad:mv' }]);
  }
  rows.push([{ text: '🔄 Actualiser', callback_data: 'cad:ref' }, { text: '◀ Canaux', callback_data: 'cad:back' }]);
  return { text: `${note ? `${note}\n\n` : ''}${head}${body}`, reply_markup: { inline_keyboard: rows } };
}

function selectedItems(s) { return s.items.filter((c) => s.sel.has(itemKey(c))); }

function confirmScreen(s) {
  const sel = selectedItems(s);
  const lines = sel.map((c, i) => `${i + 1}. ${clip(`${c.group} · ${c.name}`, 90)} → ${c.readOnly ? 'non modifiable ici (ignoré)' : (c.canDelete ? '🗑 supprimée' : '➖ ce canal lui est retiré (la configuration reste)')}`);
  return {
    text: `⚠️ Confirmer sur « ${chanLabel(s.channel)} » ?\n\n${lines.join('\n')}`,
    reply_markup: { inline_keyboard: [[{ text: '✅ Oui, confirmer', callback_data: 'cad:delok' }, { text: '↩ Annuler', callback_data: 'cad:cancel' }]] },
  };
}

// ---------------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------------
function loadChannels(s) {
  const rows = provider.channels() || [];
  s.channels = rows.map((r) => {
    let count = null; try { count = (provider.configs(String(r.id)) || []).length; } catch (_) {}
    return { id: String(r.id), title: r.title || '', count };
  }).sort((a, b) => String(chanLabel(a)).localeCompare(String(chanLabel(b)), 'fr'));
}
function loadItems(s) {
  s.items = (provider.configs(String(s.channel.id)) || []);
  const keys = new Set(s.items.map(itemKey));
  for (const k of [...s.sel]) if (!keys.has(k)) s.sel.delete(k);
}
const norm = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

async function send(bot, chatId, screen) { return bot.sendMessage(chatId, screen.text, { reply_markup: screen.reply_markup, disable_web_page_preview: true }); }
async function show(bot, q, screen) {
  try {
    await bot.editMessageText(screen.text, { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: screen.reply_markup, disable_web_page_preview: true });
  } catch (e) {
    if (!/not modified/i.test(String(e && e.message))) { try { await send(bot, q.message.chat.id, screen); } catch (_) {} }
  }
}

// ---------------------------------------------------------------------------
// Commande /envois [nom|id]
// ---------------------------------------------------------------------------
async function open(bot, chatId, arg) {
  if (!ready()) return bot.sendMessage(chatId, '⏳ Le site démarre encore, réessaie dans quelques secondes.');
  const s = newSession(chatId);
  loadChannels(s);
  const q = norm(arg);
  if (q) {
    const hits = s.channels.filter((c) => norm(c.title).includes(q) || norm(c.id) === q || norm(c.id).includes(q));
    if (!hits.length) { return send(bot, chatId, channelsScreen(s, `🔎 Aucun canal ne correspond à « ${arg} ».`)); }
    if (hits.length === 1) { s.channel = hits[0]; loadItems(s); return send(bot, chatId, channelScreen(s)); }
    s.channels = hits;
    return send(bot, chatId, channelsScreen(s, `🔎 ${hits.length} canaux correspondent à « ${arg} » :`));
  }
  return send(bot, chatId, channelsScreen(s));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function bodyOf(c, extra) { return { kind: c.kind, panel: c.panel, id: c.id, mode: c.mode, ...extra }; }
const errOf = (r) => (r && r.body && r.body.error) || `erreur ${r && r.status}`;
const okRes = (r) => r && r.status < 400;

async function applyEnabled(s, on) {
  const sel = selectedItems(s);
  const lines = []; let done = 0;
  for (const c of sel) {
    if (c.enabled === null || c.enabled === undefined) { lines.push(`• ${clip(c.name, 50)} : pas d'état à changer`); continue; }
    if (c.readOnly) { lines.push(`• ${clip(c.name, 50)} : non modifiable ici`); continue; }
    const r = await provider.update(bodyOf(c, { enabled: on }));
    if (okRes(r)) done += 1; else lines.push(`❌ ${clip(c.name, 50)} : ${errOf(r)}`);
  }
  return `${on ? '▶️ Activées' : '⏸ Mises en pause'} : ${done}/${sel.length}${lines.length ? `\n${lines.join('\n')}` : ''}`;
}

async function applyDelete(s) {
  const sel = selectedItems(s);
  const chId = String(s.channel.id);
  const lines = []; let done = 0;
  for (const c of sel) {
    if (c.readOnly) { lines.push(`• ${clip(c.name, 50)} : non modifiable ici`); continue; }
    let r;
    if (c.canDelete) r = await provider.remove({ kind: c.kind, panel: c.panel, id: c.id });
    else {
      const keep = (c.channels || []).filter((x) => String(x).trim().toLowerCase() !== chId.trim().toLowerCase());
      r = await provider.update(bodyOf(c, { channels: keep }));
    }
    if (okRes(r)) done += 1; else lines.push(`❌ ${clip(c.name, 50)} : ${errOf(r)}`);
  }
  s.sel.clear();
  return `🗑 Terminé : ${done}/${sel.length}${lines.length ? `\n${lines.join('\n')}` : ''}`;
}

async function applyMove(s, rawNew) {
  const res = await provider.resolve(rawNew);
  if (!res || !res.ok) return { note: `❌ Canal introuvable ou inaccessible au bot : ${(res && res.error) || rawNew}` };
  const newId = String(res.chat.id);
  const chId = String(s.channel.id).trim().toLowerCase();
  if (newId.trim().toLowerCase() === chId) return { note: '❌ C’est déjà ce canal.' };
  const sel = selectedItems(s);
  const lines = []; let done = 0;
  for (const c of sel) {
    if (c.readOnly) { lines.push(`• ${clip(c.name, 50)} : non modifiable ici`); continue; }
    const cur = (c.channels || []).map(String);
    const next = [...new Set(cur.map((x) => (x.trim().toLowerCase() === chId ? newId : x)))];
    const r = await provider.update(bodyOf(c, { channels: next }));
    if (okRes(r)) done += 1; else lines.push(`❌ ${clip(c.name, 50)} : ${errOf(r)}`);
  }
  s.sel.clear();
  return { note: `🔀 Déplacées vers « ${res.chat.title || newId} » : ${done}/${sel.length}${lines.length ? `\n${lines.join('\n')}` : ''}`, moved: done > 0 };
}

// ---------------------------------------------------------------------------
// Boutons (callback_query « cad:… ») — renvoie false si ce n'est pas pour nous
// ---------------------------------------------------------------------------
async function handleCallback(bot, q) {
  const data = String((q && q.data) || '');
  if (!data.startsWith('cad:')) return false;
  const answer = (text) => bot.answerCallbackQuery(q.id, text ? { text: String(text).slice(0, 190) } : {}).catch(() => {});
  try {
    if (!ready() || !q.message) { await answer('Indisponible pour le moment'); return true; }
    const chatId = q.message.chat.id;
    let s = getSession(chatId);
    if (!s) { await answer('Session expirée — tape /envois'); return true; }
    touch(s);
    const [, act, arg] = data.split(':');
    const sel = () => selectedItems(s);

    if (act === 'noop') { await answer(); return true; }
    if (act === 'p') { s.chPage = Number(arg) || 0; await answer(); await show(bot, q, channelsScreen(s)); return true; }
    if (act === 'c') {
      const ch = s.channels[Number(arg)];
      if (!ch) { await answer('Canal introuvable'); return true; }
      s.channel = ch; s.sel.clear(); s.itPage = 0; s.awaiting = null; s.confirm = false; loadItems(s);
      await answer(); await show(bot, q, channelScreen(s)); return true;
    }
    if (act === 'back') { s.awaiting = null; s.confirm = false; s.channel = null; loadChannels(s); await answer(); await show(bot, q, channelsScreen(s)); return true; }
    if (!s.channel) { await answer('Choisis d’abord un canal'); return true; }
    if (act === 'ip') { s.itPage = Number(arg) || 0; await answer(); await show(bot, q, channelScreen(s)); return true; }
    if (act === 't') {
      const c = s.items[Number(arg)];
      if (!c) { await answer('Ligne introuvable — actualise'); return true; }
      const k = itemKey(c); if (s.sel.has(k)) s.sel.delete(k); else s.sel.add(k);
      s.awaiting = null; await answer(); await show(bot, q, channelScreen(s)); return true;
    }
    if (act === 'all') { for (const c of s.items) s.sel.add(itemKey(c)); await answer(); await show(bot, q, channelScreen(s)); return true; }
    if (act === 'none') { s.sel.clear(); s.awaiting = null; await answer(); await show(bot, q, channelScreen(s)); return true; }
    if (act === 'ref' || act === 'cancel') { s.awaiting = null; s.confirm = false; loadItems(s); await answer(act === 'cancel' ? 'Annulé' : 'Actualisé'); await show(bot, q, channelScreen(s)); return true; }
    if (act === 'en' || act === 'dis') {
      if (!sel().length) { await answer('Coche d’abord une ou plusieurs lignes'); return true; }
      await answer('En cours…');
      const note = await applyEnabled(s, act === 'en');
      loadItems(s); await show(bot, q, channelScreen(s, note)); return true;
    }
    if (act === 'del') {
      if (!sel().length) { await answer('Coche d’abord une ou plusieurs lignes'); return true; }
      s.confirm = true; await answer(); await show(bot, q, confirmScreen(s)); return true;
    }
    if (act === 'delok') {
      if (!s.confirm) { await answer('Rien à confirmer'); return true; }
      s.confirm = false; await answer('En cours…');
      const note = await applyDelete(s);
      loadItems(s); await show(bot, q, channelScreen(s, note)); return true;
    }
    if (act === 'ren') {
      const list = sel();
      if (list.length !== 1) { await answer('Coche UNE seule ligne à renommer'); return true; }
      if (!renamable(list[0])) { await answer('Cette ligne n’a pas de nom modifiable'); return true; }
      s.awaiting = { type: 'rename', key: itemKey(list[0]) };
      await answer();
      await bot.sendMessage(chatId, `✏️ Envoie le nouveau nom pour :\n« ${list[0].name} »\n\n(envoie « annuler » pour laisser tel quel)`);
      return true;
    }
    if (act === 'mv') {
      if (!sel().length) { await answer('Coche d’abord une ou plusieurs lignes'); return true; }
      s.awaiting = { type: 'move' };
      await answer();
      await bot.sendMessage(chatId, `🔀 Envoie l’ID (ex. -1001234567890) ou le @nom du NOUVEAU canal.\nLes ${sel().length} ligne(s) cochée(s) y seront déplacées (elles quittent « ${chanLabel(s.channel)} »).\n\n(envoie « annuler » pour abandonner)`);
      return true;
    }
    await answer();
    return true;
  } catch (e) {
    try { await answer(`Erreur : ${e.message}`); } catch (_) {}
    return true;
  }
}

// ---------------------------------------------------------------------------
// Réponse texte attendue (nouveau nom / nouveau canal). Renvoie true si le message a été utilisé.
// ---------------------------------------------------------------------------
async function handleText(bot, msg) {
  try {
    if (!msg || typeof msg.text !== 'string' || msg.text.startsWith('/')) return false;
    const s = getSession(msg.chat.id);
    if (!s || !s.awaiting || !s.channel || !ready()) return false;
    touch(s);
    const text = msg.text.trim();
    const aw = s.awaiting;
    s.awaiting = null;
    if (/^annuler$/i.test(text)) { loadItems(s); await send(bot, msg.chat.id, channelScreen(s, '↩ Annulé.')); return true; }
    if (aw.type === 'rename') {
      const c = s.items.find((x) => itemKey(x) === aw.key);
      if (!c) { await send(bot, msg.chat.id, channelScreen(s, '❌ Ligne introuvable (actualisée).')); return true; }
      const name = text.slice(0, 80);
      const r = await provider.update(bodyOf(c, { name }));
      loadItems(s);
      await send(bot, msg.chat.id, channelScreen(s, okRes(r) ? `✏️ Renommée : « ${name} »` : `❌ ${errOf(r)}`));
      return true;
    }
    if (aw.type === 'move') {
      const out = await applyMove(s, text);
      if (out.note.startsWith('❌')) s.awaiting = aw; // on laisse réessayer
      loadItems(s);
      await send(bot, msg.chat.id, channelScreen(s, out.note));
      return true;
    }
    return false;
  } catch (e) { try { await bot.sendMessage(msg.chat.id, `❌ ${e.message}`); } catch (_) {} return true; }
}

module.exports = { setProvider, open, handleCallback, handleText, channelsScreen, channelScreen, confirmScreen, getSession };
