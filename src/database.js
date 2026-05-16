/**
 * database.js Turso / local SQLite wrapper.
 *
 * In development, this uses sql.js with a local filesystem-backed database.
 * In production, it connects to Turso Cloud via @tursodatabase/serverless.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const {
  TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN,
  TURSO_REMOTE_ENCRYPTION_KEY,
  DATABASE_PATH = 'database.sqlite',
} = process.env;

const DB_PATH = path.isAbsolute(DATABASE_PATH)
  ? DATABASE_PATH
  : path.join(__dirname, '..', DATABASE_PATH);

let SQL;
let db;
let usingTurso = false;

async function initSqlJs() {
  if (SQL) return;
  SQL = await require('sql.js')();
}

function loadOrCreate() {
  console.log(`Using local SQLite database file: ${DB_PATH}`);
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  createSchema();
  try { db.run("ALTER TABLE users ADD COLUMN wallet_address TEXT DEFAULT ''"); } catch (_) {}
  try { db.run("ALTER TABLE users ADD COLUMN cv_url TEXT DEFAULT ''"); } catch (_) {}
  try { db.run("ALTER TABLE users ADD COLUMN selected_mode TEXT DEFAULT 'jobber'"); } catch (_) {}
  try { db.run("ALTER TABLE users ADD COLUMN mode_confirmed INTEGER DEFAULT 0"); } catch (_) {}
  try { db.run("ALTER TABLE users ADD COLUMN telegram_id TEXT DEFAULT ''"); } catch (_) {}
  try { db.run("ALTER TABLE users ADD COLUMN telegram_username TEXT DEFAULT ''"); } catch (_) {}
  try { db.run("ALTER TABLE email_verifications ADD COLUMN username TEXT DEFAULT ''"); } catch (_) {}
  try { db.run("ALTER TABLE email_verifications ADD COLUMN referrer_email TEXT DEFAULT NULL"); } catch (_) {}
  try { db.run("ALTER TABLE jobs ADD COLUMN description TEXT DEFAULT ''"); } catch (_) {}
  save();
}

async function initTursoDb() {
  console.log(`Connecting to Turso Cloud at ${TURSO_DATABASE_URL}`);
  const { connect } = require('@tursodatabase/serverless');
  db = await connect({
    url: TURSO_DATABASE_URL,
    authToken: TURSO_AUTH_TOKEN,
    remoteEncryptionKey: TURSO_REMOTE_ENCRYPTION_KEY,
  });
  usingTurso = true;
  await createSchema();
  try { await db.run("ALTER TABLE users ADD COLUMN wallet_address TEXT DEFAULT ''"); } catch (_) {}
  try { await db.run("ALTER TABLE users ADD COLUMN cv_url TEXT DEFAULT ''"); } catch (_) {}
  try { await db.run("ALTER TABLE users ADD COLUMN selected_mode TEXT DEFAULT 'jobber'"); } catch (_) {}
  try { await db.run("ALTER TABLE users ADD COLUMN mode_confirmed INTEGER DEFAULT 0"); } catch (_) {}
}

function save() {
  if (!usingTurso) {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
}

function getDb() {
  if (!db) throw new Error('DB not initialised — call await initDb() first');
  return dbProxy;
}

async function initDb() {
  if (TURSO_DATABASE_URL && TURSO_AUTH_TOKEN) {
    await initTursoDb();
  } else {
    await initSqlJs();
    loadOrCreate();
  }
}

function runQuery(sql, params = []) {
  const normalized = normaliseParams(params);
  if (usingTurso) {
    return db.run(sql, ...normalized);
  }
  db.run(sql, normalized);
  save();
}

async function getQuery(sql, params = []) {
  const normalized = normaliseParams(params);
  if (usingTurso) {
    return await db.get(sql, ...normalized);
  }
  const stmt = db.prepare(sql);
  stmt.bind(normalized);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

async function allQuery(sql, params = []) {
  const normalized = normaliseParams(params);
  if (usingTurso) {
    return await db.all(sql, ...normalized);
  }
  const stmt = db.prepare(sql);
  const rows = [];
  stmt.bind(normalized);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function execQuery(sql) {
  if (usingTurso) {
    return await db.run(sql);
  }
  db.run(sql);
  save();
}

function normaliseParams(params) {
  if (!params || params.length === 0) return [];
  return Array.isArray(params) ? params : [params];
}

function transaction(fn) {
  if (usingTurso) {
    return db.transaction(fn);
  }
  return async function (...args) {
    const result = await fn(...args);
    save();
    return result;
  };
}

const dbProxy = {
  prepare: (sql) => ({
    run: (...params) => runQuery(sql, params.flat()),
    get: (...params) => getQuery(sql, params.flat()),
    all: (...params) => allQuery(sql, params.flat()),
    bind: () => {},
  }),
  get: (sql, ...params) => getQuery(sql, params),
  all: (sql, ...params) => allQuery(sql, params),
  run: (sql, ...params) => runQuery(sql, params),
  exec: execQuery,
  transaction: transaction,
};

function createSchema() {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
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
      mode_confirmed INTEGER DEFAULT 0,
      created_date TEXT DEFAULT (datetime('now')),
      updated_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
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
      extension_requested INTEGER DEFAULT 0,
      extension_hours REAL DEFAULT 0,
      extension_reason TEXT DEFAULT '',
      extension_status TEXT DEFAULT 'pending',
      last_activity_date TEXT DEFAULT (datetime('now')),
      escrow_funded INTEGER DEFAULT 0,
      escrow_tx_hash TEXT DEFAULT '',
      escrow_error TEXT,
      jobber_wallet TEXT,
      escrow_taken INTEGER DEFAULT 0,
      escrow_release_pending INTEGER DEFAULT 0,
      escrow_released INTEGER DEFAULT 0,
      created_date TEXT DEFAULT (datetime('now')),
      updated_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kpis (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      name TEXT NOT NULL,
      target_value TEXT DEFAULT '',
      weight REAL DEFAULT 0,
      baseline TEXT DEFAULT '',
      is_primary INTEGER DEFAULT 0,
      status TEXT DEFAULT 'not_started',
      completion_percent REAL DEFAULT 0,
      created_date TEXT DEFAULT (datetime('now')),
      updated_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      applicant_email TEXT NOT NULL,
      applicant_username TEXT DEFAULT '',
      proposal TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      application_type TEXT DEFAULT 'manual',
      is_pod INTEGER DEFAULT 0,
      pod_name TEXT,
      pod_members TEXT DEFAULT '[]',
      performance_snapshot TEXT DEFAULT '{}',
      created_date TEXT DEFAULT (datetime('now')),
      updated_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS proof_submissions (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      kpi_id TEXT NOT NULL,
      submitter_email TEXT NOT NULL,
      proof_link TEXT DEFAULT '',
      metric_achieved TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      rejection_reason TEXT,
      created_date TEXT DEFAULT (datetime('now')),
      updated_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      sender_username TEXT DEFAULT '',
      content TEXT NOT NULL,
      created_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT DEFAULT '',
      message TEXT DEFAULT '',
      job_id TEXT,
      is_read INTEGER DEFAULT 0,
      created_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      required_action TEXT DEFAULT '',
      required_keyword TEXT DEFAULT '',
      xp_reward INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_date TEXT DEFAULT (datetime('now')),
      updated_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_submissions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      proof_link TEXT DEFAULT '',
      status TEXT DEFAULT 'approved',
      xp_awarded INTEGER DEFAULT 0,
      created_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS xp_logs (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      source TEXT NOT NULL,
      xp_amount INTEGER DEFAULT 0,
      label TEXT DEFAULT '',
      reference_id TEXT,
      created_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referrer_email TEXT NOT NULL,
      referred_email TEXT NOT NULL,
      created_date TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      verification_code TEXT NOT NULL,
      full_name TEXT,
      password_hash TEXT,
      username TEXT DEFAULT '',
      referrer_email TEXT DEFAULT NULL,
      expires_at TEXT NOT NULL,
      created_date TEXT DEFAULT (datetime('now'))
    );
  `;

  if (usingTurso) {
    return db.exec(schema);
  }

  db.run(schema);
}

module.exports = { initDb, getDb };