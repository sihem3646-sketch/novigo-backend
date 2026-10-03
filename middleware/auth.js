// middleware/auth.js
// Identité de l'appelant des routes /api/nova : TOUJOURS un compte Supabase.
//
//  1) Jeton de session (Authorization: Bearer <jwt>) vérifié par le serveur
//     (signature, émetteur, audience, expiration — voir auth/verifyToken.js).
//     Compte de confiance = `sub` du jeton. Sans jeton valide : 401.
//  2) Profil actif (X-Novigo-Profile = id du profil) : il doit appartenir à CE
//     compte, vérifié en base (jamais supposé) ; sinon 403. Pas de Nova dans
//     l'espace Enfant.
//  3) Code testeur (X-Novigo-Vip) : vérifié par empreinte ; donne la formule
//     « tester » à ce compte, le temps de la requête. Les compteurs restent ceux
//     du COMPTE.
// Plus d'identité d'appareil ni d'adresse IP : un identifiant envoyé par l'app
// n'est jamais cru.
//   req.accountId -> clé des quotas (par compte)
//   req.learnerId -> clé de la mémoire de Nova (par profil)
//   req.plan      -> 'free' | 'tester' (et plus tard 'premium')

const crypto = require('crypto');

const { verifySupabaseToken, UUID } = require('../auth/verifyToken');
const sb = require('../fiche/supabase');

// Codes testeur : on ne garde que leur empreinte SHA-256 (le dépôt est public ;
// les codes font 24 caractères aléatoires, impossibles à deviner).
// NOVA_VIP_CODE_HASHES (liste séparée par des virgules) remplace la valeur par défaut.
const DEFAULT_VIP_HASHES = ['ae5b64e3f2a5aa41b31105fc60e72b5c3cea85ed21ed0e80746ab4b81f108192'];

function vipHashes() {
  const fromEnv = (process.env.NOVA_VIP_CODE_HASHES || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_VIP_HASHES;
}

/** Le code testeur envoyé (X-Novigo-Vip) est-il valide ? Casse et tirets ignorés. */
function isVip(req) {
  const code = String(req.headers['x-novigo-vip'] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 16) return false;
  const digest = crypto.createHash('sha256').update(code).digest('hex');
  return vipHashes().includes(digest);
}

// Profils déjà vérifiés (compte:profil → espace), gardés 5 minutes.
const LEARNER_TTL_MS = 5 * 60 * 1000;
const learnerCache = new Map();

async function findLearnerMode(accountId, learnerId) {
  const key = `${accountId}:${learnerId}`;
  const hit = learnerCache.get(key);
  if (hit != null && Date.now() - hit.at < LEARNER_TTL_MS) return hit.mode;
  const rows = await sb.request(
    `learners?id=eq.${encodeURIComponent(learnerId)}&account_id=eq.${encodeURIComponent(accountId)}&select=mode&limit=1`,
  );
  const mode = Array.isArray(rows) && rows[0] != null ? String(rows[0].mode) : null;
  if (mode != null) {
    learnerCache.set(key, { mode, at: Date.now() });
    if (learnerCache.size > 20000) learnerCache.clear();
  }
  return mode;
}

async function novaAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ error: 'Connecte-toi pour parler à Nova.', code: 'auth_required' });
  }
  if (!sb.configured()) {
    return res.status(503).json({ error: 'Nova est momentanément indisponible.', code: 'not_configured' });
  }

  let account;
  try {
    account = await verifySupabaseToken(token);
  } catch {
    return res.status(401).json({ error: 'Ta session a expiré. Reconnecte-toi pour parler à Nova.', code: 'auth_invalid' });
  }

  const learnerId = String(req.headers['x-novigo-profile'] || '').trim().toLowerCase();
  if (!UUID.test(learnerId)) {
    return res.status(400).json({ error: 'Choisis un profil pour parler à Nova.', code: 'profile_required' });
  }
  let mode;
  try {
    mode = await findLearnerMode(account.accountId, learnerId);
  } catch (e) {
    console.error('[nova] vérification du profil impossible :', String(e.message).slice(0, 160));
    return res.status(503).json({ error: 'Nova est momentanément indisponible.', retry: true });
  }
  if (mode == null) {
    return res.status(403).json({ error: 'Ce profil n’appartient pas à ce compte.', code: 'profile_forbidden' });
  }
  if (mode === 'kids') {
    return res.status(403).json({ error: 'Nova n’est pas disponible dans l’espace Enfant.', code: 'kids' });
  }

  req.accountId = account.accountId;
  req.learnerId = learnerId;
  req.learnerMode = mode;
  req.plan = isVip(req) ? 'tester' : 'free';
  return next();
}

module.exports = { novaAuth, isVip };
