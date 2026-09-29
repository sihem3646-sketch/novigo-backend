// routes/nova.js
// Coach Nova (programme Adultes).
//   POST /api/nova          -> réponse du coach en streaming (SSE)
//   POST /api/nova/memoire  -> met à jour la fiche à partir de la conversation
//   GET  /api/nova/quota    -> messages restants aujourd'hui (affichage dans l'app)
// Identité : middleware novaAuth (compte Supabase, ou appareil + profil — jamais le body).
//
// Plafonds quotidiens :
//  - gratuit    : NOVA_DAILY_LIMIT par appareil/compte (affiché dans l'app) ;
//  - illimité   : (code testeur, puis abonnés) pas de compteur affiché, seulement une
//                 sécurité INVISIBLE NOVA_UNLIMITED_DAILY_LIMIT contre les robots ;
//  - global     : NOVA_GLOBAL_DAILY_LIMIT (gratuits) et NOVA_UNLIMITED_GLOBAL_DAILY_LIMIT
//                 (illimités) = garde-fous de coût, même si quelqu'un fabrique des
//                 identifiants à la chaîne. Budgets séparés : les gratuits ne peuvent
//                 pas épuiser celui des abonnés.
// Si l'IA échoue (surcharge, panne), le message est RENDU et l'app peut réessayer.

const express = require('express');
const { Readable } = require('stream');

const { novaAuth } = require('../middleware/auth');
const { loadFiche, saveFiche } = require('../fiche/ficheStore');
const { consume, refund, peek } = require('../fiche/usageStore');
const { parseFiche } = require('../fiche/ficheSchema');
const { buildSystemPrompt, buildMemoryPrompt } = require('../nova/prompt');
const mistral = require('../nova/mistral');

const router = express.Router();

const DAILY_LIMIT = Number(process.env.NOVA_DAILY_LIMIT) || 20;
const GLOBAL_DAILY_LIMIT = Number(process.env.NOVA_GLOBAL_DAILY_LIMIT) || 3000;
const UNLIMITED_DAILY_LIMIT = Number(process.env.NOVA_UNLIMITED_DAILY_LIMIT) || 500;
const UNLIMITED_GLOBAL_DAILY_LIMIT = Number(process.env.NOVA_UNLIMITED_GLOBAL_DAILY_LIMIT) || 5000;

const BUSY = 'Nova est très sollicitée en ce moment. Réessaie dans un instant.';

/** Compteurs à consommer pour un message (`chat`) ou une mise à jour de mémoire (`mem`). */
function quotaChecks(req, kind) {
  const p = kind === 'mem' ? 'mem:' : '';
  if (req.unlimited) {
    return [
      { key: `${p}unl:${req.quotaId}`, limit: UNLIMITED_DAILY_LIMIT },
      { key: `global-${p}unl`, limit: UNLIMITED_GLOBAL_DAILY_LIMIT },
    ];
  }
  return [
    { key: `${p}${req.quotaId}`, limit: DAILY_LIMIT },
    { key: kind === 'mem' ? 'global-mem' : 'global', limit: GLOBAL_DAILY_LIMIT },
  ];
}

/** Message clair selon le plafond atteint. */
function limitMessage(req, quota) {
  if (req.unlimited || (quota.blockedKey != null && quota.blockedKey.startsWith('global'))) {
    return 'Nova est très demandée aujourd’hui. Reviens un peu plus tard, elle sera là !';
  }
  return `Tu as utilisé tes ${DAILY_LIMIT} messages avec Nova pour aujourd’hui. Reviens demain !`;
}

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

// -------------------------------------------------------------------------
// GET /api/nova/quota  -> { unlimited, limit, remaining }
//   Illimité : on ne révèle pas la sécurité invisible.
// -------------------------------------------------------------------------
router.get('/api/nova/quota', novaAuth, async (req, res) => {
  if (req.unlimited) return res.json({ unlimited: true, limit: null, remaining: null });
  const used = (await peek([req.quotaId]))[req.quotaId] || 0;
  return res.json({ unlimited: false, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - used) });
});

// -------------------------------------------------------------------------
// POST /api/nova  — { messages, lessonId?, lessonContext? }  -> SSE
// -------------------------------------------------------------------------
router.post('/api/nova', novaAuth, async (req, res) => {
  const userId = req.userId; // de confiance (token vérifié ou appareil + profil)

  if (!mistral.isConfigured()) {
    return res.status(503).json({ error: 'Nova est momentanément indisponible.' });
  }

  const messages = sanitizeMessages(req.body && req.body.messages, 20, 4000);
  if (messages.length === 0) {
    return res.status(400).json({ error: 'Champ "messages" requis (liste user/assistant non vide).' });
  }

  const checks = quotaChecks(req, 'chat');
  const quota = await consume(checks);
  if (!quota.allowed) {
    return res.status(429).json({ error: limitMessage(req, quota), limit: req.unlimited ? undefined : DAILY_LIMIT });
  }
  const giveBack = () => refund(checks.map((c) => c.key));

  const fiche = await loadFiche(userId);
  const system = buildSystemPrompt({ fiche, lessonContext: req.body && req.body.lessonContext });
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
      const detail = await upstream.text().catch(() => '');
      console.error(`[nova] Mistral ${upstream.status} :`, detail.slice(0, 300));
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
    console.error('[nova] erreur appel Mistral :', String(e).slice(0, 200));
    await giveBack();
    return res.status(503).json({ error: BUSY, retry: true });
  }
});

// -------------------------------------------------------------------------
// POST /api/nova/memoire  — { messages }  -> met à jour la fiche
//   Validation Zod : si elle échoue, on LOG et on garde la fiche précédente.
// -------------------------------------------------------------------------
router.post('/api/nova/memoire', novaAuth, async (req, res) => {
  const userId = req.userId;

  if (!mistral.isConfigured()) {
    return res.status(503).json({ ok: false, kept: true, reason: 'config' });
  }

  const conversation = transcript(req.body && req.body.messages);
  if (conversation.length === 0) {
    return res.status(400).json({ error: 'Champ "messages" requis pour mettre à jour la fiche.' });
  }

  // La mise à jour de la mémoire appelle aussi l'IA : plafonds à part.
  const checks = quotaChecks(req, 'mem');
  const quota = await consume(checks);
  if (!quota.allowed) {
    return res.status(429).json({ ok: false, kept: true, reason: 'quota' });
  }

  const previous = await loadFiche(userId);
  const prompt = buildMemoryPrompt({ fiche: previous, conversation });

  let text;
  try {
    text = await mistral.chat({ messages: [{ role: 'user', content: prompt }] });
  } catch (e) {
    console.error('[nova/memoire] appel Mistral échoué :', String(e).slice(0, 200));
    await refund(checks.map((c) => c.key));
    return res.status(503).json({ ok: false, kept: true, reason: 'llm' });
  }

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (e) {
    console.error('[nova/memoire] JSON illisible, fiche conservée :', String(e).slice(0, 200));
    return res.json({ ok: false, kept: true, reason: 'json' });
  }

  const validation = parseFiche(parsed);
  if (!validation.ok) {
    console.error('[nova/memoire] validation Zod échouée, fiche conservée :', validation.error.issues.slice(0, 5));
    return res.json({ ok: false, kept: true, reason: 'schema' });
  }

  const fiche = { ...validation.data, misAJourLe: new Date().toISOString() };
  const saved = await saveFiche(userId, fiche); // force utilisateurId = userId de confiance
  return res.json({ ok: true, fiche: saved });
});

module.exports = router;
