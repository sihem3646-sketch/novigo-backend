// test/verifyToken.test.js — `npm test` (testeur intégré de Node, sans dépendance).
// Vérification des jetons de session : seule une signature valide du projet, pour
// un compte connecté, avec le bon émetteur, la bonne audience et non expirée, passe.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const ACCOUNT = '11111111-2222-4333-8444-555555555555';
const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const otherKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' };

let server;
let base;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_URL = base;
  delete process.env.SUPABASE_JWT_SECRET;
});

test.after(() => server.close());

function sign(claims, { key = keys.privateKey, kid = 'k1', alg = 'ES256' } = {}) {
  const payload = { role: 'authenticated', aud: 'authenticated', iss: `${base}/auth/v1`, sub: ACCOUNT, ...claims };
  if (payload.exp == null) payload.exp = Math.floor(Date.now() / 1000) + 3600;
  return jwt.sign(payload, key, { algorithm: alg, ...(kid != null ? { keyid: kid } : {}) });
}

const { verifySupabaseToken, resetJwksCache } = require('../auth/verifyToken');

test('jeton de session valide (ES256) → compte du jeton', async () => {
  resetJwksCache();
  assert.deepStrictEqual(await verifySupabaseToken(sign({})), { accountId: ACCOUNT, passwordAuthAt: null });
});

test('signature d’une autre clé → refusé', async () => {
  await assert.rejects(verifySupabaseToken(sign({}, { key: otherKeys.privateKey })));
});

test('clé inconnue (kid) → refusé', async () => {
  await assert.rejects(verifySupabaseToken(sign({}, { kid: 'inconnue' })));
});

test('jeton expiré → refusé', async () => {
  await assert.rejects(verifySupabaseToken(sign({ exp: Math.floor(Date.now() / 1000) - 3600 })));
});

test('clé publique de l’app (rôle anon) → refusé', async () => {
  await assert.rejects(verifySupabaseToken(sign({ role: 'anon', sub: undefined })));
});

test('mauvais émetteur ou mauvaise audience → refusé', async () => {
  await assert.rejects(verifySupabaseToken(sign({ iss: 'https://autre-projet.supabase.co/auth/v1' })));
  await assert.rejects(verifySupabaseToken(sign({ aud: 'autre' })));
});

test('« sub » qui n’est pas un identifiant de compte → refusé', async () => {
  await assert.rejects(verifySupabaseToken(sign({ sub: 'device:1234' })));
});

test('jeton non signé (alg none) ou illisible → refusé', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: ACCOUNT, role: 'authenticated', aud: 'authenticated' })).toString('base64url');
  await assert.rejects(verifySupabaseToken(`${header}.${body}.`));
  await assert.rejects(verifySupabaseToken('pas-un-jeton'));
});

test('ancien secret partagé (HS256) : refusé sans secret configuré, accepté avec', async () => {
  const token = sign({}, { key: 'secret-de-test', alg: 'HS256', kid: undefined });
  await assert.rejects(verifySupabaseToken(token));
  process.env.SUPABASE_JWT_SECRET = 'secret-de-test';
  try {
    assert.deepStrictEqual(await verifySupabaseToken(token), { accountId: ACCOUNT, passwordAuthAt: null });
    await assert.rejects(verifySupabaseToken(sign({}, { key: 'mauvais-secret', alg: 'HS256', kid: undefined })));
  } finally {
    delete process.env.SUPABASE_JWT_SECRET;
  }
});
