# Plan du code — où se trouve quoi

Ce fichier sert de plan : une ligne par module, rangé par rôle. Chaque module est un fichier `.js` à la racine ; l'interface (menu, pages, formulaires) est dans `public/index.html`.

## Comment une prédiction circule

1. `predictor.js` lit les jeux, appelle chaque stratégie de `strategies.js` (`detect`) et crée la prédiction.
2. `bot.js` décide où l'envoyer (public / silencieux, via `canSend`) et l'envoie à Telegram. **Tous les envois passent par `installChannelGuard` dans `bot.js`** (arrêt par canal, stabilité du jeu, suivi « Retour après perte »).
3. `predictor.js` vérifie le résultat (✅0️⃣ ✅1️⃣ … ❌) et `bot.js` modifie le message.
4. Les boutons de la section « automatique » (après perte, combinée, répétition, rupture, chevauchement…) observent ces résultats et publient leurs propres prédictions.

## Où modifier quoi

- Une stratégie de base (règle de calcul) : `strategies.js` (+ son entrée dans `LIST`). Filtres d'envoi, « série puis pause », rattrapages : `predictor.js`.
- Le texte d'un message Telegram : `tg-formats.js` / `formats.js`.
- Un bouton (page, formulaire) : sa page est une fonction `xxxPage()` dans `public/index.html` ; sa logique est dans le module du même nom ; ses routes sont dans `server.js` (cherche `/api/<nom-du-bouton>`).
- Les canaux et leurs configurations : page **Envois** (`diagnosticsPage` dans `public/index.html`, routes `/api/diagnostics/…` dans `server.js`).

## Serveur, démarrage et accès

- `server.js` — tableau de bord web (Render) + API JSON. Protégé par identifiant/mot de passe.
- `api.js` — lecture de l'API 1xbet Baccara (LiveFeed/GetChampZip)
- `bootstrap.js` — point d'entrée réel (voir package.json : "start": "node bootstrap.js").
- `auth.js` — protection du tableau de bord web
- `session-store.js` — stockage des sessions « base de données + mémoire ».
- `config.js` — réglages généraux du service.
- `version.js` — Numéro de version de CE ZIP : affiché sur le site (Accueil, Aide, Envois) et dans /api/version.
- `store.js` — persistance simple (token du bot, canaux, seuil B) dans data.json
- `paiement.js` — Paiement en ligne via des LIENS FIXES Money Fusion, un par
- `sebpay.js` — client de l'API SebPay (https://sebpay.bj), second fournisseur
- `shop.js` — Boutique de stratégies : chaque stratégie publiée par l'admin
- `deploy-generator.js` — panneau admin « Déploiement ».
- `database-url.js` — lien de la base de données PostgreSQL (Render).
- `db.js` — persistance PostgreSQL (Render) : jeux passés par date, prédictions, réglages
- `data-transfer.js` — export/import de TOUTE la configuration du bot (tokens
- `auto-import.js` — import AUTOMATIQUE du classeur de configuration au démarrage
- `midnight-reset.js` — « NOUVEAU DÉPART » chaque jour à 00h00 heure d'Abidjan

## Cœur : jeux, stratégies, vérification

- `predictor.js` — moteur multi-stratégies (main du JOUEUR uniquement)
- `strategies.js` — catalogue des stratégies de prédiction (main du JOUEUR uniquement)
- `formats.js` — adaptateur entre le moteur du bot et les 77 formats de tg-formats.js
- `tg-formats.js` — Formats de messages Telegram pour Baccarat Pro (N°1 à N°101)
- `game-stability.js` — « Stabilité du jeu » (fonction DÉSACTIVÉE PAR DÉFAUT, à activer sur le site : page « Stabilité »).
- `early-verify.js` — VÉRIFICATION ANTICIPÉE (demande admin).
- `send-delay.js` — RETARD D'ENVOI des prédictions (demande admin).
- `prediction-control.js` — interrupteur « arrêter / démarrer / planifier
- `prediction-delivery.js` — Registre commun des envois de prédictions.
- `status-animator.js` — animation du statut « En cours » des prédictions Telegram.
- `loss-notice.js` — message automatique envoyé dans le MÊME canal qu'une
- `cumulative.js` — analyse CUMULATIVE par paliers de 4 jeux
- `day-compare.js` — comparaison des statistiques des JOURS ANTÉRIEURS et
- `bilan-chart.js` — COURBE DE VARIATIONS envoyée après chaque bilan (demande admin).
- `shoe-report.js` — rapport PDF envoyé automatiquement à chaque nouveau sabot

## Telegram : envoi, canaux, bot

- `bot.js` — bot Telegram + boucle de prédiction/vérification
- `like-react.js` — bouton « J'aime » (demande admin).
- `copy-announce.js` — bouton « Copie et annonce » (demande admin).

## Boutons de prédiction automatique (déclencheurs)

- `after-loss.js` — panneau « Prédiction après perte » :
- `combined.js` — bouton « Prédiction combinée pour costume joueur » :
- `suit-streak.js` — nouveau bouton « Série de costume » (demande admin) :
- `suit-break.js` — nouveau bouton « Rupture de costume » (demande admin) :
- `overlap.js` — nouveau bouton « Chevauchement de prédictions » (demande
- `mirror-counter.js` — « Taux Miroir » : compte, pour CHAQUE carte
- `bet-type.js` — bouton « Type de mise » (demande admin).
- `vip.js` — nouveau bouton « VIP » (demande admin) :
- `cards-count.js` — nouveau bouton « Comptage 2/2 » (demande admin).
- `draw-two-three.js` — nouvelle stratégie « Nul / 2-3 » (demande admin).
- `statistics.js` — nouveau bouton « Statistiques » (demande admin) : ce

## Boutons à configurations suivies (Meilleur / Dizaine / Costume faible…)

- `best-weak-top.js` — « Meilleur + plus faible » : deux modes de configuration, pour les deux stratégies
- `dizaine-top.js` — stratégie « Dizaine — costume le plus / le moins sorti »
- `costume-faible-top.js` — stratégie « Costume faible sur 2 cartes (miroir) »
- `loss-return.js` — bouton « Retour après perte » (v47, demande admin) :
- `loss-relaunch.js` — bouton « Relance après perte » : suit des canaux ou des configurations Relance ; dès que la main du joueur du dernier rattrapage est complète, une perte → même costume à N+R+D dans le canal choisi (D=1 = jeu suivant).
- `formation.js` — bouton « Formation » (page Analyseur IA)
- `formation-relay.js` — « Envoyer la formation dans le canal »

## Intelligence artificielle

- `ai-analyzer.js` — analyseur Baccarat
- `ai-auto.js` — analyseur automatique en temps réel
- `ai-qa.js` — « Poser une question à l'IA » : réponses fondées sur les VRAIES
- `ai-repair.js` — « Réparation IA » : l'IA (Groq) lit le code du projet, écrit
- `strategy-advisor.js` — panneau « Avis IA sur les stratégies existantes »
- `pattern-miner.js` — découverte de NOUVELLES stratégies (au-delà des stratégies existantes)
- `predit.js` — panneau « Prédit » : prédictions automatiques haute fiabilité

## Jeu 21

- `game21.js` — lecture des jeux « 21 » (TwentyOne) de 1xbet + moteur d'analyse
- `game21-predict.js` — panneau « Prédiction IA jeu 21 »
- `game21-strategies.js` — création et suivi des STRATÉGIES IA du jeu « 21 ».

## Accueil du site (menu)

L'accueil est rangé par thèmes : Pilotage et envois · Stratégies de prédiction · Prédictions automatiques · Analyse des pertes · Suivi, statistiques et communauté · Intelligence artificielle · Jeu 21 · Système. Les mêmes thèmes sont repris dans la page Aide.
