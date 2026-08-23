// config.js — configuration du bot Baccara
'use strict';

// ---------------------------------------------------------------------------
// API IA Pollinations — clé en dur dans le code (aucune variable Render requise).
// ---------------------------------------------------------------------------
const POLLINATIONS = {
  BASE_URL: 'https://gen.pollinations.ai',
  CHAT_URL: 'https://gen.pollinations.ai/v1/chat/completions',
  MODELS_URL: 'https://gen.pollinations.ai/v1/models',
  IMAGE_URL: (prompt, model = 'flux') =>
    `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${model}`,
  VIDEO_URL: (prompt, model = 'veo', duration = 4) =>
    `https://gen.pollinations.ai/video/${encodeURIComponent(prompt)}?model=${model}&duration=${duration}`,
  AUDIO_URL: (text, voice = 'nova') =>
    `https://gen.pollinations.ai/audio/${encodeURIComponent(text)}?voice=${voice}`,
  API_KEY: process.env.POLLINATIONS_API_KEY || 'POLLINATIONS_KEY_A_REMPLACER',
  MODEL: process.env.POLLINATIONS_MODEL || 'openai',
};

// ---------------------------------------------------------------------------
// Google Gemini (point d'accès compatible OpenAI) et Groq — utilisés en
// PRIORITÉ par ai-analyzer.js/chat() avant le repli Pollinations : deux
// services avec clé, nettement plus fiables/rapides que le repli gratuit sans
// clé. Si l'un échoue ou expire, l'appel suivant prend automatiquement le
// relais (voir chatAttempts()/chat() dans ai-analyzer.js).
// Laisser la clé vide désactive simplement ce fournisseur (aucune erreur).
// ---------------------------------------------------------------------------
const GEMINI = {
  // point d'accès officiel « compatibilité OpenAI » de l'API Gemini
  CHAT_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  API_KEY: process.env.GEMINI_API_KEY || '',
  MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
};

const GROQ = {
  CHAT_URL: 'https://api.groq.com/openai/v1/chat/completions',
  API_KEY: process.env.GROQ_API_KEY || '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',
  // llama-3.3-70b-versatile est en cours de retrait chez Groq (courant 2026) :
  // openai/gpt-oss-120b est le modèle de migration recommandé. Réglable via
  // GROQ_MODEL sans toucher au code si Groq change encore ses modèles.
  MODEL: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
};

// ---------------------------------------------------------------------------
// OpenRouter — fournisseur PAR DÉFAUT, essayé en tout premier par
// ai-analyzer.js/chatAttempts() avant Gemini/Groq/Pollinations. Clé en dur
// (aucune variable Render requise) comme les autres services ci-dessus.
// ---------------------------------------------------------------------------
const OPENROUTER = {
  CHAT_URL: 'https://openrouter.ai/api/v1/chat/completions',
  API_KEY: process.env.OPENROUTER_API_KEY
    || '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',
  // Modèle GRATUIT par défaut (suffixe :free) — n'utilise aucun crédit
  // payant. Limites du compte gratuit OpenRouter : 20 req/min et 50 req/jour
  // (1000/jour après un achat unique de 10$ de crédits, non requis ici).
  // CORRECTIF : un modèle « raisonneur » (ex. deepseek/deepseek-r1:free)
  // renvoie souvent un champ content VIDE (tout le budget de tokens consommé
  // par son raisonnement interne avant la réponse) → échec systématique de ce
  // fournisseur, invisible car chat() bascule alors sur Gemini/Groq/
  // Pollinations. On utilise donc un modèle d'INSTRUCTION classique (pas de
  // raisonnement caché), qui répond directement — plus fiable ici.
  // ⚠️ Le catalogue gratuit d'OpenRouter change fréquemment (modèles retirés
  // sans préavis) : si ce modèle disparaît, remplacez-le (liste à jour sur
  // https://openrouter.ai/models?fmt=free) via OPENROUTER_MODEL, sans toucher
  // au code.
  MODEL: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
};

// ---------------------------------------------------------------------------
// Compte Brevo expéditeur (codes de confirmation) — clé API en dur.
// Créer un compte gratuit sur https://app.brevo.com (300 emails/jour gratuits)
// puis générer une clé API dans Settings > SMTP & API > API Keys.
// Contrairement à Resend, Brevo ne demande PAS de vérifier un domaine : il
// suffit de vérifier l'adresse expéditrice elle-même (« Single Sender »,
// Settings > Senders) — un simple compte Gmail existant convient. Une fois
// cette adresse vérifiée sur Brevo, elle peut envoyer vers N'IMPORTE QUELLE
// adresse Gmail destinataire, sans restriction de type sandbox.
// L'adresse expéditrice doit être au format « Nom <email@exemple.com> ».
// ---------------------------------------------------------------------------
const BREVO_API_KEY = process.env.BREVO_API_KEY || 'BREVO_API_KEY_A_REMPLACER';
const BREVO_FROM = process.env.BREVO_FROM || 'Baccara Bot <BREVO_FROM_A_REMPLACER@gmail.com>';
const ADMIN_EMAIL = 'sossoukouam@gmail.com';

// ---------------------------------------------------------------------------
// Base PostgreSQL Render — ÉCRITE EN DUR (aucune variable Render nécessaire).
// URL interne : utilisable uniquement depuis Render (plus rapide, sans SSL).
// URL externe : utilisable depuis n'importe où (SSL obligatoire).
// ---------------------------------------------------------------------------
const DB_INTERNAL =
  'postgresql://base_de_donnees_hgxo_user:Y121g3HpUQE9YpORWPeudA1MrHPLjeXO@dpg-d9qtu967bikc73ejg52g-a/base_de_donnees_hgxo';
const DB_EXTERNAL =
  'postgresql://base_de_donnees_hgxo_user:Y121g3HpUQE9YpORWPeudA1MrHPLjeXO@dpg-d9qtu967bikc73ejg52g-a.oregon-postgres.render.com/base_de_donnees_hgxo';

// Sur Render on prend l'URL interne, ailleurs (PC local) l'URL externe.
const ON_RENDER = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
const DB_URL = process.env.DATABASE_URL || (ON_RENDER ? DB_INTERNAL : DB_EXTERNAL);

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  SHOP_BOT_TOKEN: process.env.SHOP_BOT_TOKEN || '',
  ADMIN_ID: Number(process.env.ADMIN_ID || 0),
  PORT: Number(process.env.PORT || 10000),

  // URL publique du site déployé (utilisée pour construire le lien vers
  // succes.html envoyé au client dans le bot boutique dès qu'il clique
  // « Payer »). Render fournit RENDER_EXTERNAL_URL automatiquement ; sinon
  // définir PUBLIC_URL à la main (ex. en local). Sans l'une des deux, le
  // bouton « Voir mon code » n'est simplement pas envoyé.
  PUBLIC_URL: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),

  // Base PostgreSQL Render (en dur — se connecte sans variable Render).
  DATABASE_URL: DB_URL,
  DB_INTERNAL,
  DB_EXTERNAL,

  // Compte Brevo expéditeur (en dur — plus besoin de le configurer dans
  // les réglages de sécurité, voir auth.js).
  BREVO_API_KEY,
  BREVO_FROM,
  ADMIN_EMAIL,

  // Analyseur IA Pollinations.ai (en dur).
  POLLINATIONS,
  POLLINATIONS_API_KEY: POLLINATIONS.API_KEY,
  POLLINATIONS_BASE_URL: `${POLLINATIONS.BASE_URL}/v1`,
  POLLINATIONS_MODEL: POLLINATIONS.MODEL,

  // Fournisseurs IA prioritaires (avec clé), utilisés avant Pollinations.
  // OPENROUTER est le service PAR DÉFAUT (essayé en premier).
  OPENROUTER,
  GEMINI,
  GROQ,

  // Analyse automatique en temps réel.
  AI_AUTO_ENABLED: true,
  AI_LOCAL_INTERVAL_MS: 15000,   // analyse locale (moteur interne)
  AI_REMOTE_INTERVAL_MS: 180000, // enrichissement Pollinations.ai

  // API 1xbet Baccara (LiveFeed/GetChampZip).
  CHAMP_ID: 2050671,
  API_HOSTS: [
    'https://1xbet.cd/service-api',
    'https://1xbet.com/service-api',
    'https://1xbet-africa.com/service-api',
    'https://1xbet.ng/service-api',
  ],
  PROXIES: [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ],
  POLL_INTERVAL_MS: 1500,

  // Règles de prédiction.
  SUIT_BY_LAST_DIGIT: { 2: '♦️', 5: '❤️', 6: '♣️', 9: '♠️' },
  LEAD: 2,
  // Un sabot/journée va du jeu n°1 au jeu n°1440 : au-delà, le numéro
  // n'existera jamais avant le retour à 1 (nouveau sabot). Toute cible de
  // prédiction calculée au-delà doit être ignorée plutôt que publiée pour
  // un jeu qui ne se produira pas — voir nextTarget() dans predictor.js.
  MAX_GAME_NUMBER: 1440,
  DEFAULT_HAND: 'joueur',
  DEFAULT_B: Number(process.env.B || 3),
  DEFAULT_MAX_R: Number(process.env.MAX_R || 2),
  DEFAULT_FORMAT: Number(process.env.TG_FORMAT || 1),

  // Bilan quotidien : envoyé UNE SEULE FOIS quand les numéros de jeu
  // REPARTENT À 1 (fin de sabot), mais seulement si le sabot qui vient de
  // se terminer a atteint AU MOINS ce nombre de jeux — c'est-à-dire qu'il
  // est bien allé jusqu'au bout de la journée (jeu n°1440), et pas une
  // remise à zéro isolée/anormale en plein milieu de la journée (coupure
  // réseau, redémarrage du site source…). Une petite marge est laissée
  // sous 1440 (au lieu d'exiger 1440 pile) car le tout dernier tour peut
  // parfois manquer ou arriver incomplet dans le flux 1xbet juste avant le
  // rebouclage — voir isNewShoe()/registerGames() dans predictor.js.
  BILAN_MIN_GAMES: Number(process.env.BILAN_MIN_GAMES || 1430),
};
