const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { buildEntityRouter } = require('./entityRouter');
const { authMiddleware } = require('../middleware/auth');
const { getDb } = require('../database');

function boolsToBool(row, boolFields) {
  if (!row) return row;
  const out = { ...row };
  for (const field of boolFields) {
    if (out[field] !== undefined) out[field] = out[field] === 1 || out[field] === true;
  }
  return out;
}

async function recalcJobberPiScore(db, job) {
  const jobberEmail = job.selected_applicant_email;
  if (!jobberEmail) return;

  const kpis = await db.all('SELECT weight, completion_percent FROM kpis WHERE job_id = ?', job.id);
  const jobPiScore = kpis.reduce((sum, k) => sum + (k.completion_percent * k.weight / 100), 0);

  const prevCompleted = await db.all(`
    SELECT id FROM jobs
    WHERE selected_applicant_email = ? AND status = 'completed' AND id != ?
  `, jobberEmail, job.id);

  let totalPi = jobPiScore;
  for (const prev of prevCompleted) {
    const prevKpis = await db.all('SELECT weight, completion_percent FROM kpis WHERE job_id = ?', prev.id);
    totalPi += prevKpis.reduce((sum, k) => sum + (k.completion_percent * k.weight / 100), 0);
  }

  const jobCount = prevCompleted.length + 1;
  const newAverage = Math.round((totalPi / jobCount) * 10) / 10;

  await db.run(`
    UPDATE users
    SET average_pi_score = ?,
        total_jobs_completed = total_jobs_completed + 1,
        updated_date = ?
    WHERE email = ?
  `, newAverage, new Date().toISOString(), jobberEmail);

  const xpAmount = 500;
  const xpId = uuidv4();
  await db.run(`INSERT INTO xp_logs (id, user_email, source, xp_amount, label, reference_id, created_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, xpId, jobberEmail, 'job_completed', xpAmount, `Job completed: ${job.title || job.id}`, job.id, new Date().toISOString());
  await db.run('UPDATE users SET xp_total = xp_total + ? WHERE email = ?', xpAmount, jobberEmail);

  console.log(`[PI] Job ${job.id} completed — jobber ${jobberEmail} new avg PI: ${newAverage} (${jobCount} jobs)`);
}

const BOOL_JOB = ['escrow_funded','escrow_taken','escrow_release_pending','escrow_released','extension_requested'];
function deserializeJob(r) {
  const out = { ...r };
  for (const b of BOOL_JOB) out[b] = out[b] === 1 || out[b] === true;
  return out;
}

const jobsCrud = buildEntityRouter('jobs', {
  beforeUpdate: async (db, id, data, req, existing) => {
    if (data.status === 'in_progress' && existing.status !== 'in_progress') {
      // Enforce wallet when transitioning to in_progress
      if (!data.selected_applicant_email && !existing.selected_applicant_email) {
        const err = new Error('Must select an applicant before starting the job.');
        err.statusCode = 400;
        throw err;
      }

      const jobberEmail = data.selected_applicant_email || existing.selected_applicant_email;
      const jobber = await db.get('SELECT wallet_address FROM users WHERE email = ?', jobberEmail);
      if (!jobber || !jobber.wallet_address || jobber.wallet_address.trim() === '') {
        const err = new Error(`Selected jobber ${jobberEmail} has not connected a wallet. Please select another applicant.`);
        err.statusCode = 400;
        throw err;
      }
    }

    if (data.status === 'completed' && existing.status !== 'completed') {
      data.escrow_release_pending = 1;
      await recalcJobberPiScore(db, { ...existing, ...data, id });
    }
  },
  beforeDelete: async (db, id, req, existing) => {
    if (existing.status !== 'open') {
      const err = new Error('Cannot delete a job that is in progress or completed');
      err.statusCode = 403;
      throw err;
    }
  },
});

const jobsRouter = express.Router();

jobsRouter.get('/pending-release', authMiddleware, async (req, res) => {
  const rows = await getDb().all(`SELECT * FROM jobs WHERE escrow_release_pending = 1 AND escrow_released = 0 ORDER BY updated_date DESC`);
  res.json(rows.map(deserializeJob));
});

jobsRouter.get('/', authMiddleware, async (req, res) => {
  const db = getDb();
  const { _sort, _limit, ...filters } = req.query;
  let sql = `SELECT * FROM jobs WHERE escrow_funded = 1`;
  const params = [];
  for (const [k, v] of Object.entries(filters)) {
    sql += ` AND \`${k}\` = ?`;
    params.push(v);
  }
  if (_sort) {
    const desc = _sort.startsWith('-');
    sql += ` ORDER BY \`${desc ? _sort.slice(1) : _sort}\` ${desc ? 'DESC' : 'ASC'}`;
  } else {
    sql += ` ORDER BY created_date DESC`;
  }
  if (_limit) sql += ` LIMIT ${parseInt(_limit)}`;
  const rows = await db.all(sql, ...params);
  res.json(rows.map(r => deserializeJob(r)));
});

jobsRouter.delete('/cleanup-unfunded/:id', authMiddleware, async (req, res) => {
  const db = getDb();
  const job = await db.get('SELECT * FROM jobs WHERE id = ?', req.params.id);
  if (!job) return res.status(404).json({ message: 'Not found' });
  if (job.employer_email !== req.user.email) return res.status(403).json({ message: 'Forbidden' });
  if (job.escrow_funded) return res.status(400).json({ message: 'Job is funded — cannot delete' });
  await db.run('DELETE FROM kpis WHERE job_id = ?', job.id);
  await db.run('DELETE FROM jobs WHERE id = ?', job.id);
  res.status(204).end();
});

jobsRouter.use(jobsCrud);

const kpisRouter = buildEntityRouter('kpis');
const applicationsRouter = buildEntityRouter('applications', {
  beforeCreate: async (db, data) => {
    const existing = await db.get('SELECT id FROM applications WHERE job_id = ? AND applicant_email = ?', data.job_id, data.applicant_email);
    if (existing) {
      const err = new Error('You have already applied to this job.');
      err.statusCode = 409;
      throw err;
    }

    // Enforce wallet connection before applying
    const applicant = await db.get('SELECT wallet_address FROM users WHERE email = ?', data.applicant_email);
    if (!applicant || !applicant.wallet_address || applicant.wallet_address.trim() === '') {
      const err = new Error('You must connect a wallet before applying for jobs.');
      err.statusCode = 403;
      throw err;
    }
  },
});
const proofSubRouter = buildEntityRouter('proof_submissions', {
  afterCreate: async (db, data) => {
    if (data.submitter_email) {
      const xpAmount = 15;
      const xpId = uuidv4();
      await db.run(`INSERT INTO xp_logs (id, user_email, source, xp_amount, label, reference_id, created_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, xpId, data.submitter_email, 'proof_submitted', xpAmount, `Proof submitted for KPI`, data.kpi_id, new Date().toISOString());
      await db.run('UPDATE users SET xp_total = xp_total + ? WHERE email = ?', xpAmount, data.submitter_email);
    }
  },
});
const chatRouter = buildEntityRouter('chat_messages');
const notifRouter = buildEntityRouter('notifications');
const tasksRouter = buildEntityRouter('tasks');
const taskSubRouter = buildEntityRouter('task_submissions', {
  afterCreate: async (db, data) => {
    if (data.status === 'approved' && data.xp_awarded && data.user_email) {
      const xpId = uuidv4();
      await db.run(`INSERT INTO xp_logs (id, user_email, source, xp_amount, label, reference_id, created_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, xpId, data.user_email, 'task_completed', Number(data.xp_awarded), `Task completed`, data.task_id, new Date().toISOString());
      await db.run('UPDATE users SET xp_total = xp_total + ? WHERE email = ?', Number(data.xp_awarded), data.user_email);
    }
  },
});
const referralsRouter = buildEntityRouter('referrals');
const usersRouter = buildEntityRouter('users');

const xpLogsRouter = buildEntityRouter('xp_logs', {
  beforeCreate: async (db, data) => {
    if (data.source === 'daily_login' && data.user_email) {
      const today = new Date().toISOString().split('T')[0];
      const existing = await db.get(`
        SELECT id FROM xp_logs
        WHERE user_email = ? AND source = 'daily_login' AND DATE(created_date) = ?
      `, data.user_email, today);
      if (existing) {
        console.log(`[XP] Daily login already awarded today for ${data.user_email}`);
        const err = new Error('Daily login XP already claimed today');
        err.statusCode = 409;
        throw err;
      }
    }
  },
  afterCreate: async (db, data) => {
    if (data.user_email && data.xp_amount) {
      await db.run('UPDATE users SET xp_total = xp_total + ? WHERE email = ?', Number(data.xp_amount), data.user_email);
    }
  },
});

const path = require('path');
const fs = require('fs');
const multer = require('multer');

const uploadDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname) || '';
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({ storage });

const uploadsRouter = express.Router();
uploadsRouter.post('/', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  try {
    const db = getDb();
    if (req.user && req.user.id) {
      await db.run('UPDATE users SET avatar_url = ?, updated_date = ? WHERE id = ?', fileUrl, new Date().toISOString(), req.user.id);
      const updated = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
      return res.json({ file_url: fileUrl, user: updated });
    }
  } catch (err) {
    console.error('[uploads] failed to persist avatar_url', err);
  }

  res.json({ file_url: fileUrl });
});

const aiRouter = express.Router();
aiRouter.post('/proposal', authMiddleware, (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ message: 'prompt is required' });
  res.json({
    text: `I am the ideal candidate for this role. ${prompt.slice(0, 120)} — my track record speaks for itself, and I am confident I will exceed your KPI targets.`,
  });
});

module.exports = {
  jobsRouter,
  kpisRouter,
  applicationsRouter,
  proofSubRouter,
  chatRouter,
  notifRouter,
  tasksRouter,
  taskSubRouter,
  xpLogsRouter,
  referralsRouter,
  usersRouter,
  uploadsRouter,
  aiRouter,
};