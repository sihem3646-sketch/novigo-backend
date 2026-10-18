// test/pass.test.js — `npm test`.
// Achat d'un Pass : prix imposés par le serveur, consentement, places Fondateur,
// vérification au retour, webhook signé. Stripe et Supabase sont simulés ; la
// signature des notifications est calculée par la vraie bibliothèque Stripe.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const Stripe = require('stripe');

const { createPassRouter, createStripeWebhook, safeReturnUrl } = require('../routes/pass');
const { paymentsMode } = require('../pass/stripeClient');
const { openProducts, founderCap } = require('../pass/catalog');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const WHSEC = 'whsec_test_secret_novigo';
const ORIGIN = 'https://novigo.expo.app';
const realStripe = new (Stripe.default || Stripe)('sk_test_fake');

function fakeSb(responses = {}) {
  const calls = [];
  return {
    calls,
    configured: () => true,
    rpc: async (name, args) => {
      calls.push({ name, args });
      const r = responses[name];
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(args) : r;
    },
  };
}

function fakeStripe({ createError, sessions = {} } = {}) {
  const created = [];
  return {
    created,
    checkout: {
      sessions: {
        create: async (params, opts) => {
          if (createError) throw createError;
          created.push({ params, opts });
          return { id: 'cs_test_a1b2c3d4e5f6g7h8', url: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4e5f6g7h8' };
        },
        retrieve: async (id) => {
          if (sessions[id] == null) throw new Error('No such session');
          return sessions[id];
        },
      },
    },
    webhooks: realStripe.webhooks,
  };
}

const verify = async (token) => {
  if (token === 'tok-A') return { accountId: A, email: 'a@exemple.fr' };
  if (token === 'tok-B') return { accountId: B, email: null };
  throw new Error('bad');
};

async function withServer({ sb, stripe, env = {} }, fn) {
  const getStripe = () => stripe;
  const fullEnv = { ALLOWED_ORIGINS: '', PASS_PRODUCTS: 'novigo', STRIPE_WEBHOOK_SECRET: WHSEC, ...env };
  const pass = createPassRouter({ verify, sb, getStripe, env: fullEnv });
  const app = express();
  app.use(createStripeWebhook({ sb, getStripe, env: fullEnv, handlers: pass }));
  app.use(express.json());
  app.use(pass.router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const post = (base, path, body, token) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

const checkoutBody = (extra = {}) => ({
  product: 'novigo',
  founder: false,
  retractation: true,
  successUrl: `${ORIGIN}/pass-merci`,
  cancelUrl: `${ORIGIN}/pricing?annule=1`,
  ...extra,
});

test('offres : seul le Pass Novigo est en vente par défaut, avec ses places Fondateur', async () => {
  const sb = fakeSb({ pass_founder_left: 37 });
  await withServer({ sb, stripe: fakeStripe() }, async (base) => {
    const r = await fetch(`${base}/api/pass/offres`);
    const j = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(j.paymentsOpen, true);
    assert.deepStrictEqual(j.offres.map((o) => o.product), ['novigo']);
    assert.strictEqual(j.offres[0].price, 11900);
    assert.deepStrictEqual(j.offres[0].founder, { price: 4999, cap: 100, left: 37 });
  });
});

test('offres : paiement fermé sans Stripe, et base injoignable = places inconnues', async () => {
  const sb = fakeSb({ pass_founder_left: new Error('down') });
  await withServer({ sb, stripe: null }, async (base) => {
    const j = await (await fetch(`${base}/api/pass/offres`)).json();
    assert.strictEqual(j.paymentsOpen, false);
    assert.strictEqual(j.offres[0].founder.left, null);
  });
});

test('checkout : compte, consentement, adresse de retour et produit sont exigés', async () => {
  const sb = fakeSb();
  const stripe = fakeStripe();
  await withServer({ sb, stripe }, async (base) => {
    assert.strictEqual((await post(base, '/api/pass/checkout', checkoutBody())).status, 401);
    assert.strictEqual((await post(base, '/api/pass/checkout', checkoutBody(), 'tok-faux')).status, 401);
    let r = await post(base, '/api/pass/checkout', checkoutBody({ retractation: false }), 'tok-A');
    assert.strictEqual((await r.json()).code, 'consent_required');
    r = await post(base, '/api/pass/checkout', checkoutBody({ successUrl: 'https://pirate.example/merci' }), 'tok-A');
    assert.strictEqual((await r.json()).code, 'return_url_invalid');
    r = await post(base, '/api/pass/checkout', checkoutBody({ cancelUrl: 'javascript:alert(1)' }), 'tok-A');
    assert.strictEqual((await r.json()).code, 'return_url_invalid');
    r = await post(base, '/api/pass/checkout', checkoutBody({ product: 'kids' }), 'tok-A');
    assert.strictEqual((await r.json()).code, 'product_closed');
    assert.strictEqual(stripe.created.length, 0);
  });
});

test('checkout : le prix vient du serveur (119 €), pas de la requête', async () => {
  const sb = fakeSb();
  const stripe = fakeStripe();
  await withServer({ sb, stripe }, async (base) => {
    const r = await post(base, '/api/pass/checkout', checkoutBody({ price: 1, amount: 1, unit_amount: 1 }), 'tok-A');
    const j = await r.json();
    assert.strictEqual(r.status, 200);
    assert.match(j.url, /^https:\/\/checkout\.stripe\.com\//);
    const { params } = stripe.created[0];
    assert.strictEqual(params.line_items[0].price_data.unit_amount, 11900);
    assert.strictEqual(params.line_items[0].price_data.currency, 'eur');
    assert.strictEqual(params.mode, 'payment');
    assert.strictEqual(params.customer_email, 'a@exemple.fr');
    assert.strictEqual(params.metadata.account_id, A);
    assert.strictEqual(params.metadata.founder, '0');
    assert.ok(!Number.isNaN(Date.parse(params.metadata.retractation_waived_at)));
    assert.strictEqual(params.success_url, `${ORIGIN}/pass-merci?session_id={CHECKOUT_SESSION_ID}`);
    assert.ok(params.invoice_creation.enabled);
    assert.match(params.invoice_creation.invoice_data.footer, /293 B/);
    assert.strictEqual(sb.calls.length, 0, 'aucune réservation sans prix Fondateur');
  });
});

test('checkout Fondateur : place réservée, 49,99 €, puis complet', async () => {
  let free = 1;
  const sb = fakeSb({ pass_founder_reserve: () => free-- > 0 });
  const stripe = fakeStripe();
  await withServer({ sb, stripe }, async (base) => {
    let r = await post(base, '/api/pass/checkout', checkoutBody({ founder: true }), 'tok-A');
    assert.strictEqual(r.status, 200);
    const { params, opts } = stripe.created[0];
    assert.strictEqual(params.line_items[0].price_data.unit_amount, 4999);
    assert.match(params.line_items[0].price_data.product_data.name, /Fondateur/);
    assert.strictEqual(params.metadata.founder, '1');
    const reserve = sb.calls.find((c) => c.name === 'pass_founder_reserve');
    assert.strictEqual(reserve.args.p_account, A);
    assert.strictEqual(reserve.args.p_cap, 100);
    assert.strictEqual(params.metadata.reservation_id, reserve.args.p_reservation);
    assert.ok(opts.idempotencyKey.includes(reserve.args.p_reservation));
    r = await post(base, '/api/pass/checkout', checkoutBody({ founder: true }), 'tok-B');
    assert.strictEqual(r.status, 409);
    assert.strictEqual((await r.json()).code, 'founder_full');
  });
});

test('checkout : si Stripe échoue, la place Fondateur est libérée', async () => {
  const sb = fakeSb({ pass_founder_reserve: true });
  const stripe = fakeStripe({ createError: new Error('stripe down') });
  await withServer({ sb, stripe }, async (base) => {
    const r = await post(base, '/api/pass/checkout', checkoutBody({ founder: true }), 'tok-A');
    assert.strictEqual(r.status, 502);
    const reserved = sb.calls.find((c) => c.name === 'pass_founder_reserve').args.p_reservation;
    const released = sb.calls.find((c) => c.name === 'pass_founder_release');
    assert.strictEqual(released.args.p_reservation, reserved);
  });
});

test('checkout : paiement fermé tant que Stripe n’est pas configuré', async () => {
  await withServer({ sb: fakeSb(), stripe: null }, async (base) => {
    const r = await post(base, '/api/pass/checkout', checkoutBody(), 'tok-A');
    assert.strictEqual(r.status, 503);
    assert.strictEqual((await r.json()).code, 'payments_closed');
  });
});

const paidSession = (over = {}) => ({
  id: 'cs_test_a1b2c3d4e5f6g7h8',
  object: 'checkout.session',
  mode: 'payment',
  payment_status: 'paid',
  status: 'complete',
  amount_total: 4999,
  currency: 'eur',
  livemode: false,
  payment_intent: 'pi_123',
  metadata: {
    account_id: A, product: 'novigo', founder: '1',
    reservation_id: '33333333-3333-4333-8333-333333333333', months: '12',
    retractation_waived_at: '2026-10-18T10:00:00.000Z',
  },
  ...over,
});

test('retour du paiement : seul le compte acheteur peut activer son Pass', async () => {
  const sb = fakeSb({ pass_record_paid: 'pass-id' });
  const stripe = fakeStripe({ sessions: { cs_test_a1b2c3d4e5f6g7h8: paidSession() } });
  await withServer({ sb, stripe }, async (base) => {
    let r = await fetch(`${base}/api/pass/session/cs_test_a1b2c3d4e5f6g7h8`, { headers: { Authorization: 'Bearer tok-B' } });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(sb.calls.length, 0);
    r = await fetch(`${base}/api/pass/session/pas-une-session`, { headers: { Authorization: 'Bearer tok-A' } });
    assert.strictEqual(r.status, 400);
    r = await fetch(`${base}/api/pass/session/cs_test_a1b2c3d4e5f6g7h8`, { headers: { Authorization: 'Bearer tok-A' } });
    assert.deepStrictEqual(await r.json(), { status: 'paid', product: 'novigo' });
    const rec = sb.calls.find((c) => c.name === 'pass_record_paid').args;
    assert.strictEqual(rec.p_account, A);
    assert.strictEqual(rec.p_amount, 4999);
    assert.strictEqual(rec.p_founder, true);
    assert.strictEqual(rec.p_payment_intent, 'pi_123');
    assert.strictEqual(rec.p_months, 12);
    assert.strictEqual(rec.p_waived_at, '2026-10-18T10:00:00.000Z');
  });
});

test('retour du paiement : non payé = en attente, rien d’enregistré', async () => {
  const sb = fakeSb();
  const stripe = fakeStripe({ sessions: { cs_test_a1b2c3d4e5f6g7h8: paidSession({ payment_status: 'unpaid', status: 'open' }) } });
  await withServer({ sb, stripe }, async (base) => {
    const r = await fetch(`${base}/api/pass/session/cs_test_a1b2c3d4e5f6g7h8`, { headers: { Authorization: 'Bearer tok-A' } });
    assert.deepStrictEqual(await r.json(), { status: 'pending' });
    assert.strictEqual(sb.calls.length, 0);
  });
});

function signed(event) {
  const payload = JSON.stringify(event);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  return { payload, header };
}

const hook = (base, event, header) => {
  const s = signed(event);
  return fetch(`${base}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header ?? s.header },
    body: s.payload,
  });
};

test('webhook : signature fausse refusée, rien d’enregistré', async () => {
  const sb = fakeSb();
  await withServer({ sb, stripe: fakeStripe() }, async (base) => {
    const r = await hook(base, { type: 'checkout.session.completed', data: { object: paidSession() } }, 't=1,v1=faux');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(sb.calls.length, 0);
  });
});

test('webhook : paiement réussi = Pass enregistré ; expiré = place libérée ; remboursé = Pass coupé', async () => {
  const sb = fakeSb({ pass_record_paid: 'pass-id', pass_founder_release: null, pass_mark_refunded: 1 });
  await withServer({ sb, stripe: fakeStripe() }, async (base) => {
    let r = await hook(base, { id: 'evt_1', type: 'checkout.session.completed', data: { object: paidSession() } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(sb.calls.at(-1).name, 'pass_record_paid');
    r = await hook(base, { id: 'evt_2', type: 'checkout.session.expired', data: { object: paidSession({ payment_status: 'unpaid', status: 'expired' }) } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(sb.calls.at(-1), { name: 'pass_founder_release', args: { p_reservation: '33333333-3333-4333-8333-333333333333' } });
    r = await hook(base, { id: 'evt_3', type: 'charge.refunded', data: { object: { object: 'charge', refunded: true, payment_intent: 'pi_123' } } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(sb.calls.at(-1), { name: 'pass_mark_refunded', args: { p_payment_intent: 'pi_123' } });
    const before = sb.calls.length;
    r = await hook(base, { id: 'evt_4', type: 'charge.refunded', data: { object: { object: 'charge', refunded: false, payment_intent: 'pi_123' } } });
    assert.strictEqual(sb.calls.length, before, 'remboursement partiel : le Pass reste');
  });
});

test('webhook : session étrangère ou non payée ignorée ; base en panne = 500 (Stripe réessaiera)', async () => {
  const sb = fakeSb({ pass_record_paid: new Error('db down') });
  await withServer({ sb, stripe: fakeStripe() }, async (base) => {
    let r = await hook(base, { type: 'checkout.session.completed', data: { object: paidSession({ metadata: { product: 'novigo' } }) } });
    assert.strictEqual(r.status, 200);
    r = await hook(base, { type: 'checkout.session.completed', data: { object: paidSession({ payment_status: 'unpaid' }) } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(sb.calls.length, 0);
    r = await hook(base, { type: 'checkout.session.completed', data: { object: paidSession() } });
    assert.strictEqual(r.status, 500);
  });
});

test('réglages : clé de production refusée sans PAYMENTS_LIVE=1, catalogue et adresses', () => {
  assert.strictEqual(paymentsMode({ STRIPE_SECRET_KEY: 'sk_test_abc' }), 'test');
  assert.strictEqual(paymentsMode({ STRIPE_SECRET_KEY: 'sk_live_abc' }), null);
  assert.strictEqual(paymentsMode({ STRIPE_SECRET_KEY: 'sk_live_abc', PAYMENTS_LIVE: '1' }), 'live');
  assert.strictEqual(paymentsMode({}), null);
  assert.deepStrictEqual(openProducts({}), ['novigo']);
  assert.deepStrictEqual(openProducts({ PASS_PRODUCTS: 'novigo, ado,inconnu' }), ['novigo', 'ado']);
  assert.strictEqual(founderCap('kids', {}), 0);
  assert.strictEqual(founderCap('novigo', { PASS_FOUNDER_CAP_NOVIGO: '20' }), 20);
  assert.ok(safeReturnUrl('https://mynovigo.fr/app/pass-merci', {}));
  assert.strictEqual(safeReturnUrl('https://mynovigo.fr.pirate.example/x', {}), null);
  assert.ok(safeReturnUrl('http://localhost:8081/pass-merci', { ALLOWED_ORIGINS: 'http://localhost:8081' }));
});
