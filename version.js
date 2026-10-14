// Numéro de version de CE ZIP : affiché sur le site (Accueil, Aide, Envois) et dans /api/version.
// À changer à chaque nouvelle archive pour vérifier d'un coup d'œil que le bon fichier est déployé.
module.exports = {
  version: 'v46',
  name: 'relance-format-aligne',
  date: '2026-10-14',
  features: [
    'Relance : message et fenêtre de 10 s mieux organisés (même structure sur chaque ligne, espaces réguliers, texte normal sans bloc code) ; la fenêtre devient une petite carte bilingue français / russe avec séparateurs',
    'Relance : nouvelle présentation du message (sans pourcentage) : ♣️✅0️⃣N°: 1158 / ┣━ N°1158✅ / ┣━♦️ N°1161⏳ / ♦️⏳ ; une fois la relance jouée : ┣━ N°1161✅ et ♦️✅0️⃣N°: 1161',
    'Bouton « Combiné » corrigé : l’erreur « COMBINED_LEVEL_LABELS is not defined » est réglée (constante manquante dans public/index.html)',
    'Relance : l’attente se compte APRÈS la sortie du 1ᵉʳ costume (✅0️⃣ / ✅1️⃣ / ✅2️⃣) : on regarde le jeu suivant ; si l’autre n’est pas venu, relance à (numéro du jeu où le 1ᵉʳ est sorti) + n ; s’il sort pendant l’attente, pas de relance',
    'Relance : la vérification se fait maintenant à N+1 par défaut (au lieu de N+2) : si le 2ᵉ costume n’est pas venu à N+1, il est relancé à N+n (réglable)',
    'Relance à N+3 corrigée : elle n’est plus bloquée par la prédiction normale du même jeu (et inversement), « relancé » n’est posé que si l’envoi a réussi, et la raison d’un refus s’affiche (jeu déjà joué)',
    'Relance : un costume relancé à N°1115 et sorti à 1115 affiche ✅0️⃣ (rattrapage compté depuis le jeu de la relance) au lieu de ✅3️⃣',
    'Relance : la fenêtre de 10 s est plus jolie (mise en forme) et bilingue français / russe',
    'Relance : le verdict de l’analyse du +n est aussi envoyé au chat privé ; à chaque relance, une fenêtre « Prédit : N° costume » est envoyée dans le canal et supprimée après 10 s',
    'Relance : analyse auto cochée = plus de N+7 fixe, la relance attend le verdict de l’analyse (+n choisi) avant d’être envoyée',
    'Relance : on attend que le costume pas venu ne sorte pas jusqu’à N+2, puis relance à N+7 (attente et numéro réglables)',
    'Relance : analyse auto du +n (teste de +3 jusqu’à +n, applique tout seul le plus réussi après 8 situations)',
    'Relance : envoi aussi vers un autre canal, avec son format de prédiction et son nombre de rattrapages',
    'Relance +3 : le N° de la relance (⏳ → ✅ / ❌) est placé à côté du costume relancé, et le N° d’origine (✅) à côté du costume sorti',
    'Stabilité du jeu : évaluation toutes les 30 min (xxh00 / xxh30) sur les 10 derniers jeux ; stable si le taux de jeux stables atteint le seuil (80 % par défaut, réglable sur la page)',
    'Stabilité du jeu : fenêtre ramenée de 7 à 4 jeux analysés (les 4 costumes doivent sortir chez le joueur sur 4 jeux)',
    'Nul / 2-3 : prédit ensemble le match nul (X) ou le 2/3 ; règles de départ modifiables (2/3 → +1, nul 2/2 → +1, nul 3/2 → +2, nul 3/3 → +3)',
    'L’analyse (historique sur plusieurs sabots) propose d’ajouter, modifier ou supprimer une règle : liste cliquable dans le chat privé (bouton Appliquer, commande /nul)',
  ],
};
