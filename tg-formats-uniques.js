// tg-formats-uniques.js — Formats de prédiction N°8 à N°86 : 79 mises en page TOUTES DIFFÉRENTES.
// Chaque format a sa propre structure, ses propres bordures, son propre vocabulaire (ou sa propre langue)
// et sa propre façon d'annoncer « en cours », « gagné » et « perdu ».
//
// Règles communes (indispensables au reste du bot) :
//   • « en cours »  : le message contient toujours un sablier ⏳ ou ⌛ (animation du statut, status-animator.js)
//   • « gagné »     : le message contient ✅ et le numéro du rattrapage (0️⃣ 1️⃣ 2️⃣ …)
//   • « perdu »     : le message contient ❌
//   • aucun format n'utilise * ou _ (conversion Markdown automatique de formats.js) ni « 'n » (nettoyage)
//
// Appel : buildUnique(id, ctx) → { text, parse_mode }   (ctx est préparé par tg-formats.js)
'use strict';

// ── alphabets Unicode (pour des styles de lettres tous différents) ────────────
function conv(str, { U, L, D }) {
  return String(str).split('').map((ch) => {
    const c = ch.charCodeAt(0);
    if (U != null && c >= 65 && c <= 90) return String.fromCodePoint(U + c - 65);
    if (L != null && c >= 97 && c <= 122) return String.fromCodePoint(L + c - 97);
    if (D != null && c >= 48 && c <= 57) return String.fromCodePoint(D + c - 48);
    return ch;
  }).join('');
}
const SANS_BOLD   = (s) => conv(s, { U: 0x1D5D4, L: 0x1D5EE, D: 0x1D7EC });
const BOLD_ITAL   = (s) => conv(s, { U: 0x1D468, L: 0x1D482, D: 0x1D7CE });
const SCRIPT_BOLD = (s) => conv(s, { U: 0x1D4D0, L: 0x1D4EA, D: 0x1D7CE });
const FRAKT_BOLD  = (s) => conv(s, { U: 0x1D56C, L: 0x1D586, D: 0x1D7CE });
const MONO        = (s) => conv(s, { U: 0x1D670, L: 0x1D68A, D: 0x1D7F6 });
const SANS_ITAL   = (s) => conv(s, { U: 0x1D608, L: 0x1D622, D: 0x1D7E2 });
const CIRCLED     = (s) => conv(s, { U: 0x24B6, L: 0x24D0 });
const FULLWIDTH   = (s) => conv(s, { U: 0xFF21, L: 0xFF41, D: 0xFF10 });
const NEG_SQUARE  = (s) => conv(String(s).toUpperCase(), { U: 0x1F170 });
const DOUBLE_D    = (s) => conv(s, { D: 0x1D7D8 });
const SMALL_CAPS_MAP = { a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ' };
const SMALL_CAPS  = (s) => String(s).toLowerCase().split('').map((ch) => SMALL_CAPS_MAP[ch] || ch).join('');
const SPACED      = (s) => String(s).toUpperCase().split('').join(' ');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rep = (s, n) => s.repeat(Math.max(0, n));

// ── les 79 formats ────────────────────────────────────────────────────────────
// c = { g, e, n, t, T, R, r, rn, p, w, l, h, sup, cardsP, cardsB, found }
//   g = n° du jeu · e = emoji · n = nom FR · t = cible (costume, 2/2, Pair…) · T = cible en MAJUSCULES
//   R = rattrapages max · r = rattrapage atteint · rn = emoji du rattrapage · p/w/l = en cours / gagné / perdu
const D = {};
const pick = (c, p, w, l) => (c.p ? p : c.w ? w : l);

// 8 — Ticket de caisse
D[8] = (c) => [
  `🧾 TICKET ${c.g}`,
  `· · · · · · · · · · · · · ·`,
  `ARTICLE ..... ${c.t}`,
  `QUANTITÉ .... x${c.R}`,
  `· · · · · · · · · · · · · ·`,
  `TOTAL ....... ${pick(c, '⏳', `✅ ${c.rn} PAYÉ`, '❌ ANNULÉ')}`,
].join('\n');

// 9 — Terminal (code)
D[9] = (c) => ({
  parse_mode: 'HTML',
  text: [
    `<code>$ run game --id ${c.g}</code>`,
    `<code>cible   = "${esc(c.t)}"</code>`,
    `<code>essais  = ${c.R}</code>`,
    `<code>sortie  = ${pick(c, '⏳ attente', `0 OK ${c.rn} ✅`, '1 ÉCHEC ❌')}</code>`,
  ].join('\n'),
});

// 10 — Carte d'embarquement
D[10] = (c) => [
  `✈️ VOL ${c.g} ┃ ${c.T} ┃ PORTE ${c.R}`,
  `SIÈGE ${c.e}  ·  ${pick(c, '⏳ à l\u2019heure', `✅ ${c.rn} atterri`, '❌ vol annulé')}`,
].join('\n');

// 11 — Distribution (3 phases : en cours / trouvé avec les cartes / non distribué)
D[11] = (c) => {
  const head = [`▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜`, `▌ 🌀 DISTRIBUTION ▐`, `▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟`];
  if (c.p) return [...head, `Le jeu ${c.g} doit finir en distribution`, `⌛ contrôle en cours`].join('\n');
  if (c.w) return [...head, `✅ ${c.rn} trouvé au jeu ${c.found}`, `👤 Joueur · ${c.cardsP}`, `🏦 Banquier · ${c.cardsB}`].join('\n');
  return [...head, `Jeu ${c.g} : pas de distribution`, `❌ non distribué`].join('\n');
};

// 12 — Bulletin météo (mode parité / 2-3 cartes / costume)
D[12] = (c) => {
  const lbl = c.mode === 'parite' ? `parité ${c.t}` : c.mode === 'cartes' ? `${c.t} côté ${c.h}` : c.t;
  return [
    `🌦 ${c.g} · prévision ${lbl} sous ${c.R} jeux`,
    pick(c, '⏳ ciel variable', `☀️ ${c.rn} dégagé ✅`, `⛈ orage ❌ pas de ${c.t} sur ${c.R} jeux`),
  ].join('\n');
};

// 13 — Tableau de score (cadre épais)
D[13] = (c) => [
  `┏━━━━━━━━━━━━━━━━`,
  `┃ MATCH ${c.g} │ ${c.T}`,
  `┠────────────────`,
  `┃ MANCHES │ ${c.R + 1} max`,
  `┗━━━━━━━━━━━━━━━━`,
  pick(c, '⏳ coup d\u2019envoi', `✅ ${c.rn} victoire`, '❌ défaite'),
].join('\n');

// 14 — Télégramme
D[14] = (c) => `✉️ TELEGRAMME N ${c.g} STOP CIBLE ${c.T} STOP DELAI ${c.R} JEUX STOP REPONSE ${pick(c, '⏳ ATTENDRE', `✅ ${c.rn} RECU`, '❌ REFUS')} STOP`;

// 15 — Flash info
D[15] = (c) => [
  `🔴 EN DIRECT`,
  `📺 JEU ${c.g}`,
  `🎯 ${c.t} annoncé`,
  `⏱ ${c.R} jeux de marge`,
  `▶ ${pick(c, '⏳ confirmation attendue', `✅ ${c.rn} confirmé`, '❌ démenti')}`,
].join('\n');

// 16 — Ordonnance
D[16] = (c) => [
  `℞ n°${c.g}`,
  `${c.t} × ${c.R} jours`,
  `Effet : ${pick(c, '⏳ en observation', `✅ ${c.rn} guéri`, '❌ sans effet')}`,
].join('\n');

// 17 — Carte du chef
D[17] = (c) => [
  `🍴 ✦ Carte du chef ✦ 🍴`,
  `▫ Entrée · jeu ${c.g}`,
  `▫ Plat · ${c.t}`,
  `▫ Dessert · ${c.R} services`,
  pick(c, 'Bon appétit ⏳', `Régalez-vous ✅ ${c.rn}`, 'Cuisine fermée ❌'),
].join('\n');

// 18 — Sonar
D[18] = (c) => [
  `📡 ◜◝ ${c.t} ◞◟ jeu ${c.g} · portée ${c.R}`,
  `◉ ${pick(c, '⏳ signal en approche', `✅ ${c.rn} verrouillé`, '❌ signal perdu')}`,
].join('\n');

// 19 — Feu tricolore
D[19] = (c) => [
  `🚦 ${pick(c, '⚪🟡⚪', '⚪⚪🟢', '🔴⚪⚪')} ${c.t} · jeu ${c.g} · ${c.R} feux`,
  pick(c, '⏳ orange', `✅ ${c.rn} vert`, '❌ rouge'),
].join('\n');

// 20 — Batterie
D[20] = (c) => `🔋 ${pick(c, '[▮▮▯▯▯]', '[▮▮▮▮▮]', '[▯▯▯▯▯]')} ${c.t} · jeu ${c.g} · recharge ${c.R} ${pick(c, '⏳ charge', `✅ ${c.rn} pleine`, '❌ vide')}`;

// 21 — Thermomètre
D[21] = (c) => [
  `🌡 ${c.t} ▕${pick(c, '▁▂▃▄░░░░', '▁▂▃▄▅▆▇█', '▁░░░░░░░')}▏ ${pick(c, '⏳ ça chauffe', `✅ ${c.rn} 100 degrés`, '❌ gelé')}`,
  `jeu ${c.g} · seuil ×${c.R}`,
].join('\n');

// 22 — Dés
D[22] = (c) => [
  `🎲 jeu ${c.g}`,
  `🎲 cible ${c.t}`,
  `🎲 lancers ${c.R}`,
  `🎲 ${pick(c, '⏳ le dé roule', `✅ ${c.rn} double six`, '❌ dé raté')}`,
].join('\n');

// 23 — Machine à sous
D[23] = (c) => [
  pick(c, `🎰│${c.e}│❔│❔│`, `🎰│${c.e}│${c.e}│${c.e}│`, `🎰│${c.e}│🍋│🍒│`),
  `jeu ${c.g} · ${c.t} · ×${c.R}`,
  pick(c, '⏳ les rouleaux tournent', `✅ ${c.rn} JACKPOT`, '❌ raté'),
].join('\n');

// 24 — Boussole
D[24] = (c) => [
  `⬆️`,
  `⬅️ ${c.e} ➡️  jeu ${c.g}`,
  `⬇️`,
  `cap : ${c.t} · marge ${c.R}`,
  pick(c, '⏳ on avance', `✅ ${c.rn} arrivés`, '❌ égarés'),
].join('\n');

// 25 — Carte au trésor
D[25] = (c) => [
  `🗺 CARTE AU TRÉSOR`,
  `✖ case ${c.g} : ${c.t}`,
  `🏴‍☠️ ${c.R} pas autorisés`,
  `💰 ${pick(c, '⏳ on creuse', `✅ ${c.rn} trouvé`, '❌ introuvable')}`,
].join('\n');

// 26 — Rendez-vous
D[26] = (c) => [
  `🗓 #${c.g} · ${c.t}`,
  `🔁 ${c.R} reports possibles`,
  `📝 ${pick(c, '⏳ à confirmer', `✅ ${c.rn} confirmé`, '❌ annulé')}`,
].join('\n');

// 27 — Horoscope
D[27] = (c) => [
  `🔮 ♈ Les astres du jeu ${c.g} annoncent ${c.t} (patience : ${c.R} tours)`,
  pick(c, '✨ ⏳ les astres réfléchissent', `✨ ✅ ${c.rn} les astres avaient raison`, '✨ ❌ les astres se sont trompés'),
].join('\n');

// 28 — Carte de visite
D[28] = (c) => [
  `┌─────────────────`,
  `│ ${c.t}`,
  `│ ${c.e} jeu ${c.g}`,
  `│ ×${c.R} max`,
  `└─────────────────`,
  pick(c, '⏳', `✅ ${c.rn}`, '❌'),
].join('\n');

// 29 — Étiquette de prix
D[29] = (c) => [
  `🏷 PROMO · ${c.t} à saisir`,
  `jeu ${c.g} · stock ${c.R}`,
  pick(c, '⏳ en rayon', `✅ ${c.rn} VENDU`, '❌ rupture'),
].join('\n');

// 30 — Bulletin scolaire
D[30] = (c) => [
  `🎓 BULLETIN · classe ${c.g}`,
  `Matière : ${c.t}`,
  `Tentatives : ${c.R}`,
  `Note : ${pick(c, '⏳ en correction', `✅ ${c.rn} 20/20`, '❌ 0/20')}`,
].join('\n');

// 31 — Dossier confidentiel
D[31] = (c) => [
  `🕵️ DOSSIER ${c.g}`,
  `▮▮▮▮▮▮▮▮▮▮`,
  `OBJET : ${c.t}`,
  `ACCÈS : niveau ${c.R}`,
  pick(c, '⏳ enquête ouverte', `✅ ${c.rn} résolu`, '❌ classé'),
].join('\n');

// 32 — Code-barres
D[32] = (c) => [
  `▌│█║▌║▌║ ${c.g} ║▌║▌║█│▌`,
  `${c.t} · ×${c.R} · ${pick(c, '⏳ scan', `✅ ${c.rn} lu`, '❌ illisible')}`,
].join('\n');

// 33 — Plaque d'immatriculation
D[33] = (c) => `🚗 ┃ ${c.g} · ${c.e} ┃ route ${c.t} · ${c.R} étapes · ${pick(c, '⏳ en route', `✅ ${c.rn} arrivé`, '❌ panne')}`;

// 34 — Chronomètre
D[34] = (c) => [
  `⏱ 00:0${Math.min(9, c.R)} · jeu ${c.g}`,
  `Épreuve : ${c.t}`,
  pick(c, '⌛ départ donné', `✅ ${c.rn} chrono validé`, '❌ hors délai'),
].join('\n');

// 35 — Course de chevaux
D[35] = (c) => [
  `🏇 COURSE ${c.g}`,
  pick(c, '🏁···········🐎', '🏁🐎···········', '🏁······🐎·····'),
  `pari : ${c.t} · ${c.R} tours`,
  pick(c, '⏳ ils sont partis', `✅ ${c.rn} photo-finish gagnée`, '❌ battu d\u2019une tête'),
].join('\n');

// 36 — Échiquier
D[36] = (c) => [
  `♟ partie ${c.g} : ${c.t} (profondeur ${c.R})`,
  pick(c, '⌛ l\u2019adversaire réfléchit', `✅ ${c.rn} échec et mat`, '❌ pat'),
].join('\n');

// 37 — Podium
D[37] = (c) => [
  `🥇 PODIUM · ${c.g}`,
  pick(c, `🥈 ${c.t} (en piste)`, `🥇 ${c.t} (champion)`, `🥉 ${c.t} (hors podium)`),
  `Manches : ${c.R}`,
  pick(c, '⏳ course en cours', `✅ ${c.rn} médaille d\u2019or`, '❌ éliminé'),
].join('\n');

// 38 — Main de poker
D[38] = (c) => [
  `🃏 DONNE ${c.g}`,
  `┌──┐ ┌──┐`,
  `│${c.e}│ │${c.e}│`,
  `└──┘ └──┘`,
  `${c.t} · relances ${c.R}`,
  pick(c, '⏳ on mise', `✅ ${c.rn} quinte flush`, '❌ couché'),
].join('\n');

// 39 — Arborescence
D[39] = (c) => [
  `📁 jeu ${c.g}`,
  `├─ cible : ${c.t}`,
  `├─ essais : ${c.R}`,
  `└─ état : ${pick(c, '⏳ ouvert', `✅ ${c.rn} validé`, '❌ fermé')}`,
].join('\n');

// 40 — Équation
D[40] = (c) => [
  `∑ ${c.g} : x = ${c.t}, n ≤ ${c.R}`,
  pick(c, '⌛ résolution…', `∴ ✅ ${c.rn} CQFD`, '∴ ❌ aucune solution'),
].join('\n');

// 41 — Trois lignes brèves
D[41] = (c) => `${c.g} ⋅ ${c.t} ⋅ ${c.R} ⋅ ${pick(c, '⏳', `✅ ${c.rn}`, '❌')}`;

// 42 — Liste à cocher
D[42] = (c) => [
  `📋 À FAIRE · jeu ${c.g}`,
  `${c.w ? '☑' : '☐'} sortie de ${c.t}`,
  `${c.p ? '☐' : c.w ? '☑' : '☒'} dans les ${c.R} jeux`,
  pick(c, '⏳ en attente', `✅ ${c.rn} tout est coché`, '❌ barré'),
].join('\n');

// 43 — Frise chronologique
D[43] = (c) => {
  const steps = Array.from({ length: c.R + 1 }, (_, i) => (c.w ? (i <= c.r ? '●' : '○') : c.l ? '✕' : (i === 0 ? '◉' : '○')));
  return [
    `🕰 ${steps.join('──')}`,
    `jeu ${c.g} → ${c.t}`,
    pick(c, '⏳ étape 0', `✅ ${c.rn} atteint à l\u2019étape ${c.r}`, '❌ trajectoire interrompue'),
  ].join('\n');
};

// 44 — Tableau à colonnes
D[44] = (c) => [
  `│ JEU │ CIBLE │ MAX │ ÉTAT │`,
  `│ ${c.g} │ ${c.t} │ ${c.R} │ ${pick(c, '⏳', `✅${c.rn}`, '❌')} │`,
].join('\n');

// 45 — Bulle de discussion
D[45] = (c) => [
  `💬 « Au jeu ${c.g}, ce sera ${c.t} »`,
  `💬 « Vous avez ${c.R} chances »`,
  pick(c, '💭 ⏳ …', `💬 ✅ ${c.rn} « Bien vu ! »`, '💬 ❌ « Dommage »'),
].join('\n');

// 46 — Notification smartphone
D[46] = (c) => [
  `🔔 maintenant`,
  `Jeu ${c.g} · ${c.t} · ${c.R} essais`,
  pick(c, '⏳ non lu', `✅ ${c.rn} lu`, '❌ supprimé'),
].join('\n');

// 47 — SMS bancaire
D[47] = (c) => [
  `🏦 Opération ${c.g} · ${c.t} · plafond ${c.R}`,
  `Statut : ${pick(c, '⏳ en traitement', `✅ ${c.rn} crédité`, '❌ rejeté')}`,
].join('\n');

// 48 — Sismographe
D[48] = (c) => [
  `〰️ SISMO ${c.g} ${pick(c, '∿∿⌇∿∿∿∿', '∿∿⌇⌇⌇⌇⌇', '∿∿∿———')}`,
  `épicentre : ${c.t} · ×${c.R}`,
  pick(c, '⏳ mesure', `✅ ${c.rn} secousse détectée`, '❌ calme plat'),
].join('\n');

// 49 — Hologramme
D[49] = (c) => [
  `⟦ HOLO ⟧ ${c.g}`,
  `⟦ ${c.e} ${c.t} ⟧`,
  `⟦ ×${c.R} ⟧`,
  pick(c, '⟦ ⌛ projection ⟧', `⟦ ✅ ${c.rn} net ⟧`, '⟦ ❌ flou ⟧'),
].join('\n');

// 50 — Parchemin
D[50] = (c) => [
  `📜 Oyez, oyez !`,
  `Au jeu ${c.g}, le roi ordonne ${c.t}`,
  `Il lui sera donné ${c.R} jours`,
  pick(c, '⏳ le messager court', `✅ ${c.rn} décret exécuté`, '❌ décret révoqué'),
  `✒️ le roi`,
].join('\n');

// 51 — Avis de recherche
D[51] = (c) => [
  `🤠 W A N T E D`,
  `${c.t}`,
  `récompense ${c.R}`,
  `vu au jeu ${c.g}`,
  pick(c, '⏳ la traque continue', `✅ ${c.rn} capturé`, '❌ en fuite'),
].join('\n');

// 52 — Mission spatiale
D[52] = (c) => [
  `🚀 MISSION ${c.g}`,
  `Objectif : ${c.t}`,
  `T-moins ${c.R}`,
  pick(c, '⏳ allumage', `✅ ${c.rn} orbite atteinte`, '❌ échec au lancement'),
].join('\n');

// 53 — Compte à rebours
D[53] = (c) => `${Array.from({ length: c.R + 1 }, (_, i) => c.R - i).join('… ')}… jeu ${c.g} ${c.t} ${pick(c, '⏳ décollage imminent', `✅ ${c.rn} BOUM`, '❌ pschitt')}`;

// 54 — Commentateur
D[54] = (c) => [
  `🎙 « Mesdames et messieurs, jeu ${c.g} ! »`,
  `🎙 « On attend ${c.t} dans les ${c.R} jeux »`,
  pick(c, '🎙 ⏳ « le suspense est total »', `🎙 ✅ ${c.rn} « BUUUT ! »`, '🎙 ❌ « sur le poteau… »'),
].join('\n');

// 55 — Arbitre
D[55] = (c) => [
  `🧑‍⚖️ ARBITRE · jeu ${c.g}`,
  `Décision attendue : ${c.t}`,
  `Temps additionnel : ${c.R}`,
  pick(c, '🟨 ⏳ sous revue vidéo', `🟩 ✅ ${c.rn} but validé`, '🟥 ❌ but refusé'),
].join('\n');

// 56 — Playlist
D[56] = (c) => [
  `🎧 piste ${c.g} ♪ ${c.t} ×${c.R}`,
  pick(c, '▶ ⏳ lecture', `⏭ ✅ ${c.rn} piste suivante`, '⏹ ❌ arrêt'),
].join('\n');

// 57 — Lecteur vidéo
D[57] = (c) => [
  `🎬 Épisode ${c.g} · ${c.t} · ${c.R} relectures`,
  pick(c, '──●───────', '──────────●', '●──────────'),
  pick(c, '▶️ ⏳ 00:00', `✅ ${c.rn} fin`, '❌ lecture interrompue'),
].join('\n');

// 58 — Réseau Wi-Fi
D[58] = (c) => `📶 ${pick(c, '▂▄▁▁', '▂▄▆█', '▂▁▁▁')} réseau ${c.g} · ${c.t} · portée ${c.R} ${pick(c, '⏳ connexion', `✅ ${c.rn} connecté`, '❌ hors réseau')}`;

// 59 — Jeu vidéo (barre de vie)
D[59] = (c) => [
  `🕹 NIVEAU ${c.g}`,
  `BOSS : ${c.t}`,
  `VIES : ${rep('❤️', c.R + 1)}`,
  pick(c, '⏳ combat', `✅ ${c.rn} VICTOIRE`, '❌ GAME OVER'),
].join('\n');

// 60 — Quête de RPG
D[60] = (c) => [
  `⚔️ QUÊTE ${c.g}`,
  `Récupérer : ${c.t}`,
  `Potions : ${c.R}`,
  `Journal : ${pick(c, '⏳ quête en cours', `✅ ${c.rn} quête accomplie`, '❌ héros tombé')}`,
].join('\n');

// 61 — Dojo (crochets japonais)
D[61] = (c) => [
  `【 道場 · ${c.g} 】`,
  `【 ${c.t} 】`,
  `【 ${c.R} essais 】`,
  pick(c, '【 ⏳ concentration 】', `【 ✅ ${c.rn} ippon 】`, '【 ❌ chute 】'),
].join('\n');

// 62 — Russe
D[62] = (c) => [
  `🇷🇺 Игра №${c.g}`,
  `Цель: ${c.t}`,
  `Попыток: ${c.R}`,
  `Итог: ${pick(c, '⏳ ожидание', `✅ ${c.rn} победа`, '❌ проигрыш')}`,
].join('\n');

// 63 — Espagnol
D[63] = (c) => `🇪🇸 ¡Jugada ${c.g}! Apuesta → ${c.t} · ${c.R} intentos · ${pick(c, '⏳ esperando', `✅ ${c.rn} ¡acertó!`, '❌ fallo')}`;

// 64 — Italien
D[64] = (c) => [
  `🇮🇹 Partita n. ${c.g} · puntata su ${c.t} · tentativi ${c.R}`,
  pick(c, '⏳ in attesa', `✅ ${c.rn} bravo!`, '❌ peccato'),
].join('\n');

// 65 — Portugais
D[65] = (c) => [
  `🇵🇹 Rodada ${c.g}`,
  `Aposta em ${c.t}`,
  `Chances: ${c.R}`,
  pick(c, '⏳ aguardando', `✅ ${c.rn} acertou`, '❌ errou'),
].join('\n');

// 66 — Allemand
D[66] = (c) => [
  `🇩🇪 Spiel Nr. ${c.g}`,
  `• Tipp: ${c.t}`,
  `• Versuche: ${c.R}`,
  `• Ergebnis:`,
  pick(c, '⏳ warten', `✅ ${c.rn} Treffer`, '❌ daneben'),
].join('\n');

// 67 — Anglais (croupier)
D[67] = (c) => [
  `🇬🇧 Table ${c.g} · place your bets`,
  `Pick: ${c.t} · retries: ${c.R}`,
  `Dealer: ${pick(c, '⏳ wait', `✅ ${c.rn} winner`, '❌ no luck')}`,
].join('\n');

// 68 — Latin
D[68] = (c) => [
  `🏛 LUDUS ${c.g} · sors: ${c.t} · conatus: ${c.R}`,
  pick(c, '⏳ exspecta', `✅ ${c.rn} vicisti`, '❌ victus es'),
].join('\n');

// 69 — Gras sans empattement
D[69] = (c) => [
  SANS_BOLD(`Jeu ${c.g} · ${c.t} / ${c.R}`),
  pick(c, SANS_BOLD('attente') + ' ⏳', SANS_BOLD('gagne') + ` ✅ ${c.rn}`, SANS_BOLD('perdu') + ' ❌'),
].join('\n');

// 70 — Petites capitales
D[70] = (c) => [
  SMALL_CAPS(`jeu numéro ${c.g}`),
  SMALL_CAPS(`cible ${c.t} sur ${c.R} jeux`),
  SMALL_CAPS(pick(c, 'en cours', 'gagné', 'perdu')) + ' ' + pick(c, '⏳', `✅ ${c.rn}`, '❌'),
].join('\n');

// 71 — Lettres espacées
D[71] = (c) => `${SPACED('jeu')}  ${c.g}  ${SPACED(c.t)}  +${c.R}  ${pick(c, '⏳', `✅ ${c.rn}`, '❌')}`;

// 72 — Gras italique
D[72] = (c) => [
  BOLD_ITAL(`Jeu ${c.g} — cible ${c.t}`),
  `${BOLD_ITAL('rattrapage')} ${c.R} ${pick(c, '⏳', `✅ ${c.rn}`, '❌')}`,
].join('\n');

// 73 — Écriture manuscrite
D[73] = (c) => [
  `✒️ ${SCRIPT_BOLD(`Jeu ${c.g}`)}`,
  SCRIPT_BOLD(`${c.t} dans ${c.R} jeux`),
  pick(c, `${SCRIPT_BOLD('patience')} ⏳`, `${SCRIPT_BOLD('bravo')} ✅ ${c.rn}`, `${SCRIPT_BOLD('hélas')} ❌`),
].join('\n');

// 74 — Machine à écrire
D[74] = (c) => [
  MONO(`JEU ${c.g}`),
  MONO(`CIBLE ${c.t}`),
  MONO(`MAX ${c.R}`),
  pick(c, MONO('WAIT') + ' ⏳', MONO('OK') + ` ✅ ${c.rn}`, MONO('KO') + ' ❌'),
].join('\n');

// 75 — Lettres cerclées
D[75] = (c) => [
  `${CIRCLED('jeu')} ${c.g} ${CIRCLED('cible')} ${c.t} ${CIRCLED('max')} ${c.R}`,
  pick(c, CIRCLED('attente') + ' ⏳', CIRCLED('gagne') + ` ✅ ${c.rn}`, CIRCLED('perdu') + ' ❌'),
].join('\n');

// 76 — Lettres carrées noires
D[76] = (c) => [
  NEG_SQUARE('jeu') + ` ${c.g}`,
  `${NEG_SQUARE('cible')} ${c.t}`,
  `${NEG_SQUARE('max')} ${c.R}`,
  pick(c, '⏳', `✅ ${c.rn}`, '❌'),
].join('\n');

// 77 — Duel V1 / V2 (absence de victoire) — garde V1 = Joueur, V2 = Banquier
D[77] = (c) => [
  `⚔️ DUEL ${c.g}`,
  `┈┈┈┈┈┈┈┈┈┈`,
  `${c.v1v2 || c.t} contre le hasard`,
  `${c.R} manches`,
  pick(c, '⏳ les armes sont levées', `✅ ${c.rn} touché`, '❌ paré'),
].join('\n');

// 78 — Gothique
D[78] = (c) => [
  `${FRAKT_BOLD(`Jeu ${c.g}`)} ${FRAKT_BOLD(c.t)}`,
  `${FRAKT_BOLD(`encore ${c.R}`)} ${pick(c, '⏳', `✅ ${c.rn}`, '❌')}`,
].join('\n');

// 79 — Pleine chasse
D[79] = (c) => [
  FULLWIDTH(`JEU ${c.g}`),
  `${FULLWIDTH(c.t)} ${FULLWIDTH(`MAX ${c.R}`)} ${pick(c, '⏳', `✅ ${c.rn}`, '❌')}`,
].join('\n');

// 80 — Citation (blockquote HTML)
D[80] = (c) => ({
  parse_mode: 'HTML',
  text: `<blockquote>🎯 ${esc(c.t)} d\u2019ici ${c.R} jeux\nréf. ${c.g}\nverdict : ${pick(c, '⏳ patience', `✅ ${c.rn} bingo`, '❌ raté')}</blockquote>`,
});

// 81 — Tableau préformaté (pre HTML)
D[81] = (c) => ({
  parse_mode: 'HTML',
  text: `<pre>JEU     ${String(c.g).padEnd(6)}\nCIBLE   ${esc(c.t)}\nMAX     ${c.R}\nÉTAT    ${pick(c, '⏳', `✅ ${c.rn}`, '❌')}</pre>`,
});

// 82 — Rébus en émojis seuls
D[82] = (c) => `🎯${c.e}🔁${rep('➕', c.R)} 🔢${c.g} ${pick(c, '⏳', `✅ ${c.rn}`, '❌')}`;

// 83 — Coffre-fort
D[83] = (c) => [
  `🔐 COFFRE ${c.g}`,
  `┄┄┄┄┄┄┄┄┄┄┄┄`,
  `Combinaison : ${c.t}`,
  `Tentatives : ${c.R}`,
  pick(c, '⏳ cadran en rotation', `✅ ${c.rn} 🔓 ouvert`, '❌ 🔒 bloqué'),
].join('\n');

// 84 — Éclipse (ombre)
D[84] = (c) => [
  `🌘 ÉCLIPSE · jeu ${c.g} · dans l\u2019ombre : ${c.t}`,
  `${pick(c, '🌗 ⏳ partielle', `🌕 ✅ ${c.rn} totale`, '🌑 ❌ cachée')} (${c.R} jeux)`,
].join('\n');

// 85 — Silhouette (ombre)
D[85] = (c) => [
  `◐ ${c.g} ◑ ombre ${c.t} ⟶ +${c.R}`,
  pick(c, '◌ ⌛', `● ✅ ${c.rn}`, '○ ❌'),
].join('\n');

// 86 — Négatif photo (ombre)
D[86] = (c) => [
  `▓▓▓▓▓▓▓▓▓▓▓▓`,
  `▓ NÉGATIF ${c.g} ▓`,
  `▓ ${c.t} · ${c.R} ▓`,
  `▓▓▓▓▓▓▓▓▓▓▓▓`,
  pick(c, '⏳ développement', `✅ ${c.rn} révélé`, '❌ voilé'),
].join('\n');

const FIRST_ID = 8;
const LAST_ID = 86;

function buildUnique(id, c) {
  const fn = D[id];
  if (!fn) return null;
  const out = fn(c);
  if (out && typeof out === 'object') return out;
  return { text: out, parse_mode: null };
}

module.exports = { buildUnique, FIRST_ID, LAST_ID, _formats: D };
