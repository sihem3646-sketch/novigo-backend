// test/security.test.js — `npm test`. Corrections de sécurité avant lancement :
//  • CORS : liste stricte d'origines (sans joker), requêtes sans Origin acceptées ;
//  • /tts désactivé par défaut ;
//  • journaux sans contenu (fiche, messages, réponse de l'IA, erreur brute) ;
//  • Nova réservée aux profils Adultes pendant la bêta ;
//  • suppression du compte : identité du jeton, « SUPPRIMER », mot de passe récent ;
//  • export Nova : uniquement les données du compte du jeton.
// Un faux Supabase (JWKS, REST, Auth admin) et un faux Mistral tournent en local.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const LA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const LB = 'bbbbbbbb-0000-4000-8000-00000000000b';
const TEEN = 'cccccccc-0000-4000-8000-00000000000c';
const SECRET_TEXT = 'CONTENU-PERSONNEL-NE-DOIT-PAS-FUIR';
const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' };

// État du faux Supabase.
const db = {
  learners: [
    { id: LA, account_id: A, mode: 'adults' },
    { id: TEEN, account_id: A, mode: 'teens' },
    { id: LB, account_id: B, mode: 'adults' },
  ],
  memory: [
    { learner_id: LA, fiche: { profil: { prenom: 'Alice' } }, updated_at: '2026-10-01T00:00:00Z' },
    { learner_id: LB, fiche: { profil: { prenom: 'Bob' } }, updated_at: '2026-10-01T00:00:00Z' },
  ],
  usage: [
    { account_id: A, day: '2026-10-01', chat: 2, memory: 1 },
    { account_id: B, day: '2026-10-01', chat: 9, memory: 9 },
  ],
  profiles: [{ id: 'p-a', user_id: A }, { id: 'p-b', user_id: B }],
  deleted: [],
  adminFail: false,
  keepLeftovers: false,
};

function param(url, name) {
  const v = url.searchParams.get(name);
  if (v == null) return null;
  const m = /^eq\.(.*)$/.exec(v);
  return m ? decodeURIComponent(m[1]) : null;
}

let supa;
let mistral;
let base;
let app;
let server;
let api;
const logs = [];
const origError = console.error;

test.before(async () => {
  supa = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/auth/v1/.well-known/jwks.json') return json(200, { keys: [jwk] });
    const admin = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(url.pathname);
    if (admin && req.method === 'DELETE') {
      if (db.adminFail) return json(500, { error_code: 'unexpected_failure', msg: `Database error: ${SECRET_TEXT}` });
      const id = decodeURIComponent(admin[1]);
      db.deleted.push(id);
      if (!db.keepLeftovers) {
        const gone = new Set(db.learners.filter((l) => l.account_id === id).map((l) => l.id));
        db.learners = db.learners.filter((l) => l.account_id !== id);
        db.memory = db.memory.filter((m) => !gone.has(m.learner_id));
        db.usage = db.usage.filter((u) => u.account_id !== id);
        db.profiles = db.profiles.filter((p) => p.user_id !== id);
      }
      return json(200, {});
    }
    if (url.pathname === '/rest/v1/learners') {
      const id = param(url, 'id');
      const acc = param(url, 'account_id');
      return json(200, db.learners.filter((l) => (id == null || l.id === id) && (acc == null || l.account_id === acc)));
    }
    if (url.pathname === '/rest/v1/profiles') return json(200, db.profiles.filter((p) => p.user_id === param(url, 'user_id')));
    if (url.pathname === '/rest/v1/nova_usage_account') return json(200, db.usage.filter((u) => u.account_id === param(url, 'account_id')));
    if (url.pathname === '/rest/v1/nova_memory') {
      const ids = (url.searchParams.get('learner_id') || '').replace(/^in\.\(|\)$/g, '').split(',');
      // Faux PostgREST volontairement trop généreux : renvoie aussi la fiche d'un autre
      // profil, pour prouver que la route refiltre (défense en profondeur).
      return json(200, db.memory.filter((m) => ids.includes(m.learner_id) || m.learner_id === LB));
    }
    if (url.pathname === '/rest/v1/rpc/nova_consume') return json(200, [{ allowed: true, reason: null, used_today: 1, used_month: 1, day: '2026-10-01' }]);
    if (url.pathname === '/rest/v1/rpc/nova_refund') return json(200, null);
    if (url.pathname === '/rest/v1/rpc/nova_memory_load') return json(200, { profil: { prenom: SECRET_TEXT } });
    if (url.pathname === '/rest/v1/rpc/nova_memory_save') {
      // Comme Postgres : le message d'erreur recopie la ligne refusée.
      return json(400, { code: '23514', message: 'violates check constraint', details: `Failing row contains (${SECRET_TEXT})` });
    }
    return json(404, {});
  });
  mistral = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.stream) {
      // Erreur qui recopie la demande (dont la fiche) : ne doit jamais être journalisée.
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `bad request: ${SECRET_TEXT}` }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message: { content: `pas du json ${SECRET_TEXT}` } }] }));
  });
  await new Promise((r) => supa.listen(0, r));
  await new Promise((r) => mistral.listen(0, r));
  base = `http://127.0.0.1:${supa.address().port}`;
  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
  process.env.MISTRAL_API_KEY = 'mistral-test';
  process.env.MISTRAL_API_URL = `http://127.0.0.1:${mistral.address().port}/v1/chat/completions`;
  delete process.env.ALLOWED_ORIGINS;
  delete process.env.TTS_ENABLED;
  delete process.env.BETA_ADULTS_ONLY;
  ({ app } = require('../server.js'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  api = `http://127.0.0.1:${server.address().port}`;
  console.error = (...args) => logs.push(args.map(String).join(' '));
});

test.after(() => {
  console.error = origError;
  server.close();
  supa.close();
  mistral.close();
});

function token(sub, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { role: 'authenticated', aud: 'authenticated', iss: `${base}/auth/v1`, sub, exp: now + 3600, iat: now, ...claims },
    keys.privateKey,
    { algorithm: 'ES256', keyid: 'k1' },
  );
}
const fresh = (sub) => token(sub, { amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 10 }] });

// ── CORS ──────────────────────────────────────────────────────────────────────
test('CORS : origines de production acceptées, en-tête renvoyé', async () => {
  for (const origin of ['https://novigo.expo.app', 'https://mynovigo.fr', 'https://www.mynovigo.fr']) {
    const r = await fetch(`${api}/health`, { headers: { Origin: origin } });
    assert.strictEqual(r.status, 200, origin);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), origin);
  }
});

test('CORS : origine inconnue, aperçu Expo ou sous-domaine piège → 403, sans en-tête', async () => {
  for (const origin of ['https://evil.example', 'https://novigo--abc123.expo.app', 'https://mynovigo.fr.evil.example', 'http://mynovigo.fr', 'null']) {
    const r = await fetch(`${api}/api/annuaire`, { headers: { Origin: origin } });
    assert.strictEqual(r.status, 403, origin);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null, origin);
  }
});

test('CORS : requête sans Origin (app mobile native, contrôle de santé) → acceptée', async () => {
  const r = await fetch(`${api}/health`);
  assert.strictEqual(r.status, 200);
});

test('CORS : pré-vol d’une origine autorisée → 204 avec les en-têtes Nova', async () => {
  const r = await fetch(`${api}/api/nova`, { method: 'OPTIONS', headers: { Origin: 'https://novigo.expo.app', 'Access-Control-Request-Method': 'POST' } });
  assert.strictEqual(r.status, 204);
  assert.match(r.headers.get('access-control-allow-headers'), /X-Novigo-Profile/);
});

test('CORS : liste configurable, joker et adresses invalides ignorés', () => {
  const { allowedOrigins } = require('../lib/cors');
  assert.deepStrictEqual(allowedOrigins({ ALLOWED_ORIGINS: 'https://novigo.expo.app, https://novigo--abc.expo.app/ ,https://*.expo.app,*,javascript:alert(1)' }), [
    'https://novigo.expo.app',
    'https://novigo--abc.expo.app',
  ]);
});

// ── TTS ───────────────────────────────────────────────────────────────────────
test('/tts désactivé par défaut → 404, aucun appel externe', async () => {
  const r = await fetch(`${api}/tts?text=bonjour&voice=../../v1/user`);
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await r.json()).code, 'tts_disabled');
  const h = await (await fetch(`${api}/health`)).json();
  assert.strictEqual(h.ttsConfigured, false);
});

// ── Journaux sans contenu ─────────────────────────────────────────────────────
test('journaux : erreur Supabase « Failing row contains » → seulement statut et code', async () => {
  logs.length = 0;
  const r = await fetch(`${api}/api/nova/memoire`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token(A)}`, 'X-Novigo-Profile': LA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: SECRET_TEXT }] }),
  });
  // Le faux Mistral répond un texte non JSON : fiche conservée, sans fuite.
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).reason, 'json');
  assert.ok(logs.some((l) => l.includes('json_invalid')), logs.join('\n'));
  assert.ok(logs.every((l) => !l.includes(SECRET_TEXT)), logs.join('\n'));
});

test('journaux : erreur de l’IA en streaming → statut seulement, jamais le corps', async () => {
  logs.length = 0;
  const r = await fetch(`${api}/api/nova`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token(A)}`, 'X-Novigo-Profile': LA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: SECRET_TEXT }] }),
  });
  assert.strictEqual(r.status, 503);
  assert.ok(logs.some((l) => l.includes('llm_error') && l.includes('status=500')), logs.join('\n'));
  assert.ok(logs.every((l) => !l.includes(SECRET_TEXT)), logs.join('\n'));
});

test('journaux : enregistrement refusé par la base → code 23514, sans la ligne', async () => {
  logs.length = 0;
  const { saveFiche } = require('../fiche/ficheStore');
  const { logError, errorMeta } = require('../lib/log');
  try {
    await saveFiche(A, LA, { profil: { prenom: SECRET_TEXT } });
    assert.fail('devait échouer');
  } catch (e) {
    assert.ok(!String(e.message).includes(SECRET_TEXT));
    logError('nova', 'storage_memory_save', errorMeta(e));
  }
  assert.ok(logs.some((l) => l.includes('code=23514') && l.includes('status=400')), logs.join('\n'));
  assert.ok(logs.every((l) => !l.includes(SECRET_TEXT)));
});

test('journaux : métadonnées non sûres filtrées', () => {
  const { safeMeta } = require('../lib/log');
  assert.deepStrictEqual(safeMeta({ status: 500, code: 'Failing row contains (x)', fiche: 'x', count: 3 }), { status: '500', count: '3' });
});

// ── Bêta adultes ──────────────────────────────────────────────────────────────
test('bêta : Nova refusée à un profil Ado (403 beta_adults_only)', async () => {
  const r = await fetch(`${api}/api/nova/quota`, { headers: { Authorization: `Bearer ${token(A)}`, 'X-Novigo-Profile': TEEN } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await r.json()).code, 'beta_adults_only');
});

// ── Export Nova ───────────────────────────────────────────────────────────────
test('export Nova : sans jeton → 401', async () => {
  assert.strictEqual((await fetch(`${api}/api/account/export-nova`)).status, 401);
});

test('export Nova : seulement les données du compte du jeton (A ne voit jamais B)', async () => {
  const r = await fetch(`${api}/api/account/export-nova`, { headers: { Authorization: `Bearer ${token(A)}` } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  const body = await r.json();
  const text = JSON.stringify(body);
  assert.deepStrictEqual(body.novaMemory.map((m) => m.learnerId), [LA]);
  assert.deepStrictEqual(body.novaUsage, [{ day: '2026-10-01', messages: 2, memoryUpdates: 1 }]);
  assert.ok(!text.includes('Bob') && !text.includes(LB) && !text.includes(B));
  assert.ok(!/service-test|mistral-test|eyJ/.test(text), 'aucun secret ni jeton');
});

// ── Suppression du compte ─────────────────────────────────────────────────────
async function del(tok, body = { confirm: 'SUPPRIMER' }) {
  const r = await fetch(`${api}/api/account/delete`, {
    method: 'POST',
    headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test('suppression : sans jeton → 401 ; jeton falsifié → 401', async () => {
  assert.strictEqual((await del(null)).status, 401);
  const forged = jwt.sign({ role: 'authenticated', aud: 'authenticated', sub: A }, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, { algorithm: 'ES256', keyid: 'k1' });
  assert.strictEqual((await del(forged)).status, 401);
  assert.deepStrictEqual(db.deleted, []);
});

test('suppression : sans « SUPPRIMER » → 400', async () => {
  for (const body of [{}, { confirm: 'supprimer' }, { confirm: 'OUI' }]) assert.strictEqual((await del(fresh(A), body)).body.code, 'confirm_required');
  assert.deepStrictEqual(db.deleted, []);
});

test('suppression : sans connexion récente par mot de passe → 403 reauth_required', async () => {
  const old = token(A, { amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 3600 }] });
  const link = token(A, { amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }] });
  for (const t of [token(A), old, link]) assert.strictEqual((await del(t)).body.code, 'reauth_required');
  assert.deepStrictEqual(db.deleted, []);
});

test('suppression : un identifiant dans le corps est ignoré (compte du jeton seulement)', async () => {
  db.adminFail = true;
  const r = await del(fresh(A), { confirm: 'SUPPRIMER', accountId: B, user_id: B, sub: B });
  db.adminFail = false;
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body.deleted, false);
  assert.deepStrictEqual(db.deleted, []);
});

test('suppression : échec Supabase → 502 « rien n’a été supprimé », journal sans contenu', async () => {
  logs.length = 0;
  db.adminFail = true;
  const r = await del(fresh(A));
  db.adminFail = false;
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body.code, 'delete_failed');
  assert.ok(logs.some((l) => l.includes('delete_failed') && l.includes('status=500')));
  assert.ok(logs.every((l) => !l.includes(SECRET_TEXT)));
});

test('suppression : données restantes après coup → 500 delete_partial', async () => {
  db.keepLeftovers = true;
  const r = await del(fresh(B));
  db.keepLeftovers = false;
  db.deleted.length = 0;
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.body.code, 'delete_partial');
});

test('suppression : succès → compte A supprimé et vérifié ; B intact', async () => {
  const r = await del(fresh(A));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true, deleted: true, verified: true });
  assert.deepStrictEqual(db.deleted, [A]);
  assert.ok(db.learners.every((l) => l.account_id === B));
  assert.ok(db.usage.every((u) => u.account_id === B));
  // Après suppression, Nova refuse les profils de A (cache des profils oublié).
  const n = await fetch(`${api}/api/nova/quota`, { headers: { Authorization: `Bearer ${token(A)}`, 'X-Novigo-Profile': LA } });
  assert.strictEqual(n.status, 403);
});
