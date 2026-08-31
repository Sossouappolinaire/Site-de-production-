// bot.js — bot Telegram + boucle de prédiction/vérification
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const api = require('./api');
const store = require('./store');
const db = require('./db');
const predit = require('./predit');
const auth = require('./auth');
const aiAuto = require('./ai-auto');
const ai = require('./ai-analyzer');
const aiQa = require('./ai-qa');
const fmt = require('./formats');
const strategies = require('./strategies');
const afterLoss = require('./after-loss');
const formationRelay = require('./formation-relay');
const shoeReport = require('./shoe-report');
const aiRepair = require('./ai-repair');
const shop = require('./shop');
const paiement = require('./paiement');
const mirrorCounter = require('./mirror-counter');
const dataTransfer = require('./data-transfer');
const lossNotice = require('./loss-notice');
const {
  state, evaluate, verify, registerGames, setOnFinished, setOnShoeReset, setOnGateChange, setOnConfirm,
  predictionText, predictionMessage, liveText, stats, SUITS,
  initStrategies, setStrategyConfig, resetStrategy, strategyChannels, parityRuntime,
  bilanText, canSend, noteGateSent, gateView, autoView, noteSent, shadowRuntime, sweepAutoUnlock, unlockGate,
  fulfillAnnouncement, announcementsFor, queueFloor,
  setOnAnnouncementSave, setOnAnnouncementDelete, restoreAnnouncements,
} = require('./predictor');

let bot = null;
let shopBot = null;
let loopStarted = false;

const saved = store.read();
state.botToken = saved.botToken || config.BOT_TOKEN || '';
// Token API dédié EXCLUSIVEMENT à la boutique de stratégies (shop.js) —
// jamais partagé avec le bot principal ni avec un autre service.
state.shopBotToken = saved.shopBotToken || config.SHOP_BOT_TOKEN || '';
state.adminId = saved.adminId || config.ADMIN_ID;
if (Array.isArray(saved.channels)) state.channels = saved.channels;
if (Array.isArray(saved.activeChannels)) state.activeChannels = saved.activeChannels;
if (Array.isArray(saved.siteChannels)) state.siteChannels = saved.siteChannels;
if (saved.B) state.B = saved.B;
if (saved.maxR != null) state.maxR = saved.maxR;
state.hand = 'joueur';
if (saved.format) state.format = saved.format;
if (saved.template !== undefined) state.template = saved.template;
if (saved.strategies && typeof saved.strategies === 'object') state.strategies = saved.strategies;
if (Array.isArray(saved.aiAnalyses)) state.aiAnalyses = saved.aiAnalyses;
if (Array.isArray(saved.aiStrategies)) state.aiStrategies = saved.aiStrategies;
initStrategies();

// numéro de sabot (state.shoeSeq) pour lequel le bilan a déjà été envoyé —
// persisté pour ne pas en renvoyer un second après un redémarrage.
let lastBilanShoeSeq = saved.lastBilanShoeSeq || 0;

// CORRECTIF « bilan pendant l'envoi des prédictions » : le hook de reset de
// sabot (setOnShoeReset) est appelé en « fire-and-forget » par
// resetShoe()/registerGames() — nécessaire pour ne jamais bloquer
// resetShoe(), qui doit rester synchrone (d'autres écouteurs en dépendent :
// shoe-report.js, after-loss.js). On ne lance donc PAS flushBilans()
// directement depuis ce hook : on se contente de MÉMORISER qu'un bilan est
// dû, et c'est tick() ci-dessous qui l'exécute et l'ATTEND explicitement,
// juste après registerGames() et AVANT evaluate()/broadcast() — donc avant
// toute diffusion de prédiction du nouveau jour. Comme les tick() ne se
// chevauchent jamais (garde `ticking`), le bilan est ainsi garanti de
// s'envoyer intégralement, un jour à la fois, sans jamais se mélanger avec
// l'envoi des prédictions.
let pendingBilan = null;

// CORRECTIF : quand `persist()` est appelée alors que la base n'est pas
// joignable (coupure, veille Render Free…), l'écriture DB est silencieusement
// SAUTÉE — sans ce drapeau, rien ne se souvenait qu'un changement (ex. nouvel
// ID de canal) restait en attente. Résultat observé : à la reconnexion,
// `ensureDb()` relisait la DB (ancienne valeur) VERS l'état local et écrasait
// le changement qui n'avait jamais pu être enregistré — sur le moment ET
// après un redémarrage, puisque la DB (jamais mise à jour) reste la source
// de vérité au prochain démarrage.
let dbDirty = false;

function persist() {
  store.patch({
    botToken: state.botToken,
    shopBotToken: state.shopBotToken,
    adminId: state.adminId,
    channels: state.channels,
    activeChannels: state.activeChannels,
    siteChannels: state.siteChannels,
    B: state.B,
    maxR: state.maxR,
    hand: 'joueur',
    format: state.format,
    template: state.template,
    strategies: state.strategies,
    aiAnalyses: state.aiAnalyses,
    aiStrategies: state.aiStrategies,
    lastBilanShoeSeq,
  });
  if (db.ready) {
    // configuration complète (token, admin, canaux) : elle est relue au démarrage
    db.saveAppConfig({
      botToken: state.botToken || '',
      adminId: state.adminId || 0,
      channels: state.channels || [],
      activeChannels: state.activeChannels || [],
      siteChannels: state.siteChannels || [],
      B: state.B,
      maxR: state.maxR,
      format: state.format,
      template: state.template || '',
      savedAt: new Date().toISOString(),
    });
    // token de la boutique : clé séparée, jamais mêlée à saveAppConfig()
    // (qui ne concerne que le bot principal).
    db.setSetting('shop_bot_token', state.shopBotToken || '');
    db.setSetting('site_channels', JSON.stringify(state.siteChannels || []));
    db.setSetting('B', state.B);
    db.setSetting('maxR', state.maxR);
    db.setSetting('format', state.format);
    db.setSetting('template', state.template || '');
    // chaque stratégie est enregistrée en base : après un redémarrage le bot
    // repart exactement avec les configurations déjà enregistrées.
    for (const def of strategies.LIST) {
      const cfg = state.strategies[def.key];
      if (cfg) db.saveStrategy(def.key, def.name, cfg);
    }
    dbDirty = false;
  } else {
    // la base n'est pas joignable MAINTENANT : le changement est bien dans
    // data.json et en mémoire, mais pas encore en base. On le marque « en
    // attente » pour le pousser dès que la connexion revient (voir ensureDb).
    dbDirty = true;
  }
}

const isAdmin = (msg) => msg.from && msg.from.id === Number(state.adminId);
const deny = (id) => bot && bot.sendMessage(id, "⛔ Commande réservée à l'administrateur.");

function rememberChannel(chat) {
  if (!chat || !['channel', 'supergroup', 'group'].includes(chat.type)) return;
  if (!state.channels.some((c) => c.id === chat.id)) {
    state.channels.push({ id: chat.id, title: chat.title || String(chat.id) });
    persist();
    if (bot)
      bot.sendMessage(
        state.adminId,
        `📡 Nouveau canal détecté : *${chat.title}*\n\`${chat.id}\`\n\n` +
          `Lance \`/activer ${chat.id}\` pour y envoyer les prédictions.`,
        { parse_mode: 'Markdown' }
      );
  }
}

function listChannels() {
  if (!state.channels.length) return '_aucun_';
  return state.channels
    .map((c) => `${state.activeChannels.includes(c.id) ? '✅' : '⚪'} ${c.title} — \`${c.id}\``)
    .join('\n');
}

const HELP =
  '🎴 *Bot Baccara 1xbet — main du JOUEUR*\n\n' +
  'ℹ️ La boutique de stratégies (/start, /boutique, /langue) est sur son ' +
  'propre bot Telegram — ce bot-ci ne gère que les prédictions et l\'admin.\n\n' +
  '*Jeu*\n' +
  '/live — jeu réellement en cours (cartes + costumes joueur)\n' +
  '/stats — statistiques des prédictions\n' +
  '/reglages — réglages actuels\n\n' +
  '*Canaux*\n' +
  '/canaux — canaux où je suis admin\n' +
  '/activer <id> — activer les prédictions\n' +
  '/desactiver <id> — arrêter\n\n' +
  '*Prédiction*\n' +
  '/setb <n> — compteur B (apparitions consécutives max)\n' +
  '/setmaxr <n> — nombre de rattrapages vérifiés\n' +
  '/setformat <1-87> — style du message de prédiction (87 = nouveau format)\n' +
  '/formats [page] — liste des 87 styles (80-83 pair/impair, 84-86 ombre, 87 nouveau format)\n' +
  '/apercu <n> — aperçu complet d\'un style (⌛ / ✅ / ❌)\n' +
  '/settemplate <texte> — style personnalisé ({game} {emoji} {suit} {status} {maxR})\n' +
  '/notemplate — revenir au style numéroté\n\n' +
  '*Stratégies*\n' +
  '/strategies — liste des stratégies et leur état\n' +
  '/strategie <clé> — détail + configuration d\'une stratégie\n' +
  '/activerstrat <clé> — activer une stratégie\n' +
  '/desactiverstrat <clé> — désactiver une stratégie\n' +
  '/setstrat <clé> <format|maxr|b|lead|depart|var|decalage|streak|absence|silence|fenetre|template> <valeur>\n' +
  '/ombre — état de la stratégie « Prédiction dans l\'ombre »\n' +
  '/ombrecompte — comptage en temps réel du mode silencieux (phase actuelle, référence, écart, décompte, canal utilisé)\n' +
  '/ombrehistorique — historique des prédictions depuis la perte de référence, avec alerte si ça dépasse la limite configurée\n' +
  '/ombreannonces [n] — liste des annonces de position publiées (numéro de la perte confirmante + position, en attente ou envoyée), n dernières (20 par défaut)\n' +
  '/silence <clé> <on|off> [fenêtre] — mode silencieux 1 (réservé à la stratégie « ombre »)\n' +
  '/debloquer <clé|tout> — débloque immédiatement l\'envoi (déblocage auto après 10 min)\n' +
  '/filtres — état du filtre « double perte » de chaque stratégie\n' +
  '/sauverconfig — enregistrer toutes les configurations en base\n' +
  '/configs — lire les configurations enregistrées en base\n' +
  '/parite — état complet de la stratégie Pair/Impair (VAR)\n' +
  '/setparite <départ> <var> <décalage> <rattrapage> — configuration rapide\n' +
  '/resetstrat <clé> — remettre la configuration par défaut\n' +
  '/supprimerstrat <clé> — supprimer la configuration en base\n\n' +
  '*Stratégies IA*\n' +
  '/ia [n] — liste des stratégies créées par l\'IA (taux actuel et taux le plus bas)\n' +
  '/ia90 [seuil] — stratégies IA à 90% ou plus SANS jamais descendre sous ce seuil\n' +
  '/iabilan — bilan des prédictions IA (panneau Prédit)\n' +
  '/bilan — publier maintenant le bilan complet (toutes stratégies + IA)\n\n' +
  '*Base de données*\n' +
  '/setdb <url> — lien PostgreSQL Render\n' +
  '/db — état de la base\n' +
  '/base — nombre de lignes, dernier jeu, période couverte\n' +
  '/dates — dates disponibles\n' +
  '/jeux [2/04/2026] — résumé des jeux d\'une date\n' +
  '/derniers [n] — derniers jeux enregistrés\n' +
  '/jeu <numéro> — fiche complète d\'un jeu\n' +
  '/pred [date] — prédictions enregistrées + taux\n' +
  '/sql <SELECT ...> — requête de lecture seule\n\n' +
  '*Export / Import*\n' +
  '/exporter — envoie un fichier Excel avec toute la configuration (tokens, canaux, format, stratégies, stratégies IA, analyses IA)\n' +
  '/importer — puis envoie un fichier .xlsx (ou envoie-le directement, sans /importer) pour restaurer la configuration';

function settingsText() {
  return (
    `⚙️ *Réglages*\n` +
    `• Compteur B : *${state.B}*\n` +
    `• Rattrapages : *${state.maxR}*\n` +
    `• Main vérifiée : *joueur uniquement*\n` +
    `• Format : *${state.format}/${fmt.FORMAT_COUNT}*${state.template ? ' (template perso)' : ''}\n` +
    `• Compteurs : ${SUITS.map((s) => `${s}${state.counters[s]}`).join(' ')}\n` +
    `• Base de données : ${db.status().ready ? '🟢 connectée' : '🔴 non connectée'}`
  );
}

function fmtDate(d) {
  if (!d) return '—';
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const [y, mo, da] = s.split('-');
  return da ? `${da}/${mo}/${y}` : s;
}

function wire(b) {
  b.on('polling_error', (e) => { state.botError = e.message; });
  b.on('my_chat_member', (u) => {
    const status = u.new_chat_member && u.new_chat_member.status;
    if (['administrator', 'member', 'creator'].includes(status)) rememberChannel(u.chat);
  });
  b.on('channel_post', (m) => rememberChannel(m.chat));

  // ---------------------------------------------------------------------
  // La boutique de stratégies (shop.js) vit désormais sur son PROPRE bot
  // Telegram, avec son propre token (voir wireShop() + state.shopBotToken
  // ci-dessous) : le bot principal ne gère plus /boutique, /langue, /start
  // ni la saisie des codes de paiement.
  // ---------------------------------------------------------------------

  // « Écrire au bot » : tout message texte envoyé en privé qui n'est PAS une
  // commande (ne commence pas par /) est transmis à l'IA générale
  // (ai-qa.js) qui répond au nom de « Bak Sossou IA » en s'appuyant sur les
  // vraies données du bot. isAdmin détermine seulement si les détails
  // techniques d'une éventuelle erreur IA sont visibles (jamais montrés à un
  // utilisateur normal).
  b.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    if (!msg.chat || msg.chat.type !== 'private') return;

    try {
      const entry = await aiQa.ask(msg.text, { isAdmin: isAdmin(msg) });
      await b.sendMessage(msg.chat.id, entry.answer);
    } catch (_) {
      // question vide ou erreur imprévue : on reste silencieux plutôt que
      // de spammer l'utilisateur avec un message d'erreur technique.
    }
  });

  b.onText(/^\/(aide|help)/, (msg) =>
    b.sendMessage(msg.chat.id, HELP, { parse_mode: 'Markdown' })
  );

  // ---------------------------------------------------------------------
  // Export / import complet de la configuration (tokens, canaux, format,
  // configuration de chaque stratégie, stratégies créées par l'IA,
  // historique des analyses IA) en un classeur Excel — réservé à
  // l'administrateur : le fichier contient les tokens API en clair.
  // ---------------------------------------------------------------------
  b.onText(/^\/exporter\b/, async (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    try {
      const buffer = dataTransfer.exportBuffer();
      const filename = `baccara-config-${new Date().toISOString().slice(0, 10)}.xlsx`;
      await b.sendDocument(
        msg.chat.id,
        buffer,
        { caption: '📦 Export complet de la configuration (tokens, canaux, stratégies, stratégies IA, analyses IA).' },
        { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      );
    } catch (e) {
      await b.sendMessage(msg.chat.id, `❌ Export impossible : ${e.message}`);
    }
  });

  b.onText(/^\/importer\b/, (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    b.sendMessage(
      msg.chat.id,
      "📥 Envoie maintenant le fichier .xlsx à importer (ou envoie-le directement à tout moment, sans passer par /importer)."
    );
  });

  // n'importe quel document .xlsx envoyé par l'administrateur déclenche
  // l'import — pas besoin d'avoir tapé /importer juste avant.
  b.on('message', async (msg) => {
    if (!msg.document) return;
    if (!isAdmin(msg)) return; // silencieux : un compte non-admin n'a même pas confirmation que la fonctionnalité existe
    const name = String(msg.document.file_name || '');
    if (!/\.xlsx$/i.test(name)) return; // ignore les autres pièces jointes
    try {
      const link = await b.getFileLink(msg.document.file_id);
      const resp = await fetch(link);
      if (!resp.ok) throw new Error(`Téléchargement du fichier impossible (HTTP ${resp.status}).`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      const report = dataTransfer.importBuffer(buffer);
      persist();
      if (db.ready) await saveConfigsToDb();
      const lines = ['✅ Import terminé.'];
      if (report.applied.length) lines.push(`Appliqué : ${report.applied.join(', ')}`);
      if (report.skipped.length) lines.push(`Feuilles absentes dans ce fichier (ignorées, réglages actuels conservés) : ${report.skipped.join(', ')}`);
      lines.push("⚠️ Si le token du bot a changé, redémarre la connexion (Réglages → Bot Telegram → Enregistrer et redémarrer).");
      await b.sendMessage(msg.chat.id, lines.join('\n'));
    } catch (e) {
      await b.sendMessage(msg.chat.id, `❌ Import impossible : ${e.message}`);
    }
  });

  // /jeu SEUL = jeu en cours ; /jeu <n> est traité plus bas (fiche d'un jeu de la base)
  b.onText(/^\/(?:live|encours)\b|^\/jeu(?:@\w+)?\s*$/, (msg) =>
    b.sendMessage(msg.chat.id, liveText(), { parse_mode: 'Markdown' })
  );

  b.onText(/^\/reglages/, (msg) =>
    b.sendMessage(msg.chat.id, settingsText(), { parse_mode: 'Markdown' })
  );

  b.onText(/^\/canaux/, (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    b.sendMessage(msg.chat.id, `📋 *Canaux*\n${listChannels()}`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/setb(?:\s+(\d+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, `ℹ️ Usage : /setb <n>  (actuel : ${state.B})`);
    state.B = Math.max(1, parseInt(m[1], 10));
    for (const s of SUITS) if (state.counters[s] > state.B) state.counters[s] = 0;
    persist();
    b.sendMessage(
      msg.chat.id,
      `✅ B = ${state.B}\nLe compteur monte de 1 à ${state.B} quand le costume apparaît dans la main du joueur, retombe à 0 quand il manque, et repart à 1 après avoir atteint ${state.B}.`
    );
  });

  b.onText(/^\/setmaxr(?:\s+(\d+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, `ℹ️ Usage : /setmaxr <n>  (actuel : ${state.maxR})`);
    state.maxR = Math.max(0, Math.min(9, parseInt(m[1], 10)));
    persist();
    b.sendMessage(msg.chat.id, `✅ Rattrapages = ${state.maxR} : on vérifie le numéro prédit puis ${state.maxR} tour(s) suivant(s).`);
  });

  b.onText(/^\/setformat(?:\s+(\d+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const list = fmt.formatList(1, 26);
    if (!m[1])
      return b.sendMessage(
        msg.chat.id,
        `ℹ️ Usage : /setformat <1-${fmt.FORMAT_COUNT}>  (actuel : ${state.format})\n\n${list.text}\n\n➡️ /formats 2 pour la suite`
      );
    state.format = fmt.clampFormat(m[1]);
    state.template = null;
    persist();
    b.sendMessage(
      msg.chat.id,
      `✅ Format des prédictions = ${state.format}/${fmt.FORMAT_COUNT}\n\n` +
        `⌛ Prédiction :\n${fmt.formatPreview(state.format, { maxR: state.maxR })}\n\n` +
        `✅ Gagné :\n${fmt.formatPreview(state.format, { maxR: state.maxR, status: 'gagné', rattrapage: 1 })}\n\n` +
        `❌ Perdu :\n${fmt.formatPreview(state.format, { maxR: state.maxR, status: 'perdu', rattrapage: state.maxR })}`
    );
  });

  b.onText(/^\/formats(?:\s+(\d+))?/, (msg, m) => {
    const list = fmt.formatList(m[1] || 1, 26);
    b.sendMessage(
      msg.chat.id,
      `🎨 Styles de prédiction (${list.page}/${list.pages}) — ${fmt.FORMAT_COUNT} au total\n\n${list.text}\n\n` +
        `➡️ /formats <page> • /apercu <n> • /setformat <n>`
    );
  });

  b.onText(/^\/apercu(?:\s+(\d+))?/, (msg, m) => {
    if (!m[1]) return b.sendMessage(msg.chat.id, `ℹ️ Usage : /apercu <1-${fmt.FORMAT_COUNT}>`);
    const id = fmt.clampFormat(m[1]);
    b.sendMessage(
      msg.chat.id,
      `🎨 Style ${id}/${fmt.FORMAT_COUNT}\n\n⌛\n${fmt.formatPreview(id, { maxR: state.maxR })}\n\n` +
        `✅\n${fmt.formatPreview(id, { maxR: state.maxR, status: 'gagné', rattrapage: 1 })}\n\n` +
        `❌\n${fmt.formatPreview(id, { maxR: state.maxR, status: 'perdu', rattrapage: state.maxR })}`
    );
  });

  b.onText(/^\/settemplate(?:\s+([\s\S]+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1])
      return b.sendMessage(
        msg.chat.id,
        'ℹ️ Usage : /settemplate 🎯 #{game} | {emoji} {suit} | {status}\n' +
          'Variables : {game} {emoji} {suit} {status} {maxR} {rattrapage} {strategy}'
      );
    state.template = m[1].trim();
    persist();
    b.sendMessage(msg.chat.id, `✅ Template personnalisé actif :\n\n${fmt.renderMessage(state.format, { gameNumber: 1234, suit: '♦️', maxR: state.maxR }, state.template).text}`);
  });

  b.onText(/^\/notemplate/, (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    state.template = null;
    persist();
    b.sendMessage(msg.chat.id, `✅ Retour au style numéroté ${state.format}/${fmt.FORMAT_COUNT}.`);
  });

  b.onText(/^\/sethand(?:\s+(\w+))?/, (msg) =>
    b.sendMessage(
      msg.chat.id,
      'ℹ️ Ce bot analyse *uniquement la main du joueur*. La main du banquier est seulement enregistrée en base de données.',
      { parse_mode: 'Markdown' }
    )
  );

  b.onText(/^\/setdb(?:\s+(\S+))?/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /setdb postgresql://user:pass@host/db');
    const s = await db.connect(m[1]);
    b.sendMessage(msg.chat.id, s.ready ? '✅ Base de données connectée, tables créées.' : `❌ Échec : ${s.error}`);
  });

  b.onText(/^\/db\b/, (msg) => {
    const s = db.status();
    b.sendMessage(msg.chat.id, `🗄️ Base : ${s.ready ? '🟢 connectée' : '🔴 non connectée'}\n${s.url || 'aucun lien'}\n${s.error ? '⚠️ ' + s.error : ''}`);
  });

  b.onText(/^\/jeux(?:\s+(\S+))?/, async (msg, m) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const sum = await db.dailySummary(m[1]);
    if (!sum) return b.sendMessage(msg.chat.id, '⚠️ Date invalide. Exemple : /jeux 2/04/2026');
    b.sendMessage(
      msg.chat.id,
      `📅 *${sum.date}*\nJeux : ${sum.total}\n🧍 Joueur : ${sum.joueur} | 🏦 Banquier : ${sum.banquier} | 🤝 Égalité : ${sum.egalite}\n` +
        `Joueur pair ${sum.joueur_pair} / impair ${sum.joueur_impair}\nBanquier pair ${sum.banquier_pair} / impair ${sum.banquier_impair}`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/base\b/, async (msg) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const o = await db.overview();
    if (!o) return b.sendMessage(msg.chat.id, '⚠️ Lecture impossible.');
    b.sendMessage(
      msg.chat.id,
      `🗄️ *Contenu de la base*\n` +
        `• Jeux : ${o.games}\n• Prédictions : ${o.predictions}\n• Réglages : ${o.settings}\n` +
        `• Dernier jeu : ${o.dernier_jeu ? '#N' + o.dernier_jeu : '—'}\n` +
        `• Période : ${fmtDate(o.depuis)} → ${fmtDate(o.jusqua)}`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/dates\b/, async (msg) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const rows = await db.availableDates(15);
    if (!rows.length) return b.sendMessage(msg.chat.id, 'Aucune donnée enregistrée pour le moment.');
    b.sendMessage(msg.chat.id, `📅 Dates disponibles\n${rows.map((r) => `• ${fmtDate(r.played_on)} — ${r.total} jeux`).join('\n')}`);
  });

  b.onText(/^\/derniers(?:\s+(\d+))?/, async (msg, m) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const rows = await db.lastGames(Math.max(1, Math.min(30, parseInt(m[1], 10) || 10)));
    if (!rows.length) return b.sendMessage(msg.chat.id, 'Aucun jeu enregistré.');
    b.sendMessage(
      msg.chat.id,
      `🧾 Derniers jeux (main joueur)\n` +
        rows
          .map((r) => `#N${r.number} • ${(r.player_cards || []).join(' ') || '—'} = ${r.player_value ?? '—'} (${r.player_parity || '—'}) • ${r.winner || 'en cours'}`)
          .join('\n')
    );
  });

  b.onText(/^\/jeu\s+(\d+)/, async (msg, m) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const g = await db.gameByNumber(m[1]);
    if (!g) return b.sendMessage(msg.chat.id, `⚠️ Jeu #N${m[1]} introuvable en base.`);
    b.sendMessage(
      msg.chat.id,
      `🧾 *Jeu #N${g.number}* — ${fmtDate(g.played_on)}\n` +
        `🃏 Joueur : ${(g.player_cards || []).join(' ') || '—'} = *${g.player_value ?? '—'}* (${g.player_parity || '—'}, ${g.player_count ?? '—'} cartes)\n` +
        `🎯 Costumes joueur : ${(g.player_suits || []).join(' ') || '—'}\n` +
        `🏦 Banquier (archive) : ${(g.banker_cards || []).join(' ') || '—'} = ${g.banker_value ?? '—'}\n` +
        `🏁 Résultat : ${g.winner || '—'} • phase ${g.phase || '—'}`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/pred(?:ictions)?\b(?:\s+(\S+))?$/, async (msg, m) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const sum = await db.predictionSummary(m[1]);
    if (!sum) return b.sendMessage(msg.chat.id, '⚠️ Date invalide. Exemple : /pred 2/04/2026');
    const rows = await db.predictionsByDate(m[1], 15);
    const lines = rows.map((r) => {
      const ico = r.status === 'gagne' ? `✅ ${r.rattrapage ?? 0}` : r.status === 'perdu' ? '❌' : '⌛';
      return `#N${r.target} ${r.suit} +${r.max_r} → ${ico}`;
    });
    b.sendMessage(
      msg.chat.id,
      `🎯 *Prédictions ${fmtDate(sum.date)}*\nTotal ${sum.total} • ✅ ${sum.gagne} • ❌ ${sum.perdu} • ⌛ ${sum.attente} • taux *${sum.taux}%*\n` +
        `Rattrapage moyen : ${sum.r_moyen}\n\n${lines.join('\n') || '_aucune ligne_'}`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/sql\s+([\s\S]+)/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!db.ready) return b.sendMessage(msg.chat.id, '🔴 Aucune base de données connectée (/setdb).');
    const r = await db.readOnlyQuery(m[1], 20);
    if (r.error) return b.sendMessage(msg.chat.id, `❌ ${r.error}`);
    if (!r.rows.length) return b.sendMessage(msg.chat.id, '✅ Requête exécutée : 0 ligne.');
    const txt = r.rows.map((row) => JSON.stringify(row)).join('\n').slice(0, 3500);
    b.sendMessage(msg.chat.id, `✅ ${r.rows.length} ligne(s)\n\n${txt}`);
  });

  b.onText(/^\/activer\s+(-?\d+)/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const id = parseInt(m[1], 10);
    activate(id);
    b.sendMessage(msg.chat.id, `✅ Prédictions activées pour \`${id}\``, { parse_mode: 'Markdown' });
    try {
      await b.sendMessage(id, '🟢 *Prédictions actives*', { parse_mode: 'Markdown' });
    } catch (e) {
      b.sendMessage(msg.chat.id, `⚠️ Impossible d'écrire dans ce canal : ${e.message}`);
    }
  });

  b.onText(/^\/desactiver\s+(-?\d+)/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    deactivate(parseInt(m[1], 10));
    b.sendMessage(msg.chat.id, `🔴 Prédictions désactivées pour \`${m[1]}\``, { parse_mode: 'Markdown' });
  });


  // ---- stratégies ---------------------------------------------------------
  b.onText(/^\/strategies\b/, (msg) => {
    const lines = strategies.LIST.map((d) => {
      const c = state.strategies[d.key] || {};
      const st = stats(d.key);
      return `${c.enabled ? '🟢' : '🔴'} *${d.name}* — \`${d.key}\`\n` +
        `   format ${c.format}${d.key === 'matchnul' ? '/' + (c.formatDistribution || 79) : ''} • +${c.maxR} rattrapage(s)` +
        `${d.usesB ? ' • B=' + c.b : ''}` +
        `${d.key === 'parite' ? ` • départ ${c.startGame} • VAR ${c.varStep} • décalage ${c.decalage}` : ''}` +
        `${d.key === 'absente' ? ` • ${c.streak || 3} jeux consécutifs` : ''}` +
        ` • ${st.win}✅/${st.loss}❌ (${st.rate}%)`;
    });
    b.sendMessage(msg.chat.id, `🧠 *Stratégies*\n\n${lines.join('\n\n')}\n\n➡️ /strategie <clé>`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/strategie(?!s)(?:\s+(\w+))?/, (msg, m) => {
    const key = (m[1] || '').toLowerCase();
    const d = strategies.BY_KEY[key];
    if (!d) return b.sendMessage(msg.chat.id, `ℹ️ Usage : /strategie <${strategies.LIST.map((x) => x.key).join('|')}>`);
    const c = state.strategies[key] || {};
    const st = stats(key);
    b.sendMessage(
      msg.chat.id,
      `🧠 *${d.name}* (\`${d.key}\`)\n\n${d.about}\n\n` +
        `• État : ${c.enabled ? '🟢 active' : '🔴 arrêtée'}\n` +
        `• Format : ${c.format}/${fmt.FORMAT_COUNT}${key === 'matchnul' ? ` (distribution : ${c.formatDistribution || 79})` : ''}\n` +
        `• Rattrapages : +${c.maxR}\n` +
        (d.usesB ? `• Compteur B : ${c.b}\n` : '') +
        `• Prédiction lancée : +${c.lead} tour(s)\n` +
        (key === 'parite'
          ? `• Jeu de départ : ${c.startGame} • VAR : ${c.varStep} • Décalage : ${c.decalage}\n` +
            `• Séquence : ${strategies.triggerSequence(c.startGame, c.varStep, 8).join(' → ')} …\n`
          : '') +
        (key === 'absente' ? `• Jeux consécutifs sans la carte : ${c.streak || 3}\n` : '') +
        `• Canaux : ${(c.channels && c.channels.length ? c.channels.join(', ') : 'canaux actifs globaux')}\n` +
        `• Résultats : ${st.win}✅ / ${st.loss}❌ / ${st.pending}⌛ → ${st.rate}%\n\n` +
        `Aperçu :\n${fmt.formatPreview(c.format, { maxR: c.maxR })}`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/activerstrat(?:\s+(\w+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    if (!strategies.BY_KEY[key]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /activerstrat <clé>');
    setStrategyConfig(key, { enabled: true });
    persist();
    b.sendMessage(msg.chat.id, `🟢 Stratégie *${strategies.BY_KEY[key].name}* activée.`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/desactiverstrat(?:\s+(\w+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    if (!strategies.BY_KEY[key]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /desactiverstrat <clé>');
    setStrategyConfig(key, { enabled: false });
    persist();
    b.sendMessage(msg.chat.id, `🔴 Stratégie *${strategies.BY_KEY[key].name}* arrêtée.`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/setstrat(?:\s+(\w+)\s+(\w+)\s+([\s\S]+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /setstrat <clé> <format|formatdistribution|maxr|b|lead|template> <valeur>');
    const key = m[1].toLowerCase();
    if (!strategies.BY_KEY[key]) return b.sendMessage(msg.chat.id, `⚠️ Stratégie inconnue : ${key}`);
    const field = m[2].toLowerCase();
    const value = m[3].trim();
    const map = {
      format: 'format', formatdistribution: 'formatDistribution', maxr: 'maxR', b: 'b', lead: 'lead', template: 'template',
      depart: 'startGame', start: 'startGame', jeudepart: 'startGame',
      var: 'varStep', decalage: 'decalage', rattrapage: 'maxR',
      streak: 'streak', jeux: 'streak', consecutifs: 'streak',
      absence: 'absence', ombre: 'absence', scope: 'scope', main: 'scope',
      silence: 'silent', silencieux: 'silent', silent: 'silent',
      fenetre: 'lossWindow', intervalle: 'lossWindow', perte: 'lossWindow',
      resetgain: 'resetOnWin',
    };
    if (!map[field]) return b.sendMessage(msg.chat.id, '⚠️ Champ inconnu (format, formatdistribution, maxr, b, lead, depart, var, decalage, streak, absence, scope, silence, fenetre, resetgain, template).');
    const target = map[field];
    if (target === 'silent')
      return b.sendMessage(msg.chat.id, 'ℹ️ Le mode silencieux 1 est toujours actif pour « ombre » et n\'est pas désactivable ; il n\'existe pour aucune autre stratégie.');
    if ((target === 'lossWindow' || target === 'resetOnWin') && key !== 'ombre')
      return b.sendMessage(msg.chat.id, '⚠️ Le mode silencieux est réservé à la stratégie « ombre ».');
    let parsed = value;
    if (target === 'resetOnWin') parsed = /^(1|oui|on|true|actif)$/i.test(value);
    const cfg = setStrategyConfig(key, { [target]: parsed });
    persist();
    b.sendMessage(msg.chat.id, `✅ ${strategies.BY_KEY[key].name} → ${field} = ${cfg[target]}\n\n${fmt.formatPreview(cfg.format, { maxR: cfg.maxR })}`);
  });

  b.onText(/^\/ombre\b/, (msg) => {
    const r = shadowRuntime();
    const lines = r.suits.map((x) => `${x.suit} absent depuis ${x.absence} jeu(x)${x.watched ? ' 👁️ surveillé' : ''}`);
    b.sendMessage(
      msg.chat.id,
      `🕯️ *Prédiction dans l'ombre*\n` +
        `• État : ${r.enabled ? '🟢 active' : '🔴 arrêtée'}\n` +
        `• Absence minimum : *${r.absence}* jeux\n` +
        `• Prédiction au retour : *+${r.lead}*\n` +
        `• Périmètre : ${r.scope === 'joueur' ? 'main du joueur' : 'joueur + banquier'}\n` +
        `• Dernier jeu terminé : ${r.lastGame ? '#N' + r.lastGame : '—'}\n\n` +
        lines.join('\n') +
        `\n\n📡 ${r.gate.label}` +
        (r.prediction ? `\n🎯 En attente : ${r.prediction.label} sur #N${r.prediction.target}` : ''),
      { parse_mode: 'Markdown' }
    );
  });

  // comptage détaillé, en temps réel, du filtre silencieux de la stratégie « ombre » :
  // à chaque appel, l'état est recalculé à la volée (aucun cache) à partir des
  // pertes/gains réellement enregistrés, donc toujours à jour.
  b.onText(/^\/ombrecompte\b/, (msg) => {
    const g = gateView('ombre');
    const phaseTitle = {
      1: '1️⃣ Phase 1 — en attente de la première perte',
      2: '2️⃣ Phase 2 — perte de référence posée, mesure de l\'écart',
      3: g.armed ? '3️⃣ Phase 3 — envoi public autorisé' : '3️⃣ Phase 3 — décompte silencieux en cours',
    }[g.phase] || `Phase ${g.phase}`;

    const lines = [`🕯️ *Comptage en temps réel — Prédiction dans l'ombre*`, '',
      '🔕 Priorité : le mode silencieux passe AVANT tout (pas de déblocage automatique).', '',
      phaseTitle, ''];

    if (g.phase === 1) {
      lines.push('• Aucune perte de référence pour l\'instant.');
      lines.push('• Dès qu\'une prédiction silencieuse perd, le comptage démarre (phase 2).');
    } else if (g.phase === 2) {
      lines.push(`• Perte de référence : #N${g.since ?? '—'}`);
      lines.push(
        g.lossInterval
          ? `• Écart mesuré depuis cette perte : ${g.used} (confirmation si écart ≤ ${g.lossInterval})`
          : `• Écart mesuré depuis cette perte : ${g.used}/${g.lossWindow} (fenêtre max)`
      );
      lines.push(`• Pertes confirmées : ${g.losses}/${g.lossTrigger} nécessaire(s)`);
      lines.push('• Une nouvelle perte dans la fenêtre confirme ; un gain ou un écart trop grand relance la référence.');
    } else if (g.counting) {
      lines.push(`• Position à atteindre avant l'envoi public : N = ${g.position}`);
      lines.push(`• Prédictions comptées en silence : ${g.seen}/${g.position}`);
      lines.push('• La mesure de référence continue en parallèle (phase 2) : une nouvelle perte dans l\'intervalle ajoute une AUTRE position en file, sans jamais interrompre celle-ci.');
    } else if (g.armed) {
      lines.push('• Le seuil est atteint : la *prochaine prédiction* part publiquement dans le canal.');
      if (g.sendOnlyNext) lines.push('• Une seule prédiction sera envoyée, puis retour immédiat au silence.');
      if (g.resetOnWin !== false) lines.push('• Un gain public après l\'envoi remet le comptage à zéro.');
    }

    if (g.queueLength > 1) {
      lines.push('');
      lines.push(`📋 File d'attente (${g.queueLength} position(s), envoyées dans cet ordre) :`);
      g.queue.forEach((q, i) => {
        lines.push(`   ${i + 1}. N=${q.position} — ${q.ready ? 'prête (en attente de tour d\'envoi)' : `${q.seen}/${q.position} compté(s)`}`);
      });
    }

    lines.push('');
    lines.push(
      `⚙️ Réglages : ${g.lossTrigger} perte(s) requise(s) · intervalle max ${g.lossInterval || 'illimité'} · fenêtre ${g.lossWindow}`
    );
    lines.push('');
    lines.push(`📤 Prochaine prédiction : ${g.sending ? 'CANAL CONFIGURÉ' : 'aucun envoi (silence)'}`);
    lines.push(`📡 ${g.label}`);

    // --- explication concrète : pourquoi il n'y a (ou pas) de prédiction --
    // le filtre « double perte » et la détection « costume absent → retour »
    // sont deux mécanismes séparés. Le filtre peut être ARMÉ sans qu'aucune
    // prédiction existe encore (aucun costume n'est revenu), et inversement
    // une prédiction peut exister mais rester bloquée par le filtre.
    const r = shadowRuntime();
    lines.push('');
    lines.push('🔍 *Pourquoi (pas) de prédiction en ce moment :*');
    if (!r.enabled) {
      lines.push('• La stratégie ombre est actuellement 🔴 arrêtée (/activerstrat ombre pour la relancer).');
    } else if (r.prediction) {
      lines.push(
        `• Une prédiction est déjà calculée : ${r.prediction.label || r.prediction.suit} sur #N${r.prediction.target}.`
      );
      lines.push(
        g.sending
          ? '• Le filtre est ouvert : elle partira (ou est déjà partie) dans le canal public.'
          : '• Le filtre « double perte » n\'est pas encore ouvert : elle reste calculée en silence, invisible sur le canal public (visible sur le site).'
      );
    } else {
      const watched = r.suits.filter((x) => x.watched);
      if (!watched.length) {
        const closest = [...r.suits].sort((a, b) => b.absence - a.absence)[0];
        lines.push(
          `• Aucun costume n'est encore assez absent (seuil = ${r.absence} jeux) pour être mis sous surveillance.`
        );
        if (closest) {
          lines.push(`• Le plus proche : ${closest.suit} — absent depuis ${closest.absence}/${r.absence} jeu(x).`);
        }
      } else {
        lines.push(`• Sous surveillance (absent ≥ ${r.absence} jeux), en attente de RETOUR :`);
        for (const w of watched) lines.push(`   ${w.suit} — absent depuis ${w.absence} jeu(x)`);
        lines.push(`• Dès le retour d'un de ces costumes, la prédiction sera calculée sur le jeu + ${r.lead}.`);
      }
    }

    b.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // historique des prédictions de la stratégie ombre depuis la perte de
  // référence actuelle (g.since) — avec alerte si leur nombre dépasse la
  // limite configurée (intervalle max, ou fenêtre si aucun intervalle réglé).
  b.onText(/^\/ombrehistorique\b/, (msg) => {
    const g = gateView('ombre');

    if (g.since == null) {
      return b.sendMessage(
        msg.chat.id,
        `📜 *Historique — Prédiction dans l'ombre*\n\n` +
          `Aucune perte de référence pour l'instant.\n📡 ${g.label}`,
        { parse_mode: 'Markdown' }
      );
    }

    const list = state.predictions
      .filter((p) => p.strategy === 'ombre' && p.target >= g.since)
      .sort((a, b2) => a.target - b2.target);

    const badgeFor = (p) =>
      p.status === 'gagné' ? '✅' : p.status === 'perdu' ? '❌' : '⌛';

    const lines = [`📜 *Historique — Prédiction dans l'ombre*`, '',
      `• Perte de référence : #N${g.since}`, ''];

    if (!list.length) {
      lines.push('• (Aucune prédiction retrouvée pour ce numéro — historique probablement purgé.)');
    } else {
      list.forEach((p, i) => {
        lines.push(
          `${i === 0 ? '🔻' : '  •'} #N${p.target} ${badgeFor(p)} ${p.label || p.suit || ''}`.trimEnd()
        );
      });
    }

    const done = list.filter((p) => p.status !== 'en attente');
    const usingInterval = !!g.lossInterval;
    const limit = usingInterval ? g.lossInterval : g.lossWindow;
    const limitLabel = usingInterval ? `intervalle max ${g.lossInterval}` : `fenêtre ${g.lossWindow}`;

    lines.push('');
    lines.push(`⚙️ Réglages : ${limitLabel} · ${g.lossTrigger} perte(s) requise(s)`);
    lines.push(`📊 Prédictions terminées depuis la référence : ${done.length}/${limit}`);

    if (done.length > limit) {
      lines.push('');
      lines.push(
        `⚠️ Ce nombre dépasse la limite configurée (${limitLabel}). ` +
          `Normalement, dès que l'écart dépasse cette limite, la perte suivante ` +
          `devient automatiquement la NOUVELLE référence (repart à zéro) — un ` +
          `dépassement visible ici signale que ça n'a pas (encore) été traité ` +
          `ainsi. Vérifiez /ombrecompte pour l'état exact du filtre.`
      );
    }

    lines.push('');
    lines.push(`📡 ${g.label}`);

    b.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // liste des annonces de position publiées (« la prochaine sera la Nᵉ à venir »),
  // identifiées par le numéro de la perte confirmante + la position annoncée.
  // Statuts : en attente (décompte en cours) / envoyée (avec le n° du jeu
  // réellement envoyé au canal public). Une annonce interrompue par une
  // nouvelle perte ne se réalise jamais et disparaît de cette liste.
  b.onText(/^\/ombreannonces(?:\s+(\d+))?/, (msg, m) => {
    const limit = m[1] ? Math.max(1, Math.min(100, parseInt(m[1], 10))) : 20;
    const list = announcementsFor('ombre', limit);

    if (!list.length) {
      return b.sendMessage(
        msg.chat.id,
        `📋 *Annonces de position — Prédiction dans l'ombre*\n\nAucune annonce pour l'instant.`,
        { parse_mode: 'Markdown' }
      );
    }

    const lines = [`📋 *Annonces de position — Prédiction dans l'ombre*`, ''];
    for (const a of list) {
      const icon = a.status === 'envoyee' ? '✅' : '⌛';
      let line = `${icon} Jeu perdu #N${a.refNumber} → position ${ordinalFr(a.position)}`;
      line += a.status === 'envoyee' ? ` — envoyée sur #N${a.sentNumber}` : ' — en attente';
      lines.push(line);
    }

    const pending = list.filter((a) => a.status === 'en_attente').length;
    lines.push('');
    lines.push(`📊 ${list.length} affichée(s) · ${pending} en attente`);

    b.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  b.onText(/^\/silence(?:\s+(\w+))?(?:\s+(\d+))?(?:\s+(\d+))?(?:\s+(\w+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    if (!strategies.BY_KEY[key])
      return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /silence <clé> [nombre max de prédictions après une perte] [intervalle MAX (écart) avant confirmation] [unique:on|off]');
    if (key !== 'ombre')
      return b.sendMessage(msg.chat.id, '⚠️ Le mode silencieux est réservé à la stratégie « ombre » et y est toujours actif (non désactivable).');
    const patch = {};
    if (m[2]) patch.lossWindow = parseInt(m[2], 10);
    if (m[3]) patch.lossInterval = parseInt(m[3], 10);
    if (m[4]) patch.sendOnlyNext = /^(on|oui|1|actif|true|unique)$/i.test(m[4]);
    const cfg = setStrategyConfig(key, patch);
    persist();
    b.sendMessage(
      msg.chat.id,
      `🔕 ${strategies.BY_KEY[key].name}\n` +
        `• Mode silencieux : toujours activé (non désactivable pour cette stratégie)\n` +
        `• Prédictions max après une perte : ${cfg.lossWindow}\n` +
        `• Intervalle MAX (écart) avant confirmation : ${cfg.lossInterval || 0}\n` +
        `• Envoi : ${cfg.sendOnlyNext ? 'une seule prédiction puis retour au silence' : 'continu jusqu’à un gain'}\n` +
        `• Retour au silence après un gain : ${cfg.resetOnWin === false ? 'non' : 'oui'}\n\n` +
        gateView(key).label
    );
  });

  b.onText(/^\/debloquer(?:\s+(\w+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    const keys = key === 'tout' || key === 'all' || !key
      ? strategies.LIST.map((d) => d.key)
      : strategies.BY_KEY[key] ? [key] : null;
    if (!keys) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /debloquer <clé|tout>');
    for (const k of keys) unlockGate(k, true);
    b.sendMessage(msg.chat.id, `🔓 Débloqué : ${keys.map((k) => strategies.BY_KEY[k].name).join(', ')}`);
  });

  b.onText(/^\/filtres\b/, (msg) => {
    const lines = strategies.LIST.map((d) => {
      const g = gateView(d.key);
      return `${g.sending ? '🟢' : '🔕'} *${d.name}* — ${g.label}`;
    });
    b.sendMessage(msg.chat.id, `📡 *Filtres d'envoi*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/sauverconfig\b/, async (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const r = await saveConfigsToDb();
    b.sendMessage(msg.chat.id, r.ok
      ? `💾 Configurations enregistrées en base : ${r.saved.join(', ')}`
      : `⚠️ ${r.error}`);
  });

  b.onText(/^\/configs\b/, async (msg) => {
    if (!db.ready) return b.sendMessage(msg.chat.id, '⚠️ Base de données non connectée.');
    const rows = await db.loadStrategies();
    const keys = Object.keys(rows);
    if (!keys.length) return b.sendMessage(msg.chat.id, 'ℹ️ Aucune configuration enregistrée en base pour le moment.');
    const lines = keys.map((k) => {
      const c = rows[k] || {};
      const name = strategies.BY_KEY[k] ? strategies.BY_KEY[k].name : k;
      return `• *${name}* — ${c.enabled ? 'active' : 'arrêtée'} • format ${c.format} • +${c.maxR} • ` +
        `silence ${c.silent ? 'oui' : 'non'} (${c.lossWindow || 3}) • canal ${(c.channels || []).join(', ') || '—'}`;
    });
    b.sendMessage(msg.chat.id, `🗄️ *Configurations en base*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/resetstrat(?:\s+(\w+))?/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    if (key === 'all' || key === 'tout') {
      const done = [];
      for (const def of strategies.LIST) {
        const cfg = resetStrategy(def.key);
        if (!cfg) continue;
        if (db.ready) await db.saveStrategy(def.key, def.name, cfg);
        done.push(def.name);
      }
      persist();
      return b.sendMessage(msg.chat.id, `♻️ *${done.length} stratégie(s)* remise(s) aux valeurs par défaut du code.`, { parse_mode: 'Markdown' });
    }
    const cfg = resetStrategy(key);
    if (!cfg) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /resetstrat <clé> (ou /resetstrat all)');
    // CORRECTIF : avant, seul persist() (fichier local, perdu au redéploiement
    // Render sans disque persistant) était appelé — le reset ne survivait donc
    // jamais à un redémarrage. On enregistre maintenant aussi en base, comme
    // le fait déjà le bouton du panneau web.
    if (db.ready) await db.saveStrategy(key, strategies.BY_KEY[key].name, cfg);
    persist();
    b.sendMessage(msg.chat.id, `♻️ Configuration de *${strategies.BY_KEY[key].name}* remise par défaut.`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/supprimerstrat(?:\s+(\w+))?/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const key = (m[1] || '').toLowerCase();
    if (!strategies.BY_KEY[key]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /supprimerstrat <clé>');
    if (db.ready) await db.deleteStrategy(key);
    resetStrategy(key);
    setStrategyConfig(key, { enabled: false });
    persist();
    b.sendMessage(msg.chat.id, `🗑️ Configuration de *${strategies.BY_KEY[key].name}* supprimée en base et stratégie arrêtée.`, { parse_mode: 'Markdown' });
  });

  // ---- stratégie Pair / Impair (VAR) --------------------------------------
  b.onText(/^\/parite\b/, (msg) => {
    const r = parityRuntime();
    const c = state.strategies.parite || {};
    b.sendMessage(
      msg.chat.id,
      `🟢🔴 *Pair / Impair (VAR)*\n\n` +
        `• État : ${r.enabled ? '🟢 active' : '🔴 arrêtée'}\n` +
        `• Jeu de départ : *${r.startGame}*\n` +
        `• VAR configuré : *${r.varStep}* (VAR actuel : ${r.varLeft})\n` +
        `• Décalage : *${r.decalage}*\n` +
        `• Rattrapage : *+${r.maxR}*\n` +
        `• Format : *${r.format}/${fmt.FORMAT_COUNT}*\n\n` +
        `🎲 Jeu actuel : *${r.currentGame ? '#N' + r.currentGame : '—'}*\n` +
        `⬅️ Dernier déclencheur : *${r.lastTrigger ? '#N' + r.lastTrigger : '—'}*\n` +
        `➡️ Prochain déclencheur : *#N${r.nextTrigger}*\n` +
        `🔮 Prédiction en cours : ${r.prediction ? `*${r.prediction.parity.toUpperCase()}* sur #N${r.prediction.target} (rattrapage ${r.prediction.step}/${r.prediction.maxR})` : '—'}\n\n` +
        `📈 Séquence : ${r.sequence.join(' → ')} …\n\n` +
        `➡️ /setparite <départ> <var> <décalage> <rattrapage>`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/setparite(?:\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?)?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, 'ℹ️ Usage : /setparite <jeu de départ> <var> <décalage> [rattrapage]\nExemple : /setparite 1 2 1 3');
    const cfg = setStrategyConfig('parite', {
      startGame: m[1], varStep: m[2], decalage: m[3],
      ...(m[4] ? { maxR: m[4] } : {}),
    });
    persist();
    const r = parityRuntime();
    b.sendMessage(
      msg.chat.id,
      `✅ Pair / Impair configurée\n` +
        `Départ ${cfg.startGame} • VAR ${cfg.varStep} • Décalage ${cfg.decalage} • Rattrapage +${cfg.maxR}\n\n` +
        `Séquence : ${r.sequence.join(' → ')} …\n` +
        `Prochain déclencheur : #N${r.nextTrigger}`
    );
  });

  // ---- stratégies créées par l'IA -----------------------------------------
  function iaLine(s, i) {
    const rate = Number.isFinite(s.rate) ? s.rate : null;
    const min = Number.isFinite(s.rateMin) ? s.rateMin : rate;
    const flag = rate != null && min != null && rate >= 90 && min >= 90 ? '🏆' : rate >= 90 ? '⭐' : '•';
    return `${flag} *${i + 1}. ${s.name}*\n` +
      `   Taux : ${rate == null ? '—' : rate + '%'} • plus bas : ${min == null ? '—' : min + '%'} • mesures : ${s.observations || 1}\n` +
      (s.support ? `   Échantillon : ${s.support}\n` : '') +
      (s.trigger ? `   Déclencheur : ${String(s.trigger).slice(0, 120)}\n` : '') +
      (s.target ? `   Cible : ${String(s.target).slice(0, 120)}\n` : '') +
      `   Origine : ${s.origin || 'ia'} • ${s.active ? '🟢 active' : '⚪ inactive'}`;
  }

  b.onText(/^\/(?:ia|strategiesia)(?:@\w+)?(?:\s+(\d+))?\s*$/, (msg, m) => {
    const limit = Math.min(Math.max(parseInt(m[1], 10) || 15, 1), 40);
    const list = aiAuto.listStrategies();
    if (!list.length) {
      return b.sendMessage(msg.chat.id, "🤖 Aucune stratégie créée par l'IA pour l'instant. L'analyseur tourne en continu, réessaie plus tard.");
    }
    const rows = list.slice(0, limit).map(iaLine);
    b.sendMessage(
      msg.chat.id,
      `🤖 *Stratégies créées par l'IA* — ${list.length} au total\n\n${rows.join('\n\n')}\n\n🏆 = 90% et jamais descendue → /ia90`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/(?:ia90|elite)(?:@\w+)?(?:\s+(\d+))?\s*$/, (msg, m) => {
    const seuil = Math.min(Math.max(parseInt(m[1], 10) || 90, 50), 100);
    const list = aiAuto.eliteStrategies(seuil);
    if (!list.length) {
      return b.sendMessage(msg.chat.id, `🤖 Aucune stratégie IA à ${seuil}% ou plus sans jamais descendre pour l'instant.`);
    }
    b.sendMessage(
      msg.chat.id,
      `🏆 *Stratégies IA à ${seuil}% sans descendre* — ${list.length}\n\n${list.map(iaLine).join('\n\n')}`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/iabilan\b/, (msg) => {
    b.sendMessage(msg.chat.id, predit.globalBilanText() + '\n\n' +
      predit.strategiesView().filter((v) => v.bilan && v.bilan.total > 0)
        .map((v) => `• ${v.name} : ${v.bilan.win}✅/${v.bilan.loss}❌ (${v.bilan.rate}%)`).join('\n'));
  });

  b.onText(/^\/bilan\b/, async (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const r = await flushBilans('commande /bilan');
    b.sendMessage(msg.chat.id, `📊 Bilan publié : ${r.strategies.length} stratégie(s) + IA (${r.ai.ok ? 'envoyé' : r.ai.error || 'non envoyé'}).`);
  });

  // déclenchement manuel du rapport PDF de fin de sabot (déclencheurs ≥75%
  // des 7 stratégies + conseil ciblé) — utile pour le tester sans attendre
  // un vrai retour du jeu à #N1.
  b.onText(/^\/rapportsabot\b/, async (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    b.sendMessage(msg.chat.id, '📄 Génération du rapport en cours…');
    const ok = await sendShoeReport('commande /rapportsabot', state.shoeSeq || 0);
    if (!ok) b.sendMessage(msg.chat.id, "❌ Échec de l'envoi (aucun token, aucun administrateur configuré, ou erreur — voir les logs).");
  });

  b.onText(/^\/stats\b/, (msg) => {
    const s = stats();
    b.sendMessage(
      msg.chat.id,
      `📊 Prédictions : ${s.total}\n✅ ${s.win} | ❌ ${s.loss} | 🎯 ${s.rate}%\n\n` +
        strategies.LIST.map((d) => {
          const x = stats(d.key);
          return `${(state.strategies[d.key] || {}).enabled ? '🟢' : '🔴'} ${d.name} : ${x.win}✅/${x.loss}❌ (${x.rate}%)`;
        }).join('\n') +
        `\n\nTour live : ${state.live ? '#N' + state.live.number : '—'}`
    );
  });
}

// ---------------------------------------------------------------------------
// Bot DÉDIÉ à la boutique de stratégies (shop.js) — token API totalement
// séparé de celui du bot principal (state.botToken). Ce bot ne gère QUE :
// accueil multilingue, liste de stratégies, saisie du code de paiement,
// explication IA restreinte à la stratégie achetée. Voir shop.js.
// ---------------------------------------------------------------------------
function wireShop(b) {
  b.on('polling_error', (e) => { state.shopBotError = e.message; });

  function langKeyboard() {
    return { inline_keyboard: shop.LANGS.map((l) => [{ text: `${l.flag} ${l.label}`, callback_data: `lang:${l.code}` }]) };
  }

  async function sendWelcome(chatId) {
    await b.sendMessage(chatId, shop.t('welcome', 'fr'), { parse_mode: 'Markdown', reply_markup: langKeyboard() });
  }

  async function sendShopMenu(chatId, userId, lang) {
    // Les stratégies déjà achetées par CET utilisateur ne réapparaissent
    // plus dans la liste principale — elles restent accessibles via le
    // bouton « Mes stratégies » (voir myitems:list ci-dessous).
    const items = shop.listActive().filter((it) => !shop.hasUnlocked(userId, it.id));
    const rows = items.map((it) => [{ text: `${it.aiName}${Number.isFinite(it.rate) ? ' — ' + it.rate + '%' : ''}${Number.isFinite(it.price) ? ' — ' + it.price + '€' : ''}`, callback_data: `shop:${it.id}` }]);
    if (shop.listUnlocked(userId).length) {
      rows.push([{ text: shop.t('myItemsButton', lang), callback_data: 'myitems:list' }]);
    }
    rows.push([{ text: shop.t('supportButton', lang), callback_data: 'support:start' }]);
    await b.sendMessage(chatId, items.length ? shop.t('shopIntro', lang) : shop.t('noItems', lang), { reply_markup: { inline_keyboard: rows } });
  }

  async function sendMyItemsMenu(chatId, userId, lang) {
    const items = shop.listUnlocked(userId);
    const rows = items.map((it) => [{ text: `${it.aiName}${Number.isFinite(it.rate) ? ' — ' + it.rate + '%' : ''}`, callback_data: `shop:${it.id}` }]);
    await b.sendMessage(chatId, items.length ? shop.t('myItemsIntro', lang) : shop.t('noItemsUnlocked', lang), { reply_markup: { inline_keyboard: rows } });
  }

  // Présentation d'une stratégie débloquée (code accepté, ou réouverture
  // depuis « Mes stratégies ») + les deux boutons de suite : « Répondre-moi »
  // (pose une question à l'IA sur cette stratégie) et « J'ai compris »
  // (remerciement + conseil de formation, voir shop.closingMessage). La
  // saisie libre au clavier reste TOUJOURS possible en parallèle (voir le
  // handler 'message' plus bas, qui route déjà vers explain()/closingMessage
  // selon le texte tapé) — les boutons ne font que rendre ces deux actions
  // explicites, sans rien retirer à l'ancien fonctionnement au clavier.
  async function sendUnlockedPresentation(chatId, userId, item, lang) {
    shop.setActiveItem(userId, item.id);
    const text = await shop.fullPresentation(item, lang);
    await b.sendMessage(chatId, text);
    const buttons = [[
      { text: shop.t('askButton', lang), callback_data: `strategy:ask:${item.id}` },
      { text: shop.t('understoodButton', lang), callback_data: `strategy:understood:${item.id}` },
    ]];
    await b.sendMessage(chatId, shop.t('canAsk', lang), { reply_markup: { inline_keyboard: buttons } });
  }

  b.on('callback_query', async (q) => {
    try {
      const data = String(q.data || '');
      const chatId = q.message && q.message.chat && q.message.chat.id;
      const userId = q.from && q.from.id;
      if (!chatId || !userId) return b.answerCallbackQuery(q.id);

      if (data.startsWith('lang:')) {
        const lang = data.slice(5);
        shop.setLang(userId, lang);
        await b.answerCallbackQuery(q.id, { text: shop.t('langSaved', lang) });
        await sendShopMenu(chatId, userId, lang);
        return;
      }
      if (data.startsWith('strategy:ask:')) {
        const itemId = data.slice('strategy:ask:'.length);
        const lang = shop.getLang(userId) || 'fr';
        shop.setActiveItem(userId, itemId); // garantit le routage vers l'IA (explain()) au prochain message tapé
        await b.answerCallbackQuery(q.id);
        await b.sendMessage(chatId, shop.t('askPrompt', lang));
        return;
      }
      if (data.startsWith('strategy:understood:')) {
        const itemId = data.slice('strategy:understood:'.length);
        const item = shop.getItem(itemId);
        const lang = shop.getLang(userId) || 'fr';
        await b.answerCallbackQuery(q.id);
        if (!item) return;
        const closing = await shop.closingMessage(item, lang);
        await b.sendMessage(chatId, closing);
        // Explication détaillée du déclencheur (uniquement pour un
        // déclencheur IA — voir shop.explainTrigger).
        const explanation = shop.explainTrigger(item);
        if (explanation) await b.sendMessage(chatId, explanation);
        return;
      }
      if (data === 'support:start') {
        const lang = shop.getLang(userId) || 'fr';
        shop.setPendingSupport(userId, true);
        await b.answerCallbackQuery(q.id);
        await b.sendMessage(chatId, shop.t('supportAskAmount', lang));
        return;
      }
      if (data === 'myitems:list') {
        const lang = shop.getLang(userId) || 'fr';
        await b.answerCallbackQuery(q.id);
        await sendMyItemsMenu(chatId, userId, lang);
        return;
      }
      if (data.startsWith('support:pay:')) {
        const lang = shop.getLang(userId) || 'fr';
        const amountUsd = Number(data.slice('support:pay:'.length));
        await b.answerCallbackQuery(q.id);
        if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
        const rate = shop.getUsdToXof();
        const amountLocal = Math.round(amountUsd * rate);
        const buyerName = [q.from.first_name, q.from.last_name].filter(Boolean).join(' ').trim() || q.from.username || `Client ${userId}`;
        const pay = await paiement.initiateSupportPayment({ userId, chatId, lang, buyerName, amountUsd, amountLocal });
        if (pay.ok) {
          const buttons = [[{ text: `💛 ${shop.t('payButton', lang)} — ${amountUsd}$`, url: pay.checkoutUrl }]];
          await b.sendMessage(chatId, shop.t('supportPayIntro', lang), { reply_markup: { inline_keyboard: buttons } });
          return;
        }
        console.error('Soutien (initiation) :', pay.error);
        return;
      }
      if (data.startsWith('shop:')) {
        const itemId = data.slice(5);
        const item = shop.getItem(itemId);
        const lang = shop.getLang(userId) || 'fr';
        if (!item || !item.active) {
          await b.answerCallbackQuery(q.id);
          return b.sendMessage(chatId, shop.t('itemInactive', lang));
        }
        if (shop.hasUnlocked(userId, itemId)) {
          // déjà acheté : on rouvre directement le mode questions, sans redemander le code.
          await b.answerCallbackQuery(q.id);
          return sendUnlockedPresentation(chatId, userId, item, lang);
        }
        shop.setPendingCode(userId, itemId);
        await b.answerCallbackQuery(q.id);
        // Lien de paiement direct Money Fusion (paiement.js, SANS appel API —
        // voir commentaire en tête de ce fichier) : le lien est construit
        // localement (id du modèle + montant + nom du client), pas de
        // vérification automatique du paiement. La saisie manuelle d'un
        // code reste possible en parallèle (ex. code donné par l'admin par
        // un autre moyen), voir le handler 'message' plus bas.
        const payAmountLocal = shop.paymentAmountFor(item);
        {
          // Verrou de 3 minutes sur CETTE stratégie (voir paiement.js) : tant
          // qu'un autre acheteur a une réservation active dessus, on ne
          // relance pas de nouveau paiement — ça évite que deux acheteurs
          // se voient attribuer/afficher en même temps le même code (unique
          // et partagé tant qu'il n'a pas été consommé), qui pourrait être
          // régénéré pour l'un pendant que l'autre le croit encore valide.
          const lock = paiement.lockItem(itemId, userId);
          if (!lock) {
            return b.sendMessage(chatId, shop.t('itemLocked', lang));
          }
          const buyerName = [q.from.first_name, q.from.last_name].filter(Boolean).join(' ').trim() || q.from.username || `Client ${userId}`;
          // Fenêtre d'information envoyée DÈS que le verrou de 3 minutes est
          // obtenu (avant même de générer le lien de paiement) : elle
          // confirme au client qu'il est désormais prioritaire sur cette
          // stratégie et personne d'autre ne pourra lancer de paiement
          // pendant ce délai.
          const infoText = shop.t('reservationInfo', lang)
            .replace('{lastName}', q.from.last_name || '—')
            .replace('{firstName}', q.from.first_name || '—')
            .replace('{userId}', String(userId))
            .replace('{strategy}', item.aiName);
          await b.sendMessage(chatId, infoText);
          const pay = await paiement.initiatePayment({
            item: { ...item, payAmountLocal },
            userId,
            chatId,
            lang,
            buyerName,
          });
          if (pay.ok) {
            // Le code COURANT de la stratégie est attaché à cette réservation
            // avec 10s de délai (pas immédiatement au clic) : tant que ce
            // délai n'est pas écoulé, succes.html affiche « code pas encore
            // disponible » si le client clique trop vite sur « Voir mon
            // code ». Passé les 10s, le code apparaît sur succes.html au
            // clic sur ce bouton — jamais envoyé dans le chat Telegram. On
            // revérifie juste avant l'attachement que CETTE réservation
            // précise (pay.ref) est toujours active : si elle a expiré
            // entre-temps (voir paiement.js — expireRecord, déclenché par le
            // minuteur de 3 min posé à l'initiation), on n'attache rien.
            // UNIQUEMENT pour Money Fusion (lien fixe, confirmation par
            // simple arrivée sur succes.html) : pour SebPay, le code n'est
            // attaché qu'à la confirmation RÉELLE du webhook (voir
            // paiement.confirmSebpayPayment, server.js — POST
            // /api/sebpay/webhook), jamais par ce minuteur aveugle.
            if (pay.provider !== 'sebpay') {
              setTimeout(() => {
                const rec = paiement.getRecord(pay.ref);
                if (!rec || rec.status === 'expired' || rec.status === 'failed') return; // verrou expiré/annulé : rien à attacher
                paiement.attachCode(pay.ref, item.code);
              }, 10000);
            }
            const buttons = [[{ text: `💳 ${shop.t('payButton', lang)}${item.price ? ' — ' + item.price + '€' : ''}`, url: pay.checkoutUrl }]];
            await b.sendMessage(chatId, shop.t('payIntro', lang), { reply_markup: { inline_keyboard: buttons } });
            // 30s après avoir ouvert le lien de paiement, rappel : le client
            // peut aussi taper directement un code déjà en sa possession
            // (ex. donné par l'admin) — pas de vérification automatique du
            // paiement en mode lien direct, donc ce message reste utile même
            // après avoir cliqué sur Payer, tant que rien n'est débloqué.
            setTimeout(() => {
              if (shop.hasUnlocked(userId, itemId)) return; // déjà débloqué entre-temps, inutile de relancer
              b.sendMessage(chatId, shop.t('askCode', lang)).catch((e) => {
                console.error('Paiement (rappel code) :', e.message);
              });
            }, 30000);
            return;
          }
          paiement.unlockItem(itemId); // l'initiation a échoué : on relâche le verrou immédiatement
          console.error('Paiement (initiation) :', pay.error);
        }
        return b.sendMessage(chatId, shop.t('askCode', lang));
      }
      await b.answerCallbackQuery(q.id);
    } catch (e) {
      // AVANT : l'erreur était totalement avalée (catch (_) {}) — un clic sur
      // un bouton (langue, stratégie...) qui échouait en interne ne laissait
      // AUCUNE trace : le bouton semblait "ne pas répondre" sans qu'on sache
      // pourquoi. On log désormais l'erreur et on la garde visible dans
      // /api/shop/bot (state.shopBotError), comme pour polling_error.
      console.error('Boutique — erreur callback_query (' + (q.data || '?') + ') :', e && e.message);
      state.shopBotError = e && e.message ? e.message : String(e);
      try { await b.answerCallbackQuery(q.id); } catch (__) {}
    }
  });

  b.onText(/^\/boutique/, async (msg) => {
    const userId = msg.from.id;
    const lang = shop.getLang(userId);
    if (!lang) return sendWelcome(msg.chat.id);
    return sendShopMenu(msg.chat.id, userId, lang);
  });

  b.onText(/^\/langue/, (msg) => sendWelcome(msg.chat.id));
  b.onText(/^\/start/, (msg) => sendWelcome(msg.chat.id));

  // Code de paiement saisi une fois avec succès → CODE EXPIRÉ immédiatement
  // (voir shop.redeem()) : un nouveau code est régénéré automatiquement pour
  // cette stratégie, donc l'ancien code ne peut plus servir à personne.
  b.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    if (!msg.chat || msg.chat.type !== 'private') return;
    const userId = msg.from && msg.from.id;
    if (!userId) return;
    const lang = shop.getLang(userId);
    if (!lang) return sendWelcome(msg.chat.id);

    // Montant de soutien en $ attendu (bouton « Soutien » du menu) : on
    // valide le nombre, on affiche l'équivalent en F CFA, et on propose un
    // bouton « Payer » (voir callback support:pay:<montant> plus haut).
    if (shop.getPendingSupport(userId)) {
      const amountUsd = Number(String(msg.text).replace(',', '.').trim());
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        return b.sendMessage(msg.chat.id, shop.t('supportAmountInvalid', lang));
      }
      shop.clearPendingSupport(userId);
      const rate = shop.getUsdToXof();
      const amountLocal = Math.round(amountUsd * rate);
      const text = shop.t('supportAmountShown', lang)
        .replace('{usd}', String(amountUsd))
        .replace('{francs}', String(amountLocal));
      const buttons = [[{ text: `💛 ${shop.t('payButton', lang)}`, callback_data: `support:pay:${amountUsd}` }]];
      return b.sendMessage(msg.chat.id, text, { reply_markup: { inline_keyboard: buttons } });
    }

    const pendingItemId = shop.getPendingCode(userId);
    if (pendingItemId) {
      const r = shop.redeem(userId, pendingItemId, msg.text);
      if (r.ok) {
        await b.sendMessage(msg.chat.id, shop.t('unlockedHeader', lang));
        return sendUnlockedPresentation(msg.chat.id, userId, r.item, lang);
      }
      if (r.reason === 'used') return b.sendMessage(msg.chat.id, shop.t('codeUsed', lang));
      if (r.reason === 'inactive') return b.sendMessage(msg.chat.id, shop.t('itemInactive', lang));
      return b.sendMessage(msg.chat.id, shop.t('codeWrong', lang));
    }
    const activeItemId = shop.getActiveItem(userId);
    if (activeItemId) {
      const item = shop.getItem(activeItemId);
      if (item) {
        // L'acheteur signale qu'il a compris (fr/en/ar/ru/es, voir
        // shop.isUnderstoodMessage) → on conclut la présentation : remerciement
        // + bonne chance + vrai conseil du panneau Formation pour CETTE
        // stratégie (voir shop.closingMessage / formation.js), au lieu de
        // renvoyer ça à l'IA de Q&A comme une question ordinaire.
        if (shop.isUnderstoodMessage(msg.text)) {
          const closing = await shop.closingMessage(item, lang);
          await b.sendMessage(msg.chat.id, closing);
          // Explication détaillée du déclencheur (uniquement pour un
          // déclencheur IA — voir shop.explainTrigger, retourne null pour
          // une stratégie du catalogue existant, qui n'en a pas besoin).
          const explanation = shop.explainTrigger(item);
          if (explanation) await b.sendMessage(msg.chat.id, explanation);
          return;
        }
        const answer = await shop.explain(item, msg.text, lang);
        return b.sendMessage(msg.chat.id, answer);
      }
    }
    return sendShopMenu(msg.chat.id, userId, lang);
  });
}

function activate(id) {
  if (!state.activeChannels.includes(id)) state.activeChannels.push(id);
  if (!state.channels.some((c) => c.id === id)) state.channels.push({ id, title: String(id) });
  persist();
}

function deactivate(id) {
  state.activeChannels = state.activeChannels.filter((c) => c !== id);
  persist();
}

async function startBot(token) {
  // Validation AVANT toute mutation d'état / persistance : un token en
  // conflit avec celui de la boutique ne doit jamais être enregistré, même
  // temporairement (sinon un redémarrage ultérieur repartirait bloqué).
  const nextToken = token ? token.trim() : state.botToken;
  if (nextToken && state.shopBotToken && nextToken === state.shopBotToken) {
    state.botError = 'Ce token est déjà utilisé par la boutique : configure un token différent pour le bot principal.';
    return { ok: false, error: state.botError };
  }
  if (token) state.botToken = token.trim();
  persist();
  state.botError = null;
  if (bot) {
    try { await bot.stopPolling({ cancel: true }); } catch (_) {}
    bot = null;
  }
  if (!state.botToken) {
    state.botError = 'Aucun token configuré';
    return { ok: false, error: state.botError };
  }
  try {
    bot = new TelegramBot(state.botToken, { polling: true });
    wire(bot);
    const me = await bot.getMe();
    state.botUsername = me.username;
    return { ok: true, username: me.username };
  } catch (e) {
    state.botError = e.message;
    bot = null;
    return { ok: false, error: e.message };
  }
}

function botStatus() {
  return {
    running: !!bot,
    username: state.botUsername || null,
    tokenSet: !!state.botToken,
    tokenMasked: state.botToken ? state.botToken.slice(0, 8) + '••••••' + state.botToken.slice(-4) : null,
    adminId: state.adminId,
    error: state.botError || null,
  };
}

// Déconnexion volontaire : arrête le polling, efface le token en mémoire ET
// en base (data.json + PostgreSQL via persist()), afin qu'aucun ancien token
// ne reste actif ni ne revienne après un redémarrage. L'API Telegram cesse de
// répondre pour ce bot jusqu'à ce qu'un nouveau token soit configuré.
async function disconnectBot() {
  if (bot) {
    try { await bot.stopPolling({ cancel: true }); } catch (_) {}
    bot = null;
  }
  state.botToken = '';
  state.botUsername = null;
  state.botError = null;
  persist();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Cycle de vie du bot DÉDIÉ à la boutique — token strictement séparé du bot
// principal (voir wireShop() et la vérification croisée ci-dessus/ci-dessous :
// aucun des deux bots ne démarre si les deux tokens sont identiques).
// ---------------------------------------------------------------------------
// Paiement confirmé automatiquement (arrivée du client sur succes.html
// après validation Money Fusion, voir paiement.js/markPaidOnArrival) :
// - achat de stratégie (record.kind === 'item') : le code reste uniquement
//   sur succes.html ; le client doit le copier et l'envoyer au bot.
// - soutien (record.kind === 'support') : AUCUN code n'est envoyé, juste un
//   message de remerciement personnalisé (voir shop.supportThanksMessage).
// Enregistrée une seule fois (le handler regarde `shopBot` à l'appel, pas à
// l'enregistrement, donc il fonctionne même si le bot redémarre entre-temps).
// ---------------------------------------------------------------------------
paiement.setPaidHandler(async (record) => {
  if (record.kind === 'support') {
    if (!shopBot) return;
    try {
      await shopBot.sendMessage(record.chatId, shop.supportThanksMessage(record, record.lang));
    } catch (e) { console.error('Soutien (envoi Telegram après paiement) :', e.message); }
    return;
  }
});

// À l'expiration, seul le code courant lié à ce paiement est remplacé.
// Aucun message « Code accepté » n'est envoyé automatiquement.
paiement.setExpiredHandler(async (record) => {
  if (record.kind === 'item') shop.expirePaymentCode(record.itemId, record.code);
});

async function startShopBot(token) {
  // Même garde-fou que startBot() ci-dessus, dans l'autre sens : rien n'est
  // persisté si le token entre en conflit avec celui du bot principal.
  const nextToken = token ? token.trim() : state.shopBotToken;
  if (nextToken && state.botToken && nextToken === state.botToken) {
    state.shopBotError = 'Ce token est déjà utilisé par le bot principal : configure un token différent, réservé uniquement à la boutique.';
    return { ok: false, error: state.shopBotError };
  }
  if (token) state.shopBotToken = token.trim();
  persist();
  state.shopBotError = null;
  if (shopBot) {
    try { await shopBot.stopPolling({ cancel: true }); } catch (_) {}
    shopBot = null;
  }
  if (!state.shopBotToken) {
    state.shopBotError = 'Aucun token configuré';
    return { ok: false, error: state.shopBotError };
  }
  try {
    shopBot = new TelegramBot(state.shopBotToken, { polling: true });
    wireShop(shopBot);
    const me = await shopBot.getMe();
    state.shopBotUsername = me.username;
    return { ok: true, username: me.username };
  } catch (e) {
    state.shopBotError = e.message;
    shopBot = null;
    return { ok: false, error: e.message };
  }
}

// Déconnexion volontaire du bot boutique — même logique que disconnectBot()
// ci-dessus, côté token séparé (voir shop_bot_token dans persist()).
async function disconnectShopBot() {
  if (shopBot) {
    try { await shopBot.stopPolling({ cancel: true }); } catch (_) {}
    shopBot = null;
  }
  state.shopBotToken = '';
  state.shopBotUsername = null;
  state.shopBotError = null;
  persist();
  return { ok: true };
}

function shopBotStatus() {
  return {
    running: !!shopBot,
    username: state.shopBotUsername || null,
    tokenSet: !!state.shopBotToken,
    tokenMasked: state.shopBotToken ? state.shopBotToken.slice(0, 8) + '••••••' + state.shopBotToken.slice(-4) : null,
    error: state.shopBotError || null,
  };
}

// ---------------------------------------------------------------------------
// Expéditeurs : chaque stratégie peut avoir SON propre token de bot
// ---------------------------------------------------------------------------
const senders = new Map(); // token -> instance TelegramBot (sans polling)

// Renvoie TOUJOURS un expéditeur si un token est disponible : le bot principal
// quand il tourne, sinon une instance d'envoi seul (sans polling). Ainsi les
// prédictions partent même si le polling du bot principal est en erreur.
function senderFor() {
  const token = (state.botToken || '').trim();
  if (!token) return null;
  if (bot) return bot;                      // bot principal (polling actif)
  if (!senders.has(token)) {
    try { senders.set(token, new TelegramBot(token, { polling: false })); }
    catch (e) { console.error('Token Telegram invalide :', e.message); senders.set(token, null); }
  }
  return senders.get(token) || null;
}

// Résout un canal (ID numérique ou @nom) : titre, type, abonnés, droit de publier.
async function resolveChat(chatId) {
  const sender = senderFor();
  if (!sender) return { ok: false, error: "Aucun token API configuré dans les réglages." };
  try {
    const chat = await sender.getChat(chatId);
    let memberCount = null;
    try { memberCount = await sender.getChatMemberCount(chat.id); } catch (_) {}
    let canPost = null;
    try {
      const me = await sender.getMe();
      const m = await sender.getChatMember(chat.id, me.id);
      canPost = m.status === 'creator' || (m.status === 'administrator' && m.can_post_messages !== false);
    } catch (_) {}
    return {
      ok: true,
      chat: {
        id: chat.id,
        title: chat.title || chat.username || String(chat.id),
        type: chat.type,
        username: chat.username || null,
        memberCount,
        canPost,
      },
    };
  } catch (e) {
    const msg = /chat not found/i.test(e.message)
      ? "Canal introuvable : ajoute d'abord le bot comme administrateur du canal, puis réessaie."
      : e.message;
    return { ok: false, error: msg };
  }
}

// compteur de messages envoyés par stratégie
function countSent(key, n = 1) {
  const cfg = state.strategies[key];
  if (!cfg) return;
  cfg.sentCount = (cfg.sentCount || 0) + n;
  cfg.lastSentAt = Date.now();
}

function dropSender(token) {
  if (token && senders.has(token)) senders.delete(token);
}

// bilan à envoyer quand le jeu reprend
const bilanPending = new Set();
let lastLiveNumber = null;
let lastShoeSeq = 0;
// CORRECTIF : setInterval(tick, 1500ms) ne garantit pas qu'un tick se termine
// avant que le suivant démarre. Si un tour (appel réseau, envoi Telegram) est
// lent, deux exécutions de tick() pouvaient se chevaucher et repérer TOUTES
// LES DEUX la même prédiction « ombre » encore non envoyée (state.predictions
// pas encore mis à jour par la première) → double envoi dans le canal public.
let ticking = false;

async function sendBilan(key, snapshot) {
  const cfg = state.strategies[key] || {};
  if (cfg.bilan === false) return;
  const sender = senderFor();
  if (!sender) return;
  // CORRECTIF « bilans cumulés » : snapshot figé fourni par flushBilans()
  // (voir plus bas) — sans lui (appel manuel /bilan sur UNE stratégie via
  // le panneau admin), on retombe sur l'état live, comportement inchangé.
  const text = bilanText(key, snapshot);
  for (const id of strategyChannels(key)) {
    try { await sender.sendMessage(id, text); countSent(key); }
    catch (e) { console.error('Bilan non envoyé', id, e.message); }
  }
}

// Déclenche le bilan complet UNIQUEMENT quand le sabot qui vient de se
// terminer représente une VRAIE journée (au moins config.BILAN_MIN_GAMES
// jeux joués) — filtre les remises à zéro isolées/anormales en cours de
// journée. Une seule fois par sabot (garde lastBilanShoeSeq, persistée).
// CORRECTIF : ne fait plus qu'ENREGISTRER la demande — voir pendingBilan
// ci-dessus et son traitement (await) dans tick().
function sendBilanIfDayOver(reason, seq, previousMax) {
  if (!previousMax || previousMax < config.BILAN_MIN_GAMES) return; // pas une vraie fin de journée
  if (seq === lastBilanShoeSeq) return;                              // déjà envoyé pour ce sabot
  pendingBilan = { reason, seq, previousMax };
}

// Publie le bilan COMPLET : chaque stratégie ayant prédit + les prédictions
// IA, puis remet les compteurs à zéro sur le site. Appelée par
// sendBilanIfDayOver() ci-dessus (fin de journée réelle) ou manuellement
// (commande /bilan).
async function flushBilans(reason = 'nouveau jour') {
  bilanPending.clear();
  // CORRECTIF « bilans cumulés » : instantané figé de state.predictions AU
  // MOMENT où le bilan démarre. L'envoi Telegram (plusieurs canaux, un par
  // stratégie) prend plusieurs secondes ; pendant ce temps, le jeu reprend
  // déjà au numéro 1 et de NOUVELLES prédictions du jour suivant sont créées
  // (et parfois même déjà résolues) par le tick() en cours. Sans cet
  // instantané, bilanText(key) relisait l'état LIVE à chaque itération de la
  // boucle ci-dessous et mélangeait les résultats du jour qui vient de
  // commencer avec ceux du jour qui vient de se terminer — d'où le bilan
  // qui « cumule » jour 1 et jour 2.
  const snapshot = state.predictions.slice();
  const keys = strategies.LIST
    .map((d) => d.key)
    .filter((key) => snapshot.some((p) => p.strategy === key));
  const done = [];
  for (const key of keys) {
    try { await sendBilan(key, snapshot); done.push(key); }
    catch (e) { console.error('Bilan non envoyé', key, e.message); }
  }
  let ai = { ok: false, error: 'panneau Prédit indisponible' };
  try { ai = await predit.sendBilans(); }
  catch (e) { ai = { ok: false, error: e.message }; }
  // CORRECTIF : un bilan par jour, puis le site repart à zéro. On ne retire
  // que les prédictions déjà TERMINÉES (gagné/perdu/annulé) de la vue en
  // cours — celles encore « en attente » restent affichées (en cours), et
  // l'historique complet reste consultable en base de données (/pred, /jeux…).
  // CORRECTIF « bilans cumulés » : on ne retire QUE les prédictions qui
  // faisaient partie de l'instantané envoyé ci-dessus ET qui sont désormais
  // résolues. Une prédiction créée APRÈS l'instantané (déjà le jour suivant)
  // n'est jamais retirée ici, même si elle s'est résolue entre-temps — elle
  // sera comptée dans SON PROPRE bilan, au prochain retour à 1.
  const snapshotIds = new Set(snapshot.map((p) => p.id));
  state.predictions = state.predictions.filter((p) => p.status === 'en attente' || !snapshotIds.has(p.id));
  console.log(`📊 Bilan (${reason}) : ${done.join(', ') || 'aucune stratégie'} • IA : ${ai.ok ? 'envoyé' : ai.error}`);
  return { strategies: done, ai };
}

// message de confirmation envoyé dans le canal dès qu'on configure
// le token API et/ou l'ID du canal d'une stratégie
async function announceConfig(key, mode = 'published') {
  const def = strategies.BY_KEY[key];
  const cfg = state.strategies[key] || {};
  const ids = strategyChannels(key, mode);
  if (!def) return { ok: false, error: 'Stratégie inconnue' };
  if (!ids.length) return { ok: false, error: `Aucun canal ${mode === 'published' ? 'public' : 'silencieux'} configuré pour cette stratégie` };
  const sender = senderFor();
  if (!sender) return { ok: false, error: "Aucun token API configuré dans les réglages" };

  const sent = [];
  const failed = [];
  const infos = [];
  for (const id of ids) {
    const r = await resolveChat(id);
    const info = r.ok ? r.chat : { id, title: String(id), type: '?', memberCount: null, canPost: null };
    if (!r.ok) info.error = r.error;
    const text =
      '✅ CANAL CONFIGURÉ\n\n' +
      `🧠 Stratégie : ${def.name}\n` +
      `📡 Canal : ${info.title}\n` +
      `🆔 ID : ${info.id}\n` +
      (info.memberCount != null ? `👥 Abonnés : ${info.memberCount}\n` : '') +
      `🤖 Bot : @${state.botUsername || 'bot'} (token des réglages)\n` +
      `🎯 Format ${cfg.format} • +${cfg.maxR} rattrapage(s)\n` +
      `📊 Bilan automatique : ${cfg.bilan === false ? 'non' : 'oui'}\n` +
      `🧭 Routage : ${mode === 'published' ? 'prédictions activées' : 'prédictions silencieuses'}\n\n` +
      `Ce canal recevra désormais les ${mode === 'published' ? 'prédictions publiées' : 'prédictions silencieuses'} de cette stratégie. 🚀`;
    try {
      // l'envoi est tenté même si getChat a échoué : certains canaux ne
      // répondent pas à getChat mais acceptent parfaitement les messages.
      await sender.sendMessage(id, text);
      sent.push(id);
      countSent(key);
      info.confirmed = true;
      info.error = null;
      state.sendErrors[key] = null;
    } catch (e) {
      failed.push({ id, error: e.message });
      info.confirmed = false;
      info.error = e.message;
      state.sendErrors[key] = `${id} : ${e.message}`;
    }
    infos.push(info);
  }
  if (mode === 'shadow') cfg.shadowChannelInfos = infos;
  else {
    cfg.channelInfos = infos;
    cfg.publishedChannelInfos = infos;
  }
  return {
    ok: sent.length > 0,
    sent,
    failed,
    channels: infos,
    error: sent.length ? null : (failed[0] ? `${failed[0].id} : ${failed[0].error}` : 'Envoi impossible'),
  };
}

// envoi d'un message de test dans le(s) canal(aux) d'une stratégie
async function testSend(key, mode = 'published') {
  const def = strategies.BY_KEY[key];
  if (!def) return { ok: false, error: 'Stratégie inconnue' };
  const sender = senderFor();
  if (!sender) return { ok: false, error: "Aucun token API configuré dans les réglages" };
  const ids = strategyChannels(key, mode);
  if (!ids.length) return { ok: false, error: `Aucun canal ${mode === 'published' ? 'public' : 'silencieux'} configuré pour cette stratégie` };
  const cfg = state.strategies[key] || {};
  const preview = fmt.formatPreview(cfg.format, { maxR: cfg.maxR });
  const text = `🧪 TEST D'ENVOI\n\n🧠 ${def.name}\n🧭 ${mode === 'published' ? 'Canal public' : 'Canal silencieux'}\n\n${preview}\n\nSi tu vois ce message, le routage est correctement configuré. ✅`;
  const sent = [];
  const failed = [];
  for (const id of ids) {
    try { await sender.sendMessage(id, text); sent.push(id); countSent(key); }
    catch (e) { failed.push({ id, error: e.message }); }
  }
  state.sendErrors[key] = failed.length ? `${failed[0].id} : ${failed[0].error}` : null;
  return { ok: sent.length > 0, sent, failed, text };
}

// confirmation pour le bot principal (réglages)
// Configure le canal principal (page Configuration) : vérification + message
async function setMainChannel(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: false, error: "Renseigne l'ID du canal (ex : -1001234567890 ou @moncanal)" };
  if (!state.botToken) return { ok: false, error: "Configure d'abord le token API du bot." };
  const check = await resolveChat(value);
  const id = check.ok ? check.chat.id : (/^-?\d+$/.test(value) ? Number(value) : value);
  if (!state.activeChannels.includes(id)) state.activeChannels.push(id);
  if (!state.channels.some((c) => c.id === id)) {
    state.channels.push({ id, title: check.ok ? check.chat.title : String(id) });
  }
  persist();
  const sender = senderFor();
  const text =
    '✅ CANAL PRINCIPAL CONFIGURÉ\n\n' +
    `🤖 Bot : @${state.botUsername || 'bot'}\n` +
    `📡 Canal : ${check.ok ? check.chat.title : id}\n` +
    `🆔 ID : ${id}\n\n` +
    'Le token API et l’ID du canal sont enregistrés en base de données : ' +
    'après un redémarrage tout repart automatiquement. 🚀';
  try {
    await sender.sendMessage(id, text);
    return { ok: true, id, chat: check.ok ? check.chat : { id, title: String(id) }, sent: true };
  } catch (e) {
    return { ok: false, error: `Message non envoyé dans ${id} : ${e.message}`, id };
  }
}

async function announceMainBot() {
  const sender = senderFor();
  if (!sender) return { ok: false, error: 'Aucun token API configuré' };
  const ids = [...new Set([
    ...(state.activeChannels || []),
    ...strategies.LIST.flatMap((d) => strategyChannels(d.key)),
  ])];
  if (!ids.length) return { ok: false, error: "Token enregistré. Configure maintenant un ID de canal pour recevoir les messages." };
  const text =
    '✅ BOT CONNECTÉ\n\n' +
    `🤖 @${state.botUsername || 'bot'}\n` +
    `📡 Canal : ${ids.join(', ')}\n\n` +
    'Le token API est enregistré : ce canal recevra les prédictions. 🚀';
  const sent = [];
  const failed = [];
  for (const id of ids) {
    try { await sender.sendMessage(id, text); sent.push(id); }
    catch (e) { failed.push({ id, error: e.message }); }
  }
  return { ok: sent.length > 0, sent, failed, text };
}

// ---------------------------------------------------------------------------
// Envoi + vérification des prédictions
// ---------------------------------------------------------------------------
async function broadcast(pred) {
  if (db.ready) db.savePrediction(pred, state.B);
  const sender = senderFor();
  if (!sender) {
    state.sendErrors[pred.strategy] = 'Aucun token Telegram configuré';
    return;
  }
  // ── Mode silencieux 1 (filtre pertes → publication publique) ─────────────
  // Seul mode silencieux qui subsiste dans le projet, et uniquement pour la
  // stratégie « ombre » (voir strategies.js / predictor.js).
  // Phase 1 : on attend la 1ʳᵉ perte (référence).
  // Phase 2 : on mesure l'écart jusqu'à la perte suivante ; écart >= intervalle
  //           MAX → retour phase 1 ; écart ≤ intervalle MAX → confirmé, N = écart.
  // Phase 3 : décompte silencieux ; la N-ᵉ prédiction depuis la confirmation
  //           part dans le canal PUBLIC (une perte pendant le décompte
  //           interrompt et redevient la référence).
  if (!canSend(pred.strategy)) {
    pred.silent = true;
    pred.gate = gateView(pred.strategy).label;
    // « ombre » : un seul canal (public), utilisé uniquement une fois le mode
    // silencieux débloqué. Tant que le filtre est bloqué, rien n'est envoyé
    // nulle part (pas de canal silencieux séparé pour cette stratégie).
    if (pred.strategy === 'ombre') return;
    const shadowIds = strategyChannels(pred.strategy, 'shadow');
    if (!shadowIds.length) return;
    await sendPrediction(pred, sender, shadowIds);
    return;
  }
  pred.silent = false;
  const ids = strategyChannels(pred.strategy);
  if (!ids.length) { state.sendErrors[pred.strategy] = 'Aucun canal configuré'; return; }
  await sendPrediction(pred, sender, ids);
  // panneau « Prédit » : reprise si la stratégie est certifiée 100%
  try { await predit.mirror(pred); } catch (e) { predit.panel.lastError = e.message; }
  // le déclencheur automatique consomme l'autorisation d'envoi
  if (pred.messages.length) noteSent(pred.strategy);
  // le filtre « double perte » consomme aussi l'autorisation si l'envoi est
  // limité à une seule prédiction (sendOnlyNext)
  if (pred.messages.length) noteGateSent(pred.strategy);
  // « ombre » : la prédiction de la position annoncée vient réellement de
  // partir dans le canal public → on referme l'entrée de l'historique des
  // annonces (voir /ombreannonces).
  if (pred.strategy === 'ombre' && pred.messages.length) fulfillAnnouncement('ombre', pred.target);
  pred.gate = gateView(pred.strategy).label;
}

// ---------------------------------------------------------------------------
// Annonce publique de la CONFIRMATION du filtre « double perte » (stratégie
// « ombre ») : dès que la 2ᵉ perte confirme la mesure (phase 2 → phase 3),
// CHANGEMENT : cette confirmation n'est PLUS envoyée dans le canal public.
// L'entrée créée par pushAnnouncement() (voir predictor.js) sert UNIQUEMENT
// de repère interne pour que la phase 3 se souvienne de la position à
// atteindre, et pour l'affichage admin via /ombreannonces. Seule la vraie
// prédiction, une fois la position atteinte, part réellement dans le canal
// public (voir broadcast()/fulfillAnnouncement()). Cette fonction et son
// branchement (setOnConfirm) sont donc désormais désactivés.
function ordinalFr(n) {
  return n === 1 ? '1ʳᵉ' : `${n}ᵉ`;
}

async function sendPrediction(pred, sender, ids) {
  state.sendErrors[pred.strategy] = null;
  const { text, parse_mode } = predictionText(pred);
  for (const id of [...new Set(ids)]) {
    try {
      const m = await sender.sendMessage(id, text, parse_mode ? { parse_mode } : {});
      pred.messages.push({ chatId: id, messageId: m.message_id });
      countSent(pred.strategy);
    } catch (e) {
      state.sendErrors[pred.strategy] = `${id} : ${e.message}`;
    }
  }
}

async function updateResult(pred) {
  if (db.ready) db.closePrediction(pred);
  const sender = senderFor();
  if (!sender) return;
  const { text, parse_mode } = predictionText(pred);
  for (const m of pred.messages) {
    try {
      await sender.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId, ...(parse_mode ? { parse_mode } : {}) });
    } catch (e) {
      try { await sender.sendMessage(m.chatId, text, { reply_to_message_id: m.messageId, ...(parse_mode ? { parse_mode } : {}) }); } catch (_) {}
    }
  }
  // message de perte + rappel formation VIP (voir loss-notice.js), envoyé
  // dans CES MÊMES canaux — pour TOUTE stratégie, existante comme IA (voir
  // aussi predit.js/update() pour le panneau « Prédit IA »). Réglable/
  // désactivable depuis Système → Message de perte.
  if (pred.status === 'perdu' && pred.messages.length && lossNotice.getSettings().enabled) {
    const noticeText = lossNotice.buildText();
    for (const m of pred.messages) {
      try { await sender.sendMessage(m.chatId, noticeText); } catch (_) {}
    }
  }
}

// Reconnexion automatique de la base : si elle n'est pas joignable au démarrage
// (ou tombe en panne), on retente régulièrement puis on relit les configurations.
let dbRetryAt = 0;
async function ensureDb() {
  if (db.ready) return;
  if (Date.now() - dbRetryAt < 30000) return;
  dbRetryAt = Date.now();
  const s = await db.connect();
  if (s.ready) {
    console.log('🗄️ Base de données reconnectée');
    await auth.ensureAdminSeed();
    // CORRECTIF : si des changements locaux sont restés en attente pendant la
    // coupure (dbDirty), on les POUSSE d'abord vers la base — sinon
    // applyDbConfigs() relirait l'ancienne valeur encore en base et écraserait
    // silencieusement le changement (ex. un ID de canal tout juste modifié).
    if (dbDirty) {
      await saveConfigsToDb();
      dbDirty = false;
      console.log('🧠 Changements en attente poussés vers la base (dbDirty)');
    } else {
      const r = await applyDbConfigs();
      console.log('🧠 Configurations relues : ' + ((r.loaded || []).join(', ') || 'aucune'));
    }
  }
}

async function tick() {
  if (ticking) return; // un tick précédent tourne encore : on saute celui-ci
  ticking = true;
  try {
    await ensureDb();
    const games = await api.fetchGames();
    state.lastError = null;
    registerGames(games);

    // CORRECTIF « bilan pendant l'envoi des prédictions / un bilan par jour » :
    // traité et ATTENDU ici, avant tout le reste (verify/evaluate/broadcast)
    // — voir pendingBilan plus haut. Comme tick() ne se chevauche jamais
    // (garde `ticking`), aucune prédiction (nouvelle ou « ombre ») ne peut
    // être diffusée tant que l'envoi du bilan n'est pas terminé.
    if (pendingBilan) {
      const { seq, previousMax } = pendingBilan;
      pendingBilan = null;
      if (seq !== lastBilanShoeSeq) {
        lastBilanShoeSeq = seq;
        persist();
        await flushBilans(`journée terminée (${previousMax} jeux, retour à 1)`);
      }
    }

    // déblocage automatique des stratégies bloquées depuis plus de 10 minutes
    const freed = sweepAutoUnlock();
    if (freed.length) console.log('🔓 Déblocage automatique : ' + freed.join(', '));

    const closed = verify();
    for (const p of closed) {
      await updateResult(p);
      bilanPending.add(p.strategy);           // bilan dès que le jeu reprend
    }

    // « ombre » : une prédiction est créée (et envoyée, ou pas) au moment où
    // evaluate() la détecte — mais le filtre « double perte » peut s'ouvrir
    // PLUS TARD, après coup, suite à une perte confirmée ci-dessus (verify()
    // vient d'appeler noteClosed()). CORRECTIF : sans ceci, une prédiction
    // déjà calculée en silence (canal jamais configuré au moment de sa
    // création) restait bloquée pour toujours, même une fois le filtre
    // ouvert — rien ne revenait jamais la chercher pour l'envoyer. On
    // reprend ici la plus ancienne prédiction ombre jamais envoyée (encore
    // en attente, OU déjà résolue en silence) et on l'envoie maintenant que
    // c'est autorisé — avec son résultat réel si elle est déjà terminée.
    // CORRECTIF FILE D'ATTENTE : la file « ombre » peut contenir plusieurs
    // positions confirmées d'affilée (voir predictor.js). On les envoie donc
    // en BOUCLE tant que canSend() reste vrai — jamais une seule par tick —
    // afin de ne jamais en laisser une bloquée derrière une autre déjà prête.
    // Chaque envoi dépile la tête de file (fulfillAnnouncement), donc canSend()
    // reflète ensuite l'état de la position suivante, toujours dans l'ordre.
    let guard = 0;
    while (canSend('ombre') && guard++ < 20) {
      // CORRECTIF : exclure les prédictions « annulé » (tuées par un reset de
      // sabot en cours de décompte, voir resetShoe()). Sans ce filtre, dès que
      // la position N était enfin prête, le bot pouvait ressusciter une vieille
      // prédiction annulée d'un sabot précédent (target obsolète) au lieu de
      // laisser la vraie prédiction « ombre » du sabot courant partir — ce qui
      // désynchronisait complètement la position réellement envoyée par
      // rapport à celle annoncée dans /ombreannonces.
      // CORRECTIF #2 : même problème avec un cycle (phase 1→2→3) ABANDONNÉ
      // (changement de réglages, déblocage manuel qui remet tout à zéro…) : la
      // prédiction « ombre » restée silencieuse de ce cycle-là n'était ni
      // envoyée ni annulée, donc toujours candidate au rattrapage. On ignore
      // donc toute prédiction antérieure à la plus ancienne référence encore
      // active (file d'attente comprise) — voir queueFloor().
      // CORRECTIF (décalage de position) : comparaison désormais STRICTE
      // (`>` et non `>=`) — le floor pointe sur le numéro de la dernière
      // prédiction déjà comptée dans le décompte silencieux (perte de
      // référence comprise) ; elle-même ne doit jamais être reprise comme
      // « prédiction publique », seule la vraie suivante doit l'être.
      // CORRECTIF (envoi déjà vérifié) : avant, cette recherche reprenait
      // la plus ancienne prédiction « ombre » jamais envoyée MÊME si son
      // tour était déjà terminé et vérifié en silence (status gagné/perdu) —
      // le canal public recevait alors un message annonçant une prédiction
      // dont le résultat était déjà connu, au lieu d'une vraie prédiction
      // envoyée AVANT le tour puis vérifiée ensuite normalement. On ne
      // reprend donc plus qu'une prédiction encore « en attente » (tour pas
      // encore joué) : si aucune ne l'est, on attend simplement le prochain
      // déclencheur « ombre » plutôt que de publier un résultat déjà acquis.
      const floor = queueFloor('ombre');
      const stuck = state.predictions
        .filter((p) => p.strategy === 'ombre' && p.status === 'en attente' && (!p.messages || !p.messages.length)
          && (floor == null || p.target > floor))
        .sort((a, b) => a.target - b.target)[0];
      if (!stuck) break;
      await broadcast(stuck);
    }

    // Le bilan (résumé complet : toutes stratégies + IA) part désormais
    // directement au moment où le sabot se termine (numéros revenus à 1),
    // via le hook sendBilanIfDayOver() ci-dessous — voir sa définition pour
    // la logique « vraie fin de journée » (filtrage des remises à zéro
    // isolées) et la garde anti-doublon (lastBilanShoeSeq).

    const preds = evaluate();
    for (const pred of preds) await broadcast(pred);

    // panneau « Prédit » : prédictions certifiées à 100% (IA)
    await predit.tick();

    // panneau « Prédiction après perte » : relais de la prochaine prédiction
    // d'une stratégie suivie (existante ou IA) après N pertes consécutives.
    await afterLoss.tick();

    // panneau « Formation » : pour chaque stratégie cochée, lecture de la
    // formation après une perte, puis publication de la prédiction confirmée
    // (et du « Bingo » si elle est gagnée) dans le canal configuré.
    await formationRelay.tick();
  } catch (e) {
    state.lastError = e.message;
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
// Configurations <-> base de données
// ---------------------------------------------------------------------------
// Enregistre TOUTES les configurations existantes (réglages globaux + chaque
// stratégie) dans la base de données.
async function saveConfigsToDb() {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée' };
  await db.setSetting('B', state.B);
  await db.setSetting('maxR', state.maxR);
  await db.setSetting('format', state.format);
  await db.setSetting('template', state.template || '');
  await db.setSetting('ai_auto_enabled', aiAuto.auto.enabled ? 'true' : 'false');
  const keys = [];
  for (const def of strategies.LIST) {
    const cfg = state.strategies[def.key];
    if (!cfg) continue;
    await db.saveStrategy(def.key, def.name, cfg);
    keys.push(def.key);
  }
  return { ok: true, saved: keys };
}

// Lit les configurations enregistrées. Si la base est vide (première
// connexion), les configurations en cours y sont écrites automatiquement.
async function applyDbConfigs() {
  if (!db.ready) return { ok: false, error: 'Base de données non connectée' };
  const B = await db.getSetting('B');
  const maxR = await db.getSetting('maxR');
  const tpl = await db.getSetting('template');
  const fmtId = await db.getSetting('format');
  if (B) state.B = parseInt(B, 10) || state.B;
  if (maxR != null) state.maxR = parseInt(maxR, 10);
  if (fmtId) state.format = parseInt(fmtId, 10) || state.format;
  if (tpl !== null) state.template = tpl ? tpl : null;
  // token API, ID administrateur et canaux enregistrés : restaurés au démarrage.
  // CORRECTIF : la base de données est la seule source durable (le fichier
  // data.json local est effacé à chaque redéploiement Render, sans disque
  // persistant). Avant, la DB ne servait qu'à COMPLÉTER un état déjà vide —
  // si data.json contenait encore d'anciennes valeurs (canal supprimé,
  // redéployé sur un autre disque, etc.), elles gagnaient silencieusement et
  // la DB n'était jamais vraiment consultée. Désormais, dès que la DB est
  // connectée, ses valeurs priment toujours sur l'état local.
  const app = await db.loadAppConfig();
  const restored = [];
  if (app) {
    if (app.botToken) { state.botToken = app.botToken; restored.push('token'); }
    if (app.adminId) { state.adminId = app.adminId; restored.push('admin'); }
    if (Array.isArray(app.channels) && app.channels.length) {
      state.channels = app.channels; restored.push('canaux');
    }
    if (Array.isArray(app.activeChannels) && app.activeChannels.length) {
      state.activeChannels = app.activeChannels; restored.push('canaux actifs');
    }
    if (Array.isArray(app.siteChannels) && app.siteChannels.length) {
      state.siteChannels = app.siteChannels; restored.push('canaux du site');
    }
  }
  // token de la boutique : restauré depuis sa clé dédiée (jamais depuis
  // loadAppConfig(), réservé au bot principal) — garantit la séparation
  // même après un redémarrage.
  const shopToken = await db.getSetting('shop_bot_token');
  if (shopToken) { state.shopBotToken = shopToken; restored.push('token boutique'); }
  if (!state.siteChannels.length) {
    const rawSiteChannels = await db.getSetting('site_channels');
    if (rawSiteChannels) {
      try {
        const parsed = JSON.parse(rawSiteChannels);
        if (Array.isArray(parsed) && parsed.length) { state.siteChannels = parsed; restored.push('canaux du site'); }
      } catch (_) { /* ignore */ }
    }
  }
  const rows = await db.loadStrategies();
  const loaded = [];
  for (const [key, cfg] of Object.entries(rows)) {
    if (!strategies.BY_KEY[key]) continue;
    state.strategies[key] = { ...strategies.defaultsFor(key), ...cfg };
    loaded.push(key);
  }
  initStrategies();
  // base vide OU nouvelles stratégies absentes → on les enregistre tout de suite
  const missing = strategies.LIST.filter((d) => !loaded.includes(d.key)).map((d) => d.key);
  if (missing.length) await saveConfigsToDb();

  // CORRECTIF DÉPLOIEMENT : la stratégie « ombre » doit toujours démarrer avec
  // lossTrigger=2 (double perte), lossWindow=6 et lossInterval=5. Comme la
  // stratégie « ombre » existe déjà en base depuis longtemps, applyDbConfigs()
  // prend TOUJOURS la valeur déjà enregistrée en base (spread `...cfg` après
  // les defaults) — changer strategies.js seul ne suffit donc jamais à faire
  // apparaître un nouveau default une fois la ligne déjà créée. On force ici
  // ces 3 réglages à chaque démarrage et on les ré-enregistre si besoin.
  const OMBRE_FORCED_DEFAULTS = { lossTrigger: 2, lossWindow: 6, lossInterval: 5 };
  if (state.strategies.ombre) {
    let changed = false;
    for (const [k, v] of Object.entries(OMBRE_FORCED_DEFAULTS)) {
      if (state.strategies.ombre[k] !== v) { state.strategies.ombre[k] = v; changed = true; }
    }
    if (changed) await db.saveStrategy('ombre', strategies.BY_KEY.ombre.name, state.strategies.ombre);
  }

  // filtre « double perte » (gates) : restauré depuis la base pour survivre à
  // un redémarrage du process (veille Render Free, redéploiement, crash…),
  // sinon 2 pertes réellement tombées avant un redémarrage étaient « oubliées ».
  const gateRows = await db.loadGates();
  for (const [key, g] of Object.entries(gateRows)) {
    if (g && typeof g === 'object') state.gates[key] = g;
  }

  // annonces de position (/ombreannonces) : même raisonnement que les gates
  // ci-dessus — sans cette restauration, une confirmation déjà en cours avant
  // le redémarrage n'apparaissait plus jamais dans la liste.
  const announcementRows = await db.loadAnnouncements();
  restoreAnnouncements(announcementRows);

  // CORRECTIF « bouton Créé par moi avec IA » : même raisonnement que les
  // annonces ci-dessus — sans cette restauration, la liste des stratégies
  // créées par l'IA repartirait vide à chaque redémarrage (y compris celui
  // déclenché automatiquement juste après une création, voir server.js).
  const createdKeysRaw = await db.getSetting('ai_created_strategy_keys');
  const createdHistoryRaw = await db.getSetting('ai_created_strategy_history');
  try {
    aiRepair.restoreCreated(
      createdKeysRaw ? JSON.parse(createdKeysRaw) : null,
      createdHistoryRaw ? JSON.parse(createdHistoryRaw) : null,
    );
  } catch (_) { /* données corrompues — on repart d'une liste vide, pas bloquant */ }

  // Stratégies IA : la base est la source de vérité (data.json est perdu à
  // chaque redéploiement/redémarrage sur les plateformes sans disque persistant).
  const aiRows = await db.loadAiStrategies();
  if (aiRows.length) {
    state.aiStrategies = aiRows;
  } else if ((state.aiStrategies || []).length) {
    // rien en base encore : on migre ce qui existait localement (data.json)
    for (const item of state.aiStrategies) await db.saveAiStrategy(item);
  }
  const analyses = await db.loadAiAnalyses(12);
  if (analyses.length) state.aiAnalyses = analyses;
  const autoEnabled = await db.getSetting('ai_auto_enabled');
  if (autoEnabled !== null) aiAuto.auto.enabled = autoEnabled !== 'false';
  // clés Gemini / Groq saisies à chaud depuis la page Analyseur IA : rechargées
  // ici pour survivre à un redémarrage/redéploiement (Render sans disque
  // persistant efface le reste). Comme pour la clé Pollinations existante, la
  // clé à chaud prime sur la variable d'environnement si les deux sont définies
  // (voir geminiKey()/groqKey() dans ai-analyzer.js).
  const geminiKeySaved = await db.getSetting('ai_gemini_key');
  if (geminiKeySaved) ai.setGeminiKey(geminiKeySaved);
  const groqKeySaved = await db.getSetting('ai_groq_key');
  if (groqKeySaved) ai.setGroqKey(groqKeySaved);
  const openrouterKeySaved = await db.getSetting('ai_openrouter_key');
  if (openrouterKeySaved) ai.setOpenrouterKey(openrouterKeySaved);

  store.patch({
    strategies: state.strategies,
    botToken: state.botToken,
    adminId: state.adminId,
    channels: state.channels,
    activeChannels: state.activeChannels,
    aiStrategies: state.aiStrategies,
    aiAnalyses: state.aiAnalyses,
  });
  await predit.restoreFromDb();
  await afterLoss.restoreFromDb();
  await shop.loadFromDb();
  await paiement.loadFromDb();
  await mirrorCounter.loadFromDb();
  await lossNotice.loadFromDb();
  return { ok: true, loaded, added: missing, restored, aiStrategiesLoaded: aiRows.length };
}

// ---------------------------------------------------------------------------
// « Rapport de fin de sabot » : dès que le jeu revient à #N1 (nouveau sabot,
// voir resetShoe() dans predictor.js), on génère le PDF listant, pour
// CHACUNE des 7 stratégies, les déclencheurs « après perte » dont le taux
// mesuré sur l'historique réel est ≥ 75%, avec un conseil ciblé — puis on
// l'envoie en document Telegram à l'ADMINISTRATEUR (c'est une analyse
// interne, pas une prédiction à publier dans un canal public).
// ---------------------------------------------------------------------------
let shoeReportBusy = false;
async function sendShoeReport(reason, seq) {
  if (shoeReportBusy) return false; // pas deux rapports en parallèle si plusieurs resets rapprochés
  const sender = senderFor();
  if (!sender || !state.adminId) return false;
  shoeReportBusy = true;
  try {
    const { pdf } = await shoeReport.generate();
    await sender.sendDocument(
      state.adminId,
      pdf,
      { caption: `📄 Rapport de fin de sabot #${seq} (${reason}) — déclencheurs ≥ ${shoeReport.MIN_RATE}% des 7 stratégies.` },
      { filename: `rapport-sabot-${seq}.pdf`, contentType: 'application/pdf' }
    );
    return true;
  } catch (e) {
    console.error('Rapport de fin de sabot : envoi échoué —', e.message);
    return false;
  } finally {
    shoeReportBusy = false;
  }
}

async function startLoop() {
  predit.restore();
  predit.setSender(senderFor);
  afterLoss.restore();
  afterLoss.setSender(senderFor);
  formationRelay.restore();
  formationRelay.setSender(senderFor);
  // Compteur « Taux Miroir » : édite le même message à chaque jeu terminé
  // (voir setOnFinished ci-dessous) plutôt que d'en renvoyer un nouveau —
  // retombe sur un nouvel envoi si l'édition échoue (message trop
  // vieux/supprimé côté Telegram) ou après chaque reset horaire.
  mirrorCounter.setSender(async (channelId, text, messageId) => {
    const sender = senderFor();
    if (!sender) throw new Error('Aucun token API configuré dans les réglages.');
    if (messageId) {
      try {
        await sender.editMessageText(text, { chat_id: channelId, message_id: messageId });
        return messageId;
      } catch (e) {
        // message trop vieux/supprimé, ou contenu strictement identique
        // (Telegram répond alors "message is not modified") : dans les deux
        // cas on retente un envoi neuf plutôt que de laisser tomber.
      }
    }
    const msg = await sender.sendMessage(channelId, text);
    return msg.message_id;
  });
  mirrorCounter.scheduleHourlyReset();
  // base de données : chaque jeu terminé est archivé par date
  setOnFinished((round) => {
    if (db.ready) db.saveGame(round);
    mirrorCounter.bump(round);
    mirrorCounter.publish(round.number).catch((e) => console.error('Compteur (Taux Miroir) :', e.message));
  });
  // rapport PDF des déclencheurs fiables (≥75%) des 7 stratégies, envoyé à
  // l'admin à chaque nouveau sabot — voir sendShoeReport ci-dessus.
  setOnShoeReset((reason, seq) => sendShoeReport(reason, seq));
  // bilan complet (toutes stratégies + IA) — envoyé quand les numéros
  // reviennent à 1 ET que le sabot qui vient de se terminer représente une
  // vraie journée (voir sendBilanIfDayOver ci-dessus pour le seuil).
  setOnShoeReset((reason, seq, previousMax) => sendBilanIfDayOver(reason, seq, previousMax));
  setOnGateChange((key, g) => { if (db.ready) db.saveGate(key, g); });
  setOnAnnouncementSave((entry) => { if (db.ready) db.saveAnnouncement(entry); });
  setOnAnnouncementDelete((id) => { if (db.ready) db.deleteAnnouncement(id); });
  // setOnConfirm : volontairement NON branché — la confirmation de position
  // ne doit plus jamais partir dans le canal public (voir commentaire au-dessus
  // de ordinalFr()). L'entrée reste purement interne (pushAnnouncement).
  const s = await db.connect();
  console.log(s.ready ? '🗄️ Base de données connectée' : `🗄️ Base non connectée : ${s.error}`);
  if (s.ready) {
    await auth.ensureAdminSeed();
    const r = await applyDbConfigs();
    if ((r.restored || []).length) console.log('🔐 Restauré depuis la base : ' + r.restored.join(', '));
    console.log('🧠 Configurations lues en base : ' + ((r.loaded || []).join(', ') || 'aucune') +
      ((r.added || []).length ? ' • ajoutées : ' + r.added.join(', ') : ''));
  } else {
    initStrategies();
  }
  if (!loopStarted) {
    loopStarted = true;
    setInterval(tick, config.POLL_INTERVAL_MS);
    tick();
    // Vente automatique des déclencheurs IA >93% (shop.js/syncAutoIaListings) :
    // intervalle dédié, séparé du tick jeu-par-jeu (1.5s) — la génération du
    // nom de code par l'IA peut prendre plusieurs secondes, ça ne doit jamais
    // ralentir le suivi des jeux en direct. « fire and forget » volontaire.
    setInterval(() => {
      shop.syncAutoIaListings(aiAuto.listStrategies()).catch((e) => console.error('Boutique (sync IA >93%) :', e.message));
    }, 60 * 1000);
    shop.syncAutoIaListings(aiAuto.listStrategies()).catch((e) => console.error('Boutique (sync IA >93%) :', e.message));
  }
  startBot();
  startShopBot();
}

module.exports = { predit, flushBilans, setMainChannel, broadcast, sendPrediction, updateResult, startLoop, startBot, botStatus, disconnectBot, startShopBot, shopBotStatus, disconnectShopBot, activate, deactivate, persist, listChannels, sendBilan, dropSender, announceConfig, announceMainBot, resolveChat, testSend, senderFor, saveConfigsToDb, applyDbConfigs, sendShoeReport };
