# Correctif de Déploiement — Bot Baccara v106 (Mode Sans Base de Données)

Le projet a été adapté pour fonctionner de manière 100% autonome **sans aucune base de données**, tout en intégrant directement vos identifiants administrateur dans la configuration.

---

## 1. Modifications apportées

### A. Suppression de la base de données Render par défaut (`database-url.js`)
L'ancienne URL PostgreSQL en dur (`postgresql://kile_user:...@dpg-dalgdimk1f9s7385no2g-a...`) qui causait des erreurs ou des blocages au démarrage a été supprimée.
La fonction `databaseUrl()` renvoie désormais uniquement `process.env.DATABASE_URL || ''`. Sans cette variable, aucune tentative de connexion externe n'est effectuée.

### B. Ajout des identifiants administrateur dans `config.js`
Les identifiants sont maintenant déclarés directement dans `config.js` :
- **Identifiant** : `sossoukouam`
- **Mot de passe** : `arrow2026`

Ils peuvent aussi être surchargés si besoin par les variables d'environnement `ADMIN_IDENTIFIER` et `ADMIN_PASSWORD`.

### C. Gestion des sessions sans PostgreSQL (`server.js`)
Dans `server.js`, le gestionnaire de session vérifie si une base est configurée :
- Si `DATABASE_URL` est absente, les sessions utilisent directement `MemoryStore` sans chercher à joindre PostgreSQL ni `connect-pg-simple`.
- Si `DATABASE_URL` est fournie, le mode persistant hybride reste activable.

### D. Connexion administrateur immédiate (`auth.js`)
La méthode `login()` reconnaît immédiatement l'identifiant et le mot de passe configurés, même sans base de données, accordant le rôle `admin` dès le premier démarrage.

---

## 2. Déploiement sur Render ou toute autre plateforme

- **Build Command** : `npm install`
- **Start Command** : `node bootstrap.js` (ou `npm start`)
- **Variables recommandées** :
  - `BOT_TOKEN` : token de votre bot Telegram
  - `ADMIN_ID` : votre identifiant Telegram
  - `ACTIVE_CHANNELS` : vos canaux Telegram de diffusion
- **Accès au tableau de bord** : `https://<votre-domaine>/login.html`
  - Identifiant : `sossoukouam`
  - Mot de passe : `arrow2026`
