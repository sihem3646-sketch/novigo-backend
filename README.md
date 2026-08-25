# Novigo backend — Voix du mentor (ElevenLabs)

Proxy sécurisé : garde la clé ElevenLabs côté serveur et renvoie l'audio à l'app.

## Mise en route

1. **Créer un compte ElevenLabs** (https://elevenlabs.io) — offre gratuite pour tester.
2. **Récupérer la clé API** : Profil → API Key.
3. **Choisir une voix jeune/ado française** : Voice Library → écouter → copier le **Voice ID**.
   - Astuce : filtrer par langue « French » et par âge « young ».
4. Copier la config :
   ```bash
   cp .env.example .env
   ```
   Puis remplir `ELEVENLABS_API_KEY` et `ELEVENLABS_VOICE_ID`.
5. Installer et lancer :
   ```bash
   npm install
   npm start
   ```
   Le serveur écoute sur `http://localhost:8787`. Vérifie `http://localhost:8787/health`.

## Rendre l'app capable d'y accéder

- **Sur le même PC (web)** : dans `novigo/.env`, mets
  `EXPO_PUBLIC_BACKEND_URL=http://localhost:8787`
- **Sur ton téléphone (Expo Go)** : le téléphone doit joindre le PC. Utilise ton IP locale
  (`http://192.168.x.x:8787`) ou un tunnel (ngrok) et mets cette URL dans `novigo/.env`.

Ensuite, dans l'app : **Réglages → Voix du mentor → activer « Voix naturelle (IA) »**.
Sans clé configurée, l'app retombe automatiquement sur la voix du système.

---

# Coach Nova (programme Adultes)

Nova est une coach conversationnelle (Mistral) qui s'appuie sur la **fiche projet**
de chaque utilisateur. Prompt système : `prompts/nova-adultes.md`. La clé Mistral
et la logique restent **côté serveur uniquement**.

## Config

Dans `.env` :

- `MISTRAL_API_KEY` — clé API Mistral (https://console.mistral.ai).
- `SUPABASE_JWT_SECRET` — **secret JWT** du projet Supabase (Dashboard → Settings →
  API → JWT Secret). Sert à vérifier le token de l'utilisateur ; le `userId` de
  confiance est le `sub` du token — **le `userId` du body n'est jamais utilisé**.
- `NOVA_DAILY_LIMIT` — plafond de messages `/api/nova` par utilisateur et par jour
  (défaut : 20).
- `NOVA_DEV_USER` — **dev uniquement** : force un `userId` quand aucun token n'est
  fourni, pour tester en local sans Supabase. **Laisser vide en production.**

## Routes

Les deux exigent l'en-tête `Authorization: Bearer <token d'accès Supabase>`.

- **`POST /api/nova`** → `{ messages, lessonId?, lessonContext? }`
  Réponse du coach en **streaming SSE** (chunks compatibles OpenAI/Mistral).
  `lessonContext` = petit texte (titre + objectif de la leçon) fourni par l'app ;
  injecté dans `{{CONTEXTE_LECON}}`. Erreur **429** si le quota du jour est atteint.
- **`POST /api/nova/memoire`** → `{ messages }`
  Applique le 2ᵉ prompt pour mettre à jour la fiche, **valide le JSON avec Zod**
  (`fiche/ficheSchema.js`, limites `LIMITES_FICHE` incluses). Si la validation
  échoue → **log + fiche précédente conservée** (`{ ok:false, kept:true }`).

## ⚠️ Persistance — à lire avant de déployer

Par défaut, les fiches sont écrites dans **`data/fiches/<userId>.json`** (disque
local, dossier ignoré par git). C'est fiable **en local**, mais sur un hébergement
à **disque éphémère** (Render free, Railway, Fly sans volume, serverless…), les
fiches sont **perdues à chaque redéploiement**.

Avant tout déploiement : remplacer l'adaptateur de `fiche/ficheStore.js` par un
**adaptateur Supabase** (table `fiches`, écriture via la clé `service_role` côté
serveur). Seul ce fichier change — les routes n'utilisent que `loadFiche` /
`saveFiche`. Idem pour `fiche/usageStore.js` (compteur de quota).

## Sécurité (état actuel)

- Routes fermées par vérification du **token Supabase** (pas de route ouverte).
- Le `userId` provient **toujours** du token vérifié, jamais du client.
- Aucune donnée sensible n'est écrite dans la fiche (santé, opinions, coordonnées
  de tiers, bancaire) — règle portée par le prompt et le schéma.
- Le repli `NOVA_DEV_USER` est **provisoire / dev** : à désactiver en production.

