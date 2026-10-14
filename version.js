// Numéro de version de CE ZIP : affiché sur le site (Accueil, Aide, Envois) et dans /api/version.
// À changer à chaque nouvelle archive pour vérifier d'un coup d'œil que le bon fichier est déployé.
module.exports = {
  version: 'v32',
  name: 'nul-2-3-analyse',
  date: '2026-10-14',
  features: [
    'Nul / 2-3 : prédit ensemble le match nul (X) ou le 2/3 ; règles de départ modifiables (2/3 → +1, nul 2/2 → +1, nul 3/2 → +2, nul 3/3 → +3)',
    'L’analyse (historique sur plusieurs sabots) propose d’ajouter, modifier ou supprimer une règle : liste cliquable dans le chat privé (bouton Appliquer, commande /nul)',
    'Relance +3 et envois : inchangés (v30)',
  ],
};
