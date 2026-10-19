// server.js — tableau de bord web (Render) + API JSON. Protégé par identifiant/mot de passe.

// CORRECTIF « redémarrages en boucle sans explication » (demande admin) :
// sans ces gestionnaires, la moindre erreur non interceptée QUELQUE PART
// dans le code (promesse oubliée sans .catch, appel Telegram en échec, etc.)
// tuait instantanément tout le process Node — Render le relançait aussitôt,
// sans qu'aucune trace de la vraie cause n'apparaisse dans les logs. C'est
// ce qui produisait les doublons de prédictions (rupture, après une perte...)
// à chaque redémarrage. On loggue désormais l'erreur complète AVANT de
// quitter, pour pouvoir enfin identifier et corriger la cause exacte.
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH] unhandledRejection —', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[CRASH] uncaughtException —', err && err.stack ? err.stack : err);
  // on laisse le process continuer plutôt que de le tuer : mieux vaut un
  // module en erreur ponctuelle qu'un redémarrage complet qui rejoue tout.
});

const path = require('path');
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const pgSessionStore = require('connect-pg-simple')(session);
const hybridStore = require('./session-store');
const store = require('./store'); // liste des canaux supprimés (ignoredChannels)
const { databaseUrl } = require('./database-url');
const config = require('./config');
const api = require('./api');
const db = require('./db');
const auth = require('./auth');
const fmt = require('./formats');
const strategies = require('./strategies');
const ai = require('./ai-analyzer');
const miner = require('./pattern-miner');
const aiAuto = require('./ai-auto');
const cumulative = require('./cumulative');
const advisor = require('./strategy-advisor');
const aiQa = require('./ai-qa');
const aiRepair = require('./ai-repair');
const formation = require('./formation');
const formationRelay = require('./formation-relay');
const predit = require('./predit');
const afterLoss = require('./after-loss');
const combined = require('./combined');
const suitStreak = require('./suit-streak');
const dizaineTop = require('./dizaine-top');
const bestWeakTop = require('./best-weak-top');
const lossReturn = require('./loss-return'); // « Retour après perte » (v47)
const lossRelaunch = require('./loss-relaunch'); // « Relance après perte » (v57)
const gameStability = require('./game-stability');
const costumeFaibleTop = require('./costume-faible-top');
const copyAnnounce = require('./copy-announce');
const betType = require('./bet-type');
const likeReact = require('./like-react');
const suitBreak = require('./suit-break');
const overlap = require('./overlap');
const statistics = require('./statistics');
const cardsCount = require('./cards-count');
const drawTwoThree = require('./draw-two-three');
const vip = require('./vip');
const dayCompare = require('./day-compare');
const deployGen = require('./deploy-generator');
const mirrorCounter = require('./mirror-counter');
const lossNotice = require('./loss-notice');
const game21 = require('./game21');
const game21Strategies = require('./game21-strategies');
const game21Predict = require('./game21-predict');
const predictionControl = require('./prediction-control');
const {
  state, stats, predictionMessage, recentGames, SUITS,
  setStrategyConfig, resetStrategy, initStrategies, parityRuntime,
  strategyGames, bilanText, gameCategories, gateView, shadowRuntime,
  predictionsPanel, strategyChannels, unlockGate, sweepAutoUnlock, dizaineCounterView,
  announcementsFor, siteChannelsView, addSiteChannel, removeSiteChannel, addSiteChannelMessage, siteChannelFeed,
} = require('./predictor');
const { startLoop, startBot, botStatus, disconnectBot, activate, deactivate, persist, sendBilan, flushBilans, dropSender, announceConfig, announceMainBot, resolveChat, testSend, saveConfigsToDb, applyDbConfigs, setMainChannel } = require('./bot');

const app = express();
app.set('trust proxy', 1); // Render est derrière un proxy HTTPS : nécessaire pour les cookies "secure"
app.use(express.json());

// ---------------------------------------------------------------------------
// Sessions stockées en base Postgres (table "user_sessions", créée toute
// seule au démarrage) — sans ça (store par défaut = mémoire du process),
// tout le monde est déconnecté à chaque redémarrage/redéploiement Render.
// ---------------------------------------------------------------------------
const SESSION_DB_URL = databaseUrl() || config.DATABASE_URL;
const sessionPool = new Pool({
  connectionString: SESSION_DB_URL,
  ssl: /localhost|127\.0\.0\.1/.test(SESSION_DB_URL) ? false : { rejectUnauthorized: false },
  max: 4,
});
sessionPool.on('error', (e) => console.error('Pool de sessions (pg) :', e.message));

app.use(session({
  // base de données quand elle répond, mémoire du process en repli : ainsi la
  // connexion de secours de l'administrateur marche même base éteinte.
  store: hybridStore(new pgSessionStore({
    pool: sessionPool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 60, // purge des sessions expirées toutes les heures
  })),
  name: 'baccara.sid',
  secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  rolling: true, // chaque requête prolonge la session de 12h glissantes
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!(process.env.RENDER || process.env.NODE_ENV === 'production'),
    maxAge: 12 * 60 * 60 * 1000, // 12h
  },
}));

// ---------------------------------------------------------------------------
// Authentification — identifiant admin fixe (« sossoukouam »), ou compte créé
// par email @gmail.com puis validé par l'administrateur (voir auth.js).
// ---------------------------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  const r = await auth.login(req.body.identifier, req.body.password);
  if (!r.ok) return res.status(401).json(r);
  req.session.userId = r.userId;
  req.session.identifier = r.identifier;
  req.session.role = r.role;
  res.json({ ok: true, identifier: r.identifier });
});

app.post('/api/auth/signup', async (req, res) => {
  const r = await auth.signup(req.body.email, req.body.password, req.body.confirmPassword);
  // Aucun code n'est envoyé : le compte attend la validation de l'admin.
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/auth/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    loggedIn: !!(req.session && req.session.userId),
    identifier: req.session ? req.session.identifier || null : null,
  });
});

// Diagnostic public (aucune donnée sensible) : URL/statut de la base masqués,
// nombre de comptes, et si le compte admin existe réellement — pour
// comprendre une connexion qui échoue sans devoir être déjà connecté.
app.get('/api/auth/debug', async (req, res) => {
  try {
    res.json(await auth.debugInfo());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// configuration (une seule fois) de la clé API Resend utilisée pour ENVOYER
// les codes de confirmation — réservée à l'administrateur.
app.get('/api/auth/mail-config', async (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: "Réservé à l'administrateur." });
  res.json(await auth.mailerStatus());
});
app.post('/api/auth/mail-config', async (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: "Réservé à l'administrateur." });
  const r = await auth.configureMailSender(req.body.apiKey, req.body.from);
  res.status(r.ok ? 200 : 400).json(r);
});

// ---------------------------------------------------------------------------
// Accès public (demande admin, 30/09/2026) : plus de mot de passe, plus de
// compte à créer — tout le monde qui arrive sur le site a exactement les
// mêmes droits que l'administrateur (lecture ET écriture partout). Le
// système de comptes (auth.js, /api/auth/*, panneau « Utilisateurs ») reste
// en place et fonctionnel si besoin de le réactiver un jour : il suffit de
// remettre l'ancien verrou (conservé juste au-dessus en commentaire dans
// l'historique du fichier) à la place du middleware ci-dessous.
// ---------------------------------------------------------------------------
const PUBLIC_EXACT = new Set(['/health', '/login.html', '/favicon.ico', '/intro.js']);
function isPublicPath(p) {
  if (PUBLIC_EXACT.has(p)) return true;
  if (p.startsWith('/api/auth/')) return true;
  return false;
}
app.use((req, res, next) => {
  if (req.session) {
    req.session.role = 'admin';
    if (!req.session.userId) req.session.userId = 'public';
    if (!req.session.identifier) req.session.identifier = 'Visiteur';
  }
  next();
});

// Identifiant de démarrage : change à chaque redémarrage / redéploiement. Injecté
// dans index.html et login.html (<meta name="boot-id">) pour que l'intro animée
// (public/intro.js) ne soit jouée qu'UNE fois après chaque redémarrage.
const BOOT_ID = String(Date.now());
app.get(['/', '/index.html', '/login.html'], (req, res, next) => {
  const file = path.join(__dirname, 'public', req.path === '/login.html' ? 'login.html' : 'index.html');
  require('fs').readFile(file, 'utf8', (err, html) => {
    if (err) return next();
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html.replace('content="__BOOT_ID__"', `content="${BOOT_ID}"`));
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Lecture seule pour les comptes « user » — seul l'administrateur peut
// modifier quoi que ce soit (stratégies, canaux, bot, base, formats…). Un
// compte utilisateur ne peut que consulter le tableau de bord et poser des
// questions à l'IA (Question IA, seule action autorisée).
// ---------------------------------------------------------------------------
const USER_WRITE_ALLOWLIST = new Set([
  '/api/ai/ask', // Question IA
]);
// écrire dans le fil d'un canal du site (n'importe quel compte connecté,
// pas seulement l'administrateur) : l'IA répond automatiquement — voir la
// route POST /api/canaux/:id/message plus bas.
const USER_WRITE_PATTERNS = [/^\/api\/canaux\/[^/]+\/message$/];
app.use((req, res, next) => {
  if (isPublicPath(req.path)) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (req.method === 'GET') return next();
  if (!req.session || req.session.role === 'admin') return next();
  if (USER_WRITE_ALLOWLIST.has(req.path)) return next();
  if (USER_WRITE_PATTERNS.some((re) => re.test(req.path))) return next();
  return res.status(403).json({
    error: "Accès en lecture seule — seul l'administrateur peut modifier la configuration.",
    readOnly: true,
  });
});

const appVersion = require('./version');
app.get('/health', (req, res) => res.send('ok'));
app.get('/api/version', (req, res) => res.json(appVersion));

// ---------------------------------------------------------------------------
// Panneau administrateur « Utilisateurs » — réservé à l'administrateur :
// liste des comptes, acceptation avec un temps d'accès (minutes/heures),
// blocage manuel, refus d'un compte en attente.
// ---------------------------------------------------------------------------
function requireAdmin(req, res) {
  if (!req.session || req.session.role !== 'admin') {
    res.status(403).json({ error: "Réservé à l'administrateur." });
    return false;
  }
  return true;
}
app.get('/api/users', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ users: await auth.listUsers() });
});
// --- Panneau admin « Déploiement » : génère un ZIP de bot autonome --------
app.get('/api/deploy/options', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(deployGen.listSelectable());
});
app.post('/api/deploy/generate', (req, res) => {
  if (!requireAdmin(req, res)) return;
  let built;
  try {
    built = deployGen.buildZipStream((req.body && req.body.selection) || []);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${built.slug}.zip"`);
  built.archive.on('error', (e) => { try { res.status(500).end(e.message); } catch (_) {} });
  built.archive.pipe(res);
});
app.post('/api/users/:id/approve', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const r = await auth.approveUser(req.params.id, req.body.minutes);
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/users/:id/block', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const r = await auth.blockUser(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/users/:id/reject', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const r = await auth.rejectUser(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

// « Chevauchement de prédictions » (voir overlap.js) — pour aider l'admin à
// retrouver une source par le NOM/ID du canal Telegram où elle publie déjà
// (ex. l'admin connaît le canal « bo » mais pas forcément la clé interne de
// la stratégie qui y envoie), on résout ici, pour chaque option disponible
// dans overlap.options(), le(s) canal(aux) Telegram où cette source publie
// ACTUELLEMENT — pour affichage uniquement dans le sélecteur du tableau de
// bord (ça ne change rien au fonctionnement du panneau lui-même).
async function overlapSourceChannelHints() {
  const hints = {};
  const bot = botStatus();
  async function addHint(key, ids) {
    if (!key || !Array.isArray(ids) || !ids.length) return;
    const names = [];
    for (const id of ids.slice(0, 3)) {
      if (bot.tokenSet) {
        const check = await resolveChat(id);
        names.push(check.ok ? (check.chat.title || String(id)) : String(id));
      } else {
        names.push(String(id));
      }
    }
    if (names.length) hints[key] = names;
  }
  // stratégies existantes : canal publié (celui du bouton « Envoyer »).
  for (const def of strategies.LIST) {
    await addHint(def.key, strategyChannels(def.key, 'published'));
  }
  // IA « Prédit » : canal propre du panneau.
  await addHint('ia', predit.panel.channels);
  // Formations : canal propre par stratégie, sinon canal par défaut du panneau.
  const frStatus = formationRelay.status();
  const frDefault = Array.isArray(frStatus.channels) ? frStatus.channels : [];
  for (const s of (frStatus.strategies || [])) {
    await addHint(`formation:${s.key}`, (Array.isArray(s.channels) && s.channels.length) ? s.channels : frDefault);
  }
  // panneaux « frères » (chaque tracker peut avoir son propre canal, sinon
  // celui du panneau) : après-perte, combinée, répétition, rupture.
  async function addPanelHints(mod, prefix) {
    const st = mod.status();
    const defaultChannels = Array.isArray(st.channels) ? st.channels : [];
    for (const t of (mod.panel.trackers || [])) {
      await addHint(`${prefix}:${t.id}`, (Array.isArray(t.channels) && t.channels.length) ? t.channels : defaultChannels);
    }
  }
  await addPanelHints(afterLoss, 'after');
  await addPanelHints(combined, 'combo');
  await addPanelHints(suitStreak, 'streak');
  await addPanelHints(suitBreak, 'break');
  return hints;
}

app.get('/api/state', async (req, res) => {
  const channelList = configuredChannelList(); // liste unique des canaux (tous les boutons), partagée par toutes les pages
  const aiCreatedKeys = new Set(aiRepair.status().createdStrategyKeys || []);
  res.json({
    appVersion,
    role: req.session ? req.session.role || null : null,
    b: state.B,
    maxR: state.maxR,
    hand: 'joueur',
    format: state.format,
    formatCount: fmt.FORMAT_COUNT,
    // 5 formats simples « Il y aura distribution 2/2 » (stratégie « 2/3 → distribution 2/2 ») : aperçus en attente / gagné au 1ᵉʳ rattrapage
    distFormats: [102, 103, 104, 105, 106].map((id) => ({ id, preview: fmt.formatPreview(id, { cardsLabel: '2/2', gameNumber: 1194, maxR: 3, status: null }), previewWin: fmt.formatPreview(id, { cardsLabel: '2/2', gameNumber: 1194, maxR: 3, status: 'gagné', rattrapage: 1 }) })),
    formats: fmt.formatList(1, fmt.FORMAT_COUNT).text,
    template: state.template || null,
    counters: state.counters,
    suits: SUITS,
    live: state.live,
    liveCategories: gameCategories(state.live),
    board: strategyGames('costume', 8),
    lastFinished: state.lastFinished,
    error: state.lastError,
    bot: botStatus(),
    db: db.status(),
    apiUrl: api.endpoints()[0],
    champId: config.CHAMP_ID,
    ai: {
      configured: ai.keyLooksValid(),
      model: config.POLLINATIONS.MODEL,
      openrouterConfigured: ai.openrouterConfigured(),
      openrouterModel: config.OPENROUTER.MODEL,
      geminiConfigured: ai.geminiConfigured(),
      geminiModel: config.GEMINI.MODEL,
      groqConfigured: ai.groqConfigured(),
      groqModel: config.GROQ.MODEL,
      // Statut RÉEL du quota (appel réseau déjà effectué, mis en cache — voir
      // ai.refreshQuotaStatus()) : `configured` ci-dessus ne dit que « une
      // clé est présente », alors que `quota` dit « la clé a été testée et
      // le quota/crédit existe (ou pas) ». null tant qu'aucun test n'a
      // encore eu lieu (juste après un démarrage, avant la 1ère vérification).
      quota: ai.getLastQuotaCheck(),
      auto: aiAuto.status(),
      lastAnalysis: state.aiAnalyses[0] || null,
      results: state.aiAnalyses.slice(0, 6),
      savedStrategies: state.aiStrategies,
    },
    channels: state.channels.map((c) => ({ ...c, active: state.activeChannels.includes(c.id) })),
    strategies: strategies.LIST.map((d) => ({
      key: d.key, name: d.name, about: d.about, usesB: !!d.usesB,
      config: state.strategies[d.key] || {}, stats: stats(d.key),
      aiCreated: aiCreatedKeys.has(d.key),
    })),
    // stratégies créées par l'IA mais dont le redémarrage automatique n'est
    // pas encore terminé — le fichier strategies.js est déjà à jour sur
    // disque, mais Node ne l'a pas encore rechargé. Affichées à part sur la
    // page « Créé par moi avec IA » avec un état « en attente ».
    pendingAiStrategies: [...aiCreatedKeys]
      .filter((key) => !strategies.BY_KEY[key])
      .map((key) => {
        const h = (aiRepair.status().createdStrategies || []).find((c) => c.key === key);
        return { key, name: h ? h.name : key, about: h ? h.about : '', at: h ? h.at : null };
      }),
    predit: predit.status(),
    afterLoss: afterLoss.status(),
    combined: combined.status(),
    suitStreak: suitStreak.status(),
    dizaineTop: dizaineTop.status(),
    bestWeakTop: bestWeakTop.status(),
    lossReturn: lossReturnView(),
    lossRelaunch: lossRelaunchView(),
    gameStability: gameStability.status(),
    costumeFaibleTop: costumeFaibleTop.status(),
    control: predictionControl.status(),
    suitBreak: suitBreak.status(),
    channelList,
    copyAnnounce: { ...copyAnnounce.status(), channels: channelList },
    betType: { ...betType.status(), allChannels: channelList },
    likeReact: { ...likeReact.status(), allChannels: channelList, bestChannels: channelList },
    overlap: { ...overlap.status(), channelHints: await overlapSourceChannelHints() },
    statistics: statistics.status(),
    cardsCount: cardsCount.status(),
    drawTwoThree: drawTwoThree.status(),
    vip: vip.status(),
    predictions: state.predictions.slice(0, 50).map((p) => ({
      strategy: p.strategy, strategyName: p.strategyName, label: p.label,
      target: p.target, suit: p.suit, hand: p.hand, step: p.step, maxR: p.maxR,
      status: p.status, badge: p.badge, reason: p.reason, text: predictionMessage(p),
    })),
    parity: parityRuntime(),
    panel: predictionsPanel(40),
    stats: stats(),
    uptime: Date.now() - state.startedAt,
    mail: await auth.mailerStatus(),
    mirrorCounter: {
      channelId: mirrorCounter.getChannel(),
      games: mirrorCounter.state.games,
    },
    lossNotice: lossNotice.getSettings(),
  });
});

app.get('/api/games', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 30);
  res.json({ live: state.live, games: recentGames(limit) });
});

// ---------------------------------------------------------------------------
// Jeu « 21 » (TwentyOne) de 1xbet — jeux en live + analyse des déclencheurs
// des cartes de valeur (A, K, Q, J) et des cartes de valeur exacte.
// ---------------------------------------------------------------------------
app.get('/api/game21', async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 30);
  const variant = req.query.variant && req.query.variant !== 'tous' ? String(req.query.variant) : null;
  if (req.query.refresh === '1' || !game21.state.updatedAt) await game21.refresh();
  res.json({ ...game21.snapshot({ limit, variant }), strategies: game21Strategies.status() });
});

app.post('/api/game21/refresh', async (req, res) => {
  await game21.refresh();
  res.json(game21.snapshot({ limit: 30 }));
});

app.post('/api/game21/analyze', async (req, res) => {
  try {
    const variant = req.body && req.body.variant && req.body.variant !== 'tous' ? String(req.body.variant) : null;
    if (!game21.state.updatedAt) await game21.refresh();
    const ai21 = await game21.aiOpinion({ limit: 40, variant });
    res.json({ ...game21.snapshot({ limit: 30, variant }), ai: ai21, strategies: game21Strategies.status() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// --- panneau « Prédiction IA jeu 21 » ---------------------------------------
app.get('/api/game21/predict', (req, res) => res.json(game21Predict.status()));

app.post('/api/game21/predict/config', (req, res) => {
  game21Predict.configure(req.body || {});
  res.json(game21Predict.status());
});

app.post('/api/game21/predict/channel', async (req, res) => {
  const kind = (req.body && req.body.kind) === 'valeur' ? 'valeur' : 'exacte';
  const ids = game21Predict.parseChannels(req.body && req.body.channelId);
  if (!ids.length) return res.status(400).json({ error: 'ID de canal invalide' });
  const check = await resolveChat(ids[0]);
  if (!check.ok) return res.status(400).json({ error: check.error });
  game21Predict.configure(kind === 'valeur' ? { valueChannels: ids } : { exactChannels: ids });
  res.json({ ok: true, channel: check.chat, ...game21Predict.status() });
});

app.delete('/api/game21/predict/channel', (req, res) => {
  const kind = req.query.kind === 'valeur' ? 'valeur' : 'exacte';
  game21Predict.configure(kind === 'valeur' ? { valueChannels: [] } : { exactChannels: [] });
  res.json(game21Predict.status());
});

app.post('/api/game21/predict/test', async (req, res) => {
  const r = await game21Predict.test();
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/game21/predict/run', async (req, res) => {
  await game21.refresh();
  const r = await game21Predict.tick();
  res.json(r);
});

// --- stratégies IA du jeu 21 ------------------------------------------------
app.get('/api/game21/strategies', (req, res) => res.json(game21Strategies.status()));

app.post('/api/game21/strategies', async (req, res) => {
  try {
    const entry = await game21Strategies.create({
      description: req.body && req.body.description,
      variant: (req.body && req.body.variant) || 'classique',
    });
    res.json({ ok: true, strategy: entry, ...game21Strategies.status() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/game21/strategies/:id/toggle', (req, res) => {
  const s = game21Strategies.toggle(req.params.id, req.body && req.body.enabled);
  if (!s) return res.status(404).json({ error: 'Stratégie introuvable.' });
  res.json({ ok: true, strategy: s, ...game21Strategies.status() });
});

app.delete('/api/game21/strategies/:id', (req, res) => {
  game21Strategies.remove(req.params.id);
  res.json({ ok: true, ...game21Strategies.status() });
});

// jeux stockés en base par date (ex: /api/history?date=2/04/2026)
app.get('/api/history', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  const rows = await db.gamesByDate(req.query.date, Math.min(1000, parseInt(req.query.limit, 10) || 300));
  const summary = await db.dailySummary(req.query.date);
  res.json({ summary, games: rows });
});

// --- bot --------------------------------------------------------------------
app.get('/api/bot', (req, res) => res.json(botStatus()));

app.post('/api/bot/token', async (req, res) => {
  const token = (req.body.token || '').trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) return res.status(400).json({ error: 'Token Telegram invalide' });
  const r = await startBot(token);
  // signale dans les canaux actifs que le token API est configuré
  const notice = r.ok ? await announceMainBot() : null;
  res.status(r.ok ? 200 : 400).json({ ...r, notice, bot: botStatus() });
});

app.post('/api/bot/restart', async (req, res) => {
  const r = await startBot();
  res.json({ ...r, bot: botStatus() });
});

// Déconnexion volontaire du bot principal : arrête le polling et efface le
// token (mémoire + data.json + base). Le bot ne répond plus tant qu'un
// nouveau token n'est pas enregistré via POST /api/bot/token.
app.delete('/api/bot/token', async (req, res) => {
  const r = await disconnectBot();
  res.json({ ...r, bot: botStatus() });
});

app.post('/api/bot/admin', (req, res) => {
  const id = parseInt(req.body.adminId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID administrateur invalide' });
  state.adminId = id;
  persist();
  res.json({ ok: true, bot: botStatus() });
});

// --- base de données --------------------------------------------------------
app.post('/api/db', async (req, res) => {
  const s = await db.connect(req.body.url || '');
  res.status(s.ready ? 200 : 400).json(s);
});

// --- canaux / réglages ------------------------------------------------------
app.post('/api/channels/activate', (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID de canal invalide' });
  activate(id);
  res.json({ ok: true });
});

// canal principal (page Configuration) : vérifié, enregistré et confirmé
app.post('/api/channels/main', async (req, res) => {
  const r = await setMainChannel(req.body && req.body.channelId);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/channels/deactivate', (req, res) => {
  deactivate(parseInt(req.body.id, 10));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// « Canaux » du site — vitrines internes (indépendantes de Telegram) : un
// canal = un nom + une stratégie. Visible par tous les comptes connectés
// (lecture seule pour un compte « user », déjà garanti par le middleware
// ci-dessus : seul un GET passe pour ce rôle) ; création/suppression
// réservées à l'administrateur.
// ---------------------------------------------------------------------------
app.get('/api/canaux', (req, res) => {
  res.json({ channels: siteChannelsView() });
});

app.post('/api/canaux', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const r = addSiteChannel(req.body && req.body.name, req.body && req.body.strategy);
  if (!r.ok) return res.status(400).json(r);
  persist();
  res.json(r);
});

app.delete('/api/canaux/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const r = removeSiteChannel(req.params.id);
  if (!r.ok) return res.status(404).json(r);
  persist();
  res.json(r);
});

// fil d'un canal : bilan de la stratégie + prédictions déjà publiées, dans
// l'ordre chronologique — exactement le rendu Telegram (même texte).
app.get('/api/canaux/:id', (req, res) => {
  const feed = siteChannelFeed(req.params.id, Math.min(100, parseInt(req.query.limit, 10) || 30));
  if (!feed) return res.status(404).json({ error: 'Canal introuvable.' });
  res.json(feed);
});

// écrire dans un canal du site : accessible à TOUT compte connecté (pas
// réservé à l'administrateur, voir USER_WRITE_PATTERNS ci-dessus). Le
// message est mémorisé dans le fil, puis l'IA (ai-qa.js, même moteur que le
// panneau « Question IA ») y répond directement — la réponse apparaît comme
// un nouveau message dans ce même canal, visible par tous ceux qui l'ouvrent.
app.post('/api/canaux/:id/message', async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'Message vide.' });
  const exists = siteChannelFeed(req.params.id, 1);
  if (!exists) return res.status(404).json({ error: 'Canal introuvable.' });
  const isAdminSession = !!(req.session && req.session.role === 'admin');
  const senderLabel = (req.session && req.session.identifier) || (isAdminSession ? 'Administrateur' : 'Visiteur');
  addSiteChannelMessage(req.params.id, { sender: senderLabel, text });
  persist();
  try {
    const entry = await aiQa.ask(text, { isAdmin: isAdminSession });
    addSiteChannelMessage(req.params.id, { sender: 'Bak Sossou IA', text: entry.answer });
  } catch (_) {
    addSiteChannelMessage(req.params.id, {
      sender: 'Bak Sossou IA',
      text: "Désolé, je n'ai pas pu répondre à l'instant — réessaie dans un moment.",
    });
  }
  persist();
  const feed = siteChannelFeed(req.params.id, Math.min(100, parseInt(req.query.limit, 10) || 30));
  res.json(feed);
});

app.post('/api/setb', (req, res) => {
  state.B = Math.max(1, parseInt(req.body.b, 10) || 1);
  for (const s of SUITS) if (state.counters[s] > state.B) state.counters[s] = 0;
  persist();
  res.json({ ok: true, b: state.B });
});

app.post('/api/setmaxr', (req, res) => {
  state.maxR = Math.max(0, Math.min(9, parseInt(req.body.maxR, 10) || 0));
  persist();
  res.json({ ok: true, maxR: state.maxR });
});

app.post('/api/setformat', (req, res) => {
  state.format = fmt.clampFormat(req.body.format);
  state.template = null;
  persist();
  res.json({ ok: true, format: state.format, preview: fmt.formatPreview(state.format, { maxR: state.maxR }) });
});

// aperçu d'un style (⌛ / ✅ / ❌)
app.get('/api/formats', (req, res) => {
  res.json({ count: fmt.FORMAT_COUNT, formats: fmt.formatCatalog() });
});

app.post('/api/template', (req, res) => {
  const t = String(req.body.template || '').trim();
  state.template = t || null;
  persist();
  res.json({ ok: true, template: state.template, preview: fmt.renderMessage(state.format, { gameNumber: 1234, suit: '♦️', maxR: state.maxR }, state.template).text });
});

// La main analysée est toujours celle du joueur (banquier = archive seulement)
app.post('/api/sethand', (req, res) => res.json({ ok: true, hand: 'joueur' }));

// --- vérification des données enregistrées ---------------------------------
app.get('/api/db/overview', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  res.json({ overview: await db.overview(), dates: await db.availableDates(20) });
});

app.get('/api/db/games', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  res.json({ games: await db.lastGames(Math.min(100, parseInt(req.query.limit, 10) || 20)) });
});

app.get('/api/db/game/:number', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  const g = await db.gameByNumber(req.params.number);
  if (!g) return res.status(404).json({ error: 'Jeu introuvable' });
  res.json(g);
});

app.get('/api/db/predictions', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  res.json({
    summary: await db.predictionSummary(req.query.date),
    predictions: await db.predictionsByDate(req.query.date, Math.min(500, parseInt(req.query.limit, 10) || 100)),
  });
});

app.post('/api/db/query', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  const r = await db.readOnlyQuery(req.body.sql, 100);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});


// contenu complet de la base de données (panneau « Base de données »)
app.get('/api/db/dump', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée', status: db.status() });
  res.json(await db.dump(Math.min(100, parseInt(req.query.limit, 10) || 25)));
});

// --- stratégies -------------------------------------------------------------
function strategyPayload(key) {
  const d = strategies.BY_KEY[key];
  if (!d) return null;
  const cfg = state.strategies[key] || {};
  return {
    key: d.key,
    name: d.name,
    about: d.about,
    usesB: !!d.usesB,
    config: { ...cfg, token: undefined },
    channels: cfg.publishedChannels || cfg.channels || [],
    publishedChannels: cfg.publishedChannels || cfg.channels || [],
    shadowChannels: cfg.shadowChannels || [],
    channelInfos: cfg.publishedChannelInfos || cfg.channelInfos || [],
    shadowChannelInfos: cfg.shadowChannelInfos || [],
    sentCount: cfg.sentCount || 0,
    lastSentAt: cfg.lastSentAt || null,
    bot: botStatus(),
    bilan: cfg.bilan !== false,
    bilanPreview: bilanText(d.key),
    sendError: state.sendErrors ? state.sendErrors[d.key] || null : null,
    gate: gateView(d.key),
    shadow: d.key === 'ombre' ? shadowRuntime() : null,
    dizaineCounter: d.key === 'dizaine' ? dizaineCounterView() : null,
    live: strategyGames(d.key, 12),
    stats: stats(d.key),
    preview: {
      pending: fmt.formatPreview(cfg.format, { maxR: cfg.maxR }),
      win: fmt.formatPreview(cfg.format, { maxR: cfg.maxR, status: 'gagné', rattrapage: 1 }),
      loss: fmt.formatPreview(cfg.format, { maxR: cfg.maxR, status: 'perdu', rattrapage: cfg.maxR }),
      distribution: cfg.formatDistribution ? fmt.formatPreview(cfg.formatDistribution, { maxR: cfg.maxR }) : null,
    },
    predictions: state.predictions.filter((p) => p.strategy === key).slice(0, 25).map((p) => ({
      target: p.target, label: p.label, status: p.status, badge: p.badge,
      step: p.step, maxR: p.maxR, reason: p.reason, text: predictionMessage(p),
      silent: !!p.silent,
    })),
  };
}

// jeux en live vus par une stratégie (catégories lisibles)
app.get('/api/strategies/:key/games', (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 12);
  res.json({ ...strategyGames(req.params.key, limit), stats: stats(req.params.key) });
});

// envoi manuel du bilan (test)
app.post('/api/strategies/:key/bilan', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  await sendBilan(req.params.key);
  res.json({ ok: true, text: bilanText(req.params.key) });
});

// stratégies créées par l'IA + celles restées au-dessus d'un seuil (90% par défaut)
app.get('/api/ai/strategies', (req, res) => {
  const min = Number(req.query.min);
  const list = aiAuto.listStrategies();
  res.json({
    total: list.length,
    threshold: Number.isFinite(min) ? min : 90,
    strategies: list,
    elite: aiAuto.eliteStrategies(Number.isFinite(min) ? min : 90),
  });
});

// publication manuelle du bilan complet (toutes stratégies + prédictions IA)
app.post('/api/bilans/send', async (req, res) => {
  res.json(await flushBilans('api'));
});

// bilan séparé par stratégie
app.get('/api/bilans', (req, res) => {
  res.json({
    bilans: strategies.LIST.map((d) => ({
      key: d.key, name: d.name, stats: stats(d.key), text: bilanText(d.key),
    })),
  });
});

// panneau des prédictions : silencieuses et publiées, séparées
app.get('/api/predictions', (req, res) => {
  res.json(predictionsPanel(Math.min(200, parseInt(req.query.limit, 10) || 60)));
});

// état de la stratégie « Prédiction dans l'ombre »
app.get('/api/ombre', (req, res) => res.json(shadowRuntime()));

// Historique des annonces de position (« /ombreannonces » côté Telegram),
// exposé au tableau de bord web pour le bouton « Annonces » de l'accueil.
app.get('/api/ombre/announcements', (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  res.json({ items: announcementsFor('ombre', limit), gate: gateView('ombre') });
});

// ---- configurations enregistrées en base ----------------------------------
app.get('/api/configs', async (req, res) => {
  if (!db.ready) return res.json({ ready: false, strategies: {}, settings: {} });
  const rows = await db.loadStrategies();
  res.json({
    ready: true,
    strategies: rows,
    settings: {
      B: await db.getSetting('B'),
      maxR: await db.getSetting('maxR'),
      format: await db.getSetting('format'),
      template: await db.getSetting('template'),
    },
  });
});

// enregistrer TOUTES les configurations en cours
app.post('/api/configs/save', async (req, res) => {
  const r = await saveConfigsToDb();
  res.status(r.ok ? 200 : 400).json(r);
});

// relire les configurations depuis la base (et compléter si elle est vide)
app.post('/api/configs/load', async (req, res) => {
  const r = await applyDbConfigs();
  res.status(r.ok ? 200 : 400).json(r);
});

app.get('/api/strategies', (req, res) => {
  initStrategies();
  res.json({ strategies: strategies.LIST.map((d) => strategyPayload(d.key)) });
});

// ---------------------------------------------------------------------------
// Compteur « Taux Miroir » — costume du joueur ET du banquier, carte par
// carte, publié dans un canal Telegram configuré une fois (bouton
// « Compteur » du tableau de bord). Reset automatique à chaque heure pile.
// ---------------------------------------------------------------------------
app.get('/api/mirror-counter', (req, res) => {
  res.json({
    channelId: mirrorCounter.getChannel(),
    player: mirrorCounter.state.player,
    banker: mirrorCounter.state.banker,
    games: mirrorCounter.state.games,
    sinceAt: mirrorCounter.state.sinceAt,
    preview: mirrorCounter.buildMessage(state.live ? state.live.number : null),
  });
});

app.post('/api/mirror-counter/channel', (req, res) => {
  const id = mirrorCounter.setChannel(req.body && req.body.channelId);
  res.json({ ok: true, channelId: id });
});

app.post('/api/mirror-counter/test', async (req, res) => {
  try {
    await mirrorCounter.publish(state.live ? state.live.number : null);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/strategies/:key', (req, res) => {
  const payload = strategyPayload(req.params.key);
  if (!payload) return res.status(404).json({ error: 'Stratégie inconnue' });
  res.json(payload);
});

// modification (administrateur) — enregistrée en base de données
app.post('/api/strategies/:key', async (req, res) => {
  const cfg = setStrategyConfig(req.params.key, req.body || {});
  if (!cfg) return res.status(404).json({ error: 'Stratégie inconnue' });
  persist();
  if (db.ready) await db.saveStrategy(req.params.key, strategies.BY_KEY[req.params.key].name, cfg);
  // token API et/ou ID de canal configurés → on prévient le canal
  const touched = req.body && (
    req.body.channels !== undefined ||
    req.body.channelId !== undefined ||
    req.body.publishedChannels !== undefined ||
    req.body.shadowChannels !== undefined
  );
  const notice = touched
    ? await announceConfig(req.params.key, req.body.mode === 'shadow' ? 'shadow' : 'published')
    : null;
  await cumulative.purgeStaleFor(cumulative.strategySignature());
  cumulative.tick();
  res.json({ ok: true, saved: db.ready, notice, ...strategyPayload(req.params.key) });
});

// --- canal d'une stratégie : vérification + confirmation dans le canal ------
app.post('/api/strategies/:key/channel', async (req, res) => {
  const key = req.params.key;
  if (!strategies.BY_KEY[key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  const mode = req.body.mode === 'shadow' ? 'shadow' : 'published';
  const raw = String(req.body.channelId || '').trim();
  if (!raw) return res.status(400).json({ error: "Renseigne l'ID du canal (ex : -1001234567890 ou @moncanal)" });
  if (!botStatus().tokenSet) {
    return res.status(400).json({ error: "Configure d'abord le token API du bot dans les réglages." });
  }
  const check = await resolveChat(raw);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const isChannel = ['channel', 'supergroup', 'group'].includes(check.chat.type);
  if (isChannel && check.chat.canPost === false) {
    return res.status(400).json({
      error: `Le bot n'est pas administrateur de « ${check.chat.title} » avec le droit « Publier des messages ».`,
    });
  }
  const cfg = setStrategyConfig(key, mode === 'shadow'
    ? { shadowChannelId: String(check.chat.id) }
    : { publishedChannels: [String(check.chat.id)] });
  const notice = await announceConfig(key, mode);
  if (mode === 'shadow') cfg.shadowChannelInfos = notice.channels || [check.chat];
  else cfg.publishedChannelInfos = notice.channels || [check.chat];
  persist();
  if (db.ready) await db.saveStrategy(key, strategies.BY_KEY[key].name, cfg);
  res.json({ ok: true, mode, channel: check.chat, notice, ...strategyPayload(key) });
});

// retirer le canal d'une stratégie
app.delete('/api/strategies/:key/channel', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  const mode = req.body && req.body.mode === 'shadow' ? 'shadow' : 'published';
  const cfg = mode === 'shadow'
    ? setStrategyConfig(req.params.key, { shadowChannels: [], shadowChannelInfos: [] })
    : setStrategyConfig(req.params.key, { publishedChannels: [], publishedChannelInfos: [], channels: [], channelInfos: [] });
  persist();
  if (db.ready) await db.saveStrategy(req.params.key, strategies.BY_KEY[req.params.key].name, cfg);
  res.json({ ok: true, mode, ...strategyPayload(req.params.key) });
});

// test d'envoi réel dans le canal configuré
app.post('/api/strategies/:key/test', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  const r = await testSend(req.params.key, req.body && req.body.mode === 'shadow' ? 'shadow' : 'published');
  persist();
  if (!r.ok) return res.status(400).json({ error: r.error || (r.failed || []).map((f) => `${f.id} : ${f.error}`).join(' / ') });
  res.json(r);
});

// --- analyse IA guidée ------------------------------------------------------
app.get('/api/ai/status', (req, res) => {
  res.json({
    configured: ai.keyLooksValid(),
    model: config.POLLINATIONS.MODEL,
    baseUrl: config.POLLINATIONS.BASE_URL,
    // voir commentaire équivalent dans /api/state : `configured` = clé
    // présente, `quota` = résultat du dernier test réseau réel (mis en
    // cache), rafraîchissable via POST /api/ai/quota-check.
    quota: ai.getLastQuotaCheck(),
    auto: aiAuto.status(),
    lastAnalysis: state.aiAnalyses[0] || null,
    results: state.aiAnalyses.slice(0, 6),
    savedStrategies: state.aiStrategies,
  });
});

// vérifie MAINTENANT (appel réseau réel) la clé/le quota de chaque
// fournisseur IA configuré, et met à jour le cache lu par /api/state et
// /api/ai/status — bouton « Vérifier maintenant » de la page Analyseur IA.
app.post('/api/ai/quota-check', async (req, res) => {
  try {
    const quota = await ai.refreshQuotaStatus();
    res.json({ ok: true, quota });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/ai/analyze', async (req, res) => {
  try {
    const date = req.body && req.body.date ? String(req.body.date).trim() : null;
    const limit = Math.min(ai.MAX_GAMES, Math.max(6, parseInt(req.body && req.body.limit, 10) || 60));
    let games = [];
    if (date && db.ready) games = await db.gamesByDate(date, limit);
    if (!games.length) games = [...state.history].slice(0, limit);
    if (db.ready) await aiAuto.refreshPastDays();
    const result = await ai.analyze({
      games,
      pastDays: aiAuto.getPastDays(),
      date,
      objective: req.body && req.body.objective ? String(req.body.objective).slice(0, 1200) : '',
    });
    state.aiAnalyses = [result, ...state.aiAnalyses].slice(0, 8);
    if (db.ready) await db.saveAiAnalysis(result, date);
    persist();
    res.json({ ok: true, result });
  } catch (error) {
    const status = error.code === 'AI_NOT_CONFIGURED' ? 503 : error.code === 'NOT_ENOUGH_DATA' ? 422 : 502;
    res.status(status).json({ error: error.message, code: error.code || 'AI_ERROR' });
  }
});

// découverte de NOUVELLES régularités (au-delà des stratégies existantes)
app.get('/api/ai/patterns', async (req, res) => {
  const limit = Math.min(300, parseInt(req.query.limit, 10) || 150);
  let games = [...state.history].slice(0, limit);
  let pastDays = [];
  if (db.ready) {
    if (!games.length) games = await db.gamesByDate(null, limit);
    await aiAuto.refreshPastDays(true);
    pastDays = aiAuto.getPastDays();
  }
  const result = miner.mine(games, { lead: 2, pastDays, todayGames: games });
  res.json({ ...result, generatedAt: new Date().toISOString(), pastDaysCount: pastDays.length });
});

// comparaison des statistiques des jours antérieurs et d'aujourd'hui
app.get('/api/ai/compare-days', async (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 300);
  let games = [...state.history].slice(0, limit);
  let pastDays = [];
  if (db.ready) {
    if (!games.length) games = await db.gamesByDate(null, limit);
    await aiAuto.refreshPastDays(true);
    pastDays = aiAuto.getPastDays();
  }
  res.json(dayCompare.compare(games, pastDays));
});

// création automatique des stratégies issues de la comparaison des journées
app.post('/api/ai/compare-days/save', async (req, res) => {
  const limit = 300;
  let games = [...state.history].slice(0, limit);
  let pastDays = [];
  if (db.ready) {
    if (!games.length) games = await db.gamesByDate(null, limit);
    await aiAuto.refreshPastDays(true);
    pastDays = aiAuto.getPastDays();
  }
  const result = dayCompare.compare(games, pastDays);
  const created = [];
  for (const proposal of result.proposals) {
    const saved = aiAuto.saveProposal(proposal, 'auto-comparaison');
    if (saved) created.push(saved.name);
  }
  res.json({ ok: true, created, total: result.proposals.length });
});

app.post('/api/ai/strategies', async (req, res) => {
  const proposal = req.body && req.body.proposal;
  if (!proposal || typeof proposal !== 'object') return res.status(400).json({ error: 'Proposition de stratégie manquante' });
  const rate = Number(proposal.rate);
  if (!Number.isFinite(rate) || rate < 75) {
    return res.status(400).json({ error: "Réussite insuffisante : seules les stratégies mesurées à 75% ou plus sont enregistrées." });
  }
  const item = {
    id: `ai-${Date.now()}`,
    name: String(proposal.name || 'Stratégie IA').slice(0, 100),
    logic: String(proposal.logic || '').slice(0, 1000),
    evidence: String(proposal.evidence || '').slice(0, 1000),
    risks: String(proposal.risks || '').slice(0, 1000),
    rate,
    support: Number(proposal.support) || null,
    compatibleExisting: strategies.BY_KEY[proposal.compatibleExisting] ? proposal.compatibleExisting : null,
    createdAt: new Date().toISOString(),
    active: false,
  };
  state.aiStrategies = [item, ...state.aiStrategies].slice(0, 30);
  persist();
  if (db.ready) await db.saveAiStrategy(item);
  res.json({ ok: true, strategy: item });
});

app.post('/api/strategies/:key/reset', async (req, res) => {
  const cfg = resetStrategy(req.params.key);
  if (!cfg) return res.status(404).json({ error: 'Stratégie inconnue' });
  persist();
  if (db.ready) await db.saveStrategy(req.params.key, strategies.BY_KEY[req.params.key].name, cfg);
  await cumulative.purgeStaleFor(cumulative.strategySignature());
  cumulative.tick();
  res.json({ ok: true, ...strategyPayload(req.params.key) });
});

// Réinitialise TOUTES les stratégies aux valeurs par défaut ACTUELLES du code
// (strategies.js), y compris celles déjà enregistrées en base avec d'anciennes
// valeurs — sans ce bouton, changer un default dans le code n'a aucun effet
// sur une stratégie déjà en base tant qu'on ne la réinitialise pas à la main
// (voir applyDbConfigs() : la base prime toujours sur les defaults une fois
// la ligne créée).
app.post('/api/strategies/reset-all', async (req, res) => {
  const results = [];
  for (const def of strategies.LIST) {
    const cfg = resetStrategy(def.key);
    if (!cfg) continue;
    if (db.ready) await db.saveStrategy(def.key, def.name, cfg);
    results.push(def.key);
  }
  persist();
  await cumulative.purgeStaleFor(cumulative.strategySignature());
  cumulative.tick();
  res.json({ ok: true, reset: results });
});

// suppression (administrateur) : configuration effacée en base + stratégie arrêtée
app.delete('/api/strategies/:key', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  resetStrategy(req.params.key);
  setStrategyConfig(req.params.key, { enabled: false });
  // CORRECTIF : persist() réécrit TOUTES les stratégies en base (y compris
  // celle-ci, remise à ses valeurs par défaut). Si on supprimait AVANT
  // persist(), la ligne réapparaissait aussitôt en base. On supprime donc
  // en dernier, après que persist() ait fini d'écrire.
  persist();
  if (db.ready) await db.deleteStrategy(req.params.key);
  res.json({ ok: true, ...strategyPayload(req.params.key) });
});

// suppression des prédictions d'une stratégie (administrateur)
app.delete('/api/strategies/:key/predictions', async (req, res) => {
  if (!strategies.BY_KEY[req.params.key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  state.predictions = state.predictions.filter((p) => p.strategy !== req.params.key);
  if (db.ready) await db.clearPredictions(req.params.key);
  res.json({ ok: true });
});

app.get('/api/db/strategies', async (req, res) => {
  if (!db.ready) return res.status(400).json({ error: 'Base de données non connectée' });
  const out = {};
  for (const d of strategies.LIST) {
    out[d.key] = { stats: await db.strategyStats(d.key), predictions: await db.strategyPredictions(d.key, 15) };
  }
  res.json({ saved: await db.loadStrategies(), details: out });
});


// --- analyse cumulative par paliers de 4 jeux -------------------------------
app.get('/api/ai/cumulative', async (req, res) => {
  const date = req.query.date ? String(req.query.date) : null;
  if (date && date !== cumulative.runtime.date) {
    return res.json({ date, step: cumulative.STEP, maxGames: cumulative.MAX_GAMES, checkpoints: await cumulative.byDate(date) });
  }
  res.json(cumulative.status());
});

app.post('/api/ai/cumulative/run', async (req, res) => {
  const r = await cumulative.tick();
  res.json({ ok: true, ...r, status: cumulative.status() });
});

// efface les paliers qui ne correspondent plus à la stratégie actuelle
app.post('/api/ai/cumulative/purge', async (req, res) => {
  const sig = cumulative.strategySignature();
  const removed = await cumulative.purgeStaleFor(sig);
  const r = await cumulative.tick();
  res.json({ ok: true, removed, recalculated: r.created.length, status: cumulative.status() });
});

// --- déblocage des prédictions (auto après 10 min, ou manuel) ---------------
app.post('/api/strategies/:key/unlock', (req, res) => {
  const key = req.params.key;
  if (key === 'all' || key === 'tout') {
    const keys = strategies.LIST.map((d) => d.key);
    keys.forEach((k) => unlockGate(k, true));
    return res.json({ ok: true, unlocked: keys });
  }
  if (!strategies.BY_KEY[key]) return res.status(404).json({ error: 'Stratégie inconnue' });
  unlockGate(key, true);
  res.json({ ok: true, unlocked: [key], gate: gateView(key) });
});

app.get('/api/gates', (req, res) => {
  sweepAutoUnlock();
  res.json({
    gates: strategies.LIST.map((d) => ({ key: d.key, name: d.name, ...gateView(d.key) })),
  });
});

// --- avis IA cumulé sur les stratégies existantes ---------------------------
app.get('/api/ai/strategy-advice', async (req, res) => {
  const st = advisor.status();
  if (!st.lastRunAt) return res.json(await advisor.run({ remote: false }));
  res.json(st);
});

app.post('/api/ai/strategy-advice/run', async (req, res) => {
  const remote = !!(req.body && req.body.remote);
  res.json(await advisor.run({ remote }));
});

// --- « Poser une question à l'IA » sur le projet (prédictions réelles, raisons, réglages) ---
app.post('/api/ai/ask', async (req, res) => {
  const question = req.body && req.body.question;
  if (!question || !String(question).trim()) return res.status(400).json({ error: 'Question vide.' });
  const isAdmin = !!(req.session && req.session.role === 'admin');
  try {
    const entry = await aiQa.ask(question, { isAdmin });
    res.json({ ok: true, ...entry, history: aiQa.history() });
  } catch (e) {
    // même filet de sécurité côté erreurs inattendues : le détail technique
    // ne part que vers l'admin, un utilisateur normal reçoit un message neutre.
    res.status(500).json({ ok: false, error: isAdmin ? e.message : "La question n'a pas pu être traitée, réessaie." });
  }
});
app.get('/api/ai/ask', (req, res) => res.json({ ok: true, history: aiQa.history() }));

// --- Formation : l'IA déduit, pour chaque stratégie, si la prédiction qui
// suit une perte ou un rattrapage a plus de chances d'être validée --------
app.get('/api/formation', async (req, res) => {
  const st = formation.status();
  if (!st.lastRunAt) return res.json(await formation.run());
  res.json(st);
});

app.post('/api/formation/run', async (req, res) => {
  const remote = !!(req.body && req.body.remote);
  res.json(await formation.run({ remote }));
});

// --- Formation : envoi dans le canal (case à cocher par stratégie) --------
app.get('/api/formation/relay', (req, res) => res.json(formationRelay.status()));

app.post('/api/formation/relay/config', (req, res) => {
  res.json(formationRelay.configure(req.body || {}));
});

app.post('/api/formation/relay/strategy', (req, res) => {
  try {
    res.json(formationRelay.setStrategy((req.body || {}).key, req.body || {}));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/formation/relay/send', async (req, res) => {
  try {
    res.json(await formationRelay.sendLesson((req.body || {}).key));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/formation/relay/scan', async (req, res) => {
  res.json(await formationRelay.tick());
});

// --- « Réparation IA » : l'IA (Groq) identifie les problèmes du projet, les
// corrige elle-même avec un pourcentage d'avancement, puis vérifie que tout
// est bien corrigé. Réservé à l'administrateur (écriture de fichiers).
function repairError(res, e) {
  const status = e.code === 'GROQ_NOT_CONFIGURED' ? 503 : e.code === 'NO_MESSAGE' || e.code === 'NO_SESSION' ? 400 : e.status === 429 ? 429 : 502;
  res.status(status).json({ error: e.message, code: e.code || 'REPAIR_ERROR' });
}

// CORRECTIF « redémarrage automatique après réparation IA » : Node garde en
// cache tout fichier chargé via require() (strategies.js, auth.js, etc.) —
// modifier ces fichiers sur disque ne suffit donc pas à faire prendre effet
// la correction/nouvelle stratégie dans l'app en cours d'exécution. Sur
// Render (voir render.yaml, type: web), le processus est automatiquement
// relancé dès qu'il se termine — on profite de ce comportement plutôt que
// d'ajouter un vrai rechargement à chaud (risqué avec des require() en
// cascade et des connexions Telegram/DB déjà ouvertes).
//
// Le redémarrage n'est jamais immédiat : on laisse d'abord la réponse HTTP
// partir vers le client (déjà fait par res.json() avant l'appel), puis on
// attend quelques secondes pour laisser le panneau admin afficher le
// résultat final et laisser un tick() éventuellement en cours se terminer
// proprement, avant de sauvegarder l'état et de couper le processus.
let restartScheduled = false;

// CORRECTIF « ne pas couper une annonce ombre en cours » : la stratégie
// « Prédiction dans l'ombre » (mode silencieux) compte plusieurs jeux en
// silence avant d'annoncer, puis d'envoyer, une seule prédiction dans le
// canal public (voir predictor.js : state.announcements, state.gates.ombre).
// Redémarrer le process PENDANT cette fenêtre couperait le décompte et/ou
// une annonce déjà publiée mais pas encore honorée par un envoi réel — donc
// avant de couper le process, on vérifie qu'il n'y a :
//   - ni prédiction « ombre » encore « en attente » (pas encore résolue),
//   - ni annonce « ombre » encore « en_attente » (position annoncée mais
//     prédiction pas encore réellement envoyée dans le canal public).
function ombreBusy() {
  const pendingPrediction = state.predictions.some((p) => p.strategy === 'ombre' && p.status === 'en attente');
  const pendingAnnouncement = (state.announcements || []).some((a) => a.strategy === 'ombre' && a.status === 'en_attente');
  return pendingPrediction || pendingAnnouncement;
}

// CORRECTIF « redémarrage qui ne se termine jamais » : la stratégie « ombre »
// est ACTIVÉE PAR DÉFAUT (voir strategies.js) et sa description dit
// elle-même qu'elle attend « aussi longtemps qu'il faut » — en pratique,
// une annonce en_attente peut donc rester vraie pendant très longtemps
// (plusieurs minutes, parfois plus). Attendre indéfiniment revenait à ne
// JAMAIS redémarrer, ce qui bloquait complètement la fonctionnalité
// (observé : « En attente de redémarrage » qui ne se termine jamais).
// On attend donc raisonnablement (jusqu'à ~2 min), mais on FORCE le
// redémarrage au-delà — mieux vaut risquer de couper un décompte ombre en
// cours (il repartira simplement de zéro) que de ne jamais mettre à jour
// les stratégies créées par l'IA.
const OMBRE_WAIT_MAX_ATTEMPTS = 12; // ~12 × 10 s = 2 min après le délai initial de 20 s

function attemptRestart(attempt) {
  if (ombreBusy() && attempt < OMBRE_WAIT_MAX_ATTEMPTS) {
    if (attempt % 3 === 0) { // log toutes les 30 s pour ne pas spammer
      console.log(`⏳ Redémarrage reporté (${attempt}/${OMBRE_WAIT_MAX_ATTEMPTS}) : prédiction/annonce « ombre » (mode silencieux) en attente.`);
      aiRepair.log('⏳ Redémarrage reporté : une prédiction/annonce « ombre » (mode silencieux) est en attente — on ne la coupe pas (sauf au-delà de 2 min).');
    }
    setTimeout(() => attemptRestart(attempt + 1), 10000);
    return;
  }
  if (attempt >= OMBRE_WAIT_MAX_ATTEMPTS && ombreBusy()) {
    console.log('⚠️ Redémarrage forcé après 2 min d\'attente — la stratégie « ombre » était encore en cours, son décompte va repartir de zéro.');
    aiRepair.log('⚠️ Redémarrage forcé après 2 min d\'attente : le décompte « ombre » en cours a été interrompu (il repart de zéro).');
  }
  try { persist(); } catch (e) { console.error('Persist avant redémarrage impossible :', e.message); }
  console.log('🔄 Redémarrage en cours (modifications de l\'IA appliquées au prochain démarrage)…');
  aiRepair.clearRestartFlag();
  process.exit(0);
}

function scheduleGracefulRestart(reason) {
  if (restartScheduled) return; // déjà programmé — pas de double redémarrage
  restartScheduled = true;
  console.log(`🔄 Redémarrage automatique programmé (${reason}) — dans 20 s…`);
  aiRepair.log(`🔄 Redémarrage automatique dans 20 s pour appliquer : ${reason}.`);
  setTimeout(() => attemptRestart(0), 20000);
}

app.get('/api/ai/repair', (req, res) => res.json(aiRepair.status()));
app.post('/api/ai/repair/diagnose', async (req, res) => {
  try { res.json({ ok: true, ...(await aiRepair.diagnose(req.body && req.body.message)) }); }
  catch (e) { repairError(res, e); }
});
app.post('/api/ai/repair/fix', async (req, res) => {
  try { res.json({ ok: true, ...(await aiRepair.fixNext()) }); }
  catch (e) { repairError(res, e); }
});
app.post('/api/ai/repair/verify', async (req, res) => {
  try {
    const r = await aiRepair.verify();
    res.json({ ok: true, ...r });
    // le process entier ne redémarre qu'ici (fin du cycle diagnose → fixNext…
    // → verify), jamais pendant fixNext() : redémarrer en plein milieu
    // tuerait la session de réparation en mémoire (liste des problèmes
    // restants) avant qu'elle soit terminée.
    if (aiRepair.needsRestart()) scheduleGracefulRestart('correctif(s) appliqué(s) par l\'IA');
  } catch (e) { repairError(res, e); }
});
app.post('/api/ai/repair/reset', (req, res) => res.json({ ok: true, ...aiRepair.reset() }));
app.post('/api/ai/repair/create-strategy', async (req, res) => {
  try {
    const r = await aiRepair.createStrategy(req.body && req.body.description);
    res.json(r);
    scheduleGracefulRestart('nouvelle stratégie créée par l\'IA');
  } catch (e) { repairError(res, e); }
});


// --- analyseur automatique en temps réel ------------------------------------
app.get('/api/ai/auto', (req, res) => res.json(aiAuto.status()));

app.post('/api/ai/auto/run', (req, res) => {
  const r = aiAuto.runLocal();
  persist();
  res.json({ ok: true, result: r.result, created: r.created, auto: aiAuto.status() });
});

app.post('/api/ai/auto/toggle', (req, res) => {
  const on = req.body && req.body.enabled !== false;
  aiAuto.auto.enabled = on;
  if (on) aiAuto.start(persist); else aiAuto.stop();
  if (db.ready) db.setSetting('ai_auto_enabled', on ? 'true' : 'false');
  persist();
  res.json({ ok: true, auto: aiAuto.status() });
});

app.post('/api/ai/key', async (req, res) => {
  ai.setApiKey(req.body && req.body.key);
  const configured = ai.keyLooksValid();
  // CORRECTIF : on appelait checkPollinationsQuota() directement, dont le
  // résultat repartait dans la réponse (toast affiché une fois) mais SANS
  // jamais mettre à jour le cache lu par /api/state (getLastQuotaCheck()) —
  // le badge permanent de la page retombait donc sur « pas encore vérifiée »
  // juste après l'enregistrement, donnant l'impression que rien ne s'était
  // passé. refreshQuotaStatus() revérifie tout ET met le cache à jour.
  const quota = configured ? (await ai.refreshQuotaStatus()).pollinations : null;
  res.json({ ok: true, configured, quota });
});

// clés Gemini / Groq saisissables à chaud depuis la page Analyseur IA —
// mêmes principe et route que /api/ai/key ci-dessus, avec persistance en base
// pour survivre à un redémarrage/redéploiement (voir applyDbConfigs dans bot.js).
// Chaque route vérifie AUSSI le quota (appel réel minimal au fournisseur) dès
// que la clé est appliquée, pour confirmer immédiatement à l'admin que le
// quota existe bien sur cette clé et qu'elle sera utilisée — et met à jour
// le cache (refreshQuotaStatus) pour que le badge permanent de la page ne
// contredise pas le toast affiché juste après l'enregistrement.
app.post('/api/ai/key/gemini', async (req, res) => {
  ai.setGeminiKey(req.body && req.body.key);
  if (db.ready) await db.setSetting('ai_gemini_key', ai.geminiKey());
  const configured = ai.geminiConfigured();
  const quota = configured ? (await ai.refreshQuotaStatus()).gemini : null;
  res.json({ ok: true, configured, quota });
});
app.post('/api/ai/key/groq', async (req, res) => {
  ai.setGroqKey(req.body && req.body.key);
  if (db.ready) await db.setSetting('ai_groq_key', ai.groqKey());
  const configured = ai.groqConfigured();
  const quota = configured ? (await ai.refreshQuotaStatus()).groq : null;
  res.json({ ok: true, configured, quota });
});
app.post('/api/ai/key/openrouter', async (req, res) => {
  ai.setOpenrouterKey(req.body && req.body.key);
  if (db.ready) await db.setSetting('ai_openrouter_key', ai.openrouterKey());
  const configured = ai.openrouterConfigured();
  const quota = configured ? (await ai.refreshQuotaStatus()).openrouter : null;
  res.json({ ok: true, configured, quota });
});

app.get('/api/ai/models', async (req, res) => {
  try { res.json({ models: await ai.listModels() }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.delete('/api/ai/strategies/:id', async (req, res) => {
  state.aiStrategies = (state.aiStrategies || []).filter((s) => s.id !== req.params.id);
  persist();
  if (db.ready) await db.deleteAiStrategy(req.params.id);
  res.json({ ok: true, savedStrategies: state.aiStrategies });
});


// --- panneau « Prédit » (prédictions certifiées 100%) -----------------------
app.get('/api/predit', (req, res) => res.json(predit.status()));

app.post('/api/predit/config', (req, res) => {
  predit.configure(req.body || {});
  res.json(predit.status());
});

app.post('/api/predit/channel', async (req, res) => {
  const ids = predit.parseChannels(req.body && req.body.channelId);
  if (!ids.length) return res.status(400).json({ error: 'ID de canal invalide' });
  const check = await resolveChat(ids[0]);
  if (!check.ok) return res.status(400).json({ error: check.error });
  predit.configure({ channels: ids });
  const notice = await predit.test();
  res.json({ ok: true, channel: check.chat, notice, predit: predit.status() });
});

app.delete('/api/predit/channel', (req, res) => {
  predit.configure({ channels: [] });
  res.json(predit.status());
});

app.post('/api/predit/test', async (req, res) => {
  const r = await predit.test();
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/predit/scan', async (req, res) => {
  await predit.tick();
  res.json(predit.status());
});

// --- panneau « Prédiction après perte » (relais après N pertes) ------------
app.get('/api/after-loss', (req, res) => res.json(afterLoss.status()));

app.post('/api/after-loss/config', (req, res) => {
  afterLoss.configure(req.body || {});
  res.json(afterLoss.status());
});

app.post('/api/after-loss/channel', async (req, res) => {
  const idsList = afterLoss.parseChannels(req.body && req.body.channelId);
  if (!idsList.length) return res.status(400).json({ error: 'ID de canal invalide' });
  const check = await resolveChat(idsList[0]);
  if (!check.ok) return res.status(400).json({ error: check.error });
  afterLoss.configure({ channels: idsList });
  const notice = await afterLoss.test();
  res.json({ ok: true, channel: check.chat, notice, afterLoss: afterLoss.status() });
});

app.delete('/api/after-loss/channel', (req, res) => {
  afterLoss.configure({ channels: [] });
  res.json(afterLoss.status());
});

app.post('/api/after-loss/test', async (req, res) => {
  const r = await afterLoss.test();
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/after-loss/scan', async (req, res) => {
  await afterLoss.tick();
  res.json(afterLoss.status());
});

app.post('/api/after-loss/trackers', async (req, res) => {
  try {
    const key = req.body && req.body.key;
    const t = afterLoss.addTracker(key, req.body && req.body.triggers, req.body && req.body.repeat, {
      // nom donné à la configuration : elle apparaît ensuite sous ce nom dans
      // les listes de stratégies existantes des autres panneaux.
      name: req.body && req.body.name,
      // catégorie de configuration choisie dans le panneau (1, 2 ou 3)
      category: req.body && req.body.category,
      channels: req.body && req.body.channels,
      siteChannelId: req.body && req.body.siteChannelId,
      format: req.body && req.body.format,
      streak: req.body && req.body.streak,
      decade: req.body && req.body.decade,
      // CORRECTIF « doublons de configuration » : force=true (renvoyé par le
      // front-end après confirmation de l'admin sur la fenêtre d'avertissement)
      // permet de créer quand même le tracker malgré un conflit détecté (voir
      // findConfigConflicts() dans after-loss.js).
      force: !!(req.body && req.body.force),
    });
    // la stratégie suivie a été activée automatiquement par addTracker() —
    // on persiste ce changement comme le fait la route /api/strategies/:key,
    // sinon l'activation ne survit pas à un redémarrage/redéploiement.
    if (key && key !== 'ia' && strategies.BY_KEY[key]) {
      persist();
      if (db.ready) await db.saveStrategy(key, strategies.BY_KEY[key].name, state.strategies[key]);
    }
    res.json({ ok: true, tracker: t, afterLoss: afterLoss.status() });
  } catch (e) {
    // CORRECTIF « doublons de configuration » : statut dédié (409 = conflit)
    // + la liste des configurations en conflit, pour que le front-end affiche
    // une fenêtre listant les différentes configurations avant de forcer.
    if (e.code === 'DUPLICATE_CONFIG') {
      return res.status(409).json({ error: e.message, code: e.code, conflicts: e.conflicts || [] });
    }
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/after-loss/trackers/:id', (req, res) => {
  try {
    const t = afterLoss.updateTracker(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ error: 'Stratégie suivie introuvable' });
    res.json({ ok: true, tracker: t, afterLoss: afterLoss.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/after-loss/trackers/:id', (req, res) => {
  afterLoss.removeTracker(req.params.id);
  res.json(afterLoss.status());
});

// ---------------------------------------------------------------------------
// « Prédiction combinée pour costume joueur » (voir combined.js) — même
// schéma de routes que « Prédiction après perte » ci-dessus, mais système
// indépendant : sources multiples (stratégies + formations), déclencheur
// CONSÉCUTIF par niveau de rattrapage, synthèse même/inverse +w.
// ---------------------------------------------------------------------------
app.get('/api/combined', (req, res) => res.json(combined.status()));

app.post('/api/combined/config', (req, res) => {
  combined.configure(req.body || {});
  res.json(combined.status());
});

app.post('/api/combined/channel', async (req, res) => {
  const idsList = combined.parseChannels(req.body && req.body.channelId);
  if (!idsList.length) return res.status(400).json({ error: 'ID de canal invalide' });
  const check = await resolveChat(idsList[0]);
  if (!check.ok) return res.status(400).json({ error: check.error });
  combined.configure({ channels: idsList });
  const notice = await combined.test();
  res.json({ ok: true, channel: check.chat, notice, combined: combined.status() });
});

app.delete('/api/combined/channel', (req, res) => {
  combined.configure({ channels: [] });
  res.json(combined.status());
});

app.post('/api/combined/test', async (req, res) => {
  const r = await combined.test();
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/combined/scan', async (req, res) => {
  await combined.tick();
  res.json(combined.status());
});

app.post('/api/combined/trackers', async (req, res) => {
  try {
    // accepte soit `keys` (tableau, sélection multiple — demande admin),
    // soit `key` (rétrocompatibilité, une seule source) — mêmes règles
    // appliquées à chacune, en un seul appel (voir combined.addTrackers).
    const keys = Array.isArray(req.body && req.body.keys)
      ? req.body.keys
      : (req.body && req.body.key ? [req.body.key] : []);
    const r = combined.addTrackers(keys, req.body && req.body.rules, {
      channels: req.body && req.body.channels,
      format: req.body && req.body.format,
      name: req.body && req.body.name,
    });
    res.json({ ok: true, created: r.created, errors: r.errors, combined: combined.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/combined/trackers/:id', (req, res) => {
  try {
    const t = combined.updateTracker(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ error: 'Source suivie introuvable' });
    res.json({ ok: true, tracker: t, combined: combined.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/combined/trackers/:id', (req, res) => {
  combined.removeTracker(req.params.id);
  res.json(combined.status());
});

// ---------------------------------------------------------------------------
// « Comptage 2/2 » (voir cards-count.js) — nouveau bouton : comptage des
// catégories 3/2, 3/3 et 2/2 par lot, filtrage selon les catégories cochées,
// nombre configurable de cibles espacées de 10 jeux, envoi déclenché à −3/−2
// du jeu cible et vérification avec le rattrapage configuré.
// ---------------------------------------------------------------------------
app.get('/api/cards-count', (req, res) => res.json(cardsCount.status()));

app.post('/api/cards-count/config', (req, res) => {
  cardsCount.configure(req.body || {});
  res.json(cardsCount.status());
});

app.post('/api/cards-count/channel', async (req, res) => {
  const idsList = cardsCount.parseChannels(req.body && req.body.channelId);
  if (!idsList.length) return res.status(400).json({ ok: false, error: 'Identifiant de canal invalide' });
  const check = await resolveChat(idsList[0]);
  if (!check.ok) return res.status(400).json({ ok: false, error: check.error });
  cardsCount.configure({ channels: idsList });
  const notice = await cardsCount.test();
  res.json({ ok: true, channel: check.chat, notice, cardsCount: cardsCount.status() });
});

app.delete('/api/cards-count/channel', (req, res) => {
  cardsCount.configure({ channels: [] });
  res.json(cardsCount.status());
});

app.post('/api/cards-count/test', async (req, res) => {
  const r = await cardsCount.test();
  res.status(r.ok ? 200 : 400).json({ ...r, cardsCount: cardsCount.status() });
});

app.post('/api/cards-count/scan', async (req, res) => {
  await cardsCount.tick();
  res.json(cardsCount.status());
});

app.post('/api/cards-count/reset', (req, res) => {
  res.json(cardsCount.resetCounting());
});

// ---------------------------------------------------------------------------
// « Nul / 2-3 » (voir draw-two-three.js) — prédit ensemble le match nul (X) ou la
// distribution 2/3 (joueur 2 cartes, banquier 3), avec l'analyse des matchs nuls.
// ---------------------------------------------------------------------------
app.get('/api/draw-two-three', (req, res) => res.json(drawTwoThree.status()));

app.post('/api/draw-two-three/config', (req, res) => {
  drawTwoThree.configure(req.body || {});
  res.json(drawTwoThree.status());
});

app.post('/api/draw-two-three/channel', async (req, res) => {
  const idsList = drawTwoThree.parseChannels(req.body && req.body.channelId);
  if (!idsList.length) return res.status(400).json({ ok: false, error: 'Identifiant de canal invalide' });
  const check = await resolveChat(idsList[0]);
  if (!check.ok) return res.status(400).json({ ok: false, error: check.error });
  drawTwoThree.configure({ channels: idsList });
  const notice = await drawTwoThree.test();
  res.json({ ok: true, channel: check.chat, notice, drawTwoThree: drawTwoThree.status() });
});

app.delete('/api/draw-two-three/channel', (req, res) => {
  drawTwoThree.configure({ channels: [] });
  res.json(drawTwoThree.status());
});

app.post('/api/draw-two-three/test', async (req, res) => {
  const r = await drawTwoThree.test();
  res.status(r.ok ? 200 : 400).json({ ...r, drawTwoThree: drawTwoThree.status() });
});

app.post('/api/draw-two-three/scan', async (req, res) => {
  await drawTwoThree.tick();
  res.json(drawTwoThree.status());
});

app.post('/api/draw-two-three/apply', (req, res) => {
  const r = drawTwoThree.applyBySid(String((req.body && req.body.sid) || ''));
  res.status(r.ok ? 200 : 400).json({ ...r, drawTwoThree: drawTwoThree.status() });
});

app.post('/api/draw-two-three/send-list', async (req, res) => {
  const ok = await drawTwoThree.sendListToAdmin();
  res.status(ok ? 200 : 400).json({ ok, error: ok ? null : (drawTwoThree.status().lastError || 'Envoi impossible'), drawTwoThree: drawTwoThree.status() });
});

app.post('/api/draw-two-three/reset', (req, res) => {
  res.json(drawTwoThree.resetStats());
});

// ---------------------------------------------------------------------------
// « VIP » (voir vip.js) — liste à cocher de toutes les stratégies + IA :
// après 3 pertes consécutives OU 3 prédictions consécutives du même costume
// sur une stratégie cochée, relais de ses 2 prochaines prédictions dans le
// canal VIP configuré, puis arrêt jusqu'à la prochaine série.
// ---------------------------------------------------------------------------
app.get('/api/vip', (req, res) => res.json(vip.status()));

app.post('/api/vip/config', (req, res) => {
  vip.configure(req.body || {});
  res.json(vip.status());
});

app.post('/api/vip/channel', async (req, res) => {
  const idsList = vip.parseChannels(req.body && req.body.channelId);
  if (!idsList.length) return res.status(400).json({ ok: false, error: 'Identifiant de canal invalide' });
  const check = await resolveChat(idsList[0]);
  if (!check.ok) return res.status(400).json({ ok: false, error: check.error });
  vip.configure({ channels: idsList });
  const notice = await vip.test();
  res.json({ ok: true, channel: check.chat, notice, vip: vip.status() });
});

app.delete('/api/vip/channel', (req, res) => {
  vip.configure({ channels: [] });
  res.json(vip.status());
});

app.post('/api/vip/test', async (req, res) => {
  const r = await vip.test();
  res.status(r.ok ? 200 : 400).json({ ...r, vip: vip.status() });
});

app.post('/api/vip/scan', async (req, res) => {
  await vip.tick();
  res.json(vip.status());
});

// ---------------------------------------------------------------------------
// « Série de costume » (voir suit-streak.js) — nouveau bouton (demande
// admin) : sélection d'UNE source (stratégie, IA, ou formation), série de N
// prédictions CONSÉCUTIVES de MÊME costume (peu importe gagné/perdu) avant
// de déclencher — aucune perte dans la série → déclenchement immédiat
// (jeu suivant ou +Z, réglable) ; une perte dans la série → attend le
// RETOUR de ce même costume avant de déclencher (une seule fois).
// ---------------------------------------------------------------------------
app.get('/api/suit-streak', (req, res) => res.json(suitStreak.status()));

app.post('/api/suit-streak/config', (req, res) => {
  suitStreak.configure(req.body || {});
  res.json(suitStreak.status());
});

app.post('/api/suit-streak/channel', async (req, res) => {
  const idsList = suitStreak.parseChannels(req.body && req.body.channelId);
  if (!idsList.length) return res.status(400).json({ error: 'ID de canal invalide' });
  const check = await resolveChat(idsList[0]);
  if (!check.ok) return res.status(400).json({ error: check.error });
  suitStreak.configure({ channels: idsList });
  if (check.chat && check.chat.title) suitStreak.setChannelTitle(idsList[0], check.chat.title);
  const notice = await suitStreak.test();
  res.json({ ok: true, channel: check.chat, notice, suitStreak: suitStreak.status() });
});

app.delete('/api/suit-streak/channel', (req, res) => {
  suitStreak.configure({ channels: [] });
  res.json(suitStreak.status());
});

app.post('/api/suit-streak/test', async (req, res) => {
  const r = await suitStreak.test();
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/suit-streak/scan', async (req, res) => {
  await suitStreak.tick();
  res.json(suitStreak.status());
});

// Relève le nom (titre) des canaux propres d'une source, sans bloquer la réponse.
function rememberPanelTitles(mod, list) {
  for (const id of (list || [])) {
    resolveChat(id).then((c) => { if (c && c.ok && c.chat && c.chat.title) mod.setChannelTitle(id, c.chat.title); }).catch(() => {});
  }
}
function rememberSuitStreakTitles(list) { rememberPanelTitles(suitStreak, list); }

app.post('/api/suit-streak/trackers', async (req, res) => {
  try {
    const t = suitStreak.addTracker(req.body && req.body.key, {
      n: req.body && req.body.n,
      mode: req.body && req.body.mode,
      offset: req.body && req.body.offset,
      suitFilter: req.body && req.body.suitFilter,
      predictSuit: req.body && req.body.predictSuit,
      channels: req.body && req.body.channels,
      siteChannelId: req.body && req.body.siteChannelId,
      format: req.body && req.body.format,
      maxR: req.body && req.body.maxR,
      name: req.body && req.body.name,
    });
    rememberSuitStreakTitles(t && t.channels);
    res.json({ ok: true, tracker: t, suitStreak: suitStreak.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/suit-streak/trackers/:id', (req, res) => {
  try {
    const t = suitStreak.updateTracker(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ error: 'Source suivie introuvable' });
    rememberSuitStreakTitles(t && t.channels);
    res.json({ ok: true, tracker: t, suitStreak: suitStreak.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/suit-streak/trackers/:id', (req, res) => {
  suitStreak.removeTracker(req.params.id);
  res.json(suitStreak.status());
});

// ---------------------------------------------------------------------------
// « Dizaine — costume le plus / le moins sorti » (voir dizaine-top.js) —
// nouvelle stratégie du bouton Stratégies (demande admin) : comptage par
// dizaine de jeux (1-10, 11-20, 21-30…), choix du 1er/2e/3e/4e costume le
// plus ou le moins sorti, et plusieurs configurations enregistrables
// (fin de numéro, rattrapages, format, canal propres à chacune).
// ---------------------------------------------------------------------------
async function verifyDizaineChannels(list) {
  for (const id of (list || [])) {
    const check = await resolveChat(id);
    if (!check.ok) throw new Error(`Canal ${id} : ${check.error}`);
    if (check.chat && check.chat.title) dizaineTop.setChannelTitle(id, check.chat.title);
  }
}

app.get('/api/dizaine-top', (req, res) => res.json(dizaineTop.status()));

app.post('/api/dizaine-top/config', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.bestChannels !== undefined) await verifyDizaineChannels(dizaineTop.parseChannels(b.bestChannels));
    if (b.weakChannels !== undefined) await verifyDizaineChannels(dizaineTop.parseChannels(b.weakChannels));
    dizaineTop.configure(b);
    res.json(dizaineTop.status());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/dizaine-top/trackers', async (req, res) => {
  try {
    const b = req.body || {};
    await verifyDizaineChannels(dizaineTop.parseChannels(b.channels));
    const t = dizaineTop.addTracker({
      name: b.name, mode: b.mode, rank: b.rank, lead: b.lead,
      channels: b.channels, siteChannelId: b.siteChannelId, format: b.format, maxR: b.maxR,
    });
    res.json({ ok: true, tracker: t, dizaineTop: dizaineTop.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/dizaine-top/trackers/:id', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.channels !== undefined) await verifyDizaineChannels(dizaineTop.parseChannels(b.channels));
    const t = dizaineTop.updateTracker(req.params.id, b);
    if (!t) return res.status(404).json({ error: 'Configuration introuvable' });
    res.json({ ok: true, tracker: t, dizaineTop: dizaineTop.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/dizaine-top/trackers/:id', (req, res) => {
  dizaineTop.removeTracker(req.params.id);
  res.json(dizaineTop.status());
});

app.post('/api/dizaine-top/trackers/:id/test', async (req, res) => {
  const r = await dizaineTop.test(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

// bilan : aperçu du texte (sans envoi) et envoi immédiat (test)
app.get('/api/dizaine-top/bilan/preview', (req, res) => {
  res.json({ text: dizaineTop.buildBilanText(Date.now(), true) || "Aucune prédiction vérifiée aujourd'hui." });
});
app.post('/api/dizaine-top/welcome/test', async (req, res) => {
  const r = await (req.body && req.body.kind === 'weak' ? dizaineTop.testWeakWelcome() : dizaineTop.testWelcome());
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/dizaine-top/bilan/send', async (req, res) => {
  const r = await dizaineTop.sendBilan({ force: true });
  res.status(r.ok ? 200 : 400).json({ ok: r.ok, sent: r.sent || [], errors: r.errors || [], error: r.error || null, dizaineTop: dizaineTop.status() });
});

// « Retour après perte » (voir loss-return.js) : suit un canal, mesure quand un costume perdu revient (N+D / miroir / inverse)
// et envoie le rapport vers un autre canal.
// vue du bouton + configurations « Relance » proposées comme source (suivi interne, sans lire le canal)
function lossReturnView() {
  let relanceOptions = [];
  try { relanceOptions = (bestWeakTop.status().configs || []).filter((c) => c.mode === 'relance').map((c) => ({ id: c.id, name: c.name || 'Relance', channelNames: c.channelNames || [], maxR: c.maxR })); } catch (_) {}
  return { ...lossReturn.status(), relanceOptions };
}
async function verifyLossReturnChannels(list) {
  for (const id of (list || [])) {
    const check = await resolveChat(id);
    if (!check.ok) throw new Error(`Canal ${id} : ${check.error}`);
    if (check.chat && check.chat.title) lossReturn.setChannelTitle(id, check.chat.title);
  }
}
app.get('/api/loss-return', (req, res) => res.json(lossReturnView()));
app.post('/api/loss-return/configs', async (req, res) => {
  try {
    const b = req.body || {};
    await verifyLossReturnChannels(lossReturn.parseChannels(b.sources));
    await verifyLossReturnChannels(lossReturn.parseChannels(b.channels));
    const c = lossReturn.addConfig(b);
    res.json({ ok: true, config: c, lossReturn: lossReturnView() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/loss-return/configs/:id', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.sources !== undefined) await verifyLossReturnChannels(lossReturn.parseChannels(b.sources));
    if (b.channels !== undefined) await verifyLossReturnChannels(lossReturn.parseChannels(b.channels));
    const c = lossReturn.updateConfig(req.params.id, b);
    res.json({ ok: true, config: c, lossReturn: lossReturnView() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/loss-return/configs/:id', (req, res) => { lossReturn.removeConfig(req.params.id); res.json(lossReturnView()); });
app.post('/api/loss-return/configs/:id/bilan', async (req, res) => {
  const r = await lossReturn.sendBilan(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/loss-return/configs/:id/test', async (req, res) => {
  const r = await lossReturn.test(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

// « Relance après perte » (voir loss-relaunch.js) : suit des canaux ou des configurations Relance ; dès que la main du joueur
// du dernier rattrapage est complète, une perte prédit le même costume à N + R + D (D=1 = jeu suivant) dans le canal configuré.
// vue du bouton + configurations « Relance » proposées comme source (suivi interne de la relance, pas de la perte d'origine)
function lossRelaunchView() {
  let relanceOptions = [];
  try { relanceOptions = (bestWeakTop.status().configs || []).filter((c) => c.mode === 'relance').map((c) => ({ id: c.id, name: c.name || 'Relance', channelNames: c.channelNames || [], maxR: c.maxR })); } catch (_) {}
  return { ...lossRelaunch.status(), relanceOptions };
}
async function verifyLossRelaunchChannels(list) {
  for (const id of (list || [])) {
    const check = await resolveChat(id);
    if (!check.ok) throw new Error(`Canal ${id} : ${check.error}`);
    if (check.chat && check.chat.title) lossRelaunch.setChannelTitle(id, check.chat.title);
  }
}
app.get('/api/loss-relaunch', (req, res) => res.json(lossRelaunchView()));
app.post('/api/loss-relaunch/configs', async (req, res) => {
  try {
    const b = req.body || {};
    await verifyLossRelaunchChannels(lossRelaunch.parseChannels(b.sources));
    await verifyLossRelaunchChannels(lossRelaunch.parseChannels(b.channels));
    const c = lossRelaunch.addConfig(b);
    res.json({ ok: true, config: c, lossRelaunch: lossRelaunchView() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/loss-relaunch/configs/:id', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.sources !== undefined) await verifyLossRelaunchChannels(lossRelaunch.parseChannels(b.sources));
    if (b.channels !== undefined) await verifyLossRelaunchChannels(lossRelaunch.parseChannels(b.channels));
    const c = lossRelaunch.updateConfig(req.params.id, b);
    res.json({ ok: true, config: c, lossRelaunch: lossRelaunchView() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/loss-relaunch/configs/:id', (req, res) => { lossRelaunch.removeConfig(req.params.id); res.json(lossRelaunchView()); });
app.post('/api/loss-relaunch/configs/:id/test', async (req, res) => {
  const r = await lossRelaunch.test(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

// « Meilleur + plus faible » (voir best-weak-top.js) : un message à deux costumes (meilleur + plus faible) par jeu.
async function verifyBestWeakChannels(list) {
  for (const id of (list || [])) {
    const check = await resolveChat(id);
    if (!check.ok) throw new Error(`Canal ${id} : ${check.error}`);
    if (check.chat && check.chat.title) bestWeakTop.setChannelTitle(id, check.chat.title);
  }
}
app.get('/api/best-weak', (req, res) => res.json(bestWeakTop.status()));
// liste de TOUS les canaux (id + nom) qui reçoivent des prédictions, pour choisir ceux à suivre (mode « suivi »)
app.get('/api/best-weak/channels', (req, res) => {
  const multi = new Set(bestWeakTop.hasMultiChannels());
  const rows = configuredChannelList().map((r) => ({ ...r, multi: multi.has(String(r.id)) }));
  rows.sort((a, b) => Number(b.multi) - Number(a.multi));
  res.json({ channels: rows });
});
// « Détection auto » : canaux qui ont publié le format à deux costumes (♦️ 100% / N°1438 / ♣️ 92%). Le bot ne les découvre que
// lorsqu'il y est présent (administrateur) et qu'un message de ce format y est publié ; la liste se remplit toute seule.
app.get('/api/best-weak/detected', (req, res) => {
  const st = bestWeakTop.status();
  res.json({ channels: st.detected || [], scanning: (st.configs || []).filter((c) => c.mode === 'scan').length });
});
app.delete('/api/best-weak/detected/:id', (req, res) => {
  delete bestWeakTop.panel.detected[String(req.params.id)];
  bestWeakTop.persist();
  res.json({ channels: bestWeakTop.detectedList() });
});
app.post('/api/best-weak/configs', async (req, res) => {
  try {
    const b = req.body || {};
    await verifyBestWeakChannels(bestWeakTop.parseChannels(b.channels));
    if (b.relChannels !== undefined) await verifyBestWeakChannels(bestWeakTop.parseChannels(b.relChannels)); // canal de relance (facultatif)
    const c = bestWeakTop.addConfig(b);
    res.json({ ok: true, config: c, bestWeakTop: bestWeakTop.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/best-weak/configs/:id', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.channels !== undefined) await verifyBestWeakChannels(bestWeakTop.parseChannels(b.channels));
    if (b.relChannels !== undefined) await verifyBestWeakChannels(bestWeakTop.parseChannels(b.relChannels));
    const c = bestWeakTop.updateConfig(req.params.id, b);
    if (!c) return res.status(404).json({ error: 'Configuration introuvable' });
    res.json({ ok: true, config: c, bestWeakTop: bestWeakTop.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/best-weak/configs/:id', (req, res) => { bestWeakTop.removeConfig(req.params.id); res.json(bestWeakTop.status()); });
// « Stabilité du jeu » (voir game-stability.js) : désactivée par défaut ; le blocage se choisit canal par canal
app.get('/api/stability', (req, res) => res.json({ ...gameStability.status(), channels: configuredChannelList() }));
app.post('/api/stability/enabled', (req, res) => {
  gameStability.setEnabled(!!(req.body && req.body.enabled));
  res.json({ ...gameStability.status(), channels: configuredChannelList() });
});
app.post('/api/stability/channels', (req, res) => {
  try {
    const b = req.body || {};
    if (Array.isArray(b.ids)) gameStability.setBlockChannels(b.ids);
    else gameStability.toggleChannel(b.id, !!b.enabled);
    res.json({ ...gameStability.status(), channels: configuredChannelList() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/stability/threshold', (req, res) => {
  try {
    gameStability.setThreshold(req.body && req.body.threshold);
    res.json({ ...gameStability.status(), channels: configuredChannelList() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/stability/release', (req, res) => { gameStability.releaseBlock(); res.json(gameStability.status()); });
app.post('/api/best-weak/configs/:id/test', async (req, res) => {
  const r = await bestWeakTop.test(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/dizaine-top/scan', async (req, res) => {
  await dizaineTop.tick();
  res.json(dizaineTop.status());
});

// ---------------------------------------------------------------------------
// « Costume faible sur 2 cartes (miroir) » avec configurations
// (voir costume-faible-top.js) — même fonctionnement que la Dizaine :
// configurations multiples, bilan, canal des meilleures prédictions.
// ---------------------------------------------------------------------------
async function verifyCostumeFaibleChannels(list) {
  for (const id of (list || [])) {
    const check = await resolveChat(id);
    if (!check.ok) throw new Error(`Canal ${id} : ${check.error}`);
    if (check.chat && check.chat.title) costumeFaibleTop.setChannelTitle(id, check.chat.title);
  }
}

app.get('/api/costume-faible-top', (req, res) => res.json(costumeFaibleTop.status()));
app.post('/api/costume-faible-top/config', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.bestChannels !== undefined) await verifyCostumeFaibleChannels(costumeFaibleTop.parseChannels(b.bestChannels));
    if (b.weakChannels !== undefined) await verifyCostumeFaibleChannels(costumeFaibleTop.parseChannels(b.weakChannels));
    costumeFaibleTop.configure(b);
    res.json(costumeFaibleTop.status());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/costume-faible-top/trackers', async (req, res) => {
  try {
    const b = req.body || {};
    await verifyCostumeFaibleChannels(costumeFaibleTop.parseChannels(b.channels));
    await verifyCostumeFaibleChannels(costumeFaibleTop.parseChannels((Array.isArray(b.slots) ? b.slots : []).map((x) => (x && x.channel) || '')));
    const t = costumeFaibleTop.addTracker({
      name: b.name, rule: b.rule, lead: b.lead, slots: b.slots,
      channels: b.channels, siteChannelId: b.siteChannelId, format: b.format, maxR: b.maxR,
    });
    res.json({ ok: true, tracker: t, costumeFaibleTop: costumeFaibleTop.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/costume-faible-top/trackers/:id', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.channels !== undefined) await verifyCostumeFaibleChannels(costumeFaibleTop.parseChannels(b.channels));
    if (Array.isArray(b.slots)) await verifyCostumeFaibleChannels(costumeFaibleTop.parseChannels(b.slots.map((x) => (x && x.channel) || '')));
    const t = costumeFaibleTop.updateTracker(req.params.id, b);
    if (!t) return res.status(404).json({ error: 'Configuration introuvable' });
    res.json({ ok: true, tracker: t, costumeFaibleTop: costumeFaibleTop.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/costume-faible-top/trackers/:id', (req, res) => {
  costumeFaibleTop.removeTracker(req.params.id);
  res.json(costumeFaibleTop.status());
});
app.post('/api/costume-faible-top/trackers/:id/test', async (req, res) => {
  const r = await costumeFaibleTop.test(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});
app.get('/api/costume-faible-top/bilan/preview', (req, res) => {
  res.json({ text: costumeFaibleTop.buildBilanText(Date.now(), true) || "Aucune prédiction vérifiée aujourd'hui." });
});
app.post('/api/costume-faible-top/welcome/test', async (req, res) => {
  const r = await (req.body && req.body.kind === 'weak' ? costumeFaibleTop.testWeakWelcome() : costumeFaibleTop.testWelcome());
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/costume-faible-top/bilan/send', async (req, res) => {
  const r = await costumeFaibleTop.sendBilan({ force: true });
  res.status(r.ok ? 200 : 400).json({ ok: r.ok, sent: r.sent || [], errors: r.errors || [], error: r.error || null, costumeFaibleTop: costumeFaibleTop.status() });
});
app.post('/api/costume-faible-top/scan', async (req, res) => {
  await costumeFaibleTop.tick();
  res.json(costumeFaibleTop.status());
});

// ---------------------------------------------------------------------------
// « Chevauchement de prédictions » (voir overlap.js) — nouveau bouton
// (demande admin) : sélection d'UNE source (stratégie, IA, formation, ou un
// autre panneau), surveillance prédiction par prédiction — dès qu'une 2ᵉ
// prédiction arrive alors que la 1ʳᵉ n'est pas encore vérifiée, on déclenche
// SUR LA 2ᵉ (jamais la 1ʳᵉ), selon le mode choisi : même prédiction, costume
// miroir, ou +n jeux.
// ---------------------------------------------------------------------------
app.get('/api/overlap', async (req, res) => res.json({ ...overlap.status(), channelHints: await overlapSourceChannelHints() }));

app.post('/api/overlap/config', (req, res) => {
  overlap.configure(req.body || {});
  res.json(overlap.status());
});

app.post('/api/overlap/channel', async (req, res) => {
  const idsList = overlap.parseChannels(req.body && req.body.channelId);
  if (!idsList.length) return res.status(400).json({ error: 'ID de canal invalide' });
  const check = await resolveChat(idsList[0]);
  if (!check.ok) return res.status(400).json({ error: check.error });
  overlap.configure({ channels: idsList });
  if (check.chat && check.chat.title) overlap.setChannelTitle(idsList[0], check.chat.title);
  const notice = await overlap.test();
  res.json({ ok: true, channel: check.chat, notice, overlap: overlap.status() });
});

app.delete('/api/overlap/channel', (req, res) => {
  overlap.configure({ channels: [] });
  res.json(overlap.status());
});

app.post('/api/overlap/test', async (req, res) => {
  const r = await overlap.test();
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/overlap/scan', async (req, res) => {
  await overlap.tick();
  res.json(overlap.status());
});

app.post('/api/overlap/trackers', async (req, res) => {
  try {
    // accepte soit `keys` (tableau, sélection multiple), soit `key`
    // (rétrocompatibilité, une seule source) — mêmes réglages appliqués à
    // chacune, en un seul appel (voir overlap.addTrackers).
    const keys = Array.isArray(req.body && req.body.keys)
      ? req.body.keys
      : (req.body && req.body.key ? [req.body.key] : []);
    const r = overlap.addTrackers(keys, {
      mode: req.body && req.body.mode,
      offset: req.body && req.body.offset,
      channels: req.body && req.body.channels,
      siteChannelId: req.body && req.body.siteChannelId,
      format: req.body && req.body.format,
      maxR: req.body && req.body.maxR,
      name: req.body && req.body.name,
    });
    for (const t of (r.created || [])) rememberPanelTitles(overlap, t && t.channels);
    res.json({ ok: true, created: r.created, errors: r.errors, overlap: overlap.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/overlap/trackers/:id', (req, res) => {
  try {
    const t = overlap.updateTracker(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ error: 'Source suivie introuvable' });
    rememberPanelTitles(overlap, t && t.channels);
    res.json({ ok: true, tracker: t, overlap: overlap.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/overlap/trackers/:id', (req, res) => {
  overlap.removeTracker(req.params.id);
  res.json(overlap.status());
});

// ---------------------------------------------------------------------------
// « Statistiques » (voir statistics.js) — nouveau bouton (demande admin) :
// PAS un panneau de prédiction — relais brut des costumes/cartes reçus de
// l'API Baccara (les mêmes données que le bouton « Canaux ») vers un canal
// Telegram configuré, avec la notation demandée (✅/🔰/⏰/▶️/#T/#X/#R).
// ---------------------------------------------------------------------------
app.get('/api/statistics', (req, res) => res.json(statistics.status()));

app.post('/api/statistics/config', (req, res) => {
  statistics.configure(req.body || {});
  res.json(statistics.status());
});

app.post('/api/statistics/channel', async (req, res) => {
  const idsList = statistics.parseChannels(req.body && req.body.channelId);
  if (!idsList.length) return res.status(400).json({ error: 'ID de canal invalide' });
  const check = await resolveChat(idsList[0]);
  if (!check.ok) return res.status(400).json({ error: check.error });
  statistics.configure({ channels: idsList });
  const notice = await statistics.test();
  res.json({ ok: true, channel: check.chat, notice, statistics: statistics.status() });
});

app.delete('/api/statistics/channel', (req, res) => {
  statistics.configure({ channels: [] });
  res.json(statistics.status());
});

app.post('/api/statistics/test', async (req, res) => {
  const r = await statistics.test();
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/statistics/scan', async (req, res) => {
  await statistics.tick();
  res.json(statistics.status());
});

// ---------------------------------------------------------------------------
// « Rupture de costume » (voir suit-break.js) — nouveau bouton (demande
// admin) : sélection d'UNE source (stratégie, IA, ou formation), série de N
// prédictions CONSÉCUTIVES de MÊME costume, puis attente de la RUPTURE
// (prochaine prédiction d'un costume différent) — la rupture déclenche sur
// SON PROPRE numéro (pas de décalage), en prédisant le costume ORIGINAL de
// la série, avec le nombre de rattrapage configuré.
// ---------------------------------------------------------------------------
app.get('/api/suit-break', (req, res) => res.json(suitBreak.status()));

app.post('/api/suit-break/config', (req, res) => {
  suitBreak.configure(req.body || {});
  res.json(suitBreak.status());
});

app.post('/api/suit-break/channel', async (req, res) => {
  const idsList = suitBreak.parseChannels(req.body && req.body.channelId);
  if (!idsList.length) return res.status(400).json({ error: 'ID de canal invalide' });
  const check = await resolveChat(idsList[0]);
  if (!check.ok) return res.status(400).json({ error: check.error });
  suitBreak.configure({ channels: idsList });
  if (check.chat && check.chat.title) suitBreak.setChannelTitle(idsList[0], check.chat.title);
  const notice = await suitBreak.test();
  res.json({ ok: true, channel: check.chat, notice, suitBreak: suitBreak.status() });
});

app.delete('/api/suit-break/channel', (req, res) => {
  suitBreak.configure({ channels: [] });
  res.json(suitBreak.status());
});

app.post('/api/suit-break/test', async (req, res) => {
  const r = await suitBreak.test();
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/suit-break/scan', async (req, res) => {
  await suitBreak.tick();
  res.json(suitBreak.status());
});

app.post('/api/suit-break/trackers', async (req, res) => {
  try {
    const t = suitBreak.addTracker(req.body && req.body.key, {
      n: req.body && req.body.n,
      channels: req.body && req.body.channels,
      siteChannelId: req.body && req.body.siteChannelId,
      format: req.body && req.body.format,
      maxR: req.body && req.body.maxR,
      name: req.body && req.body.name,
    });
    rememberPanelTitles(suitBreak, t && t.channels);
    res.json({ ok: true, tracker: t, suitBreak: suitBreak.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/suit-break/trackers/:id', (req, res) => {
  try {
    const t = suitBreak.updateTracker(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ error: 'Source suivie introuvable' });
    rememberPanelTitles(suitBreak, t && t.channels);
    res.json({ ok: true, tracker: t, suitBreak: suitBreak.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/suit-break/trackers/:id', (req, res) => {
  suitBreak.removeTracker(req.params.id);
  res.json(suitBreak.status());
});

// Optimisation IA : teste chaque déclencheur (rattrapage 1/2/3, perdue) x
// chaque N sur l'historique réel de la stratégie suivie, et fait expliquer
// par l'IA la combinaison la plus performante observée (pas une garantie
// de 100% futur — voir commentaire dans after-loss.js).
app.post('/api/after-loss/trackers/:id/optimize', async (req, res) => {
  try {
    const result = await afterLoss.optimizeTracker(req.params.id);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- diagnostic complet des envois de prédictions ---------------------------
// v66 : la page « Envois » vérifiait chaque canal de chaque stratégie UN PAR UN, avec 4 appels Telegram par canal et sans mémoire :
// avec beaucoup de canaux elle mettait des dizaines de secondes (ou dépassait le délai) et son contenu restait inutilisable.
// Les résultats sont gardés 30 s (un canal commun à plusieurs stratégies n'est interrogé qu'une fois) et les vérifications partent en parallèle.
const _chatCache = new Map();
function resolveChatCached(id, ttlMs = 30000) {
  const k = String(id); const hit = _chatCache.get(k);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p;
  const p = resolveChat(id).then((r) => { if (!r || !r.ok) _chatCache.delete(k); return r; }, (e) => { _chatCache.delete(k); throw e; });
  _chatCache.set(k, { at: Date.now(), p });
  return p;
}
// récapitulatif par canal (strategy-recap.js) : état d'un canal / activation depuis « Envois → Organisation par canal »
app.get('/api/recap/:channel', (req, res) => {
  const id = String(req.params.channel || '').trim();
  const st = strategyRecap.status();
  res.json({ channel: id, enabled: strategyRecap.isEnabled(id), explicit: !!st.enabled[id], viaStrategy: st.viaStrategies.includes(id), tz: st.tz });
});
app.post('/api/recap/:channel', (req, res) => {
  const id = String(req.params.channel || '').trim();
  if (!id) return res.status(400).json({ error: 'Canal manquant' });
  strategyRecap.setChannelEnabled(id, !!(req.body && req.body.enabled));
  const st = strategyRecap.status();
  res.json({ ok: true, channel: id, enabled: strategyRecap.isEnabled(id), explicit: !!st.enabled[id], viaStrategy: st.viaStrategies.includes(id) });
});
app.get('/api/diagnostics/channels', async (req, res) => {
  const bot = botStatus();
  const out = [];
  for (const def of strategies.LIST) {
    const cfg = state.strategies[def.key] || {};
    const hasOwnPublished = (Array.isArray(cfg.publishedChannels) && cfg.publishedChannels.length) || (Array.isArray(cfg.channels) && cfg.channels.length);
    const publishedUsesFallback = !Array.isArray(cfg.publishedChannels) && !Array.isArray(cfg.channels);
    const entry = {
      key: def.key, name: def.name, enabled: !!cfg.enabled, silent: !!cfg.silent, published: [], shadow: [],
      sendError: state.sendErrors[def.key] || null, sentCount: cfg.sentCount || 0, lastSentAt: cfg.lastSentAt || null,
      // CORRECTIF « prédictions redirigées vers un autre canal » (demande admin) :
      // Une stratégie configurée n'est jamais redirigée vers un autre canal :
      // on expose séparément les canaux actifs globaux pour repérer uniquement
      // les anciennes configurations incomplètes.
      publishedUsesGlobalFallback: publishedUsesFallback,
    };
    for (const mode of ['published', 'shadow']) {
      const ids = strategyChannels(def.key, mode);
      const checks = await Promise.all(ids.map(async (id) => ({ id, check: bot.tokenSet ? await resolveChatCached(id) : { ok: false, error: 'Aucun token Telegram configuré' } })));
      for (const { id, check } of checks) {
        entry[mode].push(check.ok
          ? { id, title: check.chat.title, type: check.chat.type, canPost: check.chat.canPost, ok: check.chat.canPost !== false }
          : { id, ok: false, error: check.error });
      }
    }
    entry.ready = !!bot.tokenSet && (entry.published.some((c) => c.ok) || entry.shadow.some((c) => c.ok));
    out.push(entry);
  }

  // --- panneaux (après-perte, combinée, série/rupture de costume, comptage
  // 2/2, VIP, formation, Prédit IA, jeu 21) : chacun a un canal par défaut, et
  // pour ceux qui ont des « configurations suivies » (trackers), chaque
  // configuration peut avoir SON PROPRE canal ou retomber sur celui du
  // panneau — on expose les deux pour que ce soit visible d'un coup d'œil.
  async function resolveIds(ids) {
    const out2 = [];
    const checks2 = await Promise.all(ids.map(async (id) => ({ id, check: bot.tokenSet ? await resolveChatCached(id) : { ok: false, error: 'Aucun token Telegram configuré' } })));
    for (const { id, check } of checks2) {
      out2.push(check.ok
        ? { id, title: check.chat.title, type: check.chat.type, canPost: check.chat.canPost, ok: check.chat.canPost !== false }
        : { id, ok: false, error: check.error });
    }
    return out2;
  }

  async function trackerPanel(id, label, mod, editBase) {
    const st = mod.status();
    const defaultChannels = Array.isArray(st.channels) ? st.channels : [];
    const trackers = Array.isArray(st.trackers) ? st.trackers : [];
    return {
      id, label, editBase,
      defaultChannels: await resolveIds(defaultChannels),
      items: await Promise.all(trackers.map(async (t) => {
        const own = Array.isArray(t.channels) && t.channels.length;
        return {
          id: t.id, name: t.name || t.key || t.id,
          usesDefault: !own,
          channels: await resolveIds(own ? t.channels : defaultChannels),
        };
      })),
    };
  }

  async function singlePanel(id, label, mod, editBase) {
    const st = mod.status();
    const panel = st.config || st;
    return {
      id, label, editBase,
      enabled: panel.enabled !== false,
      sentCount: panel.sentCount || 0,
      lastSentAt: panel.lastSentAt || null,
      lastError: panel.lastError || null,
      channels: await resolveIds(Array.isArray(st.channels) ? st.channels : []),
    };
  }

  const panels = [];
  panels.push(await trackerPanel('after-loss', 'Prédiction après perte', afterLoss, 'after-loss'));
  panels.push(await trackerPanel('combined', 'Prédiction combinée', combined, 'combined'));
  panels.push(await trackerPanel('suit-streak', 'Série de même costume', suitStreak, 'suit-streak'));
  panels.push(await trackerPanel('suit-break', 'Rupture de costume', suitBreak, 'suit-break'));
  panels.push(await trackerPanel('overlap', 'Chevauchement de prédictions', overlap, 'overlap'));
  {
    const st = cardsCount.status();
    const cfg = st.config || st;
    const categoryChannels = cfg.categoryChannels && typeof cfg.categoryChannels === 'object'
      ? cfg.categoryChannels : {};
    const categories = {};
    for (const category of ['3/2', '3/3', '2/2']) {
      const own = Array.isArray(categoryChannels[category]) && categoryChannels[category].length;
      const effective = own ? categoryChannels[category] : (Array.isArray(cfg.channels) ? cfg.channels : []);
      categories[category] = {
        usesDefault: !own,
        channels: await resolveIds(effective),
      };
    }
    panels.push({
      id: 'cards-count', label: 'Comptage 3/2 · 3/3 · 2/2', editBase: 'cards-count',
      enabled: cfg.enabled !== false, sentCount: st.sentCount || 0,
      lastSentAt: st.lastSentAt || null, lastError: st.lastError || null,
      channels: await resolveIds(Array.isArray(cfg.channels) ? cfg.channels : []),
      categories,
    });
  }
  panels.push(await singlePanel('draw-two-three', 'Nul / 2-3', drawTwoThree, 'draw-two-three'));
  panels.push(await singlePanel('vip', 'VIP', vip, 'vip'));
  panels.push(await singlePanel('predit', 'Prédit IA', predit, 'predit'));
  // Jeu 21 a DEUX canaux distincts (exacte / valeur), pas un seul comme les
  // autres panneaux à canal unique — traité à part pour rester fidèle.
  {
    const g21 = game21Predict.status().config || {};
    panels.push({
      id: 'game21', label: 'Jeu 21', editBase: 'game21/predict',
      items: [
        { id: 'exacte', name: 'Format exact', usesDefault: false, channels: await resolveIds(Array.isArray(g21.exactChannels) ? g21.exactChannels : []) },
        { id: 'valeur', name: 'Format valeur', usesDefault: false, channels: await resolveIds(Array.isArray(g21.valueChannels) ? g21.valueChannels : []) },
      ],
    });
  }

  // Formation (relais) : un canal par défaut + un canal éventuel par stratégie suivie
  const frStatus = formationRelay.status();
  const frDefault = Array.isArray(frStatus.channels) ? frStatus.channels : [];
  panels.push({
    id: 'formation', label: 'Formation (relais)', editBase: 'formation/relay',
    defaultChannels: await resolveIds(frDefault),
    items: await Promise.all((frStatus.strategies || []).map(async (s) => {
      const own = Array.isArray(s.channels) && s.channels.length;
      return { id: s.key, name: s.name || s.key, usesDefault: !own, channels: await resolveIds(own ? s.channels : frDefault) };
    })),
  });

  // Vue consolidée : un même canal peut être utilisé par plusieurs stratégies
  // ou panneaux. On garde les sources pour expliquer immédiatement pourquoi
  // un message peut encore arriver dans un canal donné.
  const channelSources = new Map();
  const addSource = (c, source) => {
    if (!c || c.id == null) return;
    const key = String(c.id);
    if (!channelSources.has(key)) channelSources.set(key, { id: c.id, title: c.title || key, ok: c.ok, sources: [] });
    const row = channelSources.get(key);
    if (c.title) row.title = c.title;
    row.ok = row.ok !== false && c.ok !== false;
    if (!row.sources.includes(source)) row.sources.push(source);
  };
  for (const s of out) {
    s.published.forEach((c) => addSource(c, `${s.name} · public`));
    s.shadow.forEach((c) => addSource(c, `${s.name} · silencieux`));
  }
  for (const p of panels) {
    (p.channels || []).forEach((c) => addSource(c, p.label));
    (p.defaultChannels || []).forEach((c) => addSource(c, `${p.label} · défaut`));
    (p.items || []).forEach((item) => (item.channels || []).forEach((c) => addSource(c, `${p.label} · ${item.name}`)));
    Object.entries(p.categories || {}).forEach(([category, item]) =>
      (item.channels || []).forEach((c) => addSource(c, `${p.label} · ${category}${item.usesDefault ? ' · défaut' : ''}`)));
  }
  const globalChannels = await resolveIds(Array.isArray(state.activeChannels) ? state.activeChannels : []);
  globalChannels.forEach((c) => addSource(c, 'Canaux actifs globaux / référence'));
  // boutons qui n'étaient pas dans cette vue (Meilleur + plus faible, Relance, Test, Dizaine, Costume faible, Type de mise, Copie…)
  try { for (const c of configuredChannelList()) for (const src of c.sources) addSource({ id: c.id, title: c.title }, src); } catch (_) {}
  res.json({
    bot, control: predictionControl.status(),
    globalChannels,
    allChannels: [...channelSources.values()],
    strategies: out, panels,
  });
});


// ---------------------------------------------------------------------------
// Supprimer un canal PARTOUT (page « Envois ») : il est retiré de chaque réglage où il figure
// (stratégies public / silencieux, panneaux, configurations suivies, Meilleur + plus faible, Relance,
// Test, Dizaine, Costume faible, Type de mise, Copie et annonce, Jeu 21, Formation, canaux actifs).
// Les configurations elles-mêmes restent, mais sans ce canal.
// ---------------------------------------------------------------------------
const CHANNEL_LIST_KEY = /(channels|channelinfos?)$/i;
const CHANNEL_SKIP_KEYS = new Set(['sources', 'detected', 'channelTitles', 'pending', 'recentSent', 'watch', 'history', 'messages', 'blockChannels']);
function sameChannel(item, id) {
  const v = item && typeof item === 'object' ? (item.id != null ? item.id : item.chatId) : item;
  return v != null && String(v).trim().toLowerCase() === String(id).trim().toLowerCase();
}
// retire `id` de toutes les listes de canaux de `node` (récursif) ; retourne le nombre de retraits
function stripChannelDeep(node, id, depth = 0, seen = new Set()) {
  if (!node || typeof node !== 'object' || depth > 7 || seen.has(node)) return 0;
  seen.add(node);
  let n = 0;
  if (Array.isArray(node)) { for (const x of node) n += stripChannelDeep(x, id, depth + 1, seen); return n; }
  for (const key of Object.keys(node)) {
    if (CHANNEL_SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (key === 'channelId' && typeof v !== 'object' && v != null && v !== '' && sameChannel(v, id)) { node[key] = ''; n += 1; }
    else if (Array.isArray(v) && CHANNEL_LIST_KEY.test(key)) {
      const kept = v.filter((x) => !sameChannel(x, id));
      if (kept.length !== v.length) { n += v.length - kept.length; node[key] = kept; }
    } else if (key === 'categoryChannels' && v && typeof v === 'object') {
      for (const c of Object.keys(v)) if (Array.isArray(v[c])) { const kept = v[c].filter((x) => !sameChannel(x, id)); n += v[c].length - kept.length; v[c] = kept; }
    } else if (v && typeof v === 'object') n += stripChannelDeep(v, id, depth + 1, seen);
  }
  return n;
}
async function removeChannelEverywhere(id) {
  const removed = [];
  const note = (label, n) => { if (n > 0) removed.push(label); };
  for (const def of strategies.LIST) {
    const cfg = state.strategies[def.key];
    const n = stripChannelDeep(cfg, id);
    if (n > 0) { removed.push(def.name); try { if (db.ready) await db.saveStrategy(def.key, def.name, cfg); } catch (_) {} }
  }
  const modules = [
    ['Prédiction après perte', afterLoss], ['Prédiction combinée', combined], ['Répétition costume', suitStreak], ['Rupture costume', suitBreak],
    ['Chevauchement', overlap], ['VIP', vip], ['Prédit IA', predit], ['Comptage 2/2', cardsCount], ['Nul / 2-3', drawTwoThree], ['Statistiques', statistics],
    ['Dizaine', dizaineTop], ['Costume faible', costumeFaibleTop], ['Meilleur + plus faible / Relance / Test', bestWeakTop],
    ['Type de mise', betType], ['Copie et annonce', copyAnnounce], ['Jeu 21', game21Predict], ['Formation', formationRelay],
    ['J\'aime', likeReact], ['Retour après perte', lossReturn], ['Relance après perte', lossRelaunch],
  ];
  for (const [label, mod] of modules) {
    try {
      const n = stripChannelDeep(mod.panel, id);
      if (n > 0) {
        note(label, n);
        if (typeof mod.persist === 'function') await mod.persist(); else if (typeof mod.configure === 'function') mod.configure({});
      }
    } catch (e) { console.error('[channel-remove]', label, e.message); }
  }
  if (Array.isArray(state.activeChannels)) {
    const kept = state.activeChannels.filter((x) => !sameChannel(x, id));
    if (kept.length !== state.activeChannels.length) { state.activeChannels = kept; note('Canaux actifs', 1); }
  }
  // canaux où le bot a été ajouté (liste « Bot ajouté dans ce canal »)
  if (Array.isArray(state.channels)) {
    const kept = state.channels.filter((x) => !sameChannel(x, id));
    if (kept.length !== state.channels.length) { state.channels = kept; note('Bot ajouté dans ce canal', 1); }
  }
  // Compteur miroir : canal unique
  try { if (sameChannel(mirrorCounter.getChannel(), id)) { mirrorCounter.setChannel(''); note('Compteur miroir', 1); } } catch (_) {}
  // suivi interne de « J'aime » : états / diagnostics / liste détectée de ce canal
  try {
    const lp = likeReact.panel;
    for (const k of Object.keys(lp.states || {})) if (sameChannel(k, id)) delete lp.states[k];
    for (const k of Object.keys(lp.diag || {})) if (sameChannel(k, id)) delete lp.diag[k];
    lp.known = (lp.known || []).filter((r) => !sameChannel(r.id, id));
    likeReact.persist();
  } catch (_) {}
  // Mémoire de suppression : un canal qui n'était plus qu'une trace de l'historique des envois ne revient pas dans la liste.
  try {
    const cur = new Set(((store.read() || {}).ignoredChannels || []).map(String));
    cur.add(String(id).trim());
    store.patch({ ignoredChannels: [...cur] });
    if (db.ready) db.setSetting('ignored_channels', JSON.stringify([...cur])).catch(() => {});
  } catch (_) {}
  try { persist(); } catch (_) {}
  return removed;
}
app.delete('/api/diagnostics/channels/:id', async (req, res) => {
  try {
    const id = decodeURIComponent(String(req.params.id || '')).trim();
    if (!id) return res.status(400).json({ error: 'Identifiant de canal manquant' });
    const removed = await removeChannelEverywhere(id);
    res.json({ ok: true, id, removedFrom: removed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- interrupteur global « arrêter / démarrer / planifier » (même logique
// que les commandes /stop /start /planifier dans un canal, accessible aussi
// depuis le tableau de bord web) -------------------------------------------
app.post('/api/prediction-control', (req, res) => {
  try {
    const action = (req.body && req.body.action) || '';
    if (action === 'pause') return res.json({ ok: true, control: predictionControl.pause(req.body.reason, 'Tableau de bord') });
    if (action === 'resume') return res.json({ ok: true, control: predictionControl.resume('Tableau de bord') });
    if (action === 'schedule') return res.json({ ok: true, control: predictionControl.setSchedule(req.body.stopAt, req.body.startAt) });
    if (action === 'clear-schedule') return res.json({ ok: true, control: predictionControl.clearSchedule() });
    return res.status(400).json({ error: 'Action inconnue (attendu : pause, resume, schedule, clear-schedule).' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});


// ---------------------------------------------------------------------------
// Organisation des configurations PAR CANAL (page « Envois ») : on choisit un canal et on voit toutes les configurations qui
// y publient (stratégies de base, boutons à configurations suivies, Meilleur + plus faible / Relance / Test, Retour après perte),
// avec pour chacune : modifier (nom, activée, canaux) + enregistrer, retirer ce canal, supprimer la configuration.
// Les autres usages (Type de mise, Copie et annonce, Jeu 21, Formation…) restent visibles dans la liste « tous les canaux » et se
// modifient dans leur propre bouton.
// ---------------------------------------------------------------------------
const CC_TRACKER_PANELS = [
  ['after-loss', 'Prédiction après perte', afterLoss, '#/after-loss'], ['combined', 'Prédiction combinée', combined, '#/combined'],
  ['suit-streak', 'Répétition costume', suitStreak, '#/suit-streak'], ['suit-break', 'Rupture costume', suitBreak, '#/suit-break'],
  ['overlap', 'Chevauchement', overlap, '#/overlap'], ['dizaine-top', 'Dizaine', dizaineTop, '#/dizaine-top'],
  ['costume-faible-top', 'Costume faible', costumeFaibleTop, '#/costume-faible-top'],
];
const CC_SIMPLE_MODULES = [
  ['predit', 'Prédit IA', predit, '#/predit'], ['draw-two-three', 'Nul / 2-3', drawTwoThree, '#/draw-two-three'],
  ['vip', 'VIP', vip, '#/vip'], ['statistics', 'Statistiques', statistics, '#/statistics'],
  ['cards-count', 'Comptage 2/2', cardsCount, '#/cards-count'], ['formation', 'Formation', formationRelay, '#/formation'],
  ['like-react', 'J\'aime', likeReact, '#/like-react'],
];
function channelConfigsFor(channelId) {
  const out = [];
  const has = (arr) => (Array.isArray(arr) ? arr : []).some((x) => sameChannel(x, channelId));
  for (const def of strategies.LIST) {
    for (const mode of ['published', 'shadow']) {
      const ids = strategyChannels(def.key, mode);
      if (has(ids)) out.push({ kind: 'strategy', id: def.key, mode, group: 'Stratégies', name: `${def.name} · ${mode === 'shadow' ? 'silencieux' : 'public'}`, enabled: !!(state.strategies[def.key] || {}).enabled, channels: ids.map(String), page: `#/strategy/${def.key}`, canDelete: false });
    }
  }
  for (const [panelId, label, mod, page] of CC_TRACKER_PANELS) {
    for (const t of ((mod.panel && mod.panel.trackers) || [])) {
      if (has(t.channels)) out.push({ kind: 'tracker', panel: panelId, id: t.id, group: label, name: t.name || t.id, enabled: typeof t.enabled === 'boolean' ? t.enabled : null, channels: (t.channels || []).map(String), page, canDelete: true });
    }
  }
  for (const c of ((bestWeakTop.panel && bestWeakTop.panel.configs) || [])) {
    if (has(c.channels)) out.push({ kind: 'best-weak', id: c.id, group: 'Meilleur + plus faible / Relance / Test', name: c.name || c.id, enabled: c.enabled !== false, channels: (c.channels || []).map(String), page: c.mode === 'relance' ? '#/relance' : c.mode === 'test' ? '#/test' : '#/best-weak', canDelete: true });
  }
  for (const c of ((lossReturn.panel && lossReturn.panel.configs) || [])) {
    if (has(c.channels)) out.push({ kind: 'loss-return', id: c.id, group: 'Retour après perte', name: c.name || c.id, enabled: c.enabled !== false, channels: (c.channels || []).map(String), page: '#/loss-return', canDelete: true });
  }
  for (const c of ((lossRelaunch.panel && lossRelaunch.panel.configs) || [])) {
    if (has(c.channels)) out.push({ kind: 'loss-relaunch', id: c.id, group: 'Relance après perte', name: c.name || c.id, enabled: c.enabled !== false, channels: (c.channels || []).map(String), page: '#/loss-relaunch', canDelete: true });
  }

  // ---- Modules à réglage unique : Prédit IA, Nul / 2-3, VIP, Statistiques, Comptage 2/2, Formation (canal général)
  for (const [mid, label, mod, page] of CC_SIMPLE_MODULES) {
    const p = mod.panel || {};
    if (has(p.channels)) out.push({ kind: 'module', id: mid, group: label, name: `${label} · canaux`, fixedName: true, enabled: !!p.enabled, channels: (p.channels || []).map(String), page, canDelete: false });
  }
  for (const [cat, list] of Object.entries((cardsCount.panel && cardsCount.panel.categoryChannels) || {})) {
    if (has(list)) out.push({ kind: 'cards-category', id: cat, group: 'Comptage 2/2', name: `Comptage 2/2 · catégorie ${cat}`, fixedName: true, enabled: null, channels: list.map(String), page: '#/cards-count', canDelete: false });
  }
  const formationNames = {}; try { formationRelay.options().forEach((o) => { formationNames[o.key] = o.name; }); } catch (_) {}
  for (const [key, e] of Object.entries((formationRelay.panel && formationRelay.panel.strategies) || {})) {
    if (e && has(e.channels)) out.push({ kind: 'formation-strategy', id: key, group: 'Formation', name: `Formation · ${formationNames[key] || key}`, fixedName: true, enabled: !!e.enabled, channels: (e.channels || []).map(String), page: '#/formation', canDelete: false });
  }
  const g21 = game21Predict.panel || {};
  if (has(g21.exactChannels)) out.push({ kind: 'game21', id: 'exact', group: 'Jeu 21', name: 'Prédiction jeu 21 · valeur exacte', fixedName: true, enabled: !!g21.enabled, channels: (g21.exactChannels || []).map(String), page: '#/game21-predict', canDelete: false });
  if (has(g21.valueChannels)) out.push({ kind: 'game21', id: 'value', group: 'Jeu 21', name: 'Prédiction jeu 21 · valeur', fixedName: true, enabled: !!g21.enabled, channels: (g21.valueChannels || []).map(String), page: '#/game21-predict', canDelete: false });
  // ---- Listes : Type de mise (configurations + « meilleur ») et Copie et annonce (règles)
  for (const t of ((betType.panel && betType.panel.trackers) || [])) {
    if (has(t.destChannels)) out.push({ kind: 'bet-type', id: t.id, group: 'Type de mise', name: t.name || t.id, enabled: t.enabled !== false, channels: (t.destChannels || []).map(String), page: '#/bet-type', canDelete: true });
  }
  const btBest = (betType.panel && betType.panel.best) || {};
  if (has(btBest.channels)) out.push({ kind: 'bet-best', id: 'best', group: 'Type de mise', name: 'Type de mise · canal du meilleur', fixedName: true, enabled: !!btBest.enabled, channels: (btBest.channels || []).map(String), page: '#/bet-type', canDelete: false });
  for (const r of ((copyAnnounce.panel && copyAnnounce.panel.rules) || [])) {
    if (has(r.destChannels)) out.push({ kind: 'copy-announce', id: r.id, group: 'Copie et annonce', name: r.name || r.id, enabled: r.enabled !== false, channels: (r.destChannels || []).map(String), page: '#/copy-announce', canDelete: true });
  }
  // ---- Meilleur / plus faible de Dizaine et de Costume faible (canaux propres à chaque côté)
  for (const [panelId, label, mod, page] of [['dizaine-top', 'Dizaine', dizaineTop, '#/dizaine-top'], ['costume-faible-top', 'Costume faible', costumeFaibleTop, '#/costume-faible-top']]) {
    const p = mod.panel || {};
    for (const side of ['best', 'weak']) {
      const e = p[side] || {};
      if (has(e.channels)) out.push({ kind: 'top-side', panel: panelId, id: side, group: label, name: `${label} · ${side === 'best' ? 'meilleur' : 'plus faible'}`, fixedName: true, enabled: !!e.enabled, channels: (e.channels || []).map(String), page, canDelete: false });
    }
    // Costume faible : canal propre à chaque emplacement (slots) d'une configuration suivie
    for (const t of (p.trackers || [])) {
      const sc = (t.slots || []).map((x) => x && x.channel).filter((x) => x != null);
      if (has(sc)) out.push({ kind: 'slot', panel: panelId, id: t.id, group: label, name: `${label} · ${t.name || t.id} · emplacements`, fixedName: true, enabled: null, channels: sc.map(String), page, canDelete: false, readOnly: true });
    }
  }
  // ---- Meilleur + plus faible : canaux de relance (relChannels)
  for (const c of ((bestWeakTop.panel && bestWeakTop.panel.configs) || [])) {
    if (has(c.relChannels)) out.push({ kind: 'best-weak-rel', id: c.id, group: 'Meilleur + plus faible / Relance / Test', name: `${c.name || c.id} · relance vers`, fixedName: true, enabled: null, channels: (c.relChannels || []).map(String), page: '#/relance', canDelete: false });
  }
  // ---- Stabilité du jeu (canaux bloqués) et Compteur miroir (canal unique)
  try { const bc = (gameStability.panel && gameStability.panel.blockChannels) || []; if (has(bc)) out.push({ kind: 'game-stability', id: 'block', group: 'Stabilité du jeu', name: 'Stabilité du jeu · canaux bloqués', fixedName: true, enabled: null, channels: bc.map(String), page: '#/game-stability', canDelete: false }); } catch (_) {}
  try { const mc = mirrorCounter.getChannel(); if (mc && sameChannel(mc, channelId)) out.push({ kind: 'mirror', id: 'mirror', group: 'Compteur miroir', name: 'Compteur miroir · canal', fixedName: true, enabled: null, channels: [String(mc)], page: '#/mirror-counter', canDelete: false }); } catch (_) {}
  return out;
}
app.get('/api/diagnostics/channel-configs/:id', (req, res) => {
  const id = decodeURIComponent(String(req.params.id || '')).trim();
  if (!id) return res.status(400).json({ error: 'Identifiant de canal manquant' });
  res.json({ id, configs: channelConfigsFor(id) });
});
app.put('/api/diagnostics/channel-configs', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).trim();
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    const channels = b.channels !== undefined ? parseChannelList(b.channels) : undefined;
    if (b.kind === 'strategy') {
      const def = strategies.BY_KEY[b.id];
      if (!def) return res.status(404).json({ error: 'Stratégie inconnue' });
      const p = {};
      if (patch.enabled !== undefined) p.enabled = patch.enabled;
      if (channels !== undefined) { if (b.mode === 'shadow') p.shadowChannels = channels; else p.publishedChannels = channels; }
      const cfg = setStrategyConfig(b.id, p);
      persist();
      if (db.ready) await db.saveStrategy(b.id, def.name, cfg);
    } else if (b.kind === 'tracker') {
      const row = CC_TRACKER_PANELS.find((x) => x[0] === b.panel);
      if (!row) return res.status(404).json({ error: 'Panneau inconnu' });
      const cur = ((row[2].panel && row[2].panel.trackers) || []).find((x) => x.id === b.id);
      if (cur && typeof cur.enabled === 'boolean' && patch.enabled !== undefined) cur.enabled = patch.enabled; // enregistré par updateTracker juste après
      delete patch.enabled;
      const t = row[2].updateTracker(b.id, { ...patch, ...(channels !== undefined ? { channels } : {}) });
      if (!t) return res.status(404).json({ error: 'Configuration introuvable' });
    } else if (b.kind === 'best-weak') {
      if (channels !== undefined) await verifyBestWeakChannels(channels);
      const c = bestWeakTop.updateConfig(b.id, { ...patch, ...(channels !== undefined ? { channels } : {}) });
      if (!c) return res.status(404).json({ error: 'Configuration introuvable' });
    } else if (b.kind === 'loss-return') {
      lossReturn.updateConfig(b.id, { ...patch, ...(channels !== undefined ? { channels } : {}) });
    } else if (b.kind === 'loss-relaunch') {
      lossRelaunch.updateConfig(b.id, { ...patch, ...(channels !== undefined ? { channels } : {}) });
    } else if (b.kind === 'module') {
      const row = CC_SIMPLE_MODULES.find((x) => x[0] === b.id);
      if (!row) return res.status(404).json({ error: 'Module inconnu' });
      const p = {};
      if (patch.enabled !== undefined && patch.enabled !== !!row[2].panel.enabled) p.enabled = patch.enabled; // seulement si ça change (évite de réinitialiser un suivi en cours)
      if (channels !== undefined) p.channels = channels;
      row[2].configure(p);
    } else if (b.kind === 'cards-category') {
      const cat = String(b.id);
      if (!['3/2', '3/3', '2/2'].includes(cat)) return res.status(404).json({ error: 'Catégorie inconnue' });
      if (channels !== undefined) cardsCount.configure({ categoryChannels: { ...(cardsCount.panel.categoryChannels || {}), [cat]: channels } });
    } else if (b.kind === 'formation-strategy') {
      const cur = (formationRelay.panel.strategies || {})[b.id];
      if (!cur) return res.status(404).json({ error: 'Formation introuvable' });
      const p = {};
      if (patch.enabled !== undefined && patch.enabled !== !!cur.enabled) p.enabled = patch.enabled;
      if (channels !== undefined) p.channels = channels;
      formationRelay.setStrategy(String(b.id), p);
    } else if (b.kind === 'game21') {
      const p = {};
      if (patch.enabled !== undefined) p.enabled = patch.enabled;
      if (channels !== undefined) p[b.id === 'value' ? 'valueChannels' : 'exactChannels'] = channels;
      game21Predict.configure(p);
    } else if (b.kind === 'bet-best') {
      betType.configureBest({ ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(channels !== undefined ? { channels } : {}) });
    } else if (b.kind === 'bet-type') {
      const t = betType.updateConfig(b.id, { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(channels !== undefined ? { destChannels: channels } : {}) });
      if (!t) return res.status(404).json({ error: 'Configuration introuvable' });
    } else if (b.kind === 'top-side') {
      const mod = b.panel === 'dizaine-top' ? dizaineTop : b.panel === 'costume-faible-top' ? costumeFaibleTop : null;
      if (!mod || !['best', 'weak'].includes(String(b.id))) return res.status(404).json({ error: 'Configuration introuvable' });
      const p = {};
      if (patch.enabled !== undefined) p[`${b.id}Enabled`] = patch.enabled;
      if (channels !== undefined) p[`${b.id}Channels`] = channels;
      mod.configure(p);
    } else if (b.kind === 'best-weak-rel') {
      if (channels === undefined) return res.json({ ok: true });
      const c = bestWeakTop.updateConfig(b.id, { relChannels: channels });
      if (!c) return res.status(404).json({ error: 'Configuration introuvable' });
    } else if (b.kind === 'game-stability') {
      if (channels !== undefined) gameStability.setBlockChannels(channels);
    } else if (b.kind === 'mirror') {
      if (channels !== undefined) mirrorCounter.setChannel(channels[0] || '');
    } else if (b.kind === 'slot') {
      return res.status(400).json({ error: 'Les emplacements se modifient depuis le bouton Costume faible (lien « Ouvrir »).' });
    } else if (b.kind === 'copy-announce') {
      const r = copyAnnounce.updateRule(b.id, { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(channels !== undefined ? { destChannels: channels } : {}) });
      if (!r) return res.status(404).json({ error: 'Règle introuvable' });
    } else return res.status(400).json({ error: 'Type de configuration inconnu' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/diagnostics/channel-configs', (req, res) => {
  try {
    const { kind, panel: panelId, id } = req.query || {};
    if (kind === 'strategy') return res.status(400).json({ error: 'Une stratégie intégrée ne se supprime pas : retire-lui ce canal, ou mets-la en pause.' });
    if (kind === 'tracker') {
      const row = CC_TRACKER_PANELS.find((x) => x[0] === panelId);
      if (!row) return res.status(404).json({ error: 'Panneau inconnu' });
      row[2].removeTracker(String(id));
    } else if (kind === 'best-weak') bestWeakTop.removeConfig(String(id));
    else if (kind === 'loss-return') lossReturn.removeConfig(String(id));
    else if (kind === 'loss-relaunch') lossRelaunch.removeConfig(String(id));
    else if (kind === 'bet-type') betType.removeConfig(String(id));
    else if (kind === 'copy-announce') copyAnnounce.removeRule(String(id));
    else if (['module', 'cards-category', 'formation-strategy', 'game21', 'bet-best'].includes(kind)) return res.status(400).json({ error: 'Cette configuration est unique et ne se supprime pas : retire-lui ce canal, ou mets-la en pause.' });
    else return res.status(400).json({ error: 'Type de configuration inconnu' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
function parseChannelList(v) { return lossReturn.parseChannels(v); }

// édition rapide du canal d'une configuration suivie (tracker) DEPUIS la page
// « Envois » — mêmes règles que les routes /api/<panel>/trackers/:id déjà
// existantes (série/rupture de costume, après-perte, combinée) ou l'entrée
// « formation » par stratégie ; centralisé ici pour que le bouton « Canaux »
// n'ait qu'un seul endpoint à appeler quel que soit le panneau d'origine.
const TRACKER_PANELS = { 'after-loss': afterLoss, combined, 'suit-streak': suitStreak, 'suit-break': suitBreak, overlap };
app.put('/api/diagnostics/panels/:panel/trackers/:id/channel', async (req, res) => {
  const mod = TRACKER_PANELS[req.params.panel];
  if (!mod) return res.status(404).json({ error: 'Panneau inconnu' });
  try {
    const idsList = mod.parseChannels(req.body && req.body.channelId);
    const t = mod.updateTracker(req.params.id, { channels: idsList });
    if (!t) return res.status(404).json({ error: 'Configuration introuvable' });
    res.json({ ok: true, tracker: t });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/diagnostics/panels/game21/trackers/:id/channel', async (req, res) => {
  try {
    const kind = req.params.id === 'valeur' ? 'valeur' : 'exacte';
    const ids = game21Predict.parseChannels(req.body && req.body.channelId);
    if (ids.length) {
      const check = await resolveChat(ids[0]);
      if (!check.ok) return res.status(400).json({ error: check.error });
    }
    game21Predict.configure(kind === 'valeur' ? { valueChannels: ids } : { exactChannels: ids });
    res.json({ ok: true, status: game21Predict.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/diagnostics/panels/cards-count/categories/:category/channel', (req, res) => {
  const category = String(req.params.category);
  if (!['3/2', '3/3', '2/2'].includes(category)) return res.status(404).json({ error: 'Catégorie inconnue' });
  try {
    const current = cardsCount.status().config || cardsCount.status();
    const categoryChannels = { ...(current.categoryChannels || {}) };
    categoryChannels[category] = cardsCount.parseChannels(req.body && req.body.channelId);
    cardsCount.configure({ categoryChannels });
    res.json({ ok: true, status: cardsCount.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/diagnostics/panels/formation/trackers/:id/channel', (req, res) => {
  try {
    res.json(formationRelay.setStrategy(req.params.id, { channels: req.body && req.body.channelId ? [String(req.body.channelId).trim()] : [] }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// « Copie et annonce » (voir copy-announce.js) — règles : source (stratégie,
// stratégie enregistrée ou canal) → canal de destination, copie des
// prédictions et/ou annonces planifiées (intervalle ou heures pile).
// ---------------------------------------------------------------------------
// Liste de TOUS les canaux (id) déjà configurés quelque part — stratégies
// (public/silencieux), panneaux et leurs sources suivies, canaux actifs —
// pour le sélecteur « source = canal » et « destination » de Copie et annonce.
// Aucun appel réseau : les noms viennent des titres déjà relevés.
function configuredChannelList() {
  const rows = new Map();
  const titles = {};
  let discovered = [];
  try { discovered = likeReact.discoverChannels(); } catch (_) {}
  for (const r of discovered) if (r.title) titles[r.id] = r.title;
  for (const mod of [suitStreak, suitBreak, dizaineTop, costumeFaibleTop, bestWeakTop, lossReturn, lossRelaunch, overlap, copyAnnounce, betType]) {
    try { Object.assign(titles, (mod.status() || {}).channelTitles || {}); } catch (_) {}
  }
  const add = (id, source) => {
    if (id === null || id === undefined || id === '') return;
    const key = String(id);
    if (!rows.has(key)) rows.set(key, { id: key, title: titles[key] || '', sources: [] });
    const row = rows.get(key);
    if (!row.sources.includes(source)) row.sources.push(source);
  };
  try {
    for (const def of strategies.LIST) {
      for (const mode of ['published', 'shadow']) {
        for (const id of strategyChannels(def.key, mode)) add(id, `${def.name}${mode === 'shadow' ? ' · silencieux' : ''}`);
      }
    }
  } catch (_) {}
  const panelsList = [['Prédiction après perte', afterLoss], ['Prédiction combinée', combined], ['Répétition costume', suitStreak], ['Rupture costume', suitBreak], ['Chevauchement', overlap], ['VIP', vip], ['Prédit IA', predit], ['Type de mise', betType],
    // sources qui manquaient : leurs canaux n'apparaissaient pas dans « Type de mise »
    ['Dizaine', dizaineTop], ['Costume faible', costumeFaibleTop], ['Comptage 2/2', cardsCount], ['Nul / 2-3', drawTwoThree], ['Statistiques', statistics]];
  for (const [label, mod] of panelsList) {
    try {
      const st = mod.status() || {};
      (Array.isArray(st.channels) ? st.channels : []).forEach((id) => add(id, label));
      (Array.isArray(st.bestChannels) ? st.bestChannels : []).forEach((id) => add(id, `${label} · meilleur`));
      (Array.isArray(st.weakChannels) ? st.weakChannels : []).forEach((id) => add(id, `${label} · faible`));
      (Array.isArray(st.trackers) ? st.trackers : []).forEach((t) => (Array.isArray(t.channels) ? t.channels : []).forEach((id) => add(id, `${label} · ${t.name || t.key}`)));
    } catch (_) {}
  }
  // Recherche profonde dans le réglage de TOUS les boutons : toute liste « …channels » ou « channelId » est importée
  for (const [label, mod] of [['J\'aime', likeReact], ['Retour après perte', lossReturn], ['Relance après perte', lossRelaunch], ['Jeu 21', game21Predict], ['Formation', formationRelay],
    ['Type de mise', betType], ['Copie et annonce', copyAnnounce], ['Meilleur + plus faible / Relance / Test', bestWeakTop], ['Dizaine', dizaineTop],
    ['Costume faible', costumeFaibleTop], ['Chevauchement', overlap], ['Répétition costume', suitStreak], ['Rupture costume', suitBreak],
    ['Prédiction après perte', afterLoss], ['Prédiction combinée', combined], ['Comptage 2/2', cardsCount], ['Nul / 2-3', drawTwoThree], ['VIP', vip], ['Prédit IA', predit],
    ['Statistiques', statistics], ['Stabilité du jeu', gameStability]]) {
    try { likeReact.collectFrom(mod.panel, label, add); } catch (_) {}
  }
  try { const mc = mirrorCounter.getChannel(); if (mc) add(mc, 'Compteur miroir'); } catch (_) {}
  // Copie et annonce : canaux de destination des règles
  try { for (const r of (copyAnnounce.status().rules || [])) (r.destChannels || []).forEach((id) => add(id, `Copie et annonce · ${r.name || ''}`.trim())); } catch (_) {}
  // Jeu 21 : canaux des prédictions (exacte / valeur)
  try { const g = game21Predict.panel || {}; [...(g.exactChannels || []), ...(g.valueChannels || [])].forEach((id) => add(id, 'Jeu 21')); } catch (_) {}
  // Canaux où des prédictions ont réellement été publiées, même s'ils ne sont plus saisis dans un réglage
  try { for (const r of discovered) r.sources.forEach((s) => add(r.id, s)); } catch (_) {}
  try {
    const fr = formationRelay.status() || {};
    (Array.isArray(fr.channels) ? fr.channels : []).forEach((id) => add(id, 'Formation'));
  } catch (_) {}
  try { for (const c of (bestWeakTop.status().configs || [])) (c.channels || []).forEach((id) => add(id, `Meilleur + plus faible · ${c.name || c.strategyLabel}`)); } catch (_) {}
  (Array.isArray(state.activeChannels) ? state.activeChannels : []).forEach((id) => add(id, 'Canaux actifs'));
  return [...rows.values()];
}

app.get('/api/copy-announce', (req, res) => res.json({ ...copyAnnounce.status(), channels: configuredChannelList() }));

app.post('/api/copy-announce/config', (req, res) => {
  copyAnnounce.configure(req.body || {});
  res.json(copyAnnounce.status());
});

// Vérifie les canaux de destination auprès de Telegram (le bot doit y être
// administrateur) et retient leur nom pour l'affichage « Nom · id ».
async function checkCopyDest(list) {
  const titles = [];
  for (const id of (list || [])) {
    const check = await resolveChat(id);
    if (!check.ok) throw new Error(`${id} : ${check.error}`);
    if (check.chat && check.chat.canPost === false) throw new Error(`${id} : le bot ne peut pas publier dans ce canal`);
    if (check.chat && check.chat.title) copyAnnounce.setChannelTitle(id, check.chat.title);
    titles.push(id);
  }
  return titles;
}
app.post('/api/copy-announce/rules', async (req, res) => {
  try {
    const body = req.body || {};
    const dest = copyAnnounce.parseChannels(body.destChannels);
    if (botStatus().tokenSet) await checkCopyDest(dest);
    const rule = copyAnnounce.addRule(body);
    res.json({ ok: true, rule, copyAnnounce: copyAnnounce.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/copy-announce/rules/:id', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.destChannels !== undefined && botStatus().tokenSet) await checkCopyDest(copyAnnounce.parseChannels(body.destChannels));
    const rule = copyAnnounce.updateRule(req.params.id, body);
    if (!rule) return res.status(404).json({ error: 'Règle introuvable' });
    res.json({ ok: true, rule, copyAnnounce: copyAnnounce.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/copy-announce/rules/:id', (req, res) => {
  copyAnnounce.removeRule(req.params.id);
  res.json(copyAnnounce.status());
});

app.post('/api/copy-announce/rules/:id/test', async (req, res) => {
  const r = await copyAnnounce.test(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/copy-announce/scan', async (req, res) => {
  await copyAnnounce.tick();
  res.json(copyAnnounce.status());
});


// ---------------------------------------------------------------------------
// « Type de mise » (voir bet-type.js) : configurations (4 types) créées à
// partir des canaux déjà connus + « Meilleur type de mise ».
// ---------------------------------------------------------------------------
async function checkBetDest(list) {
  for (const id of (list || [])) {
    const check = await resolveChat(id);
    if (!check.ok) throw new Error(`${id} : ${check.error}`);
    if (check.chat && check.chat.canPost === false) throw new Error(`${id} : le bot ne peut pas publier dans ce canal`);
    if (check.chat && check.chat.title) betType.setChannelTitle(id, check.chat.title);
  }
}
const betTypeSnapshot = () => ({ ...betType.status(), allChannels: configuredChannelList() });

// « J'aime » (voir like-react.js) : canaux cochés dont les prédictions Type de
// mise reçoivent une réaction automatique selon leur type (1 à 4).
likeReact.setChannelSource(configuredChannelList);
const bestTestChannelList = () => {
  const ids = new Set((bestWeakTop.status().configs || [])
    .filter((c) => c.mode === 'test' && c.enabled !== false)
    .flatMap((c) => c.channels || []).map(String));
  return configuredChannelList().filter((channel) => ids.has(String(channel.id)));
};
const likeReactSnapshot = () => { const list = configuredChannelList(); return { ...likeReact.status(), allChannels: list, bestChannels: list }; };
app.get('/api/like-react', (req, res) => { likeReact.scan(); res.json(likeReactSnapshot()); });
app.post('/api/like-react/config', (req, res) => {
  try {
    likeReact.configure(req.body || {});
    likeReact.scan();
    res.json({ ok: true, likeReact: likeReactSnapshot() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/like-react/test', async (req, res) => {
  const chatId = (req.body || {}).chatId;
  if (chatId === undefined || chatId === null || chatId === '') return res.status(400).json({ ok: false, error: 'Canal manquant.' });
  res.json(await likeReact.testReaction(chatId));
});
app.post('/api/like-react/scan', (req, res) => { likeReact.scan(); res.json({ ok: true, likeReact: likeReactSnapshot() }); });

app.get('/api/bet-type', (req, res) => res.json(betTypeSnapshot()));

app.post('/api/bet-type/config', (req, res) => {
  betType.configure(req.body || {});
  res.json(betTypeSnapshot());
});

app.post('/api/bet-type/configs', async (req, res) => {
  try {
    const body = req.body || {};
    if (botStatus().tokenSet) await checkBetDest([...betType.parseChannels(body.destChannels), ...betType.parseChannels(body.bestChannels)]);
    const config = betType.addConfig(body);
    res.json({ ok: true, config, betType: betTypeSnapshot() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/bet-type/configs/:id', async (req, res) => {
  try {
    const body = req.body || {};
    if ((body.destChannels !== undefined || body.bestChannels !== undefined) && botStatus().tokenSet) await checkBetDest([...betType.parseChannels(body.destChannels), ...betType.parseChannels(body.bestChannels)]);
    const config = betType.updateConfig(req.params.id, body);
    if (!config) return res.status(404).json({ error: 'Configuration introuvable' });
    res.json({ ok: true, config, betType: betTypeSnapshot() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/bet-type/configs/:id', (req, res) => {
  betType.removeConfig(req.params.id);
  res.json(betTypeSnapshot());
});

app.post('/api/bet-type/configs/:id/test', async (req, res) => {
  const r = await betType.test(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/bet-type/best', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.channels !== undefined && botStatus().tokenSet) await checkBetDest(betType.parseChannels(body.channels));
    betType.configureBest(body);
    res.json({ ok: true, betType: betTypeSnapshot() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/bet-type/best/test', async (req, res) => {
  const r = await betType.testBest();
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/bet-type/bilan', async (req, res) => {
  const ok = await betType.sendBilan();
  res.status(ok ? 200 : 400).json({ ok, error: ok ? undefined : 'Aucun bilan envoyé (aucun résultat, ou aucun canal configuré)' });
});

app.post('/api/bet-type/scan', async (req, res) => {
  await betType.tick();
  res.json(betTypeSnapshot());
});


// ---------------------------------------------------------------------------
// Démarrage : on connecte la base et on sème le compte admin AVANT d'ouvrir
// le port. Sans ça, une tentative de connexion arrivant pendant le réveil du
// service (Render gratuit se met en veille) tombe sur "Base de données non
// connectée", ou pire, sur "Identifiants inconnus" si la base vient tout
// juste de répondre mais que le compte admin n'a pas encore été semé.
// ---------------------------------------------------------------------------
(async () => {
  const s = await db.connect();
  console.log(s.ready ? '🗄️ Base de données connectée' : `🗄️ Base non connectée : ${s.error}`);
  if (s.ready) {
    await auth.ensureAdminSeed();
    console.log('🔐 Compte admin vérifié/créé (' + auth.ADMIN_IDENTIFIER + ')');
  } else {
    console.error('⚠️ Le compte admin ne peut pas être créé tant que la base n\'est pas connectée — vérifiez DATABASE_URL sur Render.');
  }

  app.listen(config.PORT, '0.0.0.0', () => {
    console.log('Tableau de bord sur le port ' + config.PORT);
    game21.startLoop(6000);
    startLoop().then(() => {
      if (aiAuto.auto.enabled) aiAuto.start(persist);
      console.log('🤖 Analyseur IA temps réel démarré (clé configurée : ' + ((ai.keyLooksValid() || ai.geminiConfigured() || ai.groqConfigured() || ai.openrouterConfigured()) ? 'oui' : 'non configurée') + ')');
      // vérification réelle (appel réseau) du quota de chaque clé IA
      // configurée au démarrage, pour que le badge de la page Analyseur IA
      // n'affiche pas juste « clé présente » mais bien « clé valide et
      // quota disponible » dès l'ouverture du tableau de bord.
      ai.refreshQuotaStatus().catch((error) => {
        console.error('Vérification du quota IA au démarrage impossible :', error.message);
      });
    }).catch((error) => {
      console.error('Initialisation impossible :', error.message);
    });
  });
})();
