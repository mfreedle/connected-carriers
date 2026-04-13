import { Router, Request, Response } from "express";
import Stripe from "stripe";
import { query } from "../db";

const router = Router();

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

// ── POST /api/webhooks/stripe ──────────────────────────────────
router.post("/api/webhooks/stripe", async (req: Request, res: Response) => {
  if (!stripe) return res.status(503).send("Billing not configured");

  const sig = req.headers["stripe-signature"] as string;
  let event: Stripe.Event;

  try {
    if (WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } else {
      // Development: parse without verification
      event = JSON.parse(req.body.toString());
    }
  } catch (err: any) {
    console.error("[Stripe webhook sig error]", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[Stripe webhook] ${event.type}`);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "subscription" && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);
          await upsertBilling(sub, session.metadata?.broker_account_id || sub.metadata?.broker_account_id);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        await upsertBilling(sub, sub.metadata?.broker_account_id);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await query(
          `UPDATE broker_billing SET subscription_status = 'canceled', updated_at = NOW()
           WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.subscription) {
          await query(
            `UPDATE broker_billing SET subscription_status = 'active', updated_at = NOW()
             WHERE stripe_subscription_id = $1`,
            [invoice.subscription as string]
          );
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.subscription) {
          await query(
            `UPDATE broker_billing SET subscription_status = 'past_due', updated_at = NOW()
             WHERE stripe_subscription_id = $1`,
            [invoice.subscription as string]
          );
        }
        break;
      }
    }
  } catch (err) {
    console.error("[Stripe webhook processing error]", err);
    return res.status(500).send("Webhook processing error");
  }

  res.json({ received: true });
});

// ── Helper: upsert billing record from a Stripe Subscription ──
async function upsertBilling(sub: Stripe.Subscription, brokerAccountId?: string) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.toString();
  const priceId = sub.items.data[0]?.price?.id || "";
  const interval = sub.items.data[0]?.price?.recurring?.interval || "month";
  const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

  // Try to find broker account by metadata or existing customer ID
  let brokerAccId = brokerAccountId ? parseInt(brokerAccountId) : null;

  if (!brokerAccId) {
    const existing = await query(
      "SELECT broker_account_id FROM broker_billing WHERE stripe_customer_id = $1",
      [customerId]
    );
    if (existing.rows.length > 0) {
      brokerAccId = existing.rows[0].broker_account_id;
    }
  }

  // If still no broker account, try to match by email
  if (!brokerAccId) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
      const customer = await stripe.customers.retrieve(customerId);
      if (customer && !customer.deleted && customer.email) {
        const match = await query(
          "SELECT ba.id FROM broker_accounts ba JOIN broker_users bu ON bu.broker_account_id = ba.id WHERE bu.email = $1 LIMIT 1",
          [customer.email]
        );
        if (match.rows.length > 0) {
          brokerAccId = match.rows[0].id;
        }
      }
    } catch { /* ignore */ }
  }

  await query(`
    INSERT INTO broker_billing (broker_account_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
      subscription_status, billing_interval, trial_ends_at, current_period_end)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (stripe_customer_id) DO UPDATE SET
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      stripe_price_id = EXCLUDED.stripe_price_id,
      subscription_status = EXCLUDED.subscription_status,
      billing_interval = EXCLUDED.billing_interval,
      trial_ends_at = EXCLUDED.trial_ends_at,
      current_period_end = EXCLUDED.current_period_end,
      updated_at = NOW()
  `, [brokerAccId, customerId, sub.id, priceId, sub.status, interval, trialEnd, periodEnd]);
}

export default router;
