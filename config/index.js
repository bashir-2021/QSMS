'use strict';
require('dotenv').config();
const path = require('path');

const env = process.env.NODE_ENV || 'development';
const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === 'true');
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

const config = {
  env,
  isProd: env === 'production',
  isTest: env === 'test',
  port: int(process.env.PORT, 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  rootDir: path.resolve(__dirname, '..'),

  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/quranic',
  useTransactions: bool(process.env.MONGO_TRANSACTIONS, true),

  session: {
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    maxAgeMs: int(process.env.SESSION_MAX_AGE_HOURS, 8) * 60 * 60 * 1000,
    secureCookie: bool(process.env.COOKIE_SECURE, false),
  },
  trustProxy: bool(process.env.TRUST_PROXY, false),

  uploads: {
    dir: path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads'),
    maxImageBytes: int(process.env.MAX_IMAGE_MB, 2) * 1024 * 1024,
    maxAttachmentBytes: int(process.env.MAX_ATTACHMENT_MB, 5) * 1024 * 1024,
  },

  subscription: {
    expiredAccessPolicy: process.env.EXPIRED_ACCESS_POLICY || 'read_only',
    expiringSoonDays: int(process.env.EXPIRING_SOON_DAYS, 7),
    jobIntervalMinutes: int(process.env.JOB_INTERVAL_MINUTES, 60),
  },

  backupDir: path.resolve(__dirname, '..', process.env.BACKUP_DIR || 'backups'),
};

if (config.isProd && config.session.secret === 'dev-only-secret-change-me') {
  throw new Error('SESSION_SECRET must be set in production');
}

module.exports = config;
