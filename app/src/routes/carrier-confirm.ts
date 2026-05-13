/**
 * Carrier confirmation routes — /confirm/:token
 *
 * After Kate assigns a carrier, the carrier confirms which driver
 * and truck are on this load. Only missing/expired docs are requested.
 *
 * SPINE-0009 (Dispatch Package)
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import multer from "multer";
import { query } from "../db";
import { uploadToR2, isR2Configured } from "../lib/storage";
import { syncCanonicalCarrierRecords } from "../services/carrier-records";
import { evaluateDispatchPackage } from "../services/dispatch-evaluation";
import { createDispatchSignal } from "../services/dispatch-signal";
import { sendSms } from "../lib/sms";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ══════════════════════════════════════════════════════════════════
// GET /confirm/:token
// ══════════════════════════════════════════════════════════════════

router.get("/confirm/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    // Look up assignment
    const assignResult = await query(
      `SELECT la.*, cl.load_id, cl.origin, cl.destination, cl.equipment,
              cl.pickup_date, cl.pickup_address, cl.pickup_window_text,
              c.mc_number, c.fmcsa_legal_name
       FROM load_assignments la
       JOIN canonical_loads cl ON cl.id = la.load_id
       JOIN carriers c ON c.id = la.carrier_id
       WHERE la.confirmation_token = $1`,
      [token]
    );

    if (!assignResult.rows.length) {
      return res.status(404).send(shell("Not Found", `
        <div style="text-align:center;padding:40px">
          <div style="font-size:36px;margin-bottom:16px">?</div>
          <p>This confirmation link is not valid or has expired.</p>
        </div>`));
    }

    const a = assignResult.rows[0];

    // If already confirmed, show current state instead of error
    if (a.confirmed_at) {
      const eval_ = a.driver_id && a.equipment_id
        ? await evaluateDispatchPackage(a.carrier_id, a.driver_id, a.equipment_id)
        : null;
      return res.send(shell("Confirmed", confirmedPage(a, eval_)));
    }

    // If cancelled/superseded
    if (a.status === "cancelled" || a.status === "superseded") {
      return res.send(shell("Unavailable", `
        <div style="text-align:center;padding:40px">
          <div style="font-size:36px;margin-bottom:16px">—</div>
          <p>This assignment is no longer active.</p>
        </div>`));
    }

    // Load carrier's active drivers + equipment
    const drivers = await query(
      "SELECT * FROM carrier_drivers WHERE carrier_id = $1 AND status = 'active' ORDER BY updated_at DESC",
      [a.carrier_id]
    );
    const equipment = await query(
      "SELECT * FROM carrier_equipment WHERE carrier_id = $1 AND status = 'active' ORDER BY updated_at DESC",
      [a.carrier_id]
    );

    // Per-driver CDL status (doc check, not full eval)
    const driverDocs: Record<number, { cdl: string }> = {};
    for (const d of drivers.rows) {
      const cdl = await query(
        `SELECT expiration_date, expires_at, status FROM carrier_documents
         WHERE carrier_id = $1 AND driver_id = $2
           AND (doc_type = 'cdl' OR document_type = 'cdl')
           AND COALESCE(status, 'current') NOT IN ('superseded')
         ORDER BY created_at DESC LIMIT 1`,
        [a.carrier_id, d.id]
      );
      if (!cdl.rows.length) {
        driverDocs[d.id] = { cdl: "missing" };
      } else {
        const exp = cdl.rows[0].expiration_date || cdl.rows[0].expires_at;
        const s = cdl.rows[0].status;
        if (s === "expired" || (exp && new Date(exp) < new Date())) driverDocs[d.id] = { cdl: "expired" };
        else if (s === "expiring") driverDocs[d.id] = { cdl: "expiring" };
        else driverDocs[d.id] = { cdl: "ok" };
      }
    }

    // Per-equipment cab card status
    const equipDocs: Record<number, { cab: string }> = {};
    for (const e of equipment.rows) {
      const cab = await query(
        `SELECT status FROM carrier_documents
         WHERE carrier_id = $1 AND equipment_id = $2
           AND (doc_type IN ('cab_card','truck_photo') OR document_type IN ('cab_card','truck_photo','vin_photo'))
           AND COALESCE(status, 'current') NOT IN ('superseded')
         ORDER BY created_at DESC LIMIT 1`,
        [a.carrier_id, e.id]
      );
      equipDocs[e.id] = { cab: cab.rows.length ? "ok" : "missing" };
    }

    // Carrier-level insurance status (shown once)
    const insResult = await query(
      `SELECT expiration_date, expires_at, status FROM carrier_documents
       WHERE carrier_id = $1 AND (doc_type = 'insurance' OR document_type = 'coi')
         AND COALESCE(status, 'current') NOT IN ('superseded')
       ORDER BY created_at DESC LIMIT 1`,
      [a.carrier_id]
    );
    let insStatus = "missing";
    if (insResult.rows.length) {
      const s = insResult.rows[0].status;
      const exp = insResult.rows[0].expiration_date || insResult.rows[0].expires_at;
      if (s === "expired" || (exp && new Date(exp) < new Date())) insStatus = "expired";
      else if (s === "expiring") insStatus = "expiring";
      else insStatus = "ok";
    }

    res.send(shell("Confirm for Load", confirmationForm(token, a, drivers.rows, equipment.rows, driverDocs, equipDocs, insStatus)));
  } catch (err) {
    console.error("[confirm GET]", err);
    res.status(500).send(shell("Error", `<div style="text-align:center;padding:40px"><p>Something went wrong.</p></div>`));
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /confirm/:token
// ══════════════════════════════════════════════════════════════════

router.post("/confirm/:token", upload.fields([
  { name: "cdl", maxCount: 1 },
  { name: "insurance", maxCount: 1 },
  { name: "cab_card", maxCount: 1 },
]), async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    // Look up assignment — must be active
    const assignResult = await query(
      `SELECT la.*, cl.load_id as cl_load_id, cl.origin, cl.destination, cl.equipment as cl_equipment,
              cl.pickup_date, cl.pickup_address, cl.pickup_window_text, cl.broker_account_id,
              c.mc_number, c.fmcsa_legal_name
       FROM load_assignments la
       JOIN canonical_loads cl ON cl.id = la.load_id
       JOIN carriers c ON c.id = la.carrier_id
       WHERE la.confirmation_token = $1`,
      [token]
    );

    if (!assignResult.rows.length) {
      return res.status(404).send(shell("Not Found", `<div style="text-align:center;padding:40px"><p>Invalid confirmation link.</p></div>`));
    }

    const a = assignResult.rows[0];

    if (a.status === "cancelled" || a.status === "superseded") {
      return res.send(shell("Unavailable", `<div style="text-align:center;padding:40px"><p>This assignment is no longer active.</p></div>`));
    }

    if (a.confirmed_at) {
      const eval_ = a.driver_id && a.equipment_id
        ? await evaluateDispatchPackage(a.carrier_id, a.driver_id, a.equipment_id)
        : null;
      return res.send(shell("Confirmed", confirmedPage(a, eval_)));
    }

    // ── Resolve driver ──────────────────────────────────────────

    let driverId: number | null = null;
    const submittedDriverId = parseInt(req.body.driver_id);
    const newDriverName = (req.body.new_driver_name || "").trim();

    if (submittedDriverId) {
      // Verify driver belongs to this carrier
      const dCheck = await query(
        "SELECT id FROM carrier_drivers WHERE id = $1 AND carrier_id = $2",
        [submittedDriverId, a.carrier_id]
      );
      if (!dCheck.rows.length) {
        return res.status(400).send(shell("Error", `<div style="text-align:center;padding:40px"><p>Selected driver does not belong to this carrier.</p></div>`));
      }
      driverId = submittedDriverId;
    } else if (newDriverName) {
      // Create new driver via sync
      const syncResult = await syncCanonicalCarrierRecords({
        carrier_id: a.carrier_id,
        driver: {
          name: newDriverName,
          phone: (req.body.new_driver_phone || "").trim() || null,
        },
        documents: [],
        source: "confirm",
      });
      driverId = syncResult.driver_id;
    }

    if (!driverId) {
      return res.status(400).send(shell("Error", `<div style="text-align:center;padding:40px"><p>Please select or add a driver.</p></div>`));
    }

    // ── Resolve equipment ───────────────────────────────────────

    let equipmentId: number | null = null;
    const submittedEquipId = parseInt(req.body.equipment_id);
    const newTruckNumber = (req.body.new_truck_number || "").trim();
    const newVin = (req.body.new_vin || "").trim();

    if (submittedEquipId) {
      const eCheck = await query(
        "SELECT id FROM carrier_equipment WHERE id = $1 AND carrier_id = $2",
        [submittedEquipId, a.carrier_id]
      );
      if (!eCheck.rows.length) {
        return res.status(400).send(shell("Error", `<div style="text-align:center;padding:40px"><p>Selected equipment does not belong to this carrier.</p></div>`));
      }
      equipmentId = submittedEquipId;
    } else if (newTruckNumber || newVin) {
      const syncResult = await syncCanonicalCarrierRecords({
        carrier_id: a.carrier_id,
        equipment: {
          truck_number: newTruckNumber || null,
          vin_number: newVin || null,
          trailer_number: (req.body.new_trailer || "").trim() || null,
        },
        documents: [],
        source: "confirm",
      });
      equipmentId = syncResult.equipment_id;
    }

    if (!equipmentId) {
      return res.status(400).send(shell("Error", `<div style="text-align:center;padding:40px"><p>Please select or add a truck.</p></div>`));
    }

    // ── Upload docs ─────────────────────────────────────────────

    const files = req.files as Record<string, Express.Multer.File[]>;
    const docInputs: Array<{ doc_type: "cdl" | "insurance" | "cab_card"; r2_key: string; file_url: string | null }> = [];

    if (isR2Configured()) {
      const mc = a.mc_number || "unknown";
      for (const [field, docType] of [["cdl", "cdl"], ["insurance", "insurance"], ["cab_card", "cab_card"]] as const) {
        if (files[field]?.[0]) {
          const f = files[field][0];
          const uploaded = await uploadToR2(f.buffer, f.originalname, f.mimetype, `confirm/${mc}`);
          docInputs.push({ doc_type: docType, r2_key: uploaded.objectKey, file_url: uploaded.fileUrl });
        }
      }
    }

    // Sync all docs via canonical utility
    if (docInputs.length > 0) {
      await syncCanonicalCarrierRecords({
        carrier_id: a.carrier_id,
        driver_id: driverId,
        equipment_id: equipmentId,
        documents: docInputs,
        source: "confirm",
      });
    }

    // ── Evaluate dispatch package ───────────────────────────────

    const evaluation = await evaluateDispatchPackage(a.carrier_id, driverId, equipmentId);

    // ── Update assignment ───────────────────────────────────────

    let assignmentStatus: string;
    let loadStatus: string;

    if (evaluation.result === "clear") {
      assignmentStatus = "clear";
      loadStatus = "clear_to_dispatch";
    } else if (evaluation.result === "review") {
      assignmentStatus = "caution";
      loadStatus = "review";
    } else if (evaluation.result === "do_not_use") {
      assignmentStatus = "do_not_use";
      loadStatus = "do_not_use";
    } else {
      // docs_needed
      assignmentStatus = "documents_pending";
      loadStatus = "waiting_on_docs";
    }

    await query(
      `UPDATE load_assignments
       SET driver_id = $1, equipment_id = $2, confirmed_at = NOW(), status = $3, updated_at = NOW()
       WHERE id = $4`,
      [driverId, equipmentId, assignmentStatus, a.id]
    );

    await query(
      "UPDATE canonical_loads SET status = $1, updated_at = NOW() WHERE id = $2",
      [loadStatus, a.load_id]
    );

    // ── Store SMS consent ───────────────────────────────────────

    const consentText = "By submitting, I agree to receive SMS messages from Connected Carriers about document verification and dispatch status.";
    const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || null;
    const userAgent = (req.headers["user-agent"] as string) || null;

    let confirmedDriverPhone: string | null = null;
    let confirmedDriverName = "Driver";
    try {
      const driverResult = await query(
        "SELECT driver_name, driver_phone FROM carrier_drivers WHERE id = $1 AND carrier_id = $2",
        [driverId, a.carrier_id]
      );
      confirmedDriverPhone = driverResult.rows[0]?.driver_phone || null;
      confirmedDriverName = driverResult.rows[0]?.driver_name || "Driver";
    } catch { /* non-fatal */ }

    try {
      await query(
        `INSERT INTO carrier_consents (carrier_id, consent_type, granted, source, phone, consent_text, ip_address, user_agent, load_id, granted_at)
         VALUES ($1, 'sms_verification', true, 'confirm', $2, $3, $4, $5, $6, NOW())`,
        [a.carrier_id, confirmedDriverPhone, consentText, ipAddress, userAgent, a.load_id]
      );
    } catch { /* non-fatal */ }

    // ── If clear: trigger dispatch signal using confirmed driver's phone ──

    if (evaluation.result === "clear") {
      try {
        const brokerResult = await query(
          "SELECT contact_phone FROM broker_accounts WHERE id = $1",
          [a.broker_account_id]
        );
        const brokerPhone = brokerResult.rows[0]?.contact_phone || "";

        if (confirmedDriverPhone && (a.pickup_address || a.origin)) {
          const signalResult = await createDispatchSignal({
            load_id: a.cl_load_id,
            assignment_id: a.id,
            carrier_id: a.carrier_id,
            driver_phone: confirmedDriverPhone,
            broker_phone: brokerPhone,
            mc_number: a.mc_number,
            carrier_name: a.fmcsa_legal_name,
            pickup_address: a.pickup_address || "",
            origin: a.origin,
          });

          await query(
            `UPDATE load_assignments SET status = 'arrival_pending', dispatch_signal_id = $1, dispatch_signal_ref = $2, updated_at = NOW() WHERE id = $3`,
            [signalResult.id, signalResult.dispatch_verification_id, a.id]
          );
          await query(
            "UPDATE canonical_loads SET status = 'arrival_sent', updated_at = NOW() WHERE id = $1",
            [a.load_id]
          );
        }
      } catch (err) {
        console.error("[confirm] Dispatch signal error (non-fatal):", err);
      }
    }

    // ── Notify broker ───────────────────────────────────────────

    try {
      const brokerResult = await query(
        "SELECT contact_phone, company_name FROM broker_accounts WHERE id = $1",
        [a.broker_account_id]
      );
      const broker = brokerResult.rows[0];
      if (broker?.contact_phone) {
        const carrierName = a.fmcsa_legal_name || `MC${a.mc_number}`;

        const statusMsg = evaluation.result === "clear"
          ? `✓ ${carrierName} confirmed: ${confirmedDriverName} for ${a.cl_load_id}. Clear to dispatch — arrival check sent.`
          : evaluation.result === "review"
          ? `⚠ ${carrierName} confirmed ${confirmedDriverName} for ${a.cl_load_id} with flags: ${evaluation.warnings.join(", ")}`
          : evaluation.result === "do_not_use"
          ? `✗ ${carrierName} — DO NOT USE for ${a.cl_load_id}: ${evaluation.blockers.join(", ")}`
          : `${carrierName} confirmed ${confirmedDriverName} for ${a.cl_load_id}. Still needs: ${evaluation.missing.join(", ")}`;

        await sendSms(broker.contact_phone, `Connected Carriers: ${statusMsg}`);
      }
    } catch (err) {
      console.error("[confirm] Broker notification error:", err);
    }

    // ── Show result page ────────────────────────────────────────

    const refreshed = await query(
      `SELECT la.*, cl.load_id, cl.origin, cl.destination
       FROM load_assignments la JOIN canonical_loads cl ON cl.id = la.load_id
       WHERE la.id = $1`, [a.id]
    );

    res.send(shell("Confirmed", confirmedPage(refreshed.rows[0] || a, evaluation)));

  } catch (err) {
    console.error("[confirm POST]", err);
    res.status(500).send(shell("Error", `<div style="text-align:center;padding:40px"><p>Something went wrong. Please try again.</p></div>`));
  }
});

export default router;


// ══════════════════════════════════════════════════════════════════
// Page templates
// ══════════════════════════════════════════════════════════════════

function h(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shell(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0">
<title>${h(title)} — Connected Carriers</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--slate:#1C2B3A;--amber:#C8892A;--cream:#F7F5F0;--cream2:#EDE9E1;--muted:#6B7A8A;--sans:'DM Sans',system-ui,sans-serif;--serif:'Playfair Display',Georgia,serif}
  body{font-family:var(--sans);background:var(--slate);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
  .page{background:var(--cream);border-radius:8px;padding:24px;max-width:480px;width:100%}
  .tag{font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--amber);font-weight:600;margin-bottom:4px}
  .route{font-size:20px;font-weight:600;color:var(--slate);margin-bottom:4px}
  .detail{font-size:13px;color:var(--muted);margin-bottom:2px}
  .divider{height:1px;background:#E0DAD0;margin:16px 0}
  .section-label{font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);font-weight:600;margin-bottom:8px}
  .option{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--cream2);border-radius:6px;margin-bottom:6px;cursor:pointer}
  .option:hover{border-color:var(--amber)}
  .option input[type=radio]{flex-shrink:0}
  .option-name{font-size:14px;font-weight:500;color:var(--slate)}
  .option-detail{font-size:12px;color:var(--muted)}
  .badge{display:inline-block;padding:1px 6px;border-radius:2px;font-size:10px;font-weight:600}
  .badge-ok{background:#EAF3DE;color:#3b6d11}
  .badge-missing{background:#F0EDE7;color:#6b7a8a}
  .badge-expired{background:#FFEBEE;color:#c62828}
  .badge-expiring{background:#FFF8E1;color:#f57f17}
  .new-fields{display:none;margin-top:8px;padding:12px;background:#FAFAF8;border-radius:6px}
  .new-fields.active{display:block}
  .field{margin-bottom:8px}
  .field label{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}
  .field input,.field select{width:100%;padding:9px 12px;border:1px solid var(--cream2);border-radius:6px;font-size:14px;font-family:var(--sans);outline:none}
  .field input:focus{border-color:var(--amber)}
  .upload-field{margin-bottom:10px}
  .upload-field label{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}
  .btn{width:100%;padding:14px;background:var(--amber);border:none;border-radius:6px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--sans)}
  .btn:disabled{opacity:0.5}
  .ins-status{padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:12px}
  .result-card{text-align:center;padding:24px 16px}
  .result-icon{font-size:40px;margin-bottom:12px}
  .powered{text-align:center;font-size:11px;color:var(--muted);margin-top:16px}
  .powered a{color:var(--amber);text-decoration:none}
</style></head><body>
<div class="page">${body}
  <div class="powered">Powered by <a href="https://connectedcarriers.org">Connected Carriers</a></div>
</div></body></html>`;
}

function confirmationForm(
  token: string,
  a: Record<string, unknown>,
  drivers: Array<Record<string, unknown>>,
  equipment: Array<Record<string, unknown>>,
  driverDocs: Record<number, { cdl: string }>,
  equipDocs: Record<number, { cab: string }>,
  insStatus: string,
): string {
  const driverOptions = drivers.map(d => {
    const cdl = driverDocs[d.id as number] || { cdl: "missing" };
    const badge = cdl.cdl === "ok" ? '<span class="badge badge-ok">CDL current</span>'
      : cdl.cdl === "expiring" ? '<span class="badge badge-expiring">CDL expiring</span>'
      : cdl.cdl === "expired" ? '<span class="badge badge-expired">CDL expired</span>'
      : '<span class="badge badge-missing">CDL needed</span>';
    return `<label class="option">
      <input type="radio" name="driver_id" value="${d.id}" ${drivers.length === 1 ? "checked" : ""}>
      <div>
        <div class="option-name">${h(String(d.driver_name))}</div>
        <div class="option-detail">${d.cdl_number ? "CDL " + h(String(d.cdl_number)) : ""}${d.driver_phone ? " · " + h(String(d.driver_phone)) : ""} ${badge}</div>
      </div>
    </label>`;
  }).join("");

  const equipOptions = equipment.map(e => {
    const cab = equipDocs[e.id as number] || { cab: "missing" };
    const badge = cab.cab === "ok" ? '<span class="badge badge-ok">Cab card on file</span>' : '<span class="badge badge-missing">Cab card needed</span>';
    return `<label class="option">
      <input type="radio" name="equipment_id" value="${e.id}" ${equipment.length === 1 ? "checked" : ""}>
      <div>
        <div class="option-name">${e.truck_number ? "Truck " + h(String(e.truck_number)) : ""}${e.vin_number ? " · VIN " + h(String(e.vin_number)) : ""}</div>
        <div class="option-detail">${e.trailer_number ? "Trailer " + h(String(e.trailer_number)) + " " : ""}${badge}</div>
      </div>
    </label>`;
  }).join("");

  const insBadge = insStatus === "ok" ? '<span class="badge badge-ok">Current</span>'
    : insStatus === "expiring" ? '<span class="badge badge-expiring">Expiring soon</span>'
    : insStatus === "expired" ? '<span class="badge badge-expired">Expired</span>'
    : '<span class="badge badge-missing">Not on file</span>';

  const needsInsUpload = insStatus === "missing" || insStatus === "expired";

  return `
  <div class="tag">Confirm for Load</div>
  <div class="route">${h(String(a.origin))} → ${h(String(a.destination))}</div>
  <div class="detail">${h(String(a.cl_equipment || a.equipment || ""))}${a.pickup_date ? " · Pickup: " + h(String(a.pickup_date)) : ""}</div>

  <div class="divider"></div>

  <form action="/confirm/${h(token)}" method="POST" enctype="multipart/form-data" id="confirm-form">

    <!-- DRIVER -->
    <div class="section-label">Who is driving this load?</div>
    ${driverOptions}
    <label class="option" onclick="document.getElementById('new-driver').classList.add('active')">
      <input type="radio" name="driver_id" value="new" id="driver-new-radio">
      <div><div class="option-name">Add a different driver</div></div>
    </label>
    <div class="new-fields" id="new-driver">
      <div class="field"><label>Driver name</label><input name="new_driver_name" placeholder="Full name"></div>
      <div class="field"><label>Driver phone</label><input name="new_driver_phone" placeholder="Phone number" inputmode="tel"></div>
    </div>

    <div class="divider"></div>

    <!-- EQUIPMENT -->
    <div class="section-label">Which truck and trailer?</div>
    ${equipOptions}
    <label class="option" onclick="document.getElementById('new-equip').classList.add('active')">
      <input type="radio" name="equipment_id" value="new" id="equip-new-radio">
      <div><div class="option-name">Add a different truck</div></div>
    </label>
    <div class="new-fields" id="new-equip">
      <div class="field"><label>Truck number</label><input name="new_truck_number" placeholder="e.g. 4821"></div>
      <div class="field"><label>VIN (17 characters)</label><input name="new_vin" placeholder="e.g. 1HGBH41JXMN109186" maxlength="17"></div>
      <div class="field"><label>Trailer number</label><input name="new_trailer" placeholder="e.g. TR-2209"></div>
    </div>

    <div class="divider"></div>

    <!-- INSURANCE STATUS -->
    <div class="section-label">Insurance (COI) ${insBadge}</div>
    ${needsInsUpload ? `<div class="upload-field"><label>Upload insurance certificate</label><input type="file" name="insurance" accept="image/*,.pdf"></div>` : `<div class="ins-status" style="background:#EAF3DE;color:#3b6d11">Insurance on file.</div>`}

    <!-- CDL + CAB CARD UPLOADS (shown as needed — JS reveals based on selection) -->
    <div id="doc-uploads">
      <div class="upload-field" id="cdl-upload" style="display:none"><label>Upload CDL photo</label><input type="file" name="cdl" accept="image/*,.pdf"></div>
      <div class="upload-field" id="cab-upload" style="display:none"><label>Upload cab card / truck photo</label><input type="file" name="cab_card" accept="image/*,.pdf"></div>
    </div>

    <div style="margin:16px 0;font-size:11px;color:var(--muted);line-height:1.5">
      By submitting, I agree to receive SMS messages from Connected Carriers about document verification and dispatch status. Msg & data rates may apply. Reply STOP to opt out.
      <a href="https://connectedcarriers.org/terms.html" target="_blank" style="color:var(--amber)">Terms</a> &
      <a href="https://connectedcarriers.org/privacy.html" target="_blank" style="color:var(--amber)">Privacy</a>.
    </div>

    <button type="submit" class="btn" id="confirm-btn">Confirm for this load</button>
  </form>

  <script>
  // Show CDL upload if selected driver needs it, cab card if selected equipment needs it
  var driverDocs = ${JSON.stringify(driverDocs)};
  var equipDocs = ${JSON.stringify(equipDocs)};

  document.querySelectorAll('input[name=driver_id]').forEach(function(r) {
    r.addEventListener('change', function() {
      var id = this.value;
      var cdlUpload = document.getElementById('cdl-upload');
      if (id === 'new') { cdlUpload.style.display = 'block'; return; }
      var doc = driverDocs[id];
      cdlUpload.style.display = (doc && (doc.cdl === 'missing' || doc.cdl === 'expired')) ? 'block' : 'none';
    });
  });

  document.querySelectorAll('input[name=equipment_id]').forEach(function(r) {
    r.addEventListener('change', function() {
      var id = this.value;
      var cabUpload = document.getElementById('cab-upload');
      if (id === 'new') { cabUpload.style.display = 'block'; return; }
      var doc = equipDocs[id];
      cabUpload.style.display = (doc && doc.cab === 'missing') ? 'block' : 'none';
    });
  });

  // Trigger change on pre-selected options
  var checkedDriver = document.querySelector('input[name=driver_id]:checked');
  if (checkedDriver) checkedDriver.dispatchEvent(new Event('change'));
  var checkedEquip = document.querySelector('input[name=equipment_id]:checked');
  if (checkedEquip) checkedEquip.dispatchEvent(new Event('change'));

  // Form submit
  document.getElementById('confirm-form').addEventListener('submit', function() {
    var btn = document.getElementById('confirm-btn');
    btn.disabled = true; btn.textContent = 'Confirming...';
  });
  </script>`;
}

function confirmedPage(a: Record<string, unknown>, eval_: { result: string; items: Array<{ check: string; status: string; detail: string }>; missing: string[]; warnings: string[]; blockers: string[] } | null): string {
  const resultIcon = !eval_ ? "✓"
    : eval_.result === "clear" ? "✓"
    : eval_.result === "review" ? "⚠"
    : eval_.result === "do_not_use" ? "✗"
    : "◐";

  const resultColor = !eval_ ? "#2e7d32"
    : eval_.result === "clear" ? "#2e7d32"
    : eval_.result === "review" ? "#f57f17"
    : eval_.result === "do_not_use" ? "#c62828"
    : "#C8892A";

  const resultLabel = !eval_ ? "Confirmed"
    : eval_.result === "clear" ? "Clear to dispatch — arrival check sent"
    : eval_.result === "review" ? "Confirmed with flags — broker reviewing"
    : eval_.result === "do_not_use" ? "Issue found — broker notified"
    : "Confirmed — waiting on remaining docs";

  const itemsHtml = eval_ ? eval_.items.map(item => {
    const icon = item.status === "ok" ? "✓" : item.status === "missing" ? "○" : item.status === "expired" ? "✗" : item.status === "warning" ? "⚠" : "?";
    const color = item.status === "ok" ? "#2e7d32" : item.status === "missing" ? "#C8892A" : item.status === "expired" ? "#c62828" : "#f57f17";
    return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--cream2)">
      <span style="font-size:13px">${h(item.check)}</span>
      <span style="font-size:12px;color:${color};font-weight:500">${icon} ${h(item.detail)}</span>
    </div>`;
  }).join("") : "";

  return `
  <div class="result-card">
    <div class="result-icon" style="color:${resultColor}">${resultIcon}</div>
    <div class="route">${h(String(a.origin || ""))} → ${h(String(a.destination || ""))}</div>
    <div style="margin-top:8px;font-size:14px;color:${resultColor};font-weight:500">${resultLabel}</div>
  </div>
  ${itemsHtml ? `<div style="margin:16px 0;padding:12px;background:white;border:1px solid var(--cream2);border-radius:6px">${itemsHtml}</div>` : ""}
  <div style="text-align:center;margin-top:12px">
    <a href="https://connectedcarriers.org" style="font-size:13px;color:var(--muted);text-decoration:none">← Back to Connected Carriers</a>
  </div>`;
}
