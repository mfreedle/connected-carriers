/**
 * Seed test carriers for insurance waterfall smoke tests.
 *
 * Usage:
 *   cd app && npx ts-node test/fixtures/seed-test-carriers.ts
 *
 * Prerequisites:
 *   - DATABASE_URL environment variable
 *   - At least one broker_account row
 *
 * This creates:
 *   - 3 carriers (MC 999001, 999002, 999003)
 *   - 1 driver + 1 equipment per carrier
 *   - CDL, cab card, and insurance documents with pre-parsed data
 *   - For 999002: no declarations_page (so evaluator triggers needs_dec_page)
 *
 * After seeding, create a load in Kate's dashboard and assign each
 * test carrier to verify the evaluator branches.
 */

import { query, migrate } from "../../src/db";
import { CLEAR_CARRIER, NEEDS_DEC_PAGE_CARRIER, REVIEW_CARRIER } from "./insurance-waterfall-fixtures";

const TEST_MCS = ["999001", "999002", "999003"];
type InsuranceFixture = typeof CLEAR_CARRIER | typeof NEEDS_DEC_PAGE_CARRIER | typeof REVIEW_CARRIER;

async function clean() {
  console.log("[seed] Cleaning test carriers...");
  for (const mc of TEST_MCS) {
    const carrier = await query("SELECT id FROM carriers WHERE mc_number = $1", [mc]);
    if (carrier.rows.length) {
      const cid = carrier.rows[0].id;
      const apps = await query("SELECT id FROM canonical_load_applications WHERE carrier_id = $1", [cid]);
      const appIds = apps.rows.map((row) => row.id);
      if (appIds.length > 0) {
        await query("UPDATE canonical_loads SET assigned_applicant_id = NULL WHERE assigned_applicant_id = ANY($1::int[])", [appIds]);
      }
      // Clean load assignments/applications before driver/equipment because assignments may FK to them.
      await query("DELETE FROM load_assignments WHERE carrier_id = $1", [cid]).catch(() => {});
      await query("DELETE FROM canonical_load_applications WHERE carrier_id = $1", [cid]).catch(() => {});
      await query("DELETE FROM carrier_documents WHERE carrier_id = $1", [cid]);
      await query("DELETE FROM carrier_drivers WHERE carrier_id = $1", [cid]);
      await query("DELETE FROM carrier_equipment WHERE carrier_id = $1", [cid]);
      await query("DELETE FROM carriers WHERE id = $1", [cid]);
      console.log(`  Removed MC ${mc} (carrier_id ${cid})`);
    }
  }
}

async function seedCarrier(fixture: InsuranceFixture) {
  // Upsert carrier
  const carrierResult = await query(
    `INSERT INTO carriers (mc_number, fmcsa_legal_name, fmcsa_status_text, authority_status, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (mc_number) DO UPDATE SET fmcsa_legal_name = $2, fmcsa_status_text = $3, authority_status = $4, updated_at = NOW()
     RETURNING id`,
    [fixture.mc_number, fixture.fmcsa_legal_name, fixture.fmcsa_status_text, fixture.authority_status]
  );
  const carrierId = carrierResult.rows[0].id;

  // Create driver
  const driverResult = await query(
    `INSERT INTO carrier_drivers (carrier_id, driver_name, driver_phone, cdl_number, cdl_expiration, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING id`,
    [carrierId, fixture.driver.driver_name, fixture.driver.driver_phone,
     fixture.driver.cdl_number, fixture.driver.cdl_expiration, fixture.driver.status]
  );
  const driverId = driverResult.rows[0].id;

  // Create equipment
  const equipResult = await query(
    `INSERT INTO carrier_equipment (carrier_id, truck_number, vin_number, trailer_number, status, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING id`,
    [carrierId, fixture.equipment.truck_number, fixture.equipment.vin_number,
     fixture.equipment.trailer_number, fixture.equipment.status]
  );
  const equipmentId = equipResult.rows[0].id;

  // CDL document
  await query(
    `INSERT INTO carrier_documents (carrier_id, driver_id, equipment_id, doc_type, document_type, file_url, parsed_data, expiration_date, status, created_at)
     VALUES ($1, $2, NULL, 'cdl', 'cdl', 'fixture://cdl', $3, $4, 'current', NOW())`,
    [carrierId, driverId, JSON.stringify(fixture.cdl_parsed_data), fixture.cdl_parsed_data.expiration_date]
  );

  // Cab card document
  await query(
    `INSERT INTO carrier_documents (carrier_id, driver_id, equipment_id, doc_type, document_type, file_url, parsed_data, status, created_at)
     VALUES ($1, NULL, $2, 'cab_card', 'cab_card', 'fixture://cab_card', $3, 'current', NOW())`,
    [carrierId, equipmentId, JSON.stringify(fixture.cab_card_parsed_data)]
  );

  // Insurance document
  await query(
    `INSERT INTO carrier_documents (carrier_id, driver_id, equipment_id, doc_type, document_type, file_url, parsed_data, expiration_date, status, created_at)
     VALUES ($1, NULL, NULL, 'insurance', 'coi', 'fixture://insurance', $2, $3, 'current', NOW())`,
    [carrierId, JSON.stringify(fixture.insurance_parsed_data), fixture.insurance_parsed_data.expiration_date]
  );

  console.log(`  MC ${fixture.mc_number}: carrier_id=${carrierId}, driver_id=${driverId}, equipment_id=${equipmentId}`);
  return { carrierId, driverId, equipmentId };
}

async function main() {
  await migrate();
  await clean();

  console.log("\n[seed] Seeding test carriers...\n");

  console.log("Fixture 1: CLEAR (Signature Brand pattern)");
  await seedCarrier(CLEAR_CARRIER);

  console.log("Fixture 2: NEEDS_DEC_PAGE (Phamile 1st pattern)");
  await seedCarrier(NEEDS_DEC_PAGE_CARRIER);

  console.log("Fixture 3: REVIEW / weak data (KIK pattern)");
  await seedCarrier(REVIEW_CARRIER);

  console.log("\n[seed] Done. Test carriers seeded:");
  console.log("  MC 999001 → expected CLEAR (scheduled autos, VIN match, all thresholds met)");
  console.log("  MC 999002 → expected REVIEW + needs_dec_page (scheduled autos, no VINs on cert)");
  console.log("  MC 999003 → expected DO_NOT_DISPATCH (expired CDL, low coverage, low confidence)");
  console.log("\nTo test: create a load, have each carrier apply via /l/:slug, assign, and confirm.");
  console.log("To reset fixtures, run this script again.");

  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] Error:", err);
  process.exit(1);
});
