const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { makeToken, sanitizeUser } = require('./authHelpers');

const router = express.Router();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

console.log('[telegramAuth] config', {
  TELEGRAM_BOT_USERNAME,
  FRONTEND_URL,
  BACKEND_URL,
  hasBotToken: Boolean(TELEGRAM_BOT_TOKEN),
});

function verifyTelegramAuth(data, botToken) {
  const hash = data.hash;
  const checkObj = Object.assign({}, data);
  delete checkObj.hash;
  const dataCheckArr = Object.keys(checkObj)
    .map(k => `${k}=${checkObj[k]}`)
    .sort();
  const dataCheckString = dataCheckArr.join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const isValid = hmac === hash;

  if (!isValid) {
    console.error('[telegramAuth] invalid Telegram auth payload', {
      dataCheckString,
      expectedHmac: hmac,
      receivedHash: hash,
    });
  }

  return isValid;
}

async function handleTelegramCallback(req, res) {
  const origin = req.body?.origin || req.query?.origin;
  const payload = Object.keys(req.body || {}).length ? { ...req.body } : { ...req.query };
  delete payload.origin;

  if (!payload || !payload.hash) return res.status(400).send('Missing Telegram payload');
  if (!TELEGRAM_BOT_TOKEN) return res.status(500).send('Server misconfigured (missing bot token)');

  try {
    const valid = verifyTelegramAuth(payload, TELEGRAM_BOT_TOKEN);
    if (!valid) return res.status(401).send('Invalid Telegram login');

    const authAge = Math.floor(Date.now() / 1000) - Number(payload.auth_date || 0);
    if (authAge > 86400) return res.status(401).send('Telegram login expired');

    const db = getDb();
    const telegramId = String(payload.id);
    const telegramUsername = payload.username || '';
    let user = await db.get('SELECT * FROM users WHERE telegram_id = ? OR telegram_username = ?', telegramId, telegramUsername);

    const now = new Date().toISOString();

    if (!user) {
      // Create a user placeholder. Telegram does not provide email, so use synthetic email.
      const baseUsername = (telegramUsername || (`tg_${payload.first_name || 'user'}${(Math.random()*10000|0)}`)).toString().replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
      const usernameTaken = await db.get('SELECT id FROM users WHERE username = ?', baseUsername);
      const username = usernameTaken ? `${baseUsername}_${uuidv4().slice(0,4)}` : baseUsername;
      const id = uuidv4();
      const syntheticEmail = `telegram_${telegramId}@no-reply.apexium`; 
      const referral_code = uuidv4().slice(0,8).toUpperCase();

      await db.run(`INSERT INTO users (id,email,password_hash,full_name,username,referral_code,top_categories,created_date,updated_date,telegram_id,telegram_username)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, syntheticEmail, '', `${payload.first_name || ''} ${payload.last_name || ''}`.trim(), username, referral_code, '[]', now, now, telegramId, telegramUsername);

      user = await db.get('SELECT * FROM users WHERE id = ?', id);
    } else {
      await db.run('UPDATE users SET telegram_id = ?, telegram_username = ?, last_login_date = ?, updated_date = ? WHERE id = ?', telegramId, telegramUsername, now, now, user.id);
      user = await db.get('SELECT * FROM users WHERE id = ?', user.id);
    }

    const token = makeToken(user);
    const redirectOrigin = origin || FRONTEND_URL;
    const redirectTarget = `${redirectOrigin.replace(/\/$/, '')}/auth/callback?token=${encodeURIComponent(token)}`;
    return res.redirect(redirectTarget);
  } catch (err) {
    console.error('[telegramAuth] error', err);
    return res.status(500).send('Telegram auth processing failed');
  }
}

// Serve a small page with the Telegram widget so users can authenticate via the bot
router.get('/telegram', (req, res) => {
  const botUser = TELEGRAM_BOT_USERNAME || '@your_bot_username';
  const origin = req.query.origin || FRONTEND_URL;
  const callbackUrl = `${BACKEND_URL}/api/auth/telegram/callback?origin=${encodeURIComponent(origin)}`;
  console.log('[telegramAuth] serving widget', { botUser, origin, callbackUrl });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="display:flex;align-items:center;justify-content:center;height:100vh">\n<script async src="https://telegram.org/js/telegram-widget.js?19" data-telegram-login="${botUser}" data-size="large" data-userpic="false" data-auth-url="${callbackUrl}" data-request-access="write"></script>\n</body></html>`;
  res.send(html);
});

router.post('/telegram/callback', handleTelegramCallback);
router.get('/telegram/callback', handleTelegramCallback);

module.exports = router;
