// Numéro de version de CE ZIP : affiché sur le site (Accueil, Aide, Envois) et dans /api/version.
// À changer à chaque nouvelle archive pour vérifier d'un coup d'œil que le bon fichier est déployé.
module.exports = {
  version: 'v30',
  name: 'relance-nr3',
  date: '2026-10-14',
  features: [
    'Relance +3 : dès qu’un costume est sorti (n’importe quel rattrapage) et que l’autre n’est pas sorti au jeu suivant → jeu vérifié + 2 (N+r+3, N+3 si direct)',
    'Même message, numéro de relance ⏳ / ✅ / ❌, format arbre ┣━ en texte normal',
    'Envois : liste complète des canaux + suppression',
  ],
};
