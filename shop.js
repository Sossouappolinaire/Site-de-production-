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
};

(function loadInitial() {
  try {
    const saved = store.read().shop;
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.items)) shop.items = saved.items;
      if (saved.users && typeof saved.users === 'object') shop.users = saved.users;
    }
  } catch (_) { /* ignore */ }
})();

function persist() {
  store.patch({ shop: { items: shop.items, users: shop.users } });
  if (db.ready) {
    db.setSetting('shop_data', JSON.stringify({ items: shop.items, users: shop.users })).catch(() => {});
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
    return true;
  } catch (_) { return false; }
}

function user(id) {
  const key = String(id);
  if (!shop.users[key]) shop.users[key] = { lang: null, unlocked: [], pendingCode: null, activeItem: null };
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

// ---------------------------------------------------------------------------
// Génération : nom de code (IA) et code de paiement.
// ---------------------------------------------------------------------------
function shortId() { return crypto.randomBytes(4).toString('hex'); }
function genCode() { return `BAC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }

const NAME_A = ['Éclipse', 'Zénith', 'Alizée', 'Onyx', 'Météore', 'Vermeil', 'Cobalt', 'Solstice', 'Nébuleuse', 'Émeraude', 'Orage', 'Mirage'];
const NAME_B = ['Dorée', 'Silencieuse', 'Boréale', 'Ultime', 'Discrète', 'Royale', 'Secrète', 'Nocturne', 'Rapide', 'Précise', 'Furtive', 'Éclatante'];
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

async function createItem({ source = 'custom', sourceKey = null, realName = '', details = '', example = '', rate = null } = {}) {
  const existingNames = shop.items.map((i) => i.aiName);
  const aiName = await generateAiName(existingNames);
  const item = {
    id: `shop_${shortId()}`,
    source, // 'strategy' | 'ia' | 'custom'
    sourceKey,
    realName: realName || sourceKey || '',
    aiName,
    details: String(details || ''),
    example: String(example || ''),
    rate: Number.isFinite(rate) ? rate : null,
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
  const allowed = ['details', 'example', 'rate', 'active', 'realName', 'aiName'];
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
function publishFromStrategy(key, { details = '', example = '' } = {}) {
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
  });
}

// Publication depuis une stratégie créée par l'IA (pattern-miner / ai-auto) :
// on COPIE le déclencheur/la cible/le taux au moment de la publication car
// ces stratégies expirent automatiquement au bout d'1h côté ai-auto.js.
function publishFromAiStrategy(aiItem, { details = '', example = '' } = {}) {
  if (!aiItem) return null;
  const auto = [
    aiItem.trigger ? `Déclencheur : ${aiItem.trigger}` : null,
    aiItem.target ? `Cible : ${aiItem.target}` : null,
  ].filter(Boolean).join('\n');
  return createItem({
    source: 'ia',
    sourceKey: aiItem.id || aiItem.key || null,
    realName: aiItem.name || '',
    details: details || auto || (aiItem.name || ''),
    example,
    rate: Number.isFinite(aiItem.rate) ? aiItem.rate : null,
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
// Achat / déblocage par code.
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
  if (!u.unlocked.includes(itemId)) u.unlocked.push(itemId);
  u.pendingCode = null;
  u.activeItem = itemId;
  persist();
  return { ok: true, item };
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
  t,
  loadFromDb,
  listAll, listActive, getItem,
  createItem, updateItem, deleteItem, regenerateCode, renameItem,
  publishFromStrategy, publishFromAiStrategy, refreshRateFromStrategy,
  getLang, setLang,
  setPendingCode, getPendingCode, clearPendingCode,
  setActiveItem, getActiveItem,
  redeem, hasUnlocked,
  explain, fullPresentation, translate,
  isUnderstoodMessage, closingMessage,
};
