// Numéro de version de CE ZIP : affiché sur le site (Accueil, Aide, Envois) et dans /api/version.
// À changer à chaque nouvelle archive pour vérifier d'un coup d'œil que le bon fichier est déployé.
module.exports = {
  version: 'v34',
  name: 'stabilite-10-jeux-30min',
  date: '2026-10-14',
  features: [
    'Stabilité du jeu : évaluation toutes les 30 min (xxh00 / xxh30) sur les 10 derniers jeux ; stable si le taux de jeux stables atteint le seuil (80 % par défaut, réglable sur la page)',
    'Stabilité du jeu : fenêtre ramenée de 7 à 4 jeux analysés (les 4 costumes doivent sortir chez le joueur sur 4 jeux)',
    'Nul / 2-3 : prédit ensemble le match nul (X) ou le 2/3 ; règles de départ modifiables (2/3 → +1, nul 2/2 → +1, nul 3/2 → +2, nul 3/3 → +3)',
    'L’analyse (historique sur plusieurs sabots) propose d’ajouter, modifier ou supprimer une règle : liste cliquable dans le chat privé (bouton Appliquer, commande /nul)',
    'Relance +3 et envois : inchangés (v30)',
  ],
};
