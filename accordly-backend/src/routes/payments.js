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


/**
 * payments.routes.js
 * --------------------------------------------------------
 * Routes for the child_support_payments table.
 *
 * HOW TO WIRE THIS IN (2 things to check/adjust):
 *
 * 1. DB CONNECTION — this file assumes you have a Postgres pool
 *    exported from somewhere like `../db` or `../config/db`, e.g.:
 *        module.exports = new Pool({ connectionString: process.env.DATABASE_URL })
 *    Update the require path on the next non-comment line if yours
 *    lives somewhere else.
 *
 * 2. AUTH MIDDLEWARE — this assumes you already have a JWT-verifying
 *    middleware that sets `req.user = { id: ... }` after checking the
 *    Authorization: Bearer <token> header (your login route already
 *    issues that token). Update the require path below to match
 *    wherever that middleware lives in your project.
 *
 * 3. RELATIONSHIP LOOKUP — child_support_payments rows are scoped by
 *    `relationship_id`, which points at your `coparent_relationships`
 *    table. I don't have that table's column names, so getRelationshipId()
 *    below is a best guess (parent_a_id / parent_b_id). Paste that
 *    table's columns and I'll correct this in one line if it's wrong.
 * --------------------------------------------------------
 */

const express = require('express');
const router = express.Router();

const db = require('../db');                    // <-- adjust path if needed
const authenticateToken = require('../middleware/auth'); // <-- adjust path if needed

// Look up the coparent_relationships row this user belongs to.
// ASSUMPTION: columns parent_a_id / parent_b_id link two users together.
async function getRelationshipId(userId) {
  const result = await db.query(
    `SELECT id FROM coparent_relationships
     WHERE parent_a_id = $1 OR parent_b_id = $1
     LIMIT 1`,
    [userId]
  );
  return result.rows[0]?.id || null;
}

function deriveStatus(row) {
  const ordered = Number(row.amount_ordered || 0);
  const paid = Number(row.amount_paid || 0);
  if (paid >= ordered && ordered > 0) return 'paid';
  if (paid > 0) return 'partial';
  if (row.due_date && new Date(row.due_date) < new Date()) return 'overdue';
  return 'pending';
}

// GET /api/v1/payments — list all payments for the logged-in user's relationship
router.get('/', authenticateToken, async (req, res) => {
  try {
    const relationshipId = await getRelationshipId(req.user.id);
    if (!relationshipId) {
      return res.json({ payments: [] }); // no linked co-parent yet
    }

    const result = await db.query(
      `SELECT id, relationship_id, ordered_by_id, amount_ordered, amount_paid,
              due_date, paid_date, status, payment_method, notes,
              created_at, updated_at
       FROM child_support_payments
       WHERE relationship_id = $1
       ORDER BY due_date DESC`,
      [relationshipId]
    );

    res.json({ payments: result.rows });
  } catch (err) {
    console.error('GET /api/v1/payments error:', err);
    res.status(500).json({ error: 'Could not load payments.' });
  }
});

// POST /api/v1/payments — create a new payment record
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { amount_ordered, due_date, payment_method, notes } = req.body;

    if (!amount_ordered || !due_date) {
      return res.status(400).json({ error: 'amount_ordered and due_date are required.' });
    }

    const relationshipId = await getRelationshipId(req.user.id);
    if (!relationshipId) {
      return res.status(400).json({ error: 'No linked co-parent relationship found for this account.' });
    }

    const result = await db.query(
      `INSERT INTO child_support_payments
         (relationship_id, ordered_by_id, amount_ordered, amount_paid, due_date, status, payment_method, notes, created_at, updated_at)
       VALUES ($1, $2, $3, 0, $4, 'pending', $5, $6, NOW(), NOW())
       RETURNING *`,
      [relationshipId, req.user.id, amount_ordered, due_date, payment_method || null, notes || null]
    );

    res.status(201).json({ payment: result.rows[0] });
  } catch (err) {
    console.error('POST /api/v1/payments error:', err);
    res.status(500).json({ error: 'Could not create payment.' });
  }
});

// PATCH /api/v1/payments/:id — record a payment (amount_paid / paid_date) or edit fields
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount_paid, paid_date, amount_ordered, due_date, payment_method, notes } = req.body;

    // Fetch existing row first (also confirms it belongs to this user's relationship)
    const relationshipId = await getRelationshipId(req.user.id);
    const existing = await db.query(
      `SELECT * FROM child_support_payments WHERE id = $1 AND relationship_id = $2`,
      [id, relationshipId]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Payment not found.' });
    }

    const merged = {
      ...existing.rows[0],
      ...(amount_paid !== undefined && { amount_paid }),
      ...(paid_date !== undefined && { paid_date }),
      ...(amount_ordered !== undefined && { amount_ordered }),
      ...(due_date !== undefined && { due_date }),
      ...(payment_method !== undefined && { payment_method }),
      ...(notes !== undefined && { notes }),
    };
    merged.status = deriveStatus(merged);

    const result = await db.query(
      `UPDATE child_support_payments
       SET amount_paid = $1, paid_date = $2, amount_ordered = $3, due_date = $4,
           payment_method = $5, notes = $6, status = $7, updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [merged.amount_paid, merged.paid_date, merged.amount_ordered, merged.due_date,
       merged.payment_method, merged.notes, merged.status, id]
    );

    res.json({ payment: result.rows[0] });
  } catch (err) {
    console.error('PATCH /api/v1/payments/:id error:', err);
    res.status(500).json({ error: 'Could not update payment.' });
  }
});

// DELETE /api/v1/payments/:id
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const relationshipId = await getRelationshipId(req.user.id);

    await db.query(
      `DELETE FROM child_support_payments WHERE id = $1 AND relationship_id = $2`,
      [id, relationshipId]
    );

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/v1/payments/:id error:', err);
    res.status(500).json({ error: 'Could not delete payment.' });
  }
});

module.exports = router;

/**
 * MOUNT THIS in your main server file (e.g. index.js / app.js) with:
 *
 *   const paymentsRoutes = require('./routes/payments.routes');
 *   app.use('/api/v1/payments', paymentsRoutes);
 */

module.exports = router;
