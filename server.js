// server.js — Backend Novigo minimal.
// Proxy voix : l'app envoie du texte, le serveur appelle ElevenLabs avec la clé
// SECRÈTE (jamais côté app) et renvoie l'audio. La clé ne quitte jamais ce serveur.
// La voix est DÉSACTIVÉE par défaut (bêta adulte) : TTS_ENABLED=1 la réactive.

require('dotenv').config();
const express = require('express');

const { corsGuard } = require('./lib/cors');
const { logError, errorMeta } = require('./lib/log');

const app = express();
// Derrière le proxy de l'hébergeur : req.ip = adresse du client (X-Forwarded-For).
// TRUST_PROXY_HOPS = nombre de relais devant le serveur (ex. 1) : l'adresse est
// alors lue à la bonne position, sans faire confiance à ce que le client ajoute.
// Sans réglage : comportement historique (dernier relais de confiance = tous).
const hops = Number(process.env.TRUST_PROXY_HOPS);
app.set('trust proxy', Number.isInteger(hops) && hops >= 0 ? hops : true);
app.disable('x-powered-by');
// Origines de navigateur autorisées (liste stricte, voir lib/cors.js).
app.use(corsGuard());
app.use(express.json());

// Coach Nova (programme Adultes) : POST /api/nova (stream) + /api/nova/memoire + /api/nova/quota.
// Compte Supabase vérifié + mémoire par profil et quotas par compte (Supabase) + appel
// Mistral, tout côté serveur.
app.use(require('./routes/nova'));

// Annuaire des dispositifs d'accompagnement (lecture publique) :
// GET /api/annuaire (filtres) + GET /api/annuaire/:id. Lecture Supabase serveur.
app.use(require('./routes/annuaire'));

// Droits sur les données : supprimer son compte, exporter ses données Nova.
app.use(require('./routes/account'));

const PORT = process.env.PORT || 8787;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
// Voix par défaut : mets ici l'ID d'une voix jeune/ado française (ElevenLabs).
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID || '';
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
/** La voix IA ne sert qu'à l'espace Enfant, fermé pendant la bêta adulte : coupée par défaut. */
const TTS_ENABLED = process.env.TTS_ENABLED === '1';
// Identifiant de voix ElevenLabs : lettres et chiffres seulement. Il entre dans
// l'adresse appelée AVEC la clé secrète : sans ce contrôle, « ../ » ferait viser
// une autre route de l'API ElevenLabs. Seules les voix configurées sont acceptées.
const VOICE_ID = /^[A-Za-z0-9]{8,64}$/;
function allowedVoices() {
  const extra = (process.env.ELEVENLABS_VOICE_IDS || '').split(',').map((v) => v.trim()).filter(Boolean);
  return new Set([DEFAULT_VOICE, ...extra].filter((v) => VOICE_ID.test(v)));
}
/** La voix demandée si elle est autorisée ; la voix par défaut si rien n'est demandé ; sinon null. */
function resolveVoice(requested) {
  const allowed = allowedVoices();
  if (requested == null || requested === '') return allowed.has(DEFAULT_VOICE) ? DEFAULT_VOICE : null;
  const v = String(requested);
  return VOICE_ID.test(v) && allowed.has(v) ? v : null;
}

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
  res.json({ ok: true, ttsConfigured: Boolean(TTS_ENABLED && ELEVEN_KEY && DEFAULT_VOICE) });
});

// GET /tts?text=...&voice=...  -> renvoie un audio/mpeg (si TTS_ENABLED=1)
app.get('/tts', async (req, res) => {
  if (!TTS_ENABLED) {
    return res.status(404).json({ error: 'Voix IA désactivée.', code: 'tts_disabled' });
  }
  const text = (req.query.text || '').toString().slice(0, 800);
  const voiceId = resolveVoice(req.query.voice);

  if (!ELEVEN_KEY || !DEFAULT_VOICE) {
    return res.status(503).json({ error: 'Voix IA non configurée (clé ou voix manquante).' });
  }
  if (voiceId == null) {
    return res.status(400).json({ error: 'Voix inconnue.', code: 'voice_invalid' });
  }
  if (!text) {
    return res.status(400).json({ error: 'Paramètre "text" requis.' });
  }
  if (!reserveTts(req.ip || '', text.length)) {
    return res.status(429).json({ error: 'Voix IA indisponible pour aujourd’hui (plafond atteint).' });
  }

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
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
      // Ni le texte ni la réponse brute d'ElevenLabs ne sont renvoyés ou journalisés.
      logError('tts', 'upstream_error', { status: r.status });
      return res.status(502).json({ error: 'Voix IA indisponible.', code: 'tts_upstream' });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400'); // cache 24 h (économise des appels)
    return res.send(buf);
  } catch (e) {
    logError('tts', 'request_failed', errorMeta(e));
    return res.status(500).json({ error: 'Erreur serveur voix', code: 'tts_error' });
  }
});

// On NE force PAS d'hôte : Node écoute alors sur toutes les interfaces (IPv4 + IPv6),
// ce qui permet à la fois l'accès LAN (téléphone) ET la détection de port par
// l'hébergeur (Render scanne en IPv6 — forcer 0.0.0.0/IPv4 seul le rend aveugle).
if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Novigo backend sur le port ${PORT}  (TTS ${TTS_ENABLED && ELEVEN_KEY && DEFAULT_VOICE ? 'prêt' : 'désactivé'})`);
  });
}

// Tests : l'application sans démarrage du serveur.
module.exports = { app, resolveVoice };
