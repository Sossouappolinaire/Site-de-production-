// shoe-report.js — rapport PDF envoyé automatiquement à chaque nouveau sabot
// (dès que le jeu revient à #N1) : pour CHACUNE des 7 stratégies, liste les
// déclencheurs « après perte » (rattrapage 1/2/3, perdue + nombre N de
// prédictions à laisser passer) dont le taux de réussite mesuré sur
// l'historique réel du bot est ≥ 75%, accompagnés d'un conseil ciblé.
//
// Le conseil est rédigé par l'IA (mêmes clés/fournisseurs que le reste du
// bot — voir ai-analyzer.js) à partir UNIQUEMENT des chiffres calculés ici ;
// si aucune clé IA n'est disponible, un conseil équivalent est généré
// localement à partir des mêmes chiffres (jamais de texte inventé).
'use strict';

const PDFDocument = require('pdfkit');
const strategies = require('./strategies');
const afterLoss = require('./after-loss');
const { stats: strategyStats } = require('./predictor');
const ai = require('./ai-analyzer');

const MIN_RATE = 75;   // seuil demandé : déclencheurs ≥ 75%
const MIN_SAMPLE = 2;  // au moins 2 essais mesurés pour être retenu

// ---------------------------------------------------------------------------
// Conseil de repli (sans IA) — dérivé uniquement des chiffres déjà calculés,
// jamais inventé.
// ---------------------------------------------------------------------------
function localAdvice(entry) {
  const s = entry.stats;
  if (!entry.triggers.length) {
    return s.total < 5
      ? `Pas encore assez d'historique (${s.total} prédiction(s)) sur « ${entry.name} » pour dégager un déclencheur fiable à ${MIN_RATE}% — laisser l'échantillon grandir avant d'agir.`
      : `Aucun déclencheur n'atteint ${MIN_RATE}% sur « ${entry.name} » avec l'historique actuel (${s.total} prédiction(s), ${s.rate}% de réussite globale) — pas de réglage « après perte » à recommander pour l'instant sur cette stratégie.`;
  }
  const best = entry.triggers[0];
  const waitTxt = best.n > 0 ? `attendre ${best.n} prédiction(s)` : 'envoi immédiat';
  return `Sur « ${entry.name} », la combinaison « ${best.label} + ${waitTxt} » a réussi ${best.wins}/${best.sends} fois (${best.ratePct}%) — c'est la base la plus solide pour régler un suivi « après perte » sur cette stratégie. Résultat passé sur un échantillon donné, pas une garantie : le baccara reste indépendant à chaque main.`;
}

async function aiAdvice(entry) {
  const hasKey = ai.keyLooksValid() || ai.geminiConfigured() || ai.groqConfigured() || ai.openrouterConfigured();
  if (!hasKey) return localAdvice(entry);
  try {
    const text = await ai.chat({
      system: [
        "Tu rédiges, en français, un conseil COURT (3 à 4 phrases MAXIMUM) et bien ciblé pour un joueur qui suit une stratégie de prédiction baccara.",
        "Base-toi UNIQUEMENT sur les chiffres fournis (bilan global de la stratégie, et liste des déclencheurs « après perte » dont le taux mesuré est ≥ 75%). N'invente jamais un chiffre.",
        "Si la liste des déclencheurs est vide, dis-le clairement et explique quoi surveiller ensuite plutôt que d'inventer une recommandation.",
        "Rappelle toujours que ce sont des résultats passés sur un échantillon donné, pas une garantie — le baccara reste un jeu aléatoire.",
        "Texte brut uniquement, en phrases complètes, sans markdown, sans puces, sans astérisque.",
      ].join(' '),
      user: { strategie: entry.name, bilanGlobal: entry.stats, declencheursFiables: entry.triggers },
      temperature: 0.2,
      timeoutMs: 15000,
    });
    const clean = String(text || '').trim();
    return clean || localAdvice(entry);
  } catch (_) {
    return localAdvice(entry);
  }
}

// ---------------------------------------------------------------------------
// Données du rapport : les 7 stratégies, chacune avec son bilan, ses
// déclencheurs ≥ 75% et son conseil ciblé.
// ---------------------------------------------------------------------------
async function buildReport() {
  const raw = afterLoss.allTriggersAboveThreshold(MIN_RATE, MIN_SAMPLE);
  const entries = raw.map((r) => ({ ...r, stats: strategyStats(r.key) }));
  for (const entry of entries) {
    entry.advice = await aiAdvice(entry);
  }
  return { generatedAt: new Date(), minRate: MIN_RATE, entries };
}

// ---------------------------------------------------------------------------
// Mise en page PDF
// ---------------------------------------------------------------------------
function renderPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 42, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(17).fillColor('#0b3d0b')
      .text(`Rapport de fin de sabot — déclencheurs fiables (≥ ${report.minRate}%)`, { align: 'left' });
    doc.moveDown(0.2);
    doc.fontSize(9).fillColor('#555')
      .text(`Généré le ${report.generatedAt.toLocaleString('fr-FR', { timeZone: 'Africa/Abidjan' })} (heure d'Abidjan) — 7 stratégies vérifiées.`);
    doc.fillColor('#000');
    doc.moveDown(1);

    report.entries.forEach((entry, i) => {
      if (i > 0) doc.moveDown(0.6);
      doc.fontSize(13).fillColor('#0b3d0b').text(entry.name, { underline: true });
      doc.fillColor('#000').fontSize(10);
      doc.text(`Bilan global : ${entry.stats.win} gagné(s) / ${entry.stats.loss} perdu(s) / ${entry.stats.total} au total — ${entry.stats.rate}% de réussite.`);
      doc.moveDown(0.25);

      if (entry.triggers.length) {
        doc.font('Helvetica-Bold').text(`Déclencheurs ≥ ${report.minRate}% :`);
        doc.font('Helvetica');
        for (const t of entry.triggers) {
          const waitTxt = t.n > 0 ? `attendre ${t.n} prédiction(s)` : 'envoi immédiat';
          doc.text(`•  ${t.label} + ${waitTxt} — ${t.wins}/${t.sends} (${t.ratePct}%)`, { indent: 10 });
        }
      } else {
        doc.font('Helvetica-Oblique').text(`Aucun déclencheur ne dépasse ${report.minRate}% sur l'historique actuel.`);
        doc.font('Helvetica');
      }
      doc.moveDown(0.25);
      doc.font('Helvetica-Bold').text('Conseil :');
      doc.font('Helvetica').text(entry.advice, { align: 'justify' });
    });

    doc.moveDown(1);
    doc.fontSize(8).fillColor('#888')
      .text("Chiffres mesurés sur l'historique du bot — performance passée, aucune garantie pour l'avenir : le baccara reste un jeu aléatoire.", { align: 'center' });

    doc.end();
  });
}

async function generate() {
  const report = await buildReport();
  const pdf = await renderPdf(report);
  return { report, pdf };
}

module.exports = { buildReport, renderPdf, generate, MIN_RATE };
