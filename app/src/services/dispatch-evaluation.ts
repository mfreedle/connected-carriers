/**
 * evaluateDispatchPackage — grades a specific driver + equipment
 * combination against the carrier master record and broker policy.
 *
 * Pure read. Does not modify data or trigger actions.
 *
 * Called by:
 *   - Confirmation page GET (re-eval for already-confirmed)
 *   - Confirmation page POST (initial evaluation after confirm)
 *   - Dashboard (to show Kate dispatch package status per applicant)
 */

import { query } from "../db";

// ── Types ─────────────────────────────────────────────────────────

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
  needsDecPage?: boolean;
}

export interface EvalInput {
  carrierId: number;
  driverId: number | null;
  equipmentId: number | null;
  brokerAccountId: number;
  assignmentId?: number;
}

interface BrokerThresholds {
  autoMin: number;
  cargoMin: number;
  generalMin: number;
}

// ── Helpers ───────────────────────────────────────────────────────

/** Normalize a company name for comparison: uppercase, strip LLC/INC/CORP and punctuation */
function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,]/g, "")
    .replace(/\b(LLC|INC|CORP|CORPORATION|CO|LTD|LP|LLP|PLLC|PC|DBA)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Check if a string is a valid ISO date (YYYY-MM-DD) and parseable */
function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s);
  return !isNaN(d.getTime());
}

/** Normalize a VIN: uppercase, strip whitespace */
function normalizeVin(vin: string): string {
  return vin.replace(/\s/g, "").toUpperCase();
}

/** Check if a string looks like a valid 17-character VIN */
function isValidVin(vin: unknown): vin is string {
  if (typeof vin !== "string") return false;
  const cleaned = vin.replace(/\s/g, "");
  return /^[A-HJ-NPR-Z0-9]{17}$/i.test(cleaned);
}

/** Parse a coverage amount: must be a positive number */
function parseCoverageAmount(val: unknown): number | null {
  if (typeof val === "number" && val > 0 && isFinite(val)) return val;
  if (typeof val === "string") {
    const n = parseInt(val.replace(/[^0-9]/g, ""), 10);
    if (n > 0 && isFinite(n)) return n;
  }
  return null;
}

/** Format a dollar amount for display */
function fmtDollars(n: number): string {
  return "$" + n.toLocaleString("en-US");
}

// ── Main evaluator ────────────────────────────────────────────────

export async function evaluateDispatchPackage(input: EvalInput): Promise<DispatchEvaluation> {
  const { carrierId, driverId, equipmentId, brokerAccountId } = input;

  const items: EvalItem[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  let needsDecPage = false;

  const today = new Date();
  const thirtyDays = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

  // ── 0. Load broker policy thresholds ────────────────────────────

  let thresholds: BrokerThresholds = { autoMin: 1000000, cargoMin: 100000, generalMin: 1000000 };
  try {
    const policyResult = await query(
      "SELECT minimum_insurance_auto, minimum_insurance_cargo, minimum_insurance_general FROM broker_policies WHERE broker_account_id = $1",
      [brokerAccountId]
    );
    if (policyResult.rows.length) {
      const p = policyResult.rows[0];
      thresholds = {
        autoMin: p.minimum_insurance_auto ?? 1000000,
        cargoMin: p.minimum_insurance_cargo ?? 100000,
        generalMin: p.minimum_insurance_general ?? 1000000,
      };
    }
  } catch (err) {
    console.error("[evaluateDispatch] Broker policy load error (using defaults):", err);
  }

  // ── 1. FMCSA authority ──────────────────────────────────────────

  let fmcsaLegalName: string | null = null;

  try {
    const carrierResult = await query(
      "SELECT fmcsa_status_text, authority_status, fmcsa_legal_name FROM carriers WHERE id = $1",
      [carrierId]
    );
    if (!carrierResult.rows.length) {
      blockers.push("Carrier not found");
      items.push({ check: "FMCSA authority", status: "missing", detail: "Carrier not found in system" });
    } else {
      const c = carrierResult.rows[0];
      fmcsaLegalName = c.fmcsa_legal_name || null;
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

  if (!driverId) {
    missing.push("Driver not confirmed for this load");
    items.push({ check: "Driver", status: "missing", detail: "Not confirmed for this load" });
  } else {
    try {
      const driverResult = await query(
        "SELECT driver_name, driver_phone, cdl_number, cdl_expiration, status FROM carrier_drivers WHERE id = $1 AND carrier_id = $2",
        [driverId, carrierId]
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
          if (!d.driver_phone) {
            missing.push("Driver phone not on file");
            items.push({ check: "Driver phone", status: "missing", detail: "Needed for arrival check SMS" });
          }
        }
      }
    } catch (err) {
      console.error("[evaluateDispatch] Driver check error:", err);
      warnings.push("Could not verify driver");
    }
  }

  // ── 3. CDL document (scoped to driver) ──────────────────────────

  if (driverId) {
    try {
      const cdlResult = await query(
        `SELECT expiration_date, expires_at, status, parsed_data, doc_type, document_type
         FROM carrier_documents
         WHERE carrier_id = $1 AND driver_id = $2
           AND (doc_type = 'cdl' OR document_type = 'cdl')
           AND COALESCE(status, 'current') NOT IN ('superseded')
         ORDER BY created_at DESC LIMIT 1`,
        [carrierId, driverId]
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
          warnings.push("CDL uploaded but expiration was not parsed");
          items.push({ check: "CDL document", status: "warning", detail: "On file — expiration not parsed" });
        }
      }
    } catch (err) {
      console.error("[evaluateDispatch] CDL check error:", err);
      warnings.push("Could not verify CDL");
    }
  }

  // ── 4. Equipment confirmed ──────────────────────────────────────

  if (!equipmentId) {
    missing.push("Truck/trailer not confirmed for this load");
    items.push({ check: "Equipment", status: "missing", detail: "Not confirmed for this load" });
  } else {
    try {
      const equipResult = await query(
        "SELECT truck_number, vin_number, trailer_number, status FROM carrier_equipment WHERE id = $1 AND carrier_id = $2",
        [equipmentId, carrierId]
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

  if (equipmentId) {
    try {
      const cabResult = await query(
        `SELECT status, parsed_data, doc_type, document_type
         FROM carrier_documents
         WHERE carrier_id = $1 AND equipment_id = $2
           AND (doc_type IN ('cab_card', 'truck_photo') OR document_type IN ('cab_card', 'truck_photo', 'vin_photo'))
           AND COALESCE(status, 'current') NOT IN ('superseded')
         ORDER BY created_at DESC LIMIT 1`,
        [carrierId, equipmentId]
      );
      if (!cabResult.rows.length) {
        missing.push("Cab card / truck photo not on file");
        items.push({ check: "Cab card", status: "missing", detail: "Not on file" });
      } else {
        const cab = cabResult.rows[0];
        if (!cab.parsed_data) {
          warnings.push("Cab card uploaded but VIN was not parsed");
          items.push({ check: "Cab card", status: "warning", detail: "On file — VIN not parsed" });
        } else {
          items.push({ check: "Cab card", status: "ok", detail: "On file" });
        }
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
      [carrierId]
    );
    if (!insResult.rows.length) {
      missing.push("Insurance (COI) not on file");
      items.push({ check: "Insurance", status: "missing", detail: "Not on file" });
    } else {
      const doc = insResult.rows[0];
      const parsed = typeof doc.parsed_data === "string" ? JSON.parse(doc.parsed_data) : (doc.parsed_data || {});
      const exp = doc.expiration_date || doc.expires_at;
      const confidence = parsed.confidence || {};

      // ── 6a. Expiration check ──────────────────────────────────

      if (doc.status === "expired") {
        blockers.push("Insurance is expired");
        items.push({ check: "Insurance expiration", status: "expired", detail: "Marked expired" });
      } else if (exp) {
        const expDate = new Date(exp);
        if (expDate < today) {
          blockers.push("Insurance is expired");
          items.push({ check: "Insurance expiration", status: "expired", detail: `Expired ${expDate.toLocaleDateString()}` });
        } else if (expDate < thirtyDays) {
          warnings.push(`Insurance expires ${expDate.toLocaleDateString()}`);
          items.push({ check: "Insurance expiration", status: "expiring", detail: `Expires ${expDate.toLocaleDateString()}` });
        } else {
          items.push({ check: "Insurance expiration", status: "ok", detail: `Expires ${expDate.toLocaleDateString()}` });
        }
      } else if (parsed.expiration_date && !isValidIsoDate(parsed.expiration_date)) {
        warnings.push("Insurance expiration could not be validated");
        items.push({ check: "Insurance expiration", status: "warning", detail: "On file — expiration not parseable" });
      } else if (!exp && !parsed.expiration_date) {
        warnings.push("Insurance uploaded but expiration was not parsed");
        items.push({ check: "Insurance expiration", status: "warning", detail: "On file — expiration not parsed" });
      } else {
        items.push({ check: "Insurance expiration", status: "ok", detail: `Expires ${new Date(parsed.expiration_date).toLocaleDateString()}` });
      }

      // Advisory: low confidence on expiration
      if (confidence.expiration_date === "low" && exp) {
        warnings.push("Insurance expiration was parsed with low confidence — verify manually");
        items.push({ check: "Insurance expiration confidence", status: "warning", detail: "Expiration date parsed with low confidence" });
      }

      // ── 6b. Named insured match ───────────────────────────────

      const namedInsured = parsed.named_insured;
      if (namedInsured && fmcsaLegalName) {
        const normalizedInsured = normalizeName(namedInsured);
        const normalizedFmcsa = normalizeName(fmcsaLegalName);
        if (normalizedInsured === normalizedFmcsa) {
          items.push({ check: "Named insured", status: "ok", detail: namedInsured });
        } else {
          warnings.push(`Named insured mismatch: COI says "${namedInsured}", FMCSA says "${fmcsaLegalName}"`);
          items.push({ check: "Named insured", status: "warning", detail: `COI: ${namedInsured} ≠ FMCSA: ${fmcsaLegalName}` });
        }
      } else if (!namedInsured) {
        warnings.push("Named insured not found on COI");
        items.push({ check: "Named insured", status: "warning", detail: "Not found on certificate" });
      } else if (!fmcsaLegalName) {
        warnings.push(`Named insured "${namedInsured}" — no FMCSA legal name to compare`);
        items.push({ check: "Named insured", status: "warning", detail: `${namedInsured} — no FMCSA name to compare` });
      }

      // ── 6c. Coverage threshold checks ─────────────────────────

      const autoLiability = parseCoverageAmount(parsed.auto_liability);
      if (autoLiability !== null) {
        if (autoLiability >= thresholds.autoMin) {
          items.push({ check: "Auto liability", status: "ok", detail: `${fmtDollars(autoLiability)} (min: ${fmtDollars(thresholds.autoMin)})` });
        } else {
          warnings.push(`Auto liability ${fmtDollars(autoLiability)} below minimum ${fmtDollars(thresholds.autoMin)}`);
          items.push({ check: "Auto liability", status: "warning", detail: `${fmtDollars(autoLiability)} — below min ${fmtDollars(thresholds.autoMin)}` });
        }
      } else if (parsed.auto_liability !== undefined) {
        warnings.push("Auto liability amount could not be parsed");
        items.push({ check: "Auto liability", status: "warning", detail: "Amount not parseable — verify manually" });
      } else if (thresholds.autoMin > 0) {
        warnings.push("Auto liability not found on COI");
        items.push({ check: "Auto liability", status: "warning", detail: `Not found — broker requires min ${fmtDollars(thresholds.autoMin)}` });
      }

      const cargoAmount = parseCoverageAmount(parsed.cargo);
      if (thresholds.cargoMin > 0) {
        if (cargoAmount !== null) {
          if (cargoAmount >= thresholds.cargoMin) {
            items.push({ check: "Cargo coverage", status: "ok", detail: `${fmtDollars(cargoAmount)} (min: ${fmtDollars(thresholds.cargoMin)})` });
          } else {
            warnings.push(`Cargo coverage ${fmtDollars(cargoAmount)} below minimum ${fmtDollars(thresholds.cargoMin)}`);
            items.push({ check: "Cargo coverage", status: "warning", detail: `${fmtDollars(cargoAmount)} — below min ${fmtDollars(thresholds.cargoMin)}` });
          }
        } else {
          warnings.push("Cargo coverage not found on COI");
          items.push({ check: "Cargo coverage", status: "warning", detail: "Not found — broker requires cargo coverage" });
        }
      }

      const generalLiability = parseCoverageAmount(parsed.general_liability);
      if (thresholds.generalMin > 0) {
        if (generalLiability !== null) {
          if (generalLiability >= thresholds.generalMin) {
            items.push({ check: "General liability", status: "ok", detail: `${fmtDollars(generalLiability)} (min: ${fmtDollars(thresholds.generalMin)})` });
          } else {
            warnings.push(`General liability ${fmtDollars(generalLiability)} below minimum ${fmtDollars(thresholds.generalMin)}`);
            items.push({ check: "General liability", status: "warning", detail: `${fmtDollars(generalLiability)} — below min ${fmtDollars(thresholds.generalMin)}` });
          }
        } else {
          warnings.push("General liability not found on COI");
          items.push({ check: "General liability", status: "warning", detail: `Not found — broker requires min ${fmtDollars(thresholds.generalMin)}` });
        }
      }

      // ── 6d. Auto coverage type + VIN cross-reference ──────────

      const autoCoverageType = parsed.auto_coverage_type || "unknown";

      if (autoCoverageType === "any_auto") {
        items.push({ check: "Vehicle coverage", status: "ok", detail: "Any Auto — blanket coverage, all vehicles covered" });

      } else if (autoCoverageType === "scheduled_autos" || autoCoverageType === "owned_autos") {
        const insVins: string[] = (parsed.vins || []).filter((v: unknown) => isValidVin(v));

        if (insVins.length === 0) {
          // No VINs on COI — check if a declarations page has been uploaded
          let decPageResolved = false;
          try {
            const decResult = await query(
              `SELECT parsed_data FROM carrier_documents
               WHERE carrier_id = $1
                 AND (doc_type = 'declarations_page' OR document_type = 'declarations_page')
                 AND COALESCE(status, 'current') NOT IN ('superseded')
               ORDER BY created_at DESC LIMIT 1`,
              [carrierId]
            );
            if (decResult.rows.length) {
              const decParsed = typeof decResult.rows[0].parsed_data === "string"
                ? JSON.parse(decResult.rows[0].parsed_data)
                : (decResult.rows[0].parsed_data || {});

              if (decParsed.coverage_type === "blanket") {
                items.push({ check: "Vehicle coverage", status: "ok", detail: "Blanket coverage confirmed via declarations page" });
                decPageResolved = true;
              } else if (decParsed.coverage_type === "scheduled_vehicles") {
                const decVins: string[] = (decParsed.vins || []).filter((v: unknown) => isValidVin(v));
                if (decVins.length > 0 && equipmentId) {
                  const equipResult2 = await query(
                    "SELECT vin_number FROM carrier_equipment WHERE id = $1 AND carrier_id = $2",
                    [equipmentId, carrierId]
                  );
                  const truckVin2 = equipResult2.rows[0]?.vin_number;
                  if (truckVin2 && isValidVin(truckVin2)) {
                    const match2 = decVins.some(v => normalizeVin(v) === normalizeVin(truckVin2));
                    if (match2) {
                      items.push({ check: "VIN match", status: "ok", detail: "Confirmed truck VIN found on declarations page" });
                      decPageResolved = true;
                    } else {
                      warnings.push(`Truck VIN ${truckVin2} not found on declarations page (dec page VINs: ${decVins.join(", ")})`);
                      items.push({ check: "VIN match", status: "warning", detail: `Truck VIN ${truckVin2} not on dec page — dec page has: ${decVins.join(", ")}` });
                      decPageResolved = true; // resolved but with mismatch warning — don't re-request
                    }
                  }
                } else if (decVins.length === 0) {
                  // Dec page says scheduled but has no VINs — not helpful
                  warnings.push("Declarations page uploaded but no VINs found on it");
                  items.push({ check: "Vehicle coverage", status: "warning", detail: "Declarations page has no VINs — verify manually" });
                }
              }
              // If coverage_type is unknown or dec page didn't resolve, fall through
            }
          } catch { /* non-fatal */ }

          if (!decPageResolved) {
            needsDecPage = true;
            warnings.push("Scheduled Autos policy, no VIN schedule found; declarations page required");
            items.push({ check: "Vehicle coverage", status: "warning", detail: "Scheduled Autos — no VINs on certificate; declarations page required" });
          }
        } else if (equipmentId) {
          try {
            const equipResult = await query(
              "SELECT vin_number FROM carrier_equipment WHERE id = $1 AND carrier_id = $2",
              [equipmentId, carrierId]
            );
            const truckVin = equipResult.rows[0]?.vin_number;
            if (truckVin && isValidVin(truckVin)) {
              const normalizedTruckVin = normalizeVin(truckVin);
              const match = insVins.some(v => normalizeVin(v) === normalizedTruckVin);
              if (match) {
                items.push({ check: "VIN match", status: "ok", detail: "Confirmed truck VIN found on insurance policy" });
              } else {
                warnings.push(`Truck VIN ${truckVin} not found on insurance policy (policy VINs: ${insVins.join(", ")})`);
                items.push({ check: "VIN match", status: "warning", detail: `Truck VIN ${truckVin} not on COI — COI has: ${insVins.join(", ")}` });
              }
            } else if (truckVin) {
              warnings.push("Truck VIN on file does not appear to be a valid 17-character VIN");
              items.push({ check: "VIN match", status: "warning", detail: `VIN "${truckVin}" may not be valid — verify manually` });
            } else {
              warnings.push("No VIN on file for confirmed truck — cannot cross-reference");
              items.push({ check: "VIN match", status: "warning", detail: "No VIN on equipment record" });
            }
          } catch { /* non-fatal */ }
        }

      } else if (autoCoverageType === "hired_autos" || autoCoverageType === "non_owned_autos" || autoCoverageType === "hired_and_non_owned_autos") {
        warnings.push(`Coverage type "${autoCoverageType}" may not cover carrier-owned vehicles — verify manually`);
        items.push({ check: "Vehicle coverage", status: "warning", detail: `${autoCoverageType.replace(/_/g, " ")} — may not cover owned vehicles` });

      } else {
        warnings.push("Could not determine auto coverage type from certificate");
        items.push({ check: "Vehicle coverage", status: "warning", detail: "Coverage type not determined — verify manually" });
      }

      // Advisory: low confidence on coverage type
      if (confidence.auto_coverage_type === "low") {
        warnings.push("Auto coverage type was parsed with low confidence");
        items.push({ check: "Coverage type confidence", status: "warning", detail: "Auto coverage type parsed with low confidence" });
      }

      // Advisory: low confidence on other critical fields
      if (confidence.auto_liability === "low") {
        warnings.push("Auto liability amount was parsed with low confidence — verify manually");
        items.push({ check: "Auto liability confidence", status: "warning", detail: "Auto liability parsed with low confidence" });
      }
      if (confidence.vins === "low" && (parsed.vins || []).length > 0) {
        warnings.push("VIN numbers were parsed with low confidence — verify manually");
        items.push({ check: "VIN confidence", status: "warning", detail: "VINs parsed with low confidence" });
      }
      if (confidence.named_insured === "low") {
        warnings.push("Named insured was parsed with low confidence — verify manually");
        items.push({ check: "Named insured confidence", status: "warning", detail: "Named insured parsed with low confidence" });
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

  return { result, items, missing, warnings, blockers, needsDecPage: needsDecPage || undefined };
}
