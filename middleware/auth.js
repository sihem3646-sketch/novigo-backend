// middleware/auth.js
// Identité de l'appelant des routes /api/nova. Trois cas, dans cet ordre :
//
// 1) Compte Supabase : Authorization: Bearer <jwt>, vérifié avec
//    SUPABASE_JWT_SECRET. Identité de confiance = token.sub.
// 2) Sans compte (cas de l'app aujourd'hui) : l'app envoie un identifiant
//    d'APPAREIL aléatoire (X-Novigo-Device, UUID v4) et le profil actif
//    (X-Novigo-Profile). Quota = par appareil ; mémoire de Nova = par appareil
//    ET par profil (un ado ne voit pas le projet d'un adulte sur la même tablette).
// 3) Anciennes versions de l'app (aucun en-tête) : seulement si NOVA_DEV_USER est
//    défini, identité dérivée de l'adresse IP (hachée) — plus jamais une identité
//    PARTAGÉE par tout le monde. À désactiver (vider NOVA_DEV_USER) une fois
//    toutes les apps à jour.
//
// Le userId éventuellement envoyé dans le body n'est JAMAIS utilisé.
//   req.userId    -> clé de la fiche (mémoire de Nova)
//   req.quotaId   -> clé du quota quotidien
//   req.unlimited -> accès « illimité » (code testeur aujourd'hui, abonnés demain) :
//                    pas de compteur visible, seulement une sécurité invisible.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^[a-z0-9_-]{4,64}$/i;

// Codes testeur (accès illimité) : on ne garde que leur empreinte SHA-256 (le dépôt
// est public ; les codes font 24 caractères aléatoires, impossibles à deviner).
// NOVA_VIP_CODE_HASHES (liste séparée par des virgules) remplace la valeur par défaut.
const DEFAULT_VIP_HASHES = ['ae5b64e3f2a5aa41b31105fc60e72b5c3cea85ed21ed0e80746ab4b81f108192'];

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

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

function novaAuth(req, res, next) {
  req.unlimited = isVip(req);
  const secret = process.env.SUPABASE_JWT_SECRET || '';
  const devUser = process.env.NOVA_DEV_USER || '';
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  // 1) Compte Supabase.
  if (token) {
    if (!secret) {
      return res.status(500).json({ error: 'Serveur mal configuré : SUPABASE_JWT_SECRET manquant.' });
    }
    try {
      const payload = jwt.verify(token, secret);
      const sub = payload && payload.sub;
      if (!sub) return res.status(401).json({ error: 'Token sans identifiant (sub).' });
      req.userId = String(sub);
      req.quotaId = req.userId;
      return next();
    } catch {
      return res.status(401).json({ error: 'Token invalide ou expiré.' });
    }
  }

  // 2) Appareil (sans compte).
  const device = String(req.headers['x-novigo-device'] || '').trim();
  if (device) {
    if (!UUID_V4.test(device)) {
      return res.status(400).json({ error: 'Identifiant d’appareil invalide.' });
    }
    const profile = String(req.headers['x-novigo-profile'] || '').trim();
    req.quotaId = `device:${device.toLowerCase()}`;
    req.userId = PROFILE_ID.test(profile) ? `${req.quotaId}:${profile}` : req.quotaId;
    return next();
  }

  // 3) Anciennes versions de l'app : identité par IP hachée (jamais partagée).
  if (devUser) {
    req.userId = `legacy:${hash(`${devUser}:${req.ip || ''}`)}`;
    req.quotaId = req.userId;
    return next();
  }

  return res.status(401).json({ error: 'Non authentifié. Mets l’application à jour.' });
}

module.exports = { novaAuth };
