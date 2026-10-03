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

Dans `.env` (ou les variables d'environnement de Render) :

- `MISTRAL_API_KEY` — clé API Mistral (https://console.mistral.ai).
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — **obligatoires pour Nova** : mémoire
  et quotas sont dans Supabase (et la clé publique du projet sert à vérifier les
  sessions). La clé serveur ne quitte jamais ce serveur.
- `SUPABASE_JWT_SECRET` — **facultatif** : seulement pour un projet dont les sessions
  sont signées avec l'ancien secret partagé (HS256). Novigo utilise des clés
  asymétriques (ES256), vérifiées avec la clé publique du projet (JWKS).
- `NOVA_FREE_MONTHLY_LIMIT` / `NOVA_FREE_DAILY_LIMIT` — formule gratuite : messages
  par mois (défaut 20) et au plus par jour (défaut 5), **par compte**.
- `NOVA_PREMIUM_MONTHLY_LIMIT` / `NOVA_PREMIUM_DAILY_LIMIT` — formule premium, prête
  mais **attribuée à personne** tant que les abonnements n'existent pas.
- `NOVA_FREE_MEMORY_DAILY_LIMIT` (défaut 8) — mises à jour de la mémoire par jour
  (appel IA en coulisse, ne consomme pas les messages de la personne).
- `NOVA_GLOBAL_DAILY_LIMIT` / `NOVA_GLOBAL_MEMORY_DAILY_LIMIT` — plafonds par jour pour
  **tous les comptes** (défaut 3000) : garde-fou de coût.
- `NOVA_UNLIMITED_DAILY_LIMIT` — code testeur : aucun compteur affiché, seulement une
  **sécurité invisible** par compte (défaut 500/jour).
- `NOVA_VIP_CODE_HASHES` — empreintes SHA-256 (séparées par des virgules) des codes
  testeur acceptés dans `X-Novigo-Vip` (majuscules/chiffres seulement, tirets retirés).
  Par défaut : l'empreinte du code testeur de la fondatrice (voir `middleware/auth.js`).
- `NOVA_IP_PER_MINUTE` (défaut 60) / `NOVA_ACCOUNT_PER_MINUTE` (défaut 12) — limiteur de
  rafales en mémoire.
- `MISTRAL_API_URL` — **tests locaux uniquement** (faux serveur Mistral).
- `TTS_DAILY_CHAR_LIMIT` / `TTS_IP_DAILY_LIMIT` — plafonds de la voix IA (`/tts`) :
  caractères par jour pour tout le service (défaut 20 000) et requêtes par IP et
  par jour (défaut 300).

## Routes

Identité (voir `middleware/auth.js`) — **toujours un compte** :

1. `Authorization: Bearer <jeton de session Supabase>` : signature, émetteur, audience
   et expiration vérifiés ; le compte de confiance est le `sub` du jeton. Sans jeton
   valide : **401**.
2. `X-Novigo-Profile: <id du profil actif>` : le profil doit appartenir à ce compte
   (vérifié en base) ; sinon **403**. Pas de Nova dans l'espace Enfant.
3. `X-Novigo-Vip` (facultatif) : code testeur.

Aucun identifiant envoyé par l'app (appareil, compte, profil d'un autre) n'est cru.

- **`GET /api/nova/quota`** → `{ plan, unlimited, limit, remaining, daily, monthly,
  reason, message }` (ne consomme rien ; pour un code testeur, la sécurité invisible
  n'est pas révélée).
- **`POST /api/nova`** → `{ messages, lessonContext? }`
  Réponse du coach en **streaming SSE** (chunks compatibles OpenAI/Mistral).
  `lessonContext` = contexte fourni par l'app (fiche « Mon projet », parcours…), borné
  à 6000 caractères, injecté dans `{{CONTEXTE_LECON}}`. **429** si un plafond est
  atteint (`reason` : `daily`, `monthly` ou `global`) ; **503 `{ retry: true }`** si
  Mistral échoue (le message est alors rendu).
- **`POST /api/nova/memoire`** → `{ messages }`
  Applique le 2ᵉ prompt pour mettre à jour la fiche **du profil**, **valide le JSON
  avec Zod** (`fiche/ficheSchema.js`). Si la validation échoue → **log + fiche
  précédente conservée** (`{ ok:false, kept:true }`).

## Persistance : Supabase uniquement

Migration **`novigo/supabase/migrations/0005_nova_compte.sql`** (dépôt de l'app), à
appliquer une fois dans Supabase → SQL Editor :

- `nova_memory` — la mémoire de Nova, **une fiche par profil**, supprimée avec le
  profil ou le compte ;
- `nova_usage_account` — compteurs **par compte**, par jour (heure de Paris), le mois
  étant la somme des jours ; `nova_usage_global` — garde-fou de coût ;
- fonctions `nova_consume` (atomique), `nova_refund`, `nova_usage_status`,
  `nova_memory_load`, `nova_memory_save` (qui revérifie que le profil est au compte).

Accès **serveur uniquement** : RLS sans règle + aucun droit pour les clés de l'app.
Plus aucun repli sur le disque : si Supabase est injoignable, Nova répond **503**
au lieu de compter ou retenir n'importe où.

## Sécurité

- Le compte provient **toujours** du jeton vérifié, jamais du client.
- Un compte ne peut viser que ses propres profils (vérifié en base, deux fois).
- Quotas par compte, calculés par la base : changer d'appareil ou de navigateur ne
  remet rien à zéro ; redémarrer le serveur non plus.
- Aucune donnée sensible n'est écrite dans la fiche (santé, opinions, coordonnées
  de tiers, bancaire), et rien d'inventé — règles portées par le prompt et le schéma.
