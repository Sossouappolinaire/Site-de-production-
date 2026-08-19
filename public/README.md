# Baccara Control Room

Bot Baccarat 1xbet avec tableau de bord web, moteur multi-stratégies, séparation
des canaux Telegram et analyseur guidé par Pollinations.ai.

## Déploiement sur Render

1. Crée un service Web Node depuis ce dossier.
2. Commande de build : `npm install`
3. Commande de démarrage : `npm start`
4. Health check : `/health`
5. Ajoute les variables suivantes dans Render :

| Variable | Obligatoire | Rôle |
| --- | --- | --- |
| `BOT_TOKEN` | Oui pour Telegram | Token du bot Telegram |
| `ADMIN_ID` | Recommandé | Identifiant Telegram de l'administrateur |
| `DATABASE_URL` | Oui pour la persistance | URL PostgreSQL de la base de données |
| `POLLINATIONS_API_KEY` | Non | Clé secrète pour l'enrichissement IA distant |

| `POLLINATIONS_MODEL` | Non | Modèle Pollinations, valeur par défaut `openai` |

Les clés et les URLs privées ne sont pas incluses dans le ZIP. Ne les écris jamais dans
`config.js` ou dans un fichier versionné.

## Persistance PostgreSQL

Au démarrage, le service crée ou met à jour automatiquement ses tables. La base
conserve :

- les jeux terminés et leurs cartes, points et résultats ;
- chaque prédiction des stratégies, son statut et ses rattrapages ;
- toutes les configurations globales et les configurations individuelles des stratégies ;
- les stratégies découvertes par l'IA, les analyses IA complètes et le panneau « Prédit » ;
- les réglages du bot, les canaux et l'état de l'analyse automatique.

Le fichier `data.json` n'est qu'un secours local lorsque PostgreSQL est indisponible.
En déploiement, la base est la source de vérité et les données IA sont relues après
chaque redémarrage.

## Fonctionnalités

- Accueil simplifié avec accès par boutons aux stratégies, à l'analyseur IA et
  aux 87 formats Telegram.
- Analyseur Pollinations.ai : étude des jeux passés, fréquences de costumes,
  séries, absences, parité et propositions de règles testables.
- Les propositions IA sont enregistrées comme plans inactifs : aucune règle
  générée n'est activée automatiquement.
- Chaque stratégie possède un **canal public** et un **canal silencieux**.
- Une prédiction silencieuse ne part que vers le canal silencieux.
- Une prédiction activée après le filtre double perte ne part que vers le canal
  public.
- Le même identifiant est refusé dans les deux catégories pour éviter les
  doublons de routage.
- La vérification reste basée sur la main du joueur ; la main du banquier est
  conservée pour le contexte et les statistiques.

## Utilisation

Ouvre le tableau de bord sur l'URL du service Render :

- `/#/` : accueil
- `/#/strategies` : catalogue et réglages
- `/#/ai` : analyseur et création de plans
- `/#/formats` : aperçu des formats
- `/#/settings` : token Telegram, base et réglages globaux

Après avoir ajouté le bot comme administrateur dans les canaux Telegram,
renseigne chaque ID dans la fiche de la stratégie correspondante. Utilise les
boutons de test pour vérifier séparément le canal public et le canal silencieux.

## Commandes Telegram conservées

`/live`, `/stats`, `/reglages`, `/canaux`, `/activer`, `/desactiver`,
`/setb`, `/setmaxr`, `/setformat`, `/formats`, `/apercu`, `/settemplate`,
`/setdb`, `/jeux`, `/base`, `/dates`, `/derniers`, `/jeu`, `/pred` et les
commandes de stratégie existantes restent disponibles.

## Avertissement

Les statistiques et les analyses IA décrivent uniquement un historique observé.
Elles ne garantissent pas le résultat d'un jeu et ne doivent pas être présentées
comme une certitude.

## Analyseur IA

Les adresses publiques de l'API sont définies dans `config.js` :

- Base : `https://gen.pollinations.ai`
- Texte : `https://gen.pollinations.ai/v1/chat/completions`
- Image : `https://gen.pollinations.ai/image/{PROMPT}?model=flux`
- Vidéo : `https://gen.pollinations.ai/video/{PROMPT}?model=veo&duration=4`
- Audio : `https://gen.pollinations.ai/audio/{TEXT}?voice=nova`
- Modèles : `https://gen.pollinations.ai/v1/models`

La clé se fournit avec `POLLINATIONS_API_KEY` ou à chaud depuis la page
« Analyseur IA ». Sans clé valide, le moteur local continue d'analyser seul, en
temps réel.

L'analyseur tourne automatiquement : analyse locale toutes les 15 s, enrichissement
Pollinations.ai toutes les 3 min. Chaque constat apparaît dans « Résultats », chaque
stratégie trouvée est enregistrée (désactivée) dans « Stratégies IA créées ».

La page « Envois » vérifie, pour chaque stratégie, le token du bot, les canaux
public et silencieux, le droit de publier et la dernière erreur d'envoi.

## Version 3.2 — corrections

1. **Nouveau sabot (retour au jeu n°1)** : la mémoire des jeux est remise à zéro
   automatiquement (`resetShoe`). Avant, l'ancien numéro (ex. #1440) restait le
   « dernier tour terminé » : toutes les nouvelles cibles (#1, #2…) étaient vues
   comme déjà jouées et **plus aucune prédiction ne sortait après le bilan**.
2. **Déblocage automatique après 10 minutes** : toute stratégie bloquée en mode
   silencieux est débloquée seule au bout de `autoUnlockMin` minutes (10 par
   défaut, réglable, 0 = jamais). Déblocage manuel : bouton « Débloquer »,
   `POST /api/strategies/:key/unlock` ou `/debloquer <clé|tout>` sur Telegram.
3. **Mode silencieux réglable** : `lossTrigger` = nombre de pertes avant
   d'ouvrir l'envoi. `1` = envoi dès la première perte (avant, 2 pertes étaient
   toujours exigées, d'où l'attente).
4. **Prédiction dans l'ombre / Carte absente** : le comptage d'absence ne
   s'arrêtait plus dès qu'un tour manquait dans le flux (trous tolérés) ; la
   stratégie « absence ≥ 4 puis retour → +4 » prédit désormais réellement.
5. **Analyse cumulative** : paliers 1→4, 1→8, 1→12 … jusqu'au jeu 1440.
6. **Nouveau panneau « Avis IA sur les stratégies existantes »** : avis et
   conseils cumulés (`/api/ai/strategy-advice`).


## Panneau « Prédit » (nouveau)

- Page web : onglet **Prédit** (`#/predit`).
- L'analyseur IA tourne en continu. Dès qu'une règle atteint **100 % de réussite**
  sur au moins N observations (réglable), elle est **certifiée** et entre dans le panneau.
- Chaque prédiction d'une stratégie certifiée est envoyée dans le **canal Telegram du panneau**
  (indépendant des canaux des autres stratégies).
- Si une **deuxième** stratégie atteint aussi 100 % pendant que la première reste à 100 %,
  les deux prédisent automatiquement ; quand elles visent le même jeu avec le même costume,
  le message part en **double confirmation**.
- Dès qu'une stratégie certifiée perd une prédiction, elle est retirée automatiquement du panneau.
- API : `GET /api/predit`, `POST /api/predit/config`, `POST /api/predit/channel`,
  `DELETE /api/predit/channel`, `POST /api/predit/test`, `POST /api/predit/scan`.

## Correctif : les deux modes silencieux (intervalle 0-4, max = 4)

### 1ᵉʳ mode silencieux (filtre « double perte », `silent` + `lossInterval`)
- **Phase 1** : aucune référence, on attend la 1ʳᵉ perte → elle devient la référence.
- **Phase 2** : on mesure l'écart (prédictions terminées) depuis la référence.
  - perte avec écart **≥ intervalle max (4)** → trop loin : elle devient la **nouvelle référence** ;
  - perte avec écart **< 4** → **confirmée**, `N = écart` → phase 3.
- **Phase 3** : décompte silencieux ; la prédiction en **position N** est envoyée publiquement.
  Une perte avant la position N interrompt le décompte et devient la nouvelle référence.
  `N = 1` → la prédiction suivante part directement.

### 2ᵉ mode silencieux (`silenceMode` + `silenceInterval`)
Même détection de référence et d'intervalle, mais **aucun décompte** : il ne compte ni la 1ʳᵉ
ni la 2ᵉ prédiction. Dès que la 2ᵉ perte tombe **dans l'intervalle**, la prédiction du
**jeu suivant** est envoyée dans le canal silencieux (`silenceCount` prédictions au total).
`silenceOffset` n'est plus utilisé (conservé pour compatibilité).


## Version 3.3 — vérification complète et priorité du mode silencieux

### Bugs corrigés
1. **`/jeu <n>` répondait deux fois** : la commande était captée à la fois par
   `/live` et par la fiche d'un jeu de la base. `/jeu` seul = jeu en cours,
   `/jeu 1234` = fiche du jeu dans la base.
2. **`/strategies` déclenchait aussi `/strategie`** (double réponse) : la
   commande `/strategie` n'accepte plus le pluriel.
3. **Canal présent dans les deux listes** : quand le même identifiant était
   enregistré en public ET en silencieux, la liste publique était vidée et
   **plus aucune prédiction publique ne partait**. Désormais le canal public
   est prioritaire et le doublon est simplement retiré de la liste silencieuse.
4. **Déblocage automatique qui court-circuitait « ombre »** : au bout de 10 min
   la stratégie était armée sans avoir suivi ses phases. Supprimé pour
   « ombre » (`autoUnlockMin` forcé à 0).
5. Toutes les routes HTTP (`/api/...`) et toutes les commandes Telegram
   documentées ont été testées : elles répondent toutes.

### Priorité du mode silencieux pour la stratégie « ombre »
- Le mode silencieux est **toujours actif** et **non désactivable** pour
  « ombre » ; il passe **avant** tout autre filtre.
- Aucun déblocage automatique : seules les phases 1 → 2 → 3 ouvrent le canal
  public (le déblocage manuel `/debloquer ombre` reste possible).
- Si le déclencheur automatique est activé, il ne peut qu'**ajouter** une
  condition : la prédiction ne part en public que si le filtre silencieux est
  en phase 3 **et** que le déclencheur est armé.
- Tant que le filtre n'est pas ouvert, la prédiction part **uniquement dans le
  canal silencieux** ; le champ `priority` de l'API vaut `silencieux`.

### `/ombrecompte` — suivi dynamique
Recalculé à chaque appel (aucun cache), il affiche :
- la **phase actuelle** (1 attente de la 1ʳᵉ perte · 2 référence posée et mesure
  de l'écart · 3 décompte silencieux puis envoi public) ;
- la perte de **référence** (#N) et l'**écart** mesuré depuis celle-ci ;
- le nombre de **pertes confirmées** sur le total requis (`lossTrigger`) ;
- la **position N** à atteindre et le décompte `seen/N-1` en phase 3 ;
- le **canal utilisé pour la prochaine prédiction** (public ou silencieux) ;
- les réglages en cours et, le cas échéant, l'état du déclencheur automatique.
Les mêmes informations sont exposées sur `GET /api/ombre` et `GET /api/gates`.

## Version 3.4 — stratégies IA visibles + bilan complet

### Nouvelles commandes Telegram
- `/ia [n]` — liste des stratégies **créées par l'IA** : taux actuel, **taux le
  plus bas jamais observé**, nombre de mesures, déclencheur, cible, origine.
- `/ia90 [seuil]` — uniquement les stratégies **à 90 % ou plus qui ne sont
  jamais descendues** sous ce seuil (`rateMin >= seuil`). Alias : `/elite`.
- `/iabilan` — bilan des prédictions IA (panneau « Prédit »).
- `/bilan` — publication immédiate du bilan complet (admin).

Le taux de chaque stratégie IA est désormais **remesuré à chaque analyse** :
avant, une stratégie déjà connue était ignorée et son taux restait figé, il était
donc impossible de savoir si elle était descendue. Les champs `rateMin`,
`rateMax`, `observations` et `rateHistory` sont enregistrés en base
(`ai_strategies`).

API : `GET /api/ai/strategies?min=90` renvoie la liste complète et la sélection
« jamais descendue ».

### Correctif : bilan manquant après le retour au jeu n°1
Le bilan n'était envoyé que pour les stratégies dont une prédiction venait juste
de se clôturer sur le dernier tour du sabot. Or le nouveau sabot déclenche
`resetShoe()`, qui annule les prédictions encore en attente : plus rien
n'arrivait dans la file d'attente et **aucun bilan ne partait**, ni pour les
stratégies existantes, ni pour les prédictions IA (le panneau « Prédit » n'avait
même pas de bilan Telegram).

Désormais :
1. `resetShoe()` incrémente `state.shoeSeq` : le changement de sabot est détecté
   de façon fiable (et plus seulement via le numéro live).
2. `flushBilans()` publie le bilan de **toutes** les stratégies ayant prédit
   pendant le sabot, dans leurs canaux respectifs.
3. `predit.sendBilans()` publie le bilan de **chaque stratégie IA** ayant prédit
   plus un **bilan global IA** dans le canal du panneau « Prédit ».
4. Déclenchement manuel : `/bilan` ou `POST /api/bilans/send`.

## IA — que faire quand « Insufficient balance » s'affiche

La clé Pollinations est bien configurée, mais le **solde du compte est à 0
pollen** : l'API refuse alors chaque requête (402). Le bot bascule
automatiquement sur les services gratuits, qui sont parfois saturés.

Deux solutions :

1. Recharger le compte sur https://enter.pollinations.ai (la clé actuelle
   refonctionne aussitôt, sans redéploiement).
2. Ou configurer un fournisseur de secours compatible OpenAI (Groq,
   OpenRouter, OpenAI…) avec ces variables d'environnement Render :
   - `AI_FALLBACK_URL` (ex. `https://api.groq.com/openai/v1/chat/completions`)
   - `AI_FALLBACK_KEY`
   - `AI_FALLBACK_MODEL` (ex. `llama-3.3-70b-versatile`)

## Inscription — plus de code par email

L'envoi d'un code de confirmation par Gmail a été supprimé. À l'inscription,
le compte est créé immédiatement en statut « en attente » et une fenêtre
« Merci de patienter » récapitule les informations. C'est l'administrateur
qui accepte le compte et accorde un temps d'accès depuis le panneau
« Utilisateurs ».
