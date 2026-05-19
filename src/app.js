const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const passport   = require('passport');
const path       = require('path');
const fs         = require('fs');
const { initDb } = require('./database');
const authRouter         = require('./routes/auth');
const googleAuthRouter   = require('./routes/googleAuth');
const telegramAuthRouter = require('./routes/telegramAuth');
const discordAuthRouter  = require('./routes/discordAuth');
const {
  jobsRouter, kpisRouter, applicationsRouter, proofSubRouter,
  chatRouter, notifRouter, tasksRouter, taskSubRouter,
  xpLogsRouter, referralsRouter, usersRouter, uploadsRouter, aiRouter,
} = require('./routes/entities');

const {
  authLimiter,
  jobPostLimiter,
  applicationLimiter,
  proofLimiter,
  uploadLimiter,
  aiLimiter,
  generalLimiter,
} = require('./middleware/rateLimiter');

const app = express();
app.set('trust proxy', 1);

/* ── Security headers ───────────────────────────────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://telegram.org'],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:        ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:         ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc:     ["'self'", 'https:', 'wss:'],
      frameSrc:       ["'self'", 'https://verify.walletconnect.com', 'https://verify.walletconnect.org', 'https://oauth.telegram.org'],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const allowedOrigins = [
  'http://localhost:5173',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(passport.initialize());

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

/* ── Write-only rate limiter middleware ─────────────────────────────────────── */
// Applies a limiter ONLY on mutating methods (POST, PATCH, PUT, DELETE)
// GET requests are never rate-limited so reads always work
function writeOnly(limiter) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    return limiter(req, res, next);
  };
}

/* ── Auth ───────────────────────────────────────────────────────────────────── */
app.use('/api/auth', authLimiter,        authRouter);
app.use('/api/auth', authLimiter,        googleAuthRouter);
app.use('/api/auth', authLimiter,        telegramAuthRouter);
app.use('/api/auth', authLimiter,        discordAuthRouter);

/* ── Entity routes — writes rate limited, reads always free ─────────────────── */
app.use('/api/jobs',              writeOnly(jobPostLimiter),     jobsRouter);
app.use('/api/kpis',              writeOnly(generalLimiter),     kpisRouter);
app.use('/api/applications',      writeOnly(applicationLimiter), applicationsRouter);
app.use('/api/proof-submissions', writeOnly(proofLimiter),       proofSubRouter);
app.use('/api/chat-messages',     writeOnly(generalLimiter),     chatRouter);
app.use('/api/notifications',     writeOnly(generalLimiter),     notifRouter);
app.use('/api/tasks',             writeOnly(generalLimiter),     tasksRouter);
app.use('/api/task-submissions',  writeOnly(applicationLimiter), taskSubRouter);
app.use('/api/xp-logs',           writeOnly(generalLimiter),     xpLogsRouter);
app.use('/api/referrals',         writeOnly(generalLimiter),     referralsRouter);
app.use('/api/users',             writeOnly(generalLimiter),     usersRouter);
app.use('/api/uploads',           writeOnly(uploadLimiter),      uploadsRouter);
app.use('/api/ai',                aiLimiter,                     aiRouter); // AI always limited

app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.use((req, res) => res.status(404).json({ message: `${req.method} ${req.path} not found` }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

async function createApp() {
  await initDb();
  return app;
}

module.exports = { createApp };
