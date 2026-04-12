import { Router, Response } from "express";
import crypto from "crypto";
import { query } from "../db";
import { h, csrfToken } from "../middleware/security";
import { AuthenticatedRequest, requireAuth } from "../middleware/auth";
import { layout } from "../views/layout";

const router = Router();
const MCP_URL = "https://cc-mcp-server-production.up.railway.app/mcp";

// ── BROKER: Generate intake link ──────────────────────────────────

router.post("/intake/create", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const userId = req.session.userId;
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours

  try {
    await query(`
      INSERT INTO carrier_intake_links (broker_account_id, token, status, expires_at, created_by)
      VALUES ($1, $2, 'active', $3, $4)
    `, [accountId, token, expiresAt, userId]);

    await query(`
      INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
      VALUES ('broker_account', $1, 'broker_user', $2, 'intake_link_created', $3)
    `, [accountId, userId, JSON.stringify({ token: token.slice(0, 8) + "...", expires_at: expiresAt })]);

    res.redirect("/intake/links");
  } catch (err) {
    console.error(err);
    res.redirect("/dashboard?error=intake_create_failed");
  }
});

// ── BROKER: Intake links list ─────────────────────────────────────

router.get("/intake/links", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;

  // Expire old links
  await query(`UPDATE carrier_intake_links SET status='expired' WHERE broker_account_id=$1 AND status='active' AND expires_at < NOW()`, [accountId]);

  const links = await query(`
    SELECT cil.*, bu.name as created_by_name,
           cs.id as submission_id, cs.status as submission_status,
           c.legal_name as carrier_name, c.mc_number
    FROM carrier_intake_links cil
    LEFT JOIN broker_users bu ON bu.id = cil.created_by
    LEFT JOIN carrier_submissions cs ON cs.id = cil.submitted_submission_id
    LEFT JOIN carriers c ON c.id = cs.carrier_id
    WHERE cil.broker_account_id = $1
    ORDER BY cil.created_at DESC
    LIMIT 50
  `, [accountId]);

  const BASE_URL = process.env.BASE_URL || `https://github-repo-production-2c39.up.railway.app`;
  const csrf = csrfToken(req);

  const html = layout({
    title: "Intake Links",
    userName: req.session.userName || "",
    csrfToken: csrf,
    content: intakeLinksContent(links.rows, BASE_URL, csrf),
  });
  res.send(html);
});

// ── BROKER: Cancel intake link ────────────────────────────────────

router.post("/intake/links/:id/cancel", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  await query(`UPDATE carrier_intake_links SET status='cancelled' WHERE id=$1 AND broker_account_id=$2`, [req.params.id, accountId]);
  res.redirect("/intake/links");
});

// ── PUBLIC: Carrier intake form ───────────────────────────────────

router.get("/apply/:token", async (req, res: Response) => {
  const { token } = req.params;
  try {
    const result = await query(`
      SELECT cil.*, ba.company_name, bp.*
      FROM carrier_intake_links cil
      JOIN broker_accounts ba ON ba.id = cil.broker_account_id
      LEFT JOIN broker_policies bp ON bp.broker_account_id = cil.broker_account_id
      WHERE cil.token = $1
    `, [token]);

    if (!result.rows.length) {
      return res.send(intakeErrorPage("This link is invalid or has expired."));
    }

    const link = result.rows[0];

    if (link.status === "submitted") {
      return res.send(intakeErrorPage("This intake link has already been submitted. Contact your broker for a new link."));
    }
    if (link.status === "expired" || new Date(link.expires_at) < new Date()) {
      return res.send(intakeErrorPage("This intake link has expired. Contact your broker for a new link."));
    }
    if (link.status === "cancelled") {
      return res.send(intakeErrorPage("This intake link has been cancelled. Contact your broker."));
    }

    res.send(intakeFormPage(token, link.company_name, link, req.query.error as string));
  } catch (err) {
    console.error(err);
    res.status(500).send(intakeErrorPage("Something went wrong. Please try again."));
  }
});

// ── PUBLIC: Carrier intake form submission ────────────────────────

router.post("/apply/:token", async (req, res: Response) => {
  const { token } = req.params;
  const body = req.body;

  try {
    // Load link + policy
    const linkRes = await query(`
      SELECT cil.*, ba.id as broker_account_id, ba.company_name, bp.*
      FROM carrier_intake_links cil
      JOIN broker_accounts ba ON ba.id = cil.broker_account_id
      LEFT JOIN broker_policies bp ON bp.broker_account_id = cil.broker_account_id
      WHERE cil.token = $1 AND cil.status = 'active' AND cil.expires_at > NOW()
    `, [token]);

    if (!linkRes.rows.length) {
      return res.send(intakeErrorPage("This link is invalid, expired, or already submitted."));
    }

    const link = linkRes.rows[0];
    const policy = link;
    const accountId = link.broker_account_id;

    // Per-token rate limit: max 3 submission attempts per intake link
    // Prevents FMCSA lookup hammering if a token is discovered or shared
    const submissionCount = await query(
      `SELECT COUNT(*) as count FROM carrier_submissions WHERE intake_link_id = $1`,
      [link.id]
    );
    const attemptCount = parseInt(submissionCount.rows[0].count);
    if (attemptCount >= 3) {
      return res.send(intakeErrorPage("This intake link has reached its submission limit. Contact your broker for a new link."));
    }

    // Basic validation
    const errors: string[] = [];
    if (!body.legal_name?.trim()) errors.push("Company name is required.");
    if (!body.mc_number?.trim()) errors.push("MC number is required.");
    if (!body.dispatcher_name?.trim()) errors.push("Dispatcher name is required.");
    if (!body.dispatcher_phone?.trim()) errors.push("Dispatcher phone is required.");
    if (!body.dispatcher_email?.trim()) errors.push("Dispatcher email is required.");
    if (!body.agreed_to_terms) errors.push("You must agree to the terms.");
    if (!body.agreed_to_tracking) errors.push("You must agree to the tracking requirement.");
    if (policy.coi_required_at_submission && !body.coi_provided) errors.push("Certificate of Insurance is required at submission.");

    if (errors.length) {
      return res.send(intakeFormPage(token, link.company_name, link, errors.join(" ")));
    }

    const mcNumber = body.mc_number.replace(/\D/g, "");

    // Run FMCSA verification
    let fmcsaResult: Record<string, unknown> = {};
    let verifyChecks: Record<string, unknown> = {};
    try {
      const rawResult = await mcpToolCall("cc_verify_carrier", {
        mc_number: mcNumber,
        min_years: policy.minimum_authority_age_days ? Math.floor(policy.minimum_authority_age_days / 365) : undefined,
      });
      const parsed = JSON.parse(rawResult);
      fmcsaResult = parsed.fmcsa || {};
      verifyChecks = parsed.checks || {};
    } catch (err) {
      console.error("FMCSA lookup failed:", err);
      // Non-blocking — proceed with empty result
    }

    // Hard-stop evaluation
    const autoRejectReasons: string[] = [];
    const internalFlags: Record<string, unknown> = {};

    if (policy.require_mc_active && fmcsaResult.found && !fmcsaResult.active) {
      autoRejectReasons.push("Inactive MC / FMCSA operating authority");
    }
    if (fmcsaResult.found === false) {
      autoRejectReasons.push("MC number not found in FMCSA database");
    }
    if (policy.require_dot_active && fmcsaResult.usdot_status && !String(fmcsaResult.usdot_status).includes("ACTIVE")) {
      autoRejectReasons.push("DOT number not in good standing");
    }
    if (fmcsaResult.safety_rating === "Unsatisfactory") {
      autoRejectReasons.push("Unsatisfactory FMCSA safety rating");
    }
    if (policy.double_brokering_flag_triggers_reject && body.double_brokering_flag) {
      autoRejectReasons.push("Double brokering flag on record");
    }
    if (policy.minimum_authority_age_days && fmcsaResult.years_in_operation !== undefined) {
      const minYears = policy.minimum_authority_age_days / 365;
      if ((fmcsaResult.years_in_operation as number) < minYears) {
        autoRejectReasons.push(`Carrier does not meet minimum time in business (${Math.round(minYears * 12)} months required)`);
      }
    }

    const autoRejected = autoRejectReasons.length > 0;

    // Conditional/manual-review flags
    const conditionalFlags: string[] = [];
    if (fmcsaResult.safety_rating === "Conditional") {
      conditionalFlags.push("Conditional FMCSA safety rating — manual review required");
      internalFlags.conditional_safety_rating = true;
    }
    if (!body.w9_provided && policy.require_w9) {
      conditionalFlags.push("W-9 not provided");
      internalFlags.missing_w9 = true;
    }
    if (!body.agreement_provided && policy.require_signed_agreement) {
      conditionalFlags.push("Signed carrier agreement not provided");
      internalFlags.missing_agreement = true;
    }

    const isConditional = !autoRejected && conditionalFlags.length > 0;
    const submissionStatus = autoRejected ? "rejected" : isConditional ? "conditional" : "submitted";

    // Upsert carrier
    const carrierRes = await query(`
      INSERT INTO carriers (broker_account_id, mc_number, legal_name, dba_name, phone, email,
        onboarding_status, approval_tier, authority_status, safety_rating_snapshot, last_verified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (mc_number) DO UPDATE SET
        legal_name = EXCLUDED.legal_name,
        onboarding_status = EXCLUDED.onboarding_status,
        approval_tier = EXCLUDED.approval_tier,
        authority_status = EXCLUDED.authority_status,
        safety_rating_snapshot = EXCLUDED.safety_rating_snapshot,
        last_verified_at = NOW(),
        updated_at = NOW()
      RETURNING id
    `, [
      accountId, mcNumber, body.legal_name.trim(), body.dba_name?.trim() || null,
      body.dispatcher_phone?.trim() || null, body.dispatcher_email?.trim() || null,
      autoRejected ? "rejected" : isConditional ? "conditional" : "submitted",
      autoRejected ? "rejected" : isConditional ? "conditional" : "manual_review",
      fmcsaResult.operating_status || null,
      fmcsaResult.safety_rating || null,
    ]);

    const carrierId = carrierRes.rows[0].id;

    // Create submission
    const rawPayload = {
      legal_name: body.legal_name,
      mc_number: mcNumber,
      dot_number: body.dot_number,
      dispatcher_name: body.dispatcher_name,
      dispatcher_phone: body.dispatcher_phone,
      dispatcher_email: body.dispatcher_email,
      equipment_types: Array.isArray(body.equipment_types) ? body.equipment_types : [body.equipment_types].filter(Boolean),
      lanes: body.lanes,
      hazmat: body.hazmat,
      owner_operator: body.owner_operator === "yes",
      coi_provided: !!body.coi_provided,
      w9_provided: !!body.w9_provided,
      agreement_provided: !!body.agreement_provided,
      agreed_to_tracking: !!body.agreed_to_tracking,
    };

    const submissionRes = await query(`
      INSERT INTO carrier_submissions (
        broker_account_id, mc_number, carrier_id, submitted_by_name, submitted_by_email,
        submitted_by_phone, raw_payload, fmcsa_result, status, agreed_to_terms,
        submitted_at, decision_reason, internal_flags, auto_rejected, auto_reject_reasons,
        intake_link_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11,$12,$13,$14,$15)
      RETURNING id
    `, [
      accountId, mcNumber, carrierId,
      body.dispatcher_name, body.dispatcher_email, body.dispatcher_phone,
      JSON.stringify(rawPayload),
      JSON.stringify({ ...fmcsaResult, checks: verifyChecks }),
      submissionStatus,
      true,
      autoRejected ? autoRejectReasons.join("; ") : isConditional ? conditionalFlags.join("; ") : null,
      JSON.stringify(internalFlags),
      autoRejected,
      JSON.stringify(autoRejectReasons),
      link.id,
    ]);

    const submissionId = submissionRes.rows[0].id;

    // Mark intake link as submitted
    await query(`
      UPDATE carrier_intake_links SET status='submitted', submitted_submission_id=$1, updated_at=NOW()
      WHERE id=$2
    `, [submissionId, link.id]);

    // Activity log
    await query(`
      INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
      VALUES ('carrier_submission', $1, 'system', NULL, $2, $3)
    `, [
      submissionId,
      autoRejected ? "auto_rejected" : isConditional ? "flagged_for_review" : "submitted",
      JSON.stringify({
        mc_number: mcNumber,
        auto_rejected: autoRejected,
        reasons: autoRejected ? autoRejectReasons : conditionalFlags,
        fmcsa_active: fmcsaResult.active,
      }),
    ]);

    // Show confirmation
    res.send(intakeConfirmationPage(autoRejected, isConditional, h(link.company_name), h(body.legal_name)));

  } catch (err) {
    console.error("Intake submission error:", err);
    res.status(500).send(intakeErrorPage("Something went wrong processing your submission. Please try again."));
  }
});

export default router;

// ── MCP helper ────────────────────────────────────────────────────

async function mcpToolCall(toolName: string, args: Record<string, unknown>): Promise<string> {
  const http = await import("http");
  const https = await import("https");

  const call = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
      const url = new URL(MCP_URL);
      const lib = url.protocol === "https:" ? https : http;
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
        },
      };
      const reqHttp = lib.request(options, (resHttp) => {
        let data = "";
        resHttp.on("data", chunk => data += chunk);
        resHttp.on("end", () => {
          for (const line of data.split("\n")) {
            if (line.startsWith("data:")) {
              try {
                const parsed = JSON.parse(line.slice(5).trim());
                if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
                else resolve(parsed.result || {});
                return;
              } catch { /* continue */ }
            }
          }
          reject(new Error("No data in MCP response"));
        });
      });
      reqHttp.on("error", reject);
      reqHttp.write(payload);
      reqHttp.end();
    });
  };

  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cc-broker-app", version: "1.0" },
  });
  const result = await call("tools/call", { name: toolName, arguments: args });
  const content = (result as { content?: Array<{ type: string; text: string }> }).content || [];
  for (const block of content) {
    if (block.type === "text") return block.text;
  }
  return JSON.stringify(result);
}

// ── View helpers ──────────────────────────────────────────────────

function intakeLinksContent(rows: Record<string, unknown>[], baseUrl: string, csrf = ""): string {
  return `
<div class="page-header">
  <div>
    <a href="/dashboard" class="back-link">← Dashboard</a>
    <h1 class="page-title">Carrier Intake Links</h1>
    <p class="page-sub">Send these links to carriers after they respond to your DAT posting.</p>
  </div>
  <form method="POST" action="/intake/create" style="margin-top:8px">
    <input type="hidden" name="_csrf" value="${h(csrf)}">
    <button type="submit" class="btn-primary">+ New Intake Link</button>
  </form>
</div>

<div class="table-wrap">
  ${rows.length === 0 ? `<div class="empty">No intake links yet. Create one to get started.</div>` : `
  <table class="data-table">
    <thead>
      <tr>
        <th>Link</th>
        <th>Created</th>
        <th>Expires</th>
        <th>Status</th>
        <th>Carrier</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r: Record<string, unknown>) => {
        const url = `${baseUrl}/apply/${String(r.token)}`;
        const expired = new Date(String(r.expires_at)) < new Date();
        const statusColor: Record<string, string> = {
          active: "#10b981", submitted: "#3b82f6", expired: "#6b7a8a", cancelled: "#ef4444"
        };
        const status = expired && r.status === "active" ? "expired" : String(r.status);
        const color = statusColor[status] || "#6b7a8a";
        return `
          <tr>
            <td>
              <code style="font-size:11px">${String(r.token).slice(0,16)}…</code>
              ${status === "active" ? `
                <button onclick="navigator.clipboard.writeText('${url}').then(()=>this.textContent='Copied!').catch(()=>{})" 
                  class="btn-sm" style="margin-left:8px;font-size:11px">Copy link</button>
              ` : ""}
            </td>
            <td class="muted">${r.created_at ? new Date(String(r.created_at)).toLocaleDateString() : "—"}</td>
            <td class="muted">${r.expires_at ? new Date(String(r.expires_at)).toLocaleDateString() : "—"}</td>
            <td><span class="badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${status}</span></td>
            <td>
              ${r.carrier_name ? `
                <a href="/carriers/${r.carrier_id}" class="btn-link">${String(r.carrier_name)}</a>
                <span class="muted" style="font-size:11px"> MC${String(r.mc_number)}</span>
              ` : `<span class="muted">—</span>`}
            </td>
            <td>
              ${status === "active" ? `
                <form method="POST" action="/intake/links/${r.id}/cancel" style="display:inline">
                  <input type="hidden" name="_csrf" value="${h(csrf)}">
                  <button type="submit" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:12px">Cancel</button>
                </form>
              ` : ""}
              ${r.submission_id ? `<a href="/carriers/${r.carrier_id}" class="btn-link">View →</a>` : ""}
            </td>
          </tr>
        `;
      }).join("")}
    </tbody>
  </table>
  `}
</div>`;
}

function intakeFormPage(token: string, brokerName: string, policy: Record<string, unknown>, error?: string): string {
  const equipmentTypes = [
    "Dry Van 53'", "Reefer / Refrigerated 53'", "Flatbed", "Step Deck",
    "RGN / Lowboy", "Power Only", "Sprinter / Cargo Van", "Box Truck",
    "LTL (Less Than Truckload)", "Intermodal / Drayage", "Specialized / Oversized",
    "Ocean / International Freight",
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Carrier Qualification — ${h(brokerName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --slate: #1C2B3A; --amber: #C8892A; --amber2: #E09B35;
    --cream: #F7F5F0; --cream2: #EDE9E1; --cream3: #E0DAD0;
    --ink: #141414; --muted: #6B7A8A;
    --serif: 'Playfair Display', Georgia, serif;
    --sans: 'DM Sans', system-ui, sans-serif;
  }
  body { font-family: var(--sans); background: var(--cream); color: var(--ink); font-size: 15px; line-height: 1.5; padding: 0 0 48px; }
  .header { background: var(--slate); padding: 20px 24px; }
  .header-brand { font-family: var(--serif); font-size: 18px; color: var(--cream); }
  .header-brand span { color: var(--amber); }
  .header-sub { font-size: 12px; color: rgba(247,245,240,0.5); margin-top: 3px; }
  .form-wrap { max-width: 560px; margin: 0 auto; padding: 24px 20px; }
  .intro { background: white; border-radius: 4px; border: 1px solid var(--cream3); padding: 18px 20px; margin-bottom: 20px; }
  .intro h2 { font-family: var(--serif); font-size: 18px; font-weight: 400; color: var(--slate); margin-bottom: 6px; }
  .intro p { font-size: 13px; color: var(--muted); line-height: 1.6; }
  .card { background: white; border-radius: 4px; border: 1px solid var(--cream3); padding: 20px; margin-bottom: 16px; }
  .section-title { font-size: 11px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--cream2); }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 12px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin-bottom: 5px; }
  .field input, .field select, .field textarea {
    width: 100%; padding: 10px 12px; border: 1px solid var(--cream3); background: white;
    border-radius: 3px; font-family: var(--sans); font-size: 15px; color: var(--ink);
    outline: none; transition: border-color 0.15s; -webkit-appearance: none;
  }
  .field input:focus, .field select:focus, .field textarea:focus { border-color: var(--amber); }
  .field textarea { resize: vertical; min-height: 80px; }
  .required { color: #ef4444; }
  .hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .equipment-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .check-item { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 6px 0; }
  .check-item input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--amber); flex-shrink: 0; }
  .radio-group { display: flex; gap: 16px; }
  .radio-item { display: flex; align-items: center; gap: 6px; font-size: 14px; cursor: pointer; }
  .radio-item input { accent-color: var(--amber); }
  .upload-note { background: var(--cream); border: 1px dashed var(--cream3); border-radius: 3px; padding: 12px; font-size: 13px; color: var(--muted); text-align: center; }
  .upload-check { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 8px 0; border-bottom: 1px solid var(--cream2); }
  .upload-check:last-child { border-bottom: none; }
  .upload-check input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--amber); flex-shrink: 0; }
  .terms-check { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; line-height: 1.5; padding: 12px 0; }
  .terms-check input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--amber); flex-shrink: 0; margin-top: 1px; }
  .submit-btn {
    width: 100%; padding: 15px; background: var(--amber); color: var(--slate);
    border: none; border-radius: 3px; font-family: var(--sans); font-size: 16px;
    font-weight: 500; cursor: pointer; transition: background 0.15s; margin-top: 8px;
  }
  .submit-btn:hover { background: var(--amber2); }
  .submit-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .error-banner { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; padding: 12px 16px; border-radius: 3px; font-size: 13px; margin-bottom: 16px; }
  .powered { text-align: center; font-size: 11px; color: var(--muted); margin-top: 24px; }
</style>
</head>
<body>
<div class="header">
  <div class="header-brand">Connected<span>Carriers</span></div>
  <div class="header-sub">Carrier qualification for ${h(brokerName)}</div>
</div>
<div class="form-wrap">
  <div class="intro">
    <h2>Carrier Qualification</h2>
    <p>Complete this form to be considered for loads with ${h(brokerName)}. This typically takes 5–10 minutes. Have your MC number, insurance certificate, and W-9 ready.</p>
  </div>
  ${error ? `<div class="error-banner">⚠ ${error}</div>` : ""}
  <form method="POST" action="/apply/${token}" id="intake-form">

    <div class="card">
      <div class="section-title">Company Information</div>
      <div class="field">
        <label>Legal company name <span class="required">*</span></label>
        <input type="text" name="legal_name" required placeholder="e.g. Swift Eagle Transport LLC">
      </div>
      <div class="field">
        <label>DBA name <span style="color:var(--muted);font-weight:400">(if different)</span></label>
        <input type="text" name="dba_name" placeholder="Operating name if different from legal name">
      </div>
      <div class="field">
        <label>MC number <span class="required">*</span></label>
        <input type="text" name="mc_number" required placeholder="e.g. 1234567" pattern="[0-9]+" inputmode="numeric">
        <div class="hint">Digits only — no 'MC' prefix needed</div>
      </div>
      <div class="field">
        <label>DOT number</label>
        <input type="text" name="dot_number" placeholder="e.g. 9876543" inputmode="numeric">
      </div>
    </div>

    <div class="card">
      <div class="section-title">Primary Dispatcher</div>
      <div class="field">
        <label>Name <span class="required">*</span></label>
        <input type="text" name="dispatcher_name" required placeholder="Full name">
      </div>
      <div class="field">
        <label>Phone <span class="required">*</span></label>
        <input type="tel" name="dispatcher_phone" required placeholder="e.g. 602-555-0100" inputmode="tel">
      </div>
      <div class="field">
        <label>Email <span class="required">*</span></label>
        <input type="email" name="dispatcher_email" required placeholder="dispatch@yourcompany.com" inputmode="email">
      </div>
    </div>

    <div class="card">
      <div class="section-title">Equipment & Capabilities</div>
      <div class="field">
        <label>Equipment types you operate <span class="required">*</span></label>
        <div class="equipment-grid">
          ${equipmentTypes.map(t => `
            <label class="check-item">
              <input type="checkbox" name="equipment_types" value="${t}">
              <span>${t}</span>
            </label>
          `).join("")}
        </div>
      </div>
      <div class="field">
        <label>Lanes / freight types</label>
        <textarea name="lanes" placeholder="e.g. CA→TX, hazmat, temp-controlled, ocean/drayage"></textarea>
      </div>
      <div class="field">
        <label>Hazmat or specialty capabilities</label>
        <input type="text" name="hazmat" placeholder="e.g. Hazmat endorsement, TWIC card, bonded">
      </div>
      <div class="field">
        <label>Owner-operator? <span class="required">*</span></label>
        <div class="radio-group">
          <label class="radio-item"><input type="radio" name="owner_operator" value="yes" required> Yes</label>
          <label class="radio-item"><input type="radio" name="owner_operator" value="no"> No</label>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="section-title">Documents</div>
      <div class="upload-note">
        Check each document you have ready to provide. ${h(brokerName)} will follow up to collect the actual files.
      </div>
      <div style="margin-top:12px">
        <label class="upload-check">
          <input type="checkbox" name="coi_provided" value="1" ${policy.coi_required_at_submission ? "required" : ""}>
          <span>Certificate of Insurance (COI) <span class="required">${policy.coi_required_at_submission ? "*" : ""}</span></span>
        </label>
        <label class="upload-check">
          <input type="checkbox" name="w9_provided" value="1">
          <span>W-9 ${policy.require_w9 ? '<span class="hint" style="display:inline">(required before dispatch)</span>' : ""}</span>
        </label>
        <label class="upload-check">
          <input type="checkbox" name="agreement_provided" value="1">
          <span>Signed carrier agreement ${policy.require_signed_agreement ? '<span class="hint" style="display:inline">(required before dispatch)</span>' : ""}</span>
        </label>
      </div>
    </div>

    <div class="card">
      <div class="section-title">Agreements</div>
      <label class="terms-check">
        <input type="checkbox" name="agreed_to_tracking" value="1" required>
        <span>I agree that real-time GPS tracking will be required on all loads. A tracking link will be sent to the driver, and rate confirmation will not be issued until tracking is accepted.</span>
      </label>
      <label class="terms-check">
        <input type="checkbox" name="agreed_to_terms" value="1" required>
        <span>I certify that the information provided is accurate and authorize ${h(brokerName)} to verify my company's FMCSA authority, safety record, and insurance.</span>
      </label>
    </div>

    <button type="submit" class="submit-btn" id="submit-btn">Submit for Qualification →</button>
  </form>
  <div class="powered">Powered by Connected Carriers · A HoneXAI product</div>
</div>
<script>
document.getElementById('intake-form').addEventListener('submit', function() {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
});
</script>
</body>
</html>`;
}

function intakeConfirmationPage(autoRejected: boolean, isConditional: boolean, brokerName: string, carrierName: string): string {
  if (autoRejected) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Submission Received</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#F7F5F0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:white;border-radius:4px;border:1px solid #E0DAD0;padding:36px 32px;max-width:480px;width:100%;text-align:center}
.icon{font-size:40px;margin-bottom:16px}h2{font-size:20px;color:#1C2B3A;margin-bottom:10px}p{font-size:14px;color:#6B7A8A;line-height:1.6}</style>
</head><body><div class="card">
<div class="icon">📋</div>
<h2>Submission Received</h2>
<p>Thank you for submitting your information. After reviewing your qualifications, we are unable to move forward at this time. We appreciate your interest in working with ${h(brokerName)}.</p>
</div></body></html>`;
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Submission Received</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#F7F5F0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:white;border-radius:4px;border:1px solid #E0DAD0;padding:36px 32px;max-width:480px;width:100%;text-align:center}
.check{font-size:48px;margin-bottom:16px}h2{font-family:'Playfair Display',serif;font-size:22px;font-weight:400;color:#1C2B3A;margin-bottom:10px}
p{font-size:14px;color:#6B7A8A;line-height:1.6;margin-bottom:8px}
.note{background:#F7F5F0;border-radius:3px;padding:12px;font-size:13px;color:#6B7A8A;margin-top:16px}</style>
</head><body><div class="card">
<div class="check">✓</div>
<h2>Submission received</h2>
<p>${carrierName} has been submitted to ${h(brokerName)} for qualification review.</p>
${isConditional ? `<p>Your submission has been flagged for manual review. The team will be in touch within 1 business day.</p>` : `<p>Your information is being reviewed. You will hear from ${h(brokerName)} shortly regarding next steps.</p>`}
<div class="note">Keep your insurance certificate and W-9 handy — you may be asked to provide them during onboarding.</div>
</div></body></html>`;
}

function intakeErrorPage(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Unavailable</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:#F7F5F0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:white;border-radius:4px;border:1px solid #E0DAD0;padding:36px 32px;max-width:400px;width:100%;text-align:center}
h2{font-size:18px;color:#1C2B3A;margin-bottom:10px}p{font-size:14px;color:#6B7A8A;line-height:1.6}</style>
</head><body><div class="card"><h2>Link unavailable</h2><p>${message}</p></div></body></html>`;
}
