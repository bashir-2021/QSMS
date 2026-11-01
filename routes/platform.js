'use strict';
const express = require('express');
const { asyncHandler: h } = require('../utils/errors');
const p = require('../controllers/platformController');
const auth = require('../controllers/authController');
const v = require('../middleware/validators');
const { handleValidation } = require('../middleware/validate');
const { imageUpload } = require('../middleware/upload');
const { authLimiter, appLimiter } = require('../middleware/security');
const { loadPlatformContext, requirePermission: can, redirectIfAuthenticated } = require('../middleware/auth');
const notifications = require('../services/notificationService');

const router = express.Router();

/* Public platform login */
router.get('/login', redirectIfAuthenticated, auth.platformLoginForm);
router.post('/login', authLimiter, v.login, handleValidation('/platform/login'), h(auth.platformLogin));

/* Everything below requires a platform staff session (separate from school sessions) */
router.use(appLimiter, loadPlatformContext, h(async (req, res, next) => {
  // every platform page uses the platform layout unless a view asks for another
  const render = res.render.bind(res);
  res.render = (view, opts, cb) => render(view, { layout: 'layouts/platform', ...(opts || {}) }, cb);
  res.locals.unreadCount = await notifications.unreadCount('platform', req.user, null);
  res.locals.path = req.originalUrl;
  next();
}));

router.get('/', (req, res) => res.redirect('/platform/dashboard'));
router.get('/dashboard', can('platform.dashboard'), h(p.dashboard));

router.get('/schools', can('schools.view'), h(p.schools));
router.get('/schools/new', can('schools.manage'), h(p.newSchoolForm));
router.post('/schools', can('schools.manage'), imageUpload.single('logo'), v.register, handleValidation('/platform/schools/new'), h(p.createSchool));
router.get('/schools/:id', can('schools.view'), h(p.school));
router.post('/schools/:id/status/:action', can('schools.status'), h(p.setSchoolStatus));
router.post('/schools/:id/subscription/:action(suspend|reactivate|cancel|extend)', can('subscriptions.manage'), h(p.subscriptionAction));
router.post('/schools/:id/payments', can('payments.verify'), v.subscriptionPayment, handleValidation((req) => `/platform/schools/${req.params.id}`), h(p.recordPaymentForSchool));

router.get('/plans', can('plans.view'), h(p.plans));
router.get('/plans/new', can('plans.manage'), h(p.planForm));
router.post('/plans', can('plans.manage'), v.plan, handleValidation('/platform/plans/new'), h(p.savePlan));
router.get('/plans/:id/edit', can('plans.manage'), h(p.planForm));
router.post('/plans/:id', can('plans.manage'), v.plan, handleValidation((req) => `/platform/plans/${req.params.id}/edit`), h(p.savePlan));

router.get('/subscriptions', can('subscriptions.view'), h(p.subscriptions));
router.post('/subscriptions/refresh', can('subscriptions.manage'), h(p.runJobs));

router.get('/payments', can('payments.view'), h(p.payments));
router.get('/payments/:id', can('payments.view'), h(p.payment));
router.post('/payments/:id/verify', can('payments.verify'), h(p.verifyPayment));
router.post('/payments/:id/status/:status(failed|cancelled|refunded)', can('payments.verify'), h(p.setPaymentStatus));

router.get('/reports', can('reports.view'), h(p.reports));
router.get('/reports/:key', can('reports.view'), h(p.report));

router.get('/staff', can('staff.manage'), h(p.staff));
router.post('/staff', can('staff.manage'), v.platformUser(true), handleValidation('/platform/staff'), h(p.createStaff));
router.post('/staff/:id', can('staff.manage'), v.platformUser(false), handleValidation('/platform/staff'), h(p.updateStaff));

router.get('/audit', can('audit.view'), h(p.auditLogs));
router.get('/notifications', h(p.notificationsPage));
router.post('/notifications/read', h(p.markNotifications));
router.post('/notifications/:id/read', h(p.markNotifications));

router.get('/account', auth.accountPage('platform'));
router.post('/account/password', authLimiter, v.changePassword, handleValidation('/platform/account'), h(auth.changePassword('platform')));

module.exports = router;
