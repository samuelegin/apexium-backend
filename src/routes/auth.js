const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');
const { sendVerificationEmail } = require('../emailService');

const router = express.Router();

function sanitizeUser(row) {
  if (!row) return null;
  const out = { ...row };
  delete out.password_hash;
  try { out.top_categories = JSON.parse(out.top_categories || '[]'); } catch { out.top_categories = []; }
  return out;
}

function makeToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

router.post('/register', async (req, res) => {
  const { email, password, full_name, username, referral_code } = req.body;
  if (!email || !password || !full_name) {
    return res.status(400).json({ message: 'email, password, and full_name required' });
  }

  const normalizedUsername = username ? String(username).trim().toLowerCase() : '';
  if (!normalizedUsername || !/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
    return res.status(400).json({ message: 'username must be 3-30 characters and contain only letters, numbers, or underscores' });
  }

  const db = getDb();
  const existingUser = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (existingUser) {
    return res.status(422).json({ message: 'Email already registered' });
  }

  const existingUsername = await db.get('SELECT id FROM users WHERE username = ?', normalizedUsername);
  if (existingUsername) {
    return res.status(422).json({ message: 'Username already taken' });
  }

  let referrer = null;
  if (referral_code) {
    referrer = await db.get('SELECT id, email FROM users WHERE referral_code = ?', referral_code.trim().toUpperCase());
    if (!referrer) {
      return res.status(400).json({ message: 'Invalid referral code' });
    }
  }

  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const existingVerification = await db.get('SELECT id FROM email_verifications WHERE email = ?', email);
  if (existingVerification) {
    await db.run('UPDATE email_verifications SET verification_code = ?, expires_at = ?, created_date = ? WHERE email = ?', verificationCode, expiresAt, now, email);
  } else {
    await db.run('INSERT INTO email_verifications (id, email, verification_code, expires_at) VALUES (?, ?, ?, ?)', uuidv4(), email, verificationCode, expiresAt);
  }

  const emailSent = await sendVerificationEmail(email, verificationCode);
  if (!emailSent) {
    return res.status(500).json({ message: 'Failed to send verification email' });
  }

  await db.run('UPDATE email_verifications SET full_name = ?, password_hash = ?, username = ?, referrer_email = ? WHERE email = ?', full_name, bcrypt.hashSync(password, 10), normalizedUsername, referrer?.email || null, email);

  res.status(200).json({
    message: 'Verification code sent to your email',
    email,
  });
});

router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'email required' });

  const db = getDb();
  const verification = await db.get('SELECT * FROM email_verifications WHERE email = ?', email);
  if (!verification) {
    return res.status(400).json({ message: 'No pending verification found for this email' });
  }

  if (new Date() > new Date(verification.expires_at)) {
    return res.status(400).json({ message: 'Verification code has expired. Please register again.' });
  }

  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await db.run('UPDATE email_verifications SET verification_code = ?, expires_at = ? WHERE email = ?', verificationCode, expiresAt, email);
  const emailSent = await sendVerificationEmail(email, verificationCode);
  if (!emailSent) {
    return res.status(500).json({ message: 'Failed to send verification email' });
  }

  res.json({ message: 'Verification code resent' });
});

router.post('/verify-email', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ message: 'email and code required' });

  const db = getDb();
  const verification = await db.get('SELECT * FROM email_verifications WHERE email = ? AND verification_code = ?', email, code);
  if (!verification) {
    return res.status(400).json({ message: 'Invalid verification code' });
  }

  if (new Date() > new Date(verification.expires_at)) {
    return res.status(400).json({ message: 'Verification code has expired' });
  }

  const existingUser = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (existingUser) {
    await db.run('DELETE FROM email_verifications WHERE email = ?', email);
    return res.status(422).json({ message: 'Email already registered' });
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const finalUsername = verification.username || email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() || `user${id.slice(0, 4)}`;
  const usernameTaken = await db.get('SELECT id FROM users WHERE username = ?', finalUsername);
  const username = usernameTaken ? `${finalUsername}_${id.slice(0, 4)}` : finalUsername;
  const referral_code = uuidv4().slice(0, 8).toUpperCase();

  await db.run(`INSERT INTO users (id,email,password_hash,full_name,username,referral_code,top_categories,created_date,updated_date)
    VALUES (?,?,?,?,?,?,?,?,?)`, id, email, verification.password_hash, verification.full_name, username, referral_code, '[]', now, now);

  if (verification.referrer_email) {
    const referralSignupXp = 100;
    const xpId = uuidv4();
    await db.run(`INSERT INTO xp_logs (id, user_email, source, xp_amount, label, reference_id, created_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, xpId, verification.referrer_email, 'referral_signup', referralSignupXp, `Referral signup bonus`, id, now);
    await db.run('UPDATE users SET xp_total = xp_total + ? WHERE email = ?', referralSignupXp, verification.referrer_email);
    const refId = uuidv4();
    await db.run(`INSERT INTO referrals (id, referrer_email, referred_email, created_date)
      VALUES (?, ?, ?, ?)`, refId, verification.referrer_email, email, now);
  }

  await db.run('DELETE FROM email_verifications WHERE email = ?', email);

  const user = await db.get('SELECT * FROM users WHERE id = ?', id);
  res.status(201).json({ token: makeToken(user), user: sanitizeUser(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'email and password required' });

  const db = getDb();
  const user = await db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  await db.run('UPDATE users SET last_login_date = ?, updated_date = ? WHERE id = ?', new Date().toISOString(), new Date().toISOString(), user.id);
  const refreshed = await db.get('SELECT * FROM users WHERE id = ?', user.id);
  res.json({ token: makeToken(refreshed), user: sanitizeUser(refreshed) });
});

router.post('/logout', authMiddleware, (req, res) => res.status(204).end());

router.get('/me', authMiddleware, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const user = await getDb().get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!user) return res.status(404).json({ message: 'Not found' });
  res.json(sanitizeUser(user));
});

router.patch('/me', authMiddleware, async (req, res) => {
  const db = getDb();
  const allowed = ['full_name', 'username', 'bio', 'avatar_url', 'x_handle', 'top_categories', 'wallet_address', 'last_login_date', 'cv_url', 'selected_mode', 'mode_confirmed', 'telegram_id', 'telegram_username', 'discord_id', 'discord_username'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates[key] = key === 'top_categories' ? JSON.stringify(req.body[key]) : req.body[key];
    }
  }
  updates.updated_date = new Date().toISOString();
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await db.run(`UPDATE users SET ${sets} WHERE id = ?`, ...Object.values(updates), req.user.id);
  const updatedUser = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json(sanitizeUser(updatedUser));
});

router.post('/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'email required' });
  console.log(`[auth] Forgot password requested for: ${email}`);
  res.json({ message: 'If that email is registered, a reset link has been sent.' });
});

module.exports = router;
module.exports.makeToken = makeToken;