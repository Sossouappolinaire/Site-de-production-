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
};

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
  if (item.codeUsedBy && String(item.codeUsedBy) !== String(userId)) return { ok: false, reason: 'used' };
  const submitted = String(code || '').trim().toUpperCase();
  if (submitted !== String(item.code || '').toUpperCase()) return { ok: false, reason: 'wrong' };
  if (!item.codeUsedBy) {
    item.codeUsedBy = String(userId);
    item.codeUsedAt = new Date().toISOString();
    // Code à usage unique : dès que la saisie réussit la PREMIÈRE fois, il
    // expire immédiatement et un NOUVEAU code est généré automatiquement
    // pour cette stratégie (sur le site comme côté bot) — sans action de
    // l'administrateur. L'ancien code ne peut plus jamais être réutilisé.
    item.code = genCode();
    item.updatedAt = new Date().toISOString();
  }
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
    `Tu es l'assistant qui présente et explique EXCLUSIVEMENT la stratégie nommée "${item.aiName}" à un client qui vient de l'acheter.`,
    "Base-toi UNIQUEMENT sur les informations fournies ci-dessous (détails + exemple). N'invente et ne révèle RIEN d'autre : ni les autres stratégies de la boutique, ni le fonctionnement interne du bot, ni du code, ni des données techniques.",
    "Si la question sort du cadre de cette stratégie précise, réponds poliment que tu ne peux répondre qu'aux questions concernant cette stratégie.",
    `Réponds en ${LANG_NAMES[lang] || 'français'}, texte brut, en phrases claires et naturelles, sans markdown, sans astérisques, sans puces.`,
  ].join(' ');
  try {
    const raw = await ai.chat({
      system,
      user: { question, details, example: item.example },
      temperature: 0.3,
      timeoutMs: 20000,
    });
    return cleanText(raw) || null;
  } catch (_) { return null; }
}

async function fullPresentation(item, lang) {
  const question = "Présente cette stratégie de façon claire et structurée, en intégrant l'exemple fourni pour bien montrer comment l'utiliser.";
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
};
