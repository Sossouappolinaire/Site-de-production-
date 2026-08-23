// server.js — tableau de bord web (Render) + API JSON. Protégé par identifiant/mot de passe.
const path = require('path');
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const pgSessionStore = require('connect-pg-simple')(session);
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
const predit = require('./predit');
const afterLoss = require('./after-loss');
const dayCompare = require('./day-compare');
const deployGen = require('./deploy-generator');
const shop = require('./shop');
const paiement = require('./paiement');
const {
  state, stats, predictionMessage, recentGames, SUITS,
  setStrategyConfig, resetStrategy, initStrategies, parityRuntime,
  strategyGames, bilanText, gameCategories, gateView, shadowRuntime,
  predictionsPanel, strategyChannels, unlockGate, sweepAutoUnlock,
  announcementsFor, siteChannelsView, addSiteChannel, removeSiteChannel, addSiteChannelMessage, siteChannelFeed,
} = require('./predictor');
const { startLoop, startBot, botStatus, disconnectBot, startShopBot, shopBotStatus, disconnectShopBot, activate, deactivate, persist, sendBilan, flushBilans, dropSender, announceConfig, announceMainBot, resolveChat, testSend, saveConfigsToDb, applyDbConfigs, setMainChannel } = require('./bot');

const app = express();
app.set('trust proxy', 1); // Render est derrière un proxy HTTPS : nécessaire pour les cookies "secure"
app.use(express.json());

// ---------------------------------------------------------------------------
// Sessions stockées en base Postgres (table "user_sessions", créée toute
// seule au démarrage) — sans ça (store par défaut = mémoire du process),
// tout le monde est déconnecté à chaque redémarrage/redéploiement Render.
// ---------------------------------------------------------------------------
const sessionPool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(config.DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 4,
});
sessionPool.on('error', (e) => console.error('Pool de sessions (pg) :', e.message));

app.use(session({
  store: new pgSessionStore({
    pool: sessionPool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 60, // purge des sessions expirées toutes les heures
  }),
  name: 'baccara.sid',
  secret: process.env.SESSION_SECRET || 'baccara-bot-changeme-secret',
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

// --- verrou d'accès : tout le reste du site exige une session valide ------
const PUBLIC_EXACT = new Set(['/health', '/login.html', '/favicon.ico', '/succes.html']);
const PUBLIC_PAIEMENT_PATTERNS = [/^\/api\/paiement\/webhook$/, /^\/api\/paiement\/statut\/[^/]+$/];
function isPublicPath(p) {
  if (PUBLIC_EXACT.has(p)) return true;
  if (p.startsWith('/api/auth/')) return true;
  // webhook FusionPay (appel serveur-à-serveur) et consultation du statut
  // depuis succes.html (navigateur de l'acheteur, jamais connecté au site) —
  // protégés par leur propre clé/référence, pas par une session admin.
  if (PUBLIC_PAIEMENT_PATTERNS.some((re) => re.test(p))) return true;
  return false;
}
app.use(async (req, res, next) => {
  if (isPublicPath(req.path)) return next();
  if (req.session && req.session.userId) {
    // vérifie, sur chaque requête, qu'un compte « user » n'a pas dépassé le
    // temps accordé par l'administrateur (coupure immédiate, même en pleine
    // session) — l'admin, lui, n'est jamais concerné par cette vérification.
    if (req.session.role !== 'admin') {
      const access = await auth.checkAccess(req.session.userId);
      if (!access.ok) {
        return req.session.destroy(() => {
          if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: access.error, blocked: !!access.blocked, telegram: access.telegram || null });
          }
          return res.redirect(`/login.html?blocked=1&telegram=${encodeURIComponent(access.telegram || auth.TELEGRAM_CONTACT)}`);
        });
      }
    }
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentification requise.' });
  return res.redirect('/login.html');
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

app.get('/health', (req, res) => res.send('ok'));

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

app.get('/api/state', async (req, res) => {
  const aiCreatedKeys = new Set(aiRepair.status().createdStrategyKeys || []);
  res.json({
    role: req.session ? req.session.role || null : null,
    b: state.B,
    maxR: state.maxR,
    hand: 'joueur',
    format: state.format,
    formatCount: fmt.FORMAT_COUNT,
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
    shopBot: shopBotStatus(),
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
  });
});

app.get('/api/games', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 30);
  res.json({ live: state.live, games: recentGames(limit) });
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

// --- bot de la boutique (token séparé, exclusivement dédié à shop.js) ------
app.get('/api/shop/bot', (req, res) => res.json(shopBotStatus()));

app.post('/api/shop/bot/token', async (req, res) => {
  const token = (req.body.token || '').trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) return res.status(400).json({ error: 'Token Telegram invalide' });
  const r = await startShopBot(token);
  res.status(r.ok ? 200 : 400).json({ ...r, bot: shopBotStatus() });
});

app.post('/api/shop/bot/restart', async (req, res) => {
  const r = await startShopBot();
  res.json({ ...r, bot: shopBotStatus() });
});

// Déconnexion volontaire du bot boutique — même principe que
// DELETE /api/bot/token ci-dessus, côté token séparé de la boutique.
app.delete('/api/shop/bot/token', async (req, res) => {
  const r = await disconnectShopBot();
  res.json({ ...r, bot: shopBotStatus() });
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
// Boutique — publication de stratégies vendues avec code de paiement.
// Lecture accessible à tout compte connecté (GET), écriture réservée à
// l'administrateur (voir le middleware générique plus haut : USER_WRITE_*).
// ---------------------------------------------------------------------------
app.get('/api/shop', (req, res) => {
  res.json({
    items: shop.listAll(),
    sources: {
      strategies: strategies.LIST.map((d) => ({ key: d.key, name: d.name, about: d.about, rate: (stats(d.key) || {}).rate ?? null })),
      ia: aiAuto.listStrategies(),
    },
    pricing: shop.getPricingSettings(),
  });
});

// Modifie le tarif d'une méthode/palier de vente : 'strategy' (catalogue),
// 'ia_100' (déclencheurs IA à 100% de réussite) ou 'ia_93' (93 à 99,99%).
// Appliqué à tous les articles déjà publiés du palier concerné (avec le
// montant en francs recalculé automatiquement) ET retenu comme nouveau
// défaut pour les prochaines publications (voir shop.setMethodPrice).
app.post('/api/shop/pricing', (req, res) => {
  try {
    const { method, price } = req.body || {};
    const result = shop.setMethodPrice(method, price);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Change le taux de change € -> F CFA utilisé pour calculer automatiquement
// le montant en francs des liens de paiement Money Fusion. Appliqué à tous
// les articles déjà publiés (montant recalculé) ET retenu comme nouveau
// défaut pour les prochaines publications (voir shop.setExchangeRate).
app.post('/api/shop/exchange-rate', (req, res) => {
  try {
    const { rate } = req.body || {};
    const result = shop.setExchangeRate(rate);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Change le taux de change $ -> F CFA utilisé pour le bouton « Soutien »
// (dons libres, distincts des ventes de stratégies).
app.post('/api/shop/support-rate', (req, res) => {
  try {
    const { rate } = req.body || {};
    const result = shop.setSupportRate(rate);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/shop', async (req, res) => {
  try {
    const { source, sourceKey, details, example, rate, realName, price, payAmountLocal } = req.body || {};
    const priceNum = Number.isFinite(price) ? price : null;
    const payAmountNum = Number.isFinite(payAmountLocal) ? payAmountLocal : null;
    let item;
    if (source === 'strategy' && sourceKey) {
      item = await shop.publishFromStrategy(sourceKey, { details, example, price: priceNum, payAmountLocal: payAmountNum });
    } else if (source === 'ia' && sourceKey) {
      const aiItem = aiAuto.listStrategies().find((s) => s.id === sourceKey || s.key === sourceKey);
      if (!aiItem) return res.status(404).json({ error: "Stratégie IA introuvable (peut-être expirée après 1h)." });
      item = await shop.publishFromAiStrategy(aiItem, { details, example, price: priceNum, payAmountLocal: payAmountNum });
    } else {
      item = await shop.createItem({ source: 'custom', realName, details, example, rate: Number.isFinite(rate) ? rate : null, price: priceNum, payAmountLocal: payAmountNum });
    }
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shop/:id', (req, res) => {
  const item = shop.updateItem(req.params.id, req.body || {});
  if (!item) return res.status(404).json({ error: 'Article introuvable.' });
  res.json({ ok: true, item });
});

app.delete('/api/shop/:id', (req, res) => {
  const ok = shop.deleteItem(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Article introuvable.' });
  res.json({ ok: true });
});

app.post('/api/shop/:id/code', (req, res) => {
  const item = shop.regenerateCode(req.params.id);
  if (!item) return res.status(404).json({ error: 'Article introuvable.' });
  res.json({ ok: true, item });
});

app.post('/api/shop/:id/rename', async (req, res) => {
  const item = await shop.renameItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Article introuvable.' });
  res.json({ ok: true, item });
});

app.post('/api/shop/:id/refresh-rate', (req, res) => {
  const item = shop.refreshRateFromStrategy(req.params.id);
  if (!item) return res.status(404).json({ error: 'Article introuvable.' });
  res.json({ ok: true, item });
});

// ---------------------------------------------------------------------------
// Paiement en ligne (Money Fusion) — voir paiement.js. Lien fixe, rien à
// configurer côté admin. Confirmation AUTOMATIQUE : dès que le navigateur
// du client charge succes.html (atteint, côté Money Fusion, uniquement
// après un paiement réellement validé), le paiement est marqué payé et le
// code affiché sur succes.html — voir paiement.markPaidOnArrival.
// ---------------------------------------------------------------------------
app.get('/api/paiement/config', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(paiement.getConfig());
});

// Marque un paiement en attente comme annulé/échoué (ex. nettoyage manuel
// d'une réservation abandonnée) sans envoyer de code.
app.post('/api/paiement/cancel/:ref', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const r = paiement.cancelPayment(req.params.ref);
  if (!r.ok) return res.status(404).json(r);
  res.json(r);
});

// Historique des transactions (lecture seule, pour info admin) — plus
// besoin d'y confirmer quoi que ce soit, tout est automatique.
app.get('/api/paiement/pending', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const list = paiement.listPending().map((r) => {
    const item = shop.getItem(r.itemId);
    return { ...r, aiName: item ? item.aiName : null };
  });
  res.json({ items: list });
});

// Consultée par la page succes.html (navigateur de l'acheteur, jamais
// connecté au site) pour afficher le code. succes.html n'est atteinte,
// côté Money Fusion, qu'après un paiement réellement validé (URL de succès
// configurée sur le compte Money Fusion) — ce premier appel confirme donc
// automatiquement le paiement (voir paiement.markPaidOnArrival) et affiche
// le code pendant les 3 minutes ; la stratégie est débloquée uniquement
// après saisie manuelle du code dans Telegram.
app.get('/api/paiement/statut/:ref', async (req, res) => {
  const record = await paiement.markPaidOnArrival(req.params.ref);
  if (!record) return res.status(404).json({ error: 'Paiement introuvable.' });
  const item = record.itemId ? shop.getItem(record.itemId) : null;
  res.json({
    status: record.status,
    kind: record.kind || 'item',
    code: record.status === 'failed' || record.kind === 'support' ? null : (record.code || null),
    aiName: item ? item.aiName : null,
    amount: record.amount,
    amountUsd: record.amountUsd ?? null,
    buyerName: record.buyerName || null,
    userId: record.userId || null,
    expiresAt: record.expiresAt || null,
  });
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
  const quota = configured ? await ai.checkPollinationsQuota() : null;
  res.json({ ok: true, configured, quota });
});

// clés Gemini / Groq saisissables à chaud depuis la page Analyseur IA —
// mêmes principe et route que /api/ai/key ci-dessus, avec persistance en base
// pour survivre à un redémarrage/redéploiement (voir applyDbConfigs dans bot.js).
// Chaque route vérifie AUSSI le quota (appel réel minimal au fournisseur) dès
// que la clé est appliquée, pour confirmer immédiatement à l'admin que le
// quota existe bien sur cette clé et qu'elle sera utilisée.
app.post('/api/ai/key/gemini', async (req, res) => {
  ai.setGeminiKey(req.body && req.body.key);
  if (db.ready) await db.setSetting('ai_gemini_key', ai.geminiKey());
  const configured = ai.geminiConfigured();
  const quota = configured ? await ai.checkGeminiQuota() : null;
  res.json({ ok: true, configured, quota });
});
app.post('/api/ai/key/groq', async (req, res) => {
  ai.setGroqKey(req.body && req.body.key);
  if (db.ready) await db.setSetting('ai_groq_key', ai.groqKey());
  const configured = ai.groqConfigured();
  const quota = configured ? await ai.checkGroqQuota() : null;
  res.json({ ok: true, configured, quota });
});
app.post('/api/ai/key/openrouter', async (req, res) => {
  ai.setOpenrouterKey(req.body && req.body.key);
  if (db.ready) await db.setSetting('ai_openrouter_key', ai.openrouterKey());
  const configured = ai.openrouterConfigured();
  const quota = configured ? await ai.checkOpenrouterQuota() : null;
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
      channels: req.body && req.body.channels,
      siteChannelId: req.body && req.body.siteChannelId,
      format: req.body && req.body.format,
    });
    // la stratégie suivie a été activée automatiquement par addTracker() —
    // on persiste ce changement comme le fait la route /api/strategies/:key,
    // sinon l'activation ne survit pas à un redémarrage/redéploiement.
    if (key && key !== 'ia' && strategies.BY_KEY[key]) {
      persist();
      if (db.ready) await db.saveStrategy(key, strategies.BY_KEY[key].name, state.strategies[key]);
    }
    res.json({ ok: true, tracker: t, afterLoss: afterLoss.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
app.get('/api/diagnostics/channels', async (req, res) => {
  const bot = botStatus();
  const out = [];
  for (const def of strategies.LIST) {
    const cfg = state.strategies[def.key] || {};
    const entry = { key: def.key, name: def.name, enabled: !!cfg.enabled, silent: !!cfg.silent, published: [], shadow: [], sendError: state.sendErrors[def.key] || null, sentCount: cfg.sentCount || 0, lastSentAt: cfg.lastSentAt || null };
    for (const mode of ['published', 'shadow']) {
      const ids = strategyChannels(def.key, mode);
      for (const id of ids) {
        const check = bot.tokenSet ? await resolveChat(id) : { ok: false, error: 'Aucun token Telegram configuré' };
        entry[mode].push(check.ok
          ? { id, title: check.chat.title, type: check.chat.type, canPost: check.chat.canPost, ok: check.chat.canPost !== false }
          : { id, ok: false, error: check.error });
      }
    }
    entry.ready = !!bot.tokenSet && (entry.published.some((c) => c.ok) || entry.shadow.some((c) => c.ok));
    out.push(entry);
  }
  res.json({ bot, strategies: out });
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
    startLoop().then(() => {
      if (aiAuto.auto.enabled) aiAuto.start(persist);
      console.log('🤖 Analyseur IA temps réel démarré (clé environnement : ' + (ai.keyLooksValid() ? 'oui' : 'non configurée') + ')');
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
