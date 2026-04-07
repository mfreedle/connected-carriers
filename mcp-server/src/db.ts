import pg from "pg";
const { Pool } = pg;

// PostgreSQL connection — Railway provides DATABASE_URL automatically
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

  console.error("Database initialized — tables ready");
}

export default pool;
