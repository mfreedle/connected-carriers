/**
 * evaluateDispatchPackage — grades a specific driver + equipment
 * combination against the carrier master record.
 *
 * Pure read. Does not modify data or trigger actions.
 *
 * Called by:
 *   - Assignment route (to decide: confirmation link vs fast-path)
 *   - Confirmation page (to show carrier what's missing)
 *   - Dashboard (to show Kate dispatch package status per applicant)
 */

import { query } from "../db";

export interface EvalItem {
  check: string;
  status: "ok" | "missing" | "expired" | "expiring" | "warning";
  detail: string;
}

export interface DispatchEvaluation {
  result: "clear" | "docs_needed" | "review" | "do_not_use";
  items: EvalItem[];
  missing: string[];
  warnings: string[];
  blockers: string[];
}

export async function evaluateDispatchPackage(
  carrier_id: number,
  driver_id: number | null,
  equipment_id: number | null
): Promise<DispatchEvaluation> {
  const items: EvalItem[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  const today = new Date();
  const thirtyDays = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

  // ── 1. FMCSA authority ──────────────────────────────────────────

  try {
    const carrierResult = await query(
      "SELECT fmcsa_status_text, authority_status, fmcsa_legal_name FROM carriers WHERE id = $1",
      [carrier_id]
    );
    if (!carrierResult.rows.length) {
      blockers.push("Carrier not found");
      items.push({ check: "FMCSA authority", status: "missing", detail: "Carrier not found in system" });
    } else {
      const c = carrierResult.rows[0];
      const usdot = (c.fmcsa_status_text || "").toUpperCase();
      const auth = (c.authority_status || "").toUpperCase();

      if (usdot && usdot !== "ACTIVE") {
        blockers.push(`USDOT status: ${c.fmcsa_status_text}`);
        items.push({ check: "FMCSA authority", status: "expired", detail: `USDOT: ${c.fmcsa_status_text}` });
      } else if (auth && !auth.includes("AUTHORIZED")) {
        blockers.push(`Operating authority: ${c.authority_status}`);
        items.push({ check: "FMCSA authority", status: "expired", detail: `Authority: ${c.authority_status}` });
      } else if (!usdot || !auth) {
        items.push({ check: "FMCSA authority", status: "missing", detail: "Not yet checked" });
        missing.push("FMCSA authority not verified");
      } else {
        items.push({ check: "FMCSA authority", status: "ok", detail: c.fmcsa_legal_name || "Active and authorized" });
      }
    }
  } catch (err) {
    console.error("[evaluateDispatch] FMCSA check error:", err);
    items.push({ check: "FMCSA authority", status: "warning", detail: "Could not verify" });
    warnings.push("FMCSA check failed");
  }

  // ── 2. Driver confirmed ─────────────────────────────────────────

  if (!driver_id) {
    missing.push("Driver not confirmed for this load");
    items.push({ check: "Driver", status: "missing", detail: "Not confirmed for this load" });
  } else {
    try {
      const driverResult = await query(
        "SELECT driver_name, driver_phone, cdl_number, cdl_expiration, status FROM carrier_drivers WHERE id = $1 AND carrier_id = $2",
        [driver_id, carrier_id]
      );
      if (!driverResult.rows.length) {
        missing.push("Driver record not found");
        items.push({ check: "Driver", status: "missing", detail: "Record not found" });
      } else {
        const d = driverResult.rows[0];
        if (d.status === "expired") {
          blockers.push(`Driver ${d.driver_name} status: expired`);
          items.push({ check: "Driver", status: "expired", detail: `${d.driver_name} — expired` });
        } else if (d.status === "inactive") {
          blockers.push(`Driver ${d.driver_name} status: inactive`);
          items.push({ check: "Driver", status: "expired", detail: `${d.driver_name} — inactive` });
        } else {
          items.push({ check: "Driver", status: "ok", detail: `${d.driver_name}${d.cdl_number ? " — CDL " + d.cdl_number : ""}` });
        }
      }
    } catch (err) {
      console.error("[evaluateDispatch] Driver check error:", err);
      warnings.push("Could not verify driver");
    }
  }

  // ── 3. CDL document (scoped to driver) ──────────────────────────

  if (driver_id) {
    try {
      const cdlResult = await query(
        `SELECT expiration_date, expires_at, status, doc_type, document_type
         FROM carrier_documents
         WHERE carrier_id = $1 AND driver_id = $2
           AND (doc_type = 'cdl' OR document_type = 'cdl')
           AND COALESCE(status, 'current') NOT IN ('superseded')
         ORDER BY created_at DESC LIMIT 1`,
        [carrier_id, driver_id]
      );
      if (!cdlResult.rows.length) {
        missing.push("CDL not on file");
        items.push({ check: "CDL document", status: "missing", detail: "Not on file" });
      } else {
        const doc = cdlResult.rows[0];
        const exp = doc.expiration_date || doc.expires_at;
        if (doc.status === "expired") {
          blockers.push("CDL is expired");
          items.push({ check: "CDL document", status: "expired", detail: "Marked expired" });
        } else if (exp) {
          const expDate = new Date(exp);
          if (expDate < today) {
            blockers.push("CDL is expired");
            items.push({ check: "CDL document", status: "expired", detail: `Expired ${expDate.toLocaleDateString()}` });
          } else if (expDate < thirtyDays) {
            warnings.push(`CDL expires ${expDate.toLocaleDateString()}`);
            items.push({ check: "CDL document", status: "expiring", detail: `Expires ${expDate.toLocaleDateString()}` });
          } else {
            items.push({ check: "CDL document", status: "ok", detail: `Expires ${expDate.toLocaleDateString()}` });
          }
        } else {
          items.push({ check: "CDL document", status: "ok", detail: "On file (no expiration recorded)" });
        }
      }
    } catch (err) {
      console.error("[evaluateDispatch] CDL check error:", err);
      warnings.push("Could not verify CDL");
    }
  }

  // ── 4. Equipment confirmed ──────────────────────────────────────

  if (!equipment_id) {
    missing.push("Truck/trailer not confirmed for this load");
    items.push({ check: "Equipment", status: "missing", detail: "Not confirmed for this load" });
  } else {
    try {
      const equipResult = await query(
        "SELECT truck_number, vin_number, trailer_number, status FROM carrier_equipment WHERE id = $1 AND carrier_id = $2",
        [equipment_id, carrier_id]
      );
      if (!equipResult.rows.length) {
        missing.push("Equipment record not found");
        items.push({ check: "Equipment", status: "missing", detail: "Record not found" });
      } else {
        const e = equipResult.rows[0];
        if (e.status === "inactive") {
          blockers.push("Equipment status: inactive");
          items.push({ check: "Equipment", status: "expired", detail: "Inactive" });
        } else {
          const detail = [e.truck_number, e.vin_number ? `VIN ${e.vin_number}` : null, e.trailer_number].filter(Boolean).join(" — ");
          items.push({ check: "Equipment", status: "ok", detail: detail || "On file" });
        }
      }
    } catch (err) {
      console.error("[evaluateDispatch] Equipment check error:", err);
      warnings.push("Could not verify equipment");
    }
  }

  // ── 5. Cab card / truck photo (scoped to equipment) ─────────────

  if (equipment_id) {
    try {
      const cabResult = await query(
        `SELECT status, doc_type, document_type
         FROM carrier_documents
         WHERE carrier_id = $1 AND equipment_id = $2
           AND (doc_type IN ('cab_card', 'truck_photo') OR document_type IN ('cab_card', 'truck_photo', 'vin_photo'))
           AND COALESCE(status, 'current') NOT IN ('superseded')
         ORDER BY created_at DESC LIMIT 1`,
        [carrier_id, equipment_id]
      );
      if (!cabResult.rows.length) {
        missing.push("Cab card / truck photo not on file");
        items.push({ check: "Cab card", status: "missing", detail: "Not on file" });
      } else {
        items.push({ check: "Cab card", status: "ok", detail: "On file" });
      }
    } catch (err) {
      console.error("[evaluateDispatch] Cab card check error:", err);
      warnings.push("Could not verify cab card");
    }
  }

  // ── 6. Insurance (carrier-level) ────────────────────────────────

  try {
    const insResult = await query(
      `SELECT expiration_date, expires_at, status, parsed_data, doc_type, document_type
       FROM carrier_documents
       WHERE carrier_id = $1
         AND (doc_type = 'insurance' OR document_type = 'coi')
         AND COALESCE(status, 'current') NOT IN ('superseded')
       ORDER BY created_at DESC LIMIT 1`,
      [carrier_id]
    );
    if (!insResult.rows.length) {
      missing.push("Insurance (COI) not on file");
      items.push({ check: "Insurance", status: "missing", detail: "Not on file" });
    } else {
      const doc = insResult.rows[0];
      const exp = doc.expiration_date || doc.expires_at;
      if (doc.status === "expired") {
        blockers.push("Insurance is expired");
        items.push({ check: "Insurance", status: "expired", detail: "Marked expired" });
      } else if (exp) {
        const expDate = new Date(exp);
        if (expDate < today) {
          blockers.push("Insurance is expired");
          items.push({ check: "Insurance", status: "expired", detail: `Expired ${expDate.toLocaleDateString()}` });
        } else if (expDate < thirtyDays) {
          warnings.push(`Insurance expires ${expDate.toLocaleDateString()}`);
          items.push({ check: "Insurance", status: "expiring", detail: `Expires ${expDate.toLocaleDateString()}` });
        } else {
          items.push({ check: "Insurance", status: "ok", detail: `Expires ${expDate.toLocaleDateString()}` });
        }
      } else {
        items.push({ check: "Insurance", status: "ok", detail: "On file (no expiration recorded)" });
      }

      // ── 7. VIN match (if insurance + equipment both have VIN data) ──
      if (equipment_id && doc.parsed_data) {
        try {
          const equipResult = await query("SELECT vin_number FROM carrier_equipment WHERE id = $1 AND carrier_id = $2", [equipment_id, carrier_id]);
          const vin = equipResult.rows[0]?.vin_number;
          if (vin) {
            const parsed = typeof doc.parsed_data === "string" ? JSON.parse(doc.parsed_data) : doc.parsed_data;
            const insVins: string[] = parsed?.vins || [];
            if (insVins.length > 0) {
              const vinUpper = vin.toUpperCase();
              const match = insVins.some((v: string) => v.toUpperCase() === vinUpper);
              if (match) {
                items.push({ check: "VIN match", status: "ok", detail: "Truck VIN found on insurance policy" });
              } else {
                warnings.push("Truck VIN not found on insurance policy");
                items.push({ check: "VIN match", status: "warning", detail: "VIN not on insurance — verify manually" });
              }
            }
          }
        } catch { /* non-fatal */ }
      }
    }
  } catch (err) {
    console.error("[evaluateDispatch] Insurance check error:", err);
    warnings.push("Could not verify insurance");
  }

  // ── Compute result ──────────────────────────────────────────────

  let result: DispatchEvaluation["result"];
  if (blockers.length > 0) {
    result = "do_not_use";
  } else if (missing.length > 0) {
    result = "docs_needed";
  } else if (warnings.length > 0) {
    result = "review";
  } else {
    result = "clear";
  }

  return { result, items, missing, warnings, blockers };
}
