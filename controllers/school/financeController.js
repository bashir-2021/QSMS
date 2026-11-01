'use strict';
/** Invoices, billing, payments, receipts, expenses, salaries, financial reports. */
const ctx = require('../../utils/ctx');
const C = require('../../config/constants');
const dates = require('../../utils/dates');
const money = require('../../utils/money');
const billing = require('../../services/billingService');
const payments = require('../../services/paymentService');
const expenses = require('../../services/expenseService');
const settingsService = require('../../services/settingsService');
const reportService = require('../../services/reportService');
const exportService = require('../../services/exportService');
const receiptPdf = require('../../services/receiptPdfService');
const classService = require('../../services/classService');
const teacherService = require('../../services/teacherService');
const audit = require('../../services/auditService');
const { StudentInvoice, PaymentAllocation, Student, Expense, TeacherSalaryPayment } = require('../../models');
const { owned } = require('../../services/scope');
const { notFound } = require('../../utils/errors');

const org = (req) => ({ name: req.tenant.name, logo: req.tenant.logo, address: [req.tenant.address, req.tenant.city, req.tenant.country].filter(Boolean).join(', ') });

/* --------------------------------- Invoices ------------------------------- */
async function invoices(req, res) {
  const [page, classes] = await Promise.all([billing.list(req.tenantId, req.query), classService.all(req.tenantId)]);
  res.render('finance/invoices', { title: 'Invoices & billing', page, classes, query: req.query, nav: 'invoices', thisPeriod: dates.currentPeriod() });
}

async function invoiceForm(req, res) {
  const student = req.query.student ? await owned(Student, req.tenantId, req.query.student, 'Student') : null;
  res.render('finance/invoice-form', { title: 'New invoice', student, nav: 'invoices', thisPeriod: dates.currentPeriod() });
}

async function createInvoice(req, res) {
  const inv = await billing.createOther(ctx(req), req.body);
  await audit.school(req, 'invoice.create', { entity: 'StudentInvoice', entityId: inv._id, details: { invoiceNo: inv.invoiceNo, total: inv.total } });
  req.flash('success', `Invoice ${inv.invoiceNo} created.`);
  res.redirect(`/school/finance/invoices/${inv._id}`);
}

async function invoiceDetail(req, res) {
  const inv = await owned(StudentInvoice, req.tenantId, req.params.id, 'Invoice', {
    populate: [{ path: 'student', select: 'fullName studentCode guardianName guardianPhone' }, { path: 'class', select: 'name' }],
  });
  const allocations = await PaymentAllocation.find({ tenantId: req.tenantId, invoice: inv._id })
    .populate({ path: 'payment', select: 'paymentNo paymentDate method status receipt', populate: { path: 'receipt', select: 'receiptNo' } }).lean();
  res.render('finance/invoice', { title: `Invoice ${inv.invoiceNo}`, inv, allocations, nav: 'invoices' });
}

async function generate(req, res) {
  const r = await billing.generateMonthly(ctx(req), req.body.period, { classId: req.body.class || undefined });
  await audit.school(req, 'billing.generate', { details: { period: req.body.period, ...r } });
  req.flash(r.created ? 'success' : 'info',
    `${dates.periodLabel(req.body.period)}: ${r.created} bill(s) created (${money.format(r.total, req.settings.currency)}), ${r.skipped} already billed${r.zeroFee ? `, ${r.zeroFee} skipped with no fee configured` : ''}.`);
  res.redirect(`/school/finance/invoices?period=${req.body.period}&type=monthly`);
}

async function registrationInvoice(req, res) {
  const student = await owned(Student, req.tenantId, req.params.studentId, 'Student');
  const inv = await billing.createRegistrationInvoice(ctx(req), student);
  await audit.school(req, 'invoice.create', { entity: 'StudentInvoice', entityId: inv._id, details: { invoiceNo: inv.invoiceNo, type: 'registration' } });
  req.flash('success', `Registration invoice ${inv.invoiceNo} created.`);
  res.redirect(`/school/students/${student._id}`);
}

async function adjustInvoice(req, res) {
  const { inv, before } = await billing.adjust(ctx(req), req.params.id, req.body);
  await audit.school(req, 'invoice.adjust', { entity: 'StudentInvoice', entityId: inv._id, details: { before, after: { discount: inv.discount, adjustment: inv.adjustment, total: inv.total }, reason: req.body.reason } });
  req.flash('success', 'Invoice adjusted.');
  res.redirect(`/school/finance/invoices/${inv._id}`);
}

async function cancelInvoice(req, res) {
  const inv = await billing.cancel(ctx(req), req.params.id, req.body.reason);
  await audit.school(req, 'invoice.cancel', { entity: 'StudentInvoice', entityId: inv._id, details: { invoiceNo: inv.invoiceNo, reason: req.body.reason } });
  req.flash('success', `Invoice ${inv.invoiceNo} cancelled.`);
  res.redirect(`/school/finance/invoices/${inv._id}`);
}

/* --------------------------------- Payments ------------------------------- */
async function paymentsList(req, res) {
  res.render('finance/payments', { title: 'Student payments', page: await payments.list(req.tenantId, req.query), query: req.query, nav: 'payments' });
}

async function paymentForm(req, res) {
  let student = null;
  let open = [];
  if (req.query.student) {
    student = await owned(Student, req.tenantId, req.query.student, 'Student', { populate: { path: 'class', select: 'name' } });
    open = await StudentInvoice.find({ tenantId: req.tenantId, student: student._id, status: { $in: billing.OPEN } }).sort({ issueDate: 1 }).lean();
  }
  res.render('finance/payment-form', { title: 'Receive payment', student, open, preselect: [].concat(req.query.invoice || []), nav: 'payments', today: dates.toISODate(new Date()) });
}

async function recordPayment(req, res) {
  const { payment, receipt } = await payments.record(ctx(req), req, req.body);
  req.flash('success', `Payment of ${money.format(payment.amount, req.settings.currency)} recorded. Receipt ${receipt.receiptNo}.`);
  res.redirect(`/school/finance/receipts/${receipt._id}`);
}

async function paymentDetail(req, res) {
  const data = await payments.detail(req.tenantId, req.params.id);
  res.render('finance/payment', { title: `Payment ${data.payment.paymentNo}`, ...data, nav: 'payments' });
}

async function reversePayment(req, res) {
  const p = await payments.reverse(ctx(req), req, req.params.id, req.body.reason);
  req.flash('success', `Payment ${p.paymentNo} reversed; the receipt is now void.`);
  res.redirect(`/school/finance/payments/${p._id}`);
}

/* --------------------------------- Receipts ------------------------------- */
async function receipts(req, res) {
  res.render('finance/receipts', { title: 'Receipts', page: await payments.listReceipts(req.tenantId, req.query), query: req.query, nav: 'receipts' });
}
async function receipt(req, res) {
  const r = await payments.getReceipt(req.tenantId, req.params.id);
  res.render('finance/receipt', { title: `Receipt ${r.receiptNo}`, r, nav: 'receipts' });
}
async function receiptPrint(req, res) {
  const r = await payments.getReceipt(req.tenantId, req.params.id);
  await payments.markPrinted(req.tenantId, r._id);
  await audit.school(req, 'receipt.print', { entity: 'StudentReceipt', entityId: r._id, details: { receiptNo: r.receiptNo, copy: (r.printCount || 0) + 1 } });
  receiptPdf.stream(res, r, { download: req.query.download === '1' });
}

/* --------------------------------- Expenses ------------------------------- */
async function expensesList(req, res) {
  const [page, categories, due] = await Promise.all([
    expenses.list(req.tenantId, req.query), settingsService.listCategories(req.tenantId), expenses.dueRecurring(req.tenantId),
  ]);
  const total = money.sum(page.items.filter((e) => e.status === 'recorded'), 'amount');
  res.render('finance/expenses', { title: 'Expenses', page, categories, due, total, query: req.query, nav: 'expenses', today: dates.toISODate(new Date()) });
}
async function expenseForm(req, res) {
  const [expense, categories] = await Promise.all([
    req.params.id ? owned(Expense, req.tenantId, req.params.id, 'Expense', { populate: { path: 'category', select: 'name' } }) : null,
    settingsService.listCategories(req.tenantId, { activeOnly: true }),
  ]);
  res.render('finance/expense-form', { title: expense ? `Expense ${expense.expenseNo}` : 'Record expense', expense, categories: categories.filter((c) => c.name !== C.SALARY_CATEGORY), nav: 'expenses', today: dates.toISODate(new Date()) });
}
async function createExpense(req, res) {
  const e = await expenses.create(ctx(req), req, req.body, req.file);
  req.flash('success', `Expense ${e.expenseNo} recorded.`);
  res.redirect('/school/finance/expenses');
}
async function updateExpense(req, res) {
  const e = await expenses.update(ctx(req), req, req.params.id, req.body);
  req.flash('success', `Expense ${e.expenseNo} updated.`);
  res.redirect('/school/finance/expenses');
}
async function cancelExpense(req, res) {
  const e = await expenses.cancel(ctx(req), req, req.params.id, req.body.reason);
  req.flash('success', `Expense ${e.expenseNo} cancelled.`);
  res.redirect('/school/finance/expenses');
}
async function recurExpense(req, res) {
  const e = await expenses.recordRecurrence(ctx(req), req, req.params.id, req.body.date);
  req.flash('success', `Recurring expense recorded as ${e.expenseNo}.`);
  res.redirect('/school/finance/expenses');
}
async function expenseAttachment(req, res) {
  const e = await owned(Expense, req.tenantId, req.params.id, 'Expense');
  if (!e.attachment) throw notFound('Attachment');
  res.redirect(`/school/files/${e.attachment.split('/').pop()}`);
}

/* --------------------------------- Salaries ------------------------------- */
async function salaries(req, res) {
  const period = dates.isPeriod(req.query.period) ? req.query.period : dates.currentPeriod();
  const [sheet, history, teachers] = await Promise.all([
    expenses.payroll(req.tenantId, period),
    expenses.listSalaries(req.tenantId, { ...req.query, period: req.query.history === 'all' ? undefined : period }),
    teacherService.all(req.tenantId),
  ]);
  res.render('finance/salaries', {
    title: 'Teacher salaries', period, sheet, history, teachers, query: req.query, nav: 'salaries', today: dates.toISODate(new Date()),
    paidTotal: money.sum(sheet.filter((r) => r.payment).map((r) => r.payment.amount)),
    dueTotal: money.sum(sheet.filter((r) => !r.payment).map((r) => r.teacher.monthlySalary || 0)),
  });
}
async function paySalary(req, res) {
  const s = await expenses.paySalary(ctx(req), req, req.body);
  req.flash('success', `Salary paid (${money.format(s.amount, req.settings.currency)}).`);
  res.redirect(`/school/finance/salaries?period=${s.period}`);
}
async function cancelSalary(req, res) {
  const s = await expenses.cancelSalary(ctx(req), req, req.params.id, req.body.reason);
  req.flash('success', 'Salary payment cancelled and its expense reversed.');
  res.redirect(`/school/finance/salaries?period=${s.period}`);
}

/* --------------------------------- Reports -------------------------------- */
async function reportsIndex(req, res) {
  res.render('finance/reports', { title: 'Financial reports', reports: reportService.REPORTS, nav: 'reports' });
}
async function report(req, res) {
  const r = await reportService.build(req.tenantId, req.params.key, req.query);
  if (!r) throw notFound('Report');
  if (await exportService.respond(req, res, r, { org: org(req), currency: req.settings.currency })) {
    await audit.school(req, 'report.export', { details: { report: req.params.key, format: req.query.format } });
    return;
  }
  const [classes, methods] = [await classService.all(req.tenantId), req.settings.paymentMethods || []];
  res.render('reports/view', {
    title: r.title, report: r, reportKey: req.params.key, base: '/school/reports', currencyCode: req.settings.currency,
    classes, methods, nav: 'reports', filterView: 'finance/report-filters',
  });
}

module.exports = {
  invoices, invoiceForm, createInvoice, invoiceDetail, generate, registrationInvoice, adjustInvoice, cancelInvoice,
  paymentsList, paymentForm, recordPayment, paymentDetail, reversePayment, receipts, receipt, receiptPrint,
  expensesList, expenseForm, createExpense, updateExpense, cancelExpense, recurExpense, expenseAttachment,
  salaries, paySalary, cancelSalary, reportsIndex, report, TeacherSalaryPayment,
};
