const express = require('express');
const cors = require('cors');
const { initDb } = require('./database');
const authRouter = require('./routes/auth');
const {
  jobsRouter, kpisRouter, applicationsRouter, proofSubRouter,
  chatRouter, notifRouter, tasksRouter, taskSubRouter,
  xpLogsRouter, referralsRouter, usersRouter, uploadsRouter, aiRouter,
} = require('./routes/entities');

const app = express();

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://apexium-three.vercel.app"
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/kpis', kpisRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/proof-submissions', proofSubRouter);
app.use('/api/chat-messages', chatRouter);
app.use('/api/notifications', notifRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/task-submissions', taskSubRouter);
app.use('/api/xp-logs', xpLogsRouter);
app.use('/api/referrals', referralsRouter);
app.use('/api/users', usersRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/ai', aiRouter);

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
