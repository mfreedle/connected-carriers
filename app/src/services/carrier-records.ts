/**
 * syncCanonicalCarrierRecords — keeps carrier_drivers, carrier_equipment,
 * and carrier_documents in sync after any profile write.
 *
 * Called by:
 *   - /profile/carrier POST (after initial insert, and again after OCR)
 *   - saveCarrierProfile() in verify.ts (after profile update/create)
 *
 * carrier_profiles remains the backward-compat summary/cache.
 * This function populates the canonical tables alongside it.
 */

import { query } from "../db";

export interface DriverInput {
  name: string;
  phone?: string | null;
  cdl_number?: string | null;
  cdl_state?: string | null;
  cdl_expiration?: string | null;
}

export interface EquipmentInput {
  truck_number?: string | null;
  vin_number?: string | null;
  trailer_number?: string | null;
  equipment_type?: string | null;
}

export interface DocumentInput {
  doc_type: "cdl" | "insurance" | "cab_card" | "truck_photo" | "w9";
  r2_key?: string | null;
  file_url?: string | null;
  parsed_data?: unknown | null;
  expiration_date?: string | null;
}

export interface SyncInput {
  carrier_id: number;
  driver_id?: number | null;
  equipment_id?: number | null;
  driver?: DriverInput | null;
  equipment?: EquipmentInput | null;
  documents?: DocumentInput[];
  source: string;
}

export interface SyncResult {
  driver_id: number | null;
  equipment_id: number | null;
  documents_created: number;
}

export async function syncCanonicalCarrierRecords(input: SyncInput): Promise<SyncResult> {
  const { carrier_id, driver, equipment, documents, source } = input;
  let driver_id: number | null = input.driver_id || null;
  let equipment_id: number | null = input.equipment_id || null;
  let documents_created = 0;

  const today = new Date();
  const thirtyDays = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

  const freshness = (expDate: string | null | undefined): string => {
    if (!expDate) return "current";
    const exp = new Date(expDate);
    if (exp < today) return "expired";
    if (exp < thirtyDays) return "expiring";
    return "current";
  };

  // ── 1. Find or create driver ──────────────────────────────────────

  if (driver?.name) {
    try {
      // Dedupe: prefer carrier_id + cdl_number, fall back to name + phone
      let existing;
      if (driver.cdl_number) {
        existing = await query(
          `SELECT id FROM carrier_drivers WHERE carrier_id = $1 AND cdl_number = $2`,
          [carrier_id, driver.cdl_number]
        );
      }
      if (!existing?.rows?.length) {
        existing = await query(
          `SELECT id FROM carrier_drivers WHERE carrier_id = $1 AND LOWER(driver_name) = LOWER($2) AND COALESCE(driver_phone, '') = COALESCE($3, '')`,
          [carrier_id, driver.name, driver.phone || ""]
        );
      }

      if (existing?.rows?.length) {
        driver_id = existing.rows[0].id;
        // Update facts if we have newer data
        const updates: string[] = [];
        const vals: unknown[] = [];
        let p = 0;
        if (driver.phone) { p++; updates.push(`driver_phone=$${p}`); vals.push(driver.phone); }
        if (driver.cdl_number) { p++; updates.push(`cdl_number=$${p}`); vals.push(driver.cdl_number); }
        if (driver.cdl_state) { p++; updates.push(`cdl_state=$${p}`); vals.push(driver.cdl_state); }
        if (driver.cdl_expiration) {
          p++; updates.push(`cdl_expiration=$${p}`); vals.push(driver.cdl_expiration);
          const driverStatus = new Date(driver.cdl_expiration) < today ? "expired" : "active";
          p++; updates.push(`status=$${p}`); vals.push(driverStatus);
        }
        if (updates.length > 0) {
          updates.push("updated_at=NOW()");
          p++; vals.push(driver_id);
          await query(`UPDATE carrier_drivers SET ${updates.join(", ")} WHERE id=$${p}`, vals);
        }
      } else {
        const driverStatus = driver.cdl_expiration && new Date(driver.cdl_expiration) < today ? "expired" : "active";
        const ins = await query(
          `INSERT INTO carrier_drivers (carrier_id, driver_name, driver_phone, cdl_number, cdl_state, cdl_expiration, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [carrier_id, driver.name, driver.phone || null, driver.cdl_number || null,
           driver.cdl_state || null, driver.cdl_expiration || null, driverStatus]
        );
        driver_id = ins.rows[0].id;
      }
    } catch (err) {
      console.error("[syncCanonical] Driver sync error:", err);
    }
  }

  // ── 2. Find or create equipment ───────────────────────────────────

  if (equipment?.vin_number || equipment?.truck_number) {
    try {
      let existing;
      if (equipment.vin_number) {
        existing = await query(
          `SELECT id FROM carrier_equipment WHERE carrier_id = $1 AND vin_number = $2`,
          [carrier_id, equipment.vin_number]
        );
      }
      if (!existing?.rows?.length && equipment.truck_number) {
        existing = await query(
          `SELECT id FROM carrier_equipment WHERE carrier_id = $1 AND COALESCE(truck_number,'') = COALESCE($2,'') AND COALESCE(trailer_number,'') = COALESCE($3,'')`,
          [carrier_id, equipment.truck_number, equipment.trailer_number || ""]
        );
      }

      if (existing?.rows?.length) {
        equipment_id = existing.rows[0].id;
        // Update facts if we have newer data
        const updates: string[] = [];
        const vals: unknown[] = [];
        let p = 0;
        if (equipment.vin_number) { p++; updates.push(`vin_number=$${p}`); vals.push(equipment.vin_number); }
        if (equipment.truck_number) { p++; updates.push(`truck_number=$${p}`); vals.push(equipment.truck_number); }
        if (equipment.trailer_number) { p++; updates.push(`trailer_number=$${p}`); vals.push(equipment.trailer_number); }
        if (equipment.equipment_type) { p++; updates.push(`equipment_type=$${p}`); vals.push(equipment.equipment_type); }
        if (updates.length > 0) {
          updates.push("updated_at=NOW()");
          p++; vals.push(equipment_id);
          await query(`UPDATE carrier_equipment SET ${updates.join(", ")} WHERE id=$${p}`, vals);
        }
      } else {
        const ins = await query(
          `INSERT INTO carrier_equipment (carrier_id, truck_number, vin_number, trailer_number, equipment_type, status)
           VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
          [carrier_id, equipment.truck_number || null, equipment.vin_number || null,
           equipment.trailer_number || null, equipment.equipment_type || null]
        );
        equipment_id = ins.rows[0].id;
      }
    } catch (err) {
      console.error("[syncCanonical] Equipment sync error:", err);
    }
  }

  // ── 3. Sync documents ─────────────────────────────────────────────

  if (documents?.length) {
    for (const doc of documents) {
      if (!doc.r2_key && !doc.file_url) continue;

      try {
        const legacyDocTypes = legacyDocumentTypes(doc.doc_type);

        // Check for existing doc with same key (both canonical and legacy columns)
        const existsCheck = await query(
          `SELECT id FROM carrier_documents
           WHERE carrier_id = $1
             AND (
               (doc_type = $2 AND (r2_key = $3 OR ($3 IS NULL AND file_url = $4)))
               OR (document_type = ANY($5::text[]) AND (r2_object_key = $3 OR ($3 IS NULL AND file_url = $4)))
             )`,
          [carrier_id, doc.doc_type,
           doc.r2_key || null, doc.file_url || null,
           legacyDocTypes]
        );

        if (existsCheck.rows.length > 0) {
          // Update existing row with latest parsed data / expiration
          const docId = existsCheck.rows[0].id;
          const updates: string[] = ["updated_at=NOW()"];
          const vals: unknown[] = [];
          let p = 0;
          if (doc.parsed_data) { p++; updates.push(`parsed_data=$${p}`); vals.push(JSON.stringify(doc.parsed_data)); }
          if (doc.expiration_date) {
            p++; updates.push(`expiration_date=$${p}`); vals.push(doc.expiration_date);
            p++; updates.push(`expires_at=$${p}`); vals.push(doc.expiration_date);
            p++; updates.push(`status=$${p}`); vals.push(freshness(doc.expiration_date));
          }
          // Set canonical columns if not yet set
          p++; updates.push(`doc_type=COALESCE(doc_type,$${p})`); vals.push(doc.doc_type);
          p++; updates.push(`status=COALESCE(status,$${p})`); vals.push(freshness(doc.expiration_date));
          if (doc.r2_key) { p++; updates.push(`r2_key=COALESCE(r2_key,$${p})`); vals.push(doc.r2_key); }
          if (driver_id && doc.doc_type === "cdl") { p++; updates.push(`driver_id=COALESCE(driver_id,$${p})`); vals.push(driver_id); }
          if (equipment_id && (doc.doc_type === "cab_card" || doc.doc_type === "truck_photo")) {
            p++; updates.push(`equipment_id=COALESCE(equipment_id,$${p})`); vals.push(equipment_id);
          }
          p++; vals.push(docId);
          await query(`UPDATE carrier_documents SET ${updates.join(", ")} WHERE id=$${p}`, vals);
          continue;
        }

        // Supersede existing docs of the same type within the correct scope
        const legacyDocType = preferredLegacyDocumentType(doc.doc_type);
        if (doc.doc_type === "cdl" && driver_id) {
          // Supersede CDL docs for this specific driver only
          await query(
            `UPDATE carrier_documents SET status='superseded', updated_at=NOW()
             WHERE carrier_id=$1 AND driver_id=$2 AND (doc_type='cdl' OR document_type='cdl') AND COALESCE(status,'current')='current'`,
            [carrier_id, driver_id]
          );
        } else if ((doc.doc_type === "cab_card" || doc.doc_type === "truck_photo") && equipment_id) {
          // Supersede cab card/truck photo for this specific equipment only
          await query(
            `UPDATE carrier_documents SET status='superseded', updated_at=NOW()
             WHERE carrier_id=$1 AND equipment_id=$2
               AND (doc_type IN ('cab_card','truck_photo') OR document_type IN ('cab_card','truck_photo','vin_photo'))
               AND COALESCE(status,'current')='current'`,
            [carrier_id, equipment_id]
          );
        } else if (doc.doc_type === "insurance") {
          // Supersede insurance at the carrier level
          await query(
            `UPDATE carrier_documents SET status='superseded', updated_at=NOW()
             WHERE carrier_id=$1 AND (doc_type='insurance' OR document_type='coi') AND COALESCE(status,'current')='current'`,
            [carrier_id]
          );
        }

        // Insert new document — populate both canonical and legacy columns
        await query(
          `INSERT INTO carrier_documents
           (carrier_id, driver_id, equipment_id, doc_type, document_type, r2_key, r2_object_key, file_url,
            parsed_data, expiration_date, expires_at, status, source)
           VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9::date, $9::timestamptz, $10, $11)`,
          [
            carrier_id,
            doc.doc_type === "cdl" ? driver_id : null,
            (doc.doc_type === "cab_card" || doc.doc_type === "truck_photo") ? equipment_id : null,
            doc.doc_type,
            legacyDocType,
            doc.r2_key || null,
            doc.file_url || null,
            doc.parsed_data ? JSON.stringify(doc.parsed_data) : null,
            doc.expiration_date || null,
            freshness(doc.expiration_date),
            source,
          ]
        );
        documents_created++;
      } catch (err) {
        console.error(`[syncCanonical] Document sync error (${doc.doc_type}):`, err);
      }
    }
  }

  return { driver_id, equipment_id, documents_created };
}

function legacyDocumentTypes(docType: DocumentInput["doc_type"]): string[] {
  if (docType === "insurance") return ["coi"];
  if (docType === "cab_card") return ["cab_card", "vin_photo"];
  return [docType];
}

function preferredLegacyDocumentType(docType: DocumentInput["doc_type"]): string {
  return legacyDocumentTypes(docType)[0];
}
