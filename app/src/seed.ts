import bcrypt from "bcryptjs";
import { query, migrate } from "./db";

async function seed() {
  await migrate();
  console.log("Seeding...");

  // Broker account — Logistics Xpress
  const accountRes = await query(`
    INSERT INTO broker_accounts (company_name, contact_name, contact_email, contact_phone, slug, active)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, ["Logistics Xpress", "Kate Gonzalez", "kateloads@logisticsxpress.com", "310-980-5184", "logistics-xpress", true]);

  const accountId = accountRes.rows[0].id;

  // Broker user — Kate
  const passwordHash = await bcrypt.hash("password123", 10);
  const userRes = await query(`
    INSERT INTO broker_users (broker_account_id, name, email, password_digest, role, active)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, [accountId, "Kate Gonzalez", "kateloads@logisticsxpress.com", passwordHash, "owner", true]);

  const userId = userRes.rows[0].id;

  // Broker policy — Kate's rules from form
  await query(`
    INSERT INTO broker_policies (
      broker_account_id,
      require_mc_active, require_dot_active, require_w9, require_signed_agreement,
      minimum_authority_age_days,
      minimum_insurance_auto, minimum_insurance_cargo, minimum_insurance_general,
      certificate_holder_name, require_additional_insured, auto_reject_expired_coi,
      coi_required_at_submission, require_real_time_gps,
      accept_owner_operators, owner_operator_same_requirements,
      double_brokering_flag_triggers_reject,
      require_signed_rate_confirmation, require_driver_phone,
      require_truck_and_trailer_number, require_dispatch_packet
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT (broker_account_id) DO UPDATE SET updated_at = NOW()
  `, [
    accountId,
    true, true, true, true,
    180,
    1000000, 100000, 1000000,
    "Logistics Xpress", true, true,
    true, true,
    true, true,
    true,
    true, true,
    true, true
  ]);

  // Sample carrier 1 — Approved
  const c1 = await query(`
    INSERT INTO carriers (
      broker_account_id, mc_number, company_name, legal_name,
      phone, email, city, state,
      onboarding_status, approval_tier, authority_status, safety_rating_snapshot,
      last_verified_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
    ON CONFLICT (mc_number) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, [
    accountId, "1234567", "Swift Eagle Transport LLC", "Swift Eagle Transport LLC",
    "602-555-0101", "dispatch@swifteagle.com", "Phoenix", "AZ",
    "approved", "approved", "AUTHORIZED", "Not Rated"
  ]);

  await query(`
    INSERT INTO carrier_submissions (
      broker_account_id, carrier_id, submitted_by_name, submitted_by_email,
      submitted_by_phone, status, agreed_to_terms, submitted_at,
      reviewed_at, reviewed_by, decision_reason,
      fmcsa_result
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() - INTERVAL '2 days',NOW() - INTERVAL '1 day',$8,$9,$10)
  `, [
    accountId, c1.rows[0].id, "Marcus Webb", "marcus@swifteagle.com",
    "602-555-0102", "approved", true, userId,
    "Active MC, clean safety record, all docs submitted",
    JSON.stringify({ active: true, authority: "AUTHORIZED", safety_rating: "Not Rated", years_in_operation: 4 })
  ]);

  await query(`INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
    VALUES ('carrier_submission', $1, 'broker_user', $2, 'approved', $3)`,
    [c1.rows[0].id, userId, JSON.stringify({ reason: "Active MC, clean safety record, all docs submitted" })]);

  // Sample carrier 2 — Conditional
  const c2 = await query(`
    INSERT INTO carriers (
      broker_account_id, mc_number, company_name, legal_name,
      phone, email, city, state,
      onboarding_status, approval_tier, authority_status, safety_rating_snapshot,
      last_verified_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
    ON CONFLICT (mc_number) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, [
    accountId, "7654321", "Mesa Freight Co", "Mesa Freight Co",
    "480-555-0201", "ops@mesafreight.com", "Mesa", "AZ",
    "conditional", "conditional", "AUTHORIZED", "Conditional"
  ]);

  await query(`
    INSERT INTO carrier_submissions (
      broker_account_id, carrier_id, submitted_by_name, submitted_by_email,
      submitted_by_phone, status, agreed_to_terms, submitted_at,
      reviewed_at, reviewed_by, decision_reason, fmcsa_result
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() - INTERVAL '1 day',NOW() - INTERVAL '3 hours',$8,$9,$10)
  `, [
    accountId, c2.rows[0].id, "Rosa Delgado", "rosa@mesafreight.com",
    "480-555-0202", "conditional", true, userId,
    "Conditional safety rating — manual review required before first load",
    JSON.stringify({ active: true, authority: "AUTHORIZED", safety_rating: "Conditional", years_in_operation: 1 })
  ]);

  await query(`INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
    VALUES ('carrier_submission', $1, 'broker_user', $2, 'conditional_approved', $3)`,
    [c2.rows[0].id, userId, JSON.stringify({ reason: "Conditional safety rating — manual review required" })]);

  // Sample carrier 3 — Rejected
  const c3 = await query(`
    INSERT INTO carriers (
      broker_account_id, mc_number, company_name, legal_name,
      phone, email, city, state,
      onboarding_status, approval_tier, authority_status, safety_rating_snapshot,
      last_verified_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
    ON CONFLICT (mc_number) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, [
    accountId, "9991111", "Desert Run Logistics", "Desert Run Logistics",
    "520-555-0301", "info@desertrun.com", "Tucson", "AZ",
    "rejected", "rejected", "NOT AUTHORIZED", "Unsatisfactory"
  ]);

  await query(`
    INSERT INTO carrier_submissions (
      broker_account_id, carrier_id, submitted_by_name, submitted_by_email,
      submitted_by_phone, status, agreed_to_terms, submitted_at,
      reviewed_at, reviewed_by, decision_reason, fmcsa_result,
      internal_flags
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() - INTERVAL '3 days',NOW() - INTERVAL '2 days',$8,$9,$10,$11)
  `, [
    accountId, c3.rows[0].id, "Trent Howell", "trent@desertrun.com",
    "520-555-0302", "rejected", true, userId,
    "Unsatisfactory FMCSA safety rating — auto-disqualified",
    JSON.stringify({ active: false, authority: "NOT AUTHORIZED", safety_rating: "Unsatisfactory", years_in_operation: 0 }),
    JSON.stringify({ auto_rejected: true, flags: ["unsatisfactory_safety_rating", "inactive_authority"] })
  ]);

  await query(`INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
    VALUES ('carrier_submission', $1, 'broker_user', $2, 'rejected', $3)`,
    [c3.rows[0].id, userId, JSON.stringify({ reason: "Unsatisfactory FMCSA safety rating — auto-disqualified", auto: true })]);

  // Notes on carrier 2
  await query(`
    INSERT INTO carrier_notes (carrier_id, broker_account_id, broker_user_id, note_type, body)
    VALUES ($1, $2, $3, 'review', $4)
  `, [c2.rows[0].id, accountId, userId, "Conditional safety rating from 4 months ago. Called FMCSA — no active violations. Recommend one load trial before full approval."]);

  console.log("Seed complete.");
  console.log("Login: kateloads@logisticsxpress.com / password123");
}

export default seed;

// Allow running directly: ts-node src/seed.ts
if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
