// routes/nova.js
// Coach Nova (programme Adultes).
//   POST /api/nova          -> réponse du coach en streaming (SSE)
//   POST /api/nova/memoire  -> met à jour la fiche à partir de la conversation
// Auth : middleware novaAuth (userId = token Supabase vérifié, jamais le body).

const express = require('express');
const { Readable } = require('stream');

const { novaAuth } = require('../middleware/auth');
const { loadFiche, saveFiche } = require('../fiche/ficheStore');
const { checkAndIncrement } = require('../fiche/usageStore');
const { parseFiche } = require('../fiche/ficheSchema');
const { buildSystemPrompt, buildMemoryPrompt } = require('../nova/prompt');
const mistral = require('../nova/mistral');

const router = express.Router();

const DAILY_LIMIT = Number(process.env.NOVA_DAILY_LIMIT) || 20;

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
// POST /api/nova  — { messages, lessonId?, lessonContext? }  -> SSE
// -------------------------------------------------------------------------
router.post('/api/nova', novaAuth, async (req, res) => {
  const userId = req.userId; // de confiance (token vérifié)

  if (!mistral.isConfigured()) {
    return res.status(503).json({ error: 'Coach non configurée (MISTRAL_API_KEY manquante).' });
  }

  const messages = sanitizeMessages(req.body && req.body.messages, 20, 4000);
  if (messages.length === 0) {
    return res.status(400).json({ error: 'Champ "messages" requis (liste user/assistant non vide).' });
  }

  // Plafond quotidien.
  const quota = checkAndIncrement(userId, DAILY_LIMIT);
  if (!quota.allowed) {
    return res.status(429).json({
      error: `Limite quotidienne atteinte (${quota.limit} messages par jour). Reviens demain.`,
      limit: quota.limit,
    });
  }

  const fiche = loadFiche(userId);
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
      return res.status(502).json({ error: 'Erreur Mistral', status: upstream.status, detail: detail.slice(0, 300) });
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
    return res.status(500).json({ error: 'Erreur serveur coach', detail: String(e).slice(0, 200) });
  }
});

// -------------------------------------------------------------------------
// POST /api/nova/memoire  — { messages }  -> met à jour la fiche
//   Validation Zod : si elle échoue, on LOG et on garde la fiche précédente.
// -------------------------------------------------------------------------
router.post('/api/nova/memoire', novaAuth, async (req, res) => {
  const userId = req.userId;

  if (!mistral.isConfigured()) {
    return res.status(503).json({ error: 'Coach non configurée (MISTRAL_API_KEY manquante).' });
  }

  const conversation = transcript(req.body && req.body.messages);
  if (conversation.length === 0) {
    return res.status(400).json({ error: 'Champ "messages" requis pour mettre à jour la fiche.' });
  }

  const previous = loadFiche(userId);
  const prompt = buildMemoryPrompt({ fiche: previous, conversation });

  let text;
  try {
    text = await mistral.chat({ messages: [{ role: 'user', content: prompt }] });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[nova/memoire] appel Mistral échoué :', String(e).slice(0, 200));
    return res.status(502).json({ ok: false, kept: true, reason: 'llm' });
  }

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[nova/memoire] JSON illisible, fiche conservée :', String(e).slice(0, 200));
    return res.json({ ok: false, kept: true, reason: 'json' });
  }

  const validation = parseFiche(parsed);
  if (!validation.ok) {
    // eslint-disable-next-line no-console
    console.error('[nova/memoire] validation Zod échouée, fiche conservée :', validation.error.issues.slice(0, 5));
    return res.json({ ok: false, kept: true, reason: 'schema' });
  }

  const fiche = { ...validation.data, misAJourLe: new Date().toISOString() };
  const saved = saveFiche(userId, fiche); // force utilisateurId = userId de confiance
  return res.json({ ok: true, fiche: saved });
});

module.exports = router;
