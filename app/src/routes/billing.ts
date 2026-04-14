import { Router, Request, Response } from "express";
import Stripe from "stripe";
import { query } from "../db";
import { layout } from "../views/layout";

const router = Router();

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY || "";
const STRIPE_PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL || "";
const BASE_URL = process.env.BASE_URL || "https://app.connectedcarriers.org";

// Pilot users get full access without billing — comma-separated emails
const PILOT_EMAILS = (process.env.PILOT_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);

const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

// ── Helper: check if a user is a pilot user ───────────────────
function isPilotUser(email?: string): boolean {
  if (!email) return false;
  return PILOT_EMAILS.includes(email.toLowerCase());
}

// ── POST /api/billing/checkout-session ─────────────────────────
// Creates a Stripe Checkout session for subscription with 30-day trial
router.post("/api/billing/checkout-session", async (req: Request, res: Response) => {
  if (!stripe) {
    return res.status(503).json({ error: "Billing not configured" });
  }

  try {
    const { interval } = req.body; // "monthly" or "annual"
    const priceId = interval === "annual" ? STRIPE_PRICE_ANNUAL : STRIPE_PRICE_MONTHLY;

    if (!priceId) {
      return res.status(400).json({ error: "Pricing not configured" });
    }

    // Get broker info from session
    const session = req.session as any;
    const email = req.body.email || session?.userEmail || undefined;

    // Check if broker already has a Stripe customer
    let customerId: string | undefined;
    if (session?.brokerAccountId) {
      const existing = await query(
        "SELECT stripe_customer_id FROM broker_billing WHERE broker_account_id = $1",
        [session.brokerAccountId]
      );
      if (existing.rows.length > 0 && existing.rows[0].stripe_customer_id) {
        customerId = existing.rows[0].stripe_customer_id;

        // If already subscribed, redirect to portal instead
        const sub = existing.rows[0];
        if (sub.subscription_status === "active" || sub.subscription_status === "trialing") {
          const portal = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${BASE_URL}/billing`,
          });
          return res.json({ url: portal.url, already_subscribed: true });
        }
      }
    }

    const sessionParams: any = {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 30,
      },
      success_url: `${BASE_URL}/billing?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${BASE_URL}/billing?canceled=true`,
      allow_promotion_codes: true,
    };

    if (customerId) {
      sessionParams.customer = customerId;
    } else if (email) {
      sessionParams.customer_email = email;
    }

    // Pass broker account ID in metadata for webhook processing
    if (session?.brokerAccountId) {
      sessionParams.subscription_data!.metadata = {
        broker_account_id: String(session.brokerAccountId),
      };
    }

    const checkoutSession = await stripe.checkout.sessions.create(sessionParams);
    return res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("[Stripe Checkout error]", err);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ── POST /api/billing/portal-session ───────────────────────────
// Creates a Stripe Customer Portal session for billing management
router.post("/api/billing/portal-session", async (req: Request, res: Response) => {
  if (!stripe) {
    return res.status(503).json({ error: "Billing not configured" });
  }

  try {
    const session = req.session as any;
    if (!session?.brokerAccountId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const billing = await query(
      "SELECT stripe_customer_id FROM broker_billing WHERE broker_account_id = $1",
      [session.brokerAccountId]
    );

    if (!billing.rows.length || !billing.rows[0].stripe_customer_id) {
      return res.status(400).json({ error: "No billing account found. Start a free trial first." });
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: billing.rows[0].stripe_customer_id,
      return_url: `${BASE_URL}/billing`,
    });

    return res.json({ url: portal.url });
  } catch (err) {
    console.error("[Stripe Portal error]", err);
    return res.status(500).json({ error: "Failed to create portal session" });
  }
});

// ── GET /billing ───────────────────────────────────────────────
// Billing status page in the broker dashboard
router.get("/billing", async (req: Request, res: Response) => {
  const session = req.session as any;
  if (!session?.userId) return res.redirect("/login");

  const userEmail = session.userEmail || "";
  const userIsPilot = isPilotUser(userEmail);

  // Auto-provision pilot users with permanent active status
  if (userIsPilot) {
    try {
      const existing = await query(
        "SELECT * FROM broker_billing WHERE broker_account_id = $1",
        [session.brokerAccountId]
      );
      if (!existing.rows.length) {
        await query(
          `INSERT INTO broker_billing (broker_account_id, stripe_customer_id, subscription_status, billing_interval)
           VALUES ($1, $2, 'active', 'pilot')
           ON CONFLICT (stripe_customer_id) DO NOTHING`,
          [session.brokerAccountId, `pilot_${session.brokerAccountId}`]
        );
      } else if (existing.rows[0].subscription_status !== 'active') {
        await query(
          "UPDATE broker_billing SET subscription_status = 'active', billing_interval = 'pilot', updated_at = NOW() WHERE broker_account_id = $1",
          [session.brokerAccountId]
        );
      }
    } catch { /* ignore if table doesn't exist yet */ }
  }

  let billing: any = null;
  try {
    const result = await query(
      "SELECT * FROM broker_billing WHERE broker_account_id = $1",
      [session.brokerAccountId]
    );
    billing = result.rows[0] || null;
  } catch { /* table might not exist yet */ }

  const success = req.query.success === "true";
  const canceled = req.query.canceled === "true";

  let statusLabel = "No plan";
  let statusColor = "#6B7A8A";
  let trialInfo = "";

  if (userIsPilot) {
    statusLabel = "Pilot Partner";
    statusColor = "#C8892A";
    trialInfo = "Full access — no charge";
  } else if (billing) {
    switch (billing.subscription_status) {
      case "trialing":
        statusLabel = "Free Trial";
        statusColor = "#C8892A";
        if (billing.trial_ends_at) {
          const daysLeft = Math.ceil((new Date(billing.trial_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          trialInfo = daysLeft > 0 ? `${daysLeft} days left` : "Trial ending";
        }
        break;
      case "active":
        statusLabel = "Active";
        statusColor = "#4A8C1C";
        break;
      case "past_due":
        statusLabel = "Payment Issue";
        statusColor = "#A32D2D";
        break;
      case "canceled":
        statusLabel = "Canceled";
        statusColor = "#6B7A8A";
        break;
      default:
        statusLabel = "No plan";
    }
  }

  const intervalLabel = billing?.billing_interval === "year" ? "Annual — $999/year" : billing?.billing_interval === "month" ? "Monthly — $99/month" : "";
  const renewDate = billing?.current_period_end ? new Date(billing.current_period_end).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";

  const billingContent = `
<div class="page-header">
  <h1 class="page-title">Billing</h1>
  <p class="page-sub">Manage your Connected Carriers subscription</p>
</div>
${success ? `<div style="background:#EAF3DE;border:1px solid #C5E0A0;border-radius:3px;padding:20px;margin-bottom:20px;color:#3b6d11">
  <div style="font-weight:500;margin-bottom:8px">Welcome to Connected Carriers. Your free trial is active.</div>
  <div style="font-size:13px;line-height:1.6;opacity:0.85">Here's what to do next:</div>
  <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
    <a href="/loads" style="display:inline-block;padding:8px 16px;background:#3b6d11;color:#fff;border-radius:2px;font-size:13px;font-weight:500;text-decoration:none">Create a Load Link</a>
    <a href="/loads" style="display:inline-block;padding:8px 16px;background:var(--slate);color:var(--cream);border-radius:2px;font-size:13px;font-weight:500;text-decoration:none">Send Arrival Check</a>
  </div>
</div>` : ''}
${canceled ? '<div style="background:#FFF8ED;border:1px solid #F0DFC0;border-radius:3px;padding:14px;margin-bottom:20px;font-size:14px;color:#8B6914">Checkout was canceled. No charges were made.</div>' : ''}
<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--cream2)">
    <div><div style="font-size:11px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Plan</div><div style="font-size:16px;font-weight:500;color:var(--slate)">${billing ? 'Connected Carriers' : 'No active plan'}</div></div>
    <span style="display:inline-block;padding:3px 10px;border-radius:2px;font-size:12px;font-weight:500;color:#fff;background:${statusColor}">${statusLabel}</span>
  </div>
  ${intervalLabel ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--cream2)"><div><div style="font-size:11px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Billing</div><div style="font-size:16px;font-weight:500;color:var(--slate)">${intervalLabel}</div></div></div>` : ''}
  ${trialInfo ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--cream2)"><div><div style="font-size:11px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Trial</div><div style="font-size:16px;font-weight:500;color:var(--slate)">${trialInfo}</div></div></div>` : ''}
  ${renewDate ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0"><div><div style="font-size:11px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);margin-bottom:4px">${billing?.subscription_status === 'canceled' ? 'Access until' : 'Renews'}</div><div style="font-size:16px;font-weight:500;color:var(--slate)">${renewDate}</div></div></div>` : ''}
</div>
${billing?.stripe_customer_id && !userIsPilot ? `
<form action="/api/billing/portal-session" method="POST" style="display:inline">
  <button type="submit" class="btn-primary" style="margin-top:8px">Manage Billing</button>
</form>` : userIsPilot ? `
<div class="card" style="text-align:center;padding:24px">
  <p style="font-size:15px;color:var(--slate);font-weight:500;margin-bottom:6px">You're a pilot partner</p>
  <p style="font-size:13px;color:var(--muted)">Full access to Connected Carriers at no cost. Thank you for helping us build this.</p>
</div>` : `
<div class="card" style="text-align:center;padding:32px">
  <p style="font-size:15px;color:var(--slate);margin-bottom:6px;font-weight:500">Start your free trial</p>
  <p style="font-size:13px;color:var(--muted);margin-bottom:20px">30 days free. Cancel anytime.</p>
  <form action="/api/billing/checkout-session" method="POST" style="display:inline">
    <input type="hidden" name="interval" value="monthly">
    <button type="submit" class="btn-primary">Start Free Trial — $99/month</button>
  </form>
  <form action="/api/billing/checkout-session" method="POST" style="display:inline;margin-left:8px">
    <input type="hidden" name="interval" value="annual">
    <button type="submit" class="btn-primary" style="background:var(--slate);color:var(--cream)">Start Free Trial — $999/year</button>
  </form>
  <p style="font-size:12px;color:var(--muted);margin-top:12px">Save 2 months with annual billing</p>
</div>`}`;

  res.send(layout({
    title: "Billing",
    userName: session.userName || "",
    userRole: session.userRole || "",
    content: billingContent,
  }));
});

export default router;
