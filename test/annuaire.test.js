// test/annuaire.test.js — `npm test`. Annuaire : filtres validés côté serveur,
// pagination, référentiel, ancien format conservé, erreurs jamais brutes,
// fichier des fiches valide.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const SECRET_TEXT = 'DETAIL-INTERNE-SUPABASE';
const calls = [];
let fail = false;
let supa;
let server;
let api;

const ROW = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'bge',
  nom: 'BGE',
  type: 'accompagnement',
  organisme: 'Réseau BGE',
  description: 'Accompagnement.',
  public_cible: ['tous'],
  portee: 'national',
  region_code: null,
  departements: [],
  ville: null,
  etapes: [],
  url: 'https://www.bge.asso.fr',
  source_url: null,
  verifie_le: null,
  date_limite: null,
  gratuit: true,
  total: 3,
  ...over,
});

test.before(async () => {
  supa = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const url = new URL(req.url, 'http://x');
    calls.push({ path: url.pathname, query: url.search, body });
    const json = (status, b) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (fail) return json(500, { code: 'XX000', message: SECRET_TEXT, details: SECRET_TEXT });
    if (url.pathname === '/rest/v1/rpc/annuaire_recherche') {
      const all = [ROW(), ROW({ id: '22222222-2222-4222-8222-222222222222', slug: 'ronalpia', nom: 'Ronalpia', portee: 'regional', region_code: '84' }), ROW({ id: '33333333-3333-4333-8333-333333333333', slug: 'adie', nom: 'Adie' })];
      return json(200, all.slice(body.p_offset, body.p_offset + body.p_limit));
    }
    if (url.pathname === '/rest/v1/rpc/annuaire_filtres') return json(200, { total: 3, portee: { national: 2, regional: 1 }, regions: { 84: 1 } });
    if (url.pathname === '/rest/v1/dispositifs') return json(200, url.searchParams.get('id') === 'eq.11111111-1111-4111-8111-111111111111' ? [ROW()] : []);
    return json(404, {});
  });
  await new Promise((r) => supa.listen(0, r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${supa.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
  delete process.env.ALLOWED_ORIGINS;
  const { app } = require('../server.js');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  api = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  supa.close();
});

const get = async (p) => {
  const r = await fetch(api + p);
  return { status: r.status, body: await r.json(), headers: r.headers };
};

test('recherche : filtres transmis à la base, page et total', async () => {
  calls.length = 0;
  const r = await get('/api/annuaire/recherche?portee=region&region=84&type=incubateur&public=etudiant&etape=idee&q=%20lyon%20&limit=2&offset=0');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(calls[0].body, { p_portee: 'region', p_region: '84', p_type: 'incubateur', p_public: 'etudiant', p_etape: 'idee', p_q: 'lyon', p_limit: 2, p_offset: 0 });
  assert.strictEqual(r.body.total, 3);
  assert.strictEqual(r.body.items.length, 2);
  assert.strictEqual(r.body.items[1].region, 'Auvergne-Rhône-Alpes');
  assert.strictEqual(r.body.items[0].region, 'national');
  assert.ok(!('total' in r.body.items[0]));
});

test('recherche : par défaut « tous », 20 par page ; taille bornée à 50', async () => {
  calls.length = 0;
  await get('/api/annuaire/recherche');
  assert.strictEqual(calls[0].body.p_portee, 'tous');
  assert.strictEqual(calls[0].body.p_limit, 20);
  await get('/api/annuaire/recherche?limit=500&offset=-4');
  assert.strictEqual(calls[1].body.p_limit, 50);
  assert.strictEqual(calls[1].body.p_offset, 0);
});

test('recherche : valeur inconnue ou région manquante → 400, rien envoyé à la base', async () => {
  calls.length = 0;
  for (const q of ['portee=monde', 'region=99', 'type=loterie', 'public=martiens', 'etape=fin', 'portee=region']) {
    const r = await get(`/api/annuaire/recherche?${q}`);
    assert.strictEqual(r.status, 400, q);
    assert.strictEqual(r.body.code, 'filtre_invalide', q);
  }
  assert.strictEqual(calls.length, 0);
});

test('filtres : 18 régions, référentiels et compteurs', async () => {
  const r = await get('/api/annuaire/filtres');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.regions.length, 18);
  assert.ok(r.body.regions.some((x) => x.code === '11' && x.nom === 'Île-de-France'));
  assert.deepStrictEqual(r.body.compteurs.portee, { national: 2, regional: 1 });
  assert.ok(r.body.etapes.includes('idee') && r.body.publics.includes('femme'));
});

test('ancien format : tableau complet (app déjà en ligne), avec le nom de la région', async () => {
  const r = await get('/api/annuaire');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.strictEqual(r.body.length, 3);
  assert.ok(r.body.some((d) => d.region === 'Auvergne-Rhône-Alpes'));
});

test('fiche : identifiant valide → fiche ; autre → 404 sans appel à la base', async () => {
  const ok = await get('/api/annuaire/11111111-1111-4111-8111-111111111111');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.slug, 'bge');
  calls.length = 0;
  const bad = await get('/api/annuaire/..%2F..%2Fprofiles');
  assert.strictEqual(bad.status, 404);
  assert.strictEqual(calls.length, 0);
  const missing = await get('/api/annuaire/99999999-9999-4999-8999-999999999999');
  assert.strictEqual(missing.status, 404);
});

test('erreur de la base : message neutre, jamais le texte de Supabase', async () => {
  fail = true;
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    for (const p of ['/api/annuaire', '/api/annuaire/recherche', '/api/annuaire/filtres', '/api/annuaire/11111111-1111-4111-8111-111111111111']) {
      const r = await get(p);
      assert.strictEqual(r.status, 503, p);
      assert.strictEqual(r.body.code, 'annuaire_unavailable', p);
      assert.ok(!JSON.stringify(r.body).includes(SECRET_TEXT), p);
    }
  } finally {
    console.error = orig;
    fail = false;
  }
  assert.ok(logs.every((l) => !l.includes(SECRET_TEXT)));
});

test('fichier des fiches : valide, slugs uniques, fiches vérifiées sourcées', () => {
  const { validate } = require('../scripts/seed-annuaire.js');
  const raw = require('../data/dispositifs.seed.json');
  const { fiches, erreurs } = validate(raw);
  assert.deepStrictEqual(erreurs, []);
  assert.strictEqual(fiches.length, 29);
  assert.strictEqual(fiches.filter((f) => f.actif).length, 28);
  assert.strictEqual(fiches.filter((f) => f.portee === 'regional' && f.region_code === '84').length, 7);
  // Fiche générique remplacée par les fiches précises : gardée mais masquée.
  assert.strictEqual(fiches.find((f) => f.slug === 'france-travail-creation-d-entreprise').actif, false);
  // Apec : pas encore vérifiée humainement → absente.
  assert.ok(!fiches.some((f) => f.slug.startsWith('apec')));
  assert.strictEqual(fiches.find((f) => f.slug === 'france-active').url, 'https://www.franceactive.org');
  // Toute fiche vérifiée a une source officielle ; la gratuité n'est jamais supposée.
  const verifiees = fiches.filter((f) => f.verifie_le != null);
  assert.strictEqual(verifiees.length, 18);
  assert.ok(verifiees.every((f) => typeof f.source_url === 'string' && f.source_url.startsWith('https://')));
  assert.ok(verifiees.filter((f) => f.gratuit === null).length >= 15);
});

test('validation : une fiche incohérente bloque tout le chargement', () => {
  const { validate } = require('../scripts/seed-annuaire.js');
  const raw = JSON.parse(JSON.stringify(require('../data/dispositifs.seed.json')));
  raw[0].portee = 'regional';
  raw[1].etapes = ['inventee'];
  raw[2].slug = raw[3].slug;
  raw[4].url = 'javascript:alert(1)';
  const { erreurs } = validate(raw);
  assert.ok(erreurs.length >= 4, erreurs.join('\n'));
});
