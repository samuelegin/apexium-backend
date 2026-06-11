const express = require('express');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { makeToken } = require('./authHelpers');

const router = express.Router();

const TELEGRAM_BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const FRONTEND_URL          = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL           = process.env.BACKEND_URL  || 'http://localhost:3000';

console.log('[telegramAuth] config', {
  TELEGRAM_BOT_USERNAME,
  FRONTEND_URL,
  BACKEND_URL,
  hasBotToken: Boolean(TELEGRAM_BOT_TOKEN),
});

function verifyTelegramAuth(data, botToken) {
  const hash = data.hash;
  const checkObj = { ...data };
  delete checkObj.hash;
  const dataCheckString = Object.keys(checkObj).sort().map(k => `${k}=${checkObj[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const hmac   = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return hmac === hash;
}

// Sends a page that postMessages result to opener then closes itself (login flow)
function respondToPopup(res, payload) {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  res.set('Cache-Control', 'no-store');
  res.send(`<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  try { if (window.opener) window.opener.postMessage(${json}, '*'); } catch(e) {}
  window.close();
</script>
</body></html>`);
}

// Redirects back to the frontend (profile connect flow)
function respondWithRedirect(res, frontendUrl) {
  res.set('Cache-Control', 'no-store');
  res.send(`<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  window.location.replace(${JSON.stringify(frontendUrl)});
</script>
</body></html>`);
}

async function handleTelegramCallback(req, res) {
  const origin       = req.query?.origin       || req.body?.origin       || FRONTEND_URL;
  const callbackType = req.query?.callback_type || req.body?.callback_type || '';
  const userIdParam  = req.query?.user_id       || req.body?.user_id       || '';

  // Build the telegram payload from query or body, stripping our custom params
  const payload = { ...(Object.keys(req.query).length ? req.query : req.body) };
  delete payload.origin;
  delete payload.callback_type;
  delete payload.user_id;

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (!payload?.hash) {
    if (callbackType === 'profile') return respondWithRedirect(res, `${origin.replace(/\/$/, '')}/profile?telegram_error=missing_payload`);
    return respondToPopup(res, { error: 'missing_payload' });
  }
  if (!TELEGRAM_BOT_TOKEN) {
    if (callbackType === 'profile') return respondWithRedirect(res, `${origin.replace(/\/$/, '')}/profile?telegram_error=server_misconfigured`);
    return respondToPopup(res, { error: 'server_misconfigured' });
  }

  try {
    if (!verifyTelegramAuth(payload, TELEGRAM_BOT_TOKEN)) {
      if (callbackType === 'profile') return respondWithRedirect(res, `${origin.replace(/\/$/, '')}/profile?telegram_error=invalid_signature`);
      return respondToPopup(res, { error: 'invalid_signature' });
    }

    const authAge = Math.floor(Date.now() / 1000) - Number(payload.auth_date || 0);
    if (authAge > 86400) {
      if (callbackType === 'profile') return respondWithRedirect(res, `${origin.replace(/\/$/, '')}/profile?telegram_error=expired`);
      return respondToPopup(res, { error: 'expired' });
    }

    const db              = getDb();
    const telegramId      = String(payload.id);
    const telegramUsername = payload.username || '';
    const now             = new Date().toISOString();

    // ── Profile connection mode ───────────────────────────────────────────────
    if (callbackType === 'profile' && userIdParam) {
      const targetUser = await db.get('SELECT * FROM users WHERE id = ?', userIdParam);
      if (!targetUser)
        return respondWithRedirect(res, `${origin.replace(/\/$/, '')}/profile?telegram_error=user_not_found`);

      const existingOwner = await db.get('SELECT id FROM users WHERE telegram_id = ?', telegramId);
      if (existingOwner && existingOwner.id !== userIdParam)
        return respondWithRedirect(res, `${origin.replace(/\/$/, '')}/profile?telegram_error=already_linked`);

      await db.run(
        'UPDATE users SET telegram_id = ?, telegram_username = ?, updated_date = ? WHERE id = ?',
        telegramId, telegramUsername, now, userIdParam,
      );

      // Redirect back to frontend — the page uses ?telegram_connected=1 to show success toast
      return respondWithRedirect(res, `${origin.replace(/\/$/, '')}/profile?telegram_connected=1`);
    }

    // ── Login / registration mode ─────────────────────────────────────────────
    let user = await db.get('SELECT * FROM users WHERE telegram_id = ?', telegramId);

    if (!user) {
      const base     = (telegramUsername || `tg_${payload.first_name || 'user'}${(Math.random() * 10000) | 0}`)
                         .replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
      const taken    = await db.get('SELECT id FROM users WHERE username = ?', base);
      const username = taken ? `${base}_${uuidv4().slice(0, 4)}` : base;
      const id       = uuidv4();
      const email    = `telegram_${telegramId}@no-reply.apexium`;
      const refCode  = uuidv4().slice(0, 8).toUpperCase();
      await db.run(
        `INSERT INTO users (id,email,password_hash,full_name,username,referral_code,top_categories,created_date,updated_date,telegram_id,telegram_username)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id, email, '',
        `${payload.first_name || ''} ${payload.last_name || ''}`.trim(),
        username, refCode, '[]', now, now, telegramId, telegramUsername,
      );
      user = await db.get('SELECT * FROM users WHERE id = ?', id);
    } else {
      await db.run('UPDATE users SET last_login_date = ?, updated_date = ? WHERE id = ?', now, now, user.id);
      user = await db.get('SELECT * FROM users WHERE id = ?', user.id);
    }

    const token = makeToken(user);
    return respondToPopup(res, { type: 'telegram_login', token });

  } catch (err) {
    console.error('[telegramAuth] error', err);
    if (callbackType === 'profile') return respondWithRedirect(res, `${origin.replace(/\/$/, '')}/profile?telegram_error=server_error`);
    return respondToPopup(res, { error: 'server_error' });
  }
}

// Disconnect endpoint
router.post('/telegram/disconnect', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const db  = getDb();
    const now = new Date().toISOString();
    await db.run(
      'UPDATE users SET telegram_id = ?, telegram_username = ?, updated_date = ? WHERE id = ?',
      '', '', now, req.user.id,
    );
    return res.json({ message: 'Telegram disconnected' });
  } catch (err) {
    console.error('[telegramAuth] disconnect error', err);
    return res.status(500).json({ message: 'Failed to disconnect Telegram' });
  }
});

// Widget page — full page navigation, hosts Telegram login button
router.get('/telegram', (req, res) => {
  const botUser      = TELEGRAM_BOT_USERNAME || 'your_bot_username';
  const origin       = req.query.origin       || FRONTEND_URL;
  const callbackType = req.query.callback_type || '';
  const userId       = req.query.user_id       || '';

  let callbackUrl = `${BACKEND_URL}/api/auth/telegram/callback?origin=${encodeURIComponent(origin)}`;
  if (callbackType) callbackUrl += `&callback_type=${encodeURIComponent(callbackType)}`;
  if (userId)       callbackUrl += `&user_id=${encodeURIComponent(userId)}`;

  res.set('Cache-Control', 'no-store');
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { margin:0; display:flex; align-items:center; justify-content:center; min-height:100vh; background:#fff; font-family:sans-serif; }
    p { color:#888; font-size:14px; }
  </style>
</head>
<body>
  <div style="text-align:center">
    <script async
      src="https://telegram.org/js/telegram-widget.js?22"
      data-telegram-login="${botUser}"
      data-size="large"
      data-userpic="false"
      data-auth-url="${callbackUrl}"
      data-request-access="write">
    </script>
    <p>Click the button above to connect your Telegram</p>
  </div>
</body>
</html>`);
});

router.post('/telegram/callback', handleTelegramCallback);
router.get('/telegram/callback',  handleTelegramCallback);

module.exports = router;
