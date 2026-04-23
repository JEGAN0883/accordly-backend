const express = require('express');
const Stripe = require('stripe');
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const { logger } = require('../utils/logger');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

// Plan to Stripe price ID mapping
const PLAN_PRICES = {
  essential_monthly: process.env.STRIPE_PRICE_ESSENTIAL_MONTHLY,
  essential_annual:  process.env.STRIPE_PRICE_ESSENTIAL_ANNUAL,
  safe_monthly:      process.env.STRIPE_PRICE_SAFE_MONTHLY,
  safe_annual:       process.env.STRIPE_PRICE_SAFE_ANNUAL,
  pro_monthly:       process.env.STRIPE_PRICE_PRO_MONTHLY,
  pro_annual:        process.env.STRIPE_PRICE_PRO_ANNUAL,
  attorney_pro:      process.env.STRIPE_PRICE_ATTORNEY,
  mediator:          process.env.STRIPE_PRICE_MEDIATOR,
};

// Plan name from price ID
const PRICE_TO_PLAN = Object.fromEntries(
  Object.entries(PLAN_PRICES).map(([k, v]) => [v, k.split('_')[0]])
);

// ── CREATE CHECKOUT SESSION ──
router.post('/create-checkout', authenticate, async (req, res, next) => {
  try {
    const { plan, billing = 'monthly', success_url, cancel_url } = req.body;
    
    // DV waiver holders don't pay
    if (req.user.dv_waiver) {
      return res.status(400).json({ error: 'Your account has a fee waiver — no payment required.' });
    }

    const priceKey = billing === 'annual' ? `${plan}_annual` : `${plan}_monthly`;
    const priceId = PLAN_PRICES[priceKey] || PLAN_PRICES[plan];
    
    if (!priceId) return res.status(400).json({ error: 'Invalid plan' });

    // Get or create Stripe customer
    let stripeCustomerId = req.user.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { accordly_user_id: req.user.id },
      });
      stripeCustomerId = customer.id;
      await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [stripeCustomerId, req.user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: success_url || `${process.env.APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancel_url || `${process.env.APP_URL}/pricing`,
      metadata: {
        accordly_user_id: req.user.id,
        plan: plan,
      },
      subscription_data: {
        metadata: { accordly_user_id: req.user.id, plan },
      },
    });

    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    next(err);
  }
});

// ── GET SUBSCRIPTION STATUS ──
router.get('/subscription', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT plan, plan_status, stripe_customer_id, stripe_subscription_id, dv_waiver
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    
    const user = result.rows[0];
    let subscriptionDetails = null;

    if (user.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
        subscriptionDetails = {
          status: sub.status,
          current_period_end: new Date(sub.current_period_end * 1000),
          cancel_at_period_end: sub.cancel_at_period_end,
        };
      } catch (stripeErr) {
        logger.warn(`Could not retrieve Stripe subscription: ${stripeErr.message}`);
      }
    }

    res.json({
      plan: user.plan,
      plan_status: user.plan_status,
      dv_waiver: user.dv_waiver,
      subscription: subscriptionDetails,
    });
  } catch (err) {
    next(err);
  }
});

// ── CANCEL SUBSCRIPTION ──
router.post('/cancel', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'SELECT stripe_subscription_id FROM users WHERE id = $1',
      [req.user.id]
    );
    
    const { stripe_subscription_id } = result.rows[0];
    if (!stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription' });
    }

    await stripe.subscriptions.update(stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    res.json({ success: true, message: 'Subscription will cancel at end of billing period.' });
  } catch (err) {
    next(err);
  }
});

// ── STRIPE WEBHOOK HANDLER ──
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.accordly_user_id;
        const plan = session.metadata?.plan;
        if (userId && plan) {
          await query(
            `UPDATE users SET plan = $1, plan_status = 'active', 
             stripe_subscription_id = $2 WHERE id = $3`,
            [plan, session.subscription, userId]
          );
          logger.info(`Subscription activated: user ${userId} → ${plan}`);
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        await query(
          `UPDATE users SET plan_status = 'active' 
           WHERE stripe_subscription_id = $1`,
          [invoice.subscription]
        );
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await query(
          `UPDATE users SET plan_status = 'past_due' 
           WHERE stripe_subscription_id = $1`,
          [invoice.subscription]
        );
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await query(
          `UPDATE users SET plan = 'free', plan_status = 'cancelled', 
           stripe_subscription_id = NULL 
           WHERE stripe_subscription_id = $1 AND dv_waiver = FALSE`,
          [sub.id]
        );
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error(`Webhook processing error for ${event.type}:`, err.message);
    res.json({ received: true }); // Always 200 to prevent Stripe retries
  }
});

module.exports = router;
