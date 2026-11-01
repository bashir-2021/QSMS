'use strict';
const express = require('express');
const { asyncHandler: h } = require('../utils/errors');
const people = require('../controllers/school/peopleController');
const academic = require('../controllers/school/academicController');
const finance = require('../controllers/school/financeController');
const admin = require('../controllers/school/adminController');
const auth = require('../controllers/authController');
const v = require('../middleware/validators');
const { handleValidation: hv } = require('../middleware/validate');
const { imageUpload, attachmentUpload } = require('../middleware/upload');
const { appLimiter, authLimiter } = require('../middleware/security');
const { loadSchoolContext, subscriptionGate, requirePermission: can, requireFeature: feature } = require('../middleware/auth');
const notifications = require('../services/notificationService');

const router = express.Router();
const back = (path) => (req) => path.replace(':id', req.params.id);

/* Every school route: authenticated school session -> tenant context -> subscription policy */
router.use(appLimiter, loadSchoolContext, subscriptionGate, h(async (req, res, next) => {
  res.locals.unreadCount = await notifications.unreadCount('school', req.user, req.tenantId);
  res.locals.path = req.originalUrl;
  next();
}));

router.get('/', (req, res) => res.redirect('/school/dashboard'));
router.get('/dashboard', can('dashboard.view'), h(people.dashboard));
router.get('/files/:name', h(people.file));

/* Students */
router.get('/students', can('students.view'), feature('students'), h(people.students));
router.get('/students/search', can('students.view'), h(people.studentSearch));
router.get('/students/new', can('students.manage'), h(people.studentForm));
router.post('/students', can('students.manage'), imageUpload.single('photo'), v.student, hv('/school/students/new'), h(people.createStudent));
router.get('/students/:id', can('students.view'), h(people.studentProfile));
router.get('/students/:id/edit', can('students.manage'), h(people.studentForm));
router.post('/students/:id', can('students.manage'), imageUpload.single('photo'), v.student, hv(back('/school/students/:id/edit')), h(people.updateStudent));
router.post('/students/:id/transfer', can('students.manage'), h(people.transferStudent));
router.post('/students/:id/status', can('students.manage'), h(people.setStudentStatus));
router.post('/students/:studentId/registration-invoice', can('invoices.manage'), feature('finance'), h(finance.registrationInvoice));

/* Teachers */
router.get('/teachers', can('teachers.view'), feature('teachers'), h(people.teachers));
router.get('/teachers/new', can('teachers.manage'), h(people.teacherForm));
router.post('/teachers', can('teachers.manage'), imageUpload.single('photo'), v.teacher, hv('/school/teachers/new'), h(people.createTeacher));
router.get('/teachers/:id', can('teachers.view'), h(people.teacherProfile));
router.get('/teachers/:id/edit', can('teachers.manage'), h(people.teacherForm));
router.post('/teachers/:id', can('teachers.manage'), imageUpload.single('photo'), v.teacher, hv(back('/school/teachers/:id/edit')), h(people.updateTeacher));

/* Classes */
router.get('/classes', can('classes.view'), feature('classes'), h(people.classes));
router.get('/classes/new', can('classes.manage'), h(people.classForm));
router.post('/classes', can('classes.manage'), v.class, hv('/school/classes/new'), h(people.createClass));
router.get('/classes/:id', can('classes.view'), h(people.classDetail));
router.get('/classes/:id/edit', can('classes.manage'), h(people.classForm));
router.post('/classes/:id', can('classes.manage'), v.class, hv(back('/school/classes/:id/edit')), h(people.updateClass));
router.post('/classes/:id/enrol', can('students.manage'), h(people.enrol));

/* Lessons & progress */
router.get('/lessons', can('lessons.view'), feature('lessons'), h(academic.lessons));
router.get('/lessons/new', can('lessons.manage'), feature('lessons'), h(academic.lessonForm));
router.post('/lessons', can('lessons.manage'), feature('lessons'), v.lesson, hv('/school/lessons/new'), h(academic.createLesson));
router.get('/lessons/:id', can('lessons.view'), feature('lessons'), h(academic.lessonDetail));
router.get('/lessons/:id/edit', can('lessons.manage'), feature('lessons'), h(academic.lessonForm));
router.post('/lessons/:id', can('lessons.manage'), feature('lessons'), v.lesson, hv(back('/school/lessons/:id/edit')), h(academic.updateLesson));
router.post('/lessons/:id/progress', can('lessons.manage'), feature('lessons'), h(academic.saveProgress));
router.post('/lessons/:id/delete', can('lessons.manage'), feature('lessons'), h(academic.deleteLesson));

/* Subac & Duruus */
const act = '/activities/:type(subac|duruus)';
router.get(act, can('activities.view'), feature('activities'), h(academic.activities));
router.get(`${act}/new`, can('activities.manage'), feature('activities'), h(academic.activityForm));
router.post(act, can('activities.manage'), feature('activities'), v.activity, hv((req) => `/school/activities/${req.params.type}/new`), h(academic.createActivity));
router.get(`${act}/:id`, can('activities.view'), feature('activities'), h(academic.activityDetail));
router.get(`${act}/:id/edit`, can('activities.manage'), feature('activities'), h(academic.activityForm));
router.post(`${act}/:id`, can('activities.manage'), feature('activities'), v.activity, hv((req) => `/school/activities/${req.params.type}/${req.params.id}/edit`), h(academic.updateActivity));
router.post(`${act}/:id/participation`, can('activities.manage'), feature('activities'), h(academic.saveParticipation));
router.post(`${act}/:id/delete`, can('activities.manage'), feature('activities'), h(academic.deleteActivity));

/* Attendance */
router.get('/attendance', can('attendance.view'), feature('attendance'), h(academic.attendance));
router.post('/attendance', can('attendance.manage'), feature('attendance'), h(academic.saveAttendance));
router.get('/attendance/teachers', can('attendance.view'), feature('attendance'), h(academic.teacherAttendance));
router.post('/attendance/teachers', can('attendance.manage'), feature('attendance'), h(academic.saveTeacherAttendance));
router.get('/attendance/reports', can('attendance.view'), feature('attendance'), h(academic.attendanceReport));

/* Finance — invoices & billing */
router.get('/finance/invoices', can('invoices.view'), feature('finance'), h(finance.invoices));
router.get('/finance/invoices/new', can('invoices.manage'), feature('finance'), h(finance.invoiceForm));
router.post('/finance/invoices', can('invoices.manage'), feature('finance'), v.invoice, hv('/school/finance/invoices/new'), h(finance.createInvoice));
router.post('/finance/invoices/generate', can('invoices.manage'), feature('finance'), v.generate, hv('/school/finance/invoices'), h(finance.generate));
router.get('/finance/invoices/:id', can('invoices.view'), feature('finance'), h(finance.invoiceDetail));
router.post('/finance/invoices/:id/adjust', can('invoices.manage'), feature('finance'), v.adjust, hv(back('/school/finance/invoices/:id')), h(finance.adjustInvoice));
router.post('/finance/invoices/:id/cancel', can('invoices.manage'), feature('finance'), v.reason, hv(back('/school/finance/invoices/:id')), h(finance.cancelInvoice));

/* Finance — payments & receipts */
router.get('/finance/payments', can('payments.view'), feature('finance'), h(finance.paymentsList));
router.get('/finance/payments/new', can('payments.create'), feature('finance'), h(finance.paymentForm));
router.post('/finance/payments', can('payments.create'), feature('finance'), v.payment, hv((req) => `/school/finance/payments/new?student=${encodeURIComponent(req.body.student || '')}`), h(finance.recordPayment));
router.get('/finance/payments/:id', can('payments.view'), feature('finance'), h(finance.paymentDetail));
router.post('/finance/payments/:id/reverse', can('payments.reverse'), feature('finance'), v.reason, hv(back('/school/finance/payments/:id')), h(finance.reversePayment));
router.get('/finance/receipts', can('receipts.view'), feature('finance'), h(finance.receipts));
router.get('/finance/receipts/:id', can('receipts.view'), feature('finance'), h(finance.receipt));
router.get('/finance/receipts/:id/pdf', can('receipts.view'), feature('finance'), h(finance.receiptPrint));

/* Finance — expenses & salaries */
router.get('/finance/expenses', can('expenses.view'), feature('expenses'), h(finance.expensesList));
router.get('/finance/expenses/new', can('expenses.manage'), feature('expenses'), h(finance.expenseForm));
router.post('/finance/expenses', can('expenses.manage'), feature('expenses'), attachmentUpload.single('attachment'), v.expense, hv('/school/finance/expenses/new'), h(finance.createExpense));
router.get('/finance/expenses/:id/edit', can('expenses.manage'), feature('expenses'), h(finance.expenseForm));
router.get('/finance/expenses/:id/attachment', can('expenses.view'), feature('expenses'), h(finance.expenseAttachment));
router.post('/finance/expenses/:id', can('expenses.manage'), feature('expenses'), v.expenseEdit, hv(back('/school/finance/expenses/:id/edit')), h(finance.updateExpense));
router.post('/finance/expenses/:id/cancel', can('expenses.manage'), feature('expenses'), v.reason, hv('/school/finance/expenses'), h(finance.cancelExpense));
router.post('/finance/expenses/:id/recur', can('expenses.manage'), feature('expenses'), h(finance.recurExpense));
router.get('/finance/salaries', can('salaries.view'), feature('expenses'), h(finance.salaries));
router.post('/finance/salaries', can('salaries.manage'), feature('expenses'), v.salary, hv((req) => `/school/finance/salaries?period=${encodeURIComponent(req.body.period || '')}`), h(finance.paySalary));
router.post('/finance/salaries/:id/cancel', can('salaries.manage'), feature('expenses'), v.reason, hv('/school/finance/salaries'), h(finance.cancelSalary));

/* Financial reports */
router.get('/reports', can('reports.finance'), feature('reports'), h(finance.reportsIndex));
router.get('/reports/:key', can('reports.finance'), feature('reports'), (req, res, next) => {
  if (req.query.format && !res.locals.hasFeature('exports')) {
    req.flash('warning', 'PDF and Excel exports are not included in your plan.');
    return res.redirect(`/school/reports/${encodeURIComponent(req.params.key)}`);
  }
  return next();
}, h(finance.report));

/* Administration */
router.get('/users', can('users.manage'), h(admin.users));
router.post('/users', can('users.manage'), v.schoolUser(true), hv('/school/users'), h(admin.createUser));
router.post('/users/:id', can('users.manage'), v.schoolUser(false), hv('/school/users'), h(admin.updateUser));

router.get('/settings', can('settings.manage'), h(admin.settings));
router.post('/settings/profile', can('settings.manage'), imageUpload.single('logo'), v.profile, hv('/school/settings?tab=profile'), h(admin.saveProfile));
router.post('/settings', can('settings.manage'), v.settings, hv((req) => `/school/settings?tab=${encodeURIComponent(req.body.tab || 'fees')}`), h(admin.saveSettings));
router.post('/settings/categories', can('settings.manage'), v.category, hv('/school/settings?tab=categories'), h(admin.createCategory));
router.post('/settings/categories/:id', can('settings.manage'), h(admin.updateCategory));
router.post('/settings/categories/:id/delete', can('settings.manage'), h(admin.deleteCategory));

router.get('/subscription', h(admin.subscription));
router.post('/subscription/payments', can('subscription.manage'), v.subscriptionPayment, hv('/school/subscription'), h(admin.submitSubscriptionPayment));

router.get('/notifications', h(admin.notificationsPage));
router.post('/notifications/read', h(admin.markNotifications));
router.post('/notifications/:id/read', h(admin.markNotifications));
router.get('/audit', can('audit.view'), h(admin.auditLog));

router.get('/account', auth.accountPage('school'));
router.post('/account/password', authLimiter, v.changePassword, hv('/school/account'), h(auth.changePassword('school')));

module.exports = router;
