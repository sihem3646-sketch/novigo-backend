// routes/beta.js
// Bêta en libre inscription (migration 0012) : le lien testeurs demande l'accès du
// compte connecté.
//   POST /api/beta/activer -> { statut, fin }
//     statut : 'nouveau' (30 jours ouverts maintenant) | 'actif' (déjà en cours, rien
//     n'est prolongé) | 'termine' (déjà utilisé : rien n'est relancé) | 'complet' |
//     'fermees' | 'non_confirme' (adresse pas encore confirmée) | 'inconnu'
//
// Contrôles, tous côté serveur :
//   1) Compte = jeton de session vérifié (jamais un identifiant envoyé par l'app).
//   2) Origine = le lien testeurs (en-tête Origin, posé par le navigateur et non
//      modifiable par une page) : depuis novigo.expo.app ou tout autre site, refusé.
//   3) La base décide du reste (beta_activer, réservée au serveur) : adresse
//      confirmée, une seule fois par adresse, places, inscriptions ouvertes.
// Aucun Pass, aucun paiement.

const express = require('express');

const { verifySupabaseToken } = require('../auth/verifyToken');
const { forgetAccount } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const sb = require('../fiche/supabase');
const { logError, errorMeta } = require('../lib/log');

const router = express.Router();

/** Origine(s) du lien testeurs. BETA_ORIGINS (séparées par des virgules) remplace la valeur par défaut. */
const DEFAULT_BETA_ORIGINS = ['https://novigo--testeurs.expo.app'];
const STATUTS = new Set(['nouveau', 'actif', 'termine', 'complet', 'fermees', 'non_confirme', 'inconnu']);

function normalize(origin) {
  return String(origin || '').trim().replace(/\/+$/, '').toLowerCase();
}

function betaOrigins(env = process.env) {
  const raw = (env.BETA_ORIGINS || '').split(',').map(normalize).filter(Boolean);
  return new Set(raw.length > 0 ? raw : DEFAULT_BETA_ORIGINS.map(normalize));
}

router.use('/api/beta', rateLimit({ windowMs: 60_000, max: 20, key: (req) => req.ip || 'inconnue' }));
const perAccount = rateLimit({ windowMs: 10 * 60_000, max: 10, key: (req) => (req.accountId ? `beta:${req.accountId}` : null) });

function fromBetaLink(req, res, next) {
  if (!betaOrigins().has(normalize(req.headers.origin))) {
    return res.status(403).json({ error: 'L’accès bêta s’active seulement depuis le lien testeurs.', code: 'origin' });
  }
  return next();
}

async function accountAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Connecte-toi pour continuer.', code: 'auth_required' });
  if (!sb.configured()) return res.status(503).json({ error: 'Service momentanément indisponible.', code: 'not_configured' });
  try {
    req.accountId = (await verifySupabaseToken(token)).accountId;
  } catch {
    return res.status(401).json({ error: 'Ta session a expiré. Reconnecte-toi.', code: 'auth_invalid' });
  }
  return next();
}

router.post('/api/beta/activer', fromBetaLink, accountAuth, perAccount, async (req, res) => {
  let row;
  try {
    const rows = await sb.rpc('beta_activer', { p_account: req.accountId });
    row = Array.isArray(rows) ? rows[0] : rows;
  } catch (e) {
    logError('beta', 'activation_failed', errorMeta(e));
    return res.status(503).json({ error: 'Activation momentanément indisponible. Réessaie dans un instant.', retry: true });
  }
  const statut = row != null && STATUTS.has(row.statut) ? row.statut : null;
  if (statut == null) {
    logError('beta', 'activation_unexpected', {});
    return res.status(503).json({ error: 'Activation momentanément indisponible. Réessaie dans un instant.', retry: true });
  }
  // Nova voit le nouvel accès tout de suite (plutôt qu'au bout d'une minute).
  if (statut === 'nouveau') forgetAccount(req.accountId);
  return res.json({ statut, fin: typeof row.fin === 'string' ? row.fin : null });
});

module.exports = router;
module.exports.betaOrigins = betaOrigins;
