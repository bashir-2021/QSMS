'use strict';
/**
 * Create the first Super Admin for a fresh production database.
 * Reads SUPERADMIN_NAME / SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD from the environment.
 */
const db = require('../config/db');
const { PlatformUser } = require('../models');
const { hashPassword } = require('../services/authService');

async function main() {
  const { SUPERADMIN_NAME: name, SUPERADMIN_EMAIL: email, SUPERADMIN_PASSWORD: password } = process.env;
  if (!name || !email || !password || password.length < 10) {
    throw new Error('Set SUPERADMIN_NAME, SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD (10+ characters).');
  }
  await db.connect();
  if (await PlatformUser.exists({ email: email.toLowerCase() })) {
    console.log(`${email} already exists — nothing to do.`);
    return;
  }
  await PlatformUser.create({ name, email, role: 'super_admin', passwordHash: await hashPassword(password) });
  console.log(`Super Admin ${email} created. Sign in at /platform/login and change the password.`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.disconnect());
