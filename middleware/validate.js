'use strict';
const { validationResult } = require('express-validator');

/**
 * Run after express-validator chains. On failure, flash the field errors and the
 * submitted values, then redirect back to the form (or to `fallback`).
 */
function handleValidation(fallback) {
  return (req, res, next) => {
    const result = validationResult(req);
    if (result.isEmpty()) return next();
    const errors = {};
    result.array().forEach((e) => { if (!errors[e.path]) errors[e.path] = e.msg; });
    req.flashForm(errors, req.body);
    req.flash('danger', 'Please correct the highlighted fields.');
    const back = typeof fallback === 'function' ? fallback(req) : fallback;
    return res.redirect(back || req.get('Referrer') || req.originalUrl);
  };
}

module.exports = { handleValidation };
