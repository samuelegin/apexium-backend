const express        = require('express');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../database');
const { makeToken }  = require('./authHelpers');

const router = express.Router();

// ── Configure Google Strategy ─────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  `${process.env.API_BASE_URL || 'http://localhost:3000/api'}/auth/google/callback`,
  proxy:        true,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const db    = getDb();
    const email = profile.emails?.[0]?.value;
    if (!email) return done(new Error('No email from Google'), null);

    // Check if user already exists
    let user = await db.get('SELECT * FROM users WHERE email = ?', email);

    if (!user) {
      // Create new account — no password, no email verification needed
      const id            = uuidv4();
      const now           = new Date().toISOString();
      const full_name     = profile.displayName || '';
      const avatar_url    = profile.photos?.[0]?.value || '';
      const referral_code = uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase();
      // Generate a username from their name
      const baseUsername  = full_name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
      // Make username unique by appending random digits if taken
      let username = baseUsername;
      const taken  = await db.get('SELECT id FROM users WHERE username = ?', username);
      if (taken) username = baseUsername + Math.floor(1000 + Math.random() * 9000);

      await db.run(
        `INSERT INTO users (id, email, password_hash, full_name, username, avatar_url, referral_code, role, xp_total, top_categories, created_date, updated_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 0, '[]', ?, ?)`,
        [id, email, '', full_name, username, avatar_url, referral_code, now, now]
      );

      user = await db.get('SELECT * FROM users WHERE id = ?', id);
      console.log(`[google-auth] New account created: ${email}`);
    } else {
      console.log(`[google-auth] Existing user logged in: ${email}`);
    }

    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

// ── Routes ────────────────────────────────────────────────────────────────────

// Step 1 — redirect user to Google
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  session: false,
}));

// Step 2 — Google redirects back here
router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: `${process.env.FRONTEND_URL}/login?error=google_failed` }),
  (req, res) => {
    // Generate JWT and redirect to frontend with token in URL
    const token = makeToken(req.user);
    // Frontend reads this token from URL and stores it
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${token}`);
  }
);

module.exports = router;
