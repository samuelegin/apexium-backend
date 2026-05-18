const rateLimit = require('express-rate-limit');

/* ── Helper ─────────────────────────────────────────────────────────────────── */
function limiter({ windowMinutes, max, message }) {
  return rateLimit({
    windowMs:        windowMinutes * 60 * 1000,
    max,
    standardHeaders: true,   // Return rate limit info in RateLimit-* headers
    legacyHeaders:   false,
    message:         { message },
    // Trust Railway's proxy so IP is read correctly
    keyGenerator:    (req) => req.ip,
  });
}

/* ── Auth ───────────────────────────────────────────────────────────────────── */
// 20 login/OAuth attempts per 5 min per IP
const authLimiter = limiter({
  windowMinutes: 5,
  max:           20,
  message:       'Too many auth attempts. Please wait 5 minutes.',
});

/* ── Job posting ────────────────────────────────────────────────────────────── */
// 10 job posts per hour per IP — prevents spam posting
const jobPostLimiter = limiter({
  windowMinutes: 60,
  max:           10,
  message:       'Too many jobs posted. Please wait before posting again.',
});

/* ── Applications ───────────────────────────────────────────────────────────── */
// 30 applications per hour per IP
const applicationLimiter = limiter({
  windowMinutes: 60,
  max:           30,
  message:       'Too many applications submitted. Please wait before applying again.',
});

/* ── Proof submissions ──────────────────────────────────────────────────────── */
// 20 proof submissions per hour per IP
const proofLimiter = limiter({
  windowMinutes: 60,
  max:           20,
  message:       'Too many proof submissions. Please wait before submitting again.',
});

/* ── File uploads ───────────────────────────────────────────────────────────── */
// 15 uploads per hour per IP
const uploadLimiter = limiter({
  windowMinutes: 60,
  max:           15,
  message:       'Too many file uploads. Please wait before uploading again.',
});

/* ── AI endpoints ───────────────────────────────────────────────────────────── */
// 30 AI requests per hour per IP — AI is expensive
const aiLimiter = limiter({
  windowMinutes: 60,
  max:           30,
  message:       'Too many AI requests. Please wait before trying again.',
});

/* ── General API fallback ───────────────────────────────────────────────────── */
// 300 requests per 15 min per IP for everything else
const generalLimiter = limiter({
  windowMinutes: 15,
  max:           300,
  message:       'Too many requests. Please slow down.',
});

module.exports = {
  authLimiter,
  jobPostLimiter,
  applicationLimiter,
  proofLimiter,
  uploadLimiter,
  aiLimiter,
  generalLimiter,
};
