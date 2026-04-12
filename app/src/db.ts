import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

export async function query(text: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function migrate() {
  console.log("Running migrations...");

  await query(`
    CREATE TABLE IF NOT EXISTS broker_accounts (
      id SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      contact_email TEXT NOT NULL,
      contact_phone TEXT,
      slug TEXT UNIQUE NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS broker_users (
      id SERIAL PRIMARY KEY,
      broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id),
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_digest TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'reviewer' CHECK (role IN ('owner', 'ops', 'reviewer')),
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS broker_policies (
      id SERIAL PRIMARY KEY,
      broker_account_id INTEGER NOT NULL UNIQUE REFERENCES broker_accounts(id),
      require_mc_active BOOLEAN DEFAULT true,
      require_dot_active BOOLEAN DEFAULT true,
      require_w9 BOOLEAN DEFAULT true,
      require_signed_agreement BOOLEAN DEFAULT true,
      minimum_authority_age_days INTEGER DEFAULT 180,
      minimum_insurance_auto INTEGER DEFAULT 1000000,
      minimum_insurance_cargo INTEGER DEFAULT 100000,
      minimum_insurance_general INTEGER DEFAULT 1000000,
      certificate_holder_name TEXT,
      require_additional_insured BOOLEAN DEFAULT true,
      auto_reject_expired_coi BOOLEAN DEFAULT true,
      coi_required_at_submission BOOLEAN DEFAULT true,
      require_real_time_gps BOOLEAN DEFAULT true,
      accept_owner_operators BOOLEAN DEFAULT true,
      owner_operator_same_requirements BOOLEAN DEFAULT true,
      double_brokering_flag_triggers_reject BOOLEAN DEFAULT true,
      require_signed_rate_confirmation BOOLEAN DEFAULT true,
      require_driver_phone BOOLEAN DEFAULT true,
      require_truck_and_trailer_number BOOLEAN DEFAULT true,
      require_dispatch_packet BOOLEAN DEFAULT true,
      pickup_code_required BOOLEAN DEFAULT false,
      auto_approve_rules JSONB DEFAULT '{}',
      manual_review_rules JSONB DEFAULT '{}',
      reject_rules JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Extend existing carriers table with broker fields
  await query(`
    ALTER TABLE carriers
      ADD COLUMN IF NOT EXISTS broker_account_id INTEGER REFERENCES broker_accounts(id),
      ADD COLUMN IF NOT EXISTS legal_name TEXT,
      ADD COLUMN IF NOT EXISTS dba_name TEXT,
      ADD COLUMN IF NOT EXISTS dot_number_ext TEXT,
      ADD COLUMN IF NOT EXISTS phone TEXT,
      ADD COLUMN IF NOT EXISTS email TEXT,
      ADD COLUMN IF NOT EXISTS address_line1 TEXT,
      ADD COLUMN IF NOT EXISTS address_line2 TEXT,
      ADD COLUMN IF NOT EXISTS city TEXT,
      ADD COLUMN IF NOT EXISTS state TEXT,
      ADD COLUMN IF NOT EXISTS postal_code TEXT,
      ADD COLUMN IF NOT EXISTS onboarding_status TEXT DEFAULT 'draft'
        CHECK (onboarding_status IN ('draft','submitted','under_review','approved','conditional','rejected')),
      ADD COLUMN IF NOT EXISTS approval_tier TEXT DEFAULT 'manual_review'
        CHECK (approval_tier IN ('preferred','approved','conditional','rejected','manual_review')),
      ADD COLUMN IF NOT EXISTS authority_status TEXT,
      ADD COLUMN IF NOT EXISTS safety_rating_snapshot TEXT,
      ADD COLUMN IF NOT EXISTS insurance_status TEXT,
      ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ
  `);

  // Extend existing carrier_submissions table
  await query(`
    ALTER TABLE carrier_submissions
      ADD COLUMN IF NOT EXISTS broker_account_id INTEGER REFERENCES broker_accounts(id),
      ADD COLUMN IF NOT EXISTS carrier_id INTEGER REFERENCES carriers(id),
      ADD COLUMN IF NOT EXISTS submitted_by_name TEXT,
      ADD COLUMN IF NOT EXISTS submitted_by_email TEXT,
      ADD COLUMN IF NOT EXISTS submitted_by_phone TEXT,
      ADD COLUMN IF NOT EXISTS raw_payload JSONB DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS fmcsa_result JSONB,
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'submitted'
        CHECK (status IN ('submitted','under_review','approved','conditional','rejected','more_info_requested')),
      ADD COLUMN IF NOT EXISTS agreed_to_terms BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES broker_users(id),
      ADD COLUMN IF NOT EXISTS decision_reason TEXT,
      ADD COLUMN IF NOT EXISTS internal_flags JSONB DEFAULT '{}'
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS carrier_documents (
      id SERIAL PRIMARY KEY,
      carrier_id INTEGER NOT NULL REFERENCES carriers(id),
      carrier_submission_id INTEGER REFERENCES carrier_submissions(id),
      document_type TEXT NOT NULL CHECK (document_type IN (
        'coi','w9','signed_agreement','cdl','truck_photo','vin_photo','cab_card','rate_confirmation','other'
      )),
      file_url TEXT NOT NULL,
      expires_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ,
      verification_status TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS carrier_notes (
      id SERIAL PRIMARY KEY,
      carrier_id INTEGER NOT NULL REFERENCES carriers(id),
      broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id),
      broker_user_id INTEGER NOT NULL REFERENCES broker_users(id),
      note_type TEXT DEFAULT 'general',
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id SERIAL PRIMARY KEY,
      subject_type TEXT NOT NULL,
      subject_id INTEGER NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'broker_user',
      actor_id INTEGER,
      action TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Sessions table for connect-pg-simple
  await query(`
    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL COLLATE "default",
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid)
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_carrier_submissions_broker ON carrier_submissions(broker_account_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_carrier_submissions_status ON carrier_submissions(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_carriers_broker ON carriers(broker_account_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_subject ON activity_logs(subject_type, subject_id)`);

  console.log("Migrations complete.");
}

export default pool;

export async function migrateIntake() {
  await query(`
    CREATE TABLE IF NOT EXISTS carrier_intake_links (
      id SERIAL PRIMARY KEY,
      broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id),
      token VARCHAR(64) UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','submitted','expired','cancelled')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_by INTEGER NOT NULL REFERENCES broker_users(id),
      submitted_submission_id INTEGER REFERENCES carrier_submissions(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_intake_links_token ON carrier_intake_links(token)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_intake_links_broker ON carrier_intake_links(broker_account_id)`);

  // Add intake_link_id to carrier_submissions if not present
  await query(`ALTER TABLE carrier_submissions ADD COLUMN IF NOT EXISTS intake_link_id INTEGER REFERENCES carrier_intake_links(id)`);
  await query(`ALTER TABLE carrier_submissions ADD COLUMN IF NOT EXISTS auto_rejected BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE carrier_submissions ADD COLUMN IF NOT EXISTS auto_reject_reasons JSONB DEFAULT '[]'`);

  console.log("Intake migrations complete.");
}
