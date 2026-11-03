// test/nova-testeur.test.js — `npm test`.
// Accès testeur par email (migration 0011) : un compte autorisé, accès en cours,
// parle à Nova en formule « beta » (50 messages par jour, 500 par mois, comptés par
// le serveur) ; accès terminé, adresse absente ou fonction pas encore créée :
// formule gratuite. Supabase simulé.

const test = require('node:test');
const assert = require('node:assert');

const verifyToken = require('../auth/verifyToken');
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PROFILE = '7b1e2c3d-4f50-4a6b-8c9d-0e1f2a3b4c5d';
verifyToken.verifySupabaseToken = async (token) => {
  if (token === 'tok-A') return { accountId: ACCOUNT };
  throw new Error('bad');
};

const sb = require('../fiche/supabase');
const { novaAuth, hasTesterAccess, forgetAccount } = require('../middleware/auth');
const { allowedOrigins } = require('../lib/cors');
const { planLimits, quotaView, limitMessage } = require('../nova/plans');

const calls = [];
function fakeDb({ tester = null }) {
  calls.length = 0;
  sb.configured = () => true;
  sb.request = async (path) => {
    calls.push(path);
    if (path.startsWith('learners?')) return [{ mode: 'adults' }];
    return [];
  };
  sb.rpc = async (name, args) => {
    calls.push(`rpc:${name}:${JSON.stringify(args)}`);
    if (name !== 'acces_testeur_du_compte') return null;
    if (tester instanceof Error) throw tester;
    return tester;
  };
}

async function planOf(token, headers = {}) {
  const req = { headers: { authorization: `Bearer ${token}`, 'x-novigo-profile': PROFILE, ...headers } };
  let status = 200;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  let passed = false;
  await novaAuth(req, res, () => { passed = true; });
  return passed ? req.plan : `refusé ${status}`;
}

const inDays = (d) => new Date(Date.now() + d * 24 * 3600 * 1000).toISOString();

test('testeur autorisé (accès en cours) : formule « beta », vérifiée pour CE compte', async () => {
  fakeDb({ tester: inDays(20) });
  forgetAccount(ACCOUNT);
  assert.strictEqual(await planOf('tok-A'), 'beta');
  assert.ok(calls.includes(`rpc:acces_testeur_du_compte:${JSON.stringify({ p_account: ACCOUNT })}`));
});

test('formule « beta » : 50 messages par jour, 500 par mois, contrôlés par le serveur', () => {
  const chat = planLimits('beta', 'chat');
  assert.strictEqual(chat.daily, 50);
  assert.strictEqual(chat.monthly, 500);
  assert.ok(chat.global > 0);
  // Compteur visible dans l'app, comme la formule gratuite.
  const view = quotaView('beta', { usedToday: 50, usedMonth: 120, day: '2026-11-20' });
  assert.strictEqual(view.unlimited, false);
  assert.strictEqual(view.remaining, 0);
  assert.strictEqual(view.reason, 'daily');
  assert.match(limitMessage('beta', 'daily'), /50 messages Nova d’aujourd’hui/);
  assert.match(limitMessage('beta', 'monthly', '2026-11-20'), /500 messages Nova de ce mois-ci\. Ils reviennent le 1er décembre/);
});

test('adresse absente de la liste ou accès terminé : formule gratuite', async () => {
  fakeDb({ tester: null });
  forgetAccount(ACCOUNT);
  assert.strictEqual(await planOf('tok-A'), 'free');
  // Date passée renvoyée par erreur : refusée côté serveur aussi.
  fakeDb({ tester: inDays(-1) });
  forgetAccount(ACCOUNT);
  assert.strictEqual(await planOf('tok-A'), 'free');
});

test('0011 pas appliquée (404) ou base en panne : formule gratuite, sans blocage', async () => {
  fakeDb({ tester: Object.assign(new Error('Supabase 404'), { status: 404 }) });
  forgetAccount(ACCOUNT);
  assert.strictEqual(await planOf('tok-A'), 'free');
  fakeDb({ tester: Object.assign(new Error('Supabase 500'), { status: 500 }) });
  forgetAccount(ACCOUNT);
  assert.strictEqual(await planOf('tok-A'), 'free');
});

test('accès testeur gardé 1 minute, oublié avec le compte', async () => {
  fakeDb({ tester: inDays(5) });
  forgetAccount(ACCOUNT);
  assert.strictEqual(await hasTesterAccess(ACCOUNT), true);
  const before = calls.length;
  assert.strictEqual(await hasTesterAccess(ACCOUNT), true);
  assert.strictEqual(calls.length, before);
  forgetAccount(ACCOUNT);
  fakeDb({ tester: null });
  assert.strictEqual(await hasTesterAccess(ACCOUNT), false);
});

test('sans jeton : refusé, même autorisé', async () => {
  fakeDb({ tester: inDays(5) });
  assert.strictEqual(await planOf('tok-faux'), 'refusé 401');
});

test('CORS : le lien testeurs est autorisé par défaut, pas les autres aperçus Expo', () => {
  const list = allowedOrigins({});
  assert.ok(list.includes('https://novigo--testeurs.expo.app'));
  assert.ok(!list.includes('https://novigo--abc123.expo.app'));
});
