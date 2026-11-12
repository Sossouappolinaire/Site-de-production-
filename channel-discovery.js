// channel-discovery.js — liste des canaux connus (v141).
//
//  Ce module était auparavant dans like-react.js (bouton « J'aime », supprimé en v141). Il ne garde que la DÉTECTION des canaux,
//  utilisée par la liste unique de canaux (server.js → configuredChannelList) proposée par tous les boutons :
//  • collectFrom : lit les réglages d'un bouton et reprend toute liste « …channels » / « channelId » ;
//  • discoverChannels : canaux configurés dans n'importe quel bouton + canaux où le site a réellement publié des prédictions.
'use strict';

function lazy(name) { try { return require(name); } catch (_) { return null; } }

// ---------------------------------------------------------------------------
// Lecture directe des réglages de TOUS les boutons : toute liste dont le nom
// finit par « channels » (channels, destChannels, bestChannels, publishedChannels…)
// est reprise, dans le panneau comme dans chaque configuration créée. Les canaux
// internes du site (siteChannelId…) ne sont pas des canaux Telegram : ignorés.
const SKIP_KEYS = new Set(['messages', 'pendingMessages', 'history', 'predictions', 'seen', 'states', 'verified',
  'sourcePredictions', 'lastPreds', 'channelTitles', 'refs', 'trigRefs', 'lastWins', 'sources', 'progress']);

function validId(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (typeof v === 'string') return /^-?\d+$/.test(v.trim()) || /^@[A-Za-z0-9_]{4,}$/.test(v.trim());
  return false;
}

function ignoredSet() {
  try { const st = lazy('./store'); return new Set(((st && st.read() || {}).ignoredChannels || []).map((x) => String(x).trim().toLowerCase())); }
  catch (_) { return new Set(); }
}

function collectFrom(node, label, add, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 7) return;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 300)) collectFrom(item, label, add, depth + 1);
    return;
  }
  const here = node.name && typeof node.name === 'string' ? `${label} · ${node.name}` : label;
  for (const [k, v] of Object.entries(node)) {
    if (SKIP_KEYS.has(k) || /site/i.test(k)) continue;
    if (/channels$/i.test(k)) {
      if (Array.isArray(v)) v.forEach((id) => { if (validId(id)) add(id, here); });
      else if (v && typeof v === 'object') {
        for (const list of Object.values(v)) if (Array.isArray(list)) list.forEach((id) => { if (validId(id)) add(id, here); });
      }
      continue;
    }
    if ((k === 'channelId' || k === 'channel') && typeof v !== 'object' && validId(v)) { add(v, here); continue; } // « channel » : emplacements (slots) de Costume faible
    if (v && typeof v === 'object') collectFrom(v, here, add, depth + 1);
  }
}

// Canaux configurés dans n'importe quel bouton + canaux où le site a réellement
// publié des prédictions (même s'ils ne sont plus saisis dans un réglage).
function discoverChannels() {
  const found = new Map();
  const add = (id, source, hist) => {
    if (id === null || id === undefined || id === '') return;
    const key = String(id).trim();
    if (!found.has(key)) found.set(key, { id: key, title: '', sources: [], configured: false });
    const row = found.get(key);
    if (!hist) row.configured = true; // saisi dans un réglage (≠ simple trace dans l'historique des envois)
    if (source && !row.sources.includes(source)) row.sources.push(source);
  };
  const titles = {};
  const addTitle = (id, t) => { const k = String(id == null ? '' : id).trim(); if (k && t && String(t) !== k && !titles[k]) titles[k] = String(t); };
  const fromMessages = (list, label) => {
    for (const e of (list || [])) for (const m of (e.messages || [])) add(m.chatId, label, true);
  };
  const predictor = lazy('./predictor');
  const strategies = lazy('./strategies');
  try {
    const st = predictor && predictor.state;
    fromMessages(st && st.predictions, 'Stratégies');
    (Array.isArray(st && st.activeChannels) ? st.activeChannels : []).forEach((id) => { if (validId(id)) add(id, 'Canaux actifs'); });
    // canaux où le bot (l'API) a été ajouté : ils ont un nom
    for (const c of (Array.isArray(st && st.channels) ? st.channels : [])) {
      if (c && validId(c.id)) { add(c.id, 'Bot ajouté dans ce canal', true); addTitle(c.id, c.title); }
    }
    // toutes les stratégies : canaux publiés, silencieux et anciens canaux
    for (const [key, cfg] of Object.entries((st && st.strategies) || {})) {
      const def = strategies && Array.isArray(strategies.LIST) ? strategies.LIST.find((x) => x.key === key) : null;
      const name = def ? def.name : key;
      for (const id of (Array.isArray(cfg.publishedChannels) ? cfg.publishedChannels : [])) if (validId(id)) add(id, `Stratégie · ${name} · publié`);
      for (const id of (Array.isArray(cfg.shadowChannels) ? cfg.shadowChannels : [])) if (validId(id)) add(id, `Stratégie · ${name} · silencieux`);
      for (const id of (Array.isArray(cfg.channels) ? cfg.channels : [])) if (validId(id)) add(id, `Stratégie · ${name}`);
      for (const info of [...(cfg.publishedChannelInfos || []), ...(cfg.shadowChannelInfos || [])]) if (info && validId(info.id)) addTitle(info.id, info.title || info.name);
    }
  } catch (_) {}
  const predit = lazy('./predit');
  try { fromMessages(predit && predit.panel && predit.panel.predictions, 'Prédit IA'); } catch (_) {}
  const mods = [
    ['./after-loss', 'Prédiction après perte'], ['./combined', 'Prédiction combinée'],
    ['./suit-streak', 'Répétition costume'], ['./suit-break', 'Rupture costume'],
    ['./overlap', 'Chevauchement'], ['./vip', 'VIP'], ['./predit', 'Prédit IA'],
    ['./dizaine-top', 'Dizaine'], ['./costume-faible-top', 'Costume faible'], ['./best-weak-top', 'Meilleur + plus faible'],
    ['./bet-type', 'Type de mise'], ['./copy-announce', 'Copie et annonce'],
    ['./statistics', 'Statistiques'], ['./cards-count', 'Comptage 2/2'], ['./game21-predict', 'Jeu 21'],
    ['./formation-relay', 'Formation'], ['./mirror-counter', 'Compteur miroir'],
    ['./loss-return', 'Retour après perte'], ['./loss-relaunch', 'Relance après perte'], ['./confirmation', 'Confirmation']
  ];
  for (const [file, label] of mods) {
    const mod = lazy(file);
    if (!mod) continue;
    try { collectFrom(mod.panel || mod.state, label, add); } catch (_) {}
    try { for (const [id, t] of Object.entries((mod.panel && mod.panel.channelTitles) || {})) addTitle(id, t); } catch (_) {}
    try { fromMessages(mod.panel && mod.panel.pendingMessages, label); } catch (_) {}
  }
  // Compteur miroir : un seul canal, hors panneau
  try { const mc = lazy('./mirror-counter'); const cid = mc && mc.getChannel && mc.getChannel(); if (validId(cid)) add(cid, 'Compteur miroir'); } catch (_) {}
  for (const row of found.values()) row.title = titles[row.id] || row.title || '';
  // Canaux supprimés par l'admin : ils ne reviennent pas tant qu'ils ne sont que des traces de l'historique ;
  // dès qu'un réglage les contient de nouveau, ils réapparaissent.
  const ignored = ignoredSet();
  return [...found.values()].filter((r) => r.configured || !ignored.has(String(r.id).trim().toLowerCase()));
}

module.exports = { discoverChannels, collectFrom, validId, ignoredSet };
