/**
 * Verification service — core verify trigger logic.
 *
 * Called by:
 *   - POST /api/verify/trigger (public route, thin wrapper)
 *   - POST /api/v2/loads/:slug/assign (assignment automation)
 *
 * Does NOT write HTTP responses. Returns a result object.
 */

import crypto from "crypto";
import { query } from "../db";
import { sendSms } from "../lib/sms";
import { lookupFMCSA, FMCSAResult } from "../lib/fmcsa";
import { findOrCreateCarrier, updateCarrierFMCSA } from "../carrier-identity";

const BASE_URL = process.env.BASE_URL || "https://app.connectedcarriers.org";

function genToken(): string {
  return crypto.randomBytes(12).toString("base64url");
}

// ── Input type ────────────────────────────────────────────────────

export interface VerificationTriggerInput {
  mc_number: string;
  carrier_phone?: string;
  carrier_email?: string;
  carrier_name?: string;
  broker_name?: string;
  broker_phone?: string;
  broker_email?: string;
  broker_account_id?: number;
  deadline_minutes?: number;
}

// ── Result type ───────────────────────────────────────────────────

export interface VerificationTriggerResult {
  id: number;
  token: string;
  carrier_id: number;
  status: "pending" | "complete";
  result?: "DO_NOT_USE";
  reasons?: string[];
  fmcsa_status: string;
  fmcsa: FMCSAResult;
  verify_url: string;
  sms_sent: boolean;
  email_sent: boolean;
  deadline: string;
}

// ── Core service function ─────────────────────────────────────────

export async function triggerCarrierVerification(input: VerificationTriggerInput): Promise<VerificationTriggerResult> {
  const { mc_number, carrier_phone, carrier_email, carrier_name,
          broker_name, broker_phone, broker_email, broker_account_id,
          deadline_minutes } = input;

  if (!mc_number) throw new Error("mc_number is required");
  if (!carrier_phone && !carrier_email) throw new Error("carrier_phone or carrier_email is required");

  const token = genToken();
  const deadlineMin = deadline_minutes || 90;
  const deadline = new Date(Date.now() + deadlineMin * 60 * 1000);

  // Step 1: FMCSA auto-check
  let fmcsaData: FMCSAResult = { mc_number: mc_number.replace(/\D/g, ""), found: false };
  let fmcsaStatus = "unknown";
  try {
    fmcsaData = await lookupFMCSA(mc_number);
    const usdotStatus = String(fmcsaData.usdot_status || "").toUpperCase();
    const authStatus = String(fmcsaData.operating_status || "").toUpperCase();
    if (!fmcsaData.found) fmcsaStatus = "not_found";
    else if (usdotStatus !== "ACTIVE") fmcsaStatus = "inactive";
    else if (!authStatus.includes("AUTHORIZED")) fmcsaStatus = "not_authorized";
    else fmcsaStatus = "active";
  } catch (err) {
    fmcsaStatus = "error";
    console.error("[VERIFY-SVC] FMCSA lookup error:", err);
  }

  // Step 2: Resolve carrier identity
  const mcClean = mc_number.replace(/\D/g, "");
  const carrier = await findOrCreateCarrier(mcClean);

  // Update carrier with FMCSA data
  if (fmcsaData.found) {
    await updateCarrierFMCSA(carrier.id, {
      fmcsa_legal_name: (fmcsaData.entity_name as string) || (fmcsaData.legal_name as string),
      dot_number: (fmcsaData.usdot_number as string) || (fmcsaData.dot_number as string),
      fmcsa_status: fmcsaData.usdot_status as string,
      authority_status: fmcsaData.operating_status as string,
      safety_rating: fmcsaData.safety_rating as string,
      phone: fmcsaData.phone as string,
    });
  }

  // Step 3: Create verification record
  const result = await query(`
    INSERT INTO carrier_verifications
      (token, broker_account_id, broker_name, broker_phone, broker_email,
       mc_number, carrier_phone, carrier_email, carrier_name,
       fmcsa_data, fmcsa_status, deadline, status, carrier_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)
    RETURNING id, token
  `, [token, broker_account_id || null, broker_name || null, broker_phone || null, broker_email || null,
      mcClean, carrier_phone || null, carrier_email || null, carrier_name || null,
      JSON.stringify(fmcsaData), fmcsaStatus, deadline, carrier.id]);

  const verificationId = result.rows[0].id;
  const verifyUrl = `${BASE_URL}/v/${token}`;

  // Step 4: If FMCSA hard-fail, mark DO_NOT_USE immediately
  if (fmcsaStatus === "not_found" || fmcsaStatus === "inactive" || fmcsaStatus === "not_authorized") {
    const reasons: string[] = [];
    if (fmcsaStatus === "not_found") reasons.push("Carrier not found in FMCSA database");
    if (fmcsaStatus === "inactive") reasons.push(`USDOT status: ${fmcsaData.usdot_status}`);
    if (fmcsaStatus === "not_authorized") reasons.push(`Operating authority: ${fmcsaData.operating_status}`);

    await query(
      `UPDATE carrier_verifications SET status='complete', result='DO_NOT_USE', result_reasons=$1, result_delivered_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(reasons), verificationId]
    );

    await query(
      "UPDATE carriers SET latest_verification_id = $1, updated_at = NOW() WHERE id = $2",
      [verificationId, carrier.id]
    );

    return {
      id: verificationId,
      token,
      carrier_id: carrier.id,
      status: "complete",
      result: "DO_NOT_USE",
      reasons,
      fmcsa_status: fmcsaStatus,
      fmcsa: fmcsaData,
      verify_url: verifyUrl,
      sms_sent: false,
      email_sent: false,
      deadline: deadline.toISOString(),
    };
  }

  // Step 5: Send carrier verification request
  const brokerLabel = broker_name || "A broker";
  const carrierMsg = `Connected Carriers for ${brokerLabel}: Verification required before dispatch.\n\nComplete here: ${verifyUrl}\n\nTakes ~2 min. Standard message and data rates may apply. Reply STOP to opt out.`;

  let smsSent = false;
  let emailSent = false;

  if (carrier_phone) {
    const smsResult = await sendSms(carrier_phone, carrierMsg);
    smsSent = smsResult.sent;
    if (smsSent) {
      await query(`UPDATE carrier_verifications SET sms_sent_at=NOW(), updated_at=NOW() WHERE id=$1`, [verificationId]);
    }
  }

  if (carrier_email) {
    console.log(`[VERIFY-SVC] Would send email to ${carrier_email}: ${verifyUrl}`);
    // emailSent = await sendVerificationEmail(carrier_email, brokerLabel, verifyUrl);
  }

  return {
    id: verificationId,
    token,
    carrier_id: carrier.id,
    status: "pending",
    fmcsa_status: fmcsaStatus,
    fmcsa: fmcsaData,
    verify_url: verifyUrl,
    sms_sent: smsSent,
    email_sent: emailSent,
    deadline: deadline.toISOString(),
  };
}
