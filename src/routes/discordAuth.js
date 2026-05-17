const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { makeToken } = require('./authHelpers');

const router = express.Router();

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

console.log('[discordAuth] config', {
  hasClientId: Boolean(DISCORD_CLIENT_ID),
  hasClientSecret: Boolean(DISCORD_CLIENT_SECRET),
  FRONTEND_URL,
  BACKEND_URL,
});

async function handleDiscordCallback(req, res) {
  const origin = req.query?.origin || req.body?.origin;
  const callbackType = req.query?.callback_type || req.body?.callback_type;
  const code = req.query?.code || req.body?.code;
  const stateStr = req.query?.state || req.body?.state;

  if (!code) return res.status(400).send('Missing authorization code');
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    return res.status(500).send('Server misconfigured (missing Discord credentials)');
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${BACKEND_URL}/api/auth/discord/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      console.error('[discordAuth] token exchange failed', tokenResponse.status);
      return res.status(401).send('Failed to exchange code for token');
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Get user info from Discord
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userResponse.ok) {
      console.error('[discordAuth] user fetch failed', userResponse.status);
      return res.status(401).send('Failed to fetch user info from Discord');
    }

    const discordUser = await userResponse.json();
    const discordId = String(discordUser.id);
    const discordUsername = discordUser.username || '';

    const db = getDb();
    const now = new Date().toISOString();
    const redirectOrigin = origin || FRONTEND_URL;

    // Profile connection mode: update existing user
    if (callbackType === 'profile' && stateStr) {
      let userIdToUpdate;
      try {
        const stateData = JSON.parse(stateStr);
        userIdToUpdate = stateData.user_id;
      } catch (_) {
        userIdToUpdate = stateStr;
      }

      if (userIdToUpdate) {
        // Update the existing user with Discord info
        await db.run('UPDATE users SET discord_id = ?, discord_username = ?, updated_date = ? WHERE id = ?', 
          discordId, discordUsername, now, userIdToUpdate);
        const redirectTarget = `${redirectOrigin.replace(/\/$/, '')}/auth/callback?discord_id=${encodeURIComponent(discordId)}&discord_username=${encodeURIComponent(discordUsername)}`;
        return res.redirect(redirectTarget);
      }
    }

    // Standard login/registration mode
    let user = await db.get('SELECT * FROM users WHERE discord_id = ? OR discord_username = ?', discordId, discordUsername);

    if (!user) {
      // Create a new user
      const baseUsername = (discordUsername || (`discord_${discordUser.global_name || 'user'}${(Math.random()*10000|0)}`)).toString().replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
      const usernameTaken = await db.get('SELECT id FROM users WHERE username = ?', baseUsername);
      const username = usernameTaken ? `${baseUsername}_${uuidv4().slice(0,4)}` : baseUsername;
      const id = uuidv4();
      const syntheticEmail = `discord_${discordId}@no-reply.apexium`;
      const referral_code = uuidv4().slice(0,8).toUpperCase();

      await db.run(`INSERT INTO users (id,email,password_hash,full_name,username,referral_code,top_categories,created_date,updated_date,discord_id,discord_username)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, syntheticEmail, '', discordUser.global_name || discordUsername, username, referral_code, '[]', now, now, discordId, discordUsername);

      user = await db.get('SELECT * FROM users WHERE id = ?', id);
    } else {
      await db.run('UPDATE users SET last_login_date = ?, updated_date = ? WHERE id = ?', now, now, user.id);
      user = await db.get('SELECT * FROM users WHERE id = ?', user.id);
    }

    // Standard login mode: return JWT token
    const token = makeToken(user);
    const redirectTarget = `${redirectOrigin.replace(/\/$/, '')}/auth/callback?token=${encodeURIComponent(token)}`;
    return res.redirect(redirectTarget);
  } catch (err) {
    console.error('[discordAuth] error', err);
    return res.status(500).send('Discord auth processing failed');
  }
}

// Redirect to Discord OAuth2
router.get('/discord', (req, res) => {
  const origin = req.query.origin || FRONTEND_URL;
  const callbackType = req.query.callback_type || '';
  const userId = req.query.user_id || '';

  if (!DISCORD_CLIENT_ID) {
    return res.status(500).send('Server misconfigured (missing Discord client ID)');
  }

  const redirectUri = `${BACKEND_URL}/api/auth/discord/callback`;
  const scope = ['identify'];
  
  // Build state parameter to preserve origin, callback type, and user ID
  const stateObj = { origin, callbackType };
  if (userId) stateObj.user_id = userId;
  const state = encodeURIComponent(JSON.stringify(stateObj));

  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope.join(' '))}&state=${state}`;

  console.log('[discordAuth] redirecting to Discord', { origin, callbackType, userId });
  res.redirect(discordAuthUrl);
});

router.post('/discord/callback', handleDiscordCallback);
router.get('/discord/callback', handleDiscordCallback);

module.exports = router;
