// lib/cors.js
// Origines autorisées à appeler le serveur depuis un NAVIGATEUR. Liste stricte,
// sans joker : la production connue par défaut ; une adresse d'aperçu précise
// s'ajoute par configuration (ALLOWED_ORIGINS), jamais un motif large.
//
//  • Requête SANS en-tête Origin (applis mobiles natives, contrôles de santé,
//    outils serveur) : acceptée — CORS ne concerne que les navigateurs, et
//    l'authentification reste exigée par les routes.
//  • Origine connue : en-têtes CORS renvoyés.
//  • Origine inconnue : refusée (403), avant même la route.

const DEFAULT_ORIGINS = ['https://novigo.expo.app', 'https://mynovigo.fr', 'https://www.mynovigo.fr'];

function normalize(origin) {
  return String(origin || '').trim().replace(/\/+$/, '').toLowerCase();
}

/** Liste effective : ALLOWED_ORIGINS (séparées par des virgules) remplace la liste par défaut. */
function allowedOrigins(env = process.env) {
  const raw = (env.ALLOWED_ORIGINS || '').split(',').map(normalize).filter(Boolean);
  const list = raw.length > 0 ? raw : DEFAULT_ORIGINS.map(normalize);
  // Jamais de joker ni d'adresse non http(s) : une entrée invalide est ignorée.
  return list.filter((o) => !o.includes('*') && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(o));
}

function corsGuard(env = process.env) {
  const allowed = new Set(allowedOrigins(env));
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin == null || origin === '') return next();
    if (!allowed.has(normalize(origin))) {
      return res.status(403).json({ error: 'Origine non autorisée.', code: 'origin_forbidden' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Novigo-Profile,X-Novigo-Vip');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    return next();
  };
}

module.exports = { corsGuard, allowedOrigins, DEFAULT_ORIGINS };
