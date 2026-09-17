// deploy-generator.js — panneau admin « Déploiement ».
//
// Construit à la volée un ZIP prêt à déployer (Render, VPS…) contenant le code
// du bot. L'admin peut choisir les modules optionnels à embarquer ; les
// fichiers indispensables sont toujours inclus. Aucune clé privée n'est
// ajoutée au ZIP (data.json et .env sont exclus).
'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT = __dirname;

// fichiers toujours inclus (cœur du service)
const CORE = [
  'package.json', 'render.yaml', 'README.md',
  'bootstrap.js', 'server.js', 'config.js', 'database-url.js', 'session-store.js',
  'store.js', 'db.js', 'auth.js', 'api.js', 'bot.js', 'predictor.js', 'strategies.js',
  'formats.js', 'tg-formats.js', 'deploy-generator.js',
];

// modules optionnels proposés à la sélection
const OPTIONAL = [
  { id: 'ia', name: 'Analyseur IA + réparation + questions-réponses', files: ['ai-analyzer.js', 'ai-auto.js', 'ai-qa.js', 'ai-repair.js', 'pattern-miner.js', 'strategy-advisor.js'] },
  { id: 'strategies_plus', name: 'Stratégies avancées (rupture, séries, dizaines, miroir…)', files: ['suit-streak.js', 'suit-break.js', 'cards-count.js', 'mirror-counter.js', 'combined.js', 'cumulative.js', 'after-loss.js', 'prediction-control.js', 'predit.js', 'loss-notice.js'] },
  { id: 'formation', name: 'Formation et relais de formation', files: ['formation.js', 'formation-relay.js'] },
  { id: 'game21', name: 'Jeu 21', files: ['game21.js', 'game21-strategies.js', 'game21-predict.js'] },
  { id: 'rapports', name: 'Rapports (sabot, comparaison des jours, transfert de données)', files: ['shoe-report.js', 'day-compare.js', 'data-transfer.js'] },
  { id: 'boutique', name: 'Boutique, paiements et VIP', files: ['shop.js', 'paiement.js', 'sebpay.js', 'vip.js'] },
  { id: 'web', name: 'Tableau de bord web (pages publiques)', files: ['public'] },
];

function exists(rel) {
  try { fs.accessSync(path.join(ROOT, rel)); return true; } catch (_) { return false; }
}

function listSelectable() {
  return {
    core: CORE.filter(exists),
    options: OPTIONAL.map((o) => ({
      id: o.id,
      name: o.name,
      files: o.files.filter(exists),
      selectedByDefault: true,
    })),
  };
}

function buildZipStream(selection) {
  const chosen = Array.isArray(selection) && selection.length
    ? OPTIONAL.filter((o) => selection.includes(o.id))
    : OPTIONAL; // aucune sélection → tout embarquer

  const files = [...CORE];
  for (const o of chosen) files.push(...o.files);

  const present = [...new Set(files)].filter(exists);
  if (!present.length) throw new Error('Aucun fichier à inclure dans le ZIP.');

  const archive = archiver('zip', { zlib: { level: 9 } });
  for (const rel of present) {
    const abs = path.join(ROOT, rel);
    if (fs.statSync(abs).isDirectory()) archive.directory(abs, rel);
    else archive.file(abs, { name: rel });
  }
  archive.finalize();

  const slug = 'baccara-bot-' + new Date().toISOString().slice(0, 10);
  return { slug, archive, files: present };
}

module.exports = { listSelectable, buildZipStream, CORE, OPTIONAL };
