import { Router } from "express";
import crypto from "crypto";
import multer from "multer";
import { query } from "../db";
import { sendSms } from "../lib/sms";
import { uploadToR2, getPresignedDownloadUrl } from "../lib/storage";
import { parseCDL, parseInsurance, parseVINPhoto, checkDocFlags } from "../doc-parser";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const BASE_URL = process.env.BASE_URL || "https://app.connectedcarriers.org";

// ── HELPER: Generate a short, URL-safe token ───────────────────
function genToken(): string {
  return crypto.randomBytes(12).toString("base64url");
}

// ── HELPER: FMCSA lookup (reuse MCP server's pattern) ──────────
async function lookupFMCSA(mc: string): Promise<Record<string, unknown>> {
  const clean = mc.replace(/\D/g, "");
  const url = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=MC_MX&query_string=${clean}&action=get_data`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`FMCSA returned ${resp.status}`);
  const html = await resp.text();

  if (html.includes("No records found") || html.includes("no records found")) {
    return { mc_number: clean, found: false, active: false, source: "FMCSA SAFER" };
  }

  const rowData: Record<string, string> = {};
  const trPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trPattern.exec(html)) !== null) {
    const cells: string[] = [];
    const tdPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdPattern.exec(trMatch[1])) !== null) {
      const text = tdMatch[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
      if (text) cells.push(text);
    }
    for (let i = 0; i < cells.length - 1; i += 2) {
      const label = cells[i].replace(/:?\s*$/, "").trim();
      const value = cells[i + 1].trim();
      if (label && value) rowData[label] = value;
    }
  }

  return {
    mc_number: clean,
    found: true,
    legal_name: rowData["Legal Name"] || rowData["Entity"] || null,
    dba_name: rowData["DBA Name"] || null,
    dot_number: rowData["USDOT Number"] || null,
    usdot_status: rowData["USDOT Status"] || null,
    operating_status: rowData["Operating Authority Status"] || null,
    entity_type: rowData["Entity Type"] || rowData["Carrier Operation"] || null,
    physical_address: rowData["Physical Address"] || null,
    phone: rowData["Phone"] || null,
    mailing_address: rowData["Mailing Address"] || null,
    power_units: rowData["Power Units"] || null,
    drivers: rowData["Drivers"] || null,
    safety_rating: rowData["Rating"] || rowData["Safety Rating"] || null,
    insurance_bipd: rowData["BIPD/Primary"] || rowData["Required"] || null,
    source: "FMCSA SAFER",
    checked_at: new Date().toISOString(),
    raw: rowData,
  };
}

// ── HELPER: VIN decode via NHTSA ───────────────────────────────
async function decodeVIN(vin: string): Promise<Record<string, unknown> | null> {
  try {
    const clean = vin.replace(/[^a-zA-Z0-9]/g, "");
    if (clean.length !== 17) return null;
    const resp = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${clean}?format=json`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { Results?: Array<{ Variable: string; Value: string | null }> };
    const results: Record<string, string> = {};
    for (const r of data.Results || []) {
      if (r.Value && r.Value.trim() && r.Value !== "Not Applicable") {
        results[r.Variable] = r.Value.trim();
      }
    }
    return {
      vin: clean,
      year: results["Model Year"] || null,
      make: results["Make"] || null,
      model: results["Model"] || null,
      vehicle_type: results["Vehicle Type"] || null,
      body_class: results["Body Class"] || null,
      gvwr: results["Gross Vehicle Weight Rating From"] || null,
    };
  } catch {
    return null;
  }
}

// ── HELPER: Compute result based on current verification state ──
function computeResult(v: Record<string, unknown>): { result: string; reasons: string[] } {
  const reasons: string[] = [];

  // FMCSA checks
  const fmcsa = v.fmcsa_data as Record<string, unknown> | null;
  if (!fmcsa || !fmcsa.found) {
    reasons.push("Carrier not found in FMCSA database");
    return { result: "DO_NOT_USE", reasons };
  }
  const status = String(fmcsa.usdot_status || "").toUpperCase();
  if (status !== "ACTIVE") {
    reasons.push(`USDOT status: ${status}`);
    return { result: "DO_NOT_USE", reasons };
  }
  const authStatus = String(fmcsa.operating_status || "").toUpperCase();
  if (!authStatus.includes("AUTHORIZED")) {
    reasons.push(`Operating authority: ${fmcsa.operating_status}`);
    return { result: "DO_NOT_USE", reasons };
  }

  // Document checks
  if (!v.doc_cdl) reasons.push("CDL not provided");
  if (!v.doc_insurance) reasons.push("Insurance document not provided");
  if (!v.doc_cab_card) reasons.push("Cab card not provided");
  if (!v.doc_truck_photo) reasons.push("Truck photo not provided");

  // Non-response
  if (!v.carrier_first_response_at) {
    reasons.push("Carrier did not respond to verification request");
    return { result: "DO_NOT_USE", reasons };
  }

  // OCR-based checks (from doc_flags)
  const flags = v.doc_flags as string[] || [];
  let hasCriticalFlag = false;
  for (const flag of flags) {
    if (flag === "INSURANCE_EXPIRED") { reasons.push("Insurance policy is expired"); hasCriticalFlag = true; }
    else if (flag === "CDL_EXPIRED") { reasons.push("CDL is expired"); hasCriticalFlag = true; }
    else if (flag === "VIN_NOT_ON_INSURANCE") { reasons.push("Truck VIN does not match any VIN on insurance policy"); hasCriticalFlag = true; }
    else if (flag === "INSURANCE_EXPIRING_7_DAYS") reasons.push("Insurance expires within 7 days");
    else if (flag === "INSURANCE_EXPIRING_30_DAYS") reasons.push("Insurance expires within 30 days");
    else if (flag === "CDL_EXPIRING_30_DAYS") reasons.push("CDL expires within 30 days");
  }

  if (hasCriticalFlag) return { result: "DO_NOT_USE", reasons };

  // CDL name vs driver name cross-reference
  if (v.cdl_name && v.driver_name) {
    const cdlName = String(v.cdl_name).toUpperCase().trim();
    const driverName = String(v.driver_name).toUpperCase().trim();
    if (cdlName && driverName && !cdlName.includes(driverName.split(" ")[0]) && !driverName.includes(cdlName.split(" ")[0])) {
      reasons.push(`Driver name (${v.driver_name}) may not match CDL name (${v.cdl_name})`);
    }
  }

  if (reasons.length === 0) {
    const positives = ["All documents provided", "FMCSA authority active"];
    if (v.parsed_cdl) positives.push("CDL verified via OCR");
    if (v.parsed_insurance) positives.push("Insurance verified via OCR");
    if (v.parsed_vin && v.insurance_vins) positives.push("VIN matches insurance policy");
    return { result: "CLEAR", reasons: positives };
  }
  return { result: "CAUTION", reasons };
}

// ── HELPER: Run OCR on uploaded documents and update verification record ──
async function runOCR(verificationId: number): Promise<void> {
  try {
    const result = await query(`SELECT * FROM carrier_verifications WHERE id=$1`, [verificationId]);
    if (result.rows.length === 0) return;
    const v = result.rows[0];

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramCount = 0;

    // OCR the CDL
    if (v.doc_cdl && !v.parsed_cdl) {
      try {
        const cdlUrl = await getPresignedDownloadUrl(v.doc_cdl, 120);
        const parsed = await parseCDL(cdlUrl);
        if (parsed && Object.keys(parsed).length > 0) {
          paramCount++; updates.push(`parsed_cdl=$${paramCount}`); values.push(JSON.stringify(parsed));
          if (parsed.driver_name) { paramCount++; updates.push(`cdl_name=$${paramCount}`); values.push(parsed.driver_name); }
          if (parsed.cdl_number) { paramCount++; updates.push(`cdl_number=$${paramCount}`); values.push(parsed.cdl_number); }
          if (parsed.state) { paramCount++; updates.push(`cdl_state=$${paramCount}`); values.push(parsed.state); }
          if (parsed.expiration_date) { paramCount++; updates.push(`cdl_expiration=$${paramCount}`); values.push(parsed.expiration_date); }
          console.log(`[VERIFY-OCR] CDL parsed for MC#${v.mc_number}: ${parsed.driver_name || "?"}, exp ${parsed.expiration_date || "?"}`);
        }
      } catch (err) { console.error("[VERIFY-OCR] CDL parse error:", err); }
    }

    // OCR the insurance
    if (v.doc_insurance && !v.parsed_insurance) {
      try {
        const insUrl = await getPresignedDownloadUrl(v.doc_insurance, 120);
        const parsed = await parseInsurance(insUrl);
        if (parsed && Object.keys(parsed).length > 0) {
          paramCount++; updates.push(`parsed_insurance=$${paramCount}`); values.push(JSON.stringify(parsed));
          if (parsed.expiration_date) { paramCount++; updates.push(`insurance_expiration=$${paramCount}`); values.push(parsed.expiration_date); }
          if (parsed.insurance_company) { paramCount++; updates.push(`insurance_company=$${paramCount}`); values.push(parsed.insurance_company); }
          if (parsed.policy_number) { paramCount++; updates.push(`insurance_policy_number=$${paramCount}`); values.push(parsed.policy_number); }
          if (parsed.vins && parsed.vins.length > 0) { paramCount++; updates.push(`insurance_vins=$${paramCount}`); values.push(JSON.stringify(parsed.vins)); }
          console.log(`[VERIFY-OCR] Insurance parsed for MC#${v.mc_number}: ${parsed.insurance_company || "?"}, exp ${parsed.expiration_date || "?"}, ${(parsed.vins || []).length} VINs`);
        }
      } catch (err) { console.error("[VERIFY-OCR] Insurance parse error:", err); }
    }

    // OCR the cab card / truck photo for VIN
    if ((v.doc_cab_card || v.doc_truck_photo) && !v.parsed_vin) {
      const docKey = v.doc_cab_card || v.doc_truck_photo;
      try {
        const vinUrl = await getPresignedDownloadUrl(docKey as string, 120);
        const parsed = await parseVINPhoto(vinUrl);
        if (parsed && parsed.vin) {
          paramCount++; updates.push(`parsed_vin=$${paramCount}`); values.push(parsed.vin);
          // Also set truck_vin if not already set, and decode
          if (!v.truck_vin) {
            paramCount++; updates.push(`truck_vin=$${paramCount}`); values.push(parsed.vin);
            const decoded = await decodeVIN(parsed.vin);
            if (decoded) { paramCount++; updates.push(`vin_decode=$${paramCount}`); values.push(JSON.stringify(decoded)); }
          }
          console.log(`[VERIFY-OCR] VIN extracted for MC#${v.mc_number}: ${parsed.vin}`);
        }
      } catch (err) { console.error("[VERIFY-OCR] VIN parse error:", err); }
    }

    if (updates.length > 0) {
      paramCount++;
      updates.push(`updated_at=NOW()`);
      values.push(verificationId);
      await query(`UPDATE carrier_verifications SET ${updates.join(", ")} WHERE id=$${paramCount}`, values);
    }

    // Run doc flags check after OCR
    const refreshed = await query(`SELECT * FROM carrier_verifications WHERE id=$1`, [verificationId]);
    if (refreshed.rows.length > 0) {
      const rv = refreshed.rows[0];
      const profileForFlags = {
        cdl_expiration: rv.cdl_expiration,
        insurance_expiration: rv.insurance_expiration,
        vin_number: rv.parsed_vin || rv.truck_vin,
        insurance_vins: rv.insurance_vins,
        cdl_photo_url: rv.doc_cdl,
        vin_photo_url: rv.doc_cab_card || rv.doc_truck_photo,
        insurance_doc_url: rv.doc_insurance,
        driver_name: rv.driver_name,
        driver_phone: rv.driver_phone,
        truck_number: rv.truck_vin,
      };
      const flags = checkDocFlags(profileForFlags);
      await query(`UPDATE carrier_verifications SET doc_flags=$1, updated_at=NOW() WHERE id=$2`, [JSON.stringify(flags), verificationId]);
      console.log(`[VERIFY-OCR] Doc flags for MC#${rv.mc_number}: ${flags.length > 0 ? flags.join(", ") : "none"}`);
    }
  } catch (err) {
    console.error("[VERIFY-OCR] Error:", err);
  }
}

// ── HELPER: Load carrier profile if exists (for pre-fill) ──
async function loadCarrierProfile(mcNumber: string): Promise<Record<string, unknown> | null> {
  try {
    const clean = mcNumber.replace(/\D/g, "");
    const result = await query(`SELECT * FROM carrier_profiles WHERE mc_number=$1 ORDER BY updated_at DESC LIMIT 1`, [clean]);
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch { return null; }
}

// ── HELPER: Save/update carrier profile after verification ──
async function saveCarrierProfile(v: Record<string, unknown>): Promise<void> {
  try {
    const mc = String(v.mc_number).replace(/\D/g, "");
    if (!mc) return;

    const existing = await query(`SELECT id FROM carrier_profiles WHERE mc_number=$1 LIMIT 1`, [mc]);
    const fmcsa = v.fmcsa_data as Record<string, unknown> || {};

    if (existing.rows.length > 0) {
      // Update existing profile
      const profileId = existing.rows[0].id;
      const updates: string[] = [];
      const vals: unknown[] = [];
      let p = 0;

      if (v.driver_name) { p++; updates.push(`driver_name=$${p}`); vals.push(v.driver_name); }
      if (v.driver_phone) { p++; updates.push(`driver_phone=$${p}`); vals.push(v.driver_phone); }
      if (v.truck_vin || v.parsed_vin) { p++; updates.push(`vin_number=$${p}`); vals.push(v.parsed_vin || v.truck_vin); }
      if (v.doc_cdl) { p++; updates.push(`cdl_photo_r2_key=$${p}`); vals.push(v.doc_cdl); }
      if (v.doc_insurance) { p++; updates.push(`insurance_doc_r2_key=$${p}`); vals.push(v.doc_insurance); }
      if (v.doc_cab_card || v.doc_truck_photo) { p++; updates.push(`vin_photo_r2_key=$${p}`); vals.push(v.doc_cab_card || v.doc_truck_photo); }
      if (v.parsed_cdl) { p++; updates.push(`parsed_cdl=$${p}`); vals.push(v.parsed_cdl); }
      if (v.parsed_insurance) { p++; updates.push(`parsed_insurance=$${p}`); vals.push(v.parsed_insurance); }
      if (v.parsed_vin) { p++; updates.push(`parsed_vin=$${p}`); vals.push(v.parsed_vin); }
      if (v.cdl_number) { p++; updates.push(`cdl_number=$${p}`); vals.push(v.cdl_number); }
      if (v.cdl_state) { p++; updates.push(`cdl_state=$${p}`); vals.push(v.cdl_state); }
      if (v.cdl_expiration) { p++; updates.push(`cdl_expiration=$${p}`); vals.push(v.cdl_expiration); }
      if (v.insurance_expiration) { p++; updates.push(`insurance_expiration=$${p}`); vals.push(v.insurance_expiration); }
      if (v.insurance_company) { p++; updates.push(`insurance_company=$${p}`); vals.push(v.insurance_company); }
      if (v.insurance_policy_number) { p++; updates.push(`insurance_policy_number=$${p}`); vals.push(v.insurance_policy_number); }
      if (v.insurance_vins) { p++; updates.push(`insurance_vins=$${p}`); vals.push(v.insurance_vins); }
      if (v.doc_flags) { p++; updates.push(`doc_flags=$${p}`); vals.push(v.doc_flags); }

      if (updates.length > 0) {
        updates.push(`updated_at=NOW()`);
        updates.push(`completion_status='dispatch_ready'`);
        p++;
        vals.push(profileId);
        await query(`UPDATE carrier_profiles SET ${updates.join(", ")} WHERE id=$${p}`, vals);
        // Link profile to verification
        await query(`UPDATE carrier_verifications SET carrier_profile_id=$1 WHERE id=$2`, [profileId, v.id]);
        console.log(`[VERIFY] Updated carrier profile #${profileId} for MC#${mc}`);
      }
    } else {
      // Create new profile
      const ins = await query(`
        INSERT INTO carrier_profiles (company_name, mc_number, contact_name, email, phone,
          driver_name, driver_phone, vin_number,
          cdl_photo_r2_key, vin_photo_r2_key, insurance_doc_r2_key,
          parsed_cdl, parsed_insurance, parsed_vin,
          cdl_number, cdl_state, cdl_expiration,
          insurance_expiration, insurance_company, insurance_policy_number, insurance_vins,
          doc_flags, completion_status, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'dispatch_ready','direct')
        RETURNING id
      `, [
        (fmcsa.legal_name as string) || v.carrier_name || `MC#${mc}`,
        mc,
        v.driver_name || v.carrier_name || "",
        v.carrier_email || "",
        v.carrier_phone || "",
        v.driver_name || null,
        v.driver_phone || null,
        v.parsed_vin || v.truck_vin || null,
        v.doc_cdl || null,
        v.doc_cab_card || v.doc_truck_photo || null,
        v.doc_insurance || null,
        v.parsed_cdl || null,
        v.parsed_insurance || null,
        v.parsed_vin || null,
        v.cdl_number || null,
        v.cdl_state || null,
        v.cdl_expiration || null,
        v.insurance_expiration || null,
        v.insurance_company || null,
        v.insurance_policy_number || null,
        v.insurance_vins ? JSON.stringify(v.insurance_vins) : "[]",
        v.doc_flags ? JSON.stringify(v.doc_flags) : "[]",
      ]);
      const profileId = ins.rows[0].id;
      await query(`UPDATE carrier_verifications SET carrier_profile_id=$1 WHERE id=$2`, [profileId, v.id]);
      console.log(`[VERIFY] Created carrier profile #${profileId} for MC#${mc}`);
    }
  } catch (err) {
    console.error("[VERIFY] Save carrier profile error:", err);
  }
}


// ═══════════════════════════════════════════════════════════════
// ROUTE 1: BROKER TRIGGER — POST /api/verify/trigger
// ═══════════════════════════════════════════════════════════════
// Input: mc_number, carrier_phone, carrier_email (at least one),
//        broker_name, broker_phone (for result delivery)
// Output: creates verification record, runs FMCSA, sends carrier SMS+email

router.post("/api/verify/trigger", async (req, res) => {
  try {
    const { mc_number, carrier_phone, carrier_email, carrier_name, broker_name, broker_phone, broker_email, broker_account_id, deadline_minutes } = req.body;

    if (!mc_number) return res.status(400).json({ error: "mc_number is required" });
    if (!carrier_phone && !carrier_email) return res.status(400).json({ error: "carrier_phone or carrier_email is required" });

    const token = genToken();
    const deadlineMin = deadline_minutes || 90;
    const deadline = new Date(Date.now() + deadlineMin * 60 * 1000);

    // Step 1: FMCSA auto-check
    let fmcsaData: Record<string, unknown> = {};
    let fmcsaStatus = "unknown";
    try {
      fmcsaData = await lookupFMCSA(mc_number);
      const usdotStatus = String((fmcsaData as Record<string, unknown>).usdot_status || "").toUpperCase();
      const authStatus = String((fmcsaData as Record<string, unknown>).operating_status || "").toUpperCase();
      if (!fmcsaData.found) fmcsaStatus = "not_found";
      else if (usdotStatus !== "ACTIVE") fmcsaStatus = "inactive";
      else if (!authStatus.includes("AUTHORIZED")) fmcsaStatus = "not_authorized";
      else fmcsaStatus = "active";
    } catch (err) {
      fmcsaStatus = "error";
      console.error("[VERIFY] FMCSA lookup error:", err);
    }

    // Step 2: Create verification record
    const result = await query(`
      INSERT INTO carrier_verifications
        (token, broker_account_id, broker_name, broker_phone, broker_email,
         mc_number, carrier_phone, carrier_email, carrier_name,
         fmcsa_data, fmcsa_status, deadline, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
      RETURNING id, token
    `, [token, broker_account_id || null, broker_name || null, broker_phone || null, broker_email || null,
        mc_number.replace(/\D/g, ""), carrier_phone || null, carrier_email || null, carrier_name || null,
        JSON.stringify(fmcsaData), fmcsaStatus, deadline]);

    const verificationId = result.rows[0].id;
    const verifyUrl = `${BASE_URL}/v/${token}`;

    // If FMCSA already shows DO NOT USE, skip carrier outreach and deliver immediately
    if (fmcsaStatus === "not_found" || fmcsaStatus === "inactive" || fmcsaStatus === "not_authorized") {
      const reasons = [];
      if (fmcsaStatus === "not_found") reasons.push("Carrier not found in FMCSA database");
      if (fmcsaStatus === "inactive") reasons.push(`USDOT status: ${(fmcsaData as Record<string, unknown>).usdot_status}`);
      if (fmcsaStatus === "not_authorized") reasons.push(`Operating authority: ${(fmcsaData as Record<string, unknown>).operating_status}`);

      await query(`UPDATE carrier_verifications SET status='complete', result='DO_NOT_USE', result_reasons=$1, result_delivered_at=NOW(), updated_at=NOW() WHERE id=$2`,
        [JSON.stringify(reasons), verificationId]);

      // Notify broker immediately
      if (broker_phone) {
        await sendSms(broker_phone, `MC#${mc_number} — DO NOT USE. ${reasons.join(". ")}. Details: ${verifyUrl}/report`);
      }

      return res.json({ id: verificationId, token, status: "complete", result: "DO_NOT_USE", reasons, fmcsa: fmcsaData });
    }

    // Step 3: Send carrier verification request
    const brokerLabel = broker_name || "A broker";
    const carrierMsg = `${brokerLabel} requires verification before dispatch.\n\nComplete here to be approved:\n${verifyUrl}\n\nTakes ~2 minutes.\n\nSecure verification for dispatch — no spam, no marketing.\n\nNo verification = no dispatch.`;

    let smsSent = false;
    let emailSent = false;

    if (carrier_phone) {
      const smsResult = await sendSms(carrier_phone, carrierMsg);
      smsSent = smsResult.sent;
      if (smsSent) {
        await query(`UPDATE carrier_verifications SET sms_sent_at=NOW(), updated_at=NOW() WHERE id=$1`, [verificationId]);
      }
    }

    // TODO: Send email via SendGrid when configured
    // For now, log it
    if (carrier_email) {
      console.log(`[VERIFY] Would send email to ${carrier_email}: ${verifyUrl}`);
      // emailSent = await sendVerificationEmail(carrier_email, brokerLabel, verifyUrl);
      // if (emailSent) await query(`UPDATE carrier_verifications SET email_sent_at=NOW() WHERE id=$1`, [verificationId]);
    }

    res.json({
      id: verificationId,
      token,
      status: "pending",
      verify_url: verifyUrl,
      fmcsa_status: fmcsaStatus,
      fmcsa: fmcsaData,
      sms_sent: smsSent,
      email_sent: emailSent,
      deadline: deadline.toISOString(),
    });

  } catch (err) {
    console.error("[VERIFY] Trigger error:", err);
    res.status(500).json({ error: "Verification trigger failed" });
  }
});


// ═══════════════════════════════════════════════════════════════
// ROUTE 2: CARRIER FORM — GET /v/:token
// ═══════════════════════════════════════════════════════════════
// The magic link carrier clicks (from SMS or email)

router.get("/v/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const result = await query(`SELECT * FROM carrier_verifications WHERE token=$1`, [token]);
    if (result.rows.length === 0) return res.status(404).send(renderCarrierPage("Verification not found", "This link is invalid or has expired.", token, null));

    const v = result.rows[0];

    if (v.status === "complete") {
      return res.send(renderCarrierPage("Already submitted", "Your verification documents have already been received. Your broker has been notified.", token, v));
    }

    if (v.status === "expired") {
      return res.send(renderCarrierPage("Link expired", "This verification request has expired. Please contact your broker.", token, v));
    }

    // Show the form — pre-fill from carrier profile if exists
    const fmcsa = v.fmcsa_data || {};
    const profile = await loadCarrierProfile(v.mc_number);
    if (profile && !v.carrier_first_response_at) {
      // Pre-fill driver info from previous verification
      if (profile.driver_name && !v.driver_name) v.driver_name = profile.driver_name;
      if (profile.driver_phone && !v.driver_phone) v.driver_phone = profile.driver_phone;
      if (profile.vin_number && !v.truck_vin) v.truck_vin = profile.vin_number;
    }
    res.send(renderCarrierForm(token, v, fmcsa));

  } catch (err) {
    console.error("[VERIFY] Form render error:", err);
    res.status(500).send("Something went wrong. Please try again.");
  }
});


// ═══════════════════════════════════════════════════════════════
// ROUTE 3: CARRIER FORM SUBMIT — POST /v/:token
// ═══════════════════════════════════════════════════════════════

router.post("/v/:token", upload.fields([
  { name: "cdl", maxCount: 1 },
  { name: "insurance", maxCount: 1 },
  { name: "cab_card", maxCount: 1 },
  { name: "truck_photo", maxCount: 1 },
]), async (req, res) => {
  try {
    const { token } = req.params;
    const result = await query(`SELECT * FROM carrier_verifications WHERE token=$1`, [token]);
    if (result.rows.length === 0) return res.status(404).send("Not found");

    const v = result.rows[0];
    if (v.status === "complete") return res.redirect(`/v/${token}`);

    const files = req.files as Record<string, Express.Multer.File[]>;
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramCount = 0;

    // Mark first response
    if (!v.carrier_first_response_at) {
      paramCount++;
      updates.push(`carrier_first_response_at=NOW()`);
      updates.push(`submission_method='form'`);
    }

    // Upload each file to R2
    const fileFields = [
      { field: "cdl", dbCol: "doc_cdl", dbTimeCol: "doc_cdl_submitted_at" },
      { field: "insurance", dbCol: "doc_insurance", dbTimeCol: "doc_insurance_submitted_at" },
      { field: "cab_card", dbCol: "doc_cab_card", dbTimeCol: "doc_cab_card_submitted_at" },
      { field: "truck_photo", dbCol: "doc_truck_photo", dbTimeCol: "doc_truck_photo_submitted_at" },
    ];

    for (const ff of fileFields) {
      if (files[ff.field]?.[0]) {
        const f = files[ff.field][0];
        const uploaded = await uploadToR2(f.buffer, f.originalname, f.mimetype, `verify/${token}`);
        paramCount++;
        updates.push(`${ff.dbCol}=$${paramCount}`);
        values.push(uploaded.objectKey);
        updates.push(`${ff.dbTimeCol}=NOW()`);
      }
    }

    // Text fields
    if (req.body.driver_name) { paramCount++; updates.push(`driver_name=$${paramCount}`); values.push(req.body.driver_name); }
    if (req.body.driver_phone) { paramCount++; updates.push(`driver_phone=$${paramCount}`); values.push(req.body.driver_phone); }
    if (req.body.truck_vin) {
      paramCount++; updates.push(`truck_vin=$${paramCount}`); values.push(req.body.truck_vin);
      // Auto-decode VIN
      const decoded = await decodeVIN(req.body.truck_vin);
      if (decoded) { paramCount++; updates.push(`vin_decode=$${paramCount}`); values.push(JSON.stringify(decoded)); }
    }

    updates.push(`status='in_progress'`);
    updates.push(`updated_at=NOW()`);

    paramCount++;
    values.push(v.id);

    await query(`UPDATE carrier_verifications SET ${updates.join(", ")} WHERE id=$${paramCount}`, values);

    // Re-fetch and compute result
    const updated = await query(`SELECT * FROM carrier_verifications WHERE id=$1`, [v.id]);
    const uv = updated.rows[0];

    // Check if all docs are provided — run OCR then compute result
    if (uv.doc_cdl && uv.doc_insurance && (uv.doc_cab_card || uv.doc_truck_photo)) {
      // Run OCR in background (don't block the redirect)
      runOCR(v.id).then(async () => {
        // Re-fetch with OCR data
        const ocrResult = await query(`SELECT * FROM carrier_verifications WHERE id=$1`, [v.id]);
        const ov = ocrResult.rows[0];
        const { result: finalResult, reasons } = computeResult(ov);
        await query(`UPDATE carrier_verifications SET status='complete', result=$1, result_reasons=$2, result_delivered_at=NOW(), updated_at=NOW() WHERE id=$3`,
          [finalResult, JSON.stringify(reasons), v.id]);

        // Save to carrier profile for next time
        await saveCarrierProfile(ov);

        // Notify broker
        if (ov.broker_phone) {
          await sendSms(ov.broker_phone, `MC#${ov.mc_number} — ${finalResult}. ${reasons.join(". ")}. View: ${BASE_URL}/v/${token}/report`);
        }
      }).catch(err => console.error("[VERIFY] OCR/complete error:", err));
    }

    res.redirect(`/v/${token}`);

  } catch (err) {
    console.error("[VERIFY] Form submit error:", err);
    res.status(500).send("Upload failed. Please try again.");
  }
});


// ═══════════════════════════════════════════════════════════════
// ROUTE 4: INBOUND SMS FROM CARRIER — POST /api/verify/sms
// ═══════════════════════════════════════════════════════════════
// Twilio webhook: carrier texts back photos or info

router.post("/api/verify/sms", async (req, res) => {
  try {
    const from = req.body.From;
    const body = (req.body.Body || "").trim();
    const numMedia = parseInt(req.body.NumMedia || "0");

    // Find active verification for this phone number
    const result = await query(
      `SELECT * FROM carrier_verifications WHERE carrier_phone=$1 AND status IN ('pending','in_progress') ORDER BY created_at DESC LIMIT 1`,
      [from]
    );

    if (result.rows.length === 0) {
      // No active verification — respond with generic message
      res.type("text/xml").send(`<Response><Message>No active verification request found for this number. If you received a verification link, please use that instead.</Message></Response>`);
      return;
    }

    const v = result.rows[0];

    // Mark first response if not already
    if (!v.carrier_first_response_at) {
      await query(`UPDATE carrier_verifications SET carrier_first_response_at=NOW(), submission_method='sms', status='in_progress', updated_at=NOW() WHERE id=$1`, [v.id]);
    }

    // Handle MMS (photos)
    if (numMedia > 0) {
      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = req.body[`MediaUrl${i}`];
        const mediaType = req.body[`MediaContentType${i}`];

        if (mediaUrl && mediaType) {
          // Download the media from Twilio
          try {
            const mediaResp = await fetch(mediaUrl, {
              headers: {
                "Authorization": "Basic " + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")
              }
            });
            const buffer = Buffer.from(await mediaResp.arrayBuffer());
            const ext = mediaType.includes("pdf") ? ".pdf" : mediaType.includes("png") ? ".png" : ".jpg";
            const uploaded = await uploadToR2(buffer, `sms-upload-${Date.now()}${ext}`, mediaType, `verify/${v.token}`);

            // Figure out which doc slot to fill (fill first empty one)
            const docSlots = ["doc_cdl", "doc_insurance", "doc_cab_card", "doc_truck_photo"];
            const timeSlots = ["doc_cdl_submitted_at", "doc_insurance_submitted_at", "doc_cab_card_submitted_at", "doc_truck_photo_submitted_at"];

            let slotFilled = false;
            for (let s = 0; s < docSlots.length; s++) {
              if (!v[docSlots[s]]) {
                await query(`UPDATE carrier_verifications SET ${docSlots[s]}=$1, ${timeSlots[s]}=NOW(), updated_at=NOW() WHERE id=$2`, [uploaded.objectKey, v.id]);
                v[docSlots[s]] = uploaded.objectKey; // Update local state
                slotFilled = true;
                break;
              }
            }

            if (!slotFilled) {
              // All slots full — store as extra doc
              console.log(`[VERIFY] Extra doc received for ${v.mc_number} — all slots filled`);
            }
          } catch (dlErr) {
            console.error("[VERIFY] Media download error:", dlErr);
          }
        }
      }

      // Check what's still missing
      const refreshed = await query(`SELECT * FROM carrier_verifications WHERE id=$1`, [v.id]);
      const rv = refreshed.rows[0];
      const missing: string[] = [];
      if (!rv.doc_cdl) missing.push("CDL");
      if (!rv.doc_insurance) missing.push("Insurance");
      if (!rv.doc_cab_card) missing.push("Cab card");
      if (!rv.doc_truck_photo) missing.push("Truck photo");

      if (missing.length === 0) {
        // All docs received — run OCR, compute result, save profile
        runOCR(v.id).then(async () => {
          const ocrResult = await query(`SELECT * FROM carrier_verifications WHERE id=$1`, [v.id]);
          const ov = ocrResult.rows[0];
          const { result: finalResult, reasons } = computeResult(ov);
          await query(`UPDATE carrier_verifications SET status='complete', result=$1, result_reasons=$2, result_delivered_at=NOW(), updated_at=NOW() WHERE id=$3`,
            [finalResult, JSON.stringify(reasons), v.id]);
          await saveCarrierProfile(ov);
          if (ov.broker_phone) {
            await sendSms(ov.broker_phone, `MC#${ov.mc_number} — ${finalResult}. ${reasons.join(". ")}. View: ${BASE_URL}/v/${ov.token}/report`);
          }
        }).catch(err => console.error("[VERIFY] SMS OCR/complete error:", err));

        res.type("text/xml").send(`<Response><Message>All documents received. Your broker has been notified. Thank you.</Message></Response>`);
      } else {
        res.type("text/xml").send(`<Response><Message>Got it. Still need: ${missing.join(", ")}. Text photos or use the link: ${BASE_URL}/v/${v.token}</Message></Response>`);
      }
      return;
    }

    // Handle text-only messages (VIN, driver name, etc.)
    if (body) {
      // Check if it looks like a VIN (17 alphanumeric characters)
      const vinMatch = body.match(/[A-HJ-NPR-Z0-9]{17}/i);
      if (vinMatch) {
        const decoded = await decodeVIN(vinMatch[0]);
        await query(`UPDATE carrier_verifications SET truck_vin=$1, vin_decode=$2, updated_at=NOW() WHERE id=$3`,
          [vinMatch[0], decoded ? JSON.stringify(decoded) : null, v.id]);
        const vinInfo = decoded ? `${decoded.year} ${decoded.make} ${decoded.model}` : "decoded";
        res.type("text/xml").send(`<Response><Message>VIN recorded: ${vinInfo}. Still need photos of CDL, insurance, cab card, and truck. Text them or use: ${BASE_URL}/v/${v.token}</Message></Response>`);
        return;
      }

      // Otherwise treat as driver name
      if (!v.driver_name && body.length > 2 && body.length < 100) {
        await query(`UPDATE carrier_verifications SET driver_name=$1, updated_at=NOW() WHERE id=$2`, [body, v.id]);
        res.type("text/xml").send(`<Response><Message>Driver name recorded: ${body}. Text photos of CDL, insurance, cab card, and truck — or use: ${BASE_URL}/v/${v.token}</Message></Response>`);
        return;
      }
    }

    // Default response
    res.type("text/xml").send(`<Response><Message>To complete verification, text photos of: CDL, insurance, cab card, truck. Or use: ${BASE_URL}/v/${v.token}</Message></Response>`);

  } catch (err) {
    console.error("[VERIFY] Inbound SMS error:", err);
    res.type("text/xml").send(`<Response><Message>Something went wrong. Please try the link your broker sent.</Message></Response>`);
  }
});


// ═══════════════════════════════════════════════════════════════
// ROUTE 5: BROKER REPORT — GET /v/:token/report
// ═══════════════════════════════════════════════════════════════

router.get("/v/:token/report", async (req, res) => {
  try {
    const { token } = req.params;
    const result = await query(`SELECT * FROM carrier_verifications WHERE token=$1`, [token]);
    if (result.rows.length === 0) return res.status(404).send("Not found");

    const v = result.rows[0];
    const fmcsa = v.fmcsa_data || {};
    const reasons = v.result_reasons || [];
    const vinDecode = v.vin_decode || {};

    // Generate presigned URLs for docs
    const docs: Record<string, string | null> = {};
    for (const key of ["doc_cdl", "doc_insurance", "doc_cab_card", "doc_truck_photo"]) {
      if (v[key]) {
        try { docs[key] = await getPresignedDownloadUrl(v[key], 600); }
        catch { docs[key] = null; }
      } else {
        docs[key] = null;
      }
    }

    res.send(renderReportPage(v, fmcsa, reasons, vinDecode, docs));

  } catch (err) {
    console.error("[VERIFY] Report render error:", err);
    res.status(500).send("Failed to load report");
  }
});


// ═══════════════════════════════════════════════════════════════
// ROUTE 6: VERIFICATION STATUS — GET /api/verify/:token/status
// ═══════════════════════════════════════════════════════════════

router.get("/api/verify/:token/status", async (req, res) => {
  try {
    const { token } = req.params;
    const result = await query(`SELECT id, token, mc_number, status, result, result_reasons, fmcsa_status, carrier_first_response_at,
      doc_cdl IS NOT NULL as has_cdl, doc_insurance IS NOT NULL as has_insurance,
      doc_cab_card IS NOT NULL as has_cab_card, doc_truck_photo IS NOT NULL as has_truck_photo,
      driver_name, truck_vin, vin_decode, deadline, created_at, updated_at
      FROM carrier_verifications WHERE token=$1`, [token]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch status" });
  }
});


// ═══════════════════════════════════════════════════════════════
// HTML RENDERERS
// ═══════════════════════════════════════════════════════════════

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Connected Carriers</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --slate:#1C2B3A; --amber:#C8892A; --amber2:#E09B35; --cream:#F7F5F0; --cream2:#EDE9E1; --cream3:#E0DAD0; --ink:#141414; --muted:#6B7A8A; --white:#FFF; --green:#2D8B4E; --red:#C0392B; --yellow:#D4A017; --sans:'DM Sans',system-ui,sans-serif; }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--sans);background:var(--cream);color:var(--ink);font-size:16px;line-height:1.6;min-height:100vh}
  .container{max-width:600px;margin:0 auto;padding:40px 20px}
  .logo{font-size:18px;font-weight:500;color:var(--slate);margin-bottom:32px;text-align:center}
  .logo span{color:var(--amber)}
  h1{font-size:24px;font-weight:600;margin-bottom:8px;color:var(--slate)}
  h2{font-size:18px;font-weight:600;margin-bottom:8px;color:var(--slate)}
  p{color:var(--muted);margin-bottom:16px}
  .card{background:var(--white);border:1px solid var(--cream3);border-radius:6px;padding:28px;margin-bottom:20px}
  .form-group{margin-bottom:18px}
  .form-group label{display:block;font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin-bottom:6px}
  .form-group input,.form-group select{width:100%;padding:10px 12px;font-family:var(--sans);font-size:15px;border:1px solid var(--cream3);border-radius:4px;background:var(--white);outline:none}
  .form-group input:focus{border-color:var(--amber)}
  .file-input{position:relative;border:2px dashed var(--cream3);border-radius:6px;padding:20px;text-align:center;cursor:pointer;transition:border-color 0.2s}
  .file-input:hover{border-color:var(--amber)}
  .file-input input{position:absolute;inset:0;opacity:0;cursor:pointer}
  .file-input .label{font-size:13px;color:var(--muted)}
  .file-input .uploaded{color:var(--green);font-weight:500}
  .btn{display:block;width:100%;padding:14px;background:var(--amber);color:var(--white);border:none;border-radius:4px;font-family:var(--sans);font-size:15px;font-weight:500;cursor:pointer;text-align:center;transition:background 0.2s}
  .btn:hover{background:var(--amber2)}
  .fine{font-size:12px;color:var(--muted);text-align:center;margin-top:16px}
  .tag{display:inline-block;padding:4px 12px;border-radius:3px;font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase}
  .tag-clear{background:#E8F5E9;color:var(--green)}
  .tag-caution{background:#FFF8E1;color:var(--yellow)}
  .tag-dnu{background:#FFEBEE;color:var(--red)}
  .doc-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--cream2)}
  .doc-row:last-child{border-bottom:none}
  .doc-status{font-size:13px;font-weight:500}
  .doc-yes{color:var(--green)}
  .doc-no{color:var(--red)}
  .reason{font-size:14px;padding:6px 0;color:var(--muted)}
  .reason::before{content:"—";margin-right:8px;color:var(--cream3)}
</style>
</head>
<body>
<div class="container">
  <div class="logo">Connected<span>Carriers</span></div>
  ${body}
  <p class="fine" style="margin-top:32px">connectedcarriers.org — A HoneXAI product</p>
</div>
</body>
</html>`;
}


function renderCarrierPage(title: string, message: string, _token: string, _v: Record<string, unknown> | null): string {
  return pageShell(title, `
    <div class="card" style="text-align:center">
      <h1>${title}</h1>
      <p>${message}</p>
    </div>
  `);
}


function renderCarrierForm(token: string, v: Record<string, unknown>, fmcsa: Record<string, unknown>): string {
  const brokerName = v.broker_name || "Your broker";
  const carrierName = (fmcsa.legal_name || `MC#${v.mc_number}`) as string;

  return pageShell("Carrier Verification", `
    <div class="card">
      <h1>Verification Required</h1>
      <p><strong>${brokerName}</strong> requires verification before dispatch for <strong>${carrierName}</strong>.</p>
      <p>Submit the documents below. Takes about 2 minutes.</p>
      <p style="margin-top:12px;font-size:13px;color:var(--muted);padding:10px 14px;background:var(--cream2);border-radius:4px;line-height:1.5">This verification is required by your broker before dispatch. We only use this information to confirm you're dispatch-ready. We do not share your data or use it for marketing.</p>
    </div>

    <form action="/v/${token}" method="POST" enctype="multipart/form-data">
      <div class="card">
        <h2>Driver Information</h2>
        <div class="form-group">
          <label>Driver Name</label>
          <input type="text" name="driver_name" placeholder="Full name as it appears on CDL" value="${v.driver_name || ""}">
        </div>
        <div class="form-group">
          <label>Driver Phone</label>
          <input type="tel" name="driver_phone" placeholder="Driver's cell number" value="${v.driver_phone || ""}">
        </div>
      </div>

      <div class="card">
        <h2>Documents</h2>
        <p style="font-size:12px;color:var(--muted);margin-bottom:16px">Used only for verification — not stored for marketing or resale.</p>

        <div class="form-group">
          <label>CDL — Front Photo</label>
          <div class="file-input">
            ${v.doc_cdl ? '<p class="uploaded">✓ Already uploaded</p>' : '<p class="label">Tap to upload or take photo</p>'}
            <input type="file" name="cdl" accept="image/*,.pdf" capture="environment">
          </div>
        </div>

        <div class="form-group">
          <label>Certificate of Insurance (COI)</label>
          <div class="file-input">
            ${v.doc_insurance ? '<p class="uploaded">✓ Already uploaded</p>' : '<p class="label">Tap to upload or take photo</p>'}
            <input type="file" name="insurance" accept="image/*,.pdf" capture="environment">
          </div>
        </div>

        <div class="form-group">
          <label>Cab Card</label>
          <div class="file-input">
            ${v.doc_cab_card ? '<p class="uploaded">✓ Already uploaded</p>' : '<p class="label">Tap to upload or take photo</p>'}
            <input type="file" name="cab_card" accept="image/*,.pdf" capture="environment">
          </div>
        </div>

        <div class="form-group">
          <label>Truck Photo (showing VIN plate if possible)</label>
          <div class="file-input">
            ${v.doc_truck_photo ? '<p class="uploaded">✓ Already uploaded</p>' : '<p class="label">Tap to upload or take photo</p>'}
            <input type="file" name="truck_photo" accept="image/*" capture="environment">
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Equipment</h2>
        <div class="form-group">
          <label>Truck VIN (17 characters)</label>
          <input type="text" name="truck_vin" placeholder="e.g. 1FUJGLDR5CLBP8834" maxlength="17" value="${v.truck_vin || ""}">
        </div>
      </div>

      <button type="submit" class="btn">Submit Verification</button>
      <p class="fine">Your broker will be notified when verification is complete.</p>
    </form>
  `);
}


function renderReportPage(v: Record<string, unknown>, fmcsa: Record<string, unknown>, reasons: string[], vinDecode: Record<string, unknown>, docs: Record<string, string | null>): string {
  const resultClass = v.result === "CLEAR" ? "tag-clear" : v.result === "CAUTION" ? "tag-caution" : "tag-dnu";
  const resultLabel = v.result === "DO_NOT_USE" ? "DO NOT USE" : v.result;
  const statusLine = v.status === "complete" ? `<span class="tag ${resultClass}">${resultLabel}</span>` : `<span class="tag tag-caution">PENDING</span>`;

  return pageShell("Verification Report", `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h1 style="margin-bottom:0">MC#${v.mc_number}</h1>
        ${statusLine}
      </div>
      <p style="margin-bottom:4px"><strong>Carrier:</strong> ${fmcsa.legal_name || "Unknown"}</p>
      <p style="margin-bottom:4px"><strong>DOT:</strong> ${fmcsa.dot_number || "N/A"}</p>
      <p style="margin-bottom:4px"><strong>Authority:</strong> ${fmcsa.operating_status || "Unknown"}</p>
      <p style="margin-bottom:4px"><strong>USDOT Status:</strong> ${fmcsa.usdot_status || "Unknown"}</p>
      ${v.driver_name ? `<p style="margin-bottom:4px"><strong>Driver:</strong> ${v.driver_name}</p>` : ""}
      ${v.truck_vin ? `<p style="margin-bottom:4px"><strong>VIN:</strong> ${v.truck_vin}${vinDecode.year ? ` (${vinDecode.year} ${vinDecode.make} ${vinDecode.model})` : ""}</p>` : ""}
    </div>

    <div class="card">
      <h2>Documents</h2>
      <div class="doc-row">
        <span>CDL</span>
        <span class="doc-status ${v.doc_cdl ? "doc-yes" : "doc-no"}">${v.doc_cdl ? (docs.doc_cdl ? `<a href="${docs.doc_cdl}" target="_blank">View ✓</a>` : "Received ✓") : "Not provided"}</span>
      </div>
      <div class="doc-row">
        <span>Insurance (COI)</span>
        <span class="doc-status ${v.doc_insurance ? "doc-yes" : "doc-no"}">${v.doc_insurance ? (docs.doc_insurance ? `<a href="${docs.doc_insurance}" target="_blank">View ✓</a>` : "Received ✓") : "Not provided"}</span>
      </div>
      <div class="doc-row">
        <span>Cab Card</span>
        <span class="doc-status ${v.doc_cab_card ? "doc-yes" : "doc-no"}">${v.doc_cab_card ? (docs.doc_cab_card ? `<a href="${docs.doc_cab_card}" target="_blank">View ✓</a>` : "Received ✓") : "Not provided"}</span>
      </div>
      <div class="doc-row">
        <span>Truck Photo</span>
        <span class="doc-status ${v.doc_truck_photo ? "doc-yes" : "doc-no"}">${v.doc_truck_photo ? (docs.doc_truck_photo ? `<a href="${docs.doc_truck_photo}" target="_blank">View ✓</a>` : "Received ✓") : "Not provided"}</span>
      </div>
    </div>

    ${reasons.length > 0 ? `
    <div class="card">
      <h2>${v.result === "CLEAR" ? "Summary" : "Flags"}</h2>
      ${(reasons as string[]).map((r: string) => `<div class="reason">${r}</div>`).join("")}
    </div>` : ""}

    <div class="card">
      <h2>Timing</h2>
      <p style="margin-bottom:4px"><strong>Requested:</strong> ${new Date(v.created_at as string).toLocaleString()}</p>
      ${v.carrier_first_response_at ? `<p style="margin-bottom:4px"><strong>First response:</strong> ${new Date(v.carrier_first_response_at as string).toLocaleString()} (via ${v.submission_method})</p>` : `<p style="margin-bottom:4px"><strong>Carrier response:</strong> None</p>`}
      ${v.result_delivered_at ? `<p style="margin-bottom:4px"><strong>Completed:</strong> ${new Date(v.result_delivered_at as string).toLocaleString()}</p>` : ""}
    </div>

    <p class="fine">This report was generated automatically by Connected Carriers. We do not contact carriers, store broker data, or participate in transactions.</p>
  `);
}


export default router;
