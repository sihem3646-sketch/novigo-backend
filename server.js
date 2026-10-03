// server.js — Backend Novigo minimal.
// Proxy voix : l'app envoie du texte, le serveur appelle ElevenLabs avec la clé
// SECRÈTE (jamais côté app) et renvoie l'audio. La clé ne quitte jamais ce serveur.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
// Derrière le proxy de l'hébergeur : req.ip = adresse du client (X-Forwarded-For).
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// Coach Nova (programme Adultes) : POST /api/nova (stream) + /api/nova/memoire + /api/nova/quota.
// Compte Supabase vérifié + mémoire par profil et quotas par compte (Supabase) + appel
// Mistral, tout côté serveur.
app.use(require('./routes/nova'));

// Annuaire des dispositifs d'accompagnement (lecture publique) :
// GET /api/annuaire (filtres) + GET /api/annuaire/:id. Lecture Supabase serveur.
app.use(require('./routes/annuaire'));

const PORT = process.env.PORT || 8787;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
// Voix par défaut : mets ici l'ID d'une voix jeune/ado française (ElevenLabs).
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID || '';
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

// Garde-fous de coût de la voix IA (route publique) : caractères par jour pour tout
// le service, et requêtes par jour par adresse IP. Compteurs en mémoire (remis à
// zéro au redémarrage) : l'abonnement ElevenLabs reste la limite ultime.
const TTS_DAILY_CHAR_LIMIT = Number(process.env.TTS_DAILY_CHAR_LIMIT) || 20000;
const TTS_IP_DAILY_LIMIT = Number(process.env.TTS_IP_DAILY_LIMIT) || 300;
let ttsDay = '';
let ttsChars = 0;
const ttsByIp = new Map();

/** Réserve le budget d'une lecture ; false si un plafond du jour est atteint. */
function reserveTts(ip, chars) {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== ttsDay) {
    ttsDay = d;
    ttsChars = 0;
    ttsByIp.clear();
  }
  const n = ttsByIp.get(ip) || 0;
  if (n >= TTS_IP_DAILY_LIMIT || ttsChars + chars > TTS_DAILY_CHAR_LIMIT) return false;
  ttsByIp.set(ip, n + 1);
  ttsChars += chars;
  return true;
}

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
  if (!reserveTts(req.ip || '', text.length)) {
    return res.status(429).json({ error: 'Voix IA indisponible pour aujourd’hui (plafond atteint).' });
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

// On NE force PAS d'hôte : Node écoute alors sur toutes les interfaces (IPv4 + IPv6),
// ce qui permet à la fois l'accès LAN (téléphone) ET la détection de port par
// l'hébergeur (Render scanne en IPv6 — forcer 0.0.0.0/IPv4 seul le rend aveugle).
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Novigo backend sur le port ${PORT}  (TTS ${ELEVEN_KEY && DEFAULT_VOICE ? 'prêt' : 'NON configuré'})`);
});
