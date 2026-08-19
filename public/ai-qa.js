// ai-qa.js — « Poser une question à l'IA » : réponses fondées sur les VRAIES
// données du bot (prédictions envoyées, raison de chaque prédiction, état des
// filtres/gates, réglages des stratégies), pas sur des suppositions générales.
//
// Exemple : « Pourquoi la stratégie ombre a prédit le jeu 12 ? » → le module
// retrouve la prédiction ciblant (ou ayant touché) le jeu #12, remonte son
// champ `reason` (rédigé par detect() dans strategies.js, ex. « ❤️ absent
// pendant 5 jeux consécutifs … retour au jeu #N959 → prédiction ❤️ sur #N963
// (+4) ») et le donne à l'IA comme UNIQUE source de vérité pour répondre.
'use strict';

const config = require('./config');
const ai = require('./ai-analyzer');
const db = require('./db');
const strategies = require('./strategies');
const { state, gateView, stats: strategyStats } = require('./predictor');
const store = require('./store');
const predit = require('./predit');
const advisor = require('./strategy-advisor');

const MAX_HISTORY = 12; // nombre d'échanges question/réponse gardés en mémoire (par admin)
const HISTORY_TTL_MS = 5 * 60 * 1000; // 5 minutes : au-delà, une question/réponse est effacée
const runtime = {
  lastAskedAt: null,
  lastError: null,
  history: [], // { question, answer, at }
};

// retire du journal toute question/réponse vieille de plus de 5 minutes —
// après ce délai, la liste « Questions précédentes » redevient vide.
function pruneHistory() {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  runtime.history = runtime.history.filter((e) => new Date(e.at).getTime() >= cutoff);
}

// extrait les numéros de jeu mentionnés dans la question : « jeu 12 »,
// « #N12 », « le 12 », « numéro 12 »…
function extractGameNumbers(text) {
  const found = new Set();
  const re = /#?N?°?\s*(\d{1,6})/gi;
  let m;
  while ((m = re.exec(text))) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) found.add(n);
  }
  return [...found].slice(0, 5);
}

// retrouve, pour un numéro de jeu donné, toute prédiction (mémoire d'abord,
// puis base si absente de la mémoire) ciblant ce jeu ou l'ayant touché.
async function findPredictionsForNumber(number) {
  const fromMemory = (state.predictions || []).filter(
    (p) => p.target === number || p.hitNumber === number
  );
  if (fromMemory.length) {
    return fromMemory.map((p) => ({
      strategy: p.strategy,
      target: p.target,
      suit: p.suit || p.cardsLabel || null,
      status: p.status,
      reason: p.reason || null,
      hitNumber: p.hitNumber || null,
      step: p.step || 0,
      from: p.from || null,
      trigger: p.trigger || null,
      source: 'mémoire',
    }));
  }
  if (!db.ready) return [];
  try {
    const rows = await db.predictionsByNumber(number, 10);
    return rows.map((r) => ({
      strategy: r.strategy,
      target: Number(r.target),
      suit: r.suit,
      status: r.status,
      reason: r.reason || null,
      hitNumber: r.hit_number != null ? Number(r.hit_number) : null,
      step: r.rattrapage || 0,
      from: null,
      trigger: null,
      source: 'base de données',
    }));
  } catch (_) {
    return [];
  }
}

// nom lisible d'un canal (titre connu si le bot y a déjà été ajouté, sinon
// juste son identifiant Telegram)
function channelLabel(id) {
  try {
    const known = ((store.read() || {}).channels || []).find((c) => String(c.id) === String(id));
    return known && known.title ? `${known.title} (${id})` : String(id);
  } catch (_) { return String(id); }
}

// état courant (config + filtre + CANAUX + BILAN) de chaque stratégie,
// condensé pour le contexte IA — sans le bilan/pourcentage, l'IA ne peut pas
// dire « je préfère telle stratégie car son taux de réussite est... ».
function strategiesSnapshot() {
  return strategies.LIST.map((def) => {
    const cfg = (state.strategies && state.strategies[def.key]) || strategies.defaultsFor(def.key);
    const g = gateView(def.key);
    const s = strategyStats(def.key);
    const published = Array.isArray(cfg.publishedChannels) && cfg.publishedChannels.length
      ? cfg.publishedChannels
      : (Array.isArray(cfg.channels) ? cfg.channels : []);
    const shadow = Array.isArray(cfg.shadowChannels) ? cfg.shadowChannels : [];
    return {
      key: def.key,
      name: def.name,
      enabled: !!cfg.enabled,
      settings: {
        maxR: cfg.maxR, lead: cfg.lead, absence: cfg.absence, scope: cfg.scope,
        silent: !!cfg.silent, lossTrigger: cfg.lossTrigger, lossWindow: cfg.lossWindow,
        lossInterval: cfg.lossInterval, resetOnWin: cfg.resetOnWin,
      },
      bilan: { gains: s.win, pertes: s.loss, enAttente: s.pending, total: s.total, pourcentageReussite: s.rate },
      canalPublic: published.length ? published.map(channelLabel) : 'aucun canal public configuré',
      canalSilencieux: shadow.length ? shadow.map(channelLabel) : 'aucun canal silencieux configuré',
      gate: { phase: g.phase, label: g.label, sending: g.sending, queueLength: g.queueLength },
    };
  });
}

// avis de l'IA-conseillère (strategy-advisor.js) : verdict + conseils de
// réglages concrets par stratégie existante, calculés sur le cumul du jour.
// C'est de là que viennent des phrases comme « je te conseille de choisir
// 2 pertes avant la prédiction suivante » ou « le déclencheur le plus fiable
// est... » — jamais inventées, toujours dérivées des vraies statistiques.
async function advisorSnapshot() {
  try {
    await advisor.run({ remote: false });
    const st = advisor.status();
    return {
      analysePortantSur: st.range,
      meilleureStrategie: st.global && st.global.best ? st.global.best : null,
      strategieLaPlusFaible: st.global && st.global.worst ? st.global.worst : null,
      resumeGlobal: st.global ? st.global.advice : null,
      avisParStrategie: (st.advices || []).map((a) => ({
        key: a.key,
        name: a.name,
        verdict: a.verdict,
        bilan: { gains: a.stats.win, pertes: a.stats.loss, total: a.stats.total, pourcentageReussite: a.stats.rate },
        reglagesActuels: a.settings,
        conseils: a.advice,
      })),
    };
  } catch (_) { return null; }
}

// bilan de la stratégie IA « Prédit » (règles découvertes automatiquement),
// pour permettre la comparaison « stratégie existante vs prédiction IA ».
function preditSnapshot() {
  try {
    const st = predit.status();
    return {
      bilanGlobal: {
        gains: st.globalBilan.win, pertes: st.globalBilan.loss,
        total: st.globalBilan.total, pourcentageReussite: st.globalBilan.rate,
      },
      reglesActives: (st.strategies || []).filter((s) => s.active).map((s) => ({
        nom: s.name, pourcentageFiabilite: s.rate, echantillon: s.sample,
        bilan: { gains: s.bilan.win, pertes: s.bilan.loss, pourcentageReussite: s.bilan.rate },
      })),
    };
  } catch (_) { return null; }
}

// liste globale des canaux connus du bot (tous usages confondus)
function channelsSnapshot() {
  try {
    return ((store.read() || {}).channels || []).map((c) => ({ id: c.id, titre: c.title || String(c.id) }));
  } catch (_) { return []; }
}

// dernières prédictions toutes stratégies confondues (contexte général si la
// question ne cible pas un numéro précis)
function recentPredictionsSnapshot(limit = 15) {
  return (state.predictions || []).slice(0, limit).map((p) => ({
    strategy: p.strategy, target: p.target, suit: p.suit || p.cardsLabel || null,
    status: p.status, reason: p.reason || null, hitNumber: p.hitNumber || null,
  }));
}

async function buildContext(question) {
  const numbers = extractGameNumbers(question);
  const matches = {};
  for (const n of numbers) {
    const found = await findPredictionsForNumber(n);
    if (found.length) matches[n] = found;
  }
  return {
    dateHeure: new Date().toISOString(),
    questionNumerosDetectes: numbers,
    predictionsCorrespondantes: matches,
    strategiesActuelles: strategiesSnapshot(),
    avisEtConseils: await advisorSnapshot(),
    predictionIA: preditSnapshot(),
    canauxConnusDuBot: channelsSnapshot(),
    dernieresPredictions: recentPredictionsSnapshot(),
  };
}

// Réponse hors-IA (repli) quand aucune réponse IA n'a pu être obtenue : on
// donne quand même les données brutes trouvées, sans mise en forme par un
// modèle de langage. Le texte diffère selon qui regarde : SEUL l'admin voit
// qu'aucune clé n'est configurée / qu'il y a eu une erreur technique — un
// utilisateur normal reçoit une phrase neutre, jamais l'info technique.
function fallbackAnswer(context, { isAdmin } = {}) {
  const nums = context.questionNumerosDetectes;
  if (!nums.length) {
    return isAdmin
      ? "Aucune clé IA configurée ou disponible pour reformuler la réponse (visible uniquement par l'administrateur), et aucun numéro de jeu détecté dans la question. Précise un numéro de jeu (ex. « jeu 12 ») pour que je retrouve la prédiction correspondante."
      : "Je n'ai pas trouvé de numéro de jeu précis dans ta question. Précise un numéro de jeu (ex. « jeu 12 ») pour que je retrouve la prédiction correspondante.";
  }
  const parts = [];
  for (const n of nums) {
    const list = context.predictionsCorrespondantes[n];
    if (!list || !list.length) { parts.push(`Aucune prédiction trouvée pour le jeu #${n}.`); continue; }
    for (const p of list) {
      parts.push(
        `Jeu #${n} — stratégie « ${p.strategy} », statut ${p.status || 'inconnu'}` +
        (p.reason ? ` : ${p.reason}` : ' (aucune raison enregistrée pour cette prédiction).')
      );
    }
  }
  return parts.join('\n');
}

// filet de sécurité : au cas où le modèle renverrait quand même du markdown
// ou un bloc de raisonnement, on nettoie avant d'afficher la réponse.
function cleanAnswer(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .replace(/^\s{0,3}[-*•]\s+/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// vrai seulement si AUCUN fournisseur IA n'a de clé du tout — dans ce cas
// ai.chat() n'irait de toute façon interroger que les modèles gratuits sans
// clé (lents, souvent saturés) : autant répondre tout de suite avec les
// données brutes plutôt que de faire attendre l'utilisateur pour rien.
function noKeyConfigured() {
  return !ai.keyLooksValid() && !ai.geminiConfigured() && !ai.groqConfigured() && !ai.openrouterConfigured();
}

async function ask(question, { isAdmin = false } = {}) {
  const q = String(question || '').trim();
  if (!q) { const e = new Error('Question vide.'); e.code = 'EMPTY_QUESTION'; throw e; }
  const context = await buildContext(q);

  // aucune clé du tout → réponse immédiate (pas d'appel réseau qui traînerait
  // en longueur) ; seul l'admin voit la raison, jamais les autres comptes.
  if (noKeyConfigured()) {
    runtime.lastError = 'Aucune clé IA configurée.';
    const answer = fallbackAnswer(context, { isAdmin });
    const source = isAdmin ? 'local (aucune clé IA configurée — visible admin uniquement)' : 'local';
    const entry = { question: q, answer, source, at: new Date().toISOString() };
    pruneHistory();
    runtime.history = [entry, ...runtime.history].slice(0, MAX_HISTORY);
    runtime.lastAskedAt = Date.now();
    return entry;
  }

  let answer;
  let source;
const system = [
    'Tu t\'appelles Bak Sossou IA, l\'assistant du bot de prédiction Baccarat « Ombre », créé par Kouamé Appolinaire. Si on te demande qui tu es ou comment tu t\'appelles, présente-toi ainsi (« Je suis Bak Sossou IA, l\'assistant de Kouamé Appolinaire ») ; sinon, ne le répète pas à chaque message, ce n\'est utile que quand on te le demande.',
    'Tu discutes avec des utilisateurs humains : reste toujours poli, chaleureux et naturel, comme dans une vraie conversation, jamais robotique.',
    'Tu dois pouvoir répondre à TOUT ce qui concerne le bot : salutations, échanges normaux, questions sur une prédiction précise, sur les réglages ou canaux d\'une stratégie, sur le bilan et le pourcentage de réussite de chaque stratégie (y compris la stratégie IA « Prédit »), et donner ton avis motivé sur quelle stratégie privilégier.',
    'Le champ avisEtConseils contient l\'analyse déjà calculée par le module conseiller (verdict, conseils de réglages, meilleure et pire stratégie du jour) : appuie-toi dessus pour répondre à des questions comme « quelle stratégie préfères-tu et pourquoi », en citant le bilan et le pourcentage réel qui justifient ton avis. Le champ predictionIA donne le bilan de la stratégie IA « Prédit » pour la comparer aux autres.',
    'Quand on te demande un conseil de réglage (ex. le nombre de pertes avant d\'envoyer la prédiction suivante, ou le meilleur déclencheur), utilise les conseils déjà présents dans avisEtConseils et les réglages actuels (reglagesActuels) pour formuler une recommandation concrète et chiffrée, comme le ferait un expert qui connaît les statistiques du bot.',
    'Base-toi UNIQUEMENT sur les données JSON fournies pour tout ce qui concerne le bot. Si l\'information demandée n\'y figure pas, dis-le clairement au lieu d\'inventer un chiffre, un canal ou un résultat.',
    'Pour une simple salutation ou une question générale sans rapport avec les données, réponds normalement et naturellement, sans mentionner l\'absence de données.',
    'Le champ "reason" d\'une prédiction est la raison réelle déjà calculée par le bot : reformule-la clairement plutôt que de la réinventer.',
    'FORMAT DE RÉPONSE STRICT : texte brut uniquement, en phrases complètes qui s\'enchaînent naturellement (comme à l\'oral), en français. INTERDIT : markdown, astérisques, dièses, puces, tirets de liste, numérotation de type "1)", ou tout symbole de mise en forme — même pour énumérer plusieurs éléments, relie-les par des mots de liaison (« ensuite », « par ailleurs », « de plus »). N\'affiche jamais de raisonnement intermédiaire ni de balises — donne directement la réponse finale, claire, précise et bien polie.',
  ].join(' ');
  try {
    const raw = await ai.chat({
      system,
      user: { question: q, donnees: context },
      temperature: 0.1,
      timeoutMs: 20000,
    });
    answer = cleanAnswer(raw);
    if (!answer) throw new Error('Réponse vide de l’IA.');
    source = `IA — ${ai.chatRoute() || 'pollinations'}`;
    runtime.lastError = null;
  } catch (e) {
    runtime.lastError = e.message;
    // repli sur les données brutes plutôt que de laisser la question sans
    // réponse — la mention de l'erreur technique (clé, quota, réseau…) ne
    // doit jamais s'afficher pour un utilisateur normal, seul l'admin la voit.
    answer = fallbackAnswer(context, { isAdmin });
    source = isAdmin ? 'local (secours après erreur IA : ' + e.message + ')' : 'local';
  }

  const entry = { question: q, answer, source, at: new Date().toISOString() };
  pruneHistory();
  runtime.history = [entry, ...runtime.history].slice(0, MAX_HISTORY);
  runtime.lastAskedAt = Date.now();
  return entry;
}

function history() {
  pruneHistory();
  return runtime.history;
}

module.exports = { ask, history, extractGameNumbers, buildContext, noKeyConfigured };
