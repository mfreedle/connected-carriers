import { Router, Request, Response } from "express";
import crypto from "crypto";
import multer from "multer";
import { query } from "../db";
import { h } from "../middleware/security";
import { uploadToR2, isR2Configured } from "../lib/storage";
import { findOrCreateCarrier, updateCarrierFMCSA, updateCarrierContact, findCarrierByMc } from "../carrier-identity";
import { lookupFMCSA, FMCSAResult } from "../lib/fmcsa";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
});

const EQUIPMENT_TYPES = [
  "Dry Van 53'", "Reefer / Refrigerated 53'", "Flatbed", "Step Deck",
  "RGN / Lowboy", "Power Only", "Sprinter / Cargo Van", "Box Truck",
  "LTL (Less Than Truckload)", "Intermodal / Drayage", "Specialized / Oversized",
];

const fileFields = upload.fields([
  { name: "cdl_photo", maxCount: 1 },
  { name: "vin_photo", maxCount: 1 },
  { name: "insurance_doc", maxCount: 1 },
]);

// ── GET /profile/carrier ──────────────────────────────────────────

router.get("/profile/carrier", async (req: Request, res: Response) => {
  const source = (req.query.source as string) || "direct";
  const mcParam = (req.query.mc as string || "").replace(/\D/g, "");

  let prefill: Record<string, string> = {
    mc: mcParam,
    name: (req.query.name as string) || "",
    phone: (req.query.phone as string) || "",
    email: (req.query.email as string) || "",
  };
  let existingProfile: Record<string, unknown> | null = null;

  // If MC provided, look up carrier + existing profile (READ-ONLY — no DB creation)
  if (mcParam) {
    try {
      const carrier = await findCarrierByMc(mcParam);

      if (carrier) {
        // Pre-fill from carrier identity
        if (!prefill.name && carrier.fmcsa_legal_name) prefill.name = carrier.fmcsa_legal_name;
        if (!prefill.phone && carrier.phone) prefill.phone = carrier.phone;
        if (!prefill.email && carrier.email) prefill.email = carrier.email;

        // Load existing profile — try carrier_id first, then mc_number fallback
        let profileResult;
        if (carrier.latest_profile_id) {
          profileResult = await query("SELECT * FROM carrier_profiles WHERE id = $1", [carrier.latest_profile_id]);
        }
        if (!profileResult?.rows?.length) {
          profileResult = await query("SELECT * FROM carrier_profiles WHERE mc_number = $1 ORDER BY updated_at DESC LIMIT 1", [mcParam]);
        }
        if (profileResult?.rows?.length) {
          const ep = profileResult.rows[0];
          existingProfile = ep;
          if (!prefill.name && ep.contact_name) prefill.name = ep.contact_name as string;
          if (!prefill.phone && ep.phone) prefill.phone = ep.phone as string;
          if (!prefill.email && ep.email) prefill.email = ep.email as string;
        }
      } else {
        // No carrier identity — check for legacy profiles by MC number
        const profileResult = await query("SELECT * FROM carrier_profiles WHERE mc_number = $1 ORDER BY updated_at DESC LIMIT 1", [mcParam]);
        if (profileResult.rows.length) {
          const ep = profileResult.rows[0];
          existingProfile = ep;
          if (!prefill.name && ep.contact_name) prefill.name = ep.contact_name as string;
          if (!prefill.phone && ep.phone) prefill.phone = ep.phone as string;
          if (!prefill.email && ep.email) prefill.email = ep.email as string;
        }
      }
    } catch (err) {
      console.error("[profile GET] Carrier lookup error:", err);
    }
  }

  res.send(profilePage(source, req.query.error as string, req.query.success as string, prefill, existingProfile));
});

// ── POST /profile/carrier ─────────────────────────────────────────

router.post("/profile/carrier", fileFields, async (req: Request, res: Response) => {
  const { company_name, mc_number, contact_name, email, phone,
          driver_name, driver_phone, truck_number, trailer_number,
          lanes_or_regions, source } = req.body;
  const equipment_types = Array.isArray(req.body.equipment_types)
    ? req.body.equipment_types
    : req.body.equipment_types ? [req.body.equipment_types] : [];

  const errors: string[] = [];
  if (!company_name?.trim()) errors.push("Company name is required.");
  if (!contact_name?.trim()) errors.push("Contact name is required.");
  if (!email?.trim()) errors.push("Email is required.");

  if (errors.length) {
    return res.send(profilePage(source || "direct", errors.join(" ")));
  }

  try {
    // Rate limit: max 3 submissions per email per hour
    const recent = await query(
      "SELECT COUNT(*) as count FROM carrier_profiles WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'",
      [email.trim().toLowerCase()]
    );
    if (parseInt(recent.rows[0].count) >= 3) {
      return res.send(profilePage(source || "direct", "You've submitted recently. Please wait before submitting again."));
    }

    // FMCSA check if MC number provided
    const mcClean = mc_number?.replace(/\D/g, "") || "";
    let fmcsaStatus = "not_checked";
    let fmcsaData: FMCSAResult = { mc_number: mcClean, found: false };

    if (mcClean) {
      try {
        fmcsaData = await lookupFMCSA(mcClean);
        if (!fmcsaData.found) fmcsaStatus = "not_found";
        else if (!fmcsaData.active) fmcsaStatus = "inactive";
        else if (!fmcsaData.authorized) fmcsaStatus = "not_authorized";
        else fmcsaStatus = "active";
      } catch (err) {
        console.error("[PROFILE] FMCSA lookup error:", err);
        fmcsaStatus = "error";
      }

      // Reject carriers that fail hard stops
      if (fmcsaStatus === "not_found") {
        return res.send(profilePage(source || "direct", "MC number not found in the FMCSA database. Please check and try again."));
      }
      if (fmcsaStatus === "inactive") {
        return res.send(profilePage(source || "direct", "This MC number has an inactive USDOT status. Active authority is required."));
      }
      if (fmcsaStatus === "not_authorized") {
        return res.send(profilePage(source || "direct", "This MC number does not have authorized operating authority. Please check your MC number."));
      }
    }

    // Resolve carrier identity (SPINE-0002)
    let carrierId: number | null = null;
    if (mcClean) {
      const carrier = await findOrCreateCarrier(mcClean);
      carrierId = carrier.id;

      // Update carrier with FMCSA data if we ran a check
      if (fmcsaStatus === "active" || fmcsaStatus === "inactive" || fmcsaStatus === "not_authorized") {
        await updateCarrierFMCSA(carrier.id, {
          fmcsa_legal_name: fmcsaData.entity_name || fmcsaData.legal_name || undefined,
          dot_number: fmcsaData.dot_number || fmcsaData.usdot_number || undefined,
          fmcsa_status: fmcsaData.usdot_status || undefined,
          authority_status: fmcsaData.operating_status || undefined,
          safety_rating: fmcsaData.safety_rating || undefined,
          phone: fmcsaData.phone || undefined,
        });
      }

      // Update carrier contact info
      await updateCarrierContact(carrier.id, phone?.trim(), email?.trim().toLowerCase());

      // Store consent with evidence
      const consentText = "By submitting, I agree to receive SMS messages from Connected Carriers about document verification and dispatch status. Standard message and data rates may apply. Reply STOP to opt out.";
      const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || null;
      const userAgent = (req.headers["user-agent"] as string) || null;

      try {
        // SMS consent — always granted by submission
        await query(
          `INSERT INTO carrier_consents (carrier_id, consent_type, granted, source, phone, consent_text, ip_address, user_agent, granted_at)
           VALUES ($1, 'sms_verification', true, $2, $3, $4, $5, $6, NOW())`,
          [carrier.id, source?.trim() || "direct", phone?.trim() || null, consentText, ipAddress, userAgent]
        );
        // Network reuse — optional
        if (req.body.consent_network_reuse === "yes") {
          await query(
            `INSERT INTO carrier_consents (carrier_id, consent_type, granted, source, phone, ip_address, user_agent, granted_at)
             VALUES ($1, 'network_profile_reuse', true, $2, $3, $4, $5, NOW())`,
            [carrier.id, source?.trim() || "direct", phone?.trim() || null, ipAddress, userAgent]
          );
        }
      } catch (e) { console.error("[profile] Consent storage error:", e); }
    }

    // Upload files to R2 if present
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    let cdl_photo_url: string | null = null, cdl_photo_r2_key: string | null = null;
    let vin_photo_url: string | null = null, vin_photo_r2_key: string | null = null;
    let insurance_doc_url: string | null = null, insurance_doc_r2_key: string | null = null;

    if (isR2Configured()) {
      const mcSlug = mc_number?.replace(/\D/g, "") || "unknown";

      if (files?.cdl_photo?.[0]) {
        const f = files.cdl_photo[0];
        const uploaded = await uploadToR2(f.buffer, f.originalname, f.mimetype, `profiles/${mcSlug}`);
        cdl_photo_url = uploaded.fileUrl;
        cdl_photo_r2_key = uploaded.objectKey;
      }
      if (files?.vin_photo?.[0]) {
        const f = files.vin_photo[0];
        const uploaded = await uploadToR2(f.buffer, f.originalname, f.mimetype, `profiles/${mcSlug}`);
        vin_photo_url = uploaded.fileUrl;
        vin_photo_r2_key = uploaded.objectKey;
      }
      if (files?.insurance_doc?.[0]) {
        const f = files.insurance_doc[0];
        const uploaded = await uploadToR2(f.buffer, f.originalname, f.mimetype, `profiles/${mcSlug}`);
        insurance_doc_url = uploaded.fileUrl;
        insurance_doc_r2_key = uploaded.objectKey;
      }
    }

    // Determine completion status — now includes VIN and insurance expiration
    const hasAllDocs = !!(cdl_photo_url && vin_photo_url && insurance_doc_url);
    const hasDriverInfo = !!(driver_name?.trim() && driver_phone?.trim());
    const hasTruckInfo = !!(truck_number?.trim() && trailer_number?.trim());
    const hasVIN = !!req.body.vin_number?.trim();
    const hasInsExpiry = !!req.body.insurance_expiration;
    const completion = (hasAllDocs && hasDriverInfo && hasTruckInfo && hasVIN && hasInsExpiry) ? "dispatch_ready"
      : (hasAllDocs || hasDriverInfo || hasTruckInfo) ? "partial" : "partial";

    const vin_number = req.body.vin_number?.trim()?.toUpperCase() || null;
    const insurance_expiration = req.body.insurance_expiration || null;
    const cdl_expiration = req.body.cdl_expiration || null;

    const statusToken = crypto.randomBytes(24).toString("base64url");

    await query(`
      INSERT INTO carrier_profiles
        (company_name, mc_number, contact_name, email, phone,
         driver_name, driver_phone, truck_number, trailer_number,
         equipment_types, lanes_or_regions,
         cdl_photo_url, cdl_photo_r2_key,
         vin_photo_url, vin_photo_r2_key,
         insurance_doc_url, insurance_doc_r2_key,
         vin_number, insurance_expiration, cdl_expiration,
         completion_status, source,
         fmcsa_status, fmcsa_data, fmcsa_checked_at,
         carrier_id, status_token)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
      RETURNING id
    `, [
      company_name.trim(), mcClean || null,
      contact_name.trim(), email.trim().toLowerCase(),
      phone?.trim() || null,
      driver_name?.trim() || null, driver_phone?.trim() || null,
      truck_number?.trim() || null, trailer_number?.trim() || null,
      JSON.stringify(equipment_types), lanes_or_regions?.trim() || null,
      cdl_photo_url, cdl_photo_r2_key,
      vin_photo_url, vin_photo_r2_key,
      insurance_doc_url, insurance_doc_r2_key,
      vin_number, insurance_expiration, cdl_expiration,
      completion, source?.trim() || "direct",
      fmcsaStatus !== "not_checked" ? fmcsaStatus : null,
      Object.keys(fmcsaData).length > 0 ? JSON.stringify(fmcsaData) : null,
      fmcsaStatus !== "not_checked" ? new Date() : null,
      carrierId, statusToken,
    ]);

    // Update carrier identity with latest profile reference
    if (carrierId) {
      const profileResult = await query(
        "SELECT id FROM carrier_profiles WHERE carrier_id = $1 ORDER BY created_at DESC LIMIT 1",
        [carrierId]
      );
      if (profileResult.rows.length) {
        const newStatus = completion === "dispatch_ready" ? "verified" : "profile_started";
        await query(
          "UPDATE carriers SET latest_profile_id = $1, network_status = $2, updated_at = NOW() WHERE id = $3",
          [profileResult.rows[0].id, newStatus, carrierId]
        );
      }
    }

    // Run AI document parsing in background (don't block the response)
    const profileEmail = email.trim().toLowerCase();
    setImmediate(async () => {
      try {
        const { parseCDL, parseInsurance, parseVINPhoto, checkDocFlags } = await import("../doc-parser");

        let parsedCdl: any = null, parsedIns: any = null, parsedVin: string | null = null;
        const updates: string[] = [];
        const params: any[] = [];
        let paramIdx = 1;

        if (cdl_photo_url) {
          parsedCdl = await parseCDL(cdl_photo_url);
          if (parsedCdl && Object.keys(parsedCdl).length > 0) {
            updates.push(`parsed_cdl = $${paramIdx++}`);
            params.push(JSON.stringify(parsedCdl));
            if (parsedCdl.cdl_number) { updates.push(`cdl_number = $${paramIdx++}`); params.push(parsedCdl.cdl_number); }
            if (parsedCdl.state) { updates.push(`cdl_state = $${paramIdx++}`); params.push(parsedCdl.state); }
            if (parsedCdl.expiration_date && !cdl_expiration) { updates.push(`cdl_expiration = $${paramIdx++}`); params.push(parsedCdl.expiration_date); }
          }
        }

        if (insurance_doc_url) {
          parsedIns = await parseInsurance(insurance_doc_url);
          if (parsedIns && Object.keys(parsedIns).length > 0) {
            updates.push(`parsed_insurance = $${paramIdx++}`);
            params.push(JSON.stringify(parsedIns));
            if (parsedIns.policy_number) { updates.push(`insurance_policy_number = $${paramIdx++}`); params.push(parsedIns.policy_number); }
            if (parsedIns.insurance_company) { updates.push(`insurance_company = $${paramIdx++}`); params.push(parsedIns.insurance_company); }
            if (parsedIns.expiration_date && !insurance_expiration) { updates.push(`insurance_expiration = $${paramIdx++}`); params.push(parsedIns.expiration_date); }
            if (parsedIns.auto_liability) { updates.push(`insurance_auto_liability = $${paramIdx++}`); params.push(parsedIns.auto_liability); }
            if (parsedIns.cargo) { updates.push(`insurance_cargo = $${paramIdx++}`); params.push(parsedIns.cargo); }
            if (parsedIns.general_liability) { updates.push(`insurance_general_liability = $${paramIdx++}`); params.push(parsedIns.general_liability); }
            if (parsedIns.vins && parsedIns.vins.length > 0) { updates.push(`insurance_vins = $${paramIdx++}`); params.push(JSON.stringify(parsedIns.vins)); }
          }
        }

        if (vin_photo_url) {
          const vinResult = await parseVINPhoto(vin_photo_url);
          if (vinResult?.vin) {
            parsedVin = vinResult.vin;
            updates.push(`parsed_vin = $${paramIdx++}`);
            params.push(parsedVin);
            if (!vin_number) { updates.push(`vin_number = $${paramIdx++}`); params.push(parsedVin); }
          }
        }

        // Run doc flag checks
        const profileRow = await query("SELECT * FROM carrier_profiles WHERE email = $1 ORDER BY created_at DESC LIMIT 1", [profileEmail]);
        if (profileRow.rows.length > 0) {
          const flags = checkDocFlags(profileRow.rows[0]);
          updates.push(`doc_flags = $${paramIdx++}`);
          params.push(JSON.stringify(flags));

          // Update completion status if AI filled in missing fields
          const p = profileRow.rows[0];
          const vinNow = vin_number || parsedVin || p.vin_number;
          const insExpNow = insurance_expiration || (parsedIns?.expiration_date) || p.insurance_expiration;
          const allDocs = !!(p.cdl_photo_url && p.vin_photo_url && p.insurance_doc_url);
          const allInfo = !!(p.driver_name && p.driver_phone && p.truck_number && p.trailer_number);
          if (allDocs && allInfo && vinNow && insExpNow) {
            updates.push(`completion_status = $${paramIdx++}`);
            params.push("dispatch_ready");
          }
        }

        if (updates.length > 0) {
          params.push(profileEmail);
          await query(
            `UPDATE carrier_profiles SET ${updates.join(", ")}, updated_at = NOW() WHERE email = $${paramIdx}`,
            params
          );
          console.log(`[DocParser] Parsed docs for ${profileEmail}: CDL=${!!parsedCdl}, Insurance=${!!parsedIns}, VIN=${!!parsedVin}`);
        }
      } catch (err) {
        console.error("[DocParser] Background parsing error:", err);
      }
    });

    res.send(profileConfirmationPage(completion, statusToken));
  } catch (err) {
    console.error("Carrier profile submission error:", err);
    res.status(500).send(profilePage(source || "direct", "Something went wrong. Please try again."));
  }
});

// ── GET /carrier/status/:token — token-gated carrier status page ──

router.get("/carrier/status/:token", async (req: Request, res: Response) => {
  const token = req.params.token;
  if (!token) return res.status(400).send(pageShell("Invalid", `<div class="page" style="text-align:center;padding:40px"><p>Invalid status link.</p></div>`));

  try {
    // Look up profile by status_token
    const profileResult = await query("SELECT * FROM carrier_profiles WHERE status_token = $1", [token]);
    if (!profileResult.rows.length) {
      return res.status(404).send(pageShell("Not Found", `<div class="page" style="text-align:center;padding:40px"><p>Status link not found or expired.</p></div>`));
    }
    const profile = profileResult.rows[0];
    const mc = profile.mc_number || "";

    // Load carrier identity (read-only)
    const carrier = mc ? await findCarrierByMc(mc) : null;

    // Load latest verification
    let verification: Record<string, unknown> | null = null;
    if (carrier?.latest_verification_id) {
      const vResult = await query("SELECT result, status, result_delivered_at FROM carrier_verifications WHERE id = $1", [carrier.latest_verification_id]);
      if (vResult.rows.length) verification = vResult.rows[0];
    }

    // Build status checks
    const checks: { label: string; status: string; detail: string }[] = [];

    // FMCSA
    const companyName = carrier?.fmcsa_legal_name || (profile.company_name as string) || null;
    if (companyName) {
      checks.push({ label: "FMCSA Authority", status: "ok", detail: companyName });
    } else {
      checks.push({ label: "FMCSA Authority", status: "unknown", detail: "Not yet checked" });
    }

    checks.push({ label: "CDL Photo", status: profile.cdl_photo_url ? "ok" : "missing", detail: profile.cdl_photo_url ? "On file" : "Not uploaded" });
      checks.push({ label: "Insurance (COI)", status: profile.insurance_doc_url ? "ok" : "missing", detail: profile.insurance_doc_url ? "On file" : "Not uploaded" });
      checks.push({ label: "VIN / Cab Card Photo", status: profile.vin_photo_url ? "ok" : "missing", detail: profile.vin_photo_url ? "On file" : "Not uploaded" });
      checks.push({ label: "Driver Info", status: profile.driver_name ? "ok" : "missing", detail: profile.driver_name ? String(profile.driver_name) : "Not provided" });
      checks.push({ label: "Truck VIN", status: profile.vin_number ? "ok" : "missing", detail: profile.vin_number ? String(profile.vin_number) : "Not provided" });

      if (profile.insurance_expiration) {
        const exp = new Date(profile.insurance_expiration as string);
        const now = new Date();
        const daysLeft = Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        if (daysLeft < 0) {
          checks.push({ label: "Insurance Expiration", status: "expired", detail: `Expired ${exp.toLocaleDateString()}` });
        } else if (daysLeft < 30) {
          checks.push({ label: "Insurance Expiration", status: "warning", detail: `Expires in ${daysLeft} days (${exp.toLocaleDateString()})` });
        } else {
          checks.push({ label: "Insurance Expiration", status: "ok", detail: exp.toLocaleDateString() });
        }
      } else {
        checks.push({ label: "Insurance Expiration", status: "missing", detail: "Not provided" });
      }

      if (profile.cdl_expiration) {
        const exp = new Date(profile.cdl_expiration as string);
        const now = new Date();
        const daysLeft = Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        if (daysLeft < 0) {
          checks.push({ label: "CDL Expiration", status: "expired", detail: `Expired ${exp.toLocaleDateString()}` });
        } else if (daysLeft < 30) {
          checks.push({ label: "CDL Expiration", status: "warning", detail: `Expires in ${daysLeft} days (${exp.toLocaleDateString()})` });
        } else {
          checks.push({ label: "CDL Expiration", status: "ok", detail: exp.toLocaleDateString() });
        }
      }

      // Doc flags
      if (profile.doc_flags) {
        const flags = JSON.parse(JSON.stringify(profile.doc_flags));
        if (Array.isArray(flags)) {
          for (const flag of flags) {
            if (flag === "VIN_NOT_ON_INSURANCE") {
              checks.push({ label: "VIN Match", status: "warning", detail: "Truck VIN not found on insurance policy" });
            }
          }
        }
      }

    const isReady = profile.completion_status === "dispatch_ready";
    const hasMissing = checks.some(c => c.status === "missing" || c.status === "expired");
    const hasWarnings = checks.some(c => c.status === "warning");

    const statusIcon = isReady ? "✓" : hasMissing ? "○" : hasWarnings ? "⚠" : "◐";
    const statusColor = isReady ? "#2e7d32" : hasMissing ? "#C8892A" : hasWarnings ? "#f57f17" : "#6B7A8A";
    const statusLabel = isReady ? "Dispatch-ready" : hasMissing ? "Profile incomplete" : hasWarnings ? "Review needed" : "Profile on file";

    const checksHtml = checks.map(c => {
      const icon = c.status === "ok" ? "✓" : c.status === "missing" ? "○" : c.status === "expired" ? "✗" : c.status === "warning" ? "⚠" : "?";
      const color = c.status === "ok" ? "#2e7d32" : c.status === "missing" ? "#C8892A" : c.status === "expired" ? "#c62828" : c.status === "warning" ? "#f57f17" : "#6B7A8A";
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--cream2)">
        <span style="font-size:13px;color:var(--ink)">${h(c.label)}</span>
        <span style="font-size:12px;color:${color};font-weight:500">${icon} ${h(c.detail)}</span>
      </div>`;
    }).join("");

    res.send(pageShell(`MC#${mc} Status`, `
    <div class="page" style="max-width:480px;margin:0 auto">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:48px;margin-bottom:12px">${statusIcon}</div>
        <div class="page-eyebrow">MC#${h(mc)}</div>
        <h1 class="page-title" style="font-size:22px">${h(carrier?.fmcsa_legal_name || (profile.company_name as string) || "Carrier Profile")}</h1>
        <div style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;color:${statusColor};background:${statusColor}15;margin-top:8px">
          ${statusLabel}
        </div>
      </div>

      <div style="background:white;border:1px solid var(--cream2);border-radius:6px;padding:16px;margin-bottom:20px">
        ${checksHtml || '<div style="padding:12px 0;font-size:13px;color:var(--muted)">No profile data yet. Complete your profile to see status.</div>'}
      </div>

      ${!isReady ? `
      <a href="/profile/carrier?mc=${h(mc)}&source=status_return" style="display:block;width:100%;padding:14px;background:var(--amber);color:white;border-radius:6px;text-decoration:none;text-align:center;font-size:14px;font-weight:600">
        Upload missing docs →
      </a>` : `
      <div style="text-align:center;font-size:13px;color:var(--muted);padding:12px 0">
        All documents current. You're ready for dispatch.
      </div>`}

      ${verification ? `
      <div style="margin-top:20px;padding:12px 16px;background:white;border:1px solid var(--cream2);border-radius:6px;font-size:12px;color:var(--muted)">
        Last verification: <strong style="color:${verification.result === "CLEAR" ? "#2e7d32" : verification.result === "CAUTION" ? "#f57f17" : "#c62828"}">${verification.result || verification.status}</strong>
        ${verification.result_delivered_at ? " — " + new Date(verification.result_delivered_at as string).toLocaleDateString() : ""}
      </div>` : ""}

      <div style="text-align:center;margin-top:20px">
        <a href="https://connectedcarriers.org" style="font-size:13px;color:var(--muted);text-decoration:none">← Back to Connected Carriers</a>
      </div>
    </div>`));
  } catch (err) {
    console.error("[carrier status]", err);
    res.status(500).send(pageShell("Error", `<div class="page" style="text-align:center;padding:40px"><p>Something went wrong. Please try again.</p></div>`));
  }
});

export default router;

// ── Page shell (matches existing interest form design) ──────────

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
    --ink: #141414; --muted: #6B7A8A; --green: #4A8C1C;
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
    outline: none; transition: border-color 0.15s;
  }
  .field input[type="file"] { padding: 8px; font-size: 13px; }
  .field input:focus, .field select:focus, .field textarea:focus { border-color: var(--amber); }
  .field textarea { resize: vertical; min-height: 70px; }
  .required { color: #ef4444; }
  .field-hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .check-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .check-item { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 5px 0; cursor: pointer; }
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
  .urgency-bar { background: #FFF8ED; border: 1px solid #F0DFC0; border-radius: 3px; padding: 14px 18px; margin-bottom: 20px; }
  .urgency-bar p { font-size: 13px; color: #8B6914; margin: 0; }
  .urgency-bar strong { color: var(--slate); }
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

// ── Profile form page ──────────────────────────────────────────

function profilePage(source: string, error?: string, success?: string, prefill?: Record<string, string>, existingProfile?: Record<string, unknown> | null): string {
  const isSupersedeNudge = source === "superseded_nudge";
  const pf = prefill || { mc: "", name: "", phone: "", email: "" };
  const ep = existingProfile || null;

  // Build "what's on file" summary if returning carrier
  let onFileHtml = "";
  if (ep) {
    const checks = [
      { label: "Company", value: ep.company_name, ok: !!ep.company_name },
      { label: "CDL photo", value: ep.cdl_photo_url ? "On file" : null, ok: !!ep.cdl_photo_url },
      { label: "Insurance (COI)", value: ep.insurance_doc_url ? "On file" : null, ok: !!ep.insurance_doc_url },
      { label: "VIN / cab card photo", value: ep.vin_photo_url ? "On file" : null, ok: !!ep.vin_photo_url },
      { label: "Driver name", value: ep.driver_name, ok: !!ep.driver_name },
      { label: "Truck VIN", value: ep.vin_number, ok: !!ep.vin_number },
      { label: "Insurance expiration", value: ep.insurance_expiration ? new Date(ep.insurance_expiration as string).toLocaleDateString() : null, ok: !!ep.insurance_expiration },
      { label: "CDL expiration", value: ep.cdl_expiration ? new Date(ep.cdl_expiration as string).toLocaleDateString() : null, ok: !!ep.cdl_expiration },
    ];
    const missing = checks.filter(c => !c.ok);
    const isReady = ep.completion_status === "dispatch_ready";

    onFileHtml = `
    <div style="background:${isReady ? "#E8F5E9" : "#FFF8E1"};border:1px solid ${isReady ? "#C8E6C9" : "#FFE082"};border-radius:6px;padding:16px;margin-bottom:20px">
      <div style="font-size:14px;font-weight:600;color:${isReady ? "#2e7d32" : "#f57f17"};margin-bottom:8px">
        ${isReady ? "✓ You're dispatch-ready." : "Profile on file — some items missing."}
      </div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6">
        ${checks.map(c => `<div>${c.ok ? "✓" : "○"} ${h(c.label)}${c.ok && c.value && c.value !== "On file" ? ": " + h(String(c.value)) : c.ok ? "" : " — needed"}</div>`).join("")}
      </div>
      ${isReady
        ? `<div style="font-size:12px;color:var(--muted);margin-top:8px">You can update any document below if something has changed.</div>`
        : `<div style="font-size:12px;color:#f57f17;margin-top:8px">Upload the missing items below to reach dispatch-ready status.</div>`
      }
    </div>`;
  }

  return pageShell("Carrier Profile", `
<div class="page">
  <div class="page-head">
    <div class="page-eyebrow">Carrier profile</div>
    <h1 class="page-title">${isSupersedeNudge ? "Get cleared faster next time" : "Complete your carrier profile"}</h1>
    <p class="page-sub">${isSupersedeNudge
      ? "Carriers with a complete profile get dispatched faster. Submit your docs now and skip the wait on your next load."
      : "Complete your profile once and be dispatch-ready whenever a broker needs you. No more chasing docs on every load."
    }</p>
  </div>

  ${isSupersedeNudge ? `
  <div class="urgency-bar">
    <p><strong>Your last load was assigned to another carrier</strong> because docs weren't ready in time. Complete your profile now so you're cleared before the next one.</p>
  </div>` : ""}

  ${error ? `<div class="error-banner">⚠ ${h(error)}</div>` : ""}
  ${success ? `<div style="background:#E8F5E9;border:1px solid #C8E6C9;border-radius:6px;padding:14px;margin-bottom:16px;font-size:13px;color:#2e7d32">${h(success)}</div>` : ""}

  ${onFileHtml}

  <form method="POST" action="/profile/carrier" enctype="multipart/form-data" id="profile-form">
    <input type="hidden" name="source" value="${h(source)}">

    <div class="card">
      <div class="section-label">Your company</div>
      <div class="field">
        <label>Legal company name <span class="required">*</span></label>
        <input type="text" name="company_name" required placeholder="e.g. Swift Eagle Transport LLC" autocomplete="organization">
      </div>
      <div class="field">
        <label>MC number</label>
        <input type="text" name="mc_number" placeholder="e.g. 1234567" inputmode="numeric" value="${h(pf.mc)}">
        <div class="field-hint">Digits only — no "MC" prefix needed.</div>
      </div>
      <div class="two-col">
        <div class="field">
          <label>Contact name <span class="required">*</span></label>
          <input type="text" name="contact_name" required placeholder="Full name" autocomplete="name" value="${h(pf.name)}">
        </div>
        <div class="field">
          <label>Phone</label>
          <input type="tel" name="phone" placeholder="e.g. 602-555-0100" autocomplete="tel" inputmode="tel" value="${h(pf.phone)}">
        </div>
      </div>
      <div class="field">
        <label>Email <span class="required">*</span></label>
        <input type="email" name="email" required placeholder="dispatch@yourcompany.com" autocomplete="email" inputmode="email" value="${h(pf.email)}">
      </div>
    </div>

    <div class="card">
      <div class="section-label">Driver & truck details</div>
      <div class="two-col">
        <div class="field">
          <label>Driver name</label>
          <input type="text" name="driver_name" placeholder="Full name" value="${ep?.driver_name ? h(String(ep.driver_name)) : ''}">
        </div>
        <div class="field">
          <label>Driver phone</label>
          <input type="tel" name="driver_phone" placeholder="e.g. 509-555-1212" inputmode="tel" value="${ep?.driver_phone ? h(String(ep.driver_phone)) : ''}">
        </div>
      </div>
      <div class="two-col">
        <div class="field">
          <label>Truck number</label>
          <input type="text" name="truck_number" placeholder="e.g. 4821" value="${ep?.truck_number ? h(String(ep.truck_number)) : ''}">
        </div>
        <div class="field">
          <label>Trailer number</label>
          <input type="text" name="trailer_number" placeholder="e.g. TR-2209" value="${ep?.trailer_number ? h(String(ep.trailer_number)) : ''}">
        </div>
      </div>
      <div class="field">
        <label>VIN number (truck)</label>
        <input type="text" name="vin_number" placeholder="e.g. 1HGBH41JXMN109186" value="${ep?.vin_number ? h(String(ep.vin_number)) : ''}" maxlength="17" style="text-transform:uppercase;letter-spacing:0.05em">
        <div class="field-hint">17-character Vehicle Identification Number. Found on the driver's door jamb or registration. We'll auto-fill this if you upload a VIN photo below.</div>
      </div>
    </div>

    <div class="card">
      <div class="section-label">Documents — upload now, skip the wait later</div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:16px">Upload your docs and we'll automatically read the key details. No need to type everything — just upload the photo.</p>
      <div class="field">
        <label>CDL photo</label>
        <input type="file" name="cdl_photo" accept="image/*,.pdf">
        <div class="field-hint">Photo or scan of driver's CDL. We'll extract the license number, class, and expiration date automatically.</div>
      </div>
      <div class="field">
        <label>VIN photo (truck door)</label>
        <input type="file" name="vin_photo" accept="image/*,.pdf">
        <div class="field-hint">Photo of VIN on truck door or registration. We'll read the VIN and cross-reference it with your insurance.</div>
      </div>
      <div class="field">
        <label>Insurance certificate (COI)</label>
        <input type="file" name="insurance_doc" accept="image/*,.pdf">
        <div class="field-hint">Current certificate of insurance. We'll extract the expiration date, coverage amounts, and VINs on the policy.</div>
      </div>
      <div class="two-col">
        <div class="field">
          <label>Insurance expiration date</label>
          <input type="date" name="insurance_expiration">
          <div class="field-hint">Auto-filled from your COI if uploaded. Enter manually if the upload doesn't capture it.</div>
        </div>
        <div class="field">
          <label>CDL expiration date</label>
          <input type="date" name="cdl_expiration">
          <div class="field-hint">Auto-filled from your CDL photo if uploaded.</div>
        </div>
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
    </div>

    <div style="margin:20px 0">
      <div style="font-size:11px;color:#6B7A8A;line-height:1.5;margin-bottom:10px">
        By submitting, I agree to receive SMS messages from Connected Carriers about document verification and dispatch status. Standard message and data rates may apply. Reply STOP to opt out. <a href="https://connectedcarriers.org/terms.html" target="_blank" style="color:#C8892A">Terms</a> & <a href="https://connectedcarriers.org/privacy.html" target="_blank" style="color:#C8892A">Privacy</a>.
      </div>
      <label style="display:flex;gap:10px;align-items:flex-start;font-size:13px;color:#6B7A8A;cursor:pointer">
        <input type="checkbox" name="consent_network_reuse" value="yes" checked style="margin-top:2px;flex-shrink:0">
        <span>Save my carrier profile so brokers using Connected Carriers can qualify me faster.</span>
      </label>
    </div>

    <button type="submit" class="submit-btn" id="profile-submit">Submit Profile →</button>
  </form>
  <div class="powered">Powered by Connected Carriers · A HoneXAI product</div>
</div>
<script>
document.getElementById('profile-form').addEventListener('submit', function() {
  const btn = document.getElementById('profile-submit');
  btn.disabled = true; btn.textContent = 'Uploading…';
});
</script>`);
}

// ── Confirmation page ──────────────────────────────────────────

function profileConfirmationPage(completion: string, statusToken?: string): string {
  const isReady = completion === "dispatch_ready";
  const statusUrl = statusToken ? `/carrier/status/${statusToken}` : null;
  return pageShell("Profile Submitted", `
<div class="page" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;text-align:center">
  <div style="font-size:48px;margin-bottom:20px">${isReady ? "✓" : "◐"}</div>
  <div class="page-eyebrow">Carrier Profile</div>
  <h1 class="page-title" style="font-size:24px;margin-bottom:12px">
    ${isReady ? "You're dispatch-ready." : "Profile received — not complete yet."}
  </h1>
  <p style="font-size:14px;color:var(--muted);max-width:420px;line-height:1.7">
    ${isReady
      ? "All required documents are on file. When a broker assigns you a load, you'll be cleared to roll without waiting for doc collection."
      : "We have your info, but some items are still needed to reach dispatch-ready status. Upload the missing docs to get fully verified."
    }
  </p>
  ${!isReady && statusUrl ? `
  <a href="${statusUrl}" style="display:inline-block;margin-top:16px;padding:10px 24px;background:var(--amber);color:white;border-radius:4px;text-decoration:none;font-size:14px;font-weight:500">See what's missing →</a>
  ` : ""}
  ${statusUrl ? `
  <a href="${statusUrl}" style="margin-top:12px;font-size:13px;color:var(--amber);text-decoration:none">Check your status anytime →</a>
  ` : ""}
  <a href="https://connectedcarriers.org" style="margin-top:16px;font-size:13px;color:var(--muted);text-decoration:none">← Back to Connected Carriers</a>
</div>`);
}
