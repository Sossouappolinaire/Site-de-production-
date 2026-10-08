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
  REGLAGES: 'Reglages',
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

// JEUX EN LIVE : l'export Excel ne doit contenir AUCUNE donnée issue du jeu en
// cours (numéro surveillé, progression de série, prédictions en attente de
// résultat, dernier scan…). On ne garde que la configuration et l'historique
// terminé. À l'import, ces champs sont conservés tels qu'ils sont en direct
// sur le bot (jamais écrasés par un fichier).
const LIVE_KEYS = [
  'pendingMessages', 'pending', 'block', 'watching', 'lastSeenTarget',
  'streakSuit', 'streakCount', 'lastScanAt', 'live', 'liveGame', 'currentGame',
];
// Retrait limité au PREMIER niveau du panneau et aux éléments de `trackers` :
// aucune clé portant ce nom plus profondément (configuration, historique
// terminé) n'est touchée.
function stripLive(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (LIVE_KEYS.includes(k)) continue;
    out[k] = v;
  }
  if (Array.isArray(out.trackers)) {
    out.trackers = out.trackers.map((t) => {
      if (!t || typeof t !== 'object') return t;
      const c = {};
      for (const [k, v] of Object.entries(t)) if (!LIVE_KEYS.includes(k)) c[k] = v;
      return c;
    });
  }
  return out;
}
// reprend dans `current` les champs live (au premier niveau et dans trackers)
function keepLive(imported, current) {
  if (!imported || typeof imported !== 'object' || Array.isArray(imported)) return imported;
  const out = { ...imported };
  if (current && typeof current === 'object') {
    for (const k of LIVE_KEYS) if (current[k] !== undefined) out[k] = current[k];
    if (Array.isArray(out.trackers) && Array.isArray(current.trackers)) {
      out.trackers = out.trackers.map((t) => {
        const cur = current.trackers.find((x) => x && t && x.id === t.id);
        if (!cur) return t;
        const merged = { ...t };
        for (const k of LIVE_KEYS) if (cur[k] !== undefined) merged[k] = cur[k];
        return merged;
      });
    }
  }
  return out;
}

// clé dans data.json -> module à recharger après import (chargé à la demande
// pour éviter toute dépendance circulaire avec bot.js/predictor.js)
const PANELS = {
  predit: { mod: './predit' },
  game21Predict: { mod: './game21-predict' },
  afterLoss: { mod: './after-loss' },
  combined: { mod: './combined' },
  suitStreak: { mod: './suit-streak' },
  dizaineTop: { mod: './dizaine-top' },
  bestWeakTop: { mod: './best-weak-top' },
  costumeFaibleTop: { mod: './costume-faible-top' },
  suitBreak: { mod: './suit-break' },
  overlap: { mod: './overlap' },
  statistics: { mod: './statistics' },
  cardsCount: { mod: './cards-count' },
  vip: { mod: './vip' },
  formationRelay: { mod: './formation-relay' },
  predictionControl: { mod: './prediction-control' },
  lossNotice: { mod: './loss-notice' },
  mirrorCounter: { mod: './mirror-counter' },
  copyAnnounce: { mod: './copy-announce' },        // « Copie et annonce »
  game21Strategies: { mod: './game21-strategies' }, // stratégies Jeu 21 (liste lue directement dans data.json)
};

function panelRows() {
  const data = store.read() || {};
  const rows = [];
  for (const key of Object.keys(PANELS)) {
    if (data[key] === undefined || data[key] === null) continue;
    const json = JSON.stringify(stripLive(data[key]));
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
  store.patch({ [key]: keepLive(value, (store.read() || {})[key]) });
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
// RÉGLAGES — tout ce qui n'était PAS dans data.json ni dans state : clés API
// saisies à chaud (Gemini, Groq, OpenRouter), interrupteur de l'analyse IA
// automatique, clé d'envoi d'e-mails (Brevo), lien de base de données, liste
// et code source des stratégies créées par l'IA (sinon la liste « Créé par
// moi avec IA » et leur code repartent de zéro sur un nouvel hébergement).
// Une ligne par morceau (cellule Excel limitée à 32 767 caractères).
// ---------------------------------------------------------------------------
const DB_SETTINGS = [
  'brevo_api_key', 'brevo_from', 'ai_created_strategy_keys', 'ai_created_strategy_history', 'ai_strategy_code_blocks',
];

function lazy(name) { try { return require(name); } catch (_) { return null; } }

async function settingRows() {
  const rows = [];
  const add = (cle, valeur) => {
    if (valeur === undefined || valeur === null || valeur === '') return;
    const text = typeof valeur === 'string' ? valeur : JSON.stringify(valeur);
    for (let i = 0, part = 1; i < text.length; i += CHUNK, part += 1) rows.push({ cle, partie: part, valeur: text.slice(i, i + CHUNK) });
  };
  const ai = lazy('./ai-analyzer');
  if (ai) {
    add('ai_gemini_key', ai.geminiKey && ai.geminiKey());
    add('ai_groq_key', ai.groqKey && ai.groqKey());
    add('ai_openrouter_key', ai.openrouterKey && ai.openrouterKey());
  }
  const aiAuto = lazy('./ai-auto');
  if (aiAuto && aiAuto.auto) add('ai_auto_enabled', aiAuto.auto.enabled ? 'true' : 'false');
  add('databaseUrl', (store.read() || {}).databaseUrl);
  const db = lazy('./db');
  if (db && db.ready) {
    for (const key of DB_SETTINGS) {
      try { add(key, await db.getSetting(key)); } catch (_) { /* best-effort */ }
    }
  }
  return rows;
}

async function importSettings(wb, report) {
  const sheet = wb.Sheets[SHEETS.REGLAGES];
  if (!sheet) { report.skipped.push(SHEETS.REGLAGES); return; }
  const parts = {};
  for (const r of XLSX.utils.sheet_to_json(sheet, { defval: '' })) {
    const key = String(r.cle || '').trim();
    if (!key) continue;
    (parts[key] = parts[key] || []).push({ n: Number(r.partie) || 0, v: String(r.valeur ?? '') });
  }
  const val = {};
  for (const [k, list] of Object.entries(parts)) { list.sort((a, b) => a.n - b.n); val[k] = list.map((x) => x.v).join(''); }
  const db = lazy('./db');
  const done = [];
  const ai = lazy('./ai-analyzer');
  const saveDb = async (key, value) => { if (db && db.ready) { try { await db.setSetting(key, value); } catch (_) { /* best-effort */ } } };
  if (ai && val.ai_gemini_key) { ai.setGeminiKey(val.ai_gemini_key); await saveDb('ai_gemini_key', val.ai_gemini_key); done.push('clé Gemini'); }
  if (ai && val.ai_groq_key) { ai.setGroqKey(val.ai_groq_key); await saveDb('ai_groq_key', val.ai_groq_key); done.push('clé Groq'); }
  if (ai && val.ai_openrouter_key) { ai.setOpenrouterKey(val.ai_openrouter_key); await saveDb('ai_openrouter_key', val.ai_openrouter_key); done.push('clé OpenRouter'); }
  const aiAuto = lazy('./ai-auto');
  if (aiAuto && aiAuto.auto && val.ai_auto_enabled !== undefined) {
    aiAuto.auto.enabled = val.ai_auto_enabled !== 'false';
    await saveDb('ai_auto_enabled', val.ai_auto_enabled);
    done.push('analyse IA auto');
  }
  for (const key of DB_SETTINGS) {
    if (val[key] === undefined) continue;
    await saveDb(key, val[key]);
    done.push(key);
  }
  // lien de base : on ne remplace JAMAIS une base déjà configurée (cela
  // couperait la connexion en cours) ; il sert seulement à un hébergement neuf.
  if (val.databaseUrl && !(store.read() || {}).databaseUrl) {
    store.patch({ databaseUrl: val.databaseUrl });
    done.push('lien de base (redémarrage requis)');
  }
  report.applied.push(`${SHEETS.REGLAGES} (${done.length}${done.length ? ' : ' + done.join(', ') : ''})`);
}

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------
async function buildWorkbook() {
  const wb = XLSX.utils.book_new();

  const general = [
    { cle: 'botToken', valeur: state.botToken || '' },
    { cle: 'adminId', valeur: state.adminId || '' },
    { cle: 'shopBotToken', valeur: state.shopBotToken || (store.read() || {}).shopBotToken || '' },
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
  XLSX.utils.book_append_sheet(wb, toSheet(await settingRows()), SHEETS.REGLAGES);

  // Pas de feuille « Predictions », « Annonces » ni « Portes » : ce sont des
  // données issues du jeu en live (cibles en cours, compteurs de pertes).

  return wb;
}

async function exportBuffer() {
  const wb = await buildWorkbook();
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---------------------------------------------------------------------------
// IMPORT — chaque feuille est optionnelle : un classeur ne contenant que
// certaines feuilles ne touche QUE les données correspondantes, le reste de
// la configuration actuelle reste intact.
// ---------------------------------------------------------------------------
function importWorkbook(wb) {
  const applied = [];
  const skipped = [];

  const general = fromSheet(wb, SHEETS.GENERAL);
  if (general.length) {
    const map = {};
    for (const row of general) map[row.cle] = row.valeur;
    if (map.botToken) state.botToken = String(map.botToken);
    if (map.adminId !== undefined && map.adminId !== '') state.adminId = Number(map.adminId) || map.adminId;
    if (map.shopBotToken) { state.shopBotToken = String(map.shopBotToken); store.patch({ shopBotToken: state.shopBotToken }); }
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

// import synchrone (compatibilité) : tout sauf la feuille « Reglages »
function importBuffer(buffer) {
  return importWorkbook(XLSX.read(buffer, { type: 'buffer' }));
}

// import complet : y compris les réglages stockés en base (clés API, e-mails…)
async function importBufferAsync(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const report = importWorkbook(wb);
  await importSettings(wb, report);
  return report;
}

module.exports = { SHEETS, exportBuffer, importBuffer, importBufferAsync, stripLive, keepLive };
