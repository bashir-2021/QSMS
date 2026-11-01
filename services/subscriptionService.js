'use strict';
const mongoose = require('mongoose');
const config = require('../config');
const C = require('../config/constants');
const dates = require('../utils/dates');
const money = require('../utils/money');
const { badRequest, notFound, conflict, AppError } = require('../utils/errors');
const {
  Tenant, Subscription, SubscriptionPlan, SubscriptionPayment, Student, Teacher, Class, SchoolUser,
} = require('../models');
const sequence = require('./sequenceService');
const notifications = require('./notificationService');

/* ------------------------------ Plan helpers ------------------------------ */

function planSnapshot(plan) {
  return {
    name: plan.name, price: plan.price, currency: plan.currency, billingCycle: plan.billingCycle,
    customDays: plan.customDays, limits: { ...plan.limits }, features: [...plan.features],
    graceDays: plan.graceDays, reminderDays: [...(plan.reminderDays || [])],
  };
}

/** End date of `periods` billing cycles of a plan starting at `from`. */
function periodEnd(planLike, from, periods = 1) {
  if (planLike.billingCycle === 'custom') return dates.addDays(from, (planLike.customDays || 30) * periods);
  return dates.addMonths(from, C.BILLING_CYCLES[planLike.billingCycle].months * periods);
}

/* --------------------------- Status & access rules ------------------------ */

/** Derive the time-based status of a subscription. Manual states (suspended/cancelled) stick. */
function computeStatus(sub, now = new Date()) {
  if (!sub) return 'expired';
  if (['suspended', 'cancelled'].includes(sub.status)) return sub.status;
  if (now > new Date(sub.endDate)) return 'expired';
  if (sub.status === 'trial') return 'trial';
  const daysLeft = dates.daysBetween(now, sub.endDate);
  return daysLeft <= config.subscription.expiringSoonDays ? 'expiring_soon' : 'active';
}

/**
 * What a school user may do right now.
 * mode: full | read_only | blocked
 */
function computeAccess(tenant, sub, now = new Date()) {
  if (!tenant || tenant.status !== 'active') {
    return { mode: 'blocked', status: tenant ? tenant.status : 'unknown', message: `This school account is ${tenant ? tenant.status : 'unavailable'}. Please contact Quranic support.${tenant && tenant.statusReason ? ` Reason: ${tenant.statusReason}` : ''}` };
  }
  const status = computeStatus(sub, now);
  const daysLeft = sub ? dates.daysBetween(now, sub.endDate) : 0;
  if (status === 'suspended' || status === 'cancelled') {
    return { mode: 'blocked', status, daysLeft, message: `Your subscription is ${status}. Renew or contact support to restore access.` };
  }
  if (status === 'expired') {
    const graceEnd = sub && (sub.graceEndDate || dates.addDays(sub.endDate, (sub.planSnapshot && sub.planSnapshot.graceDays) || 0));
    if (graceEnd && now <= graceEnd) {
      return { mode: 'full', status, inGrace: true, daysLeft: dates.daysBetween(now, graceEnd), message: `Your subscription has expired. You are in the grace period until ${dates.formatDate(graceEnd)} — renew now to avoid restrictions.` };
    }
    const mode = config.subscription.expiredAccessPolicy === 'blocked' ? 'blocked' : 'read_only';
    return { mode, status, daysLeft: 0, message: `Your subscription has expired. Your data is safe, but ${mode === 'read_only' ? 'the school is in read-only mode' : 'access is restricted'} until the subscription is renewed.` };
  }
  return { mode: 'full', status, daysLeft, message: status === 'expiring_soon' ? `Your subscription expires in ${daysLeft} day(s). Renew to avoid interruption.` : null };
}

function hasFeature(sub, feature) {
  if (!sub || !sub.planSnapshot) return false;
  return (sub.planSnapshot.features || []).includes(feature);
}

/* ------------------------------- Plan limits ------------------------------ */

const LIMIT_SOURCES = {
  students: (tenantId) => Student.countDocuments({ tenantId, status: { $in: ['active', 'suspended'] } }),
  teachers: (tenantId) => Teacher.countDocuments({ tenantId, status: { $in: ['active', 'on_leave'] } }),
  classes: (tenantId) => Class.countDocuments({ tenantId, isActive: true }),
  users: (tenantId) => SchoolUser.countDocuments({ tenantId, isActive: true }),
};

/** Server-side enforcement of plan limits. Throws 403 when adding `adding` would exceed. */
async function assertLimit(sub, tenantId, resource, adding = 1) {
  const max = sub && sub.planSnapshot && sub.planSnapshot.limits ? sub.planSnapshot.limits[resource] : 0;
  if (!max) return; // 0 / undefined = unlimited
  const current = await LIMIT_SOURCES[resource](tenantId);
  if (current + adding > max) {
    throw new AppError(403, `Your plan allows up to ${max} ${resource}. You currently have ${current}. Upgrade your subscription to add more.`);
  }
}

async function usage(sub, tenantId) {
  const out = {};
  await Promise.all(Object.keys(LIMIT_SOURCES).map(async (r) => {
    out[r] = { used: await LIMIT_SOURCES[r](tenantId), max: (sub && sub.planSnapshot && sub.planSnapshot.limits[r]) || 0 };
  }));
  return out;
}

/* --------------------------- Subscription lifecycle ----------------------- */

/** Create the first subscription for a newly registered school (trial if the plan has one). */
async function createInitial(tenantId, plan, { session } = {}) {
  const now = new Date();
  const trial = plan.trialDays > 0;
  const endDate = trial ? dates.addDays(now, plan.trialDays) : now; // paid plans start expired until verified payment
  const [sub] = await Subscription.create([{
    tenant: tenantId, plan: plan._id, status: trial ? 'trial' : 'expired',
    startDate: now, endDate, graceEndDate: trial ? dates.addDays(endDate, plan.graceDays) : now,
    planSnapshot: planSnapshot(plan),
    notes: trial ? `${plan.trialDays}-day free trial` : 'Awaiting first payment',
  }], { session });
  return sub;
}

async function getCurrent(tenantId) {
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant || !tenant.currentSubscription) return null;
  return Subscription.findById(tenant.currentSubscription).populate('plan').lean();
}

/**
 * A school (or platform staff on its behalf) records a payment for N periods of a plan.
 * The payment stays "pending" — only verification activates or extends the subscription.
 */
async function submitPayment(tenantId, { planId, periods = 1, method, transactionRef, payerName, paidAt, notes }, submittedBy) {
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) throw notFound('School');
  const plan = await SubscriptionPlan.findOne({ _id: planId, isActive: true }).lean();
  if (!plan) throw badRequest('Please choose an active subscription plan.');
  if (!C.PLATFORM_PAYMENT_METHODS.includes(method)) throw badRequest('Invalid payment method.');
  const n = Math.max(1, Math.min(24, parseInt(periods, 10) || 1));
  const pendingExists = await SubscriptionPayment.exists({ tenant: tenantId, status: 'pending' });
  if (pendingExists) throw conflict('There is already a payment awaiting verification for this school.');

  const payment = await SubscriptionPayment.create({
    reference: await sequence.next(null, 'subscription_payment', 'SP-{YYYY}-{SEQ:5}'),
    tenant: tenantId, subscription: tenant.currentSubscription, plan: plan._id,
    amount: plan.price * n, currency: plan.currency, periods: n,
    method, transactionRef, payerName, paidAt: dates.parseDay(paidAt) || new Date(), notes, submittedBy,
  });
  await notifications.toPlatform({
    type: 'payment', level: 'warning', roles: ['super_admin', 'finance_officer'],
    title: 'Subscription payment awaiting verification',
    message: `${tenant.name} submitted ${money.format(payment.amount, payment.currency)} (${payment.reference}).`,
    link: `/platform/payments/${payment._id}`,
  });
  return payment;
}

/**
 * Verify a pending payment: marks it paid and activates/extends the subscription.
 * Renewal of the same plan extends from the later of now and the current end date; a plan
 * change starts a new subscription period immediately.
 */
async function verifyPayment(paymentId, platformUser, runInTransaction) {
  return runInTransaction(async (session) => {
    const payment = await SubscriptionPayment.findOne({ _id: paymentId }).session(session);
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'pending') throw conflict(`This payment is already ${payment.status}.`);
    const plan = await SubscriptionPlan.findById(payment.plan).session(session);
    const tenant = await Tenant.findById(payment.tenant).session(session);
    const current = tenant.currentSubscription ? await Subscription.findById(tenant.currentSubscription).session(session) : null;
    const now = new Date();

    let sub;
    const samePlan = current && String(current.plan) === String(plan._id) && !['cancelled'].includes(current.status);
    if (samePlan && current.status !== 'trial') {
      const from = new Date(current.endDate) > now ? new Date(current.endDate) : now;
      current.endDate = periodEnd(plan, from, payment.periods);
      current.graceEndDate = dates.addDays(current.endDate, plan.graceDays);
      current.planSnapshot = planSnapshot(plan);
      current.status = 'active';
      current.remindersSent = [];
      payment.periodStart = from;
      sub = await current.save({ session });
    } else {
      if (current && !['expired', 'cancelled'].includes(current.status)) {
        current.status = 'cancelled';
        current.cancelledAt = now;
        current.notes = `Replaced by ${plan.name} plan`;
        await current.save({ session });
      }
      const endDate = periodEnd(plan, now, payment.periods);
      [sub] = await Subscription.create([{
        tenant: tenant._id, plan: plan._id, status: 'active', startDate: now, endDate,
        graceEndDate: dates.addDays(endDate, plan.graceDays), planSnapshot: planSnapshot(plan),
      }], { session });
      tenant.currentSubscription = sub._id;
      await tenant.save({ session });
      payment.periodStart = now;
    }
    sub.status = computeStatus(sub, now);
    await sub.save({ session });

    payment.status = 'paid';
    payment.subscription = sub._id;
    payment.periodEnd = sub.endDate;
    payment.verifiedBy = platformUser._id;
    payment.verifiedAt = now;
    await payment.save({ session });
    return { payment, subscription: sub, tenant };
  }).then(async (result) => {
    await notifications.toSchool(result.tenant._id, {
      type: 'subscription', level: 'success', roles: ['school_admin', 'finance_officer'],
      title: 'Subscription payment verified',
      message: `Payment ${result.payment.reference} was verified. Your subscription is active until ${dates.formatDate(result.subscription.endDate)}.`,
      link: '/school/subscription',
    });
    return result;
  });
}

async function setPaymentStatus(paymentId, status, platformUser, notes) {
  if (!['failed', 'cancelled', 'refunded'].includes(status)) throw badRequest('Invalid status');
  const payment = await SubscriptionPayment.findById(paymentId);
  if (!payment) throw notFound('Payment');
  const allowed = { failed: ['pending'], cancelled: ['pending'], refunded: ['paid'] };
  if (!allowed[status].includes(payment.status)) throw conflict(`A ${payment.status} payment cannot be marked ${status}.`);
  payment.status = status;
  payment.verifiedBy = platformUser._id;
  payment.verifiedAt = new Date();
  if (notes) payment.notes = [payment.notes, notes].filter(Boolean).join(' | ');
  await payment.save();
  await notifications.toSchool(payment.tenant, {
    type: 'subscription', level: status === 'refunded' ? 'info' : 'danger', roles: ['school_admin', 'finance_officer'],
    title: `Subscription payment ${status}`,
    message: `Payment ${payment.reference} was marked ${status}.${notes ? ` Note: ${notes}` : ''}`,
    link: '/school/subscription',
  });
  return payment;
}

/** Platform staff: change status of the current subscription (suspend / reactivate / cancel). */
async function setSubscriptionStatus(tenantId, action) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant || !tenant.currentSubscription) throw notFound('Subscription');
  const sub = await Subscription.findById(tenant.currentSubscription);
  if (action === 'suspend') sub.status = 'suspended';
  else if (action === 'cancel') { sub.status = 'cancelled'; sub.cancelledAt = new Date(); }
  else if (action === 'reactivate') { sub.status = 'active'; sub.status = computeStatus(sub); }
  else throw badRequest('Unknown action');
  await sub.save();
  return sub;
}

/** Platform staff: extend the current subscription by N days (goodwill / support). */
async function extend(tenantId, days) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant || !tenant.currentSubscription) throw notFound('Subscription');
  const n = parseInt(days, 10);
  if (!(n >= 1 && n <= 365)) throw badRequest('Days must be between 1 and 365.');
  const sub = await Subscription.findById(tenant.currentSubscription);
  const from = new Date(sub.endDate) > new Date() ? new Date(sub.endDate) : new Date();
  sub.endDate = dates.addDays(from, n);
  sub.graceEndDate = dates.addDays(sub.endDate, (sub.planSnapshot && sub.planSnapshot.graceDays) || 0);
  if (!['suspended', 'cancelled'].includes(sub.status)) sub.status = sub.status === 'trial' ? 'trial' : 'active';
  sub.status = computeStatus(sub);
  sub.remindersSent = [];
  await sub.save();
  return sub;
}

/* ------------------------- Background refresh job ------------------------- */

/**
 * Recompute statuses and send renewal reminders. Runs on an interval from app.js and can
 * also be triggered by platform staff. Idempotent: reminders are de-duplicated.
 */
async function refreshAll(now = new Date()) {
  const subs = await Subscription.find({ status: { $nin: ['cancelled'] } }).populate('tenant', 'name currentSubscription status');
  let changed = 0;
  for (const sub of subs) {
    if (!sub.tenant || String(sub.tenant.currentSubscription) !== String(sub._id)) continue;
    const next = computeStatus(sub, now);
    if (next !== sub.status) {
      sub.status = next;
      changed += 1;
      if (next === 'expired') {
        await notifications.toSchool(sub.tenant._id, {
          type: 'subscription', level: 'danger', roles: ['school_admin', 'finance_officer'],
          title: 'Subscription expired',
          message: 'Your Quranic subscription has expired. Renew now to keep full access — your data is kept safe.',
          link: '/school/subscription', dedupeKey: `sub-expired:${sub._id}:${dates.toISODate(sub.endDate)}`,
        });
        await notifications.toPlatform({
          type: 'subscription', level: 'warning', roles: ['super_admin', 'finance_officer'],
          title: 'School subscription expired', message: `${sub.tenant.name}'s subscription expired.`,
          link: `/platform/schools/${sub.tenant._id}`, dedupeKey: `p-sub-expired:${sub._id}:${dates.toISODate(sub.endDate)}`,
        });
      }
    }
    // renewal reminders
    const daysLeft = dates.daysBetween(now, sub.endDate);
    const reminderDays = (sub.planSnapshot && sub.planSnapshot.reminderDays) || [7, 3, 1];
    for (const d of reminderDays) {
      if (daysLeft >= 0 && daysLeft <= d && !(sub.remindersSent || []).some((r) => r.daysBefore === d)) {
        await notifications.toSchool(sub.tenant._id, {
          type: 'subscription', level: 'warning', roles: ['school_admin', 'finance_officer'],
          title: `Subscription expires in ${daysLeft} day(s)`,
          message: `Your ${sub.planSnapshot ? sub.planSnapshot.name : ''} subscription ends on ${dates.formatDate(sub.endDate)}. Submit a renewal payment to avoid interruption.`,
          link: '/school/subscription', dedupeKey: `sub-reminder:${sub._id}:${dates.toISODate(sub.endDate)}:${d}`,
        });
        sub.remindersSent.push({ daysBefore: d, sentAt: now });
        changed += 1;
        break; // one reminder per run
      }
    }
    if (sub.isModified()) await sub.save();
  }
  return { checked: subs.length, changed };
}

module.exports = {
  planSnapshot, periodEnd, computeStatus, computeAccess, hasFeature, assertLimit, usage,
  createInitial, getCurrent, submitPayment, verifyPayment, setPaymentStatus, setSubscriptionStatus, extend, refreshAll,
  isObjectId: (v) => mongoose.isValidObjectId(v),
};
