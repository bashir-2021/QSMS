'use strict';

class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
    this.expose = true;
  }
}

const notFound = (what = 'Record') => new AppError(404, `${what} not found`);
const badRequest = (msg, details) => new AppError(400, msg, details);
const forbidden = (msg = 'You do not have permission to perform this action') => new AppError(403, msg);
const conflict = (msg) => new AppError(409, msg);

/** Wrap an async route handler so rejections reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { AppError, notFound, badRequest, forbidden, conflict, asyncHandler };
