'use strict';
/**
 * Parent portal. A parent signs in with the guardian phone or the mother phone on their children's records. The first
 * time, the password is that same phone number; the parent must then choose a new one. The account belongs
 * to one school (a parent with children in two schools has one account in each), and the children shown are
 * looked up by phone on every request, so only that school's records with that number are ever visible.
 */
const bcrypt = require('bcrypt');
const { ParentAccount, Student, Tenant, Subscription, StudentLesson, StudentAttendance, StudentInvoice } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const { phoneKey, phoneKeyRegex } = require('../utils/phone');
const { badRequest, notFound } = require('../utils/errors');
const { owned } = require('./scope');
const { hashPassword } = require('./authService');
const subscriptionService = require('./subscriptionService');
const billing = require('./billingService');

// Keeps sign-in timing similar whether or not the number is known.
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO5y3Y0sIy1H1aEQK1sUj1xXjQyQ6sQ1a';
const INVALID = 'Invalid phone number or password.';

/** Students whose guardian phone or mother phone is this number. */
const byPhone = (key) => ({ $or: [{ guardianPhone: phoneKeyRegex(key) }, { motherPhone: phoneKeyRegex(key) }] });
const childrenFilter = (tenantId, key) => ({ tenantId, ...byPhone(key) });
/** The parent phone numbers on a student record, as login keys: [{ who, key }], without repeats. */
function parentKeys(student) {
  const out = [];
  [['Guardian', student.guardianPhone], ['Mother', student.motherPhone]].forEach(([who, phone]) => {
    const key = phoneKey(phone);
    if (key && !out.some((o) => o.key === key)) out.push({ who, key });
  });
  return out;
}

/**
 * Sign in with a phone number and password. Returns every school where the number has children and the
 * password is right (usually one), or an error. The first sign-in at a school creates the account.
 */
async function login(phone, password) {
  const key = phoneKey(phone);
  if (!key) {
    await bcrypt.compare(String(password || ''), DUMMY_HASH);
    return { error: INVALID };
  }
  // Sign-in is the one place children are looked up before the school is known.
  const tenantIds = await Student.distinct('tenantId', byPhone(key)).setOptions({ skipTenant: true });
  const matches = [];
  let checked = false;
  for (const tenantId of tenantIds) {
    /* eslint-disable no-await-in-loop */
    const tenant = await Tenant.findById(tenantId).lean();
    const sub = tenant && tenant.currentSubscription ? await Subscription.findById(tenant.currentSubscription).lean() : null;
    if (!tenant || subscriptionService.computeAccess(tenant, sub).mode === 'blocked') continue;
    let account = await ParentAccount.findOne({ tenantId, phoneKey: key }).select('+passwordHash');
    let ok;
    if (account) {
      ok = (await bcrypt.compare(String(password || ''), account.passwordHash)) && account.isActive;
    } else {
      // first sign-in: the password is the phone number itself (written in any way)
      ok = phoneKey(password) === key;
      if (ok) {
        try {
          account = await ParentAccount.create({ tenantId, phoneKey: key, passwordHash: await hashPassword(key), mustChangePassword: true });
        } catch (err) {
          if (err.code !== 11000) throw err;
          account = await ParentAccount.findOne({ tenantId, phoneKey: key });
        }
      }
    }
    checked = checked || Boolean(account);
    if (ok) {
      account.lastLoginAt = new Date();
      await account.save();
      matches.push({ account, tenant });
    }
    /* eslint-enable no-await-in-loop */
  }
  if (!checked) await bcrypt.compare(String(password || ''), DUMMY_HASH);
  if (!matches.length) return { error: INVALID };
  return { matches };
}

/** The parent's children at their school, by name. */
async function children(tenantId, key) {
  // awaited here so the query (and its populate) runs inside the caller's tenant scope
  const rows = await Student.find(childrenFilter(tenantId, key)).sort({ fullName: 1 })
    .select('fullName studentCode program class status photo gender guardianName').populate({ path: 'class', select: 'name' }).lean();
  return rows;
}

/** One child of this parent, or 404 — a parent never sees another family's child. */
async function child(tenantId, key, childId) {
  const student = await owned(Student, tenantId, childId, 'Student', { populate: { path: 'class', select: 'name' } });
  if (!parentKeys(student).some((p) => p.key === key)) throw notFound('Student');
  return student;
}

/** Cards for the parent's home page: each child's latest lesson, lessons waiting, attendance and balance. */
async function overview(tenantId, key, { finance }) {
  const kids = await children(tenantId, key);
  const since = dates.addDays(dates.startOfDay(), -30);
  await Promise.all(kids.map(async (k) => {
    const [last, waiting, att, due] = await Promise.all([
      StudentLesson.findOne({ tenantId, student: k._id }).sort({ date: -1, createdAt: -1 }).lean(),
      StudentLesson.countDocuments({ tenantId, student: k._id, isOpen: true }),
      StudentAttendance.aggregate([{ $match: { tenantId, student: k._id, date: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      finance ? billing.studentOutstanding(tenantId, k._id) : null,
    ]);
    const counts = Object.fromEntries(att.map((a) => [a._id, a.n]));
    const total = att.reduce((a, b) => a + b.n, 0);
    Object.assign(k, {
      lastLesson: last, waiting, balance: due,
      attendanceRate: total ? Math.round((((counts.present || 0) + (counts.late || 0)) / total) * 100) : null,
    });
  }));
  return kids;
}

/** A child's page: lessons with every sitting, attendance for the last 30 days, and open fees. */
async function childDetail(tenantId, key, childId, { finance }) {
  const student = await child(tenantId, key, childId);
  const since = dates.addDays(dates.startOfDay(), -30);
  const [lessons, attendance, invoices, balance] = await Promise.all([
    StudentLesson.find({ tenantId, student: student._id }).sort({ date: -1, createdAt: -1 }).limit(30).lean(),
    StudentAttendance.find({ tenantId, student: student._id, date: { $gte: since } }).sort({ date: -1 }).limit(60).lean(),
    finance ? StudentInvoice.find({ tenantId, student: student._id, status: { $in: billing.OPEN } }).sort({ issueDate: 1 }).lean() : [],
    finance ? billing.studentOutstanding(tenantId, student._id) : null,
  ]);
  const counts = attendance.reduce((m, a) => { m[a.status] = (m[a.status] || 0) + 1; return m; }, {});
  const passed = lessons.filter((l) => l.result === 'passed');
  return {
    student, lessons, attendance, invoices, balance,
    attendanceSummary: { ...Object.fromEntries(C.ATTENDANCE_STATUSES.map((s) => [s, counts[s] || 0])), total: attendance.length },
    progress: {
      passed: passed.length,
      waiting: lessons.filter((l) => l.isOpen).length,
      ayahs: passed.reduce((a, l) => a + (l.ayahs || 0), 0),
      pages: passed.reduce((a, l) => a + (l.pages || 0), 0),
    },
  };
}

/**
 * Change the parent's password. On the forced first change the current password is not asked again
 * (it was just typed to sign in). The new password may not be the phone number.
 */
async function changePassword(tenantId, accountId, { currentPassword, newPassword, confirmPassword }) {
  const account = await ParentAccount.findOne({ tenantId, _id: accountId, isActive: true }).select('+passwordHash');
  if (!account) throw notFound('Account');
  if (!account.mustChangePassword && !(await bcrypt.compare(String(currentPassword || ''), account.passwordHash))) {
    throw badRequest('Your current password is incorrect.');
  }
  const pw = String(newPassword || '');
  if (pw.length < 8 || pw.length > 128 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw badRequest('Use at least 8 characters with a letter and a number.');
  if (pw !== String(confirmPassword || '')) throw badRequest('Passwords do not match');
  if (phoneKey(pw) === account.phoneKey) throw badRequest('Choose a password that is not your phone number.');
  account.passwordHash = await hashPassword(pw);
  account.mustChangePassword = false;
  account.passwordChangedAt = new Date();
  await account.save();
  return account;
}

/* ------------------------------ School side ------------------------------- */

/** The parent logins of a student (guardian and mother): [{ who, key, account }], account null until first used. */
async function loginFor(tenantId, student) {
  const keys = parentKeys(student);
  const accounts = await ParentAccount.find({ tenantId, phoneKey: { $in: keys.map((k) => k.key) } }).lean();
  return keys.map((k) => ({ ...k, account: accounts.find((a) => a.phoneKey === k.key) || null }));
}

/** Reset a parent's password back to their phone number (they must change it again at the next sign-in). */
async function resetForStudent(ctx, studentId, phone) {
  const student = await owned(Student, ctx.tenantId, studentId, 'Student');
  const keys = parentKeys(student);
  if (!keys.length) throw badRequest('This student has no parent phone number, so there is no parent login.');
  // one of this student's own numbers only (the guardian's unless another is chosen)
  const key = phone ? (keys.find((k) => k.key === phoneKey(phone)) || {}).key : keys[0].key;
  if (!key) throw notFound('Parent login');
  await ParentAccount.deleteOne({ tenantId: ctx.tenantId, phoneKey: key });
  return { student, key };
}

module.exports = { parentKeys, login, children, child, overview, childDetail, changePassword, loginFor, resetForStudent };
