// strategy-advisor.js — panneau « Avis IA sur les stratégies existantes »
//
//  • L'IA regarde TOUT ce qui est cumulé depuis le début de la journée
//    (jeux 1 → N, jusqu'à 1440) et non une fenêtre fixe de 4 jeux.
//  • Pour chaque stratégie existante, elle mesure les résultats réels
//    (gains / pertes / rattrapages) et croise avec les régularités trouvées
//    par le moteur d'analyse cumulative.
//  • Elle rend un AVIS (garder, ajuster, mettre en pause) et des CONSEILS
//    concrets (lead, rattrapages, absence, mode silencieux…).
//  • Un enrichissement Pollinations.ai est ajouté quand la clé est valide.
'use strict';

const ai = require('./ai-analyzer');
const db = require('./db');
const strategiesLib = require('./strategies');
const cumulative = require('./cumulative');
const { state, gateView } = require('./predictor');

const runtime = {
  lastRunAt: null,
  lastError: null,
  advices: [],
  global: null,
  remote: null,
  remoteAt: null,
  sample: 0,
  upTo: 0,
  range: null,
  firstGame: null,
  lastGame: null,
};

function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : 0; }

// résultats CUMULÉS d'une stratégie depuis le début (base si disponible,
// sinon mémoire). CORRECTIF : avant, mémoire ET base étaient additionnées —
// or chaque prédiction est enregistrée dans les DEUX dès son envoi
// (db.savePrediction() dans broadcast()) et la mémoire n'est vidée qu'une
// fois par jour (flushBilans()) : chaque prédiction terminée du jour était
// donc comptée deux fois (total gonflé, seuil « échantillon suffisant »
// atteint à tort). On ne prend plus qu'UNE seule source à la fois.
function liveStats(key, dbRows = []) {
  const dbForKey = dbRows.filter((r) => r.strategy === key);
  if (dbForKey.length) {
    const done = dbForKey.filter((r) => String(r.status || '').startsWith('gagn') || String(r.status || '').startsWith('perd'));
    const win = done.filter((r) => String(r.status || '').startsWith('gagn')).length;
    const steps = done.filter((r) => String(r.status || '').startsWith('gagn')).map((r) => r.rattrapage || 0);
    const avgStep = steps.length ? Math.round((steps.reduce((a, b) => a + b, 0) / steps.length) * 100) / 100 : 0;
    return {
      total: done.length, win, loss: done.length - win,
      rate: pct(win, done.length),
      pending: dbForKey.length - done.length,
      avgStep,
      firstAt: null,
    };
  }
  // repli mémoire : base indisponible, ou pas encore de ligne pour cette clé
  const list = (state.predictions || []).filter((p) => p.strategy === key);
  const done = list.filter((p) => p.status === 'gagné' || p.status === 'perdu');
  const win = done.filter((p) => p.status === 'gagné').length;
  const steps = done.filter((p) => p.status === 'gagné').map((p) => p.step || 0);
  const avgStep = steps.length ? Math.round((steps.reduce((a, b) => a + b, 0) / steps.length) * 100) / 100 : 0;
  return {
    total: done.length, win, loss: done.length - win,
    rate: pct(win, done.length),
    pending: list.length - done.length,
    avgStep,
    firstAt: list.length ? list[list.length - 1].sentAt : null,
  };
}

// avis + conseils pour une stratégie, en tenant compte du cumul complet
function adviceFor(def, cfg, st, checkpointCount, findings, cov) {
  const tips = [];
  let verdict = 'à observer';
  let tone = 'wait';

  if (st.total < 8) {
    verdict = 'échantillon insuffisant';
    tips.push(`Seulement ${st.total} prédiction(s) terminée(s) : laisser cumuler jusqu'à au moins 8 avant de juger.`);
  } else if (st.rate >= 70) {
    verdict = 'à conserver';
    tone = 'win';
    tips.push(`Taux cumulé de ${st.rate}% sur ${st.total} prédictions : la règle tient, ne pas y toucher.`);
    if (cfg.silent) tips.push('Le mode silencieux freine une stratégie qui gagne : envisager de le désactiver ou de baisser le déclencheur de pertes à 1.');
  } else if (st.rate >= 50) {
    verdict = 'à ajuster';
    tips.push(`Taux cumulé de ${st.rate}% : ajuster un seul réglage à la fois et laisser au moins 20 jeux avant de rejuger.`);
    if ((cfg.maxR || 0) < 2) tips.push(`Passer les rattrapages de +${cfg.maxR || 0} à +${(cfg.maxR || 0) + 1} pour récupérer les retours tardifs.`);
  } else {
    verdict = 'à mettre en pause';
    tone = 'loss';
    tips.push(`Taux cumulé de ${st.rate}% sur ${st.total} prédictions : basculer en mode silencieux plutôt que de publier.`);
  }

  if (st.avgStep >= 1.5 && (cfg.maxR || 0) <= st.avgStep) {
    tips.push(`Les gains arrivent en moyenne au rattrapage +${st.avgStep} : ${cfg.maxR} rattrapage(s) est trop court.`);
  }
  if (def.key === 'ombre' || def.key === 'absente') {
    const need = cfg.absence || cfg.streak || 4;
    tips.push(`Absence exigée : ${need} jeux. Si peu de prédictions sortent, baisser à ${Math.max(2, need - 1)} ; si trop de pertes, monter à ${need + 1}.`);
  }
  const g = gateView(def.key);
  if (g.silent && !g.sending) {
    tips.push(`Envoi actuellement bloqué (${g.label}). Le déblocage automatique intervient après ${g.autoUnlockMin || 10} minutes.`);
  }
  if (cov && cov.sample) {
    tips.push(`Avis fondé sur ${cov.label} — ${checkpointCount} palier(s) cumulés de la journée.`);
  }

  return {
    key: def.key,
    name: def.name,
    enabled: !!cfg.enabled,
    verdict,
    tone,
    stats: st,
    settings: {
      maxR: cfg.maxR, lead: cfg.lead, b: cfg.b, absence: cfg.absence, streak: cfg.streak,
      silent: !!cfg.silent, lossTrigger: cfg.lossTrigger || 2, autoUnlockMin: cfg.autoUnlockMin ?? 10,
      format: cfg.format,
    },
    advice: tips,
    context: (findings || []).slice(0, 3),
  };
}

async function run({ remote = false } = {}) {
  try {
    const status = cumulative.status();
    const last = status.current || status.last || null;
    const cov = status.coverage || { sample: 0, label: 'aucun jeu analysé', firstGame: null, lastGame: null };
    const findings = last ? last.findings || [] : [];
    let dbRows = [];
    if (db.ready) {
      try { dbRows = (await db.predictionsByDate(new Date().toISOString().slice(0, 10), 1000)) || []; }
      catch (_) { dbRows = []; }
    }

    const advices = (strategiesLib.LIST || []).map((def) => {
      const cfg = (state.strategies && state.strategies[def.key]) || {};
      return adviceFor(def, cfg, liveStats(def.key, dbRows), status.count || 0, findings, cov);
    });

    const totals = advices.reduce((acc, a) => {
      acc.total += a.stats.total; acc.win += a.stats.win; acc.loss += a.stats.loss; return acc;
    }, { total: 0, win: 0, loss: 0 });

    const ranked = [...advices].filter((a) => a.stats.total >= 5).sort((a, b) => b.stats.rate - a.stats.rate);

    runtime.advices = advices;
    runtime.sample = last ? last.sample : 0;
    runtime.upTo = last ? last.upTo : 0;
    runtime.range = cov.label;
    runtime.firstGame = cov.firstGame;
    runtime.lastGame = cov.lastGame;
    runtime.global = {
      total: totals.total,
      win: totals.win,
      loss: totals.loss,
      rate: pct(totals.win, totals.total),
      best: ranked[0] ? { key: ranked[0].key, name: ranked[0].name, rate: ranked[0].stats.rate } : null,
      worst: ranked.length > 1 ? { key: ranked[ranked.length - 1].key, name: ranked[ranked.length - 1].name, rate: ranked[ranked.length - 1].stats.rate } : null,
      checkpoints: status.count || 0,
      upTo: last ? last.upTo : 0,
      range: cov.label,
      firstGame: cov.firstGame,
      lastGame: cov.lastGame,
      sample: cov.sample,
      maxGames: cumulative.MAX_GAMES,
      summary: last ? last.verdict : null,
      advice: ranked.length
        ? `Analyse portant sur ${cov.label}. ` +
          `Sur le cumul de la journée, ${ranked[0].name} est la plus fiable (${ranked[0].stats.rate}%). ` +
          (ranked.length > 1 ? `${ranked[ranked.length - 1].name} est la plus faible (${ranked[ranked.length - 1].stats.rate}%) : la garder en mode silencieux.` : '')
        : `Analyse portant sur ${cov.label}. Pas encore assez de prédictions terminées pour classer les stratégies : laisser le cumul se remplir.`,
    };

    if (remote && ai.keyLooksValid()) {
      try {
        const games = [...(state.history || [])].slice(0, 80);
        const res = await ai.analyze({
          games,
          objective:
            "Donne un AVIS et des CONSEILS sur les stratégies existantes suivantes, en tenant compte du CUMUL de la journée " +
            `(${cov.label}, maximum 1440). Commence ta réponse en précisant exactement la plage analysée ` +
            `(du jeu #${cov.firstGame ?? '?'} au jeu #${cov.lastGame ?? '?'}). Résultats mesurés : ` +
            advices.map((a) => `${a.name} = ${a.stats.win}G/${a.stats.loss}P (${a.stats.rate}%)`).join(' ; ') +
            ". Dis lesquelles garder, lesquelles ajuster (rattrapages, lead, absence) et lesquelles mettre en silencieux.",
        });
        runtime.remote = res;
        runtime.remoteAt = Date.now();
      } catch (e) { runtime.lastError = e.message; }
    }

    runtime.lastRunAt = Date.now();
    if (!remote) runtime.lastError = null;
    return status_();
  } catch (e) {
    runtime.lastError = e.message;
    return status_();
  }
}

function status_() {
  return {
    lastRunAt: runtime.lastRunAt,
    lastError: runtime.lastError,
    upTo: runtime.upTo,
    sample: runtime.sample,
    range: runtime.range,
    firstGame: runtime.firstGame,
    lastGame: runtime.lastGame,
    maxGames: cumulative.MAX_GAMES,
    global: runtime.global,
    advices: runtime.advices,
    remote: runtime.remote,
    remoteAt: runtime.remoteAt,
  };
}

module.exports = { run, status: status_, runtime };
