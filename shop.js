// shop.js — Boutique de stratégies : chaque stratégie publiée par l'admin
// (issue du catalogue, d'une stratégie créée par l'IA, ou saisie librement)
// reçoit un NOM DE CODE inventé par l'IA (sans rapport avec son vrai nom) et
// un CODE DE PAIEMENT à usage unique. Un utilisateur qui écrit au bot choisit
// sa langue, voit la liste des stratégies (nom de code + taux de réussite),
// entre le code reçu après paiement, et reçoit alors le détail complet de la
// stratégie (traduit dans sa langue). Il peut ensuite poser des questions :
// l'IA répond STRICTEMENT dans le cadre de cette stratégie, jamais au-delà.
'use strict';

const crypto = require('crypto');
const store = require('./store');
const db = require('./db');
const ai = require('./ai-analyzer');
const strategies = require('./strategies');
const { stats: strategyStats } = require('./predictor');
const formation = require('./formation');

// ---------------------------------------------------------------------------
// Langues proposées à l'accueil du bot.
// ---------------------------------------------------------------------------
const LANGS = [
  { code: 'fr', flag: '🇫🇷', label: 'Français' },
  { code: 'en', flag: '🇬🇧', label: 'English' },
  { code: 'ar', flag: '🇸🇦', label: 'العربية' },
  { code: 'ru', flag: '🇷🇺', label: 'Русский' },
  { code: 'es', flag: '🇪🇸', label: 'Español' },
];
const LANG_NAMES = { fr: 'français', en: 'anglais', ar: 'arabe', ru: 'russe', es: 'espagnol' };
const LANG_CODES = new Set(LANGS.map((l) => l.code));

// ---------------------------------------------------------------------------
// Textes d'interface (pas besoin d'appeler l'IA pour de simples menus).
// ---------------------------------------------------------------------------
const TEXTS = {
  welcome: {
    fr: '👋 Bienvenue sur *Baccara Vend* — la boutique de stratégies de prédiction.\n\nChoisis ta langue :',
    en: "👋 Welcome to *Baccara Vend* — the prediction strategy shop.\n\nChoose your language:",
    ar: '👋 مرحبًا بك في *Baccara Vend* — متجر استراتيجيات التوقّع.\n\nاختر لغتك:',
    ru: '👋 Добро пожаловать в *Baccara Vend* — магазин стратегий прогнозирования.\n\nВыберите язык:',
    es: '👋 Bienvenido a *Baccara Vend* — la tienda de estrategias de predicción.\n\nElige tu idioma:',
  },
  shopIntro: {
    fr: '🛍️ Voici les stratégies disponibles. Le pourcentage indique leur taux de réussite. Choisis-en une :',
    en: '🛍️ Here are the available strategies. The percentage shows their success rate. Pick one:',
    ar: '🛍️ إليك الاستراتيجيات المتاحة. النسبة المئوية تمثّل معدّل نجاحها. اختر واحدة:',
    ru: '🛍️ Вот доступные стратегии. Процент — это их процент успеха. Выберите одну:',
    es: '🛍️ Aquí están las estrategias disponibles. El porcentaje indica su tasa de éxito. Elige una:',
  },
  noItems: {
    fr: "😕 Aucune stratégie n'est disponible dans la boutique pour l'instant. Reviens plus tard.",
    en: '😕 No strategy is available in the shop right now. Please check back later.',
    ar: '😕 لا توجد استراتيجية متاحة في المتجر حاليًا. عد لاحقًا من فضلك.',
    ru: '😕 Сейчас в магазине нет доступных стратегий. Загляните позже.',
    es: '😕 Ninguna estrategia está disponible en la tienda por ahora. Vuelve más tarde.',
  },
  askCode: {
    fr: '🔑 Envoie maintenant le code de paiement de cette stratégie pour la débloquer.',
    en: '🔑 Now send the payment code for this strategy to unlock it.',
    ar: '🔑 أرسل الآن رمز الدفع الخاص بهذه الاستراتيجية لفتحها.',
    ru: '🔑 Теперь отправьте код оплаты этой стратегии, чтобы разблокировать её.',
    es: '🔑 Envía ahora el código de pago de esta estrategia para desbloquearla.',
  },
  codeWrong: {
    fr: "❌ Code incorrect. Vérifie le code reçu après ton paiement et réessaie, ou tape /boutique pour revenir à la liste.",
    en: '❌ Incorrect code. Check the code you received after payment and try again, or type /boutique to go back to the list.',
    ar: '❌ رمز غير صحيح. تحقّق من الرمز الذي استلمته بعد الدفع وأعد المحاولة، أو اكتب /boutique للعودة إلى القائمة.',
    ru: '❌ Неверный код. Проверьте код, полученный после оплаты, и повторите попытку, или введите /boutique, чтобы вернуться к списку.',
    es: '❌ Código incorrecto. Comprueba el código recibido tras el pago y vuelve a intentarlo, o escribe /boutique para volver a la lista.',
  },
  codeUsed: {
    fr: '⛔ Ce code a déjà été utilisé et a expiré. Contacte l\'administrateur pour recevoir un nouveau code.',
    en: '⛔ This code has already been used and has expired. Contact the administrator to receive a new code.',
    ar: '⛔ تم استخدام هذا الرمز بالفعل وانتهت صلاحيته. تواصل مع المسؤول للحصول على رمز جديد.',
    ru: '⛔ Этот код уже использован и больше не действителен. Обратитесь к администратору за новым кодом.',
    es: '⛔ Este código ya fue utilizado y ha caducado. Contacta al administrador para recibir un nuevo código.',
  },
  itemInactive: {
    fr: "⛔ Cette stratégie n'est plus disponible. Tape /boutique pour voir les stratégies disponibles.",
    en: '⛔ This strategy is no longer available. Type /boutique to see the available strategies.',
    ar: '⛔ هذه الاستراتيجية لم تعد متاحة. اكتب /boutique لعرض الاستراتيجيات المتاحة.',
    ru: '⛔ Эта стратегия больше недоступна. Введите /boutique, чтобы увидеть доступные стратегии.',
    es: '⛔ Esta estrategia ya no está disponible. Escribe /boutique para ver las estrategias disponibles.',
  },
  unlockedHeader: {
    fr: '✅ Code accepté ! Voici ta stratégie en détail :',
    en: '✅ Code accepted! Here is your strategy in detail:',
    ar: '✅ تم قبول الرمز! إليك استراتيجيتك بالتفصيل:',
    ru: '✅ Код принят! Вот ваша стратегия подробно:',
    es: '✅ ¡Código aceptado! Aquí tienes tu estrategia en detalle:',
  },
  canAsk: {
    fr: "💬 Tu peux maintenant me poser toutes tes questions sur cette stratégie, je t'expliquerai en détail.",
    en: '💬 You can now ask me any question about this strategy, I will explain it in detail.',
    ar: '💬 يمكنك الآن طرح أي سؤال حول هذه الاستراتيجية، وسأشرحها لك بالتفصيل.',
    ru: '💬 Теперь вы можете задать любой вопрос об этой стратегии, я подробно объясню.',
    es: '💬 Ahora puedes hacerme cualquier pregunta sobre esta estrategia, te la explicaré en detalle.',
  },
  langSaved: {
    fr: '✅ Langue enregistrée : Français.',
    en: '✅ Language saved: English.',
    ar: '✅ تم حفظ اللغة: العربية.',
    ru: '✅ Язык сохранён: Русский.',
    es: '✅ Idioma guardado: Español.',
  },
  askMore: {
    fr: 'Voulez-vous que je vous explique davantage ?',
    en: 'Would you like me to explain further?',
    ar: 'هل تريد أن أشرح لك أكثر؟',
    ru: 'Хотите, я объясню подробнее?',
    es: '¿Quieres que te explique más?',
  },
  payIntro: {
    fr: '💳 Clique sur le bouton ci-dessous pour payer et débloquer cette stratégie instantanément. Tu as déjà un code ? Envoie-le directement ici.',
    en: '💳 Tap the button below to pay and unlock this strategy instantly. Already have a code? Send it directly here.',
    ar: '💳 اضغط على الزر أدناه للدفع وفتح هذه الاستراتيجية فورًا. لديك رمز بالفعل؟ أرسله مباشرة هنا.',
    ru: '💳 Нажмите на кнопку ниже, чтобы оплатить и мгновенно разблокировать эту стратегию. Уже есть код? Отправьте его прямо сюда.',
    es: '💳 Toca el botón de abajo para pagar y desbloquear esta estrategia al instante. ¿Ya tienes un código? Envíalo directamente aquí.',
  },
  payButton: {
    fr: 'Payer',
    en: 'Pay',
    ar: 'ادفع',
    ru: 'Оплатить',
    es: 'Pagar',
  },
  viewCodeButton: {
    fr: '🎟️ Voir mon code',
    en: '🎟️ View my code',
    ar: '🎟️ عرض رمزي',
    ru: '🎟️ Посмотреть мой код',
    es: '🎟️ Ver mi código',
  },
  itemLocked: {
    fr: "⏳ Un autre utilisateur est en train d'effectuer un paiement. Merci de patienter 3 minutes avant de réessayer.",
    en: '⏳ Another user is currently making a payment. Please wait 3 minutes before trying again.',
    ar: '⏳ مستخدم آخر يقوم حاليًا بالدفع. يرجى الانتظار 3 دقائق قبل إعادة المحاولة.',
    ru: '⏳ Другой пользователь сейчас выполняет оплату. Подождите 3 минуты перед повторной попыткой.',
    es: '⏳ Otro usuario está realizando un pago. Espera 3 minutos antes de volver a intentarlo.',
  },
  supportButton: {
    fr: '💛 Soutien',
    en: '💛 Support',
    ar: '💛 دعم',
    ru: '💛 Поддержка',
    es: '💛 Apoyo',
  },
  supportAskAmount: {
    fr: '💛 Merci pour ton geste ! Indique le montant de ton soutien en dollars (ex. 50).',
    en: '💛 Thank you for your support! Enter the amount of your support in dollars (e.g. 50).',
    ar: '💛 شكرًا على دعمك! أدخل مبلغ دعمك بالدولار (مثال: 50).',
    ru: '💛 Спасибо за поддержку! Укажите сумму поддержки в долларах (напр. 50).',
    es: '💛 ¡Gracias por tu apoyo! Indica el monto de tu apoyo en dólares (ej. 50).',
  },
  supportAmountInvalid: {
    fr: "❌ Montant invalide. Envoie juste un nombre en dollars (ex. 50).",
    en: '❌ Invalid amount. Just send a number in dollars (e.g. 50).',
    ar: '❌ مبلغ غير صالح. أرسل رقمًا فقط بالدولار (مثال: 50).',
    ru: '❌ Неверная сумма. Отправьте просто число в долларах (напр. 50).',
    es: '❌ Monto inválido. Envía solo un número en dólares (ej. 50).',
  },
  supportAmountShown: {
    fr: '💰 {usd}$ = {francs} F CFA.\nClique sur le bouton ci-dessous pour payer ton soutien.',
    en: '💰 {usd}$ = {francs} XOF.\nTap the button below to pay your support.',
    ar: '💰 {usd}$ = {francs} فرنك إفريقي.\nاضغط على الزر أدناه لدفع دعمك.',
    ru: '💰 {usd}$ = {francs} франков КФА.\nНажмите кнопку ниже, чтобы оплатить поддержку.',
    es: '💰 {usd}$ = {francs} F CFA.\nToca el botón de abajo para pagar tu apoyo.',
  },
  supportPayIntro: {
    fr: '💳 Clique sur le bouton ci-dessous pour finaliser ton soutien.',
    en: '💳 Tap the button below to complete your support.',
    ar: '💳 اضغط على الزر أدناه لإتمام دعمك.',
    ru: '💳 Нажмите кнопку ниже, чтобы завершить поддержку.',
    es: '💳 Toca el botón de abajo para completar tu apoyo.',
  },
  supportThanks: {
    fr: '🙏 {buyerName}, Sossou Kouamé te remercie infiniment ! Tu as versé {usd}$ ({francs} F CFA) pour ton soutien. Merci du fond du cœur ❤️',
    en: '🙏 {buyerName}, Sossou Kouamé thanks you infinitely! You gave {usd}$ ({francs} XOF) as support. Thank you from the bottom of my heart ❤️',
    ar: '🙏 {buyerName}، سوسو كوامي يشكرك من كل قلبه! لقد دفعت {usd}$ ({francs} فرنك إفريقي) كدعم. شكرًا جزيلاً ❤️',
    ru: '🙏 {buyerName}, Соссу Куаме бесконечно благодарит тебя! Ты внёс {usd}$ ({francs} франков КФА) в поддержку. Спасибо от всего сердца ❤️',
    es: '🙏 {buyerName}, ¡Sossou Kouamé te lo agradece infinitamente! Diste {usd}$ ({francs} F CFA) de apoyo. Gracias de todo corazón ❤️',
  },
};

// ---------------------------------------------------------------------------
// Remerciement de fin de discussion — une fois que l'acheteur dit avoir
// compris la stratégie (« compris », « understood », « понятно »…), le bot
// le remercie, lui souhaite bonne chance, PUIS donne un vrai conseil issu du
// panneau « Formation » (formation.js) pour CETTE stratégie précise : combien
// de prédictions jouer d'affilée après une perte/rattrapage, et avec quel
// taux observé — jamais un conseil générique inventé.
// ---------------------------------------------------------------------------
const THANKS_TEMPLATES = {
  fr: "🙏 Merci d'avoir acheté la stratégie « {name} » ! Je te souhaite bonne chance pour tes prochaines parties.",
  en: '🙏 Thank you for buying the "{name}" strategy! I wish you good luck for your next games.',
  ar: '🙏 شكرًا لشرائك استراتيجية «{name}»! أتمنى لك حظًا موفقًا في جولاتك القادمة.',
  ru: '🙏 Спасибо за покупку стратегии «{name}»! Желаю удачи в следующих играх.',
  es: '🙏 ¡Gracias por comprar la estrategia «{name}»! Te deseo mucha suerte en tus próximas partidas.',
};
const FORMATION_INTRO = {
  fr: '📋 Un conseil tiré de la formation observée pour cette stratégie :',
  en: '📋 A tip from the training pattern observed for this strategy:',
  ar: '📋 نصيحة مستخلصة من التكوين الملاحَظ لهذه الاستراتيجية:',
  ru: '📋 Небольшой совет на основе наблюдаемой формации для этой стратегии:',
  es: '📋 Un consejo basado en la formación observada para esta estrategia:',
};
const NO_FORMATION_TEXT = {
  fr: "Je n'ai pas encore assez de données de jeu pour te donner un conseil de formation fiable sur cette stratégie précise — reviens me demander plus tard, une fois qu'elle aura plus d'historique.",
  en: "I don't have enough game data yet for a reliable training tip on this specific strategy — ask me again later once it has more history.",
  ar: 'ليس لدي بعد بيانات كافية لتقديم نصيحة تكوين موثوقة لهذه الاستراتيجية بالذات — اسألني لاحقًا عندما يتوفر سجل أطول.',
  ru: 'У меня пока недостаточно данных, чтобы дать надёжный совет по формации именно для этой стратегии — спросите позже, когда накопится больше истории.',
  es: 'Todavía no tengo suficientes datos de juego para un consejo de formación fiable sobre esta estrategia en concreto — pregúntame más tarde cuando tenga más historial.',
};

// Détection multilingue (fr/en/ar/ru/es) d'un message signalant que
// l'acheteur a compris. On exclut d'abord toute négation courante (« pas »,
// « don't », « не »...) pour ne jamais confondre avec une vraie question du
// type « je n'ai pas bien compris pourquoi... » ou « I don't understand ».
const NEGATION_HINTS = /\b(pas|jamais|aucun(?:e)?|n'ai|don'?t|doesn'?t|didn'?t|not|no\s+entiendo|не\s|нет|لا\s|غير)\b/i;
const UNDERSTOOD_PATTERNS = [
  /\bcompris\b/i,
  /\bc'?est\s+(clair|bon)\b/i,
  /\bunderstood\b/i,
  /\b(get|understand)\s+it\b/i,
  /\bgot\s+it\b/i,
  /\bunderstand\b/i,
  /понял|поняла|понятно|ясно/i,
  /entendido|lo\s+entiend[oí]|entend[íi]/i,
  /فهمت|واضح/,
];
function isUnderstoodMessage(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 160) return false;
  if (NEGATION_HINTS.test(s)) return false;
  return UNDERSTOOD_PATTERNS.some((re) => re.test(s));
}

// Cherche l'entrée du panneau Formation correspondant à la stratégie
// achetée (par clé technique réelle — jamais par nom de code) et renvoie son
// constat en français brut, ou null si pas assez de données/pas de lien.
async function formationFindingsFor(item) {
  let st = formation.status();
  if (!st.lastRunAt) {
    try { st = await formation.run(); } catch (_) { return null; }
  }
  const list = st.strategies || [];
  let key = null;
  if (item.source === 'strategy' && item.sourceKey) key = item.sourceKey;
  else if (item.sourceKey === 'predit') key = 'predit';
  if (!key) return null;
  const entry = list.find((s) => s.key === key);
  if (!entry || !entry.findings || !entry.findings.length) return null;
  return entry.findings.join(' ');
}

async function closingMessage(item, lang) {
  const headerTpl = THANKS_TEMPLATES[lang] || THANKS_TEMPLATES.fr;
  const header = headerTpl.replace('{name}', item.aiName || '');
  const findingsFr = await formationFindingsFor(item);
  let body;
  if (findingsFr) {
    const intro = FORMATION_INTRO[lang] || FORMATION_INTRO.fr;
    const findingsTranslated = await translate(findingsFr, lang);
    body = `${intro}\n${findingsTranslated}`;
  } else {
    body = NO_FORMATION_TEXT[lang] || NO_FORMATION_TEXT.fr;
  }
  return `${header}\n\n${body}`;
}

function t(key, lang) {
  const l = LANG_CODES.has(lang) ? lang : 'fr';
  return (TEXTS[key] && TEXTS[key][l]) || (TEXTS[key] && TEXTS[key].fr) || '';
}

// ---------------------------------------------------------------------------
// État (persisté dans data.json, avec repli en base via db.setSetting, même
// mécanisme que site_channels dans bot.js).
// ---------------------------------------------------------------------------
const shop = {
  items: [],   // stratégies publiées dans la boutique
  users: {},   // { [telegramUserId]: { lang, unlocked: [itemId], pendingCode: itemId|null, activeItem: itemId|null } }
  settings: {}, // { priceCatalog, priceIa } — tarifs par défaut, modifiables depuis le bouton « Modifier les prix »
};

(function loadInitial() {
  try {
    const saved = store.read().shop;
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.items)) shop.items = saved.items;
      if (saved.users && typeof saved.users === 'object') shop.users = saved.users;
      if (saved.settings && typeof saved.settings === 'object') shop.settings = saved.settings;
    }
  } catch (_) { /* ignore */ }
})();

function persist() {
  store.patch({ shop: { items: shop.items, users: shop.users, settings: shop.settings } });
  if (db.ready) {
    db.setSetting('shop_data', JSON.stringify({ items: shop.items, users: shop.users, settings: shop.settings })).catch(() => {});
  }
}

// appelée depuis bot.js une fois la base confirmée prête, comme pour
// site_channels/ai_created_strategy_keys — restaure la boutique après un
// redémarrage même si data.json a été perdu (disque non persistant).
async function loadFromDb() {
  if (!db.ready) return false;
  try {
    const raw = await db.getSetting('shop_data');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.items) && (parsed.items.length || !shop.items.length)) shop.items = parsed.items;
    if (parsed.users && typeof parsed.users === 'object') shop.users = { ...parsed.users, ...shop.users };
    if (parsed.settings && typeof parsed.settings === 'object') shop.settings = { ...parsed.settings, ...shop.settings };
    return true;
  } catch (_) { return false; }
}

function user(id) {
  const key = String(id);
  if (!shop.users[key]) shop.users[key] = { lang: null, unlocked: [], pendingCode: null, activeItem: null, pendingSupport: false };
  return shop.users[key];
}

function getLang(id) { return (shop.users[String(id)] && shop.users[String(id)].lang) || null; }
function setLang(id, lang) {
  if (!LANG_CODES.has(lang)) return false;
  user(id).lang = lang;
  persist();
  return true;
}

function setPendingCode(id, itemId) { user(id).pendingCode = itemId; user(id).activeItem = null; persist(); }
function getPendingCode(id) { const u = shop.users[String(id)]; return u ? u.pendingCode : null; }
function clearPendingCode(id) { const u = shop.users[String(id)]; if (u) { u.pendingCode = null; persist(); } }

function setActiveItem(id, itemId) { user(id).activeItem = itemId; persist(); }
function getActiveItem(id) { const u = shop.users[String(id)]; return u ? u.activeItem : null; }

// État « en attente de saisie d'un montant de soutien (en $) » — distinct du
// pendingCode (achat d'une stratégie), pour le bouton « Soutien » du menu.
function setPendingSupport(id, value) { user(id).pendingSupport = !!value; persist(); }
function getPendingSupport(id) { const u = shop.users[String(id)]; return u ? !!u.pendingSupport : false; }
function clearPendingSupport(id) { const u = shop.users[String(id)]; if (u) { u.pendingSupport = false; persist(); } }

// ---------------------------------------------------------------------------
// Génération : nom de code (IA) et code de paiement.
// ---------------------------------------------------------------------------
function shortId() { return crypto.randomBytes(4).toString('hex'); }
function genCode() { return `BAC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }

const NAME_A = ['Éclipse', 'Zénith', 'Alizée', 'Onyx', 'Météore', 'Vermeil', 'Cobalt', 'Solstice', 'Nébuleuse', 'Émeraude', 'Orage', 'Mirage'];
const NAME_B = ['Dorée', 'Silencieuse', 'Boréale', 'Ultime', 'Discrète', 'Royale', 'Secrète', 'Nocturne', 'Rapide', 'Précise', 'Furtive', 'Éclatante'];

// Tarifs par défaut selon l'origine de la stratégie / le palier de taux de
// réussite. Utilisés si aucun prix n'est fourni explicitement à la création.
// Modifiables depuis le panneau « Modifier les prix par méthode » de la
// boutique (voir setMethodPrice ci-dessous) — le nouveau tarif est alors à
// la fois appliqué à TOUS les articles déjà publiés de ce type/palier et
// retenu comme nouveau défaut pour les prochaines publications.
// - Catalogue (stratégies existantes) : un seul tarif, 50€ par défaut.
// - Déclencheurs IA : DEUX paliers selon le taux de réussite —
//   100% de réussite -> 2€, de 93% à 99,99% -> 1,8€ (promo ; 4€ hors promo).
const DEFAULT_PRICE_CATALOG = 50;
const DEFAULT_PRICE_IA_100 = 2;
const DEFAULT_PRICE_IA_93 = 1.8; // palier 93% à 99,99% — promo en cours (prix normal habituel : 4€)
function getPriceCatalog() { return Number.isFinite(shop.settings.priceCatalog) ? shop.settings.priceCatalog : DEFAULT_PRICE_CATALOG; }
function getPriceIa100() { return Number.isFinite(shop.settings.priceIa100) ? shop.settings.priceIa100 : DEFAULT_PRICE_IA_100; }
function getPriceIa93() { return Number.isFinite(shop.settings.priceIa93) ? shop.settings.priceIa93 : DEFAULT_PRICE_IA_93; }
// Tarif IA applicable pour un taux de réussite donné : palier 100% si le
// taux atteint 100, palier 93-99,99% s'il est ≥ 93 (donc aussi utilisé en
// repli pour une publication manuelle IA sans taux connu, ou en dessous
// de 93 — l'admin reste libre de surcharger le prix à la main dans ce cas).
function priceForIaRate(rate) {
  if (Number.isFinite(rate) && rate >= 100) return getPriceIa100();
  return getPriceIa93();
}

// Conversion € -> francs CFA (XOF) pour calculer automatiquement le montant
// à intégrer dans le lien de paiement direct Money Fusion (payAmountLocal),
// à partir du prix en €. Taux confirmé au départ par un lien réel fourni par
// l'admin : https://payin.moneyfusion.net/payment/6a8abd93ff0cbef4d3e8f6a3/24000/Sossou%20Kouam%C3%A9
// -> 24000 correspond à 50€, soit 24000 / 50 = 480 F/€. Ce taux est modifiable
// par l'admin depuis le panneau boutique (voir setExchangeRate ci-dessous) —
// dès qu'il change, TOUS les montants en francs déjà publiés sont recalculés.
const DEFAULT_EUR_TO_XOF = 480;
function getEurToXof() {
  return Number.isFinite(shop.settings.eurToXof) ? shop.settings.eurToXof : DEFAULT_EUR_TO_XOF;
}
function eurToFrancs(price) {
  return Number.isFinite(price) ? Math.round(price * getEurToXof()) : null;
}

// Les anciennes stratégies peuvent ne pas avoir encore de montant CFA
// enregistré. On le recalcule depuis le prix affiché afin de toujours
// proposer le lien de paiement.
function paymentAmountFor(item) {
  if (!item) return null;
  const saved = Number(item.payAmountLocal);
  if (Number.isFinite(saved) && saved > 0) return Math.round(saved);
  const price = Number(item.price);
  return Number.isFinite(price) && price > 0 ? eurToFrancs(price) : null;
}

// Expire le code affiché sur succes.html à la fin de la réservation. On ne
// change le code que s'il s'agit toujours de celui de ce paiement : un code
// déjà utilisé ou remplacé entre-temps ne doit pas être écrasé.
function expirePaymentCode(itemId, code) {
  const item = getItem(itemId);
  if (!item || !code) return false;
  if (String(item.code || '').toUpperCase() !== String(code).toUpperCase()) return false;
  item.code = genCode();
  item.updatedAt = new Date().toISOString();
  persist();
  return true;
}
// Change le taux de change € -> F CFA : retenu comme nouveau défaut ET
// appliqué immédiatement (montant en francs recalculé) à TOUS les articles
// déjà publiés qui ont un prix en € connu.
function setExchangeRate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) throw new Error('Taux de change invalide.');
  shop.settings.eurToXof = r;
  let count = 0;
  for (const item of shop.items) {
    if (!Number.isFinite(item.price)) continue;
    const francs = eurToFrancs(item.price);
    if (francs == null) continue;
    item.payAmountLocal = francs;
    item.updatedAt = new Date().toISOString();
    count += 1;
  }
  persist();
  return { pricing: getPricingSettings(), updatedCount: count };
}
function defaultPayAmountFor(source, price) {
  const francs = eurToFrancs(price);
  if (francs != null) return francs;
  return null; // prix inconnu (ex. 'custom' sans prix saisi) : à régler manuellement
}
function defaultPriceFor(source, rate) {
  if (source === 'strategy') return getPriceCatalog();
  if (source === 'ia') return priceForIaRate(rate);
  return null; // 'custom' : prix laissé au choix de l'admin
}

// Tarifs courants (catalogue + les deux paliers IA), à afficher dans le
// panneau « Modifier les prix » de la boutique.
function getPricingSettings() {
  return { priceCatalog: getPriceCatalog(), priceIa100: getPriceIa100(), priceIa93: getPriceIa93(), eurToXof: getEurToXof(), usdToXof: getUsdToXof() };
}

// Taux de change $ -> F CFA (XOF) pour le bouton « Soutien » (dons libres,
// distincts des ventes de stratégies). Modifiable depuis le panneau admin —
// voir setSupportRate ci-dessous. Pas de valeur « confirmée » comme pour
// EUR_TO_XOF : à vérifier/ajuster par l'admin selon le taux réel du jour.
const DEFAULT_USD_TO_XOF = 600;
function getUsdToXof() { return Number.isFinite(shop.settings.usdToXof) ? shop.settings.usdToXof : DEFAULT_USD_TO_XOF; }
function setSupportRate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) throw new Error('Taux de change invalide.');
  shop.settings.usdToXof = r;
  persist();
  return { pricing: getPricingSettings() };
}

// Message de remerciement envoyé au client dès que son paiement de soutien
// est confirmé (voir bot.js/paidHandler, branché sur record.kind === 'support').
function supportThanksMessage(record, lang) {
  return t('supportThanks', lang)
    .replace('{buyerName}', record.buyerName || 'Ami(e)')
    .replace('{usd}', String(record.amountUsd))
    .replace('{francs}', String(record.amount));
}

// Change le tarif d'une méthode/palier : retenu comme nouveau défaut pour
// les prochaines publications ET appliqué immédiatement — avec conversion
// automatique en francs pour le lien de paiement — à TOUS les articles déjà
// publiés concernés :
// - method 'strategy' : tous les articles du catalogue (source === 'strategy').
// - method 'ia_100'    : déclencheurs IA à 100% de réussite (source === 'ia', rate === 100).
// - method 'ia_93'     : déclencheurs IA de 93% à 99,99% (source === 'ia', rate < 100, incluant rate absent).
function setMethodPrice(method, price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) throw new Error('Prix invalide.');
  const settingsKey = { strategy: 'priceCatalog', ia_100: 'priceIa100', ia_93: 'priceIa93' }[method];
  if (!settingsKey) throw new Error('Méthode inconnue (attendu : strategy, ia_100 ou ia_93).');
  shop.settings[settingsKey] = p;
  const francs = eurToFrancs(p);
  let count = 0;
  for (const item of shop.items) {
    if (item.source !== (method === 'strategy' ? 'strategy' : 'ia')) continue;
    if (method === 'ia_100' && item.rate !== 100) continue;
    if (method === 'ia_93' && item.rate === 100) continue;
    item.price = p;
    if (francs != null) item.payAmountLocal = francs;
    item.updatedAt = new Date().toISOString();
    count += 1;
  }
  persist();
  return { pricing: getPricingSettings(), updatedCount: count };
}
function fallbackName() {
  return `${NAME_A[Math.floor(Math.random() * NAME_A.length)]} ${NAME_B[Math.floor(Math.random() * NAME_B.length)]}`;
}

function cleanText(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .trim();
}

async function generateAiName(existingNames = []) {
  try {
    const raw = await ai.chat({
      system: "Tu inventes un nom de code court (2 à 3 mots), élégant et mémorable, pour une stratégie vendue dans une boutique privée. INTERDIT : tout mot lié au baccarat, aux cartes, au jeu d'argent, aux prédictions, aux statistiques ou aux pourcentages — le nom doit sembler complètement neutre (ex. nom de code d'agence, constellation, objet précieux, phénomène naturel). Réponds UNIQUEMENT avec le nom, sans guillemets, sans ponctuation finale, rien d'autre.",
      user: `Invente un nouveau nom de code, différent de ceux déjà utilisés : ${existingNames.join(', ') || 'aucun'}.`,
      temperature: 0.9,
      timeoutMs: 15000,
    });
    const name = cleanText(raw).split('\n')[0].replace(/["'«»_#]/g, '').trim().slice(0, 40);
    if (name && !existingNames.includes(name)) return name;
  } catch (_) { /* repli ci-dessous */ }
  let name = fallbackName();
  let guard = 0;
  while (existingNames.includes(name) && guard < 10) { name = fallbackName(); guard += 1; }
  return name;
}

async function translate(text, lang) {
  if (!text) return text;
  if (!lang || lang === 'fr') return text;
  try {
    const raw = await ai.chat({
      system: `Traduis fidèlement le texte suivant en ${LANG_NAMES[lang] || 'anglais'}. Réponds UNIQUEMENT avec la traduction, texte brut, sans guillemets, sans commentaire, sans markdown.`,
      user: text,
      temperature: 0.2,
      timeoutMs: 20000,
    });
    const out = cleanText(raw);
    return out || text;
  } catch (_) {
    return text; // repli : texte original en français plutôt que rien
  }
}

// ---------------------------------------------------------------------------
// CRUD des articles de la boutique.
// ---------------------------------------------------------------------------
function listAll() { return [...shop.items].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')); }
function listActive() { return listAll().filter((i) => i.active); }
function getItem(id) { return shop.items.find((i) => i.id === id) || null; }

async function createItem({ source = 'custom', sourceKey = null, realName = '', details = '', example = '', rate = null, price = null, payAmountLocal = null, auto = false } = {}) {
  const existingNames = shop.items.map((i) => i.aiName);
  const aiName = await generateAiName(existingNames);
  const finalRate = Number.isFinite(rate) ? rate : null;
  const finalPrice = Number.isFinite(price) ? price : defaultPriceFor(source, finalRate);
  const item = {
    id: `shop_${shortId()}`,
    source, // 'strategy' | 'ia' | 'custom'
    sourceKey,
    realName: realName || sourceKey || '',
    aiName,
    details: String(details || ''),
    example: String(example || ''),
    rate: finalRate,
    price: finalPrice,
    // montant à intégrer dans le lien de paiement direct Money Fusion (voir
    // paiement.js) — distinct du prix affiché en € au client ; calculé
    // automatiquement à partir du prix (voir eurToFrancs ci-dessus), à
    // régler manuellement seulement si le prix est inconnu (ex. personnalisée
    // sans prix saisi).
    payAmountLocal: Number.isFinite(payAmountLocal) ? payAmountLocal : defaultPayAmountFor(source, finalPrice),
    auto: !!auto, // publiée automatiquement (déclencheur IA >93%) — voir syncAutoIaListings()
    code: genCode(),
    active: true,
    codeUsedBy: null,
    codeUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  shop.items.unshift(item);
  persist();
  return item;
}

function updateItem(id, patch = {}) {
  const item = getItem(id);
  if (!item) return null;
  const allowed = ['details', 'example', 'rate', 'active', 'realName', 'aiName', 'price', 'payAmountLocal'];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) item[k] = patch[k];
  }
  item.updatedAt = new Date().toISOString();
  persist();
  return item;
}

function deleteItem(id) {
  const before = shop.items.length;
  shop.items = shop.items.filter((i) => i.id !== id);
  if (shop.items.length !== before) { persist(); return true; }
  return false;
}

function regenerateCode(id) {
  const item = getItem(id);
  if (!item) return null;
  item.code = genCode();
  item.codeUsedBy = null;
  item.codeUsedAt = null;
  item.updatedAt = new Date().toISOString();
  persist();
  return item;
}

async function renameItem(id) {
  const item = getItem(id);
  if (!item) return null;
  const existingNames = shop.items.filter((i) => i.id !== id).map((i) => i.aiName);
  item.aiName = await generateAiName(existingNames);
  item.updatedAt = new Date().toISOString();
  persist();
  return item;
}

// Publication rapide depuis une stratégie du catalogue (real strategy) : le
// taux courant est capturé en instantané (photographié au moment de la
// publication) — un bouton « actualiser le taux » permet de le remettre à
// jour plus tard sans changer le nom de code ni le code déjà distribué.
function publishFromStrategy(key, { details = '', example = '', price = null, payAmountLocal = null } = {}) {
  const def = strategies.BY_KEY[key];
  if (!def) return null;
  const s = strategyStats(key);
  return createItem({
    source: 'strategy',
    sourceKey: key,
    realName: def.name,
    details: details || def.about || '',
    example,
    rate: s && s.total ? s.rate : null,
    price,
    payAmountLocal,
  });
}

// Publication depuis une stratégie créée par l'IA (pattern-miner / ai-auto) :
// on COPIE le déclencheur/la cible/le taux au moment de la publication car
// ces stratégies expirent automatiquement au bout d'1h côté ai-auto.js.
function publishFromAiStrategy(aiItem, { details = '', example = '', price = null, payAmountLocal = null, auto = false } = {}) {
  if (!aiItem) return null;
  const autoText = [
    aiItem.trigger ? `Déclencheur : ${aiItem.trigger}` : null,
    aiItem.target ? `Cible : ${aiItem.target}` : null,
  ].filter(Boolean).join('\n');
  return createItem({
    source: 'ia',
    sourceKey: aiItem.id || aiItem.key || null,
    realName: aiItem.name || '',
    details: details || autoText || (aiItem.name || ''),
    example,
    rate: Number.isFinite(aiItem.rate) ? aiItem.rate : null,
    price,
    payAmountLocal,
    auto,
  });
}

function refreshRateFromStrategy(id) {
  const item = getItem(id);
  if (!item || item.source !== 'strategy' || !item.sourceKey) return item;
  const s = strategyStats(item.sourceKey);
  if (s && s.total) { item.rate = s.rate; item.updatedAt = new Date().toISOString(); persist(); }
  return item;
}

// ---------------------------------------------------------------------------
// Vente automatique des déclencheurs IA à plus de 93% de réussite — AUCUNE
// configuration admin nécessaire : dès qu'un déclencheur créé par l'IA
// (ai-auto.js / pattern-miner) dépasse 93% de réussite, il est publié tout
// seul dans la boutique, au tarif du palier correspondant (100% -> palier
// « ia_100 », 93 à 99,99% -> palier « ia_93 » — voir priceForIaRate), avec
// le montant en francs recalculé automatiquement (nom de code + code de
// paiement générés comme pour une publication manuelle). Dès que son taux
// redescend à 93% ou moins — ou qu'il expire côté ai-auto.js (1h) — il
// disparaît automatiquement de la boutique (désactivé, plus proposé aux
// acheteurs). Appelée à intervalle régulier par bot.js (tick), avec la
// liste courante de aiAuto.listStrategies().
// ---------------------------------------------------------------------------
const AUTO_IA_THRESHOLD = 93;

async function syncAutoIaListings(aiList) {
  const list = Array.isArray(aiList) ? aiList : [];
  const byId = new Map(list.filter((s) => s && s.id).map((s) => [s.id, s]));
  let changed = false;

  // 1) publication / mise à jour des déclencheurs IA au-dessus du seuil
  for (const ia of list) {
    if (!ia || !ia.id || !Number.isFinite(ia.rate) || ia.rate <= AUTO_IA_THRESHOLD) continue;
    const existing = shop.items.find((i) => i.source === 'ia' && i.auto && i.sourceKey === ia.id);
    if (existing) {
      const newPrice = priceForIaRate(ia.rate);
      if (existing.rate !== ia.rate || !existing.active || existing.price !== newPrice) {
        existing.rate = ia.rate;
        existing.active = true;
        // le taux a pu franchir le palier 93%/100% depuis la dernière
        // synchro : le prix (et le montant en francs du lien de paiement)
        // sont recalculés en conséquence, sauf si l'admin a lui-même changé
        // le prix de cet article précis à un montant hors des deux paliers
        // (auquel cas on respecte son choix).
        const onKnownTier = existing.price === getPriceIa100() || existing.price === getPriceIa93();
        if (onKnownTier && existing.price !== newPrice) {
          existing.price = newPrice;
          const francs = eurToFrancs(newPrice);
          if (francs != null) existing.payAmountLocal = francs;
        }
        existing.updatedAt = new Date().toISOString();
        changed = true;
      }
    } else {
      await publishFromAiStrategy(ia, { auto: true, price: priceForIaRate(ia.rate) });
      changed = true; // createItem() a déjà persisté, mais on force la relecture ailleurs
    }
  }

  // 2) désactivation automatique de ce qui est retombé ≤ 93% ou a expiré
  for (const item of shop.items) {
    if (item.source !== 'ia' || !item.auto) continue;
    const current = byId.get(item.sourceKey);
    const stillAbove = current && Number.isFinite(current.rate) && current.rate > AUTO_IA_THRESHOLD;
    if (!stillAbove && item.active) {
      item.active = false;
      item.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) persist();
  return changed;
}

// ---------------------------------------------------------------------------
// Achat / déblocage par code — utilisé pour la saisie manuelle ET pour un
// paiement en ligne confirmé (paiement.js soumet alors le code courant de
// l'article lui-même, exactement comme si le client l'avait tapé).
// ---------------------------------------------------------------------------
function redeem(userId, itemId, code) {
  const item = getItem(itemId);
  if (!item || !item.active) return { ok: false, reason: 'inactive' };

  // CORRECTIF : un acheteur qui a DÉJÀ débloqué cette stratégie ne doit plus
  // JAMAIS être bloqué dessus, quel que soit l'état du code affiché ensuite
  // (une revente à quelqu'un d'autre a pu régénérer le code entre-temps) —
  // il la reverra toujours, sans consommer/perturber le code courant.
  if (hasUnlocked(userId, itemId)) {
    setActiveItem(userId, itemId);
    clearPendingCode(userId);
    return { ok: true, item };
  }

  const submitted = String(code || '').trim().toUpperCase();
  if (submitted !== String(item.code || '').toUpperCase()) return { ok: false, reason: 'wrong' };

  // CORRECTIF (bug « nouveau code toujours refusé ») : avant, `codeUsedBy`
  // restait enregistré avec l'ID du TOUT PREMIER acheteur et n'était jamais
  // effacé lors de la régénération automatique du code ci-dessous — un
  // DEUXIÈME acheteur légitime, muni du nouveau code fraîchement généré,
  // se voyait donc répondre « code déjà utilisé et expiré » (reason='used')
  // alors que ce nouveau code n'avait jamais servi. Comme on vient de
  // vérifier que le code saisi est bien LE code courant et valide, il n'y a
  // plus besoin de gate sur un ancien `codeUsedBy` : correspondre au code
  // courant suffit à prouver que c'est un achat légitime et non rejoué.
  unlockItem(item, userId);
  return { ok: true, item };
}

function unlockItem(item, userId) {
  item.codeUsedBy = String(userId);
  item.codeUsedAt = new Date().toISOString();
  item.salesCount = (item.salesCount || 0) + 1;
  // Code à usage unique : dès que la saisie réussit, il expire immédiatement
  // et un NOUVEAU code est généré automatiquement pour cette stratégie (sur
  // le site comme côté bot) — sans action de l'administrateur. L'ancien code
  // ne peut plus jamais être réutilisé (il ne correspondra plus à item.code).
  item.code = genCode();
  item.updatedAt = new Date().toISOString();

  const u = user(userId);
  if (!u.unlocked.includes(item.id)) u.unlocked.push(item.id);
  u.pendingCode = null;
  u.activeItem = item.id;
  persist();
}

function hasUnlocked(userId, itemId) {
  const u = shop.users[String(userId)];
  return !!(u && u.unlocked.includes(itemId));
}

// ---------------------------------------------------------------------------
// Explication IA — strictement bornée aux détails/exemple de LA stratégie
// achetée, jamais aux données internes du bot ni aux autres stratégies.
//
// CORRECTIF : pour une stratégie issue du catalogue (source === 'strategy'),
// l'admin n'a JAMAIS besoin de retaper une description à la main — le champ
// « détails » de la boutique peut rester vide, l'IA doit se baser directement
// sur le vrai texte `about` de la stratégie (strategies.js), déjà écrit et
// tenu à jour dans le code. Avant ce correctif, explain()/fullPresentation()
// ne lisaient QUE item.details : s'il était vide (article publié sans rien
// saisir), l'IA répondait honnêtement qu'elle n'avait aucune information —
// alors que la vraie description existait bel et bien dans strategies.js.
// resolvedDetails() va la chercher dynamiquement à CHAQUE explication, donc
// ça corrige aussi les articles déjà publiés (pas besoin de les recréer).
// ---------------------------------------------------------------------------
function resolvedDetails(item) {
  if (item.details && item.details.trim()) return item.details;
  if (item.source === 'strategy' && item.sourceKey) {
    const def = strategies.BY_KEY[item.sourceKey];
    if (def && def.about) return def.about;
  }
  return item.details || '';
}

async function explain(item, question, lang) {
  const details = resolvedDetails(item);
  const system = [
    "Tu t'appelles Sossou Kouamé. Si on te demande qui tu es ou comment tu t'appelles, présente-toi ainsi (« Je suis Sossou Kouamé ») ; sinon, ne le répète pas à chaque message, ce n'est utile que quand on te le demande.",
    `Tu expliques EXCLUSIVEMENT la stratégie nommée "${item.aiName}" à un client qui vient de l'acheter.`,
    "Base-toi UNIQUEMENT sur les informations fournies ci-dessous (détails + exemple). N'invente et ne révèle RIEN d'autre : ni les autres stratégies de la boutique, ni le fonctionnement interne du bot, ni du code, ni des données techniques.",
    "Ton explication doit TOUJOURS se terminer par un exemple concret et chiffré, avec de vrais numéros de jeu fictifs, au format : « Exemple : au jeu n°X, on observe [ce que dit la règle]. Au jeu n°X+N, tu prédis [résultat prédit]. » Si aucun exemple n'a été fourni ci-dessous, INVENTE-en un toi-même, cohérent avec les détails fournis (choisis des numéros de jeu plausibles) — ne reste jamais uniquement théorique.",
    "Si les détails fournis sont vraiment vides ou insuffisants pour construire quoi que ce soit de cohérent, dis-le clairement au lieu d'improviser une fausse règle.",
    "Si la question sort du cadre de cette stratégie précise, réponds poliment que tu ne peux répondre qu'aux questions concernant cette stratégie.",
    "Termine TOUJOURS ta réponse par une courte question invitant le client à demander plus de détails s'il le souhaite (par exemple : « Voulez-vous que je vous explique davantage ? »), reformulée dans la langue de réponse.",
    `Réponds en ${LANG_NAMES[lang] || 'français'}, texte brut, en phrases claires et naturelles, sans markdown, sans astérisques, sans puces.`,
  ].join(' ');
  // Deux tentatives : ai.chat() bascule déjà entre plusieurs fournisseurs
  // (OpenRouter → Gemini → Groq → Pollinations → secours gratuit), mais un
  // aléa réseau isolé peut faire échouer les deux essais très vite ; on
  // retente une fois avant de basculer sur le repli local ci-dessous, pour
  // que le client reçoive quasi toujours une VRAIE réponse de l'IA.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await ai.chat({
        system,
        user: { question, details, example: item.example },
        temperature: 0.3,
        timeoutMs: 20000,
      });
      const out = cleanText(raw);
      if (out) return out;
    } catch (_) { /* on retente, puis on bascule sur le repli local */ }
  }
  // Repli local : l'IA est injoignable (aucun fournisseur configuré/en
  // panne) — le client ne doit JAMAIS recevoir un message générique du type
  // « stratégie indisponible ». On construit une explication directement à
  // partir des détails/exemple enregistrés, traduits si besoin.
  const fallbackDetails = await translate(details, lang);
  const fallbackExample = item.example ? await translate(item.example, lang) : '';
  const more = t('askMore', lang);
  return `${fallbackDetails}${fallbackExample ? '\n\nExemple : ' + fallbackExample : ''}\n\n${more}`;
}

async function fullPresentation(item, lang) {
  const question = "Présente cette stratégie de façon claire et structurée : explique la logique en une ou deux phrases simples, PUIS donne un exemple concret et chiffré (numéros de jeu fictifs à l'appui, ex. « Jeu n°X : ... Jeu n°X+N : tu prédis ... ») pour bien montrer comment l'utiliser en pratique.";
  const ans = await explain(item, question, lang);
  if (ans) return ans;
  const details = await translate(resolvedDetails(item), lang);
  const example = item.example ? await translate(item.example, lang) : '';
  return `${details}${example ? '\n\nExemple : ' + example : ''}`;
}

module.exports = {
  LANGS, LANG_CODES,
  AUTO_IA_THRESHOLD,
  getPricingSettings, setMethodPrice, setExchangeRate, setSupportRate, getUsdToXof, supportThanksMessage,
  paymentAmountFor,
  expirePaymentCode,
  t,
  loadFromDb,
  listAll, listActive, getItem,
  createItem, updateItem, deleteItem, regenerateCode, renameItem,
  publishFromStrategy, publishFromAiStrategy, refreshRateFromStrategy,
  syncAutoIaListings,
  getLang, setLang,
  setPendingCode, getPendingCode, clearPendingCode,
  setActiveItem, getActiveItem,
  setPendingSupport, getPendingSupport, clearPendingSupport,
  redeem, hasUnlocked,
  explain, fullPresentation, translate,
  isUnderstoodMessage, closingMessage,
};
