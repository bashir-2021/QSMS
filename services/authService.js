'use strict';
const bcrypt = require('bcrypt');
const { SchoolUser, PlatformUser, Tenant } = require('../models');

const ROUNDS = 12;
// Constant-time-ish behaviour for unknown emails: still run a bcrypt compare.
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO5y3Y0sIy1H1aEQK1sUj1xXjQyQ6sQ1a';

const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);

async function verify(user, password) {
  const ok = await bcrypt.compare(String(password || ''), user ? user.passwordHash : DUMMY_HASH);
  return Boolean(user) && ok;
}

/** School login. Email is globally unique; the tenant comes from the user record. */
async function loginSchoolUser(email, password) {
  // Login is the one place a SchoolUser is looked up before the tenant is known.
  const user = await SchoolUser.findOne({ email: String(email || '').toLowerCase().trim() })
    .select('+passwordHash').setOptions({ skipTenant: true });
  if (!(await verify(user, password))) return { error: 'Invalid email or password.' };
  if (!user.isActive) return { error: 'Your account has been deactivated. Contact your school administrator.' };
  const tenant = await Tenant.findById(user.tenantId).lean();
  if (!tenant) return { error: 'School account not found.' };
  user.lastLoginAt = new Date();
  await user.save();
  return { user, tenant };
}

async function loginPlatformUser(email, password) {
  const user = await PlatformUser.findOne({ email: String(email || '').toLowerCase().trim() }).select('+passwordHash');
  if (!(await verify(user, password))) return { error: 'Invalid email or password.' };
  if (!user.isActive) return { error: 'This account has been deactivated.' };
  user.lastLoginAt = new Date();
  await user.save();
  return { user };
}

async function changePassword(Model, filter, currentPassword, newPassword) {
  const user = await Model.findOne(filter).select('+passwordHash');
  if (!user || !(await verify(user, currentPassword))) return { error: 'Your current password is incorrect.' };
  user.passwordHash = await hashPassword(newPassword);
  await user.save();
  return { user };
}

/** Regenerate the session id on login to prevent session fixation. */
function establishSession(req, auth) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.auth = auth;
      return req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

function destroySession(req) {
  return new Promise((resolve) => { req.session.destroy(() => resolve()); });
}

module.exports = {
  hashPassword, loginSchoolUser, loginPlatformUser, changePassword, establishSession, destroySession,
  PASSWORD_RULE: { minLength: 8, minLowercase: 1, minUppercase: 0, minNumbers: 1, minSymbols: 0 },
};
