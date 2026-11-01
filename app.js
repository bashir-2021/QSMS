'use strict';
/**
 * Quranic — multi-tenant SaaS for Quran school management.
 * Main application entry point (MVC: models / controllers / routes / services / views).
 */
const path = require('path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const expressLayouts = require('express-ejs-layouts');
const compression = require('compression');
const morgan = require('morgan');

const config = require('./config');
const db = require('./config/db');
require('./models'); // register all schemas
const viewHelpers = require('./utils/viewHelpers');
const { securityHeaders } = require('./middleware/security');
const { csrfProtection } = require('./middleware/csrf');
const { flash } = require('./middleware/flash');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const jobService = require('./services/jobService');
const tenantContext = require('./utils/tenantContext');

function createApp({ sessionStore } = {}) {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // views
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(expressLayouts);
  app.set('layout', 'layouts/school');
  Object.assign(app.locals, viewHelpers, { appName: 'Quranic', year: new Date().getFullYear() });

  // hardening & basics
  app.use(securityHeaders);
  app.use(compression());
  if (!config.isTest) app.use(morgan(config.isProd ? 'combined' : 'dev'));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  app.use(express.urlencoded({ extended: true, limit: '200kb', parameterLimit: 2000 }));
  app.use(express.json({ limit: '100kb' }));

  // sessions (stored in MongoDB, httpOnly, sameSite, secure behind HTTPS)
  app.use(session({
    name: 'quranic.sid',
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: sessionStore || MongoStore.create({ mongoUrl: config.mongoUri, collectionName: 'sessions', ttl: config.session.maxAgeMs / 1000 }),
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.session.secureCookie, maxAge: config.session.maxAgeMs },
  }));

  app.use(tenantContext.middleware); // per-request tenant scope used by the tenant plugin
  app.use(flash);
  app.use(csrfProtection);
  app.use((req, res, next) => {
    res.locals.path = req.path;
    res.locals.query = req.query;
    res.locals.auth = req.session.auth || null;
    next();
  });

  // routes
  app.use('/', require('./routes/public'));
  app.use('/platform', require('./routes/platform'));
  app.use('/school', require('./routes/school'));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function start() {
  await db.connect();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Quranic running on ${config.appUrl} (${config.env}) — transactions ${config.useTransactions ? 'on' : 'OFF'}`);
  });
  jobService.start();
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start Quranic:', err);
    process.exit(1);
  });
}

module.exports = { createApp, start };
