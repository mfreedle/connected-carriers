import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

export async function query(text: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function initDb() {
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
      submitted_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS pickup_codes (
      id SERIAL PRIMARY KEY,
      code VARCHAR(10) UNIQUE NOT NULL,
      mc_number VARCHAR(20) NOT NULL,
      load_reference TEXT,
      broker_id TEXT,
      carrier_phone TEXT,
      status VARCHAR(20) DEFAULT 'active',
      expires_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS dispatch_verifications (
      id SERIAL PRIMARY KEY,
      load_id VARCHAR(30) UNIQUE NOT NULL,
      token VARCHAR(64) UNIQUE NOT NULL,
      driver_phone VARCHAR(20) NOT NULL,
      broker_phone VARCHAR(20) NOT NULL,
      mc_number VARCHAR(20),
      pickup_address TEXT NOT NULL,
      pickup_window_start VARCHAR(20),
      pickup_window_end VARCHAR(20),
      geo_center_lat DOUBLE PRECISION,
      geo_center_lng DOUBLE PRECISION,
      geo_radius_miles DOUBLE PRECISION DEFAULT 0.5,
      status VARCHAR(30) DEFAULT 'pending',
      fmcsa_authority VARCHAR(20),
      fmcsa_company TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      confirmed_lat DOUBLE PRECISION,
      confirmed_lng DOUBLE PRECISION,
      distance_miles DOUBLE PRECISION,
      geofence_result VARCHAR(20),
      broker_notified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add reminder tracking columns (safe to run multiple times)
  await query(`ALTER TABLE dispatch_verifications ADD COLUMN IF NOT EXISTS reminder_count INTEGER DEFAULT 0`);
  await query(`ALTER TABLE dispatch_verifications ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ`);
  await query(`ALTER TABLE dispatch_verifications ADD COLUMN IF NOT EXISTS no_confirm_alert_sent BOOLEAN DEFAULT FALSE`);

  // ── LOADS (for inbound filter / load apply page) ──
  await query(`
    CREATE TABLE IF NOT EXISTS loads (
      id SERIAL PRIMARY KEY,
      load_id VARCHAR(30) UNIQUE NOT NULL,
      slug VARCHAR(20) UNIQUE NOT NULL,
      broker_ref TEXT,
      broker_phone VARCHAR(20),
      broker_email TEXT,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      equipment TEXT NOT NULL,
      pickup_date TEXT,
      rate_note TEXT,
      notes TEXT,
      status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','covered','cancelled')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add broker_ref column if table already exists
  await query("ALTER TABLE loads ADD COLUMN IF NOT EXISTS broker_ref TEXT").catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS load_applications (
      id SERIAL PRIMARY KEY,
      load_id INTEGER NOT NULL REFERENCES loads(id),
      mc_number TEXT NOT NULL,
      company_name TEXT,
      contact_name TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      fmcsa_authority TEXT,
      fmcsa_safety TEXT,
      fmcsa_company TEXT,
      qualification_result TEXT NOT NULL CHECK (qualification_result IN ('qualified','review','not_qualified')),
      qualification_details JSONB,
      has_profile BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_load_applications_load ON load_applications(load_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_load_applications_mc ON load_applications(mc_number)`);

  console.error("Database initialized — tables ready");
}

export default pool;
