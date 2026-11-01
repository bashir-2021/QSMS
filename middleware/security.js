'use strict';
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('../config');

const CDN = 'https://cdn.jsdelivr.net';

const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", CDN], // no inline scripts — all JS lives in /public/js
      'style-src': ["'self'", CDN, 'https://fonts.googleapis.com'],
      'font-src': ["'self'", CDN, 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"],
      'upgrade-insecure-requests': config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
});

const handler = (req, res) => {
  res.status(429).render('errors/error', {
    layout: 'layouts/public', title: 'Too many requests', status: 429,
    message: 'Too many attempts. Please wait a few minutes and try again.',
  });
};

// Brute-force protection on login and password endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: config.isTest ? 1000 : 10,
  standardHeaders: 'draft-7', legacyHeaders: false, handler,
});

// School self-registration (prevents spam tenant creation).
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: config.isTest ? 1000 : 5,
  standardHeaders: 'draft-7', legacyHeaders: false, handler,
});

// General ceiling for the authenticated app.
const appLimiter = rateLimit({
  windowMs: 60 * 1000, limit: config.isTest ? 10000 : 300,
  standardHeaders: 'draft-7', legacyHeaders: false, handler,
});

module.exports = { securityHeaders, authLimiter, registrationLimiter, appLimiter };
