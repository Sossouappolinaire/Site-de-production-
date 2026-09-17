// config.js — réglages généraux du service.
//
// AUCUNE clé privée n'est écrite ici : tout se règle par variables
// d'environnement sur Render (ou depuis le tableau de bord pour les clés IA,
// les canaux Telegram et les clés de paiement, stockées en base).
'use strict';

const { databaseUrl } = require('./database-url');

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};

module.exports = {
  // ---- serveur ----------------------------------------------------------
  PORT: num(process.env.PORT, 3000),
  PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  // ---- base de données --------------------------------------------------
  // Base « kile » par défaut (voir database-url.js) ; DATABASE_URL reste
  // prioritaire pour changer de base sans modifier le code.
  DATABASE_URL: databaseUrl(),

  // ---- Telegram ---------------------------------------------------------
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  SHOP_BOT_TOKEN: process.env.SHOP_BOT_TOKEN || '',
  ADMIN_ID: process.env.ADMIN_ID || '',
  // CORRECTIF « le site doit marcher même sans base de données » (demande
  // admin) : le token et l'admin survivent déjà à un redémarrage via ces
  // variables d'environnement Render (persistantes, contrairement au disque
  // local data.json ET à la base Postgres gratuite qui expire). Il manquait
  // l'équivalent pour les CANAUX ACTIFS (là où les stratégies de base
  // publient par défaut, voir strategyChannels() dans predictor.js) : sans
  // eux, même avec un token valide, il n'y a nulle part où envoyer. Réglage
  // facultatif : ACTIVE_CHANNELS=-1001234567890,-1009876543210 sur Render —
  // sert de solution de secours SEULEMENT si aucun canal n'est déjà connu
  // localement/en base (voir bot.js, juste après le chargement de `saved`).
  ACTIVE_CHANNELS: String(process.env.ACTIVE_CHANNELS || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^-?\d+$/.test(s) ? Number(s) : s)),

  // ---- flux des jeux 1xbet Baccara --------------------------------------
  // 1xBet a changé de domaine et l'ancien championnat 2196545 ne renvoie
  // plus de jeux. 2050671 est le championnat « Baccara » actuellement
  // publié par LiveFeed/GetChampsZip sur 1xbet.cd (septembre 2026).
  // La découverte automatique dans api.js reste active si l'identifiant
  // change à nouveau.
  CHAMP_ID: process.env.CHAMP_ID || '2050671',
  API_HOSTS: (process.env.API_HOSTS || [
    'https://1xbet.cd/service-api',
    'https://1xbet.com/service-api/LiveFeed',
    'https://ind.1xbet.com/service-api/LiveFeed',
  ].join(','))
    .split(',')
    .map((h) => h.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    // les modules ajoutent eux-mêmes "/LiveFeed/..." : on retire un éventuel
    // suffixe /LiveFeed en trop pour rester compatible avec les deux formes.
    .map((h) => h.replace(/\/LiveFeed$/, '')),
  // proxys publics de secours si tous les miroirs directs refusent
  PROXIES: [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
  ],
  POLL_INTERVAL_MS: num(process.env.POLL_INTERVAL_MS, 5000),
  // un sabot va du jeu 1 au jeu 1440 avant de revenir à 1
  MAX_GAME_NUMBER: num(process.env.MAX_GAME_NUMBER, 1440),

  // ---- réglages de prédiction par défaut --------------------------------
  // costume imposé par le dernier chiffre du numéro : 2→♦️, 5→❤️, 6→♣️, 9→♠️
  SUIT_BY_LAST_DIGIT: [null, null, '♦️', null, null, '❤️', '♣️', null, null, '♠️'],
  LEAD: num(process.env.LEAD, 2), // prédiction 2 jeux à l'avance
  DEFAULT_B: num(process.env.DEFAULT_B, 3),
  DEFAULT_MAX_R: num(process.env.DEFAULT_MAX_R, 4),
  DEFAULT_FORMAT: num(process.env.DEFAULT_FORMAT, 1),
  BILAN_MIN_GAMES: num(process.env.BILAN_MIN_GAMES, 10),

  // ---- analyseur IA -----------------------------------------------------
  AI_AUTO_ENABLED: String(process.env.AI_AUTO_ENABLED || '') === '1',
  AI_LOCAL_INTERVAL_MS: num(process.env.AI_LOCAL_INTERVAL_MS, 5 * 60 * 1000),
  AI_REMOTE_INTERVAL_MS: num(process.env.AI_REMOTE_INTERVAL_MS, 30 * 60 * 1000),
  POLLINATIONS: {
    API_KEY: process.env.POLLINATIONS_API_KEY || '',
    MODEL: process.env.POLLINATIONS_MODEL || 'openai',
    BASE_URL: 'https://text.pollinations.ai',
    CHAT_URL: 'https://text.pollinations.ai/openai',
    MODELS_URL: 'https://text.pollinations.ai/models',
  },
  GEMINI: {
    API_KEY: process.env.GEMINI_API_KEY || '',
    MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    CHAT_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  },
  GROQ: {
    API_KEY: process.env.GROQ_API_KEY || '',
    MODEL: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    CHAT_URL: 'https://api.groq.com/openai/v1/chat/completions',
  },
  OPENROUTER: {
    API_KEY: process.env.OPENROUTER_API_KEY || '',
    MODEL: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
    CHAT_URL: 'https://openrouter.ai/api/v1/chat/completions',
  },

  // ---- emails (confirmations, notifications) ----------------------------
  BREVO_API_KEY: process.env.BREVO_API_KEY || '',
  BREVO_FROM: process.env.BREVO_FROM || '',

  // ---- paiements --------------------------------------------------------
  SEBPAY_API_URL: (process.env.SEBPAY_API_URL || 'https://new.sebpay.bj/api/v1').replace(/\/+$/, ''),
};
