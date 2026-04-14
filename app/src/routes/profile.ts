import { Router, Request, Response } from "express";
import multer from "multer";
import { query } from "../db";
import { h } from "../middleware/security";
import { uploadToR2, isR2Configured } from "../lib/storage";

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

router.get("/profile/carrier", (req: Request, res: Response) => {
  const source = (req.query.source as string) || "direct";
  res.send(profilePage(source, req.query.error as string, req.query.success as string));
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

    await query(`
      INSERT INTO carrier_profiles
        (company_name, mc_number, contact_name, email, phone,
         driver_name, driver_phone, truck_number, trailer_number,
         equipment_types, lanes_or_regions,
         cdl_photo_url, cdl_photo_r2_key,
         vin_photo_url, vin_photo_r2_key,
         insurance_doc_url, insurance_doc_r2_key,
         vin_number, insurance_expiration, cdl_expiration,
         completion_status, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    `, [
      company_name.trim(), mc_number?.replace(/\D/g, "") || null,
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
    ]);

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

    res.send(profileConfirmationPage(completion));
  } catch (err) {
    console.error("Carrier profile submission error:", err);
    res.status(500).send(profilePage(source || "direct", "Something went wrong. Please try again."));
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

function profilePage(source: string, error?: string, success?: string): string {
  const isSupersedeNudge = source === "superseded_nudge";

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
        <input type="text" name="mc_number" placeholder="e.g. 1234567" inputmode="numeric">
        <div class="field-hint">Digits only — no "MC" prefix needed.</div>
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
      <div class="section-label">Driver & truck details</div>
      <div class="two-col">
        <div class="field">
          <label>Driver name</label>
          <input type="text" name="driver_name" placeholder="Full name">
        </div>
        <div class="field">
          <label>Driver phone</label>
          <input type="tel" name="driver_phone" placeholder="e.g. 509-555-1212" inputmode="tel">
        </div>
      </div>
      <div class="two-col">
        <div class="field">
          <label>Truck number</label>
          <input type="text" name="truck_number" placeholder="e.g. 4821">
        </div>
        <div class="field">
          <label>Trailer number</label>
          <input type="text" name="trailer_number" placeholder="e.g. TR-2209">
        </div>
      </div>
      <div class="field">
        <label>VIN number (truck)</label>
        <input type="text" name="vin_number" placeholder="e.g. 1HGBH41JXMN109186" maxlength="17" style="text-transform:uppercase;letter-spacing:0.05em">
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

function profileConfirmationPage(completion: string): string {
  const isReady = completion === "dispatch_ready";
  return pageShell("Profile Submitted", `
<div class="page" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;text-align:center">
  <div style="font-size:48px;margin-bottom:20px">${isReady ? "✓" : "◐"}</div>
  <div class="page-eyebrow">Carrier Profile</div>
  <h1 class="page-title" style="font-size:24px;margin-bottom:12px">
    ${isReady ? "You're dispatch-ready." : "Profile received."}
  </h1>
  <p style="font-size:14px;color:var(--muted);max-width:400px;line-height:1.7">
    ${isReady
      ? "All required documents are on file. When a broker assigns you a load, you'll be cleared to roll without waiting for doc collection."
      : "We have your info on file. Some documents are still missing — you can come back to this page anytime to upload them and reach full dispatch-ready status."
    }
  </p>
  <a href="https://connectedcarriers.org" style="margin-top:28px;font-size:13px;color:var(--amber);text-decoration:none">← Back to Connected Carriers</a>
</div>`);
}
