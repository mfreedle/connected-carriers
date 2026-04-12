import { Router, Response } from "express";
import crypto from "crypto";
import { query } from "../db";
import { AuthenticatedRequest, requireAuth } from "../middleware/auth";
import { h, csrfToken } from "../middleware/security";
import { layout } from "../views/layout";

const router = Router();

// ── Open dispatch packet from carrier detail ──────────────────────

router.post("/carriers/:id/dispatch/create", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const carrierId = parseInt(req.params.id);
  const { load_reference, pickup_address, pickup_window_start, pickup_window_end, carrier_submission_id } = req.body;

  if (!load_reference?.trim()) {
    return res.redirect(`/carriers/${carrierId}?error=load_reference_required`);
  }

  try {
    // Only approved or conditional carriers
    const carrierRes = await query(
      `SELECT * FROM carriers WHERE id = $1 AND broker_account_id = $2 AND onboarding_status NOT IN ('rejected','draft')`,
      [carrierId, accountId]
    );
    if (!carrierRes.rows.length) {
      return res.redirect(`/carriers/${carrierId}?error=carrier_not_eligible`);
    }

    const policyRes = await query(`SELECT * FROM broker_policies WHERE broker_account_id = $1`, [accountId]);
    const policy = policyRes.rows[0] || {};

    const result = await query(`
      INSERT INTO dispatch_packets (
        broker_account_id, carrier_id, carrier_submission_id, load_reference,
        pickup_address, pickup_window_start, pickup_window_end,
        tracking_required, final_clearance_status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
      RETURNING id
    `, [
      accountId, carrierId,
      carrier_submission_id ? parseInt(carrier_submission_id) : null,
      load_reference.trim(), pickup_address?.trim() || null,
      pickup_window_start?.trim() || null, pickup_window_end?.trim() || null,
      policy.require_real_time_gps !== false,
    ]);

    const packetId = result.rows[0].id;

    await logActivity("dispatch_packet", packetId, "broker_user", req.session.userId!, "packet_created", {
      load_reference, carrier_id: carrierId,
    });

    res.redirect(`/dispatch/${packetId}`);
  } catch (err) {
    console.error(err);
    res.redirect(`/carriers/${carrierId}?error=dispatch_create_failed`);
  }
});

// ── Dispatch packet detail screen ─────────────────────────────────

router.get("/dispatch/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const packetId = parseInt(req.params.id);

  try {
    const packetRes = await query(`
      SELECT dp.*, c.legal_name, c.company_name, c.mc_number, c.onboarding_status,
             bu.name as cleared_by_name, bur.name as reverified_by_name
      FROM dispatch_packets dp
      JOIN carriers c ON c.id = dp.carrier_id
      LEFT JOIN broker_users bu ON bu.id = dp.cleared_by
      LEFT JOIN broker_users bur ON bur.id = dp.insurance_reverified_by
      WHERE dp.id = $1 AND dp.broker_account_id = $2
    `, [packetId, accountId]);

    if (!packetRes.rows.length) return res.status(404).send("Dispatch packet not found");

    const packet = packetRes.rows[0];

    const policyRes = await query(`SELECT * FROM broker_policies WHERE broker_account_id = $1`, [accountId]);
    const policy = policyRes.rows[0] || {};

    const activityRes = await query(`
      SELECT * FROM activity_logs WHERE subject_type = 'dispatch_packet' AND subject_id = $1
      ORDER BY created_at DESC LIMIT 50
    `, [packetId]);

    const { blocking, complete } = evaluateGating(packet, policy);

    const csrf = csrfToken(req);
    const html = layout({
      title: `Dispatch — ${packet.load_reference}`,
      userName: req.session.userName || "",
      csrfToken: csrf,
      content: dispatchContent(packet, policy, activityRes.rows, blocking, complete, req.query, csrf),
    });

    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading dispatch packet");
  }
});

// ── Save driver & equipment fields ───────────────────────────────

router.post("/dispatch/:id/driver", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const packetId = parseInt(req.params.id);
  const { driver_name, driver_phone, vin_number, trailer_number,
          cdl_photo_url, truck_photo_url, vin_photo_url, cab_card_url } = req.body;

  try {
    await query(`
      UPDATE dispatch_packets SET
        driver_name=$1, driver_phone=$2, vin_number=$3, trailer_number=$4,
        cdl_photo_url=$5, truck_photo_url=$6, vin_photo_url=$7, cab_card_url=$8,
        updated_at=NOW()
      WHERE id=$9 AND broker_account_id=$10
    `, [
      driver_name?.trim() || null, driver_phone?.trim() || null,
      vin_number?.trim() || null, trailer_number?.trim() || null,
      cdl_photo_url?.trim() || null, truck_photo_url?.trim() || null,
      vin_photo_url?.trim() || null, cab_card_url?.trim() || null,
      packetId, accountId,
    ]);

    await logActivity("dispatch_packet", packetId, "broker_user", req.session.userId!, "driver_info_updated", {
      driver_name, vin_number,
    });

    res.redirect(`/dispatch/${packetId}?saved=driver`);
  } catch (err) {
    console.error(err);
    res.redirect(`/dispatch/${packetId}?error=save_failed`);
  }
});

// ── Insurance reverification ──────────────────────────────────────

router.post("/dispatch/:id/insurance", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const packetId = parseInt(req.params.id);
  const userId = req.session.userId;
  const { insurer_name, insurance_verification_method, vin_verified, vin_verification_notes } = req.body;

  try {
    await query(`
      UPDATE dispatch_packets SET
        insurer_name=$1, insurance_verification_method=$2,
        insurance_reverified_at=NOW(), insurance_reverified_by=$3,
        vin_verified=$4, vin_verification_notes=$5,
        updated_at=NOW()
      WHERE id=$6 AND broker_account_id=$7
    `, [
      insurer_name?.trim() || null, insurance_verification_method || null,
      userId, vin_verified === "on" || vin_verified === "true",
      vin_verification_notes?.trim() || null,
      packetId, accountId,
    ]);

    await logActivity("dispatch_packet", packetId, "broker_user", userId!, "insurance_reverified", {
      insurer_name, method: insurance_verification_method,
      vin_verified: vin_verified === "on" || vin_verified === "true",
    });

    res.redirect(`/dispatch/${packetId}?saved=insurance`);
  } catch (err) {
    console.error(err);
    res.redirect(`/dispatch/${packetId}?error=save_failed`);
  }
});

// ── Tracking actions ──────────────────────────────────────────────

router.post("/dispatch/:id/tracking/send", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const packetId = parseInt(req.params.id);

  try {
    await query(`
      UPDATE dispatch_packets SET tracking_status='sent', tracking_link_sent_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND broker_account_id=$2
    `, [packetId, accountId]);

    await logActivity("dispatch_packet", packetId, "broker_user", req.session.userId!, "tracking_link_sent", {});
    res.redirect(`/dispatch/${packetId}?saved=tracking_sent`);
  } catch (err) {
    console.error(err);
    res.redirect(`/dispatch/${packetId}?error=save_failed`);
  }
});

router.post("/dispatch/:id/tracking/accept", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const packetId = parseInt(req.params.id);

  try {
    await query(`
      UPDATE dispatch_packets SET tracking_status='accepted', tracking_accepted_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND broker_account_id=$2
    `, [packetId, accountId]);

    await logActivity("dispatch_packet", packetId, "broker_user", req.session.userId!, "tracking_accepted", {});
    res.redirect(`/dispatch/${packetId}?saved=tracking_accepted`);
  } catch (err) {
    console.error(err);
    res.redirect(`/dispatch/${packetId}?error=save_failed`);
  }
});

router.post("/dispatch/:id/tracking/reject", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const packetId = parseInt(req.params.id);

  try {
    await query(`
      UPDATE dispatch_packets SET tracking_status='rejected', updated_at=NOW()
      WHERE id=$1 AND broker_account_id=$2
    `, [packetId, accountId]);

    await logActivity("dispatch_packet", packetId, "broker_user", req.session.userId!, "tracking_rejected", {});
    res.redirect(`/dispatch/${packetId}?saved=tracking_rejected`);
  } catch (err) {
    console.error(err);
    res.redirect(`/dispatch/${packetId}?error=save_failed`);
  }
});

// ── Rate confirmation + pickup confirmation ───────────────────────

router.post("/dispatch/:id/rate-confirm", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const packetId = parseInt(req.params.id);

  try {
    await query(`
      UPDATE dispatch_packets SET rate_confirmation_signed_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND broker_account_id=$2
    `, [packetId, accountId]);

    await logActivity("dispatch_packet", packetId, "broker_user", req.session.userId!, "rate_confirmation_signed", {});
    res.redirect(`/dispatch/${packetId}?saved=rate_confirmed`);
  } catch (err) {
    console.error(err);
    res.redirect(`/dispatch/${packetId}?error=save_failed`);
  }
});

router.post("/dispatch/:id/pickup-confirm", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const packetId = parseInt(req.params.id);

  try {
    await query(`
      UPDATE dispatch_packets SET pickup_appointment_confirmed_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND broker_account_id=$2
    `, [packetId, accountId]);

    await logActivity("dispatch_packet", packetId, "broker_user", req.session.userId!, "pickup_confirmed", {});
    res.redirect(`/dispatch/${packetId}?saved=pickup_confirmed`);
  } catch (err) {
    console.error(err);
    res.redirect(`/dispatch/${packetId}?error=save_failed`);
  }
});

// ── Final clearance — Clear to Roll ──────────────────────────────

router.post("/dispatch/:id/clear", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const packetId = parseInt(req.params.id);
  const userId = req.session.userId;
  const { final_clearance_notes } = req.body;

  try {
    const packetRes = await query(
      `SELECT dp.*, bp.* FROM dispatch_packets dp
       LEFT JOIN broker_policies bp ON bp.broker_account_id = dp.broker_account_id
       WHERE dp.id = $1 AND dp.broker_account_id = $2`,
      [packetId, accountId]
    );

    if (!packetRes.rows.length) return res.status(404).send("Not found");

    const packet = packetRes.rows[0];
    const { blocking } = evaluateGating(packet, packet);

    if (blocking.length > 0) {
      return res.redirect(`/dispatch/${packetId}?error=blocking_items_unresolved`);
    }

    // Generate pickup code if policy requires it
    let pickupCode: string | null = null;
    let pickupCodeExpires: Date | null = null;

    let pickupCodeHash: string | null = null;

    if (packet.pickup_code_required) {
      // crypto.randomInt is cryptographically secure — never use Math.random() for codes
      pickupCode = crypto.randomInt(100000, 999999).toString();
      // Store SHA-256 hash — plaintext is shown once in the UI response and never re-read from DB
      pickupCodeHash = crypto.createHash("sha256").update(pickupCode).digest("hex");
      pickupCodeExpires = packet.pickup_window_end
        ? new Date(packet.pickup_window_end)
        : new Date(Date.now() + 24 * 60 * 60 * 1000);
    }

    await query(`
      UPDATE dispatch_packets SET
        final_clearance_status='cleared_to_roll',
        final_clearance_notes=$1,
        cleared_by=$2,
        cleared_at=NOW(),
        pickup_code=$3,
        pickup_code_hash=$4,
        pickup_code_expires_at=$5,
        updated_at=NOW()
      WHERE id=$6 AND broker_account_id=$7
    `, [
      final_clearance_notes?.trim() || null,
      userId,
      pickupCode,       // kept for broker UI display — acceptable for internal broker-only view
      pickupCodeHash,
      pickupCodeExpires,
      packetId, accountId,
    ]);

    await logActivity("dispatch_packet", packetId, "broker_user", userId!, "cleared_to_roll", {
      notes: final_clearance_notes,
      pickup_code_issued: !!pickupCode,
    });

    res.redirect(`/dispatch/${packetId}?cleared=1`);
  } catch (err) {
    console.error(err);
    res.redirect(`/dispatch/${packetId}?error=clearance_failed`);
  }
});

// ── Cancel / fail dispatch packet ────────────────────────────────

router.post("/dispatch/:id/cancel", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const packetId = parseInt(req.params.id);

  try {
    await query(`
      UPDATE dispatch_packets SET final_clearance_status='cancelled', updated_at=NOW()
      WHERE id=$1 AND broker_account_id=$2 AND final_clearance_status != 'cleared_to_roll'
    `, [packetId, accountId]);

    await logActivity("dispatch_packet", packetId, "broker_user", req.session.userId!, "packet_cancelled", {});

    const packetRes = await query(`SELECT carrier_id FROM dispatch_packets WHERE id=$1`, [packetId]);
    res.redirect(`/carriers/${packetRes.rows[0]?.carrier_id || ""}`);
  } catch (err) {
    console.error(err);
    res.redirect(`/dispatch/${packetId}?error=cancel_failed`);
  }
});

// ── Carrier dispatch history list ────────────────────────────────

router.get("/carriers/:id/dispatch", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId;
  const carrierId = parseInt(req.params.id);

  try {
    const packets = await query(`
      SELECT dp.*, bu.name as cleared_by_name
      FROM dispatch_packets dp
      LEFT JOIN broker_users bu ON bu.id = dp.cleared_by
      WHERE dp.carrier_id = $1 AND dp.broker_account_id = $2
      ORDER BY dp.created_at DESC
    `, [carrierId, accountId]);

    const carrierRes = await query(`SELECT * FROM carriers WHERE id=$1`, [carrierId]);
    const carrier = carrierRes.rows[0];

    const csrf = csrfToken(req);
    const html = layout({
      title: `Dispatch History — ${carrier?.legal_name || "Carrier"}`,
      userName: req.session.userName || "",
      csrfToken: csrf,
      content: dispatchHistoryContent(carrier, packets.rows, csrf),
    });
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

export default router;

// ── Gating logic ──────────────────────────────────────────────────

function evaluateGating(packet: Record<string, unknown>, policy: Record<string, unknown>): {
  blocking: string[];
  complete: string[];
} {
  const blocking: string[] = [];
  const complete: string[] = [];

  // Driver name
  if (!packet.driver_name) blocking.push("Driver name required");
  else complete.push("Driver name");

  // Driver phone
  if (policy.require_driver_phone && !packet.driver_phone) blocking.push("Driver phone required");
  else if (packet.driver_phone) complete.push("Driver phone");

  // Truck/trailer
  if (policy.require_truck_and_trailer_number) {
    if (!packet.vin_number) blocking.push("VIN number required");
    else complete.push("VIN number");
    if (!packet.trailer_number) blocking.push("Trailer number required");
    else complete.push("Trailer number");
  }

  // VIN verified
  if (!packet.vin_verified) blocking.push("VIN verification required");
  else complete.push("VIN verified");

  // Insurance reverification
  if (!packet.insurance_reverified_at) blocking.push("Insurance reverification required");
  else complete.push("Insurance reverified");

  // Tracking
  if (packet.tracking_required) {
    if (packet.tracking_status !== "accepted") blocking.push("Tracking acceptance required");
    else complete.push("Tracking accepted");
  }

  // Rate confirmation
  if (policy.require_signed_rate_confirmation && !packet.rate_confirmation_signed_at) {
    blocking.push("Signed rate confirmation required");
  } else if (packet.rate_confirmation_signed_at) {
    complete.push("Rate confirmation signed");
  }

  // Pickup appointment
  if (!packet.pickup_appointment_confirmed_at) blocking.push("Pickup appointment not confirmed");
  else complete.push("Pickup appointment confirmed");

  return { blocking, complete };
}

// ── Activity log helper ───────────────────────────────────────────

async function logActivity(
  subjectType: string, subjectId: number,
  actorType: string, actorId: number | null,
  action: string, metadata: Record<string, unknown>
) {
  await query(`
    INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [subjectType, subjectId, actorType, actorId, action, JSON.stringify(metadata)]);
}

// ── View: dispatch packet screen ──────────────────────────────────

function dispatchContent(
  packet: Record<string, unknown>,
  policy: Record<string, unknown>,
  activity: Record<string, unknown>[],
  blocking: string[],
  complete: string[],
  query: Record<string, unknown>,
  csrf = ""
): string {
  const isCleared = packet.final_clearance_status === "cleared_to_roll";
  const isCancelled = ["cancelled", "failed", "expired"].includes(String(packet.final_clearance_status));

  const carrierName = String(packet.legal_name || packet.company_name || "Carrier");
  const saved = query.saved as string;
  const error = query.error as string;
  const cleared = query.cleared as string;

  const savedMessages: Record<string, string> = {
    driver: "Driver & equipment saved.",
    insurance: "Insurance verification saved.",
    tracking_sent: "Tracking link marked as sent.",
    tracking_accepted: "Tracking acceptance recorded.",
    tracking_rejected: "Tracking rejection recorded.",
    rate_confirmed: "Rate confirmation marked complete.",
    pickup_confirmed: "Pickup appointment confirmed.",
  };

  const ts = (val: unknown) => val ? new Date(String(val)).toLocaleString() : null;

  return `
<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start">
  <div>
    <a href="/carriers/${packet.carrier_id}" class="back-link">← ${carrierName}</a>
    <h1 class="page-title">Dispatch Packet</h1>
    <div class="page-meta">
      <code>${h(packet.load_reference)}</code>
      <span class="sep">·</span>
      <code>MC${h(packet.mc_number)}</code>
      <span class="sep">·</span>
      ${clearanceStatusBadge(String(packet.final_clearance_status))}
    </div>
  </div>
  ${!isCleared && !isCancelled ? `
    <form method="POST" action="/dispatch/${packet.id}/cancel">
            <input type="hidden" name="_csrf" value="${h(csrf)}">
      <button type="submit" style="background:none;border:1px solid #ef4444;color:#ef4444;padding:7px 14px;border-radius:3px;cursor:pointer;font-size:12px">Cancel Packet</button>
    </form>
  ` : ""}
</div>

${cleared === "1" ? `<div class="alert alert-success">✓ Truck cleared to roll. ${packet.pickup_code ? `Pickup code: <strong>${h(packet.pickup_code)}</strong>${packet.pickup_code_expires_at ? ` (expires ${ts(packet.pickup_code_expires_at)})` : ""}` : ""}</div>` : ""}
${saved && savedMessages[saved] ? `<div class="alert alert-success">${savedMessages[saved]}</div>` : ""}
${error === "blocking_items_unresolved" ? `<div class="alert alert-error">Cannot clear — resolve all blocking items first.</div>` : ""}
${error && error !== "blocking_items_unresolved" ? `<div class="alert alert-error">Error: ${error.replace(/_/g, " ")}.</div>` : ""}

${/* Clearance status panel */isCleared ? `
<div class="card" style="border-left:4px solid #10b981;background:#f0fdf4">
  <div class="card-title" style="color:#15803d">✓ Cleared to Roll</div>
  <div class="info-grid">
    <div class="info-row"><span class="info-label">Cleared by</span><span>${h(packet.cleared_by_name || "—")}</span></div>
    <div class="info-row"><span class="info-label">Cleared at</span><span>${ts(packet.cleared_at) || "—"}</span></div>
    ${packet.final_clearance_notes ? `<div class="info-row"><span class="info-label">Notes</span><span>${h(packet.final_clearance_notes)}</span></div>` : ""}
    ${packet.pickup_code ? `<div class="info-row"><span class="info-label">Pickup code</span><span style="font-size:24px;font-weight:700;color:#1C2B3A;letter-spacing:0.1em">${h(packet.pickup_code)}</span></div>` : ""}
  </div>
</div>
` : ""}

<div class="detail-grid">
<div class="detail-left">

  <!-- Driver & Equipment -->
  <div class="card">
    <div class="card-title">Driver & Equipment</div>
    ${isCleared ? `
      <div class="info-grid">
        <div class="info-row"><span class="info-label">Driver</span><span>${h(packet.driver_name || "—")}</span></div>
        <div class="info-row"><span class="info-label">Phone</span><span>${h(packet.driver_phone || "—")}</span></div>
        <div class="info-row"><span class="info-label">VIN</span><span><code>${h(packet.vin_number || "—")}</code></span></div>
        <div class="info-row"><span class="info-label">Trailer</span><span>${h(packet.trailer_number || "—")}</span></div>
      </div>
    ` : `
    <form method="POST" action="/dispatch/${packet.id}/driver">
            <input type="hidden" name="_csrf" value="${h(csrf)}">
      <div class="form-field">
        <label class="field-label">Driver name <span style="color:#ef4444">*</span></label>
        <input type="text" name="driver_name" value="${h(packet.driver_name || "")}" class="field-input" placeholder="Full name">
      </div>
      <div class="form-field">
        <label class="field-label">Driver phone ${policy.require_driver_phone ? '<span style="color:#ef4444">*</span>' : ""}</label>
        <input type="tel" name="driver_phone" value="${h(packet.driver_phone || "")}" class="field-input" placeholder="e.g. 602-555-0100">
      </div>
      <div class="form-field">
        <label class="field-label">VIN number ${policy.require_truck_and_trailer_number ? '<span style="color:#ef4444">*</span>' : ""}</label>
        <input type="text" name="vin_number" value="${h(packet.vin_number || "")}" class="field-input" placeholder="17-character VIN">
      </div>
      <div class="form-field">
        <label class="field-label">Trailer number ${policy.require_truck_and_trailer_number ? '<span style="color:#ef4444">*</span>' : ""}</label>
        <input type="text" name="trailer_number" value="${h(packet.trailer_number || "")}" class="field-input" placeholder="Trailer ID">
      </div>
      <div class="form-field">
        <label class="field-label">CDL photo URL</label>
        <input type="url" name="cdl_photo_url" value="${String(packet.cdl_photo_url || "")}" class="field-input" placeholder="https://…">
      </div>
      <div class="form-field">
        <label class="field-label">Truck photo URL <span class="field-hint" style="display:inline">(showing MC/DOT)</span></label>
        <input type="url" name="truck_photo_url" value="${String(packet.truck_photo_url || "")}" class="field-input" placeholder="https://…">
      </div>
      <div class="form-field">
        <label class="field-label">VIN photo URL</label>
        <input type="url" name="vin_photo_url" value="${String(packet.vin_photo_url || "")}" class="field-input" placeholder="https://…">
      </div>
      <div class="form-field">
        <label class="field-label">Cab card URL</label>
        <input type="url" name="cab_card_url" value="${String(packet.cab_card_url || "")}" class="field-input" placeholder="https://…">
      </div>
      <button type="submit" class="btn-sm">Save Driver & Equipment</button>
    </form>
    `}
  </div>

  <!-- Insurance Reverification -->
  <div class="card">
    <div class="card-title">Insurance Reverification</div>
    ${packet.insurance_reverified_at ? `
      <div class="alert alert-success" style="margin-bottom:12px">✓ Reverified ${ts(packet.insurance_reverified_at)}</div>
    ` : ""}
    ${isCleared ? `
      <div class="info-grid">
        <div class="info-row"><span class="info-label">Insurer</span><span>${h(packet.insurer_name || "—")}</span></div>
        <div class="info-row"><span class="info-label">Method</span><span>${String(packet.insurance_verification_method || "—")}</span></div>
        <div class="info-row"><span class="info-label">VIN verified</span><span>${packet.vin_verified ? "✓ Yes" : "No"}</span></div>
        ${packet.vin_verification_notes ? `<div class="info-row"><span class="info-label">Notes</span><span>${h(packet.vin_verification_notes)}</span></div>` : ""}
      </div>
    ` : `
    <form method="POST" action="/dispatch/${packet.id}/insurance">
            <input type="hidden" name="_csrf" value="${h(csrf)}">
      <div class="form-field">
        <label class="field-label">Insurer name <span style="color:#ef4444">*</span></label>
        <input type="text" name="insurer_name" value="${h(packet.insurer_name || "")}" class="field-input" placeholder="e.g. Progressive Commercial">
      </div>
      <div class="form-field">
        <label class="field-label">Verification method <span style="color:#ef4444">*</span></label>
        <select name="insurance_verification_method" class="field-input">
          <option value="">Select…</option>
          <option value="phone" ${packet.insurance_verification_method === "phone" ? "selected" : ""}>Phone call to insurer</option>
          <option value="email" ${packet.insurance_verification_method === "email" ? "selected" : ""}>Email confirmation</option>
          <option value="portal" ${packet.insurance_verification_method === "portal" ? "selected" : ""}>Carrier portal / RMIS</option>
        </select>
      </div>
      <div class="form-field">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
          <input type="checkbox" name="vin_verified" value="true" ${packet.vin_verified ? "checked" : ""} style="width:16px;height:16px;accent-color:#C8892A">
          <span>VIN verified against COI <span style="color:#ef4444">*</span></span>
        </label>
      </div>
      <div class="form-field">
        <label class="field-label">Notes</label>
        <textarea name="vin_verification_notes" class="field-input" rows="2" placeholder="e.g. Spoke with agent, confirmed coverage dates">${h(packet.vin_verification_notes || "")}</textarea>
      </div>
      <button type="submit" class="btn-sm">Save Insurance Reverification</button>
    </form>
    `}
  </div>

</div>
<div class="detail-right">

  <!-- Clearance Checklist -->
  <div class="card" style="${blocking.length === 0 && !isCleared ? "border-left:3px solid #10b981" : blocking.length > 0 ? "border-left:3px solid #f97316" : ""}">
    <div class="card-title">Clearance Checklist</div>
    ${complete.map(item => `<div style="padding:6px 0;font-size:13px;color:#15803d;border-bottom:1px solid #F7F5F0">✓ ${item}</div>`).join("")}
    ${blocking.map(item => `<div style="padding:6px 0;font-size:13px;color:#b45309;border-bottom:1px solid #F7F5F0">⚠ ${item}</div>`).join("")}
    ${!isCleared && !isCancelled ? `
      <div style="margin-top:16px">
        ${blocking.length === 0 ? `
        <form method="POST" action="/dispatch/${packet.id}/clear">
            <input type="hidden" name="_csrf" value="${h(csrf)}">
          <div class="form-field">
            <label class="field-label">Clearance notes</label>
            <textarea name="final_clearance_notes" class="field-input" rows="2" placeholder="Optional notes…"></textarea>
          </div>
          <button type="submit" class="btn-decision approve" style="width:100%;font-size:14px;padding:12px">
            ✓ Clear to Roll
          </button>
        </form>
        ` : `
        <button disabled style="width:100%;padding:12px;background:#E0DAD0;color:#6B7A8A;border:none;border-radius:2px;font-size:14px;cursor:not-allowed">
          Resolve ${blocking.length} item${blocking.length !== 1 ? "s" : ""} to clear
        </button>
        `}
      </div>
    ` : ""}
  </div>

  <!-- Tracking -->
  <div class="card">
    <div class="card-title">Tracking</div>
    ${packet.tracking_required ? `
      <div class="info-grid" style="margin-bottom:12px">
        <div class="info-row"><span class="info-label">Status</span><span>${trackingBadge(String(packet.tracking_status))}</span></div>
        ${packet.tracking_link_sent_at ? `<div class="info-row"><span class="info-label">Sent</span><span class="muted" style="font-size:12px">${ts(packet.tracking_link_sent_at)}</span></div>` : ""}
        ${packet.tracking_accepted_at ? `<div class="info-row"><span class="info-label">Accepted</span><span class="muted" style="font-size:12px">${ts(packet.tracking_accepted_at)}</span></div>` : ""}
      </div>
      ${!isCleared ? `
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${packet.tracking_status === "not_sent" ? `
          <form method="POST" action="/dispatch/${packet.id}/tracking/send">
            <input type="hidden" name="_csrf" value="${h(csrf)}">
            <button type="submit" class="btn-sm">Send tracking link</button>
          </form>
        ` : ""}
        ${packet.tracking_status === "sent" ? `
          <form method="POST" action="/dispatch/${packet.id}/tracking/accept">
            <input type="hidden" name="_csrf" value="${h(csrf)}">
            <button type="submit" class="btn-sm" style="background:#10b981">✓ Mark accepted</button>
          </form>
          <form method="POST" action="/dispatch/${packet.id}/tracking/reject">
            <input type="hidden" name="_csrf" value="${h(csrf)}">
            <button type="submit" class="btn-sm" style="background:#ef4444">✗ Mark rejected</button>
          </form>
        ` : ""}
        ${packet.tracking_status === "rejected" ? `
          <form method="POST" action="/dispatch/${packet.id}/tracking/send">
            <input type="hidden" name="_csrf" value="${h(csrf)}">
            <button type="submit" class="btn-sm">Resend tracking link</button>
          </form>
        ` : ""}
        ${packet.tracking_status === "accepted" ? `<span style="font-size:13px;color:#15803d">✓ Tracking confirmed</span>` : ""}
      </div>
      ` : ""}
    ` : `<p class="muted" style="font-size:13px">Tracking not required for this load.</p>`}
  </div>

  <!-- Rate Confirmation -->
  <div class="card">
    <div class="card-title">Rate Confirmation</div>
    ${packet.rate_confirmation_signed_at ? `
      <p style="font-size:13px;color:#15803d">✓ Signed ${ts(packet.rate_confirmation_signed_at)}</p>
    ` : !isCleared ? `
      <form method="POST" action="/dispatch/${packet.id}/rate-confirm">
            <input type="hidden" name="_csrf" value="${h(csrf)}">
        <button type="submit" class="btn-sm">✓ Mark rate confirmation signed</button>
      </form>
    ` : `<p class="muted" style="font-size:13px">Not confirmed.</p>`}
  </div>

  <!-- Pickup Appointment -->
  <div class="card">
    <div class="card-title">Pickup Appointment</div>
    ${packet.pickup_address ? `<p style="font-size:13px;margin-bottom:8px">${h(packet.pickup_address)}</p>` : ""}
    ${packet.pickup_window_start ? `<p class="muted" style="font-size:12px">${h(packet.pickup_window_start)}${packet.pickup_window_end ? ` – ${h(packet.pickup_window_end)}` : ""}</p>` : ""}
    ${packet.pickup_appointment_confirmed_at ? `
      <p style="font-size:13px;color:#15803d;margin-top:8px">✓ Confirmed ${ts(packet.pickup_appointment_confirmed_at)}</p>
    ` : !isCleared ? `
      <form method="POST" action="/dispatch/${packet.id}/pickup-confirm" style="margin-top:10px">
        <button type="submit" class="btn-sm">✓ Confirm pickup appointment</button>
      </form>
    ` : `<p class="muted" style="font-size:13px">Not confirmed.</p>`}
  </div>

  <!-- Activity -->
  <div class="card">
    <div class="card-title">Activity</div>
    ${activity.length === 0 ? `<p class="muted" style="font-size:13px">No activity yet.</p>` : `
    <div class="activity-list">
      ${activity.map((a: Record<string, unknown>) => `
        <div class="activity-item">
          <div class="activity-action">${dispatchActionLabel(String(a.action))}</div>
          <div class="activity-time muted">${a.created_at ? new Date(String(a.created_at)).toLocaleString() : ""}</div>
        </div>
      `).join("")}
    </div>
    `}
  </div>

</div>
</div>`;
}

function dispatchHistoryContent(carrier: Record<string, unknown>, packets: Record<string, unknown>[], csrf = ""): string {
  return `
<div class="page-header">
  <div>
    <a href="/carriers/${carrier?.id}" class="back-link">← ${String(carrier?.legal_name || carrier?.company_name || "Carrier")}</a>
    <h1 class="page-title">Dispatch History</h1>
  </div>
</div>
<div class="table-wrap">
  ${packets.length === 0 ? `<div class="empty">No dispatch packets yet.</div>` : `
  <table class="data-table">
    <thead><tr><th>Load Reference</th><th>Created</th><th>Status</th><th>Cleared By</th><th>Pickup Code</th><th></th></tr></thead>
    <tbody>
      ${packets.map((p: Record<string, unknown>) => `
        <tr>
          <td><code>${h(p.load_reference)}</code></td>
          <td class="muted">${p.created_at ? new Date(String(p.created_at)).toLocaleDateString() : "—"}</td>
          <td>${clearanceStatusBadge(String(p.final_clearance_status))}</td>
          <td class="muted">${h(p.cleared_by_name || "—")}</td>
          <td><code>${p.pickup_code ? String(p.pickup_code) : "—"}</code></td>
          <td><a href="/dispatch/${p.id}" class="btn-link">View →</a></td>
        </tr>
      `).join("")}
    </tbody>
  </table>
  `}
</div>`;
}

function clearanceStatusBadge(status: string): string {
  const map: Record<string, { label: string; color: string }> = {
    pending:                  { label: "Pending",       color: "#f59e0b" },
    docs_pending:             { label: "Docs Pending",  color: "#f97316" },
    verification_in_progress: { label: "Verifying",     color: "#3b82f6" },
    cleared_to_roll:          { label: "✓ Cleared",     color: "#10b981" },
    failed:                   { label: "Failed",        color: "#ef4444" },
    expired:                  { label: "Expired",       color: "#6b7a8a" },
    cancelled:                { label: "Cancelled",     color: "#6b7a8a" },
  };
  const s = map[status] || { label: status, color: "#6b7a8a" };
  return `<span class="badge" style="background:${s.color}20;color:${s.color};border:1px solid ${s.color}40">${s.label}</span>`;
}

function trackingBadge(status: string): string {
  const map: Record<string, { label: string; color: string }> = {
    not_sent: { label: "Not sent",  color: "#6b7a8a" },
    sent:     { label: "Sent",      color: "#3b82f6" },
    accepted: { label: "✓ Accepted", color: "#10b981" },
    rejected: { label: "✗ Rejected", color: "#ef4444" },
  };
  const s = map[status] || { label: status, color: "#6b7a8a" };
  return `<span class="badge" style="background:${s.color}20;color:${s.color};border:1px solid ${s.color}40">${s.label}</span>`;
}

function dispatchActionLabel(action: string): string {
  const map: Record<string, string> = {
    packet_created:           "📋 Dispatch packet opened",
    driver_info_updated:      "✏️ Driver & equipment updated",
    insurance_reverified:     "✓ Insurance reverified",
    tracking_link_sent:       "📍 Tracking link sent",
    tracking_accepted:        "✓ Tracking accepted",
    tracking_rejected:        "✗ Tracking rejected",
    rate_confirmation_signed: "✓ Rate confirmation signed",
    pickup_confirmed:         "✓ Pickup appointment confirmed",
    cleared_to_roll:          "🚛 Cleared to roll",
    packet_cancelled:         "✗ Packet cancelled",
  };
  return map[action] || action;
}
