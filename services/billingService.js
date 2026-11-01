'use strict';
const mongoose = require('mongoose');
const { StudentInvoice, Student, Class } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const money = require('../utils/money');
const { paginate, escapeRegex } = require('../utils/paginate');
const { badRequest, conflict } = require('../utils/errors');
const { owned } = require('./scope');
const sequence = require('./sequenceService');

const OPEN = ['unpaid', 'partial', 'overdue'];

/** Monthly fee resolution: student override > class fee > school-wide fee. */
function feeFor(settings, cls, student) {
  if (student && Number.isSafeInteger(student.feeOverride)) return student.feeOverride;
  if (cls && Number.isSafeInteger(cls.monthlyFee)) return cls.monthlyFee;
  return settings.monthlyFee || 0;
}

/** Derive the status from amounts and due date. Never touches cancelled invoices. */
function deriveStatus(inv, today = dates.startOfDay()) {
  if (inv.status === 'cancelled') return 'cancelled';
  if (inv.paid >= inv.total) return 'paid';
  if (inv.dueDate && new Date(inv.dueDate) < today) return 'overdue';
  return inv.paid > 0 ? 'partial' : 'unpaid';
}

function dueDateFor(settings, period) {
  if (!period) return dates.addDays(dates.startOfDay(), 14);
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, settings.billingDueDay || 10));
}

async function studentOutstanding(tenantId, studentId, session) {
  const sid = new mongoose.Types.ObjectId(String(studentId));
  const agg = await StudentInvoice.aggregate([
    { $match: { tenantId, student: sid, status: { $in: OPEN } } },
    { $group: { _id: null, due: { $sum: { $subtract: ['$total', '$paid'] } } } },
  ]).session(session || null);
  return agg.length ? agg[0].due : 0;
}

function openInvoices(tenantId, studentId, session) {
  return StudentInvoice.find({ tenantId, student: studentId, status: { $in: OPEN } })
    .sort({ issueDate: 1, createdAt: 1 }).session(session || null);
}

async function newInvoiceNo(ctx, session) {
  return sequence.next(ctx.tenantId, 'invoice', ctx.settings.numbering && ctx.settings.numbering.invoice, { session });
}

/** One-time registration fee. `amount` (minor units) overrides the school fee, e.g. a reduced fee at registration. */
async function createRegistrationInvoice(ctx, student, { session, amount: custom } = {}) {
  const amount = Number.isSafeInteger(custom) ? custom : ctx.settings.registrationFee || 0;
  if (amount <= 0) throw badRequest(Number.isSafeInteger(custom) ? 'Enter a registration fee greater than zero.' : 'Registration fee is not configured in School Settings.');
  const doc = {
    tenantId: ctx.tenantId, student: student._id, class: student.class, type: 'registration',
    description: 'Registration fee', amount, total: amount, paid: 0,
    issueDate: new Date(), dueDate: dates.addDays(dates.startOfDay(), 7),
    billingKey: `${student._id}:registration`, createdBy: ctx.user._id,
    invoiceNo: await newInvoiceNo(ctx, session),
  };
  try {
    const [inv] = await StudentInvoice.create([doc], { session });
    return inv;
  } catch (err) {
    if (err.code === 11000) throw conflict('This student already has a registration fee invoice.');
    throw err;
  }
}

/**
 * Generate monthly bills for all active students (optionally one class) for a period.
 * Duplicate prevention is guaranteed by the unique billingKey index; students already billed
 * for the period are reported as skipped.
 */
async function generateMonthly(ctx, period, { classId } = {}) {
  if (!dates.isPeriod(period)) throw badRequest('Choose a valid billing month.');
  const filter = { tenantId: ctx.tenantId, status: 'active' };
  if (classId) filter.class = (await owned(Class, ctx.tenantId, classId, 'Class'))._id;
  const [students, classes, existing] = await Promise.all([
    Student.find(filter).lean(),
    Class.find({ tenantId: ctx.tenantId }).lean(),
    StudentInvoice.find({ tenantId: ctx.tenantId, type: 'monthly', period, billingKey: { $type: 'string' } }).select('student').lean(),
  ]);
  const classMap = Object.fromEntries(classes.map((c) => [String(c._id), c]));
  const billed = new Set(existing.map((e) => String(e.student)));
  const result = { created: 0, skipped: 0, zeroFee: 0, total: 0 };

  for (const s of students) {
    if (billed.has(String(s._id))) { result.skipped += 1; continue; }
    const cls = s.class ? classMap[String(s.class)] : null;
    const fee = feeFor(ctx.settings, cls, s);
    if (fee <= 0) { result.zeroFee += 1; continue; }
    try {
      await StudentInvoice.create({
        tenantId: ctx.tenantId, student: s._id, class: s.class, type: 'monthly', period,
        description: `Monthly fee — ${dates.periodLabel(period)}`,
        amount: fee, total: fee, paid: 0,
        previousBalance: await studentOutstanding(ctx.tenantId, s._id),
        issueDate: new Date(), dueDate: dueDateFor(ctx.settings, period),
        billingKey: `${s._id}:monthly:${period}`, createdBy: ctx.user._id,
        invoiceNo: await newInvoiceNo(ctx),
      });
      result.created += 1;
      result.total += fee;
    } catch (err) {
      if (err.code === 11000) { result.skipped += 1; continue; } // concurrent generation
      throw err;
    }
  }
  return result;
}

async function createOther(ctx, data) {
  const student = await owned(Student, ctx.tenantId, data.student, 'Student');
  const amount = money.toMinor(data.amount);
  if (!amount || amount <= 0) throw badRequest('Enter a valid amount.');
  const type = data.type === 'monthly' ? 'monthly' : data.type === 'registration' ? 'registration' : 'other';
  const period = type === 'monthly' ? data.period : undefined;
  if (type === 'monthly' && !dates.isPeriod(period)) throw badRequest('Choose a billing month for a monthly invoice.');
  const billingKey = type === 'monthly' ? `${student._id}:monthly:${period}` : type === 'registration' ? `${student._id}:registration` : undefined;
  try {
    return await StudentInvoice.create({
      tenantId: ctx.tenantId, student: student._id, class: student.class, type, period,
      description: data.description || C.INVOICE_TYPES[type], amount, total: amount, paid: 0,
      previousBalance: await studentOutstanding(ctx.tenantId, student._id),
      issueDate: new Date(), dueDate: dates.parseDay(data.dueDate) || dueDateFor(ctx.settings, period),
      billingKey, createdBy: ctx.user._id, invoiceNo: await newInvoiceNo(ctx),
    });
  } catch (err) {
    if (err.code === 11000) throw (type === 'monthly' ? conflict('This student is already billed for {period}.', { period: dates.periodLabel(period) }) : conflict('This student already has a registration invoice.'));
    throw err;
  }
}

/** Apply a discount and/or adjustment. The new total can never drop below what was paid. */
async function adjust(ctx, id, { discount, adjustment }) {
  const inv = await owned(StudentInvoice, ctx.tenantId, id, 'Invoice', { lean: false });
  if (inv.status === 'cancelled') throw badRequest('Cancelled invoices cannot be adjusted.');
  const d = money.toMinor(discount || '0');
  const a = money.toMinor(adjustment || '0');
  if (d === null || d < 0 || a === null) throw badRequest('Enter valid amounts.');
  const total = inv.amount - d + a;
  if (total < 0) throw badRequest('The discount cannot exceed the invoice amount.');
  if (total < inv.paid) throw badRequest('The new total ({total}) is less than the amount already paid.', null, { total: money.format(total, ctx.settings.currency) });
  const before = { discount: inv.discount, adjustment: inv.adjustment, total: inv.total };
  inv.discount = d;
  inv.adjustment = a;
  inv.total = total;
  inv.status = deriveStatus(inv);
  await inv.save();
  return { inv, before };
}

/** Cancel an invoice that has no payments. Frees the billing period for re-billing. */
async function cancel(ctx, id, reason) {
  const inv = await owned(StudentInvoice, ctx.tenantId, id, 'Invoice', { lean: false });
  if (inv.status === 'cancelled') throw badRequest('Invoice already cancelled.');
  if (inv.paid > 0) throw conflict('This invoice has payments. Reverse the payments first.');
  inv.status = 'cancelled';
  inv.billingKey = undefined;
  inv.cancelled = { at: new Date(), by: ctx.user._id, byName: ctx.user.name, reason };
  await inv.save();
  return inv;
}

function buildFilter(tenantId, q = {}, studentIds) {
  const f = { tenantId };
  if (q.status === 'open') f.status = { $in: OPEN };
  else if (C.INVOICE_STATUSES.includes(q.status)) f.status = q.status;
  if (C.INVOICE_TYPES[q.type]) f.type = q.type;
  if (dates.isPeriod(q.period)) f.period = q.period;
  if (q.class && /^[a-f0-9]{24}$/i.test(q.class)) f.class = q.class;
  if (q.student && /^[a-f0-9]{24}$/i.test(q.student)) f.student = q.student;
  if (studentIds) f.student = { $in: studentIds };
  return f;
}

async function list(tenantId, q) {
  let studentIds;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    const byNo = await StudentInvoice.findOne({ tenantId, invoiceNo: q.search.trim().toUpperCase() }).select('_id').lean();
    if (byNo) return paginate(StudentInvoice, { tenantId, _id: byNo._id }, { populate: populateInv });
    studentIds = (await Student.find({ tenantId, $or: [{ fullName: rx }, { studentCode: rx }] }).select('_id').limit(200).lean()).map((s) => s._id);
  }
  return paginate(StudentInvoice, buildFilter(tenantId, q, studentIds), {
    page: q.page, limit: q.limit || 25, sort: { issueDate: -1, createdAt: -1 }, populate: populateInv,
  });
}
const populateInv = [{ path: 'student', select: 'fullName studentCode' }, { path: 'class', select: 'name' }];

/** Mark open invoices whose due date passed as overdue (all tenants; run by the job). */
async function refreshOverdue() {
  const today = dates.startOfDay();
  const r = await StudentInvoice.updateMany(
    { status: { $in: ['unpaid', 'partial'] }, dueDate: { $lt: today } },
    { $set: { status: 'overdue' } },
  ).setOptions({ skipTenant: true });
  return r.modifiedCount || 0;
}

module.exports = {
  OPEN, feeFor, deriveStatus, studentOutstanding, openInvoices, createRegistrationInvoice,
  generateMonthly, createOther, adjust, cancel, list, refreshOverdue, buildFilter,
};
