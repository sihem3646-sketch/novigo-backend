// test/tts.test.js — `npm test`. Voix IA RÉACTIVÉE (TTS_ENABLED=1) : le paramètre
// `voice` ne peut jamais modifier l'adresse appelée avec la clé ElevenLabs.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const VOICE = 'EXAVITQu4vr4xnSDxMaL';
const calls = [];
let server;
let api;
const realFetch = globalThis.fetch;

test.before(async () => {
  process.env.TTS_ENABLED = '1';
  process.env.ELEVENLABS_API_KEY = 'eleven-test';
  process.env.ELEVENLABS_VOICE_ID = VOICE;
  delete process.env.ELEVENLABS_VOICE_IDS;
  // Faux ElevenLabs : on enregistre l'adresse appelée.
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.elevenlabs.io/')) {
      calls.push(String(url));
      return new Response(Buffer.from('ID3'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    }
    return realFetch(url, init);
  };
  const { app } = require('../server.js');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  api = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  globalThis.fetch = realFetch;
  server.close();
});

test('voix par défaut → appel à la seule route text-to-speech de cette voix', async () => {
  const r = await realFetch(`${api}/tts?text=bonjour`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(calls, [`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}`]);
});

test('voice piégée (../, encodée, inconnue) → 400, aucun appel externe', async () => {
  calls.length = 0;
  for (const v of ['../../v1/user', '..%2F..%2Fv1%2Fvoices', `${VOICE}/../../voices`, 'abc', 'AAAAAAAAAAAAAAAAAAAA', `${VOICE}?x=1`]) {
    const r = await realFetch(`${api}/tts?text=bonjour&voice=${encodeURIComponent(v)}`);
    assert.strictEqual(r.status, 400, v);
    assert.strictEqual((await r.json()).code, 'voice_invalid', v);
  }
  assert.deepStrictEqual(calls, []);
});

test('resolveVoice : seules les voix configurées passent', () => {
  const { resolveVoice } = require('../server.js');
  assert.strictEqual(resolveVoice(undefined), VOICE);
  assert.strictEqual(resolveVoice(VOICE), VOICE);
  assert.strictEqual(resolveVoice('../x'), null);
  assert.strictEqual(resolveVoice('ZZZZZZZZZZZZZZZZZZZZ'), null);
});
