// test/beta.test.js — `npm test`.
// Bêta en libre inscription (migration 0012) : POST /api/beta/activer n'active un
// accès que pour le compte du jeton, depuis le lien testeurs ; la base (simulée ici)
// décide du reste (adresse confirmée, une fois par adresse, places, ouverture).

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const verifyToken = require('../auth/verifyToken');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
verifyToken.verifySupabaseToken = async (token) => {
  if (token === 'tok-A') return { accountId: A };
  if (token === 'tok-B') return { accountId: B };
  throw new Error('bad');
};

const sb = require('../fiche/supabase');
const auth = require('../middleware/auth');
const beta = require('../routes/beta');

const LINK = 'https://novigo--testeurs.expo.app';
const calls = [];
let answer = [{ statut: 'nouveau', fin: '2026-12-03T10:00:00+00:00' }];
sb.configured = () => true;
sb.rpc = async (name, args) => {
  calls.push({ name, args });
  if (answer instanceof Error) throw answer;
  return answer;
};

const app = express();
app.use(express.json());
app.use(beta);
let base;
let server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function activer({ origin = LINK, token = 'tok-A', body = {} } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin != null) headers.origin = origin;
  if (token != null) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${base}/api/beta/activer`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test('depuis le lien testeurs : accès demandé pour le compte DU JETON', async () => {
  calls.length = 0;
  answer = [{ statut: 'nouveau', fin: '2026-12-03T10:00:00+00:00' }];
  // Un identifiant envoyé dans la requête est ignoré.
  const r = await activer({ body: { p_account: B, jours: 365 } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { statut: 'nouveau', fin: '2026-12-03T10:00:00+00:00' });
  assert.deepStrictEqual(calls, [{ name: 'beta_activer', args: { p_account: A } }]);
});

test('depuis le site public, un autre site, ou sans origine : refusé, sans appel à la base', async () => {
  calls.length = 0;
  for (const origin of ['https://novigo.expo.app', 'https://mynovigo.fr', 'https://novigo--testeurs.expo.app.pirate.fr', 'http://novigo--testeurs.expo.app', null]) {
    const r = await activer({ origin });
    assert.strictEqual(r.status, 403, String(origin));
    assert.strictEqual(r.body.code, 'origin');
  }
  assert.strictEqual(calls.length, 0);
});

test('sans jeton ou jeton faux : refusé', async () => {
  calls.length = 0;
  assert.strictEqual((await activer({ token: null })).status, 401);
  assert.strictEqual((await activer({ token: 'tok-faux' })).status, 401);
  assert.strictEqual(calls.length, 0);
});

test('les réponses de la base passent telles quelles (rien n\'est prolongé côté serveur)', async () => {
  for (const statut of ['actif', 'termine', 'complet', 'fermees', 'non_confirme', 'inconnu']) {
    answer = [{ statut, fin: statut === 'actif' || statut === 'termine' ? '2026-11-20T00:00:00+00:00' : null }];
    const r = await activer();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.statut, statut);
  }
});

test('base en panne, 0012 pas appliquée ou réponse inattendue : « réessaie », jamais d’accès', async () => {
  answer = Object.assign(new Error('Supabase 404'), { status: 404 });
  assert.strictEqual((await activer()).status, 503);
  answer = [{ statut: 'premium', fin: '2099-01-01T00:00:00Z' }];
  assert.strictEqual((await activer()).status, 503);
  answer = [];
  assert.strictEqual((await activer()).status, 503);
});

test('accès nouveau : Nova le voit tout de suite (formule « beta »)', async () => {
  sb.request = async (path) => (path.startsWith('learners?') ? [{ mode: 'adults' }] : []);
  // Avant : pas d'accès (gardé 1 minute).
  answer = null;
  sb.rpc = async (name) => (name === 'acces_testeur_du_compte' ? answer : [{ statut: 'nouveau', fin: '2026-12-03T10:00:00+00:00' }]);
  auth.forgetAccount(B);
  assert.strictEqual(await auth.hasTesterAccess(B), false);
  answer = new Date(Date.now() + 30 * 864e5).toISOString();
  assert.strictEqual((await activer({ token: 'tok-B' })).body.statut, 'nouveau');
  assert.strictEqual(await auth.hasTesterAccess(B), true);
});

test('trop de demandes pour un même compte : freinées', async () => {
  // Le compte A a déjà fait 10 demandes dans ces tests.
  const r = await activer();
  assert.strictEqual(r.status, 429);
});

test('origine du lien testeurs réglable (BETA_ORIGINS)', () => {
  assert.ok(beta.betaOrigins({}).has(LINK));
  const custom = beta.betaOrigins({ BETA_ORIGINS: 'http://localhost:8081/, https://autre.expo.app' });
  assert.ok(custom.has('http://localhost:8081') && custom.has('https://autre.expo.app') && !custom.has(LINK));
});
