import { Router, Request, Response } from "express";
import { query } from "../db";
import { h } from "../middleware/security";

const router = Router();

const EQUIPMENT_TYPES = [
  "Dry Van 53'", "Reefer / Refrigerated 53'", "Flatbed", "Step Deck",
  "RGN / Lowboy", "Power Only", "Sprinter / Cargo Van", "Box Truck",
  "LTL (Less Than Truckload)", "Intermodal / Drayage", "Specialized / Oversized",
  "Ocean / International Freight",
];

const TMS_OPTIONS = [
  "Port TMS", "McLeod", "Turvo", "Aljex", "Tai TMS",
  "Rose Rocket", "Magaya", "None — using spreadsheets", "Other",
];

async function recentSubmissionCount(table: string, email: string): Promise<number> {
  const res = await query(
    `SELECT COUNT(*) as count FROM ${table} WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [email]
  );
  return parseInt(res.rows[0].count);
}

// ── GET /interest/broker ──────────────────────────────────────────

router.get("/interest/broker", (req: Request, res: Response) => {
  res.send(brokerInterestPage(req.query.error as string));
});

// ── POST /interest/broker ─────────────────────────────────────────

router.post("/interest/broker", async (req: Request, res: Response) => {
  const { company_name, contact_name, email, phone, tms, tms_other,
          estimated_load_volume, freight_profile_or_lanes, notes } = req.body;

  const errors: string[] = [];
  if (!company_name?.trim()) errors.push("Company name is required.");
  if (!contact_name?.trim()) errors.push("Contact name is required.");
  if (!email?.trim()) errors.push("Email is required.");

  if (errors.length) {
    return res.send(brokerInterestPage(errors.join(" ")));
  }

  try {
    const count = await recentSubmissionCount("broker_interest_submissions", email.trim().toLowerCase());
    if (count >= 3) {
      return res.send(brokerInterestPage("You've submitted recently. Please wait before submitting again."));
    }

    const tmsValue = tms === "Other" ? (tms_other?.trim() || "Other") : tms;

    await query(`
      INSERT INTO broker_interest_submissions
        (company_name, contact_name, email, phone, tms, estimated_load_volume, freight_profile_or_lanes, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      company_name.trim(), contact_name.trim(), email.trim().toLowerCase(),
      phone?.trim() || null, tmsValue?.trim() || null,
      estimated_load_volume?.trim() || null,
      freight_profile_or_lanes?.trim() || null,
      notes?.trim() || null,
    ]);

    res.send(confirmationPage(
      "Request received.",
      "Thanks for your interest in Connected Carriers. We'll review your information and be in touch within one business day.",
      "broker"
    ));
  } catch (err) {
    console.error("Broker interest submission error:", err);
    res.status(500).send(brokerInterestPage("Something went wrong. Please try again."));
  }
});

// ── GET /interest/carrier ─────────────────────────────────────────

router.get("/interest/carrier", (req: Request, res: Response) => {
  res.send(carrierInterestPage(req.query.error as string));
});

// ── POST /interest/carrier ────────────────────────────────────────

router.post("/interest/carrier", async (req: Request, res: Response) => {
  const { company_name, mc_number, contact_name, email, phone,
          lanes_or_regions, notes } = req.body;
  const equipment_types = Array.isArray(req.body.equipment_types)
    ? req.body.equipment_types
    : req.body.equipment_types ? [req.body.equipment_types] : [];

  const errors: string[] = [];
  if (!company_name?.trim()) errors.push("Company name is required.");
  if (!contact_name?.trim()) errors.push("Contact name is required.");
  if (!email?.trim()) errors.push("Email is required.");

  if (errors.length) {
    return res.send(carrierInterestPage(errors.join(" ")));
  }

  try {
    const count = await recentSubmissionCount("carrier_interest_submissions", email.trim().toLowerCase());
    if (count >= 3) {
      return res.send(carrierInterestPage("You've submitted recently. Please wait before submitting again."));
    }

    await query(`
      INSERT INTO carrier_interest_submissions
        (company_name, mc_number, contact_name, email, phone, equipment_types, lanes_or_regions, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      company_name.trim(), mc_number?.replace(/\D/g, "") || null,
      contact_name.trim(), email.trim().toLowerCase(),
      phone?.trim() || null, JSON.stringify(equipment_types),
      lanes_or_regions?.trim() || null, notes?.trim() || null,
    ]);

    res.send(confirmationPage(
      "You're on the list.",
      "Thanks for your interest in joining the Connected Carriers network. We'll be in touch when we open carrier onboarding in your region.",
      "carrier"
    ));
  } catch (err) {
    console.error("Carrier interest submission error:", err);
    res.status(500).send(carrierInterestPage("Something went wrong. Please try again."));
  }
});

export default router;

// ── Shared page shell ─────────────────────────────────────────────

function pageShell(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>${h(title)} — Connected Carriers</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --slate: #1C2B3A; --slate2: #243447; --amber: #C8892A; --amber2: #E09B35;
    --cream: #F7F5F0; --cream2: #EDE9E1; --cream3: #E0DAD0;
    --ink: #141414; --muted: #6B7A8A;
    --serif: 'Playfair Display', Georgia, serif;
    --sans: 'DM Sans', system-ui, sans-serif;
  }
  body { font-family: var(--sans); background: var(--cream); color: var(--ink); font-size: 15px; line-height: 1.5; }
  nav {
    background: var(--slate); height: 60px; display: flex; align-items: center;
    justify-content: space-between; padding: 0 32px; border-bottom: 1px solid var(--slate2);
  }
  .nav-logo { font-family: var(--serif); font-size: 18px; color: var(--cream); text-decoration: none; }
  .nav-logo span { color: var(--amber); }
  .nav-back { font-size: 12px; color: rgba(247,245,240,0.5); text-decoration: none; letter-spacing: 0.04em; }
  .nav-back:hover { color: var(--cream); }
  .page { max-width: 560px; margin: 0 auto; padding: 40px 24px 64px; }
  .page-head { margin-bottom: 32px; }
  .page-eyebrow { font-size: 11px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--amber); margin-bottom: 10px; }
  .page-title { font-family: var(--serif); font-size: 28px; font-weight: 400; color: var(--slate); line-height: 1.2; margin-bottom: 10px; }
  .page-sub { font-size: 14px; color: var(--muted); line-height: 1.6; }
  .card { background: white; border: 1px solid var(--cream3); border-radius: 3px; padding: 24px; margin-bottom: 16px; }
  .section-label { font-size: 10px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--cream2); }
  .field { margin-bottom: 16px; }
  .field:last-child { margin-bottom: 0; }
  .field label { display: block; font-size: 11px; font-weight: 500; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); margin-bottom: 5px; }
  .field input, .field select, .field textarea {
    width: 100%; padding: 10px 12px; border: 1px solid var(--cream3); border-radius: 2px;
    font-family: var(--sans); font-size: 14px; color: var(--ink); background: white;
    outline: none; transition: border-color 0.15s; -webkit-appearance: none;
  }
  .field input:focus, .field select:focus, .field textarea:focus { border-color: var(--amber); }
  .field textarea { resize: vertical; min-height: 80px; }
  .required { color: #ef4444; }
  .field-hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .check-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .check-item { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 5px 0; }
  .check-item input { width: 15px; height: 15px; accent-color: var(--amber); flex-shrink: 0; }
  .submit-btn {
    width: 100%; padding: 14px; background: var(--amber); color: var(--slate); border: none;
    border-radius: 2px; font-family: var(--sans); font-size: 15px; font-weight: 500;
    cursor: pointer; transition: background 0.15s; margin-top: 8px; letter-spacing: 0.02em;
  }
  .submit-btn:hover { background: var(--amber2); }
  .submit-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .error-banner { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; padding: 12px 16px; border-radius: 2px; font-size: 13px; margin-bottom: 20px; }
  .powered { text-align: center; font-size: 11px; color: var(--muted); margin-top: 28px; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 480px) { .two-col { grid-template-columns: 1fr; } .check-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<nav>
  <a href="https://connectedcarriers.org" class="nav-logo">Connected<span>Carriers</span></a>
  <a href="https://connectedcarriers.org" class="nav-back">← Back to site</a>
</nav>
${content}
</body>
</html>`;
}

// ── Broker interest form ──────────────────────────────────────────

function brokerInterestPage(error?: string): string {
  return pageShell("Request Broker Access", `
<div class="page">
  <div class="page-head">
    <div class="page-eyebrow">For freight brokers</div>
    <h1 class="page-title">Request broker access</h1>
    <p class="page-sub">Tell us about your operation. We'll follow up within one business day to set up your Connected Carriers portal.</p>
  </div>
  ${error ? `<div class="error-banner">⚠ ${h(error)}</div>` : ""}
  <form method="POST" action="/interest/broker" id="broker-form">
    <div class="card">
      <div class="section-label">Your company</div>
      <div class="field">
        <label>Brokerage name <span class="required">*</span></label>
        <input type="text" name="company_name" required placeholder="e.g. Logistics Xpress LLC" autocomplete="organization">
      </div>
      <div class="two-col">
        <div class="field">
          <label>Your name <span class="required">*</span></label>
          <input type="text" name="contact_name" required placeholder="Full name" autocomplete="name">
        </div>
        <div class="field">
          <label>Your role</label>
          <input type="text" name="role" placeholder="e.g. Owner, Ops Manager">
        </div>
      </div>
      <div class="two-col">
        <div class="field">
          <label>Email <span class="required">*</span></label>
          <input type="email" name="email" required placeholder="you@yourbrokerage.com" autocomplete="email" inputmode="email">
        </div>
        <div class="field">
          <label>Phone</label>
          <input type="tel" name="phone" placeholder="e.g. 602-555-0100" autocomplete="tel" inputmode="tel">
        </div>
      </div>
    </div>
    <div class="card">
      <div class="section-label">Your operation</div>
      <div class="field">
        <label>TMS you use</label>
        <select name="tms">
          <option value="">Select your TMS…</option>
          ${TMS_OPTIONS.map(t => `<option value="${h(t)}">${h(t)}</option>`).join("")}
        </select>
      </div>
      <div class="field" id="tms-other-field" style="display:none">
        <label>Which TMS?</label>
        <input type="text" name="tms_other" placeholder="TMS name">
      </div>
      <div class="field">
        <label>Estimated weekly load volume</label>
        <input type="text" name="estimated_load_volume" placeholder="e.g. 50–100 loads/week">
      </div>
      <div class="field">
        <label>Freight types and lanes you cover</label>
        <textarea name="freight_profile_or_lanes" placeholder="e.g. Dry van, CA→TX, reefer, intermodal — whatever describes your freight mix"></textarea>
      </div>
      <div class="field">
        <label>Anything else we should know</label>
        <textarea name="notes" placeholder="Current pain points, specific requirements, timeline, questions…"></textarea>
      </div>
    </div>
    <button type="submit" class="submit-btn" id="broker-submit">Request Access →</button>
  </form>
  <div class="powered">Powered by Connected Carriers · A HoneXAI product</div>
</div>
<script>
document.querySelector('select[name="tms"]').addEventListener('change', function() {
  document.getElementById('tms-other-field').style.display = this.value === 'Other' ? 'block' : 'none';
});
document.getElementById('broker-form').addEventListener('submit', function() {
  const btn = document.getElementById('broker-submit');
  btn.disabled = true; btn.textContent = 'Submitting…';
});
</script>`);
}

// ── Carrier interest form ─────────────────────────────────────────

function carrierInterestPage(error?: string): string {
  return pageShell("Request Carrier Invitation", `
<div class="page">
  <div class="page-head">
    <div class="page-eyebrow">For carriers</div>
    <h1 class="page-title">Join the network</h1>
    <p class="page-sub">Tell us about your operation. Carrier onboarding is invite-only — we'll reach out when we have brokers looking for your lanes and equipment.</p>
  </div>
  ${error ? `<div class="error-banner">⚠ ${h(error)}</div>` : ""}
  <form method="POST" action="/interest/carrier" id="carrier-form">
    <div class="card">
      <div class="section-label">Your company</div>
      <div class="field">
        <label>Legal company name <span class="required">*</span></label>
        <input type="text" name="company_name" required placeholder="e.g. Swift Eagle Transport LLC" autocomplete="organization">
      </div>
      <div class="field">
        <label>MC number</label>
        <input type="text" name="mc_number" placeholder="e.g. 1234567" inputmode="numeric">
        <div class="field-hint">Digits only — no "MC" prefix needed. Required for full qualification.</div>
      </div>
      <div class="two-col">
        <div class="field">
          <label>Contact name <span class="required">*</span></label>
          <input type="text" name="contact_name" required placeholder="Full name" autocomplete="name">
        </div>
        <div class="field">
          <label>Phone</label>
          <input type="tel" name="phone" placeholder="e.g. 602-555-0100" autocomplete="tel" inputmode="tel">
        </div>
      </div>
      <div class="field">
        <label>Email <span class="required">*</span></label>
        <input type="email" name="email" required placeholder="dispatch@yourcompany.com" autocomplete="email" inputmode="email">
      </div>
    </div>
    <div class="card">
      <div class="section-label">Equipment & lanes</div>
      <div class="field">
        <label>Equipment types you operate</label>
        <div class="check-grid">
          ${EQUIPMENT_TYPES.map(t => `
            <label class="check-item">
              <input type="checkbox" name="equipment_types" value="${h(t)}">
              <span>${h(t)}</span>
            </label>`).join("")}
        </div>
      </div>
      <div class="field">
        <label>Lanes and regions you run</label>
        <textarea name="lanes_or_regions" placeholder="e.g. CA→TX, Pacific Northwest, Southeast, national…"></textarea>
      </div>
      <div class="field">
        <label>Anything else we should know</label>
        <textarea name="notes" placeholder="Hazmat endorsement, reefer experience, fleet size, questions…"></textarea>
      </div>
    </div>
    <button type="submit" class="submit-btn" id="carrier-submit">Request Invitation →</button>
  </form>
  <div class="powered">Powered by Connected Carriers · A HoneXAI product</div>
</div>
<script>
document.getElementById('carrier-form').addEventListener('submit', function() {
  const btn = document.getElementById('carrier-submit');
  btn.disabled = true; btn.textContent = 'Submitting…';
});
</script>`);
}

// ── Confirmation page ─────────────────────────────────────────────

function confirmationPage(headline: string, message: string, type: string): string {
  return pageShell(headline, `
<div class="page" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;text-align:center">
  <div style="font-size:48px;margin-bottom:20px">${type === "broker" ? "✓" : "✓"}</div>
  <div class="page-eyebrow">${type === "broker" ? "Broker Access" : "Carrier Network"}</div>
  <h1 class="page-title" style="font-size:24px;margin-bottom:12px">${h(headline)}</h1>
  <p style="font-size:14px;color:var(--muted);max-width:380px;line-height:1.7">${h(message)}</p>
  <a href="https://connectedcarriers.org" style="margin-top:28px;font-size:13px;color:var(--amber);text-decoration:none">← Back to Connected Carriers</a>
</div>`);
}
