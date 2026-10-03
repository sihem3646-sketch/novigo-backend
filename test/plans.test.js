// test/plans.test.js — `npm test`.
// Quotas de Nova par formule : 20 par mois et 5 par jour au plus en gratuit,
// messages clairs, rien de révélé pour un code testeur.

const test = require('node:test');
const assert = require('node:assert');

const { planLimits, limitMessage, quotaView } = require('../nova/plans');
const { rateLimit } = require('../middleware/rateLimit');

test('formule gratuite par défaut : 20 messages par mois, 5 par jour', () => {
  const chat = planLimits('free', 'chat');
  assert.strictEqual(chat.monthly, 20);
  assert.strictEqual(chat.daily, 5);
  assert.ok(chat.global > 0);
  assert.strictEqual(planLimits('free', 'memory').monthly, null);
});

test('plafonds réglables (premium prêt, plus haut que gratuit)', () => {
  process.env.NOVA_PREMIUM_MONTHLY_LIMIT = '300';
  try {
    assert.strictEqual(planLimits('premium', 'chat').monthly, 300);
    assert.ok(planLimits('premium', 'chat').daily > planLimits('free', 'chat').daily);
  } finally {
    delete process.env.NOVA_PREMIUM_MONTHLY_LIMIT;
  }
});

test('formule inconnue → formule gratuite (jamais plus)', () => {
  assert.deepStrictEqual(planLimits('inconnue', 'chat'), planLimits('free', 'chat'));
});

test('restant = le plus serré du jour et du mois', () => {
  const v = quotaView('free', { usedToday: 2, usedMonth: 18, day: '2026-10-03' });
  assert.strictEqual(v.daily.remaining, 3);
  assert.strictEqual(v.monthly.remaining, 2);
  assert.strictEqual(v.remaining, 2);
  assert.strictEqual(v.reason, null);
});

test('plafonds atteints : raison et message clairs', () => {
  const day = quotaView('free', { usedToday: 5, usedMonth: 9, day: '2026-10-03' });
  assert.strictEqual(day.reason, 'daily');
  assert.match(day.message, /5 messages Nova d’aujourd’hui/);
  const month = quotaView('free', { usedToday: 1, usedMonth: 20, day: '2026-10-03' });
  assert.strictEqual(month.reason, 'monthly');
  assert.match(month.message, /20 messages Nova de ce mois-ci\. Ils reviennent le 1er novembre/);
  assert.match(limitMessage('free', 'monthly', '2026-12-31'), /1er janvier/);
  assert.match(limitMessage('free', 'global', '2026-10-03'), /très demandée/);
});

test('code testeur : aucun compteur révélé', () => {
  const v = quotaView('tester', { usedToday: 42, usedMonth: 300, day: '2026-10-03' });
  assert.deepStrictEqual([v.unlimited, v.limit, v.remaining, v.daily, v.monthly], [true, null, null, null, null]);
});

test('limiteur de rafales : au-delà du maximum → 429', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 2, key: () => 'k' });
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const res = { set() {}, status(code) { statuses.push(code); return { json() {} }; } };
    mw({}, res, () => statuses.push(200));
  }
  assert.deepStrictEqual(statuses, [200, 200, 429]);
});
