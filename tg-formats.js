// tg-formats.js — Formats de messages Telegram pour Baccarat Pro (N°1 à N°88)
// Fichier dédié aux 77 formats de prédiction — aucun saut de numéro.
// Importer avec : const { buildTgMessage, buildPredictionMsg, buildResultMsg, ... } = require('./tg-formats');

'use strict';

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

    case 8: {
      const isBank      = hand === 'banquier';
      const statusLine8 = status === null    ? '⌛'
                        : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}GAGNÉ`
                        :                      '❌';
      if (isBank) {
        return {
          text:
            `🎮 banquier #N${gameNumber}\n` +
            `⚜️ Couleur de la carte:${emoji}\n` +
            `🎰 Poursuite  🔰+${maxR} jeux\n` +
            `🗯️ Résultats : ${statusLine8}`,
          parse_mode: null,
        };
      } else {
        return {
          text:
            `🤖 joueur #N${gameNumber}\n` +
            `🔰Couleur de la carte :${emoji}\n` +
            `🔰 Rattrapages : ${maxR}(🔰+${maxR})\n` +
            `🧨 Résultats : ${statusLine8}`,
          parse_mode: null,
        };
      }
    }

    case 9: {
      const sl9 = status === null    ? '⌛'
                : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}GAGNÉ`
                :                      '❌';
      return {
        text:
          `🤖 joueur #N${gameNumber}\n` +
          `🔰Couleur de la carte :${emoji}\n` +
          `🔰 Rattrapages : ${maxR}(🔰+${maxR})\n` +
          `🧨 Résultats : ${sl9}`,
        parse_mode: null,
      };
    }

    case 10: {
      const sl10 = status === null    ? '⌛'
                 : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}GAGNÉ`
                 :                      '❌';
      return {
        text:
          `🎮 banquier #N${gameNumber}\n` +
          `⚜️ Couleur de la carte:${emoji}\n` +
          `🎰 Poursuite  🔰+${maxR} jeux\n` +
          `🗯️ Résultats : ${sl10}`,
        parse_mode: null,
      };
    }

    case 11: {
      const foundGame = gameNumber + rattrapage;
      const pEmojis   = formatCardsToEmojis(playerCards);
      const bEmojis   = formatCardsToEmojis(bankerCards);
      if (status === null) {
        return {
          text:
            `🃏 LE JEU VA SE TERMINER SUR LA DISTRIBUTION\n` +
            `📌 Jeu #N${gameNumber}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `⌛ Vérification en cours...`,
          parse_mode: null,
        };
      } else if (status === 'gagne') {
        // Phase 1 : affiche le jeu trouvé + cartes (remplacé après 10s par buildDistribFinalMsg)
        return {
          text:
            `🃏 LE JEU VA SE TERMINER SUR LA DISTRIBUTION\n` +
            `📌 Jeu #N${gameNumber}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `✅ Jeu #N${foundGame} trouvé\n` +
            `🃏 Joueur  : ${pEmojis}\n` +
            `🎴 Banquier : ${bEmojis}`,
          parse_mode: null,
        };
      } else {
        return {
          text:
            `🃏 LE JEU VA SE TERMINER SUR LA DISTRIBUTION\n` +
            `📌 Jeu #N${gameNumber}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `✅ Distribution : OUI\n` +
            `❌ Non distribué`,
          parse_mode: null,
        };
      }
    }

    case 12: {
      const handLabel12 = hand === 'banquier' ? 'Banquier' : 'Joueur';
      // Mode Pair / Impair
      if (suit === 'pair' || suit === 'impair') {
        const parity      = suit === 'pair' ? 'PAIR' : 'IMPAIR';
        const parityEmoji = suit === 'pair' ? '🟢' : '🔴';
        const winMsgP  = `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage} ${parity} confirmé 🎯`;
        const lossMsgP = `❌ Pas de ${suit} sur ${maxR} jeux`;
        return {
          text:
            `${parityEmoji} PRÉDICTION — ${parity} ${handLabel12.toUpperCase()}\n` +
            `📌 Jeu #N${gameNumber}\n` +
            `━━━━━━━━━━━━━━━\n` +
            `🎯 Total ${handLabel12} : ${parity}\n` +
            (status === null
              ? `⌛ En cours de vérification...`
              : status === 'gagne' ? winMsgP : lossMsgP),
          parse_mode: null,
        };
      }
      // Mode 2 vs 3 cartes
      const targetCards = suit === 'deux' ? 2 : 3;
      const cardEmoji   = suit === 'deux' ? '2️⃣' : '3️⃣';
      const winMsg   = suit === 'deux'
        ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage} 2 cartes confirmées 🎯`
        : `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage} 3 cartes confirmées 🎯`;
      const lossMsg  = suit === 'deux'
        ? `❌ Pas de 2 cartes sur ${maxR} jeux`
        : `❌ Pas de 3 cartes sur ${maxR} jeux`;
      return {
        text:
          `${cardEmoji} PRÉDICTION — ${targetCards} CARTES ${handLabel12.toUpperCase()}\n` +
          `📌 Jeu #N${gameNumber}\n` +
          `━━━━━━━━━━━━━━━\n` +
          `🎯 ${handLabel12} aura ${targetCards} cartes\n` +
          (status === null
            ? `⌛ En cours de vérification...`
            : status === 'gagne' ? winMsg : lossMsg),
        parse_mode: null,
      };
    }

    // ── Format 13 : Victoire Pro (Banquier / Joueur) ─────────────────────
    case 13: {
      const sl13 = status === null    ? '⌛ En cours de vérification...'
                 : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage} GAGNÉ`
                 :                      `❌ Perdu après ${maxR} tentatives`;
      const winLabel13 = suit === 'WIN_B' ? '🏦 BANQUIER'
                       : suit === 'WIN_P' ? '👤 JOUEUR'
                       : `${emoji} ${name.toUpperCase()}`;
      return {
        text:
          `🏆 PRÉDICTION VICTOIRE\n` +
          `📌 Jeu #N${gameNumber}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🎯 ${winLabel13} va gagner\n` +
          `🔰 Rattrapage : +${maxR}\n` +
          `${sl13}`,
        parse_mode: null,
      };
    }

    // ── Format 14 : Victoire Compact ──────────────────────────────────────
    case 14: {
      const sl14 = status === null    ? '⌛'
                 : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`
                 :                      '❌';
      const winLabel14 = suit === 'WIN_B' ? '🏦 Banquier'
                       : suit === 'WIN_P' ? '👤 Joueur'
                       : `${emoji} ${name}`;
      return {
        text: `${winLabel14} gagne — Jeu #N${gameNumber}   +${maxR}\n${sl14}`,
        parse_mode: null,
      };
    }

    // ── Format 15 : Globe Pro (Égalité) ──────────────────────────────────────
    case 15: {
      const sl15 = status === null    ? '⌛ Analyse en cours...'
                 : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage} ÉGALITÉ CONFIRMÉE 🎗️`
                 :                      `❌ Pas d'égalité sur ${maxR} jeux`;
      const tieLabel15 = suit === 'TIE' ? '⚖️ Égalité — aucun gagnant' : `🎯 ${emoji} ${name}`;
      return {
        text:
          `🌐 GLOBE BACCARAT\n` +
          `✦✦✦✦✦✦✦✦✦✦✦✦\n` +
          `📌 Jeu #N${gameNumber}\n` +
          `${tieLabel15}\n` +
          `🔰 Rattrapage : ×${maxR}\n` +
          `✦✦✦✦✦✦✦✦✦✦✦✦\n` +
          `${sl15}`,
        parse_mode: null,
      };
    }

    // ── Format 16 : SMS Sharp (Égalité Compact) ───────────────────────────────
    case 16: {
      const sl16 = status === null    ? '⌛'
                 : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}`
                 :                      '❌';
      const tieLabel16 = suit === 'TIE' ? '⚖️ÉGA' : `${emoji}`;
      return {
        text: `🎗️ #N${gameNumber} ${tieLabel16} ×${maxR} → ${sl16}`,
        parse_mode: null,
      };
    }

    // ── Format 17 : Split Fire (2+3 Cartes) ──────────────────────────────────
    case 17: {
      const sl17 = status === null    ? '⌛ Vérification...'
                 : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage} SPLIT CONFIRMÉ 🔥`
                 :                      `❌ Pas de split sur ${maxR} jeux`;
      const mixLabel17 = suit === 'TWO_THREE'
        ? '🃏 2 cartes / 3 cartes — camp mixte'
        : `🎯 ${emoji} ${name}`;
      return {
        text:
          `⚡ SPLIT BACCARAT\n` +
          `🎮 JEU #N${gameNumber}\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `${mixLabel17}\n` +
          `🔰 Rattrapage : +${maxR}\n` +
          `${sl17}`,
        parse_mode: null,
      };
    }

    // ── Format 18 : Block Badge (2/3 Cartes B) ───────────────────────────────
    case 18: {
      const sl18 = status === null    ? '⌛ Attente...'
                 : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage} Validé`
                 :                      '❌ Raté';
      let cardLabel18;
      if (suit === 'deux')           cardLabel18 = '2️⃣ 2 CARTES';
      else if (suit === 'trois')     cardLabel18 = '3️⃣ 3 CARTES';
      else if (suit === 'TWO_THREE') cardLabel18 = '⚡ 2+3 MIXTE';
      else                           cardLabel18 = `${emoji} ${name.toUpperCase()}`;
      const handLabel18 = hand === 'banquier' ? '🏦 BANQUIER' : hand === 'joueur' ? '👤 JOUEUR' : '';
      return {
        text:
          `【 ${cardLabel18}${handLabel18 ? ` — ${handLabel18}` : ''} 】\n` +
          `【 JEU #N${gameNumber} · +${maxR} 】\n` +
          `${sl18}`,
        parse_mode: null,
      };
    }

    // ── Format 19 : Marble VIP ────────────────────────────────────────────────
    case 19:
      return {
        text:
          `🏛️ CASINO MARBLE VIP\n` +
          `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
          `🃏 JEU #N${gameNumber}\n` +
          `🎯 ${emoji} ${name.toUpperCase()}\n` +
          `💎 Dogon : +${maxR}\n` +
          `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
          `${statusLine}`,
        parse_mode: null,
      };

    // ── Format 20 : Thunder Strike ────────────────────────────────────────────
    case 20:
      return {
        text: `⚡⚡ #N${gameNumber} ${emoji} ×${maxR} ${statusLine}`,
        parse_mode: null,
      };

    // ── Format 21 : Black Prestige ────────────────────────────────────────────
    case 21:
      return {
        text:
          `🎩 BACCARAT PRESTIGE\n` +
          `🔹 JEU #N${gameNumber}\n` +
          `🎯 ${emoji} ${name} — Dogon +${maxR}\n` +
          `✦ ${statusLine}`,
        parse_mode: null,
      };

    // ── Format 22 : Live Broadcast (avec main) ────────────────────────────────
    case 22: {
      const handLabel22 = hand === 'banquier' ? 'BANQUIER' : 'JOUEUR';
      const handEmoji22 = hand === 'banquier' ? '🏦' : '👤';
      return {
        text:
          `📣 BACCARAT LIVE\n` +
          `${handEmoji22} Main : ${handLabel22}\n` +
          `🎯 ${emoji} ${name}\n` +
          `🎮 #N${gameNumber} · Dogon +${maxR}\n` +
          `➤ ${statusLine}`,
        parse_mode: null,
      };
    }

    // ── Format 23 : Red Siren ─────────────────────────────────────────────────
    case 23:
      return {
        text:
          `🚨🚨 SIGNAL BACCARAT 🚨🚨\n` +
          `🎮 JEU #N${gameNumber}\n` +
          `🎯 ${emoji} ${name.toUpperCase()}\n` +
          `🔄 MAX : +${maxR}\n` +
          `${statusLine}`,
        parse_mode: null,
      };

    // ── Format 24 : Midnight Sky ──────────────────────────────────────────────
    case 24:
      return {
        text:
          `🌙 ${emoji} ${name} · #N${gameNumber} · +${maxR}\n` +
          `${statusLine}`,
        parse_mode: null,
      };

    // ── Format 25 : Data Panel ────────────────────────────────────────────────
    case 25:
      return {
        text:
          `📊 BACCARAT DATA\n` +
          `┌──────────────────────┐\n` +
          `│ Jeu   : #N${gameNumber}\n` +
          `│ Signe : ${emoji} ${name}\n` +
          `│ Dogon : +${maxR}\n` +
          `└──────────────────────┘\n` +
          `${statusLine}`,
        parse_mode: null,
      };

    // ── Formats 26-35 : TROIS CARTES ─────────────────────────────────────────

    // ── Format 26 : Trio Champion ────────────────────────────────────────────
    case 26: {
      const h26 = hand === 'banquier' ? '🏦 BANQUIER' : '👤 JOUEUR';
      const ct26 = suit === 'trois' ? `3️⃣ 3 CARTES — ${h26}` : suit === 'deux' ? `2️⃣ 2 CARTES — ${h26}` : suit === 'WIN_B' ? '🏦 BANQUIER GAGNE' : suit === 'WIN_P' ? '👤 JOUEUR GAGNE' : `${emoji} ${name}`;
      const sl26 = status === null ? '⌛ Vérification...' : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage} CHAMPION 🏆` : `❌ Pas confirmé — ${maxR} essais`;
      return { text: `🏆 TRIO CHAMPION\n━━━━━━━━━━━━━━━━\n🎮 #N${gameNumber} — ${ct26}\n🔰 Dogon : +${maxR}\n━━━━━━━━━━━━━━━━\n${sl26}`, parse_mode: null };
    }

    // ── Format 27 : Trio Sniper ───────────────────────────────────────────────
    case 27: {
      const h27 = hand === 'banquier' ? '🏦' : '👤';
      const ct27 = suit === 'trois' ? '3️⃣' : suit === 'deux' ? '2️⃣' : suit === 'WIN_B' ? '🏦W' : suit === 'WIN_P' ? '👤W' : emoji;
      const sl27 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `🎯 SNIPER3 #N${gameNumber} ${h27}${ct27} ×${maxR} → ${sl27}`, parse_mode: null };
    }

    // ── Format 28 : Trio Diamant ──────────────────────────────────────────────
    case 28: {
      const h28 = hand === 'banquier' ? '🏦 BANQUIER' : '👤 JOUEUR';
      const ct28 = suit === 'trois' ? `3 CARTES ${h28}` : suit === 'deux' ? `2 CARTES ${h28}` : suit === 'WIN_B' ? 'BANQUIER GAGNE' : suit === 'WIN_P' ? 'JOUEUR GAGNE' : name.toUpperCase();
      const sl28 = status === null ? '⌛ En cours...' : status === 'gagne' ? `💎 CONFIRMÉ (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '❌ RATÉ';
      return { text: `💎 TRIO DIAMANT 💎\n◆ #N${gameNumber} · ${ct28}\n◆ MAX ×${maxR}\n${sl28}`, parse_mode: null };
    }

    // ── Format 29 : Trio Neon ─────────────────────────────────────────────────
    case 29: {
      const ct29 = suit === 'trois' ? '3️⃣' : suit === 'deux' ? '2️⃣' : suit === 'WIN_B' ? '🏦' : suit === 'WIN_P' ? '👤' : emoji;
      const sl29 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `〔🟣 TRIO NEON〕\n⟨ #N${gameNumber} · ${ct29} · ×${maxR} ⟩\n⟨ ${sl29} ⟩`, parse_mode: null };
    }

    // ── Format 30 : Trio Terminal ─────────────────────────────────────────────
    case 30: {
      const h30 = hand === 'banquier' ? 'BANK' : 'PLAY';
      const ct30 = suit === 'trois' ? '3C' : suit === 'deux' ? '2C' : suit === 'WIN_B' ? 'WIN_B' : suit === 'WIN_P' ? 'WIN_P' : name.toUpperCase().replace(/\s/g, '_');
      const sl30 = status === null ? 'PENDING' : status === 'gagne' ? `HIT_${RATR_EMOJI[rattrapage] ?? rattrapage}` : 'MISS';
      return { text: `> TRIO_ENGINE RUN\n> GAME=${gameNumber} TARGET=${ct30} SIDE=${h30}\n> RETRY=${maxR} STATUS=${sl30}`, parse_mode: null };
    }

    // ── Format 31 : Trio Prestige ─────────────────────────────────────────────
    case 31: {
      const h31 = hand === 'banquier' ? '🏦 Banquier' : '👤 Joueur';
      const ct31 = suit === 'trois' ? '3️⃣ Trois cartes' : suit === 'deux' ? '2️⃣ Deux cartes' : suit === 'WIN_B' ? '🏆 Banquier gagne' : suit === 'WIN_P' ? '🏆 Joueur gagne' : `${emoji} ${name}`;
      const sl31 = status === null ? '⌛ Analyse...' : status === 'gagne' ? `✅ Confirmé (${RATR_EMOJI[rattrapage] ?? rattrapage})` : `❌ Raté (${maxR} essais)`;
      return { text: `🏅 TRIO PRESTIGE\n┌─────────────────────┐\n│ 🎮 #N${gameNumber} · ${h31}\n│ ${ct31} · +${maxR}\n└─────────────────────┘\n${sl31}`, parse_mode: null };
    }

    // ── Format 32 : Trio SMS ──────────────────────────────────────────────────
    case 32: {
      const ct32 = suit === 'trois' ? '3🃏' : suit === 'deux' ? '2🃏' : suit === 'WIN_B' ? '🏦' : suit === 'WIN_P' ? '👤' : emoji;
      const sl32 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `${ct32} #N${gameNumber} ×${maxR} ${sl32}`, parse_mode: null };
    }

    // ── Format 33 : Trio Rocket ───────────────────────────────────────────────
    case 33: {
      const h33 = hand === 'banquier' ? 'BANQUIER' : 'JOUEUR';
      const ct33 = suit === 'trois' ? `3 CARTES ${h33}` : suit === 'deux' ? `2 CARTES ${h33}` : suit === 'WIN_B' ? 'BANQUIER GAGNE' : suit === 'WIN_P' ? 'JOUEUR GAGNE' : name.toUpperCase();
      const sl33 = status === null ? '🚀 LANCEMENT...' : status === 'gagne' ? `🟢 ATTERRI (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '💥 RATÉ';
      return { text: `🚀 TRIO ROCKET 🚀\n📍 JEU #N${gameNumber}\n⚠️ ${ct33}\n🔁 DOGON : +${maxR}\n${sl33}`, parse_mode: null };
    }

    // ── Format 34 : Trio Atom ─────────────────────────────────────────────────
    case 34: {
      const h34 = hand === 'banquier' ? '🏦 Banquier' : '👤 Joueur';
      const ct34 = suit === 'trois' ? '3️⃣ Trois cartes' : suit === 'deux' ? '2️⃣ Deux cartes' : suit === 'WIN_B' ? '🏆 Victoire Banquier' : suit === 'WIN_P' ? '🏆 Victoire Joueur' : `${emoji} ${name}`;
      const sl34 = status === null ? '⚛️ Calcul...' : status === 'gagne' ? `✅ Fission (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '💀 Explosion';
      return { text: `⚛️ TRIO ATOM\n≋≋≋≋≋≋≋≋≋≋≋≋≋\n🎮 #N${gameNumber} · ${h34}\n${ct34} · +${maxR}\n≋≋≋≋≋≋≋≋≋≋≋≋≋\n${sl34}`, parse_mode: null };
    }

    // ── Format 35 : Trio Gold Star ────────────────────────────────────────────
    case 35: {
      const ct35 = suit === 'trois' ? '3️⃣✨' : suit === 'deux' ? '2️⃣✨' : suit === 'WIN_B' ? '🏦✨' : suit === 'WIN_P' ? '👤✨' : `${emoji}✨`;
      const sl35 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `✨ TRIO GOLD STAR ✨\n${ct35} — #N${gameNumber} — +${maxR}\n${sl35}`, parse_mode: null };
    }

    // ── Formats 36-45 : DEUX CARTES ───────────────────────────────────────────

    // ── Format 36 : Duo Power ─────────────────────────────────────────────────
    case 36: {
      const h36 = hand === 'banquier' ? '🏦 BANQUIER' : '👤 JOUEUR';
      const ct36 = suit === 'deux' ? `2️⃣ 2 CARTES — ${h36}` : suit === 'trois' ? `3️⃣ 3 CARTES — ${h36}` : suit === 'WIN_B' ? '🏦 BANQUIER GAGNE' : suit === 'WIN_P' ? '👤 JOUEUR GAGNE' : `${emoji} ${name}`;
      const sl36 = status === null ? '⌛ Vérification...' : status === 'gagne' ? `💪 ${RATR_EMOJI[rattrapage] ?? rattrapage} POWER CONFIRMÉ 🎯` : `❌ Pas confirmé — ${maxR} essais`;
      return { text: `💪 DUO POWER\n━━━━━━━━━━━━━━━━\n🎮 #N${gameNumber} — ${ct36}\n🔰 Dogon : +${maxR}\n━━━━━━━━━━━━━━━━\n${sl36}`, parse_mode: null };
    }

    // ── Format 37 : Duo Oracle ────────────────────────────────────────────────
    case 37: {
      const h37 = hand === 'banquier' ? '🏦' : '👤';
      const ct37 = suit === 'deux' ? '2️⃣' : suit === 'trois' ? '3️⃣' : suit === 'WIN_B' ? '🏦' : suit === 'WIN_P' ? '👤' : emoji;
      const sl37 = status === null ? '🔮 Prédiction...' : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `╔══════════════════╗\n🔮 DUO ORACLE — #N${gameNumber}\n╚══════════════════╝\n${h37} ${ct37} · +${maxR}\n${sl37}`, parse_mode: null };
    }

    // ── Format 38 : Duo Magnet ────────────────────────────────────────────────
    case 38: {
      const h38 = hand === 'banquier' ? 'BANQUIER' : 'JOUEUR';
      const ct38 = suit === 'deux' ? `2 CARTES ${h38}` : suit === 'trois' ? `3 CARTES ${h38}` : suit === 'WIN_B' ? 'BANQUIER GAGNE' : suit === 'WIN_P' ? 'JOUEUR GAGNE' : name.toUpperCase();
      const sl38 = status === null ? '🧲 Attraction...' : status === 'gagne' ? `✅ AIMÉ (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '❌ REJETÉ';
      return { text: `🧲 DUO MAGNET\n🎮 #N${gameNumber} · ${ct38}\n🔰 MAX ×${maxR}\n${sl38}`, parse_mode: null };
    }

    // ── Format 39 : Duo Radar ─────────────────────────────────────────────────
    case 39: {
      const ct39 = suit === 'deux' ? '2️⃣' : suit === 'trois' ? '3️⃣' : suit === 'WIN_B' ? '🏦' : suit === 'WIN_P' ? '👤' : emoji;
      const sl39 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `📡 DUO RADAR #N${gameNumber}\n${ct39} ×${maxR} → ${sl39}`, parse_mode: null };
    }

    // ── Format 40 : Duo Wave ──────────────────────────────────────────────────
    case 40: {
      const h40 = hand === 'banquier' ? '🏦 BANK' : '👤 PLAY';
      const ct40 = suit === 'deux' ? '2️⃣ 2 CARTES' : suit === 'trois' ? '3️⃣ 3 CARTES' : suit === 'WIN_B' ? '🌊 BANK WIN' : suit === 'WIN_P' ? '🌊 PLAY WIN' : `${emoji} ${name.toUpperCase()}`;
      const sl40 = status === null ? '〰️ WAVE...' : status === 'gagne' ? `🌊 SURF (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '💨 MISSED';
      return { text: `🌊 DUO WAVE #N${gameNumber}\n${h40} · ${ct40}\n⚡ RETRY ${maxR} · ${sl40}`, parse_mode: null };
    }

    // ── Format 41 : Duo Insight ───────────────────────────────────────────────
    case 41: {
      const h41 = hand === 'banquier' ? '🏦 Banquier' : '👤 Joueur';
      const ct41 = suit === 'deux' ? '2️⃣ Deux cartes' : suit === 'trois' ? '3️⃣ Trois cartes' : suit === 'WIN_B' ? '🏆 Banquier gagne' : suit === 'WIN_P' ? '🏆 Joueur gagne' : `${emoji} ${name}`;
      const sl41 = status === null ? '💡 Analyse...' : status === 'gagne' ? `✅ Insight confirmé (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '❌ Raté';
      return { text: `💡 DUO INSIGHT\n┌──────────────────┐\n│ #N${gameNumber} · ${h41}\n│ ${ct41} · +${maxR}\n└──────────────────┘\n${sl41}`, parse_mode: null };
    }

    // ── Format 42 : Duo Arrow ─────────────────────────────────────────────────
    case 42: {
      const ct42 = suit === 'deux' ? '2🃏' : suit === 'trois' ? '3🃏' : suit === 'WIN_B' ? '🏦' : suit === 'WIN_P' ? '👤' : emoji;
      const sl42 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `🏹 #N${gameNumber} ${ct42} ×${maxR} ${sl42}`, parse_mode: null };
    }

    // ── Format 43 : Duo Bell ──────────────────────────────────────────────────
    case 43: {
      const h43 = hand === 'banquier' ? 'BANQUIER' : 'JOUEUR';
      const ct43 = suit === 'deux' ? `2 CARTES ${h43}` : suit === 'trois' ? `3 CARTES ${h43}` : suit === 'WIN_B' ? 'BANQUIER GAGNE' : suit === 'WIN_P' ? 'JOUEUR GAGNE' : name.toUpperCase();
      const sl43 = status === null ? '🔔 SONNERIE...' : status === 'gagne' ? `🔔 DING ! (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '🔕 SILENCE';
      return { text: `🔔 DUO BELL 🔔\n📍 JEU #N${gameNumber}\n⚠️ ${ct43}\n🔁 DOGON : +${maxR}\n${sl43}`, parse_mode: null };
    }

    // ── Format 44 : Duo Crown ─────────────────────────────────────────────────
    case 44: {
      const h44 = hand === 'banquier' ? '🏦 Banquier' : '👤 Joueur';
      const ct44 = suit === 'deux' ? '2️⃣ Deux cartes' : suit === 'trois' ? '3️⃣ Trois cartes' : suit === 'WIN_B' ? '🏆 Victoire Banquier' : suit === 'WIN_P' ? '🏆 Victoire Joueur' : `${emoji} ${name}`;
      const sl44 = status === null ? '⌛ Attente royale...' : status === 'gagne' ? `👑 COURONNÉ ! (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '💀 Défaite';
      return { text: `👑 DUO CROWN\n━━━━━━━━━━━━━━━\n🎮 #N${gameNumber} · ${h44}\n${ct44} · +${maxR}\n━━━━━━━━━━━━━━━\n${sl44}`, parse_mode: null };
    }

    // ── Format 45 : Duo Zap ───────────────────────────────────────────────────
    case 45: {
      const ct45 = suit === 'deux' ? '2️⃣⚡' : suit === 'trois' ? '3️⃣⚡' : suit === 'WIN_B' ? '🏦⚡' : suit === 'WIN_P' ? '👤⚡' : `${emoji}⚡`;
      const sl45 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `⚡ DUO ZAP\n${ct45} #N${gameNumber} +${maxR} | ${sl45}`, parse_mode: null };
    }

    // ── Formats 46-55 : VICTOIRE ──────────────────────────────────────────────

    // ── Format 46 : Win Champion ──────────────────────────────────────────────
    case 46: {
      const vl46 = suit === 'WIN_B' ? '🏦 BANQUIER' : suit === 'WIN_P' ? '👤 JOUEUR' : suit === 'TIE' ? '⚖️ ÉGALITÉ' : `${emoji} ${name.toUpperCase()}`;
      const sl46 = status === null ? '⌛ Analyse...' : status === 'gagne' ? `🏆 ${RATR_EMOJI[rattrapage] ?? rattrapage} VICTOIRE CHAMPION !` : `❌ Pas de victoire — ${maxR} essais`;
      return { text: `🏆 WIN CHAMPION\n━━━━━━━━━━━━━━━━\n📌 #N${gameNumber}\n🎯 ${vl46} DOMINE\n🔰 Dogon : +${maxR}\n━━━━━━━━━━━━━━━━\n${sl46}`, parse_mode: null };
    }

    // ── Format 47 : Win Star Elite ────────────────────────────────────────────
    case 47: {
      const vl47 = suit === 'WIN_B' ? '🏦 Banquier' : suit === 'WIN_P' ? '👤 Joueur' : suit === 'TIE' ? '⚖️ Égalité' : `${emoji} ${name}`;
      const sl47 = status === null ? '⌛' : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `╔══════════════════╗\n🌟 WIN STAR — #N${gameNumber}\n╚══════════════════╝\n${vl47} · +${maxR}\n${sl47}`, parse_mode: null };
    }

    // ── Format 48 : Win Flash ─────────────────────────────────────────────────
    case 48: {
      const vl48 = suit === 'WIN_B' ? '🏦' : suit === 'WIN_P' ? '👤' : suit === 'TIE' ? '⚖️' : emoji;
      const sl48 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `⚡ WIN FLASH #N${gameNumber} ${vl48} +${maxR} ${sl48}`, parse_mode: null };
    }

    // ── Format 49 : Win Or (Gold) ─────────────────────────────────────────────
    case 49: {
      const vl49 = suit === 'WIN_B' ? '🏦 BANQUIER' : suit === 'WIN_P' ? '👤 JOUEUR' : suit === 'TIE' ? '⚖️ ÉGALITÉ' : name.toUpperCase();
      const sl49 = status === null ? '⌛ En cours...' : status === 'gagne' ? `🥇 OR ! (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '❌ Raté';
      return { text: `🥇 WIN OR BACCARAT 🥇\n🎮 #N${gameNumber}\n🏆 ${vl49}\n⚡ Tentatives : ×${maxR}\n${sl49}`, parse_mode: null };
    }

    // ── Format 50 : Win Diamond VIP ───────────────────────────────────────────
    case 50: {
      const vl50 = suit === 'WIN_B' ? '🏦 Banquier' : suit === 'WIN_P' ? '👤 Joueur' : suit === 'TIE' ? '⚖️ Égalité' : `${emoji} ${name}`;
      const sl50 = status === null ? '💎 Cristallisation...' : status === 'gagne' ? `💎 Diamond (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '❌ Pas de diamond';
      return { text: `💎 WIN DIAMOND VIP\n◆──────────────────◆\n│ #N${gameNumber} · ${vl50}\n│ Dogon +${maxR}\n◆──────────────────◆\n${sl50}`, parse_mode: null };
    }
    // ── Format 51 : Win Signal ───────────────────────────────────────────────
    case 51: {
      const vl51 = suit === 'WIN_B' ? '🏦' : suit === 'WIN_P' ? '👤' : suit === 'TIE' ? '⚖️' : emoji;
      const sl51 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `🔔 WIN SIGNAL\n${vl51} #N${gameNumber} +${maxR} → ${sl51}`, parse_mode: null };
    }
    // ── Format 52 : Win Alert ────────────────────────────────────────────────
    case 52: {
      const vl52 = suit === 'WIN_B' ? 'BANQUIER GAGNE' : suit === 'WIN_P' ? 'JOUEUR GAGNE' : suit === 'TIE' ? 'ÉGALITÉ' : name.toUpperCase();
      const sl52 = status === null ? '⏳ ATTENTE' : status === 'gagne' ? `🟢 CONFIRMÉ (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '🔴 RATÉ';
      return { text: `🚨 WIN ALERT — JEU #N${gameNumber}\n⚠️ ${vl52}\n🔁 MAX ${maxR} | ${sl52}`, parse_mode: null };
    }
    // ── Format 53 : Win Compact ──────────────────────────────────────────────
    case 53: {
      const vl53 = suit === 'WIN_B' ? '🏦' : suit === 'WIN_P' ? '👤' : suit === 'TIE' ? '⚖️' : emoji;
      const sl53 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `${vl53}WIN #N${gameNumber} ×${maxR} ${sl53}`, parse_mode: null };
    }
    // ── Format 54 : Win HTML ─────────────────────────────────────────────────
    case 54: {
      const vl54 = suit === 'WIN_B' ? '<b>🏦 BANQUIER</b>' : suit === 'WIN_P' ? '<b>👤 JOUEUR</b>' : suit === 'TIE' ? '<b>⚖️ ÉGALITÉ</b>' : `<b>${name}</b>`;
      const sl54 = status === null ? '⌛ <i>En cours...</i>' : status === 'gagne' ? `✅ <b>GAGNÉ</b> ${RATR_EMOJI[rattrapage] ?? rattrapage}` : `❌ <i>Perdu</i>`;
      return { text: `🏆 <b>VICTOIRE PREMIUM</b>\n📌 Jeu <b>#N${gameNumber}</b>\n🎯 ${vl54} va gagner\n🔰 Dogon <b>+${maxR}</b>\n${sl54}`, parse_mode: 'HTML' };
    }
    // ── Format 55 : Win Dark ─────────────────────────────────────────────────
    case 55: {
      const vl55 = suit === 'WIN_B' ? '◼️ BANQUIER' : suit === 'WIN_P' ? '◽ JOUEUR' : suit === 'TIE' ? '◈ ÉGALITÉ' : `${emoji} ${name.toUpperCase()}`;
      const sl55 = status === null ? '◈ PENDING...' : status === 'gagne' ? `◉ WIN (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '✖ LOSS';
      return { text: `◼️◼️◼️ WIN DARK ◼️◼️◼️\n◽ #N${gameNumber} · ${vl55} · +${maxR}\n◼️ ${sl55}`, parse_mode: null };
    }

    // ── Formats 56-65 : CARTE ENSEIGNE ───────────────────────────────────────

    // ── Format 56 : Enseigne Pro ─────────────────────────────────────────────
    case 56: {
      const h56 = hand === 'banquier' ? '🏦 BANQUIER' : '👤 JOUEUR';
      const sl56 = status === null ? '⌛ Vérification...' : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage} CONFIRMÉ 🎯` : `❌ Non confirmé sur ${maxR} jeux`;
      return { text: `🎴 ENSEIGNE PRO BACCARAT\n━━━━━━━━━━━━━━━━\n📌 Jeu #N${gameNumber}\n🎯 Couleur : ${emoji} ${name.toUpperCase()}\n👥 Camp : ${h56}\n🔰 Dogon : +${maxR}\n━━━━━━━━━━━━━━━━\n${sl56}`, parse_mode: null };
    }
    // ── Format 57 : Suit VIP ─────────────────────────────────────────────────
    case 57: {
      const h57 = hand === 'banquier' ? '🏦' : '👤';
      const sl57 = status === null ? '⌛' : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `╔══════════════════╗\n${emoji} SUIT VIP — Jeu #N${gameNumber}\n╚══════════════════╝\n${h57} ${name} · +${maxR}\n${sl57}`, parse_mode: null };
    }
    // ── Format 58 : Suit Bold ────────────────────────────────────────────────
    case 58: {
      const h58 = hand === 'banquier' ? 'BANQUIER' : 'JOUEUR';
      const sl58 = status === null ? '⌛ EN COURS...' : status === 'gagne' ? `✅ CONFIRMÉ (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '❌ ÉCHEC';
      return { text: `${emoji}${emoji} BACCARAT ENSEIGNE ${emoji}${emoji}\n🎮 #N${gameNumber} · ${name.toUpperCase()} ${h58}\n⚡ DOGON MAX : +${maxR}\n${sl58}`, parse_mode: null };
    }
    // ── Format 59 : Suit Signal ──────────────────────────────────────────────
    case 59: {
      const h59e = hand === 'banquier' ? '🏦' : '👤';
      const sl59 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `📡 SUIT #N${gameNumber} ${emoji}${name} ${h59e} ×${maxR} ${sl59}`, parse_mode: null };
    }
    // ── Format 60 : Suit Dark ────────────────────────────────────────────────
    case 60: {
      const h60 = hand === 'banquier' ? 'BANK' : 'PLAY';
      const sl60 = status === null ? '▒ SCAN...' : status === 'gagne' ? `◉ HIT (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '✖ MISS';
      return { text: `░░ SUIT DARK ░░\n▓ #N${gameNumber} ▓ ${emoji} ${name.toUpperCase()} ▓ ${h60} ▓ +${maxR}\n▒ ${sl60}`, parse_mode: null };
    }
    // ── Format 61 : Suit Gold ────────────────────────────────────────────────
    case 61: {
      const h61 = hand === 'banquier' ? '🏦 Banquier' : '👤 Joueur';
      const sl61 = status === null ? '⌛ Analyse...' : status === 'gagne' ? `✨ GOLDEN WIN (${RATR_EMOJI[rattrapage] ?? rattrapage})` : `❌ Raté`;
      return { text: `✨ 𝐒𝐔𝐈𝐓 𝐆𝐎𝐋𝐃 ✨\n━━━━━━━━━━━━━━━\n🎯 #N${gameNumber} · ${emoji} ${name}\n${h61} · +${maxR}\n━━━━━━━━━━━━━━━\n${sl61}`, parse_mode: null };
    }
    // ── Format 62 : Suit Compact ─────────────────────────────────────────────
    case 62: {
      const h62 = hand === 'banquier' ? '🏦' : '👤';
      const sl62 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `${emoji}${h62} #N${gameNumber} +${maxR} ${sl62}`, parse_mode: null };
    }
    // ── Format 63 : Suit Alert ───────────────────────────────────────────────
    case 63: {
      const h63 = hand === 'banquier' ? 'BANQUIER' : 'JOUEUR';
      const sl63 = status === null ? '⏳ ATTENTE' : status === 'gagne' ? `🟢 ENSEIGNE CONFIRMÉE (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '🔴 RATÉ';
      return { text: `🚨 ALERTE ENSEIGNE ${emoji} 🚨\n📍 JEU #N${gameNumber} — ${h63}\n⚠️ COULEUR : ${name.toUpperCase()}\n🔁 DOGON : +${maxR}\n${sl63}`, parse_mode: null };
    }
    // ── Format 64 : Suit Crystal ─────────────────────────────────────────────
    case 64: {
      const h64 = hand === 'banquier' ? '🏦 Banquier' : '👤 Joueur';
      const sl64 = status === null ? '🔷 Prédiction active...' : status === 'gagne' ? `💎 CRISTAL CONFIRMÉ (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '🔸 Non confirmé';
      return { text: `💎 CRYSTAL SUIT\n◈ Jeu #N${gameNumber}\n◈ ${emoji} ${name} — ${h64}\n◈ Puissance : ×${maxR}\n${sl64}`, parse_mode: null };
    }
    // ── Format 65 : Suit Block ───────────────────────────────────────────────
    case 65: {
      const sl65 = status === null ? '⌛ Attente' : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `【${emoji} SUIT BLOCK 】\n【 Jeu #N${gameNumber} 】\n【 +${maxR} 】 ${sl65}`, parse_mode: null };
    }

    // ── Formats 66-75 : HYBRIDES ─────────────────────────────────────────────

    // ── Format 66 : Multi-Pro ────────────────────────────────────────────────
    case 66: {
      const h66 = hand === 'banquier' ? '🏦 BANQUIER' : '👤 JOUEUR';
      const ct66 = suit === 'trois' ? `3️⃣ 3 CARTES` : suit === 'deux' ? `2️⃣ 2 CARTES` : suit === 'WIN_B' ? '🏆 BANQUIER GAGNE' : suit === 'WIN_P' ? '🏆 JOUEUR GAGNE' : suit === 'TIE' ? '⚖️ ÉGALITÉ' : `${emoji} ${name.toUpperCase()}`;
      const sl66 = status === null ? '⌛ En attente...' : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage} CONFIRMÉ` : `❌ Raté (${maxR} essais)`;
      return { text: `⭐ MULTI PRO BACCARAT\n═══════════════════\n📍 Jeu #N${gameNumber}\n🎯 ${ct66}\n👥 ${h66} · +${maxR}\n═══════════════════\n${sl66}`, parse_mode: null };
    }
    // ── Format 67 : Total Signal ─────────────────────────────────────────────
    case 67: {
      const ct67 = suit === 'trois' ? '3️⃣' : suit === 'deux' ? '2️⃣' : suit === 'WIN_B' ? '🏦W' : suit === 'WIN_P' ? '👤W' : suit === 'TIE' ? '⚖️' : emoji;
      const sl67 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `📡 TOTAL SIGNAL\n${ct67} #N${gameNumber} +${maxR} → ${sl67}`, parse_mode: null };
    }
    // ── Format 68 : Full VIP ─────────────────────────────────────────────────
    case 68: {
      const h68 = hand === 'banquier' ? '🏦 Banquier' : '👤 Joueur';
      const ct68 = suit === 'trois' ? '3️⃣ Trois cartes' : suit === 'deux' ? '2️⃣ Deux cartes' : suit === 'WIN_B' ? '🏆 Victoire Banquier' : suit === 'WIN_P' ? '🏆 Victoire Joueur' : suit === 'TIE' ? '⚖️ Égalité' : `${emoji} ${name}`;
      const sl68 = status === null ? '⌛ Prédiction active...' : status === 'gagne' ? `✅ Confirmé (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '❌ Manqué';
      return { text: `╔══════════════════╗\n💎 FULL VIP BACCARAT\n╚══════════════════╝\n📌 #N${gameNumber} · ${h68}\n🎯 ${ct68}\n🔰 Dogon ×${maxR}\n${sl68}`, parse_mode: null };
    }
    // ── Format 69 : Pro Compact ──────────────────────────────────────────────
    case 69: {
      const ct69 = suit === 'trois' ? '3🃏' : suit === 'deux' ? '2🃏' : suit === 'WIN_B' ? '🏦W' : suit === 'WIN_P' ? '👤W' : suit === 'TIE' ? '⚖️' : emoji;
      const h69 = hand === 'banquier' ? '🏦' : '👤';
      const sl69 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `${ct69}${h69} #N${gameNumber} ×${maxR} ${sl69}`, parse_mode: null };
    }
    // ── Format 70 : Elite Plus ───────────────────────────────────────────────
    case 70: {
      const h70 = hand === 'banquier' ? '🏦 BANK' : '👤 PLAYER';
      const ct70 = suit === 'trois' ? `3️⃣ 3 CARDS` : suit === 'deux' ? `2️⃣ 2 CARDS` : suit === 'WIN_B' ? '🏆 BANK WIN' : suit === 'WIN_P' ? '🏆 PLAYER WIN' : `${emoji} ${name.toUpperCase()}`;
      const sl70 = status === null ? '⏳ LIVE' : status === 'gagne' ? `🟢 WIN (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '🔴 LOSE';
      return { text: `🏅 ELITE PLUS\n▶ #N${gameNumber} | ${h70}\n▶ ${ct70} | RETRY ${maxR}\n▶ ${sl70}`, parse_mode: null };
    }
    // ── Format 71 : Diamond Pro ──────────────────────────────────────────────
    case 71: {
      const h71 = hand === 'banquier' ? '🏦 Banquier' : '👤 Joueur';
      const ct71 = suit === 'trois' ? '3️⃣ 3 cartes' : suit === 'deux' ? '2️⃣ 2 cartes' : suit === 'WIN_B' ? '🏆 Banquier gagne' : suit === 'WIN_P' ? '🏆 Joueur gagne' : `${emoji} ${name}`;
      const sl71 = status === null ? '◇ En cours...' : status === 'gagne' ? `💎 CONFIRMÉ (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '◈ Non confirmé';
      return { text: `💎 DIAMOND PRO\n◆ Jeu #N${gameNumber} — ${h71}\n◆ ${ct71}\n◆ Dogon : +${maxR}\n${sl71}`, parse_mode: null };
    }
    // ── Format 72 : Crown Multi ──────────────────────────────────────────────
    case 72: {
      const h72 = hand === 'banquier' ? '🏦 Banquier' : '👤 Joueur';
      const ct72 = suit === 'trois' ? '3️⃣ Trois cartes' : suit === 'deux' ? '2️⃣ Deux cartes' : suit === 'WIN_B' ? '🏆 Victoire Banquier' : suit === 'WIN_P' ? '🏆 Victoire Joueur' : `${emoji} ${name}`;
      const sl72 = status === null ? '⌛ En attente...' : status === 'gagne' ? `👑 VICTOIRE (${RATR_EMOJI[rattrapage] ?? rattrapage})` : '💀 Défaite';
      return { text: `👑 CROWN MULTI CASINO\n━━━━━━━━━━━━━━━\n🎮 #N${gameNumber} · ${h72}\n${ct72} · +${maxR}\n━━━━━━━━━━━━━━━\n${sl72}`, parse_mode: null };
    }
    // ── Format 73 : Tiger Multi ──────────────────────────────────────────────
    case 73: {
      const ct73 = suit === 'trois' ? '3️⃣🐯' : suit === 'deux' ? '2️⃣🐯' : suit === 'WIN_B' ? '🏦🐯' : suit === 'WIN_P' ? '👤🐯' : `${emoji}🐯`;
      const sl73 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `🐯 TIGER MULTI 🐯\n${ct73} — #N${gameNumber} — ×${maxR}\n${sl73}`, parse_mode: null };
    }
    // ── Format 74 : Flash Multi ──────────────────────────────────────────────
    case 74: {
      const h74 = hand === 'banquier' ? '🏦' : '👤';
      const ct74 = suit === 'trois' ? '3️⃣' : suit === 'deux' ? '2️⃣' : suit === 'WIN_B' ? '🏆B' : suit === 'WIN_P' ? '🏆P' : emoji;
      const sl74 = status === null ? '⌛' : status === 'gagne' ? `✅${RATR_EMOJI[rattrapage] ?? rattrapage}` : '❌';
      return { text: `⚡ FLASH ${ct74}${h74} #N${gameNumber} +${maxR} ${sl74}`, parse_mode: null };
    }
    // ── Format 75 : Ultra Pro ────────────────────────────────────────────────
    case 75: {
      const h75 = hand === 'banquier' ? '🏦 BANQUIER' : '👤 JOUEUR';
      const ct75 = suit === 'trois' ? `3️⃣ 3 CARTES — ${h75}` : suit === 'deux' ? `2️⃣ 2 CARTES — ${h75}` : suit === 'WIN_B' ? '🏆 BANQUIER GAGNE' : suit === 'WIN_P' ? '🏆 JOUEUR GAGNE' : suit === 'TIE' ? '⚖️ ÉGALITÉ' : `${emoji} ${name.toUpperCase()}`;
      const sl75 = status === null ? '⌛ Analyse en cours...' : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage} ULTRA CONFIRMÉ 🌟` : `❌ Pas confirmé après ${maxR} essais`;
      return { text: `🌟 ═══ ULTRA PRO BACCARAT ═══ 🌟\n📍 Jeu #N${gameNumber}\n🎯 ${ct75}\n🔰 Dogon max : ×${maxR}\n━━━━━━━━━━━━━━━━━━━━━━\n${sl75}`, parse_mode: null };
    }

    // ── Format 76 : Cartes Signature ────────────────────────────────────────
    case 76: {
      const h76 = hand === 'banquier' ? 'Banquier' : 'Joueur';
      const ct76 = suit === 'deux' ? '2 cartes'
                 : suit === 'trois' ? '3 cartes'
                 : suit === 'pair' ? 'Pair'
                 : suit === 'impair' ? 'Impair'
                 : name;
      const sl76 = status === null    ? '⌛'
                 : status === 'gagne' ? `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`
                 :                      '❌';
      return {
        text:
          `💠Jeux №${gameNumber}\n` +
          `🎯${h76} recevra ${ct76}\n` +
          `🌤 Rattrapages +${maxR}\n` +
          `🗯️Résultats : ${sl76}`,
        parse_mode: null,
      };
    }

    // ── Format 77 : Absence Victoire (V1 Joueur / V2 Banquier) ─────────────
    case 77: {
      // V1 = Victoire Joueur (WIN_P), V2 = Victoire Banquier (WIN_B)
      const v77 = suit === 'WIN_P' ? 'V1' : suit === 'WIN_B' ? 'V2' : suit === 'TIE' ? 'Ég.' : name;
      let sl77;
      if (status === null) {
        sl77 = `⏳ 💧 Poursuite ${maxR}!! (🔰+ ${maxR}Risque`;
      } else if (status === 'gagne') {
        sl77 = `✅${RATR_EMOJI[rattrapage] ?? rattrapage} 💧 Poursuite ${maxR}!! (🔰+ ${rattrapage}Risque`;
      } else {
        sl77 = `❌ 💧 Poursuite ${maxR}!! (🔰+ ${maxR}Risque`;
      }
      return {
        text: `🌈 Jeux № ${gameNumber} 🔹 Prediction: ${v77} 🌹Statut :${sl77}`,
        parse_mode: null,
      };
    }

    // ── Format 78 : Cartes joueur/banquier (💠 Jeux №) ─────────────────────
    case 78: {
      const cl78 = cardsLabel || (suit === 'deux' ? '2/2' : '3/3');
      const h78 = 'Joueur';
      let sl78;
      if (status === null)         sl78 = '';
      else if (status === 'gagne') sl78 = `\u2705 ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else                         sl78 = '\u274C';
      return {
        text:
          `\uD83D\uDCA0Jeux \u2116${gameNumber}\n` +
          `\uD83C\uDFAF${h78} recevra ${cl78} \n` +
          `\uD83C\uDF24 Rattrapages +${maxR}\n` +
          `\uD83D\uDDEF\uFE0FR\u00E9sultats : ${sl78}\n` +
          `${status === null ? '\uD83C\uDF81En cours \u23F3' : ''}`,
        parse_mode: null,
      };
    }

    // ── Format 79 : Distribution encadrée (⚜ Baccara ⚜) ────────────────────
    case 79: {
      const cl79 = cardsLabel || (suit === 'trois' ? '3/3' : '2/2');
      let sl79;
      if (status === null)         sl79 = '\uD83C\uDF81En cours \u23F3';
      else if (status === 'gagne') sl79 = `\u2705 ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else                         sl79 = '\u274C';
      return {
        text:
          `\u269CBaccara \u269C\n` +
          `\u250C \u2116 ${gameNumber}\n` +
          `\u2514 joueur ${cl79}\n` +
          `${sl79}`,
        parse_mode: null,
      };
    }

    // ── Formats 80 à 83 : Pair / Impair (stratégie VAR) ────────────────────
    case 80: {
      const p80 = suit === 'pair' ? 'PAIR 🟢' : 'IMPAIR 🔴';
      let sl80;
      if (status === null)         sl80 = '⏳ En cours';
      else if (status === 'gagne') sl80 = `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else                         sl80 = '❌';
      return {
        text:
          `🎴 *BACCARA — PAIR / IMPAIR*\n` +
          `🔢 Jeu : #N${gameNumber}\n` +
          `🎯 Prédiction : ${p80}\n` +
          `🔁 Rattrapage : +${maxR}\n` +
          `📊 Statut : ${sl80}`,
        parse_mode: null,
      };
    }

    case 81: {
      const p81 = suit === 'pair' ? '🟢 PAIR' : '🔴 IMPAIR';
      let sl81;
      if (status === null)         sl81 = '⌛';
      else if (status === 'gagne') sl81 = `✅${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else                         sl81 = '❌';
      return { text: `⚜ #N${gameNumber} Joueur +${sup} ⚜\n◽Parité ${p81}\n◼️ Résultat ${sl81}`, parse_mode: null };
    }

    case 82: {
      const p82 = suit === 'pair' ? 'PAIR' : 'IMPAIR';
      const e82 = getSuitEmoji(suit);
      let sl82;
      if (status === null)         sl82 = 'En cours ⏳';
      else if (status === 'gagne') sl82 = `GAGNÉ ✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else                         sl82 = 'PERDU ❌';
      return {
        text: `🌈 Jeux № ${gameNumber} 🔹 Point Joueur : ${e82} ${p82} 🌹 Statut : ${sl82} (Poursuite ${maxR})`,
        parse_mode: null,
      };
    }

    case 83: {
      const p83 = suit === 'pair' ? '🟢 P A I R' : '🔴 I M P A I R';
      let sl83;
      if (status === null)         sl83 = '🎁En cours ⏳';
      else if (status === 'gagne') sl83 = `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else                         sl83 = '❌';
      return {
        text:
          `⚜️ Baccara ⚜️\n` +
          `┌ Jeu № ${gameNumber}\n` +
          `├ Point du joueur\n` +
          `└ ${p83}\n` +
          `${sl83}`,
        parse_mode: null,
      };
    }


    // ── Formats 84 à 86 : Prédiction dans l'ombre (retour de carte) ────────
    case 84: {
      let sl84;
      if (status === null)         sl84 = '⏳ En cours';
      else if (status === 'gagne') sl84 = `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else                         sl84 = '❌';
      return {
        text:
          `🕯️ PRÉDICTION DANS L'OMBRE\n` +
          `🔢 Jeu : #N${gameNumber}\n` +
          `🎯 Carte : ${emoji} ${name}\n` +
          `🔁 Rattrapage : +${maxR}\n` +
          `📊 Statut : ${sl84}`,
        parse_mode: null,
      };
    }

    case 85: {
      let sl85;
      if (status === null)         sl85 = '⌛';
      else if (status === 'gagne') sl85 = `✅${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else                         sl85 = '❌';
      return { text: `🌑 #N${gameNumber} ${emoji} ombre +${sup}\n◾ Statut ${sl85}`, parse_mode: null };
    }

    case 86: {
      let sl86;
      if (status === null)         sl86 = '🎁 En cours ⏳';
      else if (status === 'gagne') sl86 = `✅ ${RATR_EMOJI[rattrapage] ?? rattrapage}`;
      else                         sl86 = '❌';
      return {
        text:
          `⚜️ Baccara — Ombre ⚜️\n` +
          `┌ Jeu № ${gameNumber}\n` +
          `├ Retour de carte\n` +
          `└ ${emoji} ${name}\n` +
          `${sl86}`,
        parse_mode: null,
      };
    }


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
