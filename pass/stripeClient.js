// pass/stripeClient.js
// Client Stripe du serveur. La clé SECRÈTE ne quitte jamais ce serveur.
//   STRIPE_SECRET_KEY      clé secrète (sk_test_… pendant les essais)
//   STRIPE_WEBHOOK_SECRET  secret de signature des notifications (whsec_…)
//   PAYMENTS_LIVE=1        OBLIGATOIRE pour accepter une clé de production
//                          (sk_live_ / rk_live_) : sans lui, elle est refusée,
//                          pour qu'aucun vrai paiement ne parte par erreur.

const Stripe = require('stripe');

let client = null;
let override = null;

/** Mode de paiement configuré : 'test', 'live', ou null (rien de configuré / clé refusée). */
function paymentsMode(env = process.env) {
  const key = env.STRIPE_SECRET_KEY || '';
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  if (/^(sk|rk)_live_/.test(key)) return env.PAYMENTS_LIVE === '1' ? 'live' : null;
  return null;
}

/** Le client Stripe, ou null si les paiements ne sont pas configurés. */
function getStripe() {
  if (override != null) return override;
  if (paymentsMode() == null) return null;
  if (client == null) {
    const StripeCtor = Stripe.default || Stripe;
    client = new StripeCtor(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20000 });
  }
  return client;
}

/** Tests : remplace le client Stripe (null = revenir au vrai). */
function setStripeForTests(fake) {
  override = fake;
}

module.exports = { getStripe, paymentsMode, setStripeForTests };
