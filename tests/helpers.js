'use strict';
process.env.NODE_ENV = 'test';
process.env.MONGO_TRANSACTIONS = 'true';
process.env.JOB_INTERVAL_MINUTES = '0';

const mongoose = require('mongoose');
const session = require('express-session');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;

async function startDb() {
  // a replica set so MongoDB transactions behave exactly as in production
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri('quranic_test'));
  require('../models');
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

async function stopDb() {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}

async function clearDb() {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
}

function makeApp() {
  const { createApp } = require('../app');
  return createApp({ sessionStore: new session.MemoryStore() });
}

function csrfFrom(html) {
  const m = /name="_csrf" value="([a-f0-9]+)"/.exec(html) || /_csrf=([a-f0-9]+)/.exec(html);
  return m ? m[1] : null;
}

/** Log a school user in with a persistent agent; returns { agent, csrf }. */
async function loginSchool(app, email, password) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), email, password });
  if (res.status !== 302 || !/\/school\//.test(res.headers.location)) throw new Error(`login failed for ${email}: ${res.status} ${res.headers.location}`);
  const dash = await agent.get('/school/dashboard');
  return { agent, csrf: csrfFrom(dash.text) };
}

async function loginPlatform(app, email, password) {
  const agent = request.agent(app);
  const page = await agent.get('/platform/login');
  const res = await agent.post('/platform/login').type('form').send({ _csrf: csrfFrom(page.text), email, password });
  if (res.status !== 302) throw new Error(`platform login failed: ${res.status}`);
  const dash = await agent.get('/platform/dashboard');
  return { agent, csrf: csrfFrom(dash.text) };
}

/** Build two fully registered schools with a class, teacher and student each. */
async function twoSchools() {
  const M = require('../models');
  const C = require('../config/constants');
  const tenantService = require('../services/tenantService');
  const studentService = require('../services/studentService');
  const classService = require('../services/classService');
  const { hashPassword } = require('../services/authService');

  const plan = await M.SubscriptionPlan.create({
    name: 'Test', code: 'test', price: 1000, billingCycle: 'monthly',
    limits: { students: 50, teachers: 5, classes: 5, users: 5 }, features: Object.keys(C.PLAN_FEATURES), trialDays: 30, graceDays: 5,
  });
  await M.PlatformUser.create({ name: 'Root', email: 'root@quranic.test', role: 'super_admin', passwordHash: await hashPassword('Root!2026x') });

  const out = {};
  for (const key of ['a', 'b']) {
    const { tenant, admin } = await tenantService.registerSchool({
      schoolName: `School ${key.toUpperCase()}`, country: 'Somalia', city: 'Mogadishu', adminName: `Admin ${key}`,
      phone: '+252610000000', email: `admin@${key}.test`, planId: plan._id, password: 'Pass1234!',
    });
    await M.SchoolSettings.updateOne({ tenantId: tenant._id }, { $set: { registrationFee: 1000, monthlyFee: 1500 } });
    const settings = await M.SchoolSettings.findOne({ tenantId: tenant._id }).lean();
    const subscription = await M.Subscription.findById(tenant.currentSubscription).lean();
    const ctx = { tenantId: tenant._id, tenant: tenant.toObject(), user: admin.toObject(), settings, subscription };
    const cls = await classService.create(ctx, { name: `Class ${key}`, level: 'Beginner', capacity: '20', isActive: 'on' });
    const { student } = await studentService.create(ctx, { fullName: `Student ${key}`, gender: 'male', program: 'cashra', class: String(cls._id) });
    out[key] = { tenant, admin, ctx, cls, student, req: { tenantId: tenant._id, user: admin, ip: '127.0.0.1' } };
  }
  out.plan = plan;
  return out;
}

module.exports = { startDb, stopDb, clearDb, makeApp, csrfFrom, loginSchool, loginPlatform, twoSchools };
