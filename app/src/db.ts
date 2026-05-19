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

  // ── Widen canonical_loads.status to include waiting_on_dec_page ──
  await query(`ALTER TABLE canonical_loads DROP CONSTRAINT IF EXISTS canonical_loads_status_check`).catch(() => {});
  await query(`ALTER TABLE canonical_loads ADD CONSTRAINT canonical_loads_status_check CHECK (status IN (
    'posted', 'carriers_qualified', 'ready_to_call', 'assigned',
    'waiting_on_docs', 'waiting_on_dec_page', 'clear_to_dispatch', 'review', 'do_not_use',
    'arrival_sent', 'on_site', 'no_response', 'location_alert',
    'covered', 'cancelled'
  ))`).catch(() => {});

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
  await query(`ALTER TABLE load_assignments ADD COLUMN IF NOT EXISTS dispatch_signal_id INTEGER`);
  await query(`ALTER TABLE load_assignments ADD COLUMN IF NOT EXISTS dispatch_signal_ref TEXT`);
  await query(`ALTER TABLE load_assignments ADD COLUMN IF NOT EXISTS driver_id INTEGER`);
  await query(`ALTER TABLE load_assignments ADD COLUMN IF NOT EXISTS equipment_id INTEGER`);
  await query(`ALTER TABLE load_assignments ADD COLUMN IF NOT EXISTS confirmation_token TEXT`);
  await query(`ALTER TABLE load_assignments ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_la_confirmation_token ON load_assignments(confirmation_token) WHERE confirmation_token IS NOT NULL`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_la_load ON load_assignments(load_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_la_carrier ON load_assignments(carrier_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_la_broker ON load_assignments(broker_account_id)`);

  // ── Widen load_assignments.status to include needs_dec_page ──
  await query(`ALTER TABLE load_assignments DROP CONSTRAINT IF EXISTS load_assignments_status_check`).catch(() => {});
  await query(`ALTER TABLE load_assignments ADD CONSTRAINT load_assignments_status_check CHECK (status IN (
    'assigned', 'verification_requested', 'documents_pending',
    'clear', 'caution', 'do_not_use',
    'needs_dec_page',
    'arrival_pending', 'arrival_confirmed', 'arrival_alert',
    'superseded', 'cancelled'
  ))`).catch(() => {});

  // ── Dec page tracking columns on load_assignments ──
  await query(`ALTER TABLE load_assignments ADD COLUMN IF NOT EXISTS dec_page_requested_at TIMESTAMPTZ`).catch(() => {});
  await query(`ALTER TABLE load_assignments ADD COLUMN IF NOT EXISTS dec_page_reminder_count INTEGER DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE load_assignments ADD COLUMN IF NOT EXISTS dec_page_last_reminder_at TIMESTAMPTZ`).catch(() => {});
  await query(`ALTER TABLE load_assignments ADD COLUMN IF NOT EXISTS dec_page_escalated_at TIMESTAMPTZ`).catch(() => {});

  // ── Carrier consents (SPINE-0003 + SPINE-0007) ───────────────────
  // Records carrier consent for network profile reuse.
  await query(`
    CREATE TABLE IF NOT EXISTS carrier_consents (
      id SERIAL PRIMARY KEY,
      carrier_id INTEGER REFERENCES carriers(id),
      broker_account_id INTEGER REFERENCES broker_accounts(id),
      consent_type TEXT NOT NULL
        CHECK (consent_type IN ('network_profile_reuse', 'sms_verification', 'doc_storage', 'broker_sms')),
      granted BOOLEAN NOT NULL DEFAULT true,
      source TEXT NOT NULL,
      phone TEXT,
      consent_text TEXT,
      ip_address TEXT,
      user_agent TEXT,
      load_id INTEGER,
      granted_at TIMESTAMPTZ DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cc_carrier ON carrier_consents(carrier_id)`);
  // Add columns to existing table if it was created before this migration
  await query(`ALTER TABLE carrier_consents ADD COLUMN IF NOT EXISTS phone TEXT`).catch(() => {});
  await query(`ALTER TABLE carrier_consents ADD COLUMN IF NOT EXISTS consent_text TEXT`).catch(() => {});
  await query(`ALTER TABLE carrier_consents ADD COLUMN IF NOT EXISTS user_agent TEXT`).catch(() => {});
  await query(`ALTER TABLE carrier_consents ADD COLUMN IF NOT EXISTS load_id INTEGER`).catch(() => {});
  await query(`ALTER TABLE carrier_consents ADD COLUMN IF NOT EXISTS broker_account_id INTEGER REFERENCES broker_accounts(id)`).catch(() => {});
  // Expand CHECK constraint
  await query(`ALTER TABLE carrier_consents DROP CONSTRAINT IF EXISTS carrier_consents_consent_type_check`).catch(() => {});
  await query(`ALTER TABLE carrier_consents ADD CONSTRAINT carrier_consents_consent_type_check CHECK (consent_type IN ('network_profile_reuse', 'sms_verification', 'doc_storage', 'broker_sms'))`).catch(() => {});

  // ── Carrier drivers (SPINE-0009 + SPINE-0010) ────────────────────
  // Per-driver record under a carrier MC. Stores current extracted facts.
  // Document files live in carrier_documents, not here.
  await query(`
    CREATE TABLE IF NOT EXISTS carrier_drivers (
      id SERIAL PRIMARY KEY,
      carrier_id INTEGER NOT NULL REFERENCES carriers(id),
      driver_name TEXT NOT NULL,
      driver_phone TEXT,
      cdl_number TEXT,
      cdl_state TEXT,
      cdl_expiration DATE,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'expired')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cd_carrier ON carrier_drivers(carrier_id)`);

  // ── Carrier equipment (SPINE-0009 + SPINE-0010) ──────────────────
  // Per-truck/trailer record under a carrier MC.
  // Cab card / truck photo files live in carrier_documents, not here.
  await query(`
    CREATE TABLE IF NOT EXISTS carrier_equipment (
      id SERIAL PRIMARY KEY,
      carrier_id INTEGER NOT NULL REFERENCES carriers(id),
      truck_number TEXT,
      vin_number TEXT,
      trailer_number TEXT,
      equipment_type TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ce_carrier ON carrier_equipment(carrier_id)`);

  // ── Carrier documents (SPINE-0009 + SPINE-0010) ──────────────────
  // Canonical document storage. Files in R2, metadata here.
  // Linked to carrier, and optionally to a specific driver or equipment.
  await query(`
    CREATE TABLE IF NOT EXISTS carrier_documents (
      id SERIAL PRIMARY KEY,
      carrier_id INTEGER NOT NULL REFERENCES carriers(id),
      driver_id INTEGER REFERENCES carrier_drivers(id),
      equipment_id INTEGER REFERENCES carrier_equipment(id),
      doc_type TEXT NOT NULL
        CHECK (doc_type IN ('cdl', 'insurance', 'cab_card', 'truck_photo', 'w9')),
      r2_key TEXT,
      file_url TEXT,
      parsed_data JSONB,
      expiration_date DATE,
      status TEXT NOT NULL DEFAULT 'current'
        CHECK (status IN ('current', 'expiring', 'expired', 'superseded')),
      source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS driver_id INTEGER REFERENCES carrier_drivers(id)`).catch(() => {});
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS equipment_id INTEGER REFERENCES carrier_equipment(id)`).catch(() => {});
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS doc_type TEXT`).catch(() => {});
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS r2_key TEXT`).catch(() => {});
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS parsed_data JSONB`).catch(() => {});
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS expiration_date DATE`).catch(() => {});
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'current'`).catch(() => {});
  await query(`ALTER TABLE carrier_documents ADD COLUMN IF NOT EXISTS source TEXT`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_cdoc_carrier ON carrier_documents(carrier_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cdoc_driver ON carrier_documents(driver_id) WHERE driver_id IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cdoc_equipment ON carrier_documents(equipment_id) WHERE equipment_id IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cdoc_type ON carrier_documents(doc_type, status)`);

  // ── Widen document type constraints to include declarations_page ──
  // Legacy document_type (NOT NULL, original table)
  await query(`ALTER TABLE carrier_documents DROP CONSTRAINT IF EXISTS carrier_documents_document_type_check`).catch(() => {});
  await query(`ALTER TABLE carrier_documents ADD CONSTRAINT carrier_documents_document_type_check CHECK (document_type IN (
    'coi','w9','signed_agreement','cdl','truck_photo','vin_photo','cab_card','rate_confirmation','declarations_page','other'
  ))`).catch(() => {});
  // Canonical doc_type (nullable — old rows may have NULL)
  await query(`ALTER TABLE carrier_documents DROP CONSTRAINT IF EXISTS carrier_documents_doc_type_check`).catch(() => {});
  await query(`ALTER TABLE carrier_documents ADD CONSTRAINT carrier_documents_doc_type_check CHECK (
    doc_type IS NULL OR doc_type IN ('cdl', 'insurance', 'cab_card', 'truck_photo', 'w9', 'declarations_page')
  )`).catch(() => {});

  // ── Add FKs from load_assignments to driver/equipment ────────────
  // These reference the new tables. Added as ALTER since load_assignments
  // was created before carrier_drivers/carrier_equipment exist.
  await query(`ALTER TABLE load_assignments ADD CONSTRAINT fk_la_driver FOREIGN KEY (driver_id) REFERENCES carrier_drivers(id)`).catch(() => {});
  await query(`ALTER TABLE load_assignments ADD CONSTRAINT fk_la_equipment FOREIGN KEY (equipment_id) REFERENCES carrier_equipment(id)`).catch(() => {});

  // ── Add carrier_id FK to existing tables ─────────────────────────
  await query(`ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS carrier_id INTEGER REFERENCES carriers(id)`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_cp_carrier ON carrier_profiles(carrier_id)`).catch(() => {});
  await query(`ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS status_token TEXT`).catch(() => {});
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cp_status_token ON carrier_profiles(status_token) WHERE status_token IS NOT NULL`).catch(() => {});

  // Backfill status_token for profiles that don't have one
  try {
    const noToken = await query("SELECT id FROM carrier_profiles WHERE status_token IS NULL LIMIT 100");
    for (const row of noToken.rows) {
      const token = require("crypto").randomBytes(24).toString("base64url");
      await query("UPDATE carrier_profiles SET status_token = $1 WHERE id = $2 AND status_token IS NULL", [token, row.id]);
    }
    if (noToken.rows.length > 0) {
      console.log(`[BACKFILL] Generated status_token for ${noToken.rows.length} carrier profiles.`);
    }
  } catch (err) {
    console.error("[BACKFILL] status_token error (non-fatal):", err);
  }
  await query(`ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS carrier_id INTEGER REFERENCES carriers(id)`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_cv_carrier ON carrier_verifications(carrier_id)`).catch(() => {});

  // ── Backfill: link orphaned profiles and verifications to carrier identity ──
  // Only runs on rows where carrier_id is NULL and mc_number matches a carrier
  try {
    const backfillProfiles = await query(`
      UPDATE carrier_profiles cp SET carrier_id = c.id
      FROM carriers c
      WHERE cp.mc_number = c.mc_number AND cp.carrier_id IS NULL
    `);
    if (backfillProfiles.rowCount && backfillProfiles.rowCount > 0) {
      console.log(`[BACKFILL] Linked ${backfillProfiles.rowCount} carrier_profiles to carrier identity.`);
    }

    const backfillVerifications = await query(`
      UPDATE carrier_verifications cv SET carrier_id = c.id
      FROM carriers c
      WHERE cv.mc_number = c.mc_number AND cv.carrier_id IS NULL
    `);
    if (backfillVerifications.rowCount && backfillVerifications.rowCount > 0) {
      console.log(`[BACKFILL] Linked ${backfillVerifications.rowCount} carrier_verifications to carrier identity.`);
    }

    // Update carriers.latest_profile_id from the most recent profile
    await query(`
      UPDATE carriers c SET latest_profile_id = sub.id
      FROM (
        SELECT DISTINCT ON (carrier_id) id, carrier_id
        FROM carrier_profiles
        WHERE carrier_id IS NOT NULL
        ORDER BY carrier_id, updated_at DESC
      ) sub
      WHERE c.id = sub.carrier_id AND c.latest_profile_id IS NULL
    `);

    // Update carriers.latest_verification_id from the most recent verification
    await query(`
      UPDATE carriers c SET latest_verification_id = sub.id
      FROM (
        SELECT DISTINCT ON (carrier_id) id, carrier_id
        FROM carrier_verifications
        WHERE carrier_id IS NOT NULL
        ORDER BY carrier_id, created_at DESC
      ) sub
      WHERE c.id = sub.carrier_id AND c.latest_verification_id IS NULL
    `);
  } catch (err) {
    console.error("[BACKFILL] Error (non-fatal):", err);
  }

  // ── Backfill: carrier_drivers, carrier_equipment, carrier_documents from carrier_profiles ──
  // Runs AFTER carrier_id backfill so profiles have carrier_id set.
  // Idempotent: checks existing canonical and legacy document rows to avoid duplicates.
  try {
    // 1. Backfill carrier_drivers from profiles with driver data
    const driverProfiles = await query(`
      SELECT cp.carrier_id, cp.driver_name, cp.driver_phone,
             cp.cdl_number, cp.cdl_state, cp.cdl_expiration
      FROM carrier_profiles cp
      WHERE cp.carrier_id IS NOT NULL
        AND cp.driver_name IS NOT NULL AND cp.driver_name != ''
      ORDER BY cp.updated_at DESC
    `);
    let driversCreated = 0;
    for (const p of driverProfiles.rows) {
      // Dedupe: prefer carrier_id + cdl_number, fall back to carrier_id + name + phone
      const existsResult = p.cdl_number
        ? await query(
            `SELECT id FROM carrier_drivers WHERE carrier_id = $1 AND cdl_number = $2`,
            [p.carrier_id, p.cdl_number]
          )
        : await query(
            `SELECT id FROM carrier_drivers WHERE carrier_id = $1 AND LOWER(driver_name) = LOWER($2) AND COALESCE(driver_phone,'') = COALESCE($3,'')`,
            [p.carrier_id, p.driver_name, p.driver_phone || ""]
          );
      if (existsResult.rows.length === 0) {
        const driverStatus = p.cdl_expiration && new Date(p.cdl_expiration) < new Date() ? "expired" : "active";
        await query(
          `INSERT INTO carrier_drivers (carrier_id, driver_name, driver_phone, cdl_number, cdl_state, cdl_expiration, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [p.carrier_id, p.driver_name, p.driver_phone || null, p.cdl_number || null, p.cdl_state || null, p.cdl_expiration || null, driverStatus]
        );
        driversCreated++;
      }
    }
    if (driversCreated > 0) console.log(`[BACKFILL] Created ${driversCreated} carrier_drivers from profiles.`);

    // 2. Backfill carrier_equipment from profiles with VIN or truck data
    const equipProfiles = await query(`
      SELECT cp.carrier_id, cp.truck_number, cp.vin_number, cp.trailer_number
      FROM carrier_profiles cp
      WHERE cp.carrier_id IS NOT NULL
        AND (cp.vin_number IS NOT NULL OR cp.truck_number IS NOT NULL)
      ORDER BY cp.updated_at DESC
    `);
    let equipCreated = 0;
    for (const p of equipProfiles.rows) {
      // Dedupe: prefer carrier_id + vin_number, fall back to carrier_id + truck_number + trailer_number
      const existsResult = p.vin_number
        ? await query(
            `SELECT id FROM carrier_equipment WHERE carrier_id = $1 AND vin_number = $2`,
            [p.carrier_id, p.vin_number]
          )
        : await query(
            `SELECT id FROM carrier_equipment WHERE carrier_id = $1 AND COALESCE(truck_number,'') = COALESCE($2,'') AND COALESCE(trailer_number,'') = COALESCE($3,'')`,
            [p.carrier_id, p.truck_number || "", p.trailer_number || ""]
          );
      if (existsResult.rows.length === 0) {
        await query(
          `INSERT INTO carrier_equipment (carrier_id, truck_number, vin_number, trailer_number, status)
           VALUES ($1, $2, $3, $4, 'active')`,
          [p.carrier_id, p.truck_number || null, p.vin_number || null, p.trailer_number || null]
        );
        equipCreated++;
      }
    }
    if (equipCreated > 0) console.log(`[BACKFILL] Created ${equipCreated} carrier_equipment from profiles.`);

    // 3. Backfill carrier_documents from profiles with R2 keys or URLs
    const docProfiles = await query(`
      SELECT cp.id as profile_id, cp.carrier_id, cp.mc_number,
             cp.cdl_photo_r2_key, cp.cdl_photo_url,
             cp.insurance_doc_r2_key, cp.insurance_doc_url,
             cp.vin_photo_r2_key, cp.vin_photo_url,
             cp.parsed_cdl, cp.parsed_insurance,
             cp.cdl_expiration, cp.insurance_expiration,
             cp.driver_name, cp.cdl_number,
             cp.truck_number, cp.trailer_number, cp.vin_number
      FROM carrier_profiles cp
      WHERE cp.carrier_id IS NOT NULL
        AND (cp.cdl_photo_r2_key IS NOT NULL OR cp.cdl_photo_url IS NOT NULL
             OR cp.insurance_doc_r2_key IS NOT NULL OR cp.insurance_doc_url IS NOT NULL
             OR cp.vin_photo_r2_key IS NOT NULL OR cp.vin_photo_url IS NOT NULL)
      ORDER BY cp.updated_at DESC
    `);
    let docsCreated = 0;
    const today = new Date();
    const thirtyDays = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

    for (const p of docProfiles.rows) {
      // Look up the driver_id and equipment_id we may have just created
      let driverId: number | null = null;
      let equipmentId: number | null = null;

      if (p.cdl_number || p.driver_name) {
        const dResult = p.cdl_number
          ? await query(`SELECT id FROM carrier_drivers WHERE carrier_id = $1 AND cdl_number = $2 LIMIT 1`, [p.carrier_id, p.cdl_number])
          : await query(`SELECT id FROM carrier_drivers WHERE carrier_id = $1 AND LOWER(driver_name) = LOWER($2) LIMIT 1`, [p.carrier_id, p.driver_name]);
        if (dResult.rows.length) driverId = dResult.rows[0].id;
      }

      if (p.vin_number || p.truck_number) {
        const eResult = p.vin_number
          ? await query(`SELECT id FROM carrier_equipment WHERE carrier_id = $1 AND vin_number = $2 LIMIT 1`, [p.carrier_id, p.vin_number])
          : await query(
              `SELECT id FROM carrier_equipment
               WHERE carrier_id = $1
                 AND COALESCE(truck_number,'') = COALESCE($2,'')
                 AND COALESCE(trailer_number,'') = COALESCE($3,'')
               LIMIT 1`,
              [p.carrier_id, p.truck_number || "", p.trailer_number || ""]
            );
        if (eResult.rows.length) equipmentId = eResult.rows[0].id;
      }

      // Helper to compute freshness status
      const freshness = (expDate: string | null): string => {
        if (!expDate) return "current";
        const exp = new Date(expDate);
        if (exp < today) return "expired";
        if (exp < thirtyDays) return "expiring";
        return "current";
      };

      // CDL document
      if (p.cdl_photo_r2_key || p.cdl_photo_url) {
        const r2Key = p.cdl_photo_r2_key || null;
        const fileUrl = p.cdl_photo_url || null;
        const exists = await query(
          `SELECT id FROM carrier_documents
           WHERE carrier_id = $1
             AND (doc_type = 'cdl' OR (doc_type IS NULL AND document_type = 'cdl'))
             AND (COALESCE(r2_key, r2_object_key) = $2 OR ($2 IS NULL AND file_url = $3))`,
          [p.carrier_id, r2Key, fileUrl]
        );
        if (exists.rows.length === 0) {
          await query(
            `INSERT INTO carrier_documents (carrier_id, driver_id, doc_type, document_type, r2_key, r2_object_key, file_url, parsed_data, expiration_date, expires_at, status, source)
             VALUES ($1, $2, 'cdl', 'cdl', $3, $3, $4, $5, $6::date, $6::timestamptz, $7, 'backfill')`,
            [p.carrier_id, driverId, r2Key, fileUrl, p.parsed_cdl ? JSON.stringify(p.parsed_cdl) : null, p.cdl_expiration || null, freshness(p.cdl_expiration)]
          );
          docsCreated++;
        }
      }

      // Insurance document (doc_type='insurance', document_type='coi' for legacy compat)
      if (p.insurance_doc_r2_key || p.insurance_doc_url) {
        const r2Key = p.insurance_doc_r2_key || null;
        const fileUrl = p.insurance_doc_url || null;
        const exists = await query(
          `SELECT id FROM carrier_documents
           WHERE carrier_id = $1
             AND (doc_type = 'insurance' OR (doc_type IS NULL AND document_type = 'coi'))
             AND (COALESCE(r2_key, r2_object_key) = $2 OR ($2 IS NULL AND file_url = $3))`,
          [p.carrier_id, r2Key, fileUrl]
        );
        if (exists.rows.length === 0) {
          await query(
            `INSERT INTO carrier_documents (carrier_id, doc_type, document_type, r2_key, r2_object_key, file_url, parsed_data, expiration_date, expires_at, status, source)
             VALUES ($1, 'insurance', 'coi', $2, $2, $3, $4, $5::date, $5::timestamptz, $6, 'backfill')`,
            [p.carrier_id, r2Key, fileUrl, p.parsed_insurance ? JSON.stringify(p.parsed_insurance) : null, p.insurance_expiration || null, freshness(p.insurance_expiration)]
          );
          docsCreated++;
        }
      }

      // Cab card / VIN photo document
      if (p.vin_photo_r2_key || p.vin_photo_url) {
        const r2Key = p.vin_photo_r2_key || null;
        const fileUrl = p.vin_photo_url || null;
        const exists = await query(
          `SELECT id FROM carrier_documents
           WHERE carrier_id = $1
             AND (doc_type = 'cab_card' OR (doc_type IS NULL AND document_type IN ('cab_card', 'vin_photo')))
             AND (COALESCE(r2_key, r2_object_key) = $2 OR ($2 IS NULL AND file_url = $3))`,
          [p.carrier_id, r2Key, fileUrl]
        );
        if (exists.rows.length === 0) {
          await query(
            `INSERT INTO carrier_documents (carrier_id, equipment_id, doc_type, document_type, r2_key, r2_object_key, file_url, status, source)
             VALUES ($1, $2, 'cab_card', 'cab_card', $3, $3, $4, 'current', 'backfill')`,
            [p.carrier_id, equipmentId, r2Key, fileUrl]
          );
          docsCreated++;
        }
      }
    }
    if (docsCreated > 0) console.log(`[BACKFILL] Created ${docsCreated} carrier_documents from profiles.`);

    // 4. Repair linkage: attach unlinked docs to the right driver/equipment
    // This catches docs that were created before drivers/equipment existed,
    // or legacy rows that never had driver_id/equipment_id set.
    let linksRepaired = 0;

    // CDL docs without driver_id — link only on a confident match.
    // If a carrier has multiple active drivers and the doc lacks parsed CDL data,
    // leave it unlinked so we do not attach a CDL to the wrong person.
    const unlnkCdl = await query(
      `SELECT cd.id as doc_id, cd.carrier_id, cd.parsed_data
       FROM carrier_documents cd
       WHERE cd.driver_id IS NULL
         AND (cd.doc_type = 'cdl' OR cd.document_type = 'cdl')
         AND COALESCE(cd.status, 'current') != 'superseded'
       LIMIT 200`
    );
    for (const doc of unlnkCdl.rows) {
      const parsed = typeof doc.parsed_data === "string" ? JSON.parse(doc.parsed_data || "{}") : (doc.parsed_data || {});
      const parsedCdlNumber = parsed.cdl_number || parsed.license_number || null;
      const parsedDriverName = parsed.driver_name || parsed.name || null;

      let driver;
      if (parsedCdlNumber) {
        driver = await query(
          "SELECT id FROM carrier_drivers WHERE carrier_id = $1 AND status = 'active' AND cdl_number = $2 LIMIT 1",
          [doc.carrier_id, parsedCdlNumber]
        );
      }
      if (!driver?.rows?.length && parsedDriverName) {
        driver = await query(
          "SELECT id FROM carrier_drivers WHERE carrier_id = $1 AND status = 'active' AND LOWER(driver_name) = LOWER($2) LIMIT 1",
          [doc.carrier_id, parsedDriverName]
        );
      }
      if (!driver?.rows?.length) {
        driver = await query(
          `SELECT id FROM carrier_drivers
           WHERE carrier_id = $1 AND status = 'active'
             AND (SELECT COUNT(*) FROM carrier_drivers WHERE carrier_id = $1 AND status = 'active') = 1
           LIMIT 1`,
          [doc.carrier_id]
        );
      }

      if (driver?.rows?.length) {
        await query("UPDATE carrier_documents SET driver_id = $1, updated_at = NOW() WHERE id = $2", [driver.rows[0].id, doc.doc_id]);
        linksRepaired++;
      }
    }

    // Cab card / truck photo docs without equipment_id — link only on VIN match
    // or when the carrier has exactly one active equipment record.
    const unlnkCab = await query(
      `SELECT cd.id as doc_id, cd.carrier_id, cd.parsed_data
       FROM carrier_documents cd
       WHERE cd.equipment_id IS NULL
         AND (cd.doc_type IN ('cab_card', 'truck_photo') OR cd.document_type IN ('cab_card', 'truck_photo', 'vin_photo'))
         AND COALESCE(cd.status, 'current') != 'superseded'
       LIMIT 200`
    );
    for (const doc of unlnkCab.rows) {
      const parsed = typeof doc.parsed_data === "string" ? JSON.parse(doc.parsed_data || "{}") : (doc.parsed_data || {});
      const parsedVin = parsed.vin || parsed.vin_number || null;

      let equip;
      if (parsedVin) {
        equip = await query(
          "SELECT id FROM carrier_equipment WHERE carrier_id = $1 AND status = 'active' AND vin_number = $2 LIMIT 1",
          [doc.carrier_id, parsedVin]
        );
      }
      if (!equip?.rows?.length) {
        equip = await query(
          `SELECT id FROM carrier_equipment
           WHERE carrier_id = $1 AND status = 'active'
             AND (SELECT COUNT(*) FROM carrier_equipment WHERE carrier_id = $1 AND status = 'active') = 1
           LIMIT 1`,
          [doc.carrier_id]
        );
      }

      if (equip?.rows?.length) {
        await query("UPDATE carrier_documents SET equipment_id = $1, updated_at = NOW() WHERE id = $2", [equip.rows[0].id, doc.doc_id]);
        linksRepaired++;
      }
    }

    if (linksRepaired > 0) console.log(`[BACKFILL] Repaired ${linksRepaired} unlinked carrier_documents.`);

  } catch (err) {
    console.error("[BACKFILL] Driver/equipment/document backfill error (non-fatal):", err);
  }

  console.log("Canonical tables migration complete.");
}
