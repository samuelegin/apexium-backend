const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { buildEntityRouter } = require('./entityRouter');
const { authMiddleware } = require('../middleware/auth');
const { getDb } = require('../database');
const { applyJobCompletionEffects } = require('../escrowEffects');


const jobsCrud = buildEntityRouter('jobs', {
  beforeUpdate: async (db, id, data, req, existing) => {
    if (data.status === 'in_progress' && existing.status !== 'in_progress') {
      // Enforce wallet(s) connected — and, for a pod, a fully-approved payout
      // split — before a job can move to "ready to fund". The contract has
      // no on-chain pod negotiation anymore (split is locked in at fundJob
      // time), so this backend check is the ONLY gate left preventing an
      // employer from funding with a split nobody actually agreed to.
      if (!data.selected_applicant_email && !existing.selected_applicant_email) {
        const err = new Error('Must select an applicant before starting the job.');
        err.statusCode = 400;
        throw err;
      }

      const jobberEmail = data.selected_applicant_email || existing.selected_applicant_email;
      const application = await db.get(
        `SELECT * FROM applications WHERE job_id = ? AND applicant_email = ? ORDER BY created_date DESC LIMIT 1`,
        id, jobberEmail
      );

      if (application && application.is_pod) {
        let podMembers;
        try { podMembers = JSON.parse(application.pod_members || '[]'); } catch { podMembers = []; }

        if (podMembers.length === 0) {
          const err = new Error('Pod has no members on file.');
          err.statusCode = 400;
          throw err;
        }
        for (const member of podMembers) {
          if (!member.wallet_address || member.wallet_address.trim() === '') {
            const err = new Error(`Pod member ${member.email} has not connected a wallet. Please ask them to connect before starting the job.`);
            err.statusCode = 400;
            throw err;
          }
        }
        const allApproved = podMembers.length > 0 && podMembers.every(m => m.approved === true);
        if (!allApproved) {
          const err = new Error('All pod members must approve the payout split before the job can start. Propose and collect approvals first.');
          err.statusCode = 400;
          throw err;
        }
      } else {
        const jobber = await db.get('SELECT wallet_address FROM users WHERE email = ?', jobberEmail);
        if (!jobber || !jobber.wallet_address || jobber.wallet_address.trim() === '') {
          const err = new Error(`Selected jobber ${jobberEmail} has not connected a wallet. Please select another applicant.`);
          err.statusCode = 400;
          throw err;
        }
      }
    }

    if (data.status === 'completed' && existing.status !== 'completed') {
      await applyJobCompletionEffects(db, { ...existing, ...data, id });
    }
  },
  beforeDelete: async (db, id, req, existing) => {
    // Drafts (pre-funding) must be deletable too — the frontend's delete
    // button is shown for both 'open' and 'draft' jobs, but this only ever
    // allowed 'open', so every draft delete attempt 403'd silently.
    if (existing.status !== 'open' && existing.status !== 'draft') {
      const err = new Error('Cannot delete a job that is in progress or completed');
      err.statusCode = 403;
      throw err;
    }
  },
});

const jobsRouter = express.Router();

// NOTE: no custom GET '/' here anymore. Under the old design, jobs were
// funded at posting time, so "not funded" meant "creation failed, hide it".
// Now funding happens later at talent-selection time — every open job is
// escrow_funded=false by design — so listing falls through to jobsCrud's
// generic, ungated GET '/' below (jobsRouter.use(jobsCrud)).

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
        WHERE user_email = ? AND source = 'daily_login' AND created_date::date = ?::date
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

const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

// Cloudinary config — set CLOUDINARY_URL in env (format: cloudinary://api_key:api_secret@cloud_name)
cloudinary.config({ secure: true });

// Use memory storage — no files written to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`File type not allowed: ${file.mimetype}`));
  },
});

// Upload buffer to Cloudinary via stream
function uploadToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
    Readable.from(buffer).pipe(stream);
  });
}

const uploadsRouter = express.Router();
uploadsRouter.post('/', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  try {
    // Determine upload type from query param: ?type=avatar | cv | proof (default: general)
    const uploadType = req.query.type || 'general';
    const isImage    = req.file.mimetype.startsWith('image/');

    const cloudinaryOptions = {
      folder:         `apexium/${uploadType}`,
      resource_type:  isImage ? 'image' : 'raw',
      public_id:      `${req.user.id}_${Date.now()}`,
      // Auto-optimize images
      ...(isImage && {
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      }),
    };

    const result  = await uploadToCloudinary(req.file.buffer, cloudinaryOptions);
    const fileUrl = result.secure_url;

    const db  = getDb();
    const now = new Date().toISOString();

    if (uploadType === 'avatar') {
      await db.run('UPDATE users SET avatar_url = ?, updated_date = ? WHERE id = ?', fileUrl, now, req.user.id);
    } else if (uploadType === 'cv') {
      await db.run('UPDATE users SET cv_url = ?, updated_date = ? WHERE id = ?', fileUrl, now, req.user.id);
    }

    const updated = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    return res.json({ file_url: fileUrl, user: updated });

  } catch (err) {
    console.error('[uploads] Cloudinary error', err);
    return res.status(500).json({ message: err.message || 'Upload failed' });
  }
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