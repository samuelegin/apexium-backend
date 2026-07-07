require('dotenv').config();
const { Pool } = require('pg');

const { DATABASE_URL } = process.env;

let pool;

async function initDb() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });

  const client = await pool.connect();
  console.log('Connected to PostgreSQL');
  client.release();

  await createSchema();
}

function getDb() {
  if (!pool) throw new Error('DB not initialised — call await initDb() first');
  return dbProxy;
}

function toPostgres(sql, params = []) {
  let i = 0;
  const converted = sql
    .replace(/`([^`]+)`/g, '"$1"')
    .replace(/\?/g, () => `$${++i}`);
  return { sql: converted, params };
}

async function runQuery(sql, params = []) {
  const pg = toPostgres(sql, params);
  await pool.query(pg.sql, pg.params);
}

async function getQuery(sql, params = []) {
  const pg = toPostgres(sql, params);
  const result = await pool.query(pg.sql, pg.params);
  return result.rows[0] ?? undefined;
}

async function allQuery(sql, params = []) {
  const pg = toPostgres(sql, params);
  const result = await pool.query(pg.sql, pg.params);
  return result.rows;
}

async function execQuery(sql) {
  await pool.query(sql);
}

function transaction(fn) {
  return async function (...args) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txProxy = makeTxProxy(client);
      const result = await fn(txProxy, ...args);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };
}

function makeTxProxy(client) {
  const txRun = async (sql, ...params) => {
    const pg = toPostgres(sql, params.flat());
    await client.query(pg.sql, pg.params);
  };
  const txGet = async (sql, ...params) => {
    const pg = toPostgres(sql, params.flat());
    const result = await client.query(pg.sql, pg.params);
    return result.rows[0] ?? undefined;
  };
  const txAll = async (sql, ...params) => {
    const pg = toPostgres(sql, params.flat());
    const result = await client.query(pg.sql, pg.params);
    return result.rows;
  };
  return {
    prepare: (sql) => ({
      run: (...params) => txRun(sql, ...params),
      get: (...params) => txGet(sql, ...params),
      all: (...params) => txAll(sql, ...params),
      bind: () => {},
    }),
    get: txGet,
    all: txAll,
    run: txRun,
    exec: (sql) => client.query(sql),
    transaction,
  };
}

const dbProxy = {
  prepare: (sql) => ({
    run: (...params) => runQuery(sql, params.flat()),
    get: (...params) => getQuery(sql, params.flat()),
    all: (...params) => allQuery(sql, params.flat()),
    bind: () => {},
  }),
  get: (sql, ...params) => getQuery(sql, params.flat()),
  all: (sql, ...params) => allQuery(sql, params.flat()),
  run: (sql, ...params) => runQuery(sql, params.flat()),
  exec: execQuery,
  transaction,
};

async function createSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      full_name TEXT DEFAULT '',
      username TEXT UNIQUE,
      bio TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      x_handle TEXT DEFAULT '',
      role TEXT DEFAULT 'user',
      xp_total INTEGER DEFAULT 0,
      average_pi_score REAL DEFAULT 0,
      total_jobs_completed INTEGER DEFAULT 0,
      last_login_date TEXT DEFAULT '',
      referral_code TEXT DEFAULT '',
      top_categories TEXT DEFAULT '[]',
      wallet_address TEXT DEFAULT '',
      cv_url TEXT DEFAULT '',
      selected_mode TEXT DEFAULT 'jobber',
      mode_confirmed BOOLEAN DEFAULT FALSE,
      telegram_id TEXT DEFAULT '',
      telegram_username TEXT DEFAULT '',
      discord_id TEXT DEFAULT '',
      discord_username TEXT DEFAULT '',
      last_application_ts BIGINT DEFAULT 0,
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      updated_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,

    `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'other',
      employer_email TEXT NOT NULL,
      employer_username TEXT DEFAULT '',
      selected_applicant_email TEXT,
      selected_applicant_username TEXT,
      status TEXT DEFAULT 'open',
      payment_amount REAL DEFAULT 0,
      deadline TEXT DEFAULT '',
      applicant_count INTEGER DEFAULT 0,
      kpi_summary TEXT DEFAULT '',
      extension_requested BOOLEAN DEFAULT FALSE,
      extension_hours REAL DEFAULT 0,
      extension_reason TEXT DEFAULT '',
      extension_status TEXT DEFAULT 'pending',
      last_activity_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      escrow_funded BOOLEAN DEFAULT FALSE,
      escrow_tx_hash TEXT DEFAULT '',
      escrow_error TEXT,
      jobber_wallet TEXT,
      escrow_taken BOOLEAN DEFAULT FALSE,
      escrow_release_pending BOOLEAN DEFAULT FALSE,
      escrow_released BOOLEAN DEFAULT FALSE,
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      updated_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,

    `CREATE TABLE IF NOT EXISTS kpis (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      name TEXT NOT NULL,
      target_value TEXT DEFAULT '',
      weight REAL DEFAULT 0,
      baseline TEXT DEFAULT '',
      is_primary BOOLEAN DEFAULT FALSE,
      status TEXT DEFAULT 'not_started',
      completion_percent REAL DEFAULT 0,
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      updated_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,

    `CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      applicant_email TEXT NOT NULL,
      applicant_username TEXT DEFAULT '',
      proposal TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      application_type TEXT DEFAULT 'manual',
      is_pod BOOLEAN DEFAULT FALSE,
      pod_name TEXT,
      pod_members TEXT DEFAULT '[]',
      performance_snapshot TEXT DEFAULT '{}',
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      updated_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,

    `CREATE TABLE IF NOT EXISTS proof_submissions (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      kpi_id TEXT NOT NULL,
      submitter_email TEXT NOT NULL,
      proof_link TEXT DEFAULT '',
      metric_achieved TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      rejection_reason TEXT,
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      updated_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,

    `CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      sender_username TEXT DEFAULT '',
      content TEXT NOT NULL,
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,

    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT DEFAULT '',
      message TEXT DEFAULT '',
      job_id TEXT,
      is_read BOOLEAN DEFAULT FALSE,
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,

    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      required_action TEXT DEFAULT '',
      required_keyword TEXT DEFAULT '',
      xp_reward INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      updated_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,

    `CREATE TABLE IF NOT EXISTS task_submissions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      proof_link TEXT DEFAULT '',
      status TEXT DEFAULT 'approved',
      xp_awarded INTEGER DEFAULT 0,
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,

    `CREATE TABLE IF NOT EXISTS xp_logs (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      source TEXT NOT NULL,
      xp_amount INTEGER DEFAULT 0,
      label TEXT DEFAULT '',
      reference_id TEXT,
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,

    `CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referrer_email TEXT NOT NULL,
      referred_email TEXT NOT NULL,
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,

    `CREATE TABLE IF NOT EXISTS email_verifications (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      verification_code TEXT NOT NULL,
      full_name TEXT,
      password_hash TEXT,
      username TEXT DEFAULT '',
      referrer_email TEXT DEFAULT NULL,
      expires_at TEXT NOT NULL,
      created_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )`,
  ];

  for (const stmt of statements) {
    await pool.query(stmt);
  }

  const jobColumnMigrations = [
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS onchain_job_id TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS escrow_status TEXT DEFAULT 'none'`, // none|funded|completed|claimed|refunded
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS escrow_disputed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fund_tx_hash TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS complete_tx_hash TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claim_tx_hash TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dispute_tx_hash TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resolve_tx_hash TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS funded_at TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_at TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claimed_at TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS timeout_deadline TEXT DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payout_recipients TEXT DEFAULT '[]'`, // JSON array of addresses — set via setPayout(), any time before completion
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payout_shares TEXT DEFAULT '[]'`,     // JSON array of integer percentages, same order as recipients
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payout_tx_hash TEXT DEFAULT ''`,      // tx hash of the most recent setPayout() call
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fee_bps_at_claim INTEGER DEFAULT 0`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fee_amount REAL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_onchain_job_id ON jobs (onchain_job_id)`,
  ];
  for (const stmt of jobColumnMigrations) {
    await pool.query(stmt);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      id TEXT PRIMARY KEY,
      last_synced_block BIGINT DEFAULT 0,
      updated_date TEXT DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    )
  `);

  console.log('Schema ready');
}

module.exports = { initDb, getDb };