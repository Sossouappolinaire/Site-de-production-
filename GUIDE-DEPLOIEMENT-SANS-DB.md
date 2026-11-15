# Déploiement — Bot Baccara (sans compte, sans variable d'environnement)

Le site est **ouvert à tous** : aucune connexion, aucun compte à créer.
Il **n'a besoin d'aucune variable d'environnement** et n'en demande aucune.

- **Base de données** : Supabase, intégrée au code (`db-link.js`). Rien à saisir.
- **Token Telegram, ID administrateur, canaux, clés IA** : à saisir depuis le site
  (**Réglages → Bot Telegram**). Ils sont enregistrés en base et rechargés à chaque démarrage.
- **Adresse publique** et **port** : détectés automatiquement.

## Lancer le service

- **Build** : `npm install`
- **Start** : `npm start`
- **Contrôle de santé** : `/health`
- **Accès** : ouvrir l'adresse du site, directement sur le tableau de bord.

Les variables `BOT_TOKEN`, `ADMIN_ID`, `ACTIVE_CHANNELS`, etc. restent reconnues mais sont
purement **facultatives**.
