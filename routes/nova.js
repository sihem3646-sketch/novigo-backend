// routes/nova.js
// Coach Nova (programme Adultes).
//   POST /api/nova          -> réponse du coach en streaming (SSE)
//   POST /api/nova/memoire  -> met à jour la mémoire (fiche) du profil à partir de la conversation
//   GET  /api/nova/quota    -> messages restants aujourd'hui et ce mois-ci (affichage dans l'app)
// Identité : middleware novaAuth (compte Supabase vérifié + profil du compte — jamais le body).
// Mémoire : par PROFIL ; quotas : par COMPTE ; les deux dans Supabase (migration 0005).
//
// Quotas (nova/plans.js, réglables) : formule « free » = 20 messages par mois et
// 5 par jour au plus ; « tester » = sécurité invisible ; « premium » prêt, non
// attribué. Plus un garde-fou de coût global par jour, et un limiteur de rafales.
// Si l'IA échoue (surcharge, panne), le message est RENDU et l'app peut réessayer.

const express = require('express');
const { Readable } = require('stream');

const { novaAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { loadFiche, saveFiche } = require('../fiche/ficheStore');
const usage = require('../fiche/usageStore');
const { parseFiche } = require('../fiche/ficheSchema');
const { planLimits, limitMessage, quotaView } = require('../nova/plans');
const { buildSystemPrompt, buildMemoryPrompt } = require('../nova/prompt');
const mistral = require('../nova/mistral');
const { logError, errorMeta } = require('../lib/log');

const router = express.Router();

const BUSY = 'Nova est très sollicitée en ce moment. Réessaie dans un instant.';
const UNAVAILABLE = 'Nova est momentanément indisponible. Réessaie dans un instant.';
/** Contexte envoyé par l'app (fiche « Mon projet », parcours…) : borné. */
const MAX_CONTEXT = 6000;

// Rafales : par adresse (avant toute vérification), puis par compte et par route.
router.use('/api/nova', rateLimit({ windowMs: 60_000, max: Number(process.env.NOVA_IP_PER_MINUTE) || 60, key: (req) => req.ip || 'inconnue' }));
const perAccount = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.NOVA_ACCOUNT_PER_MINUTE) || 12,
  key: (req) => (req.accountId ? `${req.accountId}:${req.method}:${req.path}` : null),
});

// Ne garde que des messages user/assistant, bornés en nombre et en longueur.
function sanitizeMessages(input, maxCount, maxLen) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-maxCount)
    .map((m) => ({ role: m.role, content: m.content.slice(0, maxLen) }));
}

function transcript(messages) {
  return sanitizeMessages(messages, 40, 4000)
    .map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Nova'}: ${m.content}`)
    .join('\n');
}

// Le LLM peut entourer le JSON de ```json … ``` malgré la consigne : on nettoie.
function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

// Journaux sans contenu : où, statut, code (voir lib/log.js).
function logStorage(where, e) {
  logError('nova', `storage_${where}`, errorMeta(e));
}

// -------------------------------------------------------------------------
// GET /api/nova/quota  -> { plan, unlimited, limit, remaining, daily, monthly, reason, message }
//   Accès testeur : on ne révèle pas la sécurité invisible.
// -------------------------------------------------------------------------
router.get('/api/nova/quota', novaAuth, perAccount, async (req, res) => {
  try {
    return res.json(quotaView(req.plan, await usage.status(req.accountId)));
  } catch (e) {
    logStorage('quota', e);
    return res.status(503).json({ error: UNAVAILABLE, retry: true });
  }
});

// -------------------------------------------------------------------------
// POST /api/nova  — { messages, lessonContext? }  -> SSE
// -------------------------------------------------------------------------
router.post('/api/nova', novaAuth, perAccount, async (req, res) => {
  if (!mistral.isConfigured()) {
    return res.status(503).json({ error: UNAVAILABLE });
  }

  const messages = sanitizeMessages(req.body && req.body.messages, 20, 4000);
  if (messages.length === 0) {
    return res.status(400).json({ error: 'Champ "messages" requis (liste user/assistant non vide).' });
  }

  let quota;
  try {
    quota = await usage.consume(req.accountId, 'chat', planLimits(req.plan, 'chat'));
  } catch (e) {
    logStorage('quota', e);
    return res.status(503).json({ error: UNAVAILABLE, retry: true });
  }
  if (!quota.allowed) {
    return res.status(429).json({ error: limitMessage(req.plan, quota.reason, quota.day), reason: quota.reason, quota: quotaView(req.plan, quota) });
  }
  const giveBack = () => usage.refund(req.accountId, 'chat', quota.day).catch((e) => logStorage('refund', e));

  let fiche;
  try {
    fiche = await loadFiche(req.accountId, req.learnerId);
  } catch (e) {
    logStorage('memory_load', e);
    await giveBack();
    return res.status(503).json({ error: UNAVAILABLE, retry: true });
  }
  const rawContext = req.body && typeof req.body.lessonContext === 'string' ? req.body.lessonContext : '';
  const system = buildSystemPrompt({ fiche, lessonContext: rawContext.slice(0, MAX_CONTEXT) });
  const payload = [{ role: 'system', content: system }, ...messages];

  // Abandonner l'appel Mistral si le CLIENT se déconnecte. On écoute la réponse
  // (res), pas la requête : req 'close' se déclenche dès que le corps est lu
  // (express.json) et avorterait l'appel avant même qu'il démarre.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const upstream = await mistral.chatStream({ messages: payload, signal: controller.signal });
    if (!upstream.ok || upstream.body == null) {
      // Le corps de l'erreur de l'IA n'est ni lu ni journalisé (il peut citer la demande).
      logError('nova', 'llm_error', { status: upstream.status });
      await giveBack();
      return res.status(503).json({ error: BUSY, retry: true });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // On relaie tel quel le flux SSE de Mistral (chunks compatibles OpenAI).
    Readable.fromWeb(upstream.body)
      .on('error', () => res.end())
      .pipe(res);
  } catch (e) {
    if (controller.signal.aborted) return res.end();
    logError('nova', 'llm_failed', errorMeta(e));
    await giveBack();
    return res.status(503).json({ error: BUSY, retry: true });
  }
});

// -------------------------------------------------------------------------
// POST /api/nova/memoire  — { messages }  -> met à jour la fiche du PROFIL
//   Validation Zod : si elle échoue, on LOG et on garde la fiche précédente.
// -------------------------------------------------------------------------
router.post('/api/nova/memoire', novaAuth, perAccount, async (req, res) => {
  if (!mistral.isConfigured()) {
    return res.status(503).json({ ok: false, kept: true, reason: 'config' });
  }

  const conversation = transcript(req.body && req.body.messages);
  if (conversation.length === 0) {
    return res.status(400).json({ error: 'Champ "messages" requis pour mettre à jour la fiche.' });
  }

  // La mise à jour de la mémoire appelle aussi l'IA : plafonds à part (pas les messages de la personne).
  let quota;
  try {
    quota = await usage.consume(req.accountId, 'memory', planLimits(req.plan, 'memory'));
  } catch (e) {
    logStorage('quota_memory', e);
    return res.status(503).json({ ok: false, kept: true, reason: 'storage' });
  }
  if (!quota.allowed) {
    return res.status(429).json({ ok: false, kept: true, reason: 'quota' });
  }
  const giveBack = () => usage.refund(req.accountId, 'memory', quota.day).catch((e) => logStorage('refund', e));

  let previous;
  try {
    previous = await loadFiche(req.accountId, req.learnerId);
  } catch (e) {
    logStorage('memory_load', e);
    await giveBack();
    return res.status(503).json({ ok: false, kept: true, reason: 'storage' });
  }
  const prompt = buildMemoryPrompt({ fiche: previous, conversation });

  let text;
  try {
    text = await mistral.chat({ messages: [{ role: 'user', content: prompt }] });
  } catch (e) {
    logError('nova/memoire', 'llm_failed', errorMeta(e));
    await giveBack();
    return res.status(503).json({ ok: false, kept: true, reason: 'llm' });
  }

  let parsed;
  try {
    parsed = extractJson(text);
  } catch {
    // Le message d'erreur JSON cite le texte de l'IA : on ne le journalise pas.
    logError('nova/memoire', 'json_invalid');
    return res.json({ ok: false, kept: true, reason: 'json' });
  }

  const validation = parseFiche(parsed);
  if (!validation.ok) {
    // Seulement le nombre de problèmes : les détails Zod peuvent citer les valeurs reçues.
    logError('nova/memoire', 'schema_invalid', { count: validation.error.issues.length });
    return res.json({ ok: false, kept: true, reason: 'schema' });
  }

  try {
    const fiche = { ...validation.data, misAJourLe: new Date().toISOString() };
    const saved = await saveFiche(req.accountId, req.learnerId, fiche);
    return res.json({ ok: true, fiche: saved });
  } catch (e) {
    logStorage('memory_save', e);
    return res.status(503).json({ ok: false, kept: true, reason: 'storage' });
  }
});

module.exports = router;
