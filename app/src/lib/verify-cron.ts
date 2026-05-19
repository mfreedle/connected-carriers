// ── Verification Time-Boxing Cron ────────────────────────────────
// Runs every 5 minutes. Three escalation tiers:
//
// TO CARRIER:
//   15 min, no response → one follow-up SMS (reminder_count < 1)
//
// TO BROKER:
//   30 min, no response → CAUTION notification
//   60 min OR deadline  → DO NOT USE notification
//
// Carrier gets exactly 2 messages total (initial + 1 reminder).
// Silence = signal. We don't chase.

import { query } from "../db";
import { sendSms } from "../lib/sms";

const BASE_URL = process.env.BASE_URL || "https://app.connectedcarriers.org";
const CRON_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function startVerificationCron(): void {
  console.log("[VERIFY-CRON] Starting verification time-boxing cron (every 5 min)");
  setInterval(runVerificationCron, CRON_INTERVAL_MS);
  setInterval(runDecPageEscalationCron, CRON_INTERVAL_MS);
  // Also run once on startup after a short delay
  setTimeout(runVerificationCron, 10_000);
  setTimeout(runDecPageEscalationCron, 15_000);
}

async function runVerificationCron(): Promise<void> {
  try {
    // Get all active (pending or in_progress) verifications
    const result = await query(`
      SELECT * FROM carrier_verifications 
      WHERE status IN ('pending', 'in_progress')
      ORDER BY created_at ASC
    `);

    const now = Date.now();
    let processed = 0;

    for (const v of result.rows) {
      const createdAt = new Date(v.created_at).getTime();
      const elapsed = now - createdAt;
      const elapsedMin = elapsed / 60_000;
      const deadline = v.deadline ? new Date(v.deadline).getTime() : null;
      const pastDeadline = deadline ? now >= deadline : false;

      const verifyUrl = `${BASE_URL}/v/${v.token}`;
      const brokerLabel = v.broker_name || "A broker";

      // ── TIER 1: Carrier reminder (15 min, no response, reminder_count < 1)
      if (
        elapsedMin >= 15 &&
        !v.carrier_first_response_at &&
        (v.reminder_count || 0) < 1 &&
        v.carrier_phone
      ) {
	      const reminderMsg = [
	        `Connected Carriers for ${brokerLabel}: Reminder, verification is still needed before dispatch.`,
	        ``,
	        `Complete here:`,
	        `${verifyUrl}`,
          ``,
          `Or reply to this text with photos of:`,
          `• CDL`,
          `• Insurance (COI)`,
	        `• Cab card`,
	        ``,
	        `No verification = no dispatch.`,
	        `Standard message and data rates may apply. Reply STOP to opt out.`,
	      ].join("\n");

        const smsResult = await sendSms(v.carrier_phone, reminderMsg);
        await query(
          `UPDATE carrier_verifications SET reminder_count = COALESCE(reminder_count, 0) + 1, last_reminder_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [v.id]
        );
        console.log(`[VERIFY-CRON] Sent carrier reminder for MC#${v.mc_number} (${smsResult.sent ? "delivered" : "failed"})`);
        processed++;
      }

      // ── TIER 2: Broker CAUTION (30 min, no carrier response)
      if (
        elapsedMin >= 30 &&
        !v.carrier_first_response_at &&
        !v.caution_sent_at &&
        v.broker_phone
      ) {
        // Build what's missing
        const missing: string[] = [];
        if (!v.doc_cdl) missing.push("CDL");
        if (!v.doc_insurance) missing.push("Insurance");
        if (!v.doc_cab_card) missing.push("Cab card");
        if (!v.doc_truck_photo) missing.push("Truck photo");

        const cautionMsg = `MC#${v.mc_number} — CAUTION\n\nCarrier has not responded to verification request.\n\nMissing: ${missing.length > 0 ? missing.join(", ") : "all documents"}\n\nView: ${verifyUrl}/report`;

        const smsResult = await sendSms(v.broker_phone, cautionMsg);
        await query(
          `UPDATE carrier_verifications SET caution_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [v.id]
        );
        console.log(`[VERIFY-CRON] Sent broker CAUTION for MC#${v.mc_number} (${smsResult.sent ? "delivered" : "failed"})`);
        processed++;
      }

      // ── TIER 2b: Broker CAUTION for partial submission (30 min, some docs missing)
      if (
        elapsedMin >= 30 &&
        v.carrier_first_response_at &&
        !v.caution_sent_at &&
        v.status === "in_progress" &&
        v.broker_phone
      ) {
        const missing: string[] = [];
        if (!v.doc_cdl) missing.push("CDL");
        if (!v.doc_insurance) missing.push("Insurance");
        if (!v.doc_cab_card) missing.push("Cab card");
        if (!v.doc_truck_photo) missing.push("Truck photo");

        if (missing.length > 0) {
          const cautionMsg = `MC#${v.mc_number} — CAUTION\n\nCarrier responded but submission is incomplete.\n\nMissing: ${missing.join(", ")}\n\nView: ${verifyUrl}/report`;

          const smsResult = await sendSms(v.broker_phone, cautionMsg);
          await query(
            `UPDATE carrier_verifications SET caution_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [v.id]
          );
          console.log(`[VERIFY-CRON] Sent broker CAUTION (partial) for MC#${v.mc_number} (${smsResult.sent ? "delivered" : "failed"})`);
          processed++;
        }
      }

      // ── TIER 3: DO NOT USE (60 min OR past deadline, no complete submission)
      if (
        (elapsedMin >= 60 || pastDeadline) &&
        !v.dnu_sent_at &&
        v.status !== "complete"
      ) {
        const reasons: string[] = [];
        if (!v.carrier_first_response_at) {
          reasons.push("Carrier did not respond to verification request");
        } else {
          const missing: string[] = [];
          if (!v.doc_cdl) missing.push("CDL");
          if (!v.doc_insurance) missing.push("Insurance");
          if (!v.doc_cab_card) missing.push("Cab card");
          if (!v.doc_truck_photo) missing.push("Truck photo");
          if (missing.length > 0) reasons.push(`Incomplete submission — missing: ${missing.join(", ")}`);
        }

        if (pastDeadline) reasons.push("Deadline exceeded");

        // Update status
        await query(
          `UPDATE carrier_verifications SET status = 'complete', result = 'DO_NOT_USE', result_reasons = $1, result_delivered_at = NOW(), dnu_sent_at = NOW(), updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(reasons), v.id]
        );

        // Notify broker
        if (v.broker_phone) {
          const dnuMsg = `MC#${v.mc_number} — DO NOT USE\n\n${reasons.join(". ")}.\n\nView: ${verifyUrl}/report`;
          const smsResult = await sendSms(v.broker_phone, dnuMsg);
          console.log(`[VERIFY-CRON] Sent broker DO NOT USE for MC#${v.mc_number} (${smsResult.sent ? "delivered" : "failed"})`);
        }
        processed++;
      }
    }

    if (processed > 0) {
      console.log(`[VERIFY-CRON] Processed ${processed} escalations across ${result.rows.length} active verifications`);
    }
  } catch (err) {
    console.error("[VERIFY-CRON] Error:", err);
  }
}

// ── Dec Page Escalation Cron ──────────────────────────────────────
// Watches load_assignments with status = 'needs_dec_page'.
// Three tiers:
//   15 min → carrier reminder SMS (one only)
//   30 min → broker notification
//   60 min → finalize as dec_page_no_response, broker notified
//
// Carrier gets exactly 2 messages (initial request + 1 reminder).
// Silence = signal. Do not dispatch until resolved.

async function runDecPageEscalationCron(): Promise<void> {
  try {
    const result = await query(`
      SELECT la.id, la.load_id, la.carrier_id, la.driver_id, la.broker_account_id,
             la.confirmation_token, la.dec_page_requested_at, la.dec_page_reminder_count,
             la.dec_page_escalated_at, la.dec_page_finalized_at,
             cl.load_id as cl_load_id, cl.origin, cl.destination,
             c.mc_number, c.fmcsa_legal_name,
             ba.contact_phone as broker_phone
      FROM load_assignments la
      JOIN canonical_loads cl ON cl.id = la.load_id
      JOIN carriers c ON c.id = la.carrier_id
      JOIN broker_accounts ba ON ba.id = la.broker_account_id
      WHERE la.status = 'needs_dec_page'
        AND la.dec_page_requested_at IS NOT NULL
      ORDER BY la.dec_page_requested_at ASC
    `);

    const now = Date.now();
    let processed = 0;

    for (const la of result.rows) {
      const requestedAt = new Date(la.dec_page_requested_at).getTime();
      const elapsedMin = (now - requestedAt) / 60_000;
      const carrierName = la.fmcsa_legal_name || `MC${la.mc_number}`;
      const loadLabel = la.cl_load_id || `load ${la.load_id}`;

      // ── Resolve carrier contact phone ───────────────────────────
      let carrierPhone: string | null = null;
      if (la.driver_id) {
        try {
          const dr = await query("SELECT driver_phone FROM carrier_drivers WHERE id = $1", [la.driver_id]);
          carrierPhone = dr.rows[0]?.driver_phone || null;
        } catch { /* non-fatal */ }
      }
      if (!carrierPhone) {
        try {
          const app = await query(
            "SELECT contact_phone FROM canonical_load_applications WHERE load_id = $1 AND carrier_id = $2",
            [la.load_id, la.carrier_id]
          );
          carrierPhone = app.rows[0]?.contact_phone || null;
        } catch { /* non-fatal */ }
      }

      // ── TIER 3: Finalize (≥60 min, not yet finalized) ───────────
      // Check first to avoid sending lower-tier SMS on the same run
      if (
        elapsedMin >= 60 &&
        !la.dec_page_finalized_at
      ) {
        // Status guard: only finalize if still needs_dec_page (prevents race with late upload)
        const updateResult = await query(
          `UPDATE load_assignments SET status = 'dec_page_no_response', dec_page_finalized_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'needs_dec_page' RETURNING id`,
          [la.id]
        );

        if (updateResult.rows.length > 0) {
          await query(
            `UPDATE canonical_loads SET status = 'no_response', updated_at = NOW() WHERE id = $1`,
            [la.load_id]
          );

          if (la.broker_phone) {
            const finalMsg = `Connected Carriers: ${carrierName} — no declarations page received for ${loadLabel}. DO NOT DISPATCH until resolved. Carrier did not provide insurance vehicle schedule within the verification window.`;
            const smsResult = await sendSms(la.broker_phone, finalMsg);
            console.log(`[DEC-PAGE-CRON] Finalized ${carrierName} / ${loadLabel} as no_response (broker SMS ${smsResult.sent ? "delivered" : "failed"})`);
          } else {
            console.log(`[DEC-PAGE-CRON] Finalized ${carrierName} / ${loadLabel} as no_response (no broker phone)`);
          }
          processed++;
        } else {
          console.log(`[DEC-PAGE-CRON] Skipped finalize for ${carrierName} / ${loadLabel} — status already changed`);
        }
        continue; // finalized — skip lower tiers for this row
      }

      // ── TIER 2: Broker notification (≥30 min, not yet escalated) ──
      if (
        elapsedMin >= 30 &&
        !la.dec_page_escalated_at &&
        la.broker_phone
      ) {
        const minutesAgo = Math.round(elapsedMin);
        const brokerMsg = `Connected Carriers: ${carrierName} — declarations page not yet received for ${loadLabel}. Carrier was asked ${minutesAgo} minutes ago. Do not dispatch until resolved.`;

        const smsResult = await sendSms(la.broker_phone, brokerMsg);
        await query(
          `UPDATE load_assignments SET dec_page_escalated_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [la.id]
        );
        console.log(`[DEC-PAGE-CRON] Sent broker notice for ${carrierName} / ${loadLabel} (${smsResult.sent ? "delivered" : "failed"})`);
        processed++;
      }

      // ── TIER 1: Carrier reminder (≥15 min, reminder_count < 1) ──
      if (
        elapsedMin >= 15 &&
        (la.dec_page_reminder_count || 0) < 1 &&
        carrierPhone &&
        la.confirmation_token
      ) {
        const decPageUrl = `${BASE_URL}/confirm/${la.confirmation_token}/dec-page`;
        const reminderMsg = [
          `Connected Carriers: Reminder — one more document needed for ${loadLabel}.`,
          ``,
          `Please upload your insurance declarations page:`,
          `${decPageUrl}`,
          ``,
          `No document = cannot dispatch.`,
          `Standard message and data rates may apply. Reply STOP to opt out.`,
        ].join("\n");

        const smsResult = await sendSms(carrierPhone, reminderMsg);
        await query(
          `UPDATE load_assignments SET dec_page_reminder_count = COALESCE(dec_page_reminder_count, 0) + 1, dec_page_last_reminder_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [la.id]
        );
        console.log(`[DEC-PAGE-CRON] Sent carrier reminder for ${carrierName} / ${loadLabel} (${smsResult.sent ? "delivered" : "failed"})`);
        processed++;
      }
    }

    if (processed > 0) {
      console.log(`[DEC-PAGE-CRON] Processed ${processed} escalations across ${result.rows.length} pending dec page requests`);
    }
  } catch (err) {
    console.error("[DEC-PAGE-CRON] Error:", err);
  }
}
