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
  // Also run once on startup after a short delay
  setTimeout(runVerificationCron, 10_000);
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
          `Reminder: ${brokerLabel} is still waiting on your verification.`,
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
