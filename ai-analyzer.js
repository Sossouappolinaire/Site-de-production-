// ai-analyzer.js — analyseur Baccarat
//  1) moteur LOCAL : il analyse lui-même les jeux en temps réel (aucune clé requise)
//  2) enrichissement Pollinations.ai (clé fournie par l'environnement)
'use strict';

const config = require('./config');
const miner = require('./pattern-miner');

const MAX_GAMES = 120;
const SUITS = ['♦️', '❤️', '♣️', '♠️'];
// Libellés de position pour décrire une main avec précision : l'index 0 du
// tableau playerSuits/bankerSuits est la 1ère carte reçue, l'index 1 la 2e,
// l'index 2 la 3e (main à 3 cartes). Exemple : ❤️♦️♣️ → ❤️ = 1ère position,
// ♦️ = 2e position, ♣️ = 3e position.
const POSITION_LABELS = ['1ère position', '2e position', '3e position'];

// Décrit une main (tableau de costumes) en rattachant explicitement chaque
// costume à sa position, ex. "❤️ (1ère position), ♦️ (2e position)".
function describeHandPositions(suits = []) {
  return (suits || [])
    .map((s, i) => `${s} (${POSITION_LABELS[i] || `${i + 1}e position`})`)
    .join(', ');
}

// clé utilisable à chaud (page Analyseur IA) sinon variable d'environnement
let runtimeKey = '';
function setApiKey(key) { runtimeKey = String(key || '').trim(); return apiKey(); }
function apiKey() { return runtimeKey || config.POLLINATIONS.API_KEY || ''; }
function keyLooksValid() {
  const k = apiKey();
  return !!k && k !== 'POLLINATIONS_KEY_A_REMPLACER';
}

// clés Gemini / Groq utilisables à chaud (page Analyseur IA), sinon variable
// d'environnement (GEMINI_API_KEY / GROQ_API_KEY) — même principe que la clé
// Pollinations ci-dessus. La persistance en base (pour survivre à un
// redémarrage) est gérée par l'appelant (voir server.js + bot.js/applyDbConfigs).
let runtimeGeminiKey = '';
let runtimeGroqKey = '';
let runtimeOpenrouterKey = '';
function setGeminiKey(key) { runtimeGeminiKey = String(key || '').trim(); return geminiKey(); }
function setGroqKey(key) { runtimeGroqKey = String(key || '').trim(); return groqKey(); }
function setOpenrouterKey(key) { runtimeOpenrouterKey = String(key || '').trim(); return openrouterKey(); }
function geminiKey() { return runtimeGeminiKey || (config.GEMINI && config.GEMINI.API_KEY) || ''; }
function groqKey() { return runtimeGroqKey || (config.GROQ && config.GROQ.API_KEY) || ''; }
function openrouterKey() { return runtimeOpenrouterKey || (config.OPENROUTER && config.OPENROUTER.API_KEY) || ''; }
function geminiConfigured() { return !!geminiKey(); }
function groqConfigured() { return !!groqKey(); }
function openrouterConfigured() { return !!openrouterKey(); }

// ---------------------------------------------------------------------------
// Vérification du QUOTA d'une clé au moment où l'admin l'applique depuis la
// page Analyseur IA : un appel réel minimal (1 seul jeton de sortie) est fait
// au fournisseur concerné pour confirmer que la clé est valide ET que le
// quota/crédit n'est pas déjà épuisé, plutôt que d'attendre la prochaine
// vraie question pour le découvrir. Le résultat est renvoyé tel quel dans le
// message affiché après le clic sur « Appliquer la clé ».
// ---------------------------------------------------------------------------
async function testProviderKey(label, attempt) {
  if (!attempt.key) {
    return { ok: false, quota: false, message: `Aucune clé ${label} renseignée — ce fournisseur restera inactif.` };
  }
  try {
    await callChat(attempt, {
      system: 'Réponds uniquement par le mot ok.',
      user: 'ok',
      temperature: 0,
      timeoutMs: 12000,
    });
    return { ok: true, quota: true, message: `Clé ${label} valide : le quota existe bien sur cette clé, elle sera utilisée pour les réponses IA.` };
  } catch (e) {
    const status = e.status;
    if (status === 401 || status === 403) {
      return { ok: false, quota: false, message: `Clé ${label} refusée (identifiants invalides, code ${status}) — elle ne sera pas utilisée.` };
    }
    if (status === 429) {
      return { ok: false, quota: false, message: `Clé ${label} reconnue mais quota/débit déjà épuisé pour l'instant (code 429) — un repli automatique sera utilisé en attendant.` };
    }
    if (status === 402) {
      return { ok: false, quota: false, message: `Clé ${label} reconnue mais solde/crédit épuisé (code 402) — un repli automatique sera utilisé en attendant.` };
    }
    return { ok: false, quota: false, message: `Clé ${label} enregistrée, mais impossible de confirmer son quota pour le moment (${e.message}) — le bot réessaiera au prochain usage.` };
  }
}

async function checkGeminiQuota() {
  return testProviderKey('Gemini', { url: config.GEMINI.CHAT_URL, key: geminiKey(), model: config.GEMINI.MODEL });
}
async function checkGroqQuota() {
  return testProviderKey('Groq', { url: config.GROQ.CHAT_URL, key: groqKey(), model: config.GROQ.MODEL });
}
async function checkOpenrouterQuota() {
  return testProviderKey('OpenRouter', { url: config.OPENROUTER.CHAT_URL, key: openrouterKey(), model: config.OPENROUTER.MODEL });
}
async function checkPollinationsQuota() {
  return testProviderKey('Pollinations.ai', { url: config.POLLINATIONS.CHAT_URL, key: apiKey(), model: config.POLLINATIONS.MODEL });
}


// ---------------------------------------------------------------------------
// Appel chat mutualisé, avec REPLIS automatiques.
// Le compte Pollinations payant peut renvoyer « Insufficient balance » (solde
// à 0) : dans ce cas on bascule automatiquement sur le point d'accès public
// gratuit text.pollinations.ai (avec puis sans clé) au lieu de tomber en
// panne d'IA.
// ---------------------------------------------------------------------------
const FREE_CHAT_URL = 'https://text.pollinations.ai/openai';

function chatAttempts() {
  const key = apiKey();
  const model = config.POLLINATIONS.MODEL || 'openai';
  const list = [];

  // OpenRouter est le service PAR DÉFAUT : essayé en tout premier. Puis
  // Gemini et Groq (avant Pollinations) : deux services avec clé, nettement
  // plus fiables/rapides que le repli gratuit sans clé. Si l'un échoue ou
  // expire (timeout), chat() passe automatiquement à l'entrée suivante de
  // cette liste — donc au fournisseur suivant.
  // Un fournisseur sans clé configurée est simplement absent de la liste.
  if (config.OPENROUTER && openrouterKey()) {
    list.push({ url: config.OPENROUTER.CHAT_URL, key: openrouterKey(), model: config.OPENROUTER.MODEL, label: 'OpenRouter' });
  }
  if (config.GEMINI && geminiKey()) {
    list.push({ url: config.GEMINI.CHAT_URL, key: geminiKey(), model: config.GEMINI.MODEL, label: 'Google Gemini' });
  }
  if (config.GROQ && groqKey()) {
    list.push({ url: config.GROQ.CHAT_URL, key: groqKey(), model: config.GROQ.MODEL, label: 'Groq' });
  }

  if (keyLooksValid()) {
    list.push({ url: config.POLLINATIONS.CHAT_URL, key, model, label: 'Pollinations (clé)' });
    list.push({ url: FREE_CHAT_URL, key, model, label: 'Pollinations texte (clé)' });
  }
  // Fournisseur de secours compatible OpenAI (Groq, OpenRouter, OpenAI…) :
  // renseigner AI_FALLBACK_URL + AI_FALLBACK_KEY (+ AI_FALLBACK_MODEL).
  const fbUrl = process.env.AI_FALLBACK_URL;
  const fbKey = process.env.AI_FALLBACK_KEY;
  if (fbUrl && fbKey) {
    list.push({
      url: fbUrl,
      key: fbKey,
      model: process.env.AI_FALLBACK_MODEL || 'gpt-4o-mini',
      label: 'fournisseur de secours',
    });
  }
  for (const free of ['openai', 'openai-fast', 'mistral', 'llamascout']) {
    list.push({ url: FREE_CHAT_URL, key: '', model: free, label: `service gratuit (${free})` });
  }
  return list;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callChat(attempt, { system, user, temperature, timeoutMs }) {
  const headers = { 'content-type': 'application/json' };
  if (attempt.key) headers.authorization = `Bearer ${attempt.key}`;
  const response = await fetch(attempt.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: attempt.model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = body?.error?.message || (typeof body?.error === 'string' ? body.error : '') || `réponse ${response.status}`;
    const err = new Error(msg);
    err.status = response.status;
    throw err;
  }
  const text = (body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || '').trim();
  // CORRECTIF : les modèles « raisonneurs » (DeepSeek R1 et dérivés, y compris
  // certains modèles gratuits OpenRouter) placent parfois leur raisonnement
  // interne DANS le champ content, encadré par <think>...</think>, avant la
  // vraie réponse — voire SANS aucune réponse après (tout le budget de
  // tokens consommé par le raisonnement). On retire ce bloc avant d'utiliser
  // le texte ; s'il ne reste plus rien, on considère la réponse comme vide
  // (le repli automatique passera au fournisseur suivant).
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!cleaned) throw new Error('réponse vide');
  return cleaned;
}

// Le service gratuit limite le débit (402/429 quand plusieurs requêtes
// s'enchaînent) : on réessaie brièvement avant de passer au repli suivant.
// CORRECTIF (page /ai qui « ne répond pas ou plante ») : avec un timeout de
// 45s ET jusqu'à 3 tentatives par fournisseur, la chaîne complète de repli
// (OpenRouter → Gemini → Groq → Pollinations → secours → 4 modèles gratuits)
// pouvait dépasser plusieurs MINUTES dans le pire cas — largement plus que le
// délai que tolère un proxy (Render coupe autour de 100s) ou qu'un utilisateur
// devant un écran figé sans aucun message. On réduit donc le timeout par
// tentative et le nombre de tentatives : moins de temps perdu sur un
// fournisseur en panne, plus vite au fournisseur suivant de la liste.
// Budget global : quel que soit le nombre de fournisseurs dans la liste de
// repli, on n'essaie plus d'en démarrer un nouveau au-delà de 50s écoulées —
// mieux vaut répondre avec une erreur claire que de laisser la page tourner
// indéfiniment (et se faire couper sans explication par le proxy).
const CHAT_BUDGET_MS = 50000;

async function chat({ system, user, temperature = 0.2, timeoutMs = 20000 } = {}) {
  const errors = [];
  const startedAt = Date.now();
  for (const attempt of chatAttempts()) {
    if (Date.now() - startedAt > CHAT_BUDGET_MS) {
      errors.push(`${attempt.label} : non tenté (budget de 50s dépassé)`);
      continue;
    }
    for (let tryNo = 0; tryNo < 2; tryNo += 1) {
      try {
        const text = await callChat(attempt, { system, user, temperature, timeoutMs });
        lastChatRoute = attempt.label;
        return text;
      } catch (e) {
        const retriable = e.status === 402 || e.status === 429 || e.status >= 500;
        const wait = e.status === 429 ? 3000 : 1500;
        if (retriable && tryNo < 1) { await sleep(wait); continue; }
        errors.push(`${attempt.label} : ${e.message}`);
        break;
      }
    }
  }
  const soldeVide = errors.some((m) => /budget|balance|402/i.test(m));
  const error = new Error(
    (soldeVide
      ? "Le compte Pollinations n'a plus de crédit (solde à 0) et les services gratuits sont saturés. Rechargez le compte sur enter.pollinations.ai, ou renseignez un fournisseur de secours (AI_FALLBACK_URL, AI_FALLBACK_KEY, AI_FALLBACK_MODEL). "
      : '') + `Détail : ${errors.join(' | ')}`
  );
  error.code = 'AI_REQUEST_FAILED';
  throw error;
}

let lastChatRoute = null;
function chatRoute() { return lastChatRoute; }

function compactGame(game) {
  return {
    n: game.number,
    player: game.player || game.player_cards || [],
    banker: game.banker || game.banker_cards || [],
    playerSuits: game.playerSuits || game.player_suits || [],
    bankerSuits: game.bankerSuits || game.banker_suits || [],
    playerSuitsPositions: describeHandPositions(game.playerSuits || game.player_suits || []),
    bankerSuitsPositions: describeHandPositions(game.bankerSuits || game.banker_suits || []),
    playerValue: game.playerValue ?? game.player_value ?? null,
    bankerValue: game.bankerValue ?? game.banker_value ?? null,
    winner: game.winner || null,
    finished: game.finished !== false,
  };
}

function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try { return JSON.parse(candidate); } catch (_) {}
  const object = candidate.match(/\{[\s\S]*\}/);
  if (!object) return null;
  try { return JSON.parse(object[0]); } catch (_) { return null; }
}

function localSummary(games) {
  const counts = Object.fromEntries(SUITS.map((s) => [s, 0]));
  const recent = games.slice(0, 30);
  for (const game of games) {
    for (const suit of [...(game.playerSuits || []), ...(game.bankerSuits || [])]) {
      if (counts[suit] !== undefined) counts[suit] += 1;
    }
  }
  return {
    games: games.length,
    recentGames: recent.length,
    suitCounts: counts,
    playerWins: games.filter((g) => g.winner === 'Joueur').length,
    bankerWins: games.filter((g) => g.winner === 'Banquier').length,
    ties: games.filter((g) => g.winner === 'Égalité').length,
  };
}

// ---------------------------------------------------------------------------
// MOTEUR LOCAL : l'analyseur fait les analyses lui-même, en temps réel.
// Il regarde la main du JOUEUR (base de vérification) et signale :
//  • absences de costume, séries, dominance, parité des points, cadence.
// Quand un signal est net et suffisamment échantillonné, il rédige une
// stratégie testable, prête à être enregistrée dans « Stratégies IA ».
// ---------------------------------------------------------------------------
function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : 0; }

function localAnalysis(rawGames = [], options = {}) {
  const cap = Number(options.maxGames) > 0 ? Number(options.maxGames) : MAX_GAMES;
  const games = rawGames.map(compactGame).filter((g) => g.n != null).slice(0, cap);
  const summary = localSummary(games);
  const findings = [];
  const proposals = [];
  if (games.length < 6) {
    return {
      source: 'local',
      title: 'Analyse en attente de données',
      confidence: 'exploratoire',
      observation: `Seulement ${games.length} jeu(x) disponibles : il en faut au moins 6 pour observer un signal.`,
      findings, strategies: proposals, nextChecks: ['Laisser tourner le flux quelques minutes.'],
      localSummary: summary, sample: games.length, generatedAt: new Date().toISOString(),
    };
  }

  const playerHas = (g, s) => (g.playerSuits || []).includes(s);

  // Taux de retour réel : parmi toutes les fois, dans l'historique, où le
  // costume vient d'enchaîner `threshold` absences consécutives, quelle
  // fraction le voit effectivement revenir dans les `lead` jeux suivants ?
  // (à distinguer de la fréquence de présence globale du costume, qui ne
  // mesure pas du tout la même chose — cf. bug rate trompeur.)
  function returnRate(suit, threshold, lead) {
    const chron = games.slice().reverse(); // du plus ancien au plus récent
    let streak = 0;
    let trials = 0;
    let hits = 0;
    for (let i = 0; i < chron.length; i += 1) {
      if (playerHas(chron[i], suit)) { streak = 0; continue; }
      streak += 1;
      if (streak === threshold) {
        trials += 1;
        for (let k = i + 1; k <= i + lead && k < chron.length; k += 1) {
          if (playerHas(chron[k], suit)) { hits += 1; break; }
        }
      }
    }
    return { trials, hits, rate: pct(hits, trials) };
  }

  // 1) absence de costume dans la main du joueur
  const returnLead = 2;
  for (const suit of SUITS) {
    let absence = 0;
    for (const g of games) { if (playerHas(g, suit)) break; absence += 1; }
    const seen = games.filter((g) => playerHas(g, suit)).length;
    if (absence >= 4) {
      findings.push(`${suit} absent de la main du joueur depuis ${absence} jeux (présence globale ${pct(seen, games.length)}%).`);
      if (absence >= 5 && games.length >= 20) {
        const rr = returnRate(suit, 4, returnLead);
        // Sous 5 essais historiques, le taux n'est pas fiable : on publie le
        // constat dans les findings mais on ne fabrique pas de proposition
        // chiffrée dessus plutôt que d'afficher un pourcentage trompeur.
        if (rr.trials >= 5) {
          proposals.push({
            name: `Retour du costume ${suit} après ${absence} absences`,
            logic: `Quand ${suit} est absent de la main du joueur pendant ${absence} jeux consécutifs, viser son retour dans les ${returnLead} jeux suivants.`,
            trigger: `${absence} jeux sans ${suit} côté joueur`,
            target: `jeu suivant (fenêtre de ${returnLead} jeux), avec rattrapages`,
            suggestedLead: returnLead,
            minimumSample: 20,
            rate: rr.rate,
            support: rr.trials,
            evidence: `Sur ${rr.trials} séries historiques d'au moins 4 absences consécutives de ${suit}, il est revenu dans les ${returnLead} jeux suivants ${rr.hits} fois (${rr.rate}%). Présence globale du costume : ${pct(seen, games.length)}%.`,
            risks: "Une absence longue ne garantit aucun retour : le tirage reste indépendant. À tester en mode silencieux.",
            compatibleExisting: 'absente',
          });
        }
      }
    }
  }

  // 1bis) dominance d'un costume à une position précise de la main joueur
  // (ex : ♦️ domine spécifiquement la 2e position, pas la main en général).
  // C'est ce que l'utilisateur appelle « position 2 » vs « position 3 ».
  const posRecent = games.slice(0, Math.min(30, games.length));
  for (let posIdx = 0; posIdx < 3; posIdx += 1) {
    const label = POSITION_LABELS[posIdx];
    const atPos = posRecent.filter((g) => (g.playerSuits || [])[posIdx]);
    if (atPos.length < 15) continue; // pas assez de mains à 3 cartes observées
    const counts = Object.fromEntries(SUITS.map((s) => [s, atPos.filter((g) => g.playerSuits[posIdx] === s).length]));
    const top = SUITS.slice().sort((a, b) => counts[b] - counts[a])[0];
    const topRate = pct(counts[top], atPos.length);
    if (topRate >= 55) {
      findings.push(`En ${label} de la main du joueur, ${top} domine : ${topRate}% des ${atPos.length} mains à 3 cartes récentes (ex. main ${describeHandPositions(atPos[0].playerSuits)}).`);
      if (atPos.length >= 20) {
        proposals.push({
          name: `Dominance de ${top} en ${label}`,
          logic: `Tant que ${top} reste au-dessus de 55% en ${label} du joueur sur les mains à 3 cartes récentes, jouer ${top} pour cette position.`,
          trigger: `${top} vu dans ${topRate}% des mains à 3 cartes en ${label}`,
          target: `prochaine main à 3 cartes, ${label}`,
          suggestedLead: 2,
          minimumSample: 20,
          rate: topRate,
          support: atPos.length,
          evidence: `${counts[top]} occurrences de ${top} en ${label} sur ${atPos.length} mains à 3 cartes observées.`,
          risks: 'Le tirage reste indépendant : une dominance de position peut disparaître sans préavis. À tester en mode silencieux.',
          compatibleExisting: 'costume',
          position: posIdx + 1,
        });
      }
    }
  }

  // 2) dominance d'un costume sur la fenêtre récente
  const recent = games.slice(0, Math.min(30, games.length));
  const recentCounts = Object.fromEntries(SUITS.map((s) => [s, recent.filter((g) => playerHas(g, s)).length]));
  const top = SUITS.slice().sort((a, b) => recentCounts[b] - recentCounts[a])[0];
  const topRate = pct(recentCounts[top], recent.length);
  if (topRate >= 60) {
    findings.push(`${top} domine la main du joueur : ${topRate}% des ${recent.length} derniers jeux.`);
    if (recent.length >= 20) {
      proposals.push({
        name: `Suivi du costume dominant ${top}`,
        logic: `Tant que ${top} reste au-dessus de 60% de présence sur 30 jeux, jouer ${top} côté joueur.`,
        trigger: `${top} présent dans ${topRate}% des mains récentes`,
        target: 'prochain jeu tant que la dominance tient',
        suggestedLead: 2,
        minimumSample: 30,
        rate: topRate,
        support: recent.length,
        evidence: `${recentCounts[top]} présences sur ${recent.length} jeux récents.`,
        risks: 'Une dominance peut se retourner brutalement ; couper dès que la présence repasse sous 50%.',
        compatibleExisting: 'dominant',
      });
    }
  }

  // 3) séries joueur / banquier
  let streak = 1;
  for (let i = 1; i < games.length; i += 1) {
    if (games[i].winner && games[i].winner === games[0].winner) streak += 1; else break;
  }
  if (games[0].winner && streak >= 4) {
    findings.push(`Série en cours : ${streak} victoires « ${games[0].winner} » d'affilée.`);
  }

  // 4) parité des points du joueur
  const values = games.map((g) => g.playerValue).filter((v) => v != null);
  if (values.length >= 10) {
    const even = values.filter((v) => v % 2 === 0).length;
    const rate = pct(even, values.length);
    if (rate >= 65 || rate <= 35) {
      findings.push(`Points du joueur déséquilibrés : ${rate}% de valeurs paires sur ${values.length} jeux.`);
      proposals.push({
        name: `Parité ${rate >= 65 ? 'paire' : 'impaire'} des points joueur`,
        logic: `Suivre la parité ${rate >= 65 ? 'paire' : 'impaire'} des points du joueur tant que le déséquilibre dépasse 65/35.`,
        trigger: `${rate}% de points pairs sur ${values.length} jeux`,
        target: 'prochain jeu',
        suggestedLead: 1,
        minimumSample: 30,
        rate: rate >= 65 ? rate : 100 - rate,
        support: values.length,
        evidence: `${even} points pairs sur ${values.length} relevés.`,
        risks: 'Déséquilibre possiblement dû au hasard : vérifier sur un second échantillon avant publication.',
        compatibleExisting: 'parite',
      });
    }
  }

  // 5) égalités
  if (summary.ties && pct(summary.ties, games.length) >= 12) {
    findings.push(`Taux d'égalités élevé : ${pct(summary.ties, games.length)}% des jeux analysés.`);
  }

  // ---------------------------------------------------------------------
  // DÉCOUVERTE : l'analyseur cherche des régularités qu'aucune stratégie
  // existante ne décrit (carte précise -> costume futur, points, chaînes,
  // séquences de vainqueurs, répétition d'une journée déjà jouée).
  // ---------------------------------------------------------------------
  const mined = miner.mine(rawGames, {
    lead: options.lead || 2,
    pastDays: options.pastDays || [],
    todayGames: options.todayGames || rawGames,
  });
  for (const f of mined.findings) findings.push(f);
  for (const p of mined.proposals) proposals.push(p);
  for (const r of mined.replacements) {
    findings.push(r.text);
    proposals.push({
      name: `Remplacer ${r.from} par ${r.to} (jeu a+${r.lead})`,
      logic: `Quand le déclencheur ${r.from} est vu côté joueur, prédire ${r.to} au lieu de ${r.from} sur le jeu a+${r.lead}.`,
      trigger: `${r.from} vu dans la main du joueur`,
      target: `jeu a+${r.lead}`,
      suggestedLead: r.lead,
      minimumSample: 25,
      rate: r.rate,
      support: r.support,
      evidence: `${r.rate}% pour ${r.to} contre ${r.currentRate}% pour ${r.from} sur ${r.support} observations.`,
      risks: "Remplacement à tester en mode silencieux avant de modifier une stratégie publiée.",
      compatibleExisting: 'costume',
    });
  }

  const confidence = proposals.length ? (games.length >= 40 ? 'moyenne' : 'faible') : 'exploratoire';
  return {
    source: 'local',
    discoveries: mined.discoveries || [],
    replacements: mined.replacements || [],
    dayMatches: mined.dayMatches || [],
    title: findings.length ? findings[0] : 'Aucun signal marquant pour l’instant',
    confidence,
    observation: findings.length
      ? `L’analyseur a relevé ${findings.length} signal(aux) sur ${games.length} jeux : ${findings.join(' ')}`
      : `Rien de significatif sur les ${games.length} derniers jeux : fréquences proches de l’équilibre.`,
    findings,
    strategies: proposals,
    nextChecks: [
      'Confirmer chaque signal sur les 20 prochains jeux',
      'Tester la règle en mode silencieux avant publication',
    ],
    localSummary: summary,
    sample: games.length,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Enrichissement Pollinations.ai
// ---------------------------------------------------------------------------
async function analyze({ games = [], date = null, objective = '', pastDays = [] } = {}) {
  // Aucune clé requise : à défaut, l'appel passe par le service public gratuit.

  const normalized = games.map(compactGame).filter((game) => game.n != null).slice(0, MAX_GAMES);
  if (normalized.length < 6) {
    const error = new Error('Il faut au moins 6 jeux terminés pour produire une analyse utile.');
    error.code = 'NOT_ENOUGH_DATA';
    throw error;
  }

  const summary = localSummary(normalized);
  const local = localAnalysis(games, { pastDays });
  const system = [
    'Tu es un analyste prudent de données Baccarat.',
    'Tu dois analyser uniquement les observations fournies et ne jamais promettre une prédiction fiable ou certaine.',
    'Les cartes de la main joueur sont la seule base de vérification des stratégies; la main banquier sert aux comparaisons et au contexte.',
    'Ne te limite JAMAIS aux stratégies déjà existantes : cherche de NOUVELLES régularités.',
    "Précision obligatoire : chaque fois que tu mentionnes un costume dans 'logic', 'trigger', 'evidence' ou 'observation', indique aussi sa position exacte dans la main (1ère, 2e ou 3e position), jamais juste « le costume est présent ». " +
    "Exemple : pour une main ❤️♦️♣️, dis « ❤️ en 1ère position, ♦️ en 2e position, ♣️ en 3e position », pas seulement « ❤️♦️♣️ présents ». " +
    "Le champ playerSuitsPositions/bankerSuitsPositions de chaque jeu te donne déjà cette description position par position : réutilise-la.",
    'Exemples de ce que tu dois chercher : « quand le joueur ou le banquier a eu 6❤️ au jeu a, ♣️ arrive au jeu a+2 », « la partie du 20/08/2026 se rejoue aujourd\'hui », « telle séquence de vainqueurs annonce le suivant », « il faut remplacer le costume prédit par un autre quand le déclencheur est vu ».',
    'Cherche des fréquences, séries, absences, distributions, décalages (a+1, a+2, a+3), répétitions de journées et signaux de sur-ajustement.',
    'Une stratégie proposée doit être testable, réversible, limitée à un échantillon minimum et accompagnée de ses risques.',
    'Réponds uniquement avec un JSON valide, sans Markdown.',
  ].join(' ');
  const user = {
    demande: objective || 'Identifier les signaux observables et proposer des stratégies testables pour les prochains jeux.',
    dateAnalysee: date || 'historique disponible',
    resumeLocal: summary,
    signauxDetectesLocalement: local.findings,
    reglesDecouvertesLocalement: local.discoveries || [],
    remplacementsDeCostumeConseilles: local.replacements || [],
    journeesSimilaires: local.dayMatches || [],
    jeux: normalized,
    formatReponse: {
      title: 'titre court',
      confidence: 'faible|moyenne|exploratoire',
      observation: 'résumé factuel',
      strategies: [{
        name: 'nom',
        logic: 'règle testable en une phrase, position du costume précisée (1ère/2e/3e)',
        trigger: 'déclencheur, avec la position exacte du costume dans la main',
        target: 'tour ou condition ciblée',
        position: '1ère position|2e position|3e position|null (si la règle ne porte pas sur une position précise)',
        suggestedLead: 1,
        minimumSample: 20,
        evidence: 'ce que les données montrent, position du costume incluse',
        risks: 'risques et limites',
        compatibleExisting: 'costume|dominant|matchnul|parite|absente|ombre|null',
      }],
      replacements: [{ from: '♦️', to: '♣️', lead: 2, text: "d'après mes analyses, remplace ♦️ par ♣️ quand le déclencheur est vu" }],
      nextChecks: ['contrôles à faire sur les prochains jeux'],
    },
  };

  const text = await chat({ system, user, temperature: 0.2, timeoutMs: 45000 });
  const result = extractJson(text);
  if (!result) {
    const error = new Error('La réponse de l’IA n’est pas un JSON exploitable.');
    error.code = 'AI_INVALID_RESPONSE';
    throw error;
  }
  return {
    ...result,
    source: `IA — ${chatRoute() || 'pollinations'}`,
    findings: Array.isArray(result.findings) && result.findings.length ? result.findings : local.findings,
    discoveries: local.discoveries || [],
    replacements: Array.isArray(result.replacements) && result.replacements.length ? result.replacements : local.replacements || [],
    dayMatches: local.dayMatches || [],
    generatedAt: new Date().toISOString(),
    sample: normalized.length,
    localSummary: summary,
  };
}

async function listModels() {
  const res = await fetch(config.POLLINATIONS.MODELS_URL, {
    headers: keyLooksValid() ? { authorization: `Bearer ${apiKey()}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  return (body.data || []).map((m) => m.id);
}

module.exports = {
  analyze, localAnalysis, compactGame, localSummary, listModels, chat, chatRoute,
  setApiKey, apiKey, keyLooksValid, MAX_GAMES,
  setGeminiKey, setGroqKey, geminiKey, groqKey, geminiConfigured, groqConfigured,
  setOpenrouterKey, openrouterKey, openrouterConfigured,
  checkGeminiQuota, checkGroqQuota, checkOpenrouterQuota, checkPollinationsQuota,
};
