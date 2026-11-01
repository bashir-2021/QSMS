'use strict';
/**
 * Minimal session flash messages plus "old input" for re-populating forms after
 * a validation failure redirect.
 */
function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  req.flashForm = (errors, body) => {
    req.session.formErrors = errors;
    const safe = { ...(body || {}) };
    delete safe.password; delete safe.confirmPassword; delete safe._csrf;
    req.session.oldInput = safe;
  };
  res.locals.flash = req.session.flash || [];
  res.locals.formErrors = req.session.formErrors || {};
  res.locals.old = req.session.oldInput || {};
  delete req.session.flash;
  delete req.session.formErrors;
  delete req.session.oldInput;
  next();
}

module.exports = { flash };
