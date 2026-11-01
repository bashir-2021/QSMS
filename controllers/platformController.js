'use strict';
const { runInTransaction } = require('../config/db');
const C = require('../config/constants');
const { PLATFORM_ROLES } = require('../config/roles');
const { SubscriptionPlan, SubscriptionPayment, Tenant, PlatformAuditLog } = require('../models');
const platformService = require('../services/platformService');
const subscriptionService = require('../services/subscriptionService');
const tenantService = require('../services/tenantService');
const userService = require('../services/userService');
const notifications = require('../services/notificationService');
const exportService = require('../services/exportService');
const jobService = require('../services/jobService');
const audit = require('../services/auditService');
const { paginate } = require('../utils/paginate');
const { notFound } = require('../utils/errors');
const dates = require('../utils/dates');

/* -------------------------------- Dashboard ------------------------------- */
async function dashboard(req, res) {
  res.render('superadmin/dashboard', { title: 'Platform dashboard', data: await platformService.dashboard(), nav: 'dashboard' });
}

/* --------------------------------- Schools -------------------------------- */
async function schools(req, res) {
  res.render('superadmin/schools', { title: 'Schools', page: await platformService.listSchools(req.query), query: req.query, nav: 'schools' });
}

async function newSchoolForm(req, res) {
  res.render('superadmin/school-new', { title: 'Register a school', plans: await platformService.listPlans(true), nav: 'schools' });
}

async function createSchool(req, res) {
  const { tenant } = await tenantService.registerSchool(req.body, req.file);
  await audit.platform(req, 'school.create', { entity: 'Tenant', entityId: tenant._id, tenant: tenant._id });
  req.flash('success', `${tenant.name} registered.`);
  res.redirect(`/platform/schools/${tenant._id}`);
}

async function school(req, res) {
  const detail = await platformService.schoolDetail(req.params.id);
  const [usage, plans] = await Promise.all([
    tenantService.usageStats(detail.tenant._id),
    platformService.listPlans(true),
  ]);
  const sub = detail.tenant.currentSubscription;
  res.render('superadmin/school', {
    title: detail.tenant.name, ...detail, usage, plans, nav: 'schools',
    access: subscriptionService.computeAccess(detail.tenant, sub),
    limits: sub && sub.planSnapshot ? sub.planSnapshot.limits : {},
  });
}

async function setSchoolStatus(req, res) {
  const status = { activate: 'active', reactivate: 'active', deactivate: 'inactive', suspend: 'suspended' }[req.params.action];
  if (!status) throw notFound('Action');
  const tenant = await tenantService.setStatus(req.params.id, status, req.body.reason);
  await audit.platform(req, `school.${req.params.action}`, { entity: 'Tenant', entityId: tenant._id, tenant: tenant._id, details: { reason: req.body.reason } });
  req.flash('success', `${tenant.name} is now ${status}.`);
  res.redirect(`/platform/schools/${tenant._id}`);
}

async function subscriptionAction(req, res) {
  const { id, action } = req.params;
  if (action === 'extend') {
    const sub = await subscriptionService.extend(id, req.body.days);
    req.flash('success', `Subscription extended to ${dates.formatDate(sub.endDate)}.`);
  } else {
    await subscriptionService.setSubscriptionStatus(id, action);
    req.flash('success', `Subscription ${action === 'reactivate' ? 'reactivated' : `${action}ed`}.`);
  }
  await audit.platform(req, `subscription.${action}`, { entity: 'Tenant', entityId: id, tenant: id, details: req.body });
  res.redirect(`/platform/schools/${id}`);
}

/** Platform staff record a payment for a school (e.g. received by bank transfer). */
async function recordPaymentForSchool(req, res) {
  const payment = await subscriptionService.submitPayment(req.params.id, req.body, { kind: 'platform', userId: req.user._id, name: req.user.name });
  await audit.platform(req, 'payment.record', { entity: 'SubscriptionPayment', entityId: payment._id, tenant: req.params.id });
  req.flash('success', `Payment ${payment.reference} recorded as pending. Verify it to activate the subscription.`);
  res.redirect(`/platform/payments/${payment._id}`);
}

/* ---------------------------------- Plans --------------------------------- */
async function plans(req, res) {
  res.render('superadmin/plans', { title: 'Subscription plans', plans: await platformService.listPlans(true), nav: 'plans' });
}
async function planForm(req, res) {
  const plan = req.params.id ? await SubscriptionPlan.findById(req.params.id).lean() : null;
  if (req.params.id && !plan) throw notFound('Plan');
  res.render('superadmin/plan-form', { title: plan ? `Edit ${plan.name}` : 'New plan', plan, nav: 'plans' });
}
async function savePlan(req, res) {
  const plan = await platformService.savePlan(req.params.id, req.body);
  await audit.platform(req, req.params.id ? 'plan.update' : 'plan.create', { entity: 'SubscriptionPlan', entityId: plan._id, details: { name: plan.name, price: plan.price } });
  req.flash('success', `Plan ${plan.name} saved. Existing subscriptions keep their terms until renewal.`);
  res.redirect('/platform/plans');
}

/* -------------------------------- Payments -------------------------------- */
async function payments(req, res) {
  res.render('superadmin/payments', { title: 'Subscription payments', page: await platformService.listPayments(req.query), query: req.query, nav: 'payments' });
}
async function payment(req, res) {
  const p = await SubscriptionPayment.findById(req.params.id).populate('tenant').populate('plan').populate('verifiedBy', 'name').populate('subscription').lean();
  if (!p) throw notFound('Payment');
  res.render('superadmin/payment', { title: `Payment ${p.reference}`, p, nav: 'payments' });
}
async function verifyPayment(req, res) {
  const { payment: p, subscription } = await subscriptionService.verifyPayment(req.params.id, req.user, runInTransaction);
  await audit.platform(req, 'payment.verify', { entity: 'SubscriptionPayment', entityId: p._id, tenant: p.tenant, details: { amount: p.amount, endDate: subscription.endDate } });
  req.flash('success', `Payment verified. Subscription active until ${dates.formatDate(subscription.endDate)}.`);
  res.redirect(`/platform/payments/${p._id}`);
}
async function setPaymentStatus(req, res) {
  const p = await subscriptionService.setPaymentStatus(req.params.id, req.params.status, req.user, req.body.notes);
  await audit.platform(req, `payment.${req.params.status}`, { entity: 'SubscriptionPayment', entityId: p._id, tenant: p.tenant, details: { notes: req.body.notes } });
  req.flash('success', `Payment marked ${req.params.status}.`);
  res.redirect(`/platform/payments/${p._id}`);
}

/* ------------------------------ Subscriptions ----------------------------- */
async function subscriptions(req, res) {
  const report = await platformService.buildReport('subscriptions', {});
  const rows = report.sections[0].rows;
  const status = req.query.status;
  res.render('superadmin/subscriptions', {
    title: 'Subscriptions', rows: status ? rows.filter((r) => r.status === status) : rows, summary: report.summary, query: req.query, nav: 'subscriptions',
  });
}
async function runJobs(req, res) {
  const r = await jobService.runOnce();
  await audit.platform(req, 'jobs.run', { details: r });
  req.flash('success', `Refreshed ${r.checked} subscriptions (${r.changed} updated), marked ${r.overdueMarked} overdue invoices.`);
  res.redirect('/platform/subscriptions');
}

/* --------------------------------- Reports -------------------------------- */
async function reports(req, res) {
  res.render('superadmin/reports', { title: 'Platform reports', reports: platformService.REPORTS, nav: 'reports' });
}
async function report(req, res) {
  const r = await platformService.buildReport(req.params.key, req.query);
  if (!r) throw notFound('Report');
  const org = { name: 'Quranic Platform' };
  if (await exportService.respond(req, res, r, { org, currency: 'USD' })) return;
  res.render('reports/view', { title: r.title, report: r, reportKey: req.params.key, base: '/platform/reports', currencyCode: 'USD', nav: 'reports', filterView: 'superadmin/report-filters' });
}

/* ---------------------------------- Staff --------------------------------- */
async function staff(req, res) {
  res.render('superadmin/staff', { title: 'Platform staff', users: await userService.listPlatformUsers(), roles: PLATFORM_ROLES, nav: 'staff' });
}
async function createStaff(req, res) {
  const u = await userService.createPlatformUser(req.body);
  await audit.platform(req, 'staff.create', { entity: 'PlatformUser', entityId: u._id, details: { email: u.email, role: u.role } });
  req.flash('success', `${u.name} added.`);
  res.redirect('/platform/staff');
}
async function updateStaff(req, res) {
  const u = await userService.updatePlatformUser(req.user, req.params.id, req.body);
  await audit.platform(req, 'staff.update', { entity: 'PlatformUser', entityId: u._id, details: { role: u.role, isActive: u.isActive } });
  req.flash('success', `${u.name} updated.`);
  res.redirect('/platform/staff');
}

/* ------------------------- Audit logs & notifications --------------------- */
async function auditLogs(req, res) {
  const page = await paginate(PlatformAuditLog, {}, { page: req.query.page, limit: 40, sort: { createdAt: -1 }, populate: { path: 'tenant', select: 'name' } });
  res.render('superadmin/audit', { title: 'Audit log', page, query: req.query, nav: 'audit' });
}
async function notificationsPage(req, res) {
  const items = await notifications.listFor('platform', req.user, null);
  res.render('superadmin/notifications', { title: 'Notifications', items, nav: 'notifications' });
}
async function markNotifications(req, res) {
  await notifications.markRead('platform', req.user, null, req.params.id);
  res.redirect(req.body.redirect && req.body.redirect.startsWith('/platform/') ? req.body.redirect : '/platform/notifications');
}

module.exports = {
  dashboard, schools, newSchoolForm, createSchool, school, setSchoolStatus, subscriptionAction, recordPaymentForSchool,
  plans, planForm, savePlan, payments, payment, verifyPayment, setPaymentStatus, subscriptions, runJobs,
  reports, report, staff, createStaff, updateStaff, auditLogs, notificationsPage, markNotifications, C,
};
