const express = require('express');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { makeToken, sanitizeUser } = require('./authHelpers');

const router = express.Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.warn('[googleAuth] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET environment variables');
}

passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: `${BACKEND_URL}/api/auth/google/callback`,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value;
    const fullName = profile.displayName || `${profile.name?.givenName || ''} ${profile.name?.familyName || ''}`.trim();

    if (!email) {
      return done(new Error('Google account did not return an email')); 
    }

    const db = getDb();
    let user = await db.get('SELECT * FROM users WHERE email = ?', email);
    const now = new Date().toISOString();

    if (!user) {
      const baseUsername = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() || `user${uuidv4().slice(0, 4)}`;
      const usernameTaken = await db.get('SELECT id FROM users WHERE username = ?', baseUsername);
      const username = usernameTaken ? `${baseUsername}_${uuidv4().slice(0, 4)}` : baseUsername;
      const referral_code = uuidv4().slice(0, 8).toUpperCase();
      const id = uuidv4();

      await db.run(`INSERT INTO users (id, email, password_hash, full_name, username, referral_code, top_categories, created_date, updated_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, email, '', fullName || '', username, referral_code, '[]', now, now);

      user = await db.get('SELECT * FROM users WHERE id = ?', id);
    } else {
      await db.run('UPDATE users SET last_login_date = ?, updated_date = ? WHERE id = ?', now, now, user.id);
      user = await db.get('SELECT * FROM users WHERE id = ?', user.id);
    }

    done(null, user);
  } catch (error) {
    done(error);
  }
}));

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/google/callback', passport.authenticate('google', {
  session: false,
  failureRedirect: `${FRONTEND_URL}/auth/callback?error=google_failed`,
}), (req, res) => {
  if (!req.user) {
    return res.redirect(`${FRONTEND_URL}/auth/callback?error=google_no_user`);
  }

  const token = makeToken(req.user);
  res.redirect(`${FRONTEND_URL}/auth/callback?token=${encodeURIComponent(token)}`);
});

module.exports = router;
