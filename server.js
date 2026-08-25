// server.js — Backend Novigo minimal.
// Proxy voix : l'app envoie du texte, le serveur appelle ElevenLabs avec la clé
// SECRÈTE (jamais côté app) et renvoie l'audio. La clé ne quitte jamais ce serveur.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Coach Nova (programme Adultes) : POST /api/nova (stream) + /api/nova/memoire.
// Auth (token Supabase) + quota quotidien + appel Mistral, tout côté serveur.
app.use(require('./routes/nova'));

const PORT = process.env.PORT || 8787;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
// Voix par défaut : mets ici l'ID d'une voix jeune/ado française (ElevenLabs).
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID || '';
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

app.get('/health', (_req, res) => {
  res.json({ ok: true, ttsConfigured: Boolean(ELEVEN_KEY && DEFAULT_VOICE) });
});

// GET /tts?text=...&voice=...  -> renvoie un audio/mpeg
app.get('/tts', async (req, res) => {
  const text = (req.query.text || '').toString().slice(0, 800);
  const voiceId = (req.query.voice || DEFAULT_VOICE).toString();

  if (!ELEVEN_KEY || !voiceId) {
    return res.status(503).json({ error: 'Voix IA non configurée (clé ou voix manquante).' });
  }
  if (!text) {
    return res.status(400).json({ error: 'Paramètre "text" requis.' });
  }

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3 },
      }),
    });

    if (!r.ok) {
      const msg = await r.text().catch(() => '');
      return res.status(r.status).json({ error: 'ElevenLabs: ' + r.status, detail: msg.slice(0, 300) });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400'); // cache 24 h (économise des appels)
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: 'Erreur serveur voix', detail: String(e).slice(0, 200) });
  }
});

// 0.0.0.0 = toutes les interfaces réseau (localhost + IP LAN), pour que le
// téléphone (Expo Go) sur le même Wi-Fi puisse joindre le backend.
app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Novigo backend sur http://localhost:${PORT} (LAN: http://0.0.0.0:${PORT})  (TTS ${ELEVEN_KEY && DEFAULT_VOICE ? 'prêt' : 'NON configuré'})`);
});
