// auth/verifyToken.js
// Vérifie le jeton de session Supabase envoyé par l'app (Authorization: Bearer …).
// Identité de confiance = le compte (claim `sub`) d'un jeton dont la SIGNATURE,
// l'émetteur, l'audience et l'expiration sont valides. Rien d'autre (ni un id
// envoyé dans la requête, ni un identifiant d'appareil) n'est jamais cru.
//
// Projets Supabase à clés asymétriques (ES256/RS256 — cas de Novigo) : la clé
// publique est lue sur le JWKS du projet, gardée 10 min, relue si une clé
// inconnue apparaît (rotation). Ancien secret partagé (HS256) : accepté
// seulement si SUPABASE_JWT_SECRET est configuré.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_REFRESH_MIN_MS = 30 * 1000;

function supabaseUrl() {
  return (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
}

let jwks = { keys: new Map(), fetchedAt: 0 };

async function loadJwks() {
  const base = supabaseUrl();
  if (!base) throw new Error('SUPABASE_URL manquant');
  const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  const res = await fetch(`${base}/auth/v1/.well-known/jwks.json`, { headers: apiKey ? { apikey: apiKey } : {} });
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
    if (!jwk || !jwk.kid || (jwk.kty !== 'EC' && jwk.kty !== 'RSA')) continue;
    try {
      const pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
      keys.set(jwk.kid, pem);
    } catch {
      // clé illisible : ignorée
    }
  }
  jwks = { keys, fetchedAt: Date.now() };
}

/** Clé publique d'un `kid` (JWKS en cache, relu si absent ou périmé). */
async function publicKeyFor(kid) {
  const age = Date.now() - jwks.fetchedAt;
  if (age > JWKS_TTL_MS || (!jwks.keys.has(kid) && age > JWKS_REFRESH_MIN_MS)) await loadJwks();
  return jwks.keys.get(kid) || null;
}

/**
 * Vérifie un jeton de session. Renvoie { accountId } ou lève une erreur.
 * Jamais de repli : un jeton douteux est refusé.
 */
async function verifySupabaseToken(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded !== 'object' || !decoded.header) throw new Error('jeton illisible');
  const { alg, kid } = decoded.header;

  let key;
  if (alg === 'ES256' || alg === 'RS256') {
    key = kid ? await publicKeyFor(String(kid)) : null;
  } else if (alg === 'HS256') {
    key = process.env.SUPABASE_JWT_SECRET || null;
  }
  if (!key) throw new Error('clé de vérification introuvable');

  const base = supabaseUrl();
  const payload = jwt.verify(token, key, {
    algorithms: [alg],
    audience: 'authenticated',
    ...(base ? { issuer: `${base}/auth/v1` } : {}),
    clockTolerance: 30,
  });
  if (!payload || payload.role !== 'authenticated' || typeof payload.sub !== 'string' || !UUID.test(payload.sub)) {
    throw new Error('jeton sans compte');
  }
  return { accountId: payload.sub.toLowerCase() };
}

/** Tests : oublie le JWKS en cache. */
function resetJwksCache() {
  jwks = { keys: new Map(), fetchedAt: 0 };
}

module.exports = { verifySupabaseToken, resetJwksCache, UUID };
