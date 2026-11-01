'use strict';
const { runInTransaction } = require('../config/db');
const { Expense, ExpenseCategory, TeacherSalaryPayment, Teacher } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const money = require('../utils/money');
const { paginate, escapeRegex } = require('../utils/paginate');
const { badRequest, conflict } = require('../utils/errors');
const { owned } = require('./scope');
const sequence = require('./sequenceService');
const audit = require('./auditService');
const { persistUpload } = require('../middleware/upload');

const FREQ_MONTHS = { monthly: 1, quarterly: 3, annual: 12 };

function nextDue(date, frequency) {
  return frequency && FREQ_MONTHS[frequency] ? dates.addMonths(date, FREQ_MONTHS[frequency]) : undefined;
}

async function expenseNo(ctx, session) {
  return sequence.next(ctx.tenantId, 'expense', ctx.settings.numbering && ctx.settings.numbering.expense, { session });
}

async function create(ctx, req, data, file) {
  const category = await owned(ExpenseCategory, ctx.tenantId, data.category, 'Expense category');
  if (!category.isActive) throw badRequest('This category is inactive.');
  if (category.isSystem && category.name === C.SALARY_CATEGORY && !data.allowSalaryCategory) {
    throw badRequest('Record teacher salaries from the Salaries page so they are linked to the teacher.');
  }
  const amount = money.toMinor(data.amount);
  if (!amount || amount <= 0) throw badRequest('Enter a valid amount.');
  const expenseDate = dates.parseDay(data.expenseDate) || dates.startOfDay();
  const recurring = data.recurring === 'on' && FREQ_MONTHS[data.frequency]
    ? { enabled: true, frequency: data.frequency, nextDueDate: nextDue(expenseDate, data.frequency) }
    : { enabled: false };

  const expense = new Expense({
    tenantId: ctx.tenantId, category: category._id, description: data.description, amount, expenseDate,
    method: data.method, recipient: data.recipient, reference: data.reference, recurring,
    recordedBy: ctx.user._id, recordedByName: ctx.user.name, expenseNo: await expenseNo(ctx),
  });
  if (file) {
    expense.attachment = persistUpload(file, ctx.tenantId, 'expense');
    expense.attachmentName = String(file.originalname || 'attachment').slice(0, 120);
  }
  await expense.save();
  await audit.school(req, 'expense.create', { entity: 'Expense', entityId: expense._id, details: { expenseNo: expense.expenseNo, amount, category: category.name } });
  return expense;
}

/** Edits are limited to descriptive fields; amount/date changes require cancel + re-record. */
async function update(ctx, req, id, data) {
  const e = await owned(Expense, ctx.tenantId, id, 'Expense', { lean: false });
  if (e.status === 'cancelled') throw badRequest('Cancelled expenses cannot be edited.');
  ['description', 'method', 'recipient', 'reference'].forEach((k) => { if (data[k] !== undefined) e[k] = data[k]; });
  if (!e.salaryPayment) {
    if (data.recurring === 'on' && FREQ_MONTHS[data.frequency]) {
      e.recurring = { enabled: true, frequency: data.frequency, nextDueDate: e.recurring && e.recurring.nextDueDate ? e.recurring.nextDueDate : nextDue(e.expenseDate, data.frequency) };
    } else {
      e.recurring = { enabled: false };
    }
  }
  await e.save();
  await audit.school(req, 'expense.update', { entity: 'Expense', entityId: e._id, details: { expenseNo: e.expenseNo } });
  return e;
}

async function cancel(ctx, req, id, reason) {
  if (!reason || reason.trim().length < 3) throw badRequest('A reason is required to cancel an expense.');
  const e = await owned(Expense, ctx.tenantId, id, 'Expense', { lean: false });
  if (e.status === 'cancelled') throw badRequest('Expense already cancelled.');
  if (e.salaryPayment) throw badRequest('This expense belongs to a salary payment. Cancel it from the Salaries page.');
  e.status = 'cancelled';
  e.cancelled = { at: new Date(), by: ctx.user._id, byName: ctx.user.name, reason };
  e.recurring = { enabled: false };
  await e.save();
  await audit.school(req, 'expense.cancel', { entity: 'Expense', entityId: e._id, details: { expenseNo: e.expenseNo, amount: e.amount, reason } });
  return e;
}

/** Record the next occurrence of a recurring expense (copy with a new date) and roll the schedule. */
async function recordRecurrence(ctx, req, id, dateStr) {
  const src = await owned(Expense, ctx.tenantId, id, 'Expense', { lean: false });
  if (!src.recurring || !src.recurring.enabled || src.status !== 'recorded') throw badRequest('This expense is not an active recurring expense.');
  const date = dates.parseDay(dateStr) || dates.startOfDay();
  const copy = await Expense.create({
    tenantId: ctx.tenantId, category: src.category, description: src.description, amount: src.amount,
    expenseDate: date, method: src.method, recipient: src.recipient,
    recurring: { enabled: true, frequency: src.recurring.frequency, nextDueDate: nextDue(date, src.recurring.frequency) },
    recordedBy: ctx.user._id, recordedByName: ctx.user.name, expenseNo: await expenseNo(ctx),
  });
  src.recurring = { enabled: false };
  await src.save();
  await audit.school(req, 'expense.recurring', { entity: 'Expense', entityId: copy._id, details: { from: src.expenseNo, expenseNo: copy.expenseNo } });
  return copy;
}

function buildFilter(tenantId, q = {}) {
  const f = { tenantId };
  if (['recorded', 'cancelled'].includes(q.status)) f.status = q.status;
  if (q.category && /^[a-f0-9]{24}$/i.test(q.category)) f.category = q.category;
  if (q.from || q.to) {
    const r = dates.rangeFromQuery(q);
    f.expenseDate = { $gte: r.from, $lte: r.to };
  }
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    f.$or = [{ description: rx }, { recipient: rx }, { expenseNo: rx }, { reference: rx }];
  }
  return f;
}

function list(tenantId, q) {
  return paginate(Expense, buildFilter(tenantId, q), {
    page: q.page, limit: q.limit || 25, sort: { expenseDate: -1, createdAt: -1 }, populate: { path: 'category', select: 'name' },
  });
}

function dueRecurring(tenantId) {
  return Expense.find({ tenantId, status: 'recorded', 'recurring.enabled': true, 'recurring.nextDueDate': { $lte: dates.addDays(new Date(), 7) } })
    .populate('category', 'name').sort({ 'recurring.nextDueDate': 1 }).lean();
}

/* ------------------------------ Teacher salaries --------------------------- */

/**
 * Pay a teacher's salary for a month. Creates the salary record and the linked expense
 * (category "Teacher salaries") atomically. One live salary payment per teacher per month.
 */
async function paySalary(ctx, req, data) {
  const teacher = await owned(Teacher, ctx.tenantId, data.teacher, 'Teacher');
  if (!dates.isPeriod(data.period)) throw badRequest('Choose the salary month.');
  const base = money.toMinor(data.baseSalary === undefined || data.baseSalary === '' ? money.toDecimalString(teacher.monthlySalary) : data.baseSalary);
  const bonus = money.toMinor(data.bonus || '0');
  const deductions = money.toMinor(data.deductions || '0');
  if ([base, bonus, deductions].some((v) => v === null || v < 0)) throw badRequest('Enter valid salary amounts.');
  const net = base + bonus - deductions;
  if (net <= 0) throw badRequest('Net salary must be greater than zero.');
  const paymentDate = dates.parseDay(data.paymentDate) || dates.startOfDay();
  const category = await ExpenseCategory.findOne({ tenantId: ctx.tenantId, name: C.SALARY_CATEGORY }).lean()
    || await ExpenseCategory.create({ tenantId: ctx.tenantId, name: C.SALARY_CATEGORY, isSystem: true });

  try {
    return await runInTransaction(async (session) => {
      const [salary] = await TeacherSalaryPayment.create([{
        tenantId: ctx.tenantId, teacher: teacher._id, period: data.period, baseSalary: base, bonus, deductions,
        amount: net, method: data.method, reference: data.reference, paymentDate, notes: data.notes,
        salaryKey: `${teacher._id}:${data.period}`, recordedBy: ctx.user._id, recordedByName: ctx.user.name,
      }], { session });
      const [expense] = await Expense.create([{
        tenantId: ctx.tenantId, category: category._id, amount: net, expenseDate: paymentDate,
        description: `Salary — ${teacher.fullName} (${dates.periodLabel(data.period)})`,
        method: data.method, recipient: teacher.fullName, reference: data.reference, salaryPayment: salary._id,
        recordedBy: ctx.user._id, recordedByName: ctx.user.name, expenseNo: await expenseNo(ctx, session),
      }], { session });
      salary.expense = expense._id;
      await salary.save({ session });
      await audit.school(req, 'salary.pay', { entity: 'TeacherSalaryPayment', entityId: salary._id, session, details: { teacher: teacher.teacherCode, period: data.period, amount: net } });
      return salary;
    });
  } catch (err) {
    if (err.code === 11000) throw conflict(`${teacher.fullName} has already been paid for ${dates.periodLabel(data.period)}.`);
    throw err;
  }
}

async function cancelSalary(ctx, req, id, reason) {
  if (!reason || reason.trim().length < 3) throw badRequest('A reason is required.');
  return runInTransaction(async (session) => {
    const s = await TeacherSalaryPayment.findOne({ tenantId: ctx.tenantId, _id: id }).session(session);
    if (!s) throw badRequest('Salary payment not found.');
    if (s.status === 'cancelled') throw badRequest('Already cancelled.');
    const cancelled = { at: new Date(), by: ctx.user._id, byName: ctx.user.name, reason };
    s.status = 'cancelled';
    s.salaryKey = undefined;
    s.cancelled = cancelled;
    await s.save({ session });
    await Expense.updateOne({ tenantId: ctx.tenantId, _id: s.expense }, { $set: { status: 'cancelled', cancelled } }, { session });
    await audit.school(req, 'salary.cancel', { entity: 'TeacherSalaryPayment', entityId: s._id, session, details: { period: s.period, amount: s.amount, reason } });
    return s;
  });
}

function listSalaries(tenantId, q = {}) {
  const f = { tenantId };
  if (dates.isPeriod(q.period)) f.period = q.period;
  if (q.teacher && /^[a-f0-9]{24}$/i.test(q.teacher)) f.teacher = q.teacher;
  if (['paid', 'cancelled'].includes(q.status)) f.status = q.status;
  return paginate(TeacherSalaryPayment, f, {
    page: q.page, limit: q.limit || 25, sort: { period: -1, paymentDate: -1 }, populate: { path: 'teacher', select: 'fullName teacherCode' },
  });
}

/** Payroll sheet: every active teacher with whether they were paid for `period`. */
async function payroll(tenantId, period) {
  const [teachers, paid] = await Promise.all([
    Teacher.find({ tenantId, status: { $in: ['active', 'on_leave'] } }).sort({ fullName: 1 }).lean(),
    TeacherSalaryPayment.find({ tenantId, period, status: 'paid' }).lean(),
  ]);
  const byTeacher = Object.fromEntries(paid.map((p) => [String(p.teacher), p]));
  return teachers.map((t) => ({ teacher: t, payment: byTeacher[String(t._id)] || null }));
}

module.exports = { create, update, cancel, recordRecurrence, list, dueRecurring, buildFilter, paySalary, cancelSalary, listSalaries, payroll };
