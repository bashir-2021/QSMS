'use strict';

/** Fill {name} placeholders (used to build the English message from an i18n template). */
const fill = (template, vars) => String(template).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));

/**
 * Application error shown to the user.
 * Optional `vars` make the message translatable: `message` is then a template with {placeholders};
 * err.message is the interpolated English text, err.i18nKey the template and err.vars the values
 * (the error handler renders req.t(err.i18nKey, err.vars)).
 */
class AppError extends Error {
  constructor(status, message, details, vars) {
    super(vars ? fill(message, vars) : message);
    this.status = status;
    this.details = details;
    this.expose = true;
    if (vars) {
      this.i18nKey = message;
      this.vars = vars;
    }
  }
}

const notFound = (what = 'Record') => new AppError(404, `${what} not found`);
const badRequest = (msg, details, vars) => new AppError(400, msg, details, vars);
const forbidden = (msg = 'You do not have permission to perform this action', vars) => new AppError(403, msg, undefined, vars);
const conflict = (msg, vars) => new AppError(409, msg, undefined, vars);

/** Wrap an async route handler so rejections reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { AppError, notFound, badRequest, forbidden, conflict, asyncHandler };
