# Déploiement — Bot Baccara

Le service Node.js peut démarrer sans PostgreSQL. Aucune URL de base de données,
aucun jeton Telegram et aucun mot de passe admin ne sont livrés dans le code.

## Configuration Render

Le jeton Telegram saisi dans **Réglages → Bot Telegram** est enregistré dans
`app_config` en PostgreSQL et rechargé au démarrage. Si le même `DATABASE_URL`
reste attaché au service, il n'est pas nécessaire de ressaisir `BOT_TOKEN`.
Le compte admin déjà enregistré en base reste utilisable sans
`ADMIN_PASSWORD_DEFAULT`.

Dans Render, conserve le `DATABASE_URL` déjà utilisé par le site si tu veux
retrouver les réglages persistés, dont le jeton Telegram. `BOT_TOKEN` et
`ADMIN_PASSWORD_DEFAULT` restent des valeurs de secours pour un premier
démarrage ou un mode hors ligne ; elles ne sont pas requises quand les données
et le compte existent déjà en base. `ADMIN_ID` configure les commandes Telegram,
et `ADMIN_IDENTIFIER` peut remplacer l'identifiant admin par défaut.

`SESSION_SECRET` signe les cookies de connexion. Si sa valeur est déjà présente
dans l'environnement Render, garde-la telle quelle : pas besoin de la ressaisir.
Sans cette variable, le service génère une clé temporaire et les sessions de
connexion peuvent expirer au redémarrage. `ACTIVE_CHANNELS` est un secours pour
les canaux de diffusion.

Ne colle jamais ces valeurs dans le code, dans `data.json` ou dans un ZIP partagé.

## Lancer le service

- **Build** : `npm install`
- **Start** : `npm start`
- **Contrôle de santé** : `/health`
- **Connexion au tableau de bord** : `/login.html`

L'identifiant et le mot de passe du compte admin déjà enregistré en base sont
inchangés. `ADMIN_PASSWORD_DEFAULT` ne sert qu'à semer un nouveau compte admin
ou à activer le secours hors ligne.
