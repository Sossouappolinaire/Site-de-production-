// data-transfer.js — export/import de TOUTE la configuration du bot (tokens
// API, ID de canaux, TOUS les panneaux, réglages de format, configuration de chaque stratégie,
// stratégies créées par l'IA, historique des analyses IA…) sous forme d'un
// classeur Excel (.xlsx), envoyé/reçu directement par le bot Telegram
// (commandes /exporter et /importer, voir bot.js — réservées à
// l'administrateur).
//
// ⚠️ Le fichier généré contient les TOKENS API en clair (c'est justement
// l'intérêt d'un export de configuration complet, permettant de tout
// restaurer ailleurs) — il ne doit donc jamais être envoyé ailleurs qu'au
// chat privé de l'administrateur, ni accepté en import venant d'un autre
// compte. Ces deux vérifications sont faites côté bot.js, pas ici.
'use strict';

const XLSX = require('xlsx');
const { state, initStrategies, setStrategyConfig } = require('./predictor');
const strategies = require('./strategies');

const store = require('./store');

const SHEETS = {
  PANNEAUX: 'Panneaux',
  GENERAL: 'Général',
  CANAUX: 'Canaux',
  STRATEGIES: 'Strategies',
  IA_STRATEGIES: 'StrategiesIA',
  IA_ANALYSES: 'AnalysesIA',
};

// ---------------------------------------------------------------------------
// Une valeur objet/tableau est sérialisée en JSON dans la cellule (et
// désérialisée à la lecture) : ça permet d'exporter/importer n'importe quelle
// forme de données (listes de canaux par stratégie, historique IA imbriqué…)
// sans risquer un "[object Object]" illisible et sans pouvoir le relire.
// ---------------------------------------------------------------------------
function toCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
function fromCell(v) {
  if (typeof v === 'string' && v.length > 1 && (v[0] === '{' || v[0] === '[')) {
    try { return JSON.parse(v); } catch (_) { /* pas du JSON valide : on garde tel quel */ }
  }
  return v;
}

function toSheet(rows) {
  const clean = (rows || []).map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r || {})) out[k] = toCell(v);
    return out;
  });
  const keys = [];
  const seen = new Set();
  for (const r of clean) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const normalized = clean.map((r) => {
    const out = {};
    for (const k of keys) out[k] = r[k] !== undefined ? r[k] : '';
    return out;
  });
  return XLSX.utils.json_to_sheet(normalized, { header: keys });
}

function fromSheet(wb, name) {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return rows.map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) out[k] = fromCell(v);
    return out;
  });
}


// ---------------------------------------------------------------------------
// PANNEAUX — CORRECTIF « l'Excel n'exporte pas toutes les configurations » :
// l'export ne couvrait que state.* (général, canaux, stratégies de base,
// stratégies IA). Tous les panneaux (Répétition costume, Après perte,
// Prédiction combinée, Rupture de costume, Chevauchement, Comptage 2/2,
// Prédit IA, Formation, VIP, Statistiques, Jeu 21, message de perte,
// Taux Miroir, arrêt/planification) gardent leur réglage dans data.json
// (store) et n'étaient donc JAMAIS exportés. On les exporte maintenant tous,
// dans une feuille « Panneaux » : une ligne par morceau de JSON (une cellule
// Excel est limitée à 32 767 caractères, on découpe donc en morceaux).
// ---------------------------------------------------------------------------
const CHUNK = 30000;

// clé dans data.json -> module à recharger après import (chargé à la demande
// pour éviter toute dépendance circulaire avec bot.js/predictor.js)
const PANELS = {
  predit: { mod: './predit' },
  game21Predict: { mod: './game21-predict' },
  afterLoss: { mod: './after-loss' },
  combined: { mod: './combined' },
  suitStreak: { mod: './suit-streak' },
  suitBreak: { mod: './suit-break' },
  overlap: { mod: './overlap' },
  statistics: { mod: './statistics' },
  cardsCount: { mod: './cards-count' },
  vip: { mod: './vip' },
  formationRelay: { mod: './formation-relay' },
  predictionControl: { mod: './prediction-control' },
  lossNotice: { mod: './loss-notice' },
  mirrorCounter: { mod: './mirror-counter' },
};

function panelRows() {
  const data = store.read() || {};
  const rows = [];
  for (const key of Object.keys(PANELS)) {
    if (data[key] === undefined || data[key] === null) continue;
    const json = JSON.stringify(data[key]);
    for (let i = 0, part = 1; i < json.length; i += CHUNK, part += 1) {
      rows.push({ panneau: key, partie: part, json: json.slice(i, i + CHUNK) });
    }
  }
  return rows;
}

// lecture BRUTE de la feuille (pas de fromCell : un morceau de JSON ne doit
// pas être parsé tout seul).
function readPanels(wb) {
  const sheet = wb.Sheets[SHEETS.PANNEAUX];
  if (!sheet) return {};
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const parts = {};
  for (const r of rows) {
    const key = String(r.panneau || '').trim();
    if (!PANELS[key]) continue;
    (parts[key] = parts[key] || []).push({ n: Number(r.partie) || 0, json: String(r.json ?? '') });
  }
  const out = {};
  for (const [key, list] of Object.entries(parts)) {
    list.sort((a, b) => a.n - b.n);
    try { out[key] = JSON.parse(list.map((x) => x.json).join('')); } catch (_) { /* JSON illisible : panneau ignoré */ }
  }
  return out;
}

function applyPanel(key, value) {
  store.patch({ [key]: value });
  const m = require(PANELS[key].mod);
  // 1) recharge le module depuis data.json (mêmes contrôles qu'au démarrage)
  if (key === 'lossNotice') m.setSettings(value);
  else if (key === 'mirrorCounter') m.setChannel(value && value.channelId);
  else if (typeof m.restore === 'function') m.restore();
  // 2) réécrit l'état en base (sinon la base, qui prime au redémarrage,
  //    remettrait les anciens réglages) : configure(config()) déclenche la
  //    persistance propre à chaque module.
  if (key !== 'lossNotice' && key !== 'mirrorCounter' && typeof m.configure === 'function' && typeof m.config === 'function') {
    try { m.configure(m.config()); } catch (_) { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------
function buildWorkbook() {
  const wb = XLSX.utils.book_new();

  const general = [
    { cle: 'botToken', valeur: state.botToken || '' },
    { cle: 'adminId', valeur: state.adminId || '' },
    { cle: 'shopBotToken', valeur: state.shopBotToken || '' },
    { cle: 'format', valeur: state.format },
    { cle: 'template', valeur: state.template || '' },
    { cle: 'B', valeur: state.B },
    { cle: 'maxR', valeur: state.maxR },
    { cle: 'siteChannels', valeur: state.siteChannels || [] },
  ];
  XLSX.utils.book_append_sheet(wb, toSheet(general), SHEETS.GENERAL);

  const canaux = (state.channels || []).map((c) => ({
    id: c.id,
    titre: c.title || c.name || '',
    actif: (state.activeChannels || []).includes(c.id) ? 'oui' : 'non',
  }));
  XLSX.utils.book_append_sheet(wb, toSheet(canaux), SHEETS.CANAUX);

  const stratRows = Object.keys(state.strategies || {}).map((key) => ({
    key,
    ...state.strategies[key],
  }));
  XLSX.utils.book_append_sheet(wb, toSheet(stratRows), SHEETS.STRATEGIES);

  XLSX.utils.book_append_sheet(wb, toSheet(state.aiStrategies || []), SHEETS.IA_STRATEGIES);
  XLSX.utils.book_append_sheet(wb, toSheet(state.aiAnalyses || []), SHEETS.IA_ANALYSES);
  XLSX.utils.book_append_sheet(wb, toSheet(panelRows()), SHEETS.PANNEAUX);

  return wb;
}

function exportBuffer() {
  const wb = buildWorkbook();
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---------------------------------------------------------------------------
// IMPORT — chaque feuille est optionnelle : un classeur ne contenant que
// certaines feuilles ne touche QUE les données correspondantes, le reste de
// la configuration actuelle reste intact.
// ---------------------------------------------------------------------------
function importBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const applied = [];
  const skipped = [];

  const general = fromSheet(wb, SHEETS.GENERAL);
  if (general.length) {
    const map = {};
    for (const row of general) map[row.cle] = row.valeur;
    if (map.botToken) state.botToken = String(map.botToken);
    if (map.adminId !== undefined && map.adminId !== '') state.adminId = Number(map.adminId) || map.adminId;
    if (map.shopBotToken) state.shopBotToken = String(map.shopBotToken);
    if (map.format !== undefined && map.format !== '') state.format = Number(map.format) || state.format;
    if (map.template) state.template = String(map.template);
    if (map.B !== undefined && map.B !== '') state.B = Number(map.B) || state.B;
    if (map.maxR !== undefined && map.maxR !== '') state.maxR = Number(map.maxR);
    if (Array.isArray(map.siteChannels)) state.siteChannels = map.siteChannels;
    applied.push(SHEETS.GENERAL);
  } else skipped.push(SHEETS.GENERAL);

  const canaux = fromSheet(wb, SHEETS.CANAUX);
  if (canaux.length) {
    state.channels = canaux.map((c) => ({ id: /^-?\d+$/.test(String(c.id)) ? Number(c.id) : c.id, title: c.titre || '' }));
    state.activeChannels = canaux
      .filter((c) => String(c.actif).trim().toLowerCase() === 'oui')
      .map((c) => (/^-?\d+$/.test(String(c.id)) ? Number(c.id) : c.id));
    applied.push(SHEETS.CANAUX);
  } else skipped.push(SHEETS.CANAUX);

  const stratRows = fromSheet(wb, SHEETS.STRATEGIES);
  if (stratRows.length) {
    initStrategies(); // s'assure que toutes les clés connues existent avant patch
    let count = 0;
    for (const row of stratRows) {
      const key = row.key;
      if (!key || !strategies.BY_KEY[key]) continue;
      const patch = { ...row };
      delete patch.key;
      setStrategyConfig(key, patch); // valeurs validées/bornées comme depuis le panneau web
      count += 1;
    }
    applied.push(`${SHEETS.STRATEGIES} (${count})`);
  } else skipped.push(SHEETS.STRATEGIES);

  const iaStrat = fromSheet(wb, SHEETS.IA_STRATEGIES);
  if (iaStrat.length) { state.aiStrategies = iaStrat; applied.push(`${SHEETS.IA_STRATEGIES} (${iaStrat.length})`); }
  else skipped.push(SHEETS.IA_STRATEGIES);

  const iaAnalyses = fromSheet(wb, SHEETS.IA_ANALYSES);
  if (iaAnalyses.length) { state.aiAnalyses = iaAnalyses; applied.push(`${SHEETS.IA_ANALYSES} (${iaAnalyses.length})`); }
  else skipped.push(SHEETS.IA_ANALYSES);

  const panels = readPanels(wb);
  const panelKeys = Object.keys(panels);
  if (panelKeys.length) {
    const done = [];
    for (const key of panelKeys) {
      try { applyPanel(key, panels[key]); done.push(key); } catch (e) { skipped.push(`${key} (${e.message})`); }
    }
    applied.push(`${SHEETS.PANNEAUX} (${done.length} : ${done.join(', ')})`);
  } else skipped.push(SHEETS.PANNEAUX);

  return { applied, skipped };
}

module.exports = { SHEETS, exportBuffer, importBuffer };
