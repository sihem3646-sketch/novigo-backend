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
- `NOVA_DAILY_LIMIT` — messages `/api/nova` par appareil (ou compte) et par jour
  (défaut : 20).
- `NOVA_GLOBAL_DAILY_LIMIT` — plafond de messages par jour pour **tous les gratuits**
  (défaut : 3000) : garde-fou de coût.
- `NOVA_UNLIMITED_DAILY_LIMIT` / `NOVA_UNLIMITED_GLOBAL_DAILY_LIMIT` — accès illimité
  (code testeur, puis abonnés) : aucun compteur affiché, seulement une **sécurité
  invisible** par personne (défaut 500/jour) et un budget global séparé (défaut 5000).
- `NOVA_VIP_CODE_HASHES` — empreintes SHA-256 (séparées par des virgules) des codes
  testeur acceptés dans `X-Novigo-Vip` (majuscules/chiffres seulement, tirets retirés).
  Par défaut : l'empreinte du code testeur de la fondatrice (voir `middleware/auth.js`).
- `MISTRAL_API_URL` — **tests locaux uniquement** (faux serveur Mistral).
- `TTS_DAILY_CHAR_LIMIT` / `TTS_IP_DAILY_LIMIT` — plafonds de la voix IA (`/tts`) :
  caractères par jour pour tout le service (défaut 20 000) et requêtes par IP et
  par jour (défaut 300).
- `NOVA_DEV_USER` — **transition** : pour les anciennes versions de l'app qui
  n'envoient pas d'identifiant d'appareil, identité dérivée de l'IP (hachée),
  jamais partagée. **À vider quand toutes les apps sont à jour.**

## Routes

Identité (voir `middleware/auth.js`), dans cet ordre :

1. `Authorization: Bearer <token d'accès Supabase>` (compte) ;
2. sans compte : `X-Novigo-Device: <UUID v4 aléatoire de l'appareil>` +
   `X-Novigo-Profile: <id du profil actif>` → quota **par appareil**, mémoire de
   Nova **par appareil et par profil** ;
3. anciennes versions de l'app : repli `NOVA_DEV_USER` (IP hachée).

- **`GET /api/nova/quota`** → `{ unlimited, limit, remaining }` (ne consomme rien ;
  pour un accès illimité, la sécurité invisible n'est pas révélée).
- **`POST /api/nova`** → `{ messages, lessonId?, lessonContext? }`
  Réponse du coach en **streaming SSE** (chunks compatibles OpenAI/Mistral).
  `lessonContext` = petit texte (titre + objectif de la leçon) fourni par l'app ;
  injecté dans `{{CONTEXTE_LECON}}`. Erreur **429** si le quota du jour est atteint ;
  **503 `{ retry: true }`** si Mistral échoue (le message est alors rendu).
- **`POST /api/nova/memoire`** → `{ messages }`
  Applique le 2ᵉ prompt pour mettre à jour la fiche, **valide le JSON avec Zod**
  (`fiche/ficheSchema.js`, limites `LIMITES_FICHE` incluses). Si la validation
  échoue → **log + fiche précédente conservée** (`{ ok:false, kept:true }`).

## Persistance : Supabase (sinon fichiers locaux)

La mémoire de Nova (fiches) et les compteurs de quota vont dans **Supabase** dès
que les tables existent : lancer **une fois** `supabase/nova.sql` dans Supabase →
SQL Editor (tables `nova_fiches`, `nova_usage`, fonction `nova_consume`, RLS sans
règle = accès serveur uniquement). Le serveur le détecte tout seul (au plus
10 min), sans redéploiement. Il utilise `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.

Tant que ce n'est pas fait, repli sur `data/fiches/*.json` et `data/usage.json`
(disque local, ignoré par git) : **perdus à chaque redémarrage** sur un hébergement
à disque éphémère (Render free).

## Sécurité (état actuel)

- Routes Nova : token Supabase vérifié, ou identifiant d'appareil (quota par appareil
  + plafond global de coût). Aucun identifiant n'est jamais partagé entre utilisateurs.
- Le `userId` provient **toujours** du token vérifié, jamais du client.
- Aucune donnée sensible n'est écrite dans la fiche (santé, opinions, coordonnées
  de tiers, bancaire) — règle portée par le prompt et le schéma.
- Le repli `NOVA_DEV_USER` est **transitoire** : à vider quand toutes les apps envoient
  `X-Novigo-Device`.
- Un identifiant d'appareil peut être fabriqué à volonté : le plafond global
  (`NOVA_GLOBAL_DAILY_LIMIT`) borne le coût. Pour aller plus loin : comptes (anonymes)
  Supabase + vérification d'intégrité de l'app (App Attest / Play Integrity).

