// routes/account.js
// Droits sur les données du COMPTE connecté.
//   POST /api/account/delete      -> supprime définitivement le compte et ses données
//   GET  /api/account/export-nova -> données Nova du compte (mémoire par profil, compteurs)
//
// Identité : TOUJOURS le compte du jeton de session vérifié (claim `sub`) — jamais
// un identifiant envoyé dans la requête : impossible de viser le compte d'un autre.
// Suppression : confirmation explicite « SUPPRIMER » + connexion par mot de passe
// de moins de REAUTH_MAX_AGE_S secondes (l'app redemande le mot de passe).
// Les autres données du compte (profils, progression, projets, agenda) sont lues
// par l'app elle-même, protégées par les règles RLS de Supabase.

const express = require('express');

const { verifySupabaseToken, UUID } = require('../auth/verifyToken');
const { forgetAccount } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const sb = require('../fiche/supabase');
const { logError, errorMeta } = require('../lib/log');

const router = express.Router();

const CONFIRM_WORD = 'SUPPRIMER';
/** Âge maximal de la connexion par mot de passe pour supprimer le compte (secondes). */
const REAUTH_MAX_AGE_S = Number(process.env.ACCOUNT_REAUTH_MAX_AGE_S) || 300;

router.use('/api/account', rateLimit({ windowMs: 60_000, max: 20, key: (req) => req.ip || 'inconnue' }));
const perAccount = rateLimit({
  windowMs: 10 * 60_000,
  max: 10,
  key: (req) => (req.accountId ? `${req.accountId}:${req.method}:${req.path}` : null),
});

async function accountAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Connecte-toi pour continuer.', code: 'auth_required' });
  if (!sb.configured()) return res.status(503).json({ error: 'Service momentanément indisponible.', code: 'not_configured' });
  try {
    const account = await verifySupabaseToken(token);
    req.accountId = account.accountId;
    req.passwordAuthAt = account.passwordAuthAt;
  } catch {
    return res.status(401).json({ error: 'Ta session a expiré. Reconnecte-toi.', code: 'auth_invalid' });
  }
  return next();
}

/** Reste-t-il une ligne de ce compte dans une table ? (contrôle après suppression) */
async function hasRows(path) {
  const rows = await sb.request(path);
  return Array.isArray(rows) && rows.length > 0;
}

// -------------------------------------------------------------------------
// POST /api/account/delete  — { confirm: "SUPPRIMER" }
// -------------------------------------------------------------------------
router.post('/api/account/delete', accountAuth, perAccount, async (req, res) => {
  if (!req.body || req.body.confirm !== CONFIRM_WORD) {
    return res.status(400).json({ error: `Pour confirmer, écris ${CONFIRM_WORD}.`, code: 'confirm_required' });
  }
  const now = Math.floor(Date.now() / 1000);
  const at = req.passwordAuthAt;
  if (at == null || now - at > REAUTH_MAX_AGE_S || at - now > 60) {
    return res.status(403).json({ error: 'Pour ta sécurité, saisis à nouveau ton mot de passe.', code: 'reauth_required' });
  }

  const id = req.accountId;
  if (!UUID.test(id)) return res.status(400).json({ error: 'Compte invalide.', code: 'account_invalid' });

  // 1) Suppression du compte : une seule transaction côté base (cascades).
  try {
    await sb.adminDeleteUser(id);
  } catch (e) {
    logError('account', 'delete_failed', errorMeta(e));
    return res.status(502).json({ error: 'La suppression n’a pas abouti. Rien n’a été supprimé : réessaie.', code: 'delete_failed', deleted: false });
  }
  forgetAccount(id);

  // 2) Vérification : plus aucune donnée rattachée au compte.
  const q = encodeURIComponent(id);
  let leftovers;
  try {
    const checks = await Promise.all([
      hasRows(`profiles?user_id=eq.${q}&select=id&limit=1`),
      hasRows(`learners?account_id=eq.${q}&select=id&limit=1`),
      hasRows(`nova_usage_account?account_id=eq.${q}&select=day&limit=1`),
    ]);
    leftovers = checks.some(Boolean);
  } catch (e) {
    logError('account', 'delete_check_failed', errorMeta(e));
    return res.status(200).json({ ok: true, deleted: true, verified: false });
  }
  if (leftovers) {
    logError('account', 'delete_partial');
    return res.status(500).json({ error: 'Le compte est supprimé, mais des données restent à effacer. Contacte-nous.', code: 'delete_partial', deleted: true });
  }
  return res.json({ ok: true, deleted: true, verified: true });
});

// -------------------------------------------------------------------------
// GET /api/account/export-nova -> { novaMemory: [...], novaUsage: [...] }
//   Tables réservées au serveur (RLS sans règle) : lues ici, filtrées par le
//   compte du jeton, puis revérifiées (aucune ligne d'un autre profil).
// -------------------------------------------------------------------------
router.get('/api/account/export-nova', accountAuth, perAccount, async (req, res) => {
  const q = encodeURIComponent(req.accountId);
  try {
    const learners = await sb.request(`learners?account_id=eq.${q}&select=id`);
    const ids = (Array.isArray(learners) ? learners : []).map((l) => String(l.id).toLowerCase()).filter((x) => UUID.test(x));
    const mine = new Set(ids);
    let memory = [];
    if (ids.length > 0) {
      const rows = await sb.request(`nova_memory?learner_id=in.(${ids.join(',')})&select=learner_id,fiche,updated_at`);
      memory = (Array.isArray(rows) ? rows : [])
        .filter((r) => mine.has(String(r.learner_id).toLowerCase()))
        .map((r) => ({ learnerId: r.learner_id, fiche: r.fiche, updatedAt: r.updated_at }));
    }
    const usageRows = await sb.request(`nova_usage_account?account_id=eq.${q}&select=account_id,day,chat,memory&order=day.asc`);
    const novaUsage = (Array.isArray(usageRows) ? usageRows : [])
      .filter((r) => String(r.account_id).toLowerCase() === req.accountId)
      .map((r) => ({ day: r.day, messages: Number(r.chat) || 0, memoryUpdates: Number(r.memory) || 0 }));
    res.set('Cache-Control', 'no-store');
    return res.json({ novaMemory: memory, novaUsage });
  } catch (e) {
    logError('account', 'export_failed', errorMeta(e));
    return res.status(503).json({ error: 'Export momentanément indisponible. Réessaie.', code: 'export_failed' });
  }
});

module.exports = router;
