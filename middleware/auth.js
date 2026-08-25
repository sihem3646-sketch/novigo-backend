// middleware/auth.js
// Ferme les routes /api/nova. On utilise le système de comptes EXISTANT (Supabase) :
// l'app envoie le token d'accès de l'utilisateur (Authorization: Bearer <jwt>),
// vérifié ici avec SUPABASE_JWT_SECRET. Le userId de confiance = token.sub.
// => Le userId éventuellement envoyé dans le body n'est JAMAIS utilisé pour
//    lire/écrire une fiche.
//
// Repli DEV : si NOVA_DEV_USER est défini ET qu'aucun token n'est fourni, on
// utilise cet id (fixé CÔTÉ SERVEUR) pour tester en local. À laisser vide en prod.

const jwt = require('jsonwebtoken');

function novaAuth(req, res, next) {
  const secret = process.env.SUPABASE_JWT_SECRET || '';
  const devUser = process.env.NOVA_DEV_USER || '';
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (token) {
    if (!secret) {
      return res.status(500).json({ error: 'Serveur mal configuré : SUPABASE_JWT_SECRET manquant.' });
    }
    try {
      const payload = jwt.verify(token, secret);
      const sub = payload && payload.sub;
      if (!sub) return res.status(401).json({ error: 'Token sans identifiant (sub).' });
      req.userId = String(sub);
      return next();
    } catch {
      return res.status(401).json({ error: 'Token invalide ou expiré.' });
    }
  }

  if (devUser) {
    req.userId = devUser; // DEV uniquement
    return next();
  }

  return res.status(401).json({ error: 'Non authentifié. Fournir Authorization: Bearer <token Supabase>.' });
}

module.exports = { novaAuth };
