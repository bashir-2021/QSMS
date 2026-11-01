'use strict';
const config = require('../config');

function notFoundHandler(req, res) {
  res.status(404).render('errors/error', {
    layout: 'layouts/public', title: 'Page not found', status: 404,
    message: 'The page you are looking for does not exist or was moved.',
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.status || err.statusCode || 500;
  let message = err.expose ? err.message : 'Something went wrong. The error has been logged.';

  if (err.code === 'LIMIT_FILE_SIZE') { status = 400; message = 'The uploaded file is too large.'; }
  if (err.name === 'CastError') { status = 404; message = 'Record not found.'; }
  if (err.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors).map((e) => e.message).join('. ');
  }
  if (err.code === 11000) { status = 409; message = 'A record with the same unique value already exists.'; }

  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);

  // For form posts with a recoverable error, go back to the form with a message.
  if (req.method === 'POST' && status < 500 && status !== 403 && req.flash) {
    req.flash('danger', message);
    return res.redirect(req.get('Referrer') || '/');
  }

  const kind = req.session && req.session.auth && req.session.auth.kind;
  const layout = kind === 'school' && res.locals.tenant ? 'layouts/school'
    : kind === 'platform' && res.locals.currentUser ? 'layouts/platform' : 'layouts/public';
  return res.status(status).render('errors/error', {
    layout, title: status === 403 ? 'Access denied' : status === 404 ? 'Not found' : 'Error',
    status, message, stack: config.isProd ? null : err.stack,
  });
}

module.exports = { notFoundHandler, errorHandler };
