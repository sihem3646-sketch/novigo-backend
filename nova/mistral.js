// nova/mistral.js
// Client minimal de l'API Mistral (fetch natif). La clé MISTRAL_API_KEY reste
// côté serveur. max_tokens borné pour garder des réponses courtes et le coût bas.

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL = 'mistral-small-latest';

function apiKey() {
  return process.env.MISTRAL_API_KEY || '';
}

function isConfigured() {
  return apiKey().length > 0;
}

/**
 * Appel en streaming (SSE). Renvoie la Response fetch : le routeur relaie
 * response.body vers le client. Réponses courtes => max_tokens modéré.
 */
async function chatStream({ messages, maxTokens = 700, temperature = 0.4, signal }) {
  return fetch(MISTRAL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature,
    }),
    signal,
  });
}

/** Appel non-streaming. Renvoie le texte de la réponse (ou lève une erreur). */
async function chat({ messages, maxTokens = 1500, temperature = 0.2 }) {
  const r = await fetch(MISTRAL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      max_tokens: maxTokens,
      temperature,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Mistral ${r.status}: ${detail.slice(0, 300)}`);
  }
  const data = await r.json();
  return data && data.choices && data.choices[0] ? data.choices[0].message.content || '' : '';
}

module.exports = { chatStream, chat, isConfigured, MODEL };
