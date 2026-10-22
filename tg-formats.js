// tg-formats.js — Formats de messages Telegram pour Baccarat Pro (N°1 à N°107)
// Fichier dédié aux formats de prédiction — aucun saut de numéro.
// Importer avec : const { buildTgMessage, buildPredictionMsg, buildResultMsg, ... } = require('./tg-formats');

'use strict';

const UNIQUE = require('./tg-formats-uniques');

const SUIT_EMOJI_MAP = { '♠': '♠️', '♥': '❤️', '♦': '♦️', '♣': '♣️', 'distrib': '🌀', 'deux': '2️⃣', 'trois': '3️⃣', 'WIN_B': '🏦', 'WIN_P': '👤', 'TIE': '🤝', 'TWO_THREE': '⚡', 'DEUX_TROIS': '2️⃣3️⃣', 'TROIS_DEUX': '3️⃣2️⃣', 'TROIS_TROIS': '3️⃣3️⃣', 'pair': '🟢', 'impair': '🔴' };
const SUIT_NAME_FR   = { '♠': 'Pique', '♥': 'Cœur', '♦': 'Carreau', '♣': 'Trèfle', 'distrib': 'Distribution', 'deux': '2 Cartes', 'trois': '3 Cartes', 'WIN_B': 'Victoire Banquier', 'WIN_P': 'Victoire Joueur', 'TIE': 'Match Nul', 'TWO_THREE': '2+3 Cartes', 'DEUX_TROIS': 'J:2 B:3', 'TROIS_DEUX': 'J:3 B:2', 'TROIS_TROIS': 'J:3 B:3', 'pair': 'Pair', 'impair': 'Impair' };
const SUPERSCRIPT    = ['⁰','¹','²','³','⁴','⁵','⁶','⁷','⁸','⁹','¹⁰','¹¹','¹²','¹³','¹⁴','¹⁵','¹⁶','¹⁷','¹⁸','¹⁹','²⁰'];
const RATR_EMOJI     = ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','10','11','12','13','14','15','16','17','18','19','20'];
const BOLD_DIGITS     = ['𝟎','𝟏','𝟐','𝟑','𝟒','𝟓','𝟔','𝟕','𝟖','𝟗'];
function boldNum(n) { return String(n).split('').map((c) => BOLD_DIGITS[c] ?? c).join(''); }

// Compat exports
const SUIT_EMOJI = SUIT_EMOJI_MAP;
const SUIT_NAME  = SUIT_NAME_FR;

function getSuitEmoji(suit) { return SUIT_EMOJI_MAP[suit] || suit; }
function getSuitName(suit)  { return SUIT_NAME_FR[suit]  || suit; }

/**
 * renderCustomTemplate — rend un template personnalisé défini dans le fichier de stratégie.
 * Variables disponibles : {game} {emoji} {suit} {status} {maxR} {hand} {rattrapage} {strategy}
 * Exemple de template : "🎯 #{game} | {emoji} {suit} | {status}"
 */
function renderCustomTemplate(template, { gameNumber, suit, hand, maxR, status, rattrapage, strategy }) {
  const emoji = getSuitEmoji(suit);
  const name  = getSuitName(suit);
  let statusStr;
  if (status === null)         statusStr = '⌛';
  else if (status === 'gagne') statusStr = `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
  else                         statusStr = '❌';
  return template
    .replace(/\{game\}/g,      String(gameNumber  ?? ''))
    .replace(/\{emoji\}/g,     emoji)
    .replace(/\{suit\}/g,      name)
    .replace(/\{status\}/g,    statusStr)
    .replace(/\{maxR\}/g,      String(maxR        ?? ''))
    .replace(/\{hand\}/g,      String(hand        ?? 'joueur'))
    .replace(/\{rattrapage\}/g,String(rattrapage  ?? 0))
    .replace(/\{strategy\}/g,  String(strategy    ?? ''));
}

/**
 * buildTgMessage — message unifié pour prédiction ET résultat.
 * status = null  → en cours (⌛)
 * status = 'gagne'  → gagné (✅ + emoji rattrapage)
 * status = 'perdu'  → perdu (❌)
 */
function formatCardsToEmojis(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return '—';
  return cards.map(c => {
    const raw = (c && c.S) ? String(c.S).replace(/\uFE0F/g, '').trim() : '';
    return SUIT_EMOJI_MAP[raw] || raw || '?';
  }).join(' ');
}

function buildTgMessage(formatId, {
  gameNumber, suit, strategy,
  maxR = 2,
  status = null,
  rattrapage = 0,
  hand = null,
  playerCards = null,
  bankerCards = null,
  cardsLabel = null,   // ex: '3/3' ou '2/2' (stratégies cartes/distribution)
}, tg_template = null) {
  // ── Template personnalisé (défini dans le fichier de stratégie ou la DB) ──
  if (tg_template) {
    return {
      text: renderCustomTemplate(tg_template, { gameNumber, suit, hand, maxR, status, rattrapage, strategy }),
      parse_mode: null,
    };
  }

  // La stratégie Distribution utilise toujours le format 11 (conçu pour elle)
  if (suit === 'distrib') formatId = 11;
  // deux/trois → format 76 par défaut | pair/impair → format 12 par défaut
  if ((suit === 'deux' || suit === 'trois') && (!formatId || parseInt(formatId) < 12)) formatId = 76;
  if ((suit === 'pair' || suit === 'impair') && (!formatId || parseInt(formatId) < 12)) formatId = 12;

  const emoji   = getSuitEmoji(suit);
  const name    = getSuitName(suit);
  const sup     = SUPERSCRIPT[maxR] ?? String(maxR);

  let statusLine;
  if (status === null)         statusLine = '⌛';
  else if (status === 'gagne') statusLine = `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
  else                         statusLine = '❌';

  // ── Formats 8 à 86 : 79 mises en page toutes différentes (tg-formats-uniques.js) ──
  {
    const fid = parseInt(formatId);
    if (fid >= UNIQUE.FIRST_ID && fid <= UNIQUE.LAST_ID) {
      const isParity = suit === 'pair' || suit === 'impair';
      const isCards  = suit === 'deux' || suit === 'trois' || !!cardsLabel;
      const rn = RATR_EMOJI[rattrapage] ?? rattrapage;
      const t  = cardsLabel || name;
      const out = UNIQUE.buildUnique(fid, {
        g: gameNumber, e: emoji, n: name, t, T: String(t).toUpperCase(),
        R: maxR, r: rattrapage, rn, sup,
        p: status === null, w: status === 'gagne', l: status !== null && status !== 'gagne',
        h: hand === 'banquier' ? 'Banquier' : 'Joueur',
        mode: isParity ? 'parite' : isCards ? 'cartes' : 'costume',
        found: gameNumber + rattrapage,
        cardsP: formatCardsToEmojis(playerCards),
        cardsB: formatCardsToEmojis(bankerCards),
        v1v2: suit === 'WIN_P' ? 'V1' : suit === 'WIN_B' ? 'V2' : suit === 'TIE' ? 'Ég.' : name,
      });
      if (out) return out;
    }
  }

  switch (parseInt(formatId)) {
    case 1:
      return {
        text: `⚜ #N${gameNumber} Игрок    +${sup} ⚜\n◽Масть ${emoji}\n◼️ Результат ${statusLine}`,
        parse_mode: null,
      };

    case 2:
      return {
        text:
          `🎲𝐁𝐀𝐂𝐂𝐀𝐑𝐀 𝐏𝐑𝐄𝐌𝐈𝐔𝐌+${maxR} ✨🎲\n` +
          `#N${gameNumber} :${emoji}\n` +
          `${status === null ? 'En cours' : 'Statut'} :${statusLine}`,
        parse_mode: null,
      };

    case 3:
      return {
        text:
          `𝐁𝐀𝐂𝐂𝐀𝐑𝐀 𝐏𝐑𝐎 ✨\n` +
          `🎮GAME: #N${gameNumber}\n` +
          `🃏Carte ${emoji}:${status === null ? '⌛' : statusLine}\n` +
          `Mode: Dogon ${maxR}`,
        parse_mode: null,
      };

    case 4:
      return {
        text:
          `🎰 PRÉDICTION #N${gameNumber}\n` +
          `🎯 Couleur: ${emoji} ${name}\n` +
          `📊 Statut: ${status === null ? 'En cours ⏳' : statusLine}\n` +
          `🔍 ${status === null ? 'Vérification en cours' : (status === 'gagne' ? 'Vérifié ✓' : 'Résultat final')}`,
        parse_mode: null,
      };

    case 5: {
      let bar;
      if (status === null)         bar = '🟦' + '⬜'.repeat(maxR);
      else if (status === 'gagne') bar = '🟩'.repeat(rattrapage + 1) + '⬜'.repeat(Math.max(0, maxR - rattrapage));
      else                         bar = '🟥'.repeat(maxR + 1);
      return {
        text:
          `🎰 PRÉDICTION #N${gameNumber}\n` +
          `🎯 Couleur: ${emoji} ${name}\n\n` +
          `🔍 Vérification jeu #N${gameNumber}\n` +
          `${bar}\n` +
          `${status === null ? '⏳ Analyse...' : (status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌')}`,
        parse_mode: null,
      };
    }

    case 6:
      return {
        text:
          `🏆 *PRÉDICTION #N${gameNumber}*\n\n` +
          `🎯 Couleur: ${emoji} ${name}\n` +
          (status === null
            ? `⏳ Statut: En cours`
            : status === 'gagne'
              ? `✅ Statut: ${statusLine}`
              : `Statut: ❌`),
        parse_mode: 'Markdown',
      };

    case 7:
      return {
        text:
          `<b>#N${gameNumber}</b> — <b>Le</b> <b><i>joueur</i></b> <b><u>recevra</u></b> <b>une</b> <b><i>carte</i></b> ${emoji} <b>${name}</b>\n\n` +
          (status === null
            ? `⏳ <i>En attente du résultat...</i>`
            : status === 'gagne'
              ? `✅ <b>GAGNÉ</b> ${RATR_EMOJI[rattrapage] ?? rattrapage}`
              : `❌`),
        parse_mode: 'HTML',
      };

    // ── Formats 8 à 86 : gérés plus haut par tg-formats-uniques.js (79 mises en page toutes différentes) ──

    // ── Format 87 : NOUVEAU FORMAT de prédiction (format officiel) ─────────
    case 87: {
      let sl87;
      if (status === null)         sl87 = '⏳ En attente';
      else if (status === 'gagne') sl87 = `✅ GAGNÉ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else                         sl87 = '❌ PERDU';
      const cible87 = suit === 'pair' || suit === 'impair'
        ? `${suit === 'pair' ? 'PAIR' : 'IMPAIR'}`
        : cardsLabel
          ? `${cardsLabel} carte(s)`
          : `${emoji} ${name}`;
      return {
        text:
          `🎴 𝗣𝗥𝗘́𝗗𝗜𝗖𝗧𝗜𝗢𝗡 𝗕𝗔𝗖𝗖𝗔𝗥𝗔 🎴\n` +
          `━━━━━━━━━━━━━━━\n` +
          `🔢 Jeu : #N${gameNumber}\n` +
          `🎯 Cible : ${cible87}\n` +
          `✋ Main : Joueur\n` +
          `🔁 Rattrapage : +${maxR}\n` +
          `━━━━━━━━━━━━━━━\n` +
          `📊 Statut : ${sl87}`,
        parse_mode: null,
      };
    }

    // ── Format 88 : LUXE BACCARA (format compact demandé) ─────────────────
    case 88: {
      const cible88 = suit === 'pair' || suit === 'impair'
        ? (suit === 'pair' ? 'PAIR' : 'IMPAIR')
        : cardsLabel ? cardsLabel : emoji;
      let sl88 = '';
      if (status === 'gagne')      sl88 = `  ·  ✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else if (status === 'perdu') sl88 = '  ·  ❌';
      return {
        text:
          `🌹 𝐋𝐔𝐗𝐄 𝐁𝐀𝐂𝐂𝐀𝐑𝐀 🌹\n` +
          `🎱 Jeu #N${gameNumber}  ·  ${cible88}  ·  Dogon +${maxR}${sl88}`,
        parse_mode: null,
      };
    }

    // ── Format 89 : ROYAL CLUB (format demandé) ─────────────────────────────
    case 89: {
      const cible89 = suit === 'pair' || suit === 'impair'
        ? (suit === 'pair' ? 'PAIR' : 'IMPAIR')
        : cardsLabel ? cardsLabel : emoji;
      let sl89;
      if (status === null)         sl89 = '⏳ 𝐄𝐍 𝐂𝐎𝐔𝐑𝐒';
      else if (status === 'gagne') sl89 = `✅ 𝐆𝐀𝐆𝐍É ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else                         sl89 = '❌ 𝐏𝐄𝐑𝐃𝐔';
      return {
        text:
          `⭐️ 𝐑𝐎𝐘𝐀𝐋 𝐂𝐋𝐔𝐁 💎\\n` +
          `🎱 𝐉𝐄𝐔 #𝐍${gameNumber} · ${cible89} · 𝐃𝐎𝐆𝐎𝐍 +${boldNum(maxR)}\\n` +
          `💠 𝐑𝐄𝐒𝐔𝐋𝐓𝐀𝐓 ➜ ${sl89}`,
        parse_mode: null,
      };
    }

    // ── Format 90 : ÉTOILE BACCARA (format demandé, variante de 88) ────────
    case 90: {
      const cible90 = suit === 'pair' || suit === 'impair'
        ? (suit === 'pair' ? 'PAIR' : 'IMPAIR')
        : cardsLabel ? cardsLabel : emoji;
      let sl90 = '';
      if (status === 'gagne')      sl90 = `  ·  ✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else if (status === 'perdu') sl90 = '  ·  ❌';
      return {
        text:
          `🌟ÉTOILE 🌟𝐁𝐀𝐂𝐂𝐀𝐑𝐀 🌟\n` +
          `🎱 Jeu #N${gameNumber}  ·  ${cible90}  ·  Dogon +${maxR}${sl90}`,
        parse_mode: null,
      };
    }

    // ── Format 91 : ÉCLAIR BACCARA (format demandé, variante de 88) ────────
    case 91: {
      const cible91 = suit === 'pair' || suit === 'impair'
        ? (suit === 'pair' ? 'PAIR' : 'IMPAIR')
        : cardsLabel ? cardsLabel : emoji;
      let sl91 = '';
      if (status === 'gagne')      sl91 = `  ·  ✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else if (status === 'perdu') sl91 = '  ·  ❌';
      return {
        text:
          `🥇ÉCLAIR  🌟𝐁𝐀𝐂𝐂𝐀𝐑𝐀 🥇\n` +
          `🎱 Jeu #N${gameNumber}  ·  ${cible91}  ·  Dogon +${maxR}${sl91}`,
        parse_mode: null,
      };
    }

    // ── Format 92 : Minimal (proposé par ChatGPT) ───────────────────────────
    case 92: {
      let sl92 = '';
      if (status === 'gagne')      sl92 = `\n✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else if (status === 'perdu') sl92 = '\n❌';
      return {
        text: `🎯 #${gameNumber}\n🔮 Prédiction : ${emoji}${sl92}`,
        parse_mode: null,
      };
    }

    // ── Format 93 : Avec statut (proposé par ChatGPT) ───────────────────────
    case 93: {
      const sl93 = status === null ? '⏳' : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return {
        text: `🌈 Jeu #${gameNumber}\n🔹 Prédiction : ${emoji}\n🌹 Statut : ${sl93}`,
        parse_mode: null,
      };
    }

    // ── Format 94 : Très court (proposé par ChatGPT) ────────────────────────
    case 94: {
      const sl94 = status === null ? '⏳' : status === 'gagne' ? `✅ Gagné ${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌ Perdu';
      return {
        text: `#${gameNumber} → ${emoji}\n${sl94}`,
        parse_mode: null,
      };
    }

    // ── Format 95 : Style premium (proposé par ChatGPT) ─────────────────────
    case 95: {
      const sl95 = status === null ? '⏳' : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return {
        text: `⚜️ JEU #${gameNumber}\n🎯 PRÉDICTION : ${emoji}\n🔰 STATUT : ${sl95}`,
        parse_mode: null,
      };
    }

    // ── Format 96 : Avec niveau (proposé par ChatGPT) ───────────────────────
    case 96: {
      let sl96 = '';
      if (status === 'gagne')      sl96 = `\n📊 Statut : ✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else if (status === 'perdu') sl96 = '\n📊 Statut : ❌';
      return {
        text: `🎯 #${gameNumber}\n${emoji} Costume prédit\n🔥 Risque : ${maxR}${sl96}`,
        parse_mode: null,
      };
    }

    // ── Format 97 : Deux choix (proposé par ChatGPT — le moteur ne suit
    // qu'un seul costume ; le second est affiché comme repère indicatif) ────
    case 97: {
      let sl97 = '';
      if (status === 'gagne')      sl97 = `\n✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else if (status === 'perdu') sl97 = '\n❌';
      return {
        text: `🎯 #${gameNumber}\n🔮 ${emoji} / ❓\n📊 2 Possibilités${sl97}`,
        parse_mode: null,
      };
    }

    // ── Format 98 : Poursuite (proposé par ChatGPT) ─────────────────────────
    case 98: {
      let sl98 = '';
      if (status === 'gagne')      sl98 = `\n✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else if (status === 'perdu') sl98 = '\n❌';
      return {
        text: `🌈 #${gameNumber}\n🔹 Prédiction : ${emoji}\n💧 Poursuite : +${maxR}${sl98}`,
        parse_mode: null,
      };
    }

    // ── Format 99 : Très compact pour Telegram (proposé par ChatGPT) ───────
    case 99: {
      const sl99 = status === null ? '⏳' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return {
        text: `⚜️ #${gameNumber} | ${emoji} | ${sl99}`,
        parse_mode: null,
      };
    }

    // ── Format 100 : Avec résultat (proposé par ChatGPT) ────────────────────
    case 100: {
      const sl100 = status === null ? '⏳ En attente' : status === 'gagne' ? `✅ WIN ${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌ PERDU';
      return {
        text: `🎯 #${gameNumber}\n🔮 Prédit : ${emoji}\n🎲 Résultat : ${status === null ? '⏳' : emoji}\n${sl100}`,
        parse_mode: null,
      };
    }

    // ── Format 101 : Style bot (proposé par ChatGPT) ────────────────────────
    case 101: {
      const sl101 = status === null ? '⏳ En attente' : status === 'gagne' ? `✅ GAGNÉ ${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌ PERDU';
      return {
        text: `🤖 PREDICTION #${gameNumber}\n${emoji} Costume : ${emoji}\n🔰 Signal : ${maxR}\n${sl101}`,
        parse_mode: null,
      };
    }

    // ── Format 107 : TRADING FOR BACCARA (format demandé) ──────────────────
    //   📈𝐓𝐑𝐀𝐃𝐈𝐍𝐆 𝐅𝐎𝐑 𝐁𝐀𝐂𝐂𝐀𝐑𝐀📈
    //   🎱 Jeu #N511  ·  ♥️  ·  Dogon +2
    //   📊 Résultat → ⌛ / ✅ 1️⃣ / ❌
    case 107: {
      const cible107 = suit === 'pair' || suit === 'impair'
        ? (suit === 'pair' ? 'PAIR' : 'IMPAIR')
        : cardsLabel ? cardsLabel : emoji;
      return {
        text:
          `📈𝐓𝐑𝐀𝐃𝐈𝐍𝐆 𝐅𝐎𝐑 𝐁𝐀𝐂𝐂𝐀𝐑𝐀📈\n` +
          `🎱 Jeu #N${gameNumber}  ·  ${cible107}  ·  Dogon +${maxR}\n` +
          `📊 Résultat → ${statusLine}`,
        parse_mode: null,
      };
    }

    // ── Formats 102 à 106 : prédiction « 2/2 » — 5 mises en page SIMPLES au choix (sans « Joueur »), avec ou sans le mot « distribution » ───
    //   102 : 3 lignes, « Il y aura distribution 2/2 »     103 : 3 lignes, « Il y aura 2/2 » (sans le mot distribution)
    //   104 : une seule ligne « №… · 2/2 · résultat »      105 : 3 lignes, « 2/2 (+N) » avec le nombre de rattrapages
    //   106 : bandeau « ⚜️ Baccara ⚜️ » + « №… · distribution 2/2 »
    case 102: case 103: case 104: case 105: case 106: {
      const cl = cardsLabel || (suit === 'trois' ? '3/3' : '2/2');
      const sl = status === null ? '⌛' : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      const lines = {
        102: [`💠Jeux №${gameNumber}`, `🎯Il y aura distribution ${cl}`, `🗯️Résultats : ${sl}`],
        103: [`💠Jeux №${gameNumber}`, `🎯Il y aura ${cl}`, `🗯️Résultats : ${sl}`],
        104: [`🎯 №${gameNumber} · ${cl} · ${sl}`],
        105: [`📌 Jeu №${gameNumber}`, `Il y aura ${cl} (+${maxR})`, `Résultat : ${sl}`],
        106: ['⚜️ Baccara ⚜️', `№${gameNumber} · distribution ${cl}`, sl],
      }[formatId];
      return { text: lines.join('\n'), parse_mode: null };
    }

    // ── Default : texte générique sans HTML ───────────────────────────────
    default:
      return {
        text:
          `🎯 PRÉDICTION #N${gameNumber}\n` +
          `${emoji} ${name}\n` +
          `🔰 +${maxR}\n` +
          `${statusLine}`,
        parse_mode: null,
      };
  }
}

// Compat shims for existing callers
function buildPredictionMsg(formatId, data) {
  return buildTgMessage(formatId, { ...data, maxR: data.maxRattrapage ?? data.maxR ?? 2, status: null });
}
function buildResultMsg(formatId, data) {
  return buildTgMessage(formatId, { ...data, maxR: data.maxRattrapage ?? data.maxR ?? 2 });
}

module.exports = {
  SUIT_EMOJI_MAP, SUIT_NAME_FR, SUPERSCRIPT, RATR_EMOJI,
  SUIT_EMOJI, SUIT_NAME,
  getSuitEmoji, getSuitName,
  renderCustomTemplate, formatCardsToEmojis,
  buildTgMessage, buildPredictionMsg, buildResultMsg,
};
