'use strict';
/** School users, settings, expense categories, subscription, notifications, audit log. */
const ctx = require('../../utils/ctx');
const C = require('../../config/constants');
const { SCHOOL_ROLES } = require('../../config/roles');
const { SchoolAuditLog, SubscriptionPayment } = require('../../models');
const userService = require('../../services/userService');
const settingsService = require('../../services/settingsService');
const teacherService = require('../../services/teacherService');
const subscriptionService = require('../../services/subscriptionService');
const platformService = require('../../services/platformService');
const notifications = require('../../services/notificationService');
const audit = require('../../services/auditService');
const { paginate } = require('../../utils/paginate');

/* ---------------------------------- Users --------------------------------- */
async function users(req, res) {
  const [list, teachers, usage] = await Promise.all([
    userService.listSchoolUsers(req.tenantId), teacherService.all(req.tenantId),
    subscriptionService.usage(req.subscription, req.tenantId),
  ]);
  res.render('school/users', { title: 'Users & roles', users: list, teachers, roles: SCHOOL_ROLES, usage, nav: 'users' });
}
async function createUser(req, res) {
  const u = await userService.createSchoolUser(ctx(req), req.body);
  await audit.school(req, 'user.create', { entity: 'SchoolUser', entityId: u._id, details: { email: u.email, role: u.role } });
  req.flash('success', req.t('{name} can now sign in as {role}.', { name: u.name, role: req.t(SCHOOL_ROLES[u.role].label) }));
  res.redirect('/school/users');
}
async function updateUser(req, res) {
  const u = await userService.updateSchoolUser(ctx(req), req.params.id, req.body);
  await audit.school(req, 'user.update', { entity: 'SchoolUser', entityId: u._id, details: { role: u.role, isActive: u.isActive, passwordReset: Boolean(req.body.password) } });
  req.flash('success', req.t('{name} updated.', { name: u.name }));
  res.redirect('/school/users');
}

/* -------------------------------- Settings -------------------------------- */
async function settings(req, res) {
  const [s, categories] = await Promise.all([settingsService.get(req.tenantId), settingsService.listCategories(req.tenantId)]);
  res.render('school/settings', { title: 'School settings', s: s.toObject(), categories, nav: 'settings', tab: req.query.tab || 'profile' });
}
async function saveProfile(req, res) {
  await settingsService.updateProfile(req.tenantId, req.body, req.file);
  await audit.school(req, 'settings.profile');
  req.flash('success', 'School profile saved.');
  res.redirect('/school/settings?tab=profile');
}
async function saveSettings(req, res) {
  await settingsService.updateSettings(req.tenantId, req.body);
  await audit.school(req, 'settings.update', { details: { registrationFee: req.body.registrationFee, monthlyFee: req.body.monthlyFee, currency: req.body.currency } });
  req.flash('success', 'Settings saved.');
  res.redirect(`/school/settings?tab=${req.body.tab || 'fees'}`);
}
async function saveSubacDeductions(req, res) {
  await settingsService.updateSubacDeductions(req.tenantId, req.body);
  await audit.school(req, 'settings.subac');
  req.flash('success', 'Settings saved.');
  res.redirect('/school/settings?tab=subac');
}
async function createCategory(req, res) {
  await settingsService.createCategory(req.tenantId, req.body);
  req.flash('success', 'Category added.');
  res.redirect('/school/settings?tab=categories');
}
async function updateCategory(req, res) {
  await settingsService.updateCategory(req.tenantId, req.params.id, req.body);
  req.flash('success', 'Category updated.');
  res.redirect('/school/settings?tab=categories');
}
async function deleteCategory(req, res) {
  await settingsService.deleteCategory(req.tenantId, req.params.id);
  req.flash('success', 'Category deleted.');
  res.redirect('/school/settings?tab=categories');
}

/* ------------------------------ Subscription ------------------------------ */
async function subscription(req, res) {
  const [plans, payments, usage] = await Promise.all([
    platformService.listPlans(false),
    SubscriptionPayment.find({ tenant: req.tenantId }).populate('plan', 'name').sort({ createdAt: -1 }).limit(20).lean(),
    subscriptionService.usage(req.subscription, req.tenantId),
  ]);
  res.render('subscriptions/index', { title: 'Subscription', plans, payments, usage, methods: C.PLATFORM_PAYMENT_METHODS, nav: 'subscription' });
}
async function submitSubscriptionPayment(req, res) {
  const p = await subscriptionService.submitPayment(req.tenantId, req.body, { kind: 'school', userId: req.user._id, name: req.user.name });
  await audit.school(req, 'subscription.payment_submit', { entity: 'SubscriptionPayment', entityId: p._id, details: { reference: p.reference, amount: p.amount } });
  req.flash('success', req.t('Payment {reference} submitted. Your subscription will be updated as soon as Quranic verifies it.', { reference: p.reference }));
  res.redirect('/school/subscription');
}

/* ------------------------------ Notifications ----------------------------- */
async function notificationsPage(req, res) {
  const items = await notifications.listFor('school', req.user, req.tenantId);
  res.render('school/notifications', { title: 'Notifications', items, nav: 'notifications' });
}
async function markNotifications(req, res) {
  await notifications.markRead('school', req.user, req.tenantId, req.params.id);
  const back = req.body.redirect && req.body.redirect.startsWith('/school/') ? req.body.redirect : '/school/notifications';
  res.redirect(back);
}

/* -------------------------------- Audit log ------------------------------- */
async function auditLog(req, res) {
  const f = { tenantId: req.tenantId };
  if (req.query.action) f.action = new RegExp(`^${String(req.query.action).replace(/[^a-z_.]/gi, '')}`);
  const page = await paginate(SchoolAuditLog, f, { page: req.query.page, limit: 40, sort: { createdAt: -1 } });
  res.render('school/audit', { title: 'Audit log', page, query: req.query, nav: 'audit' });
}

module.exports = {
  users, createUser, updateUser, settings, saveProfile, saveSettings, saveSubacDeductions, createCategory, updateCategory, deleteCategory,
  subscription, submitSubscriptionPayment, notificationsPage, markNotifications, auditLog,
};
