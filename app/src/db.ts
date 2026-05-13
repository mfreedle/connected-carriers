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

  // ── Base tables: create before ALTER ─────────────────────────────
  // The broker app must not depend on MCP having run first.
  // These CREATE IF NOT EXISTS ensure the tables exist before any ALTER.
  await query(`
    CREATE TABLE IF NOT EXISTS carriers (
      id SERIAL PRIMARY KEY,
      mc_number VARCHAR(20) UNIQUE NOT NULL,
      dot_number VARCHAR(20),
      company_name TEXT,
      tier VARCHAR(30),
      fmcsa_status JSONB,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS carrier_submissions (
      id SERIAL PRIMARY KEY,
      mc_number VARCHAR(20) NOT NULL,
      broker_id TEXT,
      submission_data JSONB,
      verification_result JSONB,
      tier_assigned VARCHAR(30),
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

export async function migrateDispatch() {
  await query(`
    CREATE TABLE IF NOT EXISTS dispatch_packets (
      id SERIAL PRIMARY KEY,
      broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id),
      carrier_id INTEGER NOT NULL REFERENCES carriers(id),
      carrier_submission_id INTEGER REFERENCES carrier_submissions(id),
      load_reference TEXT NOT NULL,
      pickup_address TEXT,
      pickup_window_start TEXT,
      pickup_window_end TEXT,
      driver_name TEXT,
      driver_phone TEXT,
      cdl_photo_url TEXT,
      truck_photo_url TEXT,
      vin_number TEXT,
      vin_photo_url TEXT,
      cab_card_url TEXT,
      trailer_number TEXT,
      insurer_name TEXT,
      insurance_verification_method TEXT CHECK (insurance_verification_method IN ('phone','email','portal')),
      insurance_reverified_at TIMESTAMPTZ,
      insurance_reverified_by INTEGER REFERENCES broker_users(id),
      vin_verified BOOLEAN DEFAULT false,
      vin_verification_notes TEXT,
      tracking_required BOOLEAN DEFAULT true,
      tracking_link_sent_at TIMESTAMPTZ,
      tracking_accepted_at TIMESTAMPTZ,
      tracking_status TEXT DEFAULT 'not_sent' CHECK (tracking_status IN ('not_sent','sent','accepted','rejected')),
      rate_confirmation_signed_at TIMESTAMPTZ,
      pickup_appointment_confirmed_at TIMESTAMPTZ,
      final_clearance_status TEXT DEFAULT 'pending' CHECK (final_clearance_status IN (
        'pending','docs_pending','verification_in_progress','cleared_to_roll','failed','expired','cancelled'
      )),
      final_clearance_notes TEXT,
      cleared_by INTEGER REFERENCES broker_users(id),
      cleared_at TIMESTAMPTZ,
      pickup_code TEXT,
      pickup_code_hash TEXT,
      pickup_code_expires_at TIMESTAMPTZ,
      pickup_code_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_dispatch_packets_carrier ON dispatch_packets(carrier_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dispatch_packets_broker ON dispatch_packets(broker_account_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dispatch_packets_status ON dispatch_packets(final_clearance_status)`);

  // Add pickup_code_hash if not present (idempotent — safe to run on existing tables)
  await query(`ALTER TABLE dispatch_packets ADD COLUMN IF NOT EXISTS pickup_code_hash TEXT`);

  console.log("Dispatch migrations complete.");
}

export async function migrateInterest() {
  await query(`
    CREATE TABLE IF NOT EXISTS broker_interest_submissions (
      id SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      tms TEXT,
      estimated_load_volume TEXT,
      freight_profile_or_lanes TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','contacted','rejected')),
      reviewed_at TIMESTAMPTZ,
      reviewed_by INTEGER REFERENCES broker_users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS carrier_interest_submissions (
      id SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      mc_number TEXT,
      contact_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      equipment_types JSONB DEFAULT '[]',
      lanes_or_regions TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','contacted','rejected')),
      reviewed_at TIMESTAMPTZ,
      reviewed_by INTEGER REFERENCES broker_users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_broker_interest_status ON broker_interest_submissions(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_carrier_interest_status ON carrier_interest_submissions(status)`);

  console.log("Interest form migrations complete.");
}

export async function migrateSetupPackets() {
  // carrier_setup_packets — one per carrier per broker, broker-initiated
  await query(`
    CREATE TABLE IF NOT EXISTS carrier_setup_packets (
      id SERIAL PRIMARY KEY,
      broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id),
      carrier_id INTEGER NOT NULL REFERENCES carriers(id),
      token VARCHAR(64) UNIQUE NOT NULL,
      carrier_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (carrier_status IN ('pending','partially_complete','submitted')),
      broker_status TEXT NOT NULL DEFAULT 'under_review'
        CHECK (broker_status IN ('under_review','complete','rejected','expired','cancelled')),
      expires_at TIMESTAMPTZ NOT NULL,
      carrier_name TEXT,
      carrier_email TEXT,
      carrier_phone TEXT,
      created_by INTEGER NOT NULL REFERENCES broker_users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_setup_packets_carrier ON carrier_setup_packets(carrier_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_setup_packets_broker ON carrier_setup_packets(broker_account_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_setup_packets_token ON carrier_setup_packets(token)`);

  // Extend carrier_documents with setup packet FK and broker fields
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS carrier_setup_packet_id INTEGER REFERENCES carrier_setup_packets(id)`);
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS verified_by INTEGER REFERENCES broker_users(id)`);
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ`);
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS insurer_name TEXT`);
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS r2_object_key TEXT`);
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS file_name TEXT`);
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS file_size INTEGER`);
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS mime_type TEXT`);

  // Relax file_url NOT NULL constraint for URL-optional uploads
  await query(`ALTER TABLE carrier_documents ALTER COLUMN file_url DROP NOT NULL`);

  console.log("Setup packet migrations complete.");
}

export async function migrateTwilio() {
  // Add tracking token to dispatch_packets
  await query(`ALTER TABLE dispatch_packets ADD COLUMN IF NOT EXISTS tracking_token VARCHAR(64) UNIQUE`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dispatch_packets_tracking_token ON dispatch_packets(tracking_token)`);
  // Add SMS delivery status fields
  await query(`ALTER TABLE dispatch_packets ADD COLUMN IF NOT EXISTS pickup_code_sms_status TEXT`);
  await query(`ALTER TABLE dispatch_packets ADD COLUMN IF NOT EXISTS pickup_code_sms_sent_at TIMESTAMPTZ`);
  await query(`ALTER TABLE dispatch_packets ADD COLUMN IF NOT EXISTS tracking_sms_status TEXT`);
  await query(`ALTER TABLE dispatch_packets ADD COLUMN IF NOT EXISTS tracking_sms_sent_at TIMESTAMPTZ`);
  console.log("Twilio migration complete.");
}

export async function migrateTeam() {
  // Invite tokens for adding team members
  await query(`CREATE TABLE IF NOT EXISTS broker_invites (
    id SERIAL PRIMARY KEY,
    broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id),
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'reviewer' CHECK (role IN ('owner', 'ops', 'reviewer')),
    token VARCHAR(64) UNIQUE NOT NULL,
    invited_by INTEGER NOT NULL REFERENCES broker_users(id),
    accepted_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_broker_invites_token ON broker_invites(token)`);
  console.log("Team migration complete.");
}

export async function migrateCarrierProfiles() {
  await query(`
    CREATE TABLE IF NOT EXISTS carrier_profiles (
      id SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      mc_number TEXT,
      contact_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      driver_name TEXT,
      driver_phone TEXT,
      truck_number TEXT,
      trailer_number TEXT,
      equipment_types JSONB DEFAULT '[]',
      lanes_or_regions TEXT,
      cdl_photo_url TEXT,
      cdl_photo_r2_key TEXT,
      vin_photo_url TEXT,
      vin_photo_r2_key TEXT,
      insurance_doc_url TEXT,
      insurance_doc_r2_key TEXT,
      completion_status TEXT NOT NULL DEFAULT 'partial'
        CHECK (completion_status IN ('partial','complete','dispatch_ready')),
      source TEXT DEFAULT 'direct'
        CHECK (source IN ('direct','superseded_nudge','broker_invite','interest_upgrade')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_carrier_profiles_mc ON carrier_profiles(mc_number)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_carrier_profiles_email ON carrier_profiles(email)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_carrier_profiles_status ON carrier_profiles(completion_status)`);

  // Add doc parsing columns (idempotent — uses IF NOT EXISTS pattern via DO block)
  await query(`
    DO $$ BEGIN
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS vin_number TEXT;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS cdl_number TEXT;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS cdl_state TEXT;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS cdl_expiration DATE;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS insurance_expiration DATE;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS insurance_policy_number TEXT;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS insurance_company TEXT;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS insurance_auto_liability INTEGER;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS insurance_cargo INTEGER;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS insurance_general_liability INTEGER;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS insurance_vins JSONB DEFAULT '[]';
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS parsed_cdl JSONB;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS parsed_insurance JSONB;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS parsed_vin TEXT;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS doc_flags JSONB DEFAULT '[]';
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS fmcsa_status TEXT;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS fmcsa_data JSONB;
      ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS fmcsa_checked_at TIMESTAMPTZ;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);
  // Expand source constraint to include all entry points
  await query(`ALTER TABLE carrier_profiles DROP CONSTRAINT IF EXISTS carrier_profiles_source_check`);
  await query(`ALTER TABLE carrier_profiles ADD CONSTRAINT carrier_profiles_source_check CHECK (source IN ('direct','superseded_nudge','broker_invite','interest_upgrade','site','load_apply','load_assign'))`);
  console.log("Carrier profiles migration complete.");
}

export async function migrateBilling() {
  await query(`
    CREATE TABLE IF NOT EXISTS broker_billing (
      id SERIAL PRIMARY KEY,
      broker_account_id INTEGER REFERENCES broker_accounts(id),
      stripe_customer_id TEXT UNIQUE,
      stripe_subscription_id TEXT,
      stripe_price_id TEXT,
      subscription_status TEXT DEFAULT 'none',
      billing_interval TEXT,
      trial_ends_at TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_broker_billing_account ON broker_billing(broker_account_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_broker_billing_customer ON broker_billing(stripe_customer_id)`);
  console.log("Billing migration complete.");
}

export async function migrateVerification() {
  await query(`
    CREATE TABLE IF NOT EXISTS carrier_verifications (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      broker_account_id INTEGER REFERENCES broker_accounts(id),
      broker_name TEXT,
      broker_phone TEXT,
      broker_email TEXT,

      -- Carrier info (from broker trigger)
      mc_number TEXT NOT NULL,
      carrier_phone TEXT,
      carrier_email TEXT,
      carrier_name TEXT,

      -- FMCSA auto-check results
      fmcsa_data JSONB,
      fmcsa_status TEXT,

      -- Carrier-submitted documents (R2 keys)
      doc_cdl TEXT,
      doc_cdl_submitted_at TIMESTAMPTZ,
      doc_insurance TEXT,
      doc_insurance_submitted_at TIMESTAMPTZ,
      doc_cab_card TEXT,
      doc_cab_card_submitted_at TIMESTAMPTZ,
      doc_truck_photo TEXT,
      doc_truck_photo_submitted_at TIMESTAMPTZ,

      -- Carrier-provided info
      driver_name TEXT,
      driver_phone TEXT,
      truck_vin TEXT,
      vin_decode JSONB,

      -- Submission tracking
      submission_method TEXT,
      carrier_first_response_at TIMESTAMPTZ,

      -- Status + result
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete', 'expired')),
      result TEXT CHECK (result IN ('CLEAR', 'CAUTION', 'DO_NOT_USE')),
      result_reasons JSONB DEFAULT '[]',
      result_delivered_at TIMESTAMPTZ,

      -- Notifications
      sms_sent_at TIMESTAMPTZ,
      email_sent_at TIMESTAMPTZ,
      caution_sent_at TIMESTAMPTZ,
      dnu_sent_at TIMESTAMPTZ,
      reminder_count INTEGER DEFAULT 0,
      last_reminder_at TIMESTAMPTZ,

      -- Time-boxing
      deadline TIMESTAMPTZ,

      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cv_token ON carrier_verifications(token)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cv_mc ON carrier_verifications(mc_number)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cv_carrier_phone ON carrier_verifications(carrier_phone)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cv_status ON carrier_verifications(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cv_broker ON carrier_verifications(broker_account_id)`);

  // OCR parsed data columns
  await query(`
    DO $$ BEGIN
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS parsed_cdl JSONB;
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS parsed_insurance JSONB;
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS parsed_vin TEXT;
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS cdl_expiration DATE;
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS insurance_expiration DATE;
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS insurance_company TEXT;
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS insurance_policy_number TEXT;
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS insurance_vins JSONB DEFAULT '[]';
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS cdl_name TEXT;
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS cdl_number TEXT;
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS cdl_state TEXT;
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS doc_flags JSONB DEFAULT '[]';
      ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS carrier_profile_id INTEGER;
    END $$
  `);

  console.log("Verification pipeline migration complete.");

  // ── Password reset codes (SMS-based) ─────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES broker_users(id),
      code VARCHAR(6) NOT NULL,
      phone TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT false,
      attempts INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_prc_user ON password_reset_codes(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_prc_code ON password_reset_codes(code)`);

  // ══════════════════════════════════════════════════════════════════
  // CANONICAL TABLES — broker app owns these per spine architecture
  // See docs/spines/ for design rationale
  // ══════════════════════════════════════════════════════════════════

  // ── Carrier identity (SPINE-0002) ────────────────────────────────
  // The carriers table already exists (created by MCP with mc_number, dot_number,
  // company_name, tier, fmcsa_status, verified_at). Add spine columns.
  await query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS fmcsa_legal_name TEXT`).catch(() => {});
  await query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS fmcsa_status_text TEXT`).catch(() => {});
  await query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS authority_status TEXT`).catch(() => {});
  await query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS safety_rating TEXT`).catch(() => {});
  await query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS phone_contact TEXT`).catch(() => {});
  await query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS email_contact TEXT`).catch(() => {});
  await query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
  await query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
  await query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS network_status TEXT DEFAULT 'known'`).catch(() => {});
  await query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS latest_profile_id INTEGER`).catch(() => {});
  await query(`ALTER TABLE carriers ADD COLUMN IF NOT EXISTS latest_verification_id INTEGER`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_carriers_network_status ON carriers(network_status)`).catch(() => {});

  // ── Canonical loads (SPINE-0001) ─────────────────────────────────
  // Broker-owned. Every load belongs to a broker account.
  await query(`
    CREATE TABLE IF NOT EXISTS canonical_loads (
      id SERIAL PRIMARY KEY,
      load_id VARCHAR(30) UNIQUE NOT NULL,
      slug VARCHAR(20) UNIQUE NOT NULL,
      broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id),
      broker_name TEXT,
      broker_ref TEXT,
      broker_phone VARCHAR(20),
      broker_email TEXT,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      equipment TEXT NOT NULL,
      pickup_date TEXT,
      pickup_address TEXT,
      pickup_window_start TIMESTAMPTZ,
      pickup_window_end TIMESTAMPTZ,
      pickup_window_text TEXT,
      rate_note TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'posted'
        CHECK (status IN ('posted', 'carriers_qualified', 'ready_to_call', 'assigned',
                          'waiting_on_docs', 'clear_to_dispatch', 'review', 'do_not_use',
                          'arrival_sent', 'on_site', 'no_response', 'location_alert',
                          'covered', 'cancelled')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cloads_broker ON canonical_loads(broker_account_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cloads_status ON canonical_loads(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cloads_slug ON canonical_loads(slug)`);

  // ── Canonical load applications (SPINE-0001 + SPINE-0002) ────────
  // One per carrier per load. Links to carrier identity.
  await query(`
    CREATE TABLE IF NOT EXISTS canonical_load_applications (
      id SERIAL PRIMARY KEY,
      load_id INTEGER NOT NULL REFERENCES canonical_loads(id),
      carrier_id INTEGER NOT NULL REFERENCES carriers(id),
      mc_number TEXT NOT NULL,
      company_name TEXT,
      contact_name TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      fmcsa_authority TEXT,
      fmcsa_safety TEXT,
      fmcsa_company TEXT,
      qualification_result TEXT NOT NULL
        CHECK (qualification_result IN ('qualified', 'review', 'not_qualified')),
      qualification_details JSONB,
      has_profile BOOLEAN DEFAULT FALSE,
      profile_completion_status TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(load_id, carrier_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cla_load ON canonical_load_applications(load_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cla_carrier ON canonical_load_applications(carrier_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cla_mc ON canonical_load_applications(mc_number)`);

  // ── Load assignments (SPINE-0004) ────────────────────────────────
  // The hinge between filtering and dispatch. One per assignment event.
  await query(`
    CREATE TABLE IF NOT EXISTS load_assignments (
      id SERIAL PRIMARY KEY,
      load_id INTEGER NOT NULL REFERENCES canonical_loads(id),
      broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id),
      carrier_id INTEGER NOT NULL REFERENCES carriers(id),
      load_application_id INTEGER NOT NULL REFERENCES canonical_load_applications(id),
      assigned_by_user_id INTEGER REFERENCES broker_users(id),
      carrier_verification_id INTEGER,
      dispatch_signal_id INTEGER,
      dispatch_signal_ref TEXT,
      status TEXT NOT NULL DEFAULT 'assigned'
        CHECK (status IN ('assigned', 'verification_requested', 'documents_pending',
                          'clear', 'caution', 'do_not_use',
                          'arrival_pending', 'arrival_confirmed', 'arrival_alert',
                          'superseded', 'cancelled')),
      assigned_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_la_load ON load_assignments(load_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_la_carrier ON load_assignments(carrier_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_la_broker ON load_assignments(broker_account_id)`);

  // ── Carrier consents (SPINE-0003 + SPINE-0007) ───────────────────
  // Records carrier consent for network profile reuse.
  await query(`
    CREATE TABLE IF NOT EXISTS carrier_consents (
      id SERIAL PRIMARY KEY,
      carrier_id INTEGER NOT NULL REFERENCES carriers(id),
      consent_type TEXT NOT NULL
        CHECK (consent_type IN ('network_profile_reuse', 'sms_verification', 'doc_storage')),
      granted BOOLEAN NOT NULL DEFAULT true,
      source TEXT NOT NULL,
      ip_address TEXT,
      granted_at TIMESTAMPTZ DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cc_carrier ON carrier_consents(carrier_id)`);

  // ── Add carrier_id FK to existing tables ─────────────────────────
  await query(`ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS carrier_id INTEGER REFERENCES carriers(id)`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_cp_carrier ON carrier_profiles(carrier_id)`).catch(() => {});
  await query(`ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS carrier_id INTEGER REFERENCES carriers(id)`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_cv_carrier ON carrier_verifications(carrier_id)`).catch(() => {});

  console.log("Canonical tables migration complete.");
}
