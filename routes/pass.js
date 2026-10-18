// routes/pass.js
// Achat d'un Pass avec Stripe Checkout (page de paiement hébergée par Stripe :
// la carte bancaire ne passe jamais par Novigo).
//   GET  /api/pass/offres        -> Pass en vente, prix, places Fondateur restantes (public)
//   POST /api/pass/checkout      -> ouvre un paiement (compte connecté) ; renvoie l'adresse Stripe
//   GET  /api/pass/session/:id   -> au retour du paiement : vérifie chez Stripe et enregistre le Pass
//   POST /api/stripe/webhook     -> notifications signées de Stripe (paiement réussi, expiré, remboursé)
//
// Règles :
//  • Le prix vient du catalogue du serveur (pass/catalog.js), jamais de l'app.
//  • Un Pass n'est enregistré qu'à partir d'une session Stripe RELUE chez Stripe
//    (retour) ou d'une notification dont la signature est vérifiée (webhook) ; la
//    base refuse les doublons (même session = même Pass).
//  • Accès immédiat : l'acheteur doit cocher la renonciation au droit de
//    rétractation (contenu numérique, art. L221-28 13° du Code de la consommation) ;
//    sa date est gardée avec le Pass.
//  • Places Fondateur : réservées en base pendant le paiement, libérées s'il
//    n'aboutit pas.

const crypto = require('crypto');
const express = require('express');

const { verifySupabaseToken, UUID } = require('../auth/verifyToken');
const sbDefault = require('../fiche/supabase');
const { getStripe: getStripeDefault } = require('../pass/stripeClient');
const { CATALOG, PASS_MONTHS, openProducts, founderCap } = require('../pass/catalog');
const { allowedOrigins } = require('../lib/cors');
const { rateLimit } = require('../middleware/rateLimit');
const { logError, errorMeta } = require('../lib/log');

/** Durée d'un paiement Stripe (minimum imposé par Stripe : 30 min) et de la réservation Fondateur. */
const CHECKOUT_MINUTES = 31;
const RESERVATION_MINUTES = 35;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

/** Adresse de retour acceptée : http(s), sur une origine autorisée (jamais une adresse inventée). */
function safeReturnUrl(raw, env = process.env) {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const origin = `${url.protocol}//${url.host}`.toLowerCase();
  return allowedOrigins(env).includes(origin) ? url : null;
}

function createPassRouter({ verify = verifySupabaseToken, sb = sbDefault, getStripe = getStripeDefault, env = process.env } = {}) {
  const router = express.Router();

  router.use('/api/pass', rateLimit({ windowMs: 60_000, max: 30, key: (req) => req.ip || 'inconnue' }));

  async function accountAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Connecte-toi pour continuer.', code: 'auth_required' });
    try {
      const account = await verify(token);
      req.accountId = account.accountId;
      req.accountEmail = account.email || null;
    } catch {
      return res.status(401).json({ error: 'Ta session a expiré. Reconnecte-toi.', code: 'auth_invalid' });
    }
    return next();
  }

  /** Places Fondateur restantes (null si inconnues : base injoignable). */
  async function founderLeft(product) {
    const cap = founderCap(product, env);
    if (cap <= 0) return 0;
    try {
      const n = await sb.rpc('pass_founder_left', { p_product: product, p_cap: cap });
      return Number.isInteger(n) ? n : Number(n) || 0;
    } catch (e) {
      logError('pass', 'founder_left_failed', errorMeta(e));
      return null;
    }
  }

  /**
   * Enregistre le Pass d'une session Stripe PAYÉE (relue chez Stripe ou reçue signée).
   * Renvoie l'identifiant du Pass, ou null si la session n'est pas un achat Novigo payé.
   */
  async function recordFromSession(session) {
    if (session == null || session.mode !== 'payment' || session.payment_status !== 'paid') return null;
    const meta = session.metadata || {};
    const accountId = String(meta.account_id || '').toLowerCase();
    const product = String(meta.product || '');
    if (!UUID.test(accountId) || CATALOG[product] == null) return null;
    const reservation = UUID.test(String(meta.reservation_id || '')) ? String(meta.reservation_id) : null;
    const months = Number(meta.months) || PASS_MONTHS;
    const waivedAt = typeof meta.retractation_waived_at === 'string' && !Number.isNaN(Date.parse(meta.retractation_waived_at))
      ? meta.retractation_waived_at
      : null;
    const paymentIntent = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent && typeof session.payment_intent.id === 'string' ? session.payment_intent.id : null;
    return sb.rpc('pass_record_paid', {
      p_session: session.id,
      p_payment_intent: paymentIntent,
      p_account: accountId,
      p_product: product,
      p_founder: meta.founder === '1',
      p_amount: Number(session.amount_total) || 0,
      p_currency: String(session.currency || 'eur'),
      p_livemode: Boolean(session.livemode),
      p_reservation: reservation,
      p_months: months,
      p_waived_at: waivedAt,
    });
  }

  async function releaseReservation(session) {
    const reservation = session && session.metadata ? String(session.metadata.reservation_id || '') : '';
    if (UUID.test(reservation)) await sb.rpc('pass_founder_release', { p_reservation: reservation });
  }

  // ------------------------------------------------------------------------
  // GET /api/pass/offres
  // ------------------------------------------------------------------------
  router.get('/api/pass/offres', async (_req, res) => {
    const products = openProducts(env);
    const offres = await Promise.all(products.map(async (product) => {
      const item = CATALOG[product];
      const cap = founderCap(product, env);
      const left = cap > 0 ? await founderLeft(product) : 0;
      return {
        product,
        name: item.name,
        description: item.description,
        price: item.price,
        months: PASS_MONTHS,
        founder: cap > 0 && item.founderPrice != null ? { price: item.founderPrice, cap, left } : null,
      };
    }));
    res.set('Cache-Control', 'no-store');
    return res.json({ paymentsOpen: getStripe() != null, offres });
  });

  // ------------------------------------------------------------------------
  // POST /api/pass/checkout  — { product, founder, retractation: true, successUrl, cancelUrl }
  // ------------------------------------------------------------------------
  router.post('/api/pass/checkout', accountAuth, async (req, res) => {
    const stripe = getStripe();
    if (stripe == null) {
      return res.status(503).json({ error: 'Le paiement n’est pas encore ouvert.', code: 'payments_closed' });
    }
    if (!sb.configured()) {
      return res.status(503).json({ error: 'Service momentanément indisponible.', code: 'not_configured' });
    }
    const body = req.body || {};
    const product = String(body.product || '');
    if (!openProducts(env).includes(product)) {
      return res.status(400).json({ error: 'Ce Pass n’est pas en vente.', code: 'product_closed' });
    }
    if (body.retractation !== true) {
      return res.status(400).json({
        error: 'Coche la case : tu demandes l’accès immédiat et tu renonces au délai de rétractation.',
        code: 'consent_required',
      });
    }
    const success = safeReturnUrl(body.successUrl, env);
    const cancel = safeReturnUrl(body.cancelUrl, env);
    if (success == null || cancel == null) {
      return res.status(400).json({ error: 'Adresse de retour refusée.', code: 'return_url_invalid' });
    }

    const item = CATALOG[product];
    const wantsFounder = body.founder === true && item.founderPrice != null && founderCap(product, env) > 0;
    let reservation = null;
    if (wantsFounder) {
      reservation = crypto.randomUUID();
      let reserved;
      try {
        reserved = await sb.rpc('pass_founder_reserve', {
          p_reservation: reservation,
          p_product: product,
          p_account: req.accountId,
          p_cap: founderCap(product, env),
          p_minutes: RESERVATION_MINUTES,
        });
      } catch (e) {
        logError('pass', 'founder_reserve_failed', errorMeta(e));
        return res.status(503).json({ error: 'Service momentanément indisponible.', retry: true });
      }
      if (reserved !== true) {
        return res.status(409).json({ error: 'Les places au prix Fondateur sont toutes prises.', code: 'founder_full' });
      }
    }

    const amount = wantsFounder ? item.founderPrice : item.price;
    const waivedAt = new Date().toISOString();
    // {CHECKOUT_SESSION_ID} est remplacé par Stripe au retour.
    success.searchParams.set('session_id', '__SESSION__');
    const successUrl = success.toString().replace('__SESSION__', '{CHECKOUT_SESSION_ID}');
    const metadata = {
      account_id: req.accountId,
      product,
      founder: wantsFounder ? '1' : '0',
      reservation_id: reservation || '',
      months: String(PASS_MONTHS),
      retractation_waived_at: waivedAt,
    };

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        locale: 'fr',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: amount,
            product_data: {
              name: wantsFounder ? `${item.name} · Prix Fondateur` : item.name,
              description: item.description,
            },
          },
        }],
        ...(req.accountEmail ? { customer_email: req.accountEmail } : {}),
        client_reference_id: req.accountId,
        metadata,
        payment_intent_data: { metadata },
        success_url: successUrl,
        cancel_url: cancel.toString(),
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60,
        ...(env.STRIPE_INVOICES === '0' ? {} : {
          invoice_creation: {
            enabled: true,
            invoice_data: { footer: 'TVA non applicable, article 293 B du Code général des impôts.' },
          },
        }),
        custom_text: {
          submit: { message: 'Accès immédiat : tu as demandé à commencer tout de suite et renoncé au délai de rétractation de 14 jours.' },
        },
      }, { idempotencyKey: `novigo-${reservation || crypto.randomUUID()}` });
      return res.json({ url: session.url });
    } catch (e) {
      logError('pass', 'checkout_failed', errorMeta(e));
      if (reservation != null) {
        await sb.rpc('pass_founder_release', { p_reservation: reservation }).catch(() => {});
      }
      return res.status(502).json({ error: 'Le paiement n’a pas pu s’ouvrir. Réessaie dans un instant.', code: 'checkout_failed' });
    }
  });

  // ------------------------------------------------------------------------
  // GET /api/pass/session/:id  — retour de Stripe : vérifie et enregistre
  // ------------------------------------------------------------------------
  router.get('/api/pass/session/:id', accountAuth, async (req, res) => {
    const stripe = getStripe();
    if (stripe == null) return res.status(503).json({ error: 'Le paiement n’est pas encore ouvert.', code: 'payments_closed' });
    const id = String(req.params.id || '');
    if (!SESSION_ID.test(id)) return res.status(400).json({ error: 'Paiement introuvable.', code: 'session_invalid' });
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(id);
    } catch (e) {
      logError('pass', 'session_retrieve_failed', errorMeta(e));
      return res.status(404).json({ error: 'Paiement introuvable.', code: 'session_not_found' });
    }
    // Uniquement SES paiements : la session doit appartenir au compte connecté.
    if (!session || !session.metadata || String(session.metadata.account_id || '').toLowerCase() !== req.accountId) {
      return res.status(404).json({ error: 'Paiement introuvable.', code: 'session_not_found' });
    }
    if (session.payment_status !== 'paid') {
      return res.json({ status: session.status === 'expired' ? 'expired' : 'pending' });
    }
    try {
      await recordFromSession(session);
    } catch (e) {
      logError('pass', 'record_failed', errorMeta(e));
      return res.status(503).json({ error: 'Paiement reçu : ton Pass s’active dans un instant.', code: 'record_delayed', retry: true });
    }
    return res.json({ status: 'paid', product: session.metadata.product });
  });

  return { router, recordFromSession, releaseReservation };
}

// --------------------------------------------------------------------------
// Webhook Stripe : monté AVANT express.json() (la signature porte sur le corps brut).
// --------------------------------------------------------------------------
function createStripeWebhook({ sb = sbDefault, getStripe = getStripeDefault, env = process.env, handlers } = {}) {
  const router = express.Router();
  const { recordFromSession, releaseReservation } = handlers || createPassRouter({ sb, getStripe, env });

  router.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '512kb' }), async (req, res) => {
    const stripe = getStripe();
    const secret = env.STRIPE_WEBHOOK_SECRET || '';
    if (stripe == null || !secret) return res.status(503).json({ error: 'Paiements non configurés.' });
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] || '', secret);
    } catch {
      return res.status(400).json({ error: 'Signature invalide.' });
    }
    try {
      const obj = event.data && event.data.object;
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          await recordFromSession(obj);
          break;
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed':
          await releaseReservation(obj);
          break;
        case 'charge.refunded':
          // Remboursement TOTAL seulement : le Pass n'ouvre plus rien.
          if (obj && obj.refunded === true && typeof obj.payment_intent === 'string') {
            await sb.rpc('pass_mark_refunded', { p_payment_intent: obj.payment_intent });
          }
          break;
        default:
          break;
      }
    } catch (e) {
      // 500 : Stripe renverra la notification plus tard.
      logError('pass', 'webhook_failed', { type: event.type, ...errorMeta(e) });
      return res.status(500).json({ error: 'Réessaie plus tard.' });
    }
    return res.json({ received: true });
  });

  return router;
}

module.exports = { createPassRouter, createStripeWebhook, safeReturnUrl };
