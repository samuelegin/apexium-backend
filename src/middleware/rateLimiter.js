const rateLimit = require('express-rate-limit');
const ipKeyGenerator = (rateLimit && rateLimit.ipKeyGenerator) ? rateLimit.ipKeyGenerator : (req) => req.ip;

function limiter({ windowMinutes, max, message }) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: true, 
    legacyHeaders:   false,
    message: { message },
    keyGenerator:    (req) => ipKeyGenerator(req),
  });
}

const authLimiter = limiter({
  windowMinutes: 5,
  max: 20,
  message: 'Too many auth attempts. Please wait 5 minutes.',
});

const jobPostLimiter = limiter({
  windowMinutes: 30,
  max: 10,
  message: 'Too many jobs posted. Please wait before posting again.',
});

const applicationLimiter = limiter({
  windowMinutes: 60,
  max: 30,
  message: 'Too many applications submitted. Please wait before applying again.',
});

const proofLimiter = limiter({
  windowMinutes: 60,
  max: 20,
  message: 'Too many proof submissions. Please wait before submitting again.',
});

const uploadLimiter = limiter({
  windowMinutes: 60,
  max: 15,
  message: 'Too many file uploads. Please wait before uploading again.',
});

const aiLimiter = limiter({
  windowMinutes: 60,
  max: 30,
  message: 'Too many AI requests. Please wait before trying again.',
});

const generalLimiter = limiter({
  windowMinutes: 15,
  max: 300,
  message: 'Too many requests. Please slow down.',
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