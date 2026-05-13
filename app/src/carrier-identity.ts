/**
 * findOrCreateCarrier — the canonical carrier identity resolver.
 *
 * Every carrier-facing path must call this before creating profiles,
 * applications, or verifications. No orphan records.
 *
 * See SPINE-0002 for design rationale.
 */

import { query } from "./db";

export interface CarrierIdentity {
  id: number;
  mc_number: string;
  fmcsa_legal_name: string | null;
  phone: string | null;
  email: string | null;
  network_status: string;
  latest_profile_id: number | null;
  latest_verification_id: number | null;
  isNew: boolean;
}

/**
 * Find or create a carrier by MC number.
 *
 * Does NOT run FMCSA — the calling path should write FMCSA data
 * after its own lookup to avoid redundant checks.
 *
 * Returns the carrier identity with isNew flag.
 */
export async function findOrCreateCarrier(mcNumber: string): Promise<CarrierIdentity> {
  const clean = mcNumber.replace(/\D/g, "");
  if (!clean) throw new Error("MC number required");

  // Try to find existing
  const existing = await query(
    `SELECT id, mc_number, fmcsa_legal_name, phone, email, network_status,
            latest_profile_id, latest_verification_id
     FROM carriers WHERE mc_number = $1`,
    [clean]
  );

  if (existing.rows.length) {
    const c = existing.rows[0];
    await query(
      "UPDATE carriers SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1",
      [c.id]
    );
    return {
      id: c.id,
      mc_number: c.mc_number,
      fmcsa_legal_name: c.fmcsa_legal_name,
      phone: c.phone,
      email: c.email,
      network_status: c.network_status,
      latest_profile_id: c.latest_profile_id,
      latest_verification_id: c.latest_verification_id,
      isNew: false,
    };
  }

  // Create new — ON CONFLICT handles race condition
  const result = await query(
    `INSERT INTO carriers (mc_number)
     VALUES ($1)
     ON CONFLICT (mc_number) DO UPDATE SET last_seen_at = NOW(), updated_at = NOW()
     RETURNING id, mc_number, fmcsa_legal_name, phone, email, network_status,
               latest_profile_id, latest_verification_id`,
    [clean]
  );

  const c = result.rows[0];
  return {
    id: c.id,
    mc_number: c.mc_number,
    fmcsa_legal_name: c.fmcsa_legal_name,
    phone: c.phone,
    email: c.email,
    network_status: c.network_status,
    latest_profile_id: c.latest_profile_id,
    latest_verification_id: c.latest_verification_id,
    isNew: true,
  };
}

/**
 * Update carrier FMCSA data after a lookup.
 * Called by the path that ran the FMCSA check.
 */
export async function updateCarrierFMCSA(
  carrierId: number,
  data: {
    fmcsa_legal_name?: string;
    dot_number?: string;
    fmcsa_status?: string;
    authority_status?: string;
    safety_rating?: string;
    phone?: string;
  }
): Promise<void> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.fmcsa_legal_name) { updates.push(`fmcsa_legal_name = $${idx++}`); values.push(data.fmcsa_legal_name); }
  if (data.dot_number) { updates.push(`dot_number = $${idx++}`); values.push(data.dot_number); }
  if (data.fmcsa_status) { updates.push(`fmcsa_status = $${idx++}`); values.push(data.fmcsa_status); }
  if (data.authority_status) { updates.push(`authority_status = $${idx++}`); values.push(data.authority_status); }
  if (data.safety_rating) { updates.push(`safety_rating = $${idx++}`); values.push(data.safety_rating); }
  if (data.phone) { updates.push(`phone = $${idx++}`); values.push(data.phone); }

  if (updates.length === 0) return;

  updates.push(`updated_at = NOW()`);
  values.push(carrierId);

  await query(
    `UPDATE carriers SET ${updates.join(", ")} WHERE id = $${idx}`,
    values
  );
}

/**
 * Update carrier contact info (phone/email) from a carrier submission.
 */
export async function updateCarrierContact(
  carrierId: number,
  phone?: string,
  email?: string
): Promise<void> {
  const updates: string[] = ["last_seen_at = NOW()", "updated_at = NOW()"];
  const values: unknown[] = [];
  let idx = 1;

  if (phone) { updates.push(`phone = $${idx++}`); values.push(phone); }
  if (email) { updates.push(`email = $${idx++}`); values.push(email); }

  values.push(carrierId);
  await query(
    `UPDATE carriers SET ${updates.join(", ")} WHERE id = $${idx}`,
    values
  );
}
