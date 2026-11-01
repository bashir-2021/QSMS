'use strict';
const crypto = require('crypto');

/**
 * Synchronizer-token CSRF protection for EJS forms.
 * A random token lives in the session; every state-changing request must echo it back in
 * the `_csrf` body field, the `x-csrf-token` header, or (for multipart uploads, which are
 * parsed after this middleware) the `_csrf` query parameter.
 */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function csrfProtection(req, res, next) {
  const token = ensureToken(req);
  res.locals.csrfToken = token;
  if (SAFE.has(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || req.query._csrf;
  if (tokensMatch(sent, token)) return next();
  const err = new Error('Your form session expired or is invalid. Please reload the page and try again.');
  err.status = 403;
  err.expose = true;
  return next(err);
}

module.exports = { csrfProtection };
