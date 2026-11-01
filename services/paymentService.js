'use strict';
const { runInTransaction } = require('../config/db');
const {
  Student, Class, StudentInvoice, StudentPayment, PaymentAllocation, StudentReceipt,
} = require('../models');
const dates = require('../utils/dates');
const money = require('../utils/money');
const { paginate, escapeRegex } = require('../utils/paginate');
const { badRequest, conflict, notFound } = require('../utils/errors');
const { owned } = require('./scope');
const sequence = require('./sequenceService');
const billing = require('./billingService');
const audit = require('./auditService');

/**
 * Record a confirmed student payment.
 * In one transaction: allocate the amount to the chosen (or oldest open) invoices, update
 * each invoice's paid/status, store the payment + allocations, and issue an immutable
 * receipt snapshot. Overpayment is rejected so balances can never go negative.
 */
async function record(ctx, req, data) {
  const amount = money.toMinor(data.amount);
  if (!amount || amount <= 0) throw badRequest('Enter a valid payment amount.');
  const methods = ctx.settings.paymentMethods || [];
  if (!methods.includes(data.method)) throw badRequest('Choose a payment method configured in School Settings.');
  const paymentDate = dates.parseDay(data.paymentDate) || dates.startOfDay();
  if (paymentDate > dates.endOfDay()) throw badRequest('Payment date cannot be in the future.');
  const requested = [].concat(data.invoices || []).filter(Boolean).map(String);

  const result = await runInTransaction(async (session) => {
    const student = await owned(Student, ctx.tenantId, data.student, 'Student', { session });
    let invoices;
    if (requested.length) {
      invoices = await StudentInvoice.find({ tenantId: ctx.tenantId, _id: { $in: requested }, student: student._id, status: { $in: billing.OPEN } })
        .sort({ issueDate: 1, createdAt: 1 }).session(session);
      if (invoices.length !== requested.length) throw badRequest('One or more selected invoices are not open invoices of this student.');
    } else {
      invoices = await billing.openInvoices(ctx.tenantId, student._id, session);
    }
    if (!invoices.length) throw badRequest('This student has no open invoices. Create an invoice before recording a payment.');
    const due = money.sum(invoices.map((i) => i.total - i.paid));
    if (amount > due) throw badRequest('Amount exceeds the outstanding balance of the selected invoices ({due}).', null, { due: money.format(due, ctx.settings.currency) });

    // allocate oldest-first
    let remaining = amount;
    const allocations = [];
    const lines = [];
    for (const inv of invoices) {
      if (remaining <= 0) break;
      const apply = Math.min(remaining, inv.total - inv.paid);
      if (apply <= 0) continue;
      inv.paid = money.add(inv.paid, apply);
      inv.status = billing.deriveStatus(inv);
      await inv.save({ session });
      remaining -= apply;
      allocations.push({ invoice: inv, amount: apply });
      lines.push({ invoiceNo: inv.invoiceNo, description: inv.description, total: inv.total, applied: apply, balanceAfter: inv.total - inv.paid });
    }

    const types = [...new Set(allocations.map((a) => a.invoice.type))];
    const [payment] = await StudentPayment.create([{
      tenantId: ctx.tenantId, student: student._id, amount, method: data.method,
      transactionRef: data.transactionRef, paymentDate, notes: data.notes,
      category: types.length === 1 ? types[0] : 'mixed',
      receivedBy: ctx.user._id, receivedByName: ctx.user.name,
      paymentNo: await sequence.next(ctx.tenantId, 'payment', ctx.settings.numbering && ctx.settings.numbering.payment, { session }),
    }], { session });

    await PaymentAllocation.insertMany(allocations.map((a) => ({
      tenantId: ctx.tenantId, payment: payment._id, invoice: a.invoice._id, student: student._id,
      invoiceType: a.invoice.type, amount: a.amount, paymentDate,
    })), { session });

    const cls = student.class ? await Class.findOne({ tenantId: ctx.tenantId, _id: student.class }).select('name').session(session).lean() : null;
    const remainingBalance = await billing.studentOutstanding(ctx.tenantId, student._id, session);
    const [receipt] = await StudentReceipt.create([{
      tenantId: ctx.tenantId, payment: payment._id, student: student._id,
      receiptNo: await sequence.next(ctx.tenantId, 'receipt', ctx.settings.numbering && ctx.settings.numbering.receipt, { session }),
      snapshot: {
        schoolName: ctx.tenant.name, schoolAddress: [ctx.tenant.address, ctx.tenant.city, ctx.tenant.country].filter(Boolean).join(', '),
        schoolPhone: ctx.tenant.phone, schoolLogo: ctx.tenant.logo, currency: ctx.settings.currency,
        studentName: student.fullName, studentCode: student.studentCode, className: cls ? cls.name : '—',
        category: payment.category,
        periods: allocations.map((a) => a.invoice.period).filter(Boolean),
        lines,
        totalAmount: money.sum(allocations.map((a) => a.invoice.total)),
        amountPaid: amount, remainingBalance,
        method: data.method, transactionRef: data.transactionRef, paymentDate,
        receivedBy: ctx.user.name, footer: ctx.settings.receiptFooter,
      },
    }], { session });
    payment.receipt = receipt._id;
    await payment.save({ session });

    await audit.school(req, 'payment.create', {
      entity: 'StudentPayment', entityId: payment._id, session,
      details: { paymentNo: payment.paymentNo, receiptNo: receipt.receiptNo, amount, student: student.studentCode, invoices: lines.map((l) => l.invoiceNo) },
    });
    return { payment, receipt };
  });
  return result;
}

/** Reverse a confirmed payment. Nothing is deleted; invoices are re-opened and the receipt voided. */
async function reverse(ctx, req, id, reason) {
  if (!reason || reason.trim().length < 3) throw badRequest('A reason is required to reverse a payment.');
  return runInTransaction(async (session) => {
    const payment = await StudentPayment.findOne({ tenantId: ctx.tenantId, _id: id }).session(session);
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'confirmed') throw conflict('This payment is already reversed.');
    const allocations = await PaymentAllocation.find({ tenantId: ctx.tenantId, payment: payment._id, status: 'active' }).session(session);
    for (const a of allocations) {
      const inv = await StudentInvoice.findOne({ tenantId: ctx.tenantId, _id: a.invoice }).session(session);
      inv.paid = money.sub(inv.paid, a.amount);
      if (inv.paid < 0) throw conflict('Invoice {invoice} would have a negative paid amount.', { invoice: inv.invoiceNo });
      inv.status = billing.deriveStatus(inv);
      await inv.save({ session });
      a.status = 'reversed';
      await a.save({ session });
    }
    payment.status = 'reversed';
    payment.reversal = { at: new Date(), by: ctx.user._id, byName: ctx.user.name, reason };
    await payment.save({ session });
    await StudentReceipt.updateOne({ tenantId: ctx.tenantId, payment: payment._id }, { $set: { status: 'void' } }, { session });
    await audit.school(req, 'payment.reverse', {
      entity: 'StudentPayment', entityId: payment._id, session,
      details: { paymentNo: payment.paymentNo, amount: payment.amount, reason },
    });
    return payment;
  });
}

async function list(tenantId, q = {}) {
  const f = { tenantId };
  if (['confirmed', 'reversed'].includes(q.status)) f.status = q.status;
  if (q.method) f.method = String(q.method).slice(0, 60);
  if (['registration', 'monthly', 'other', 'mixed'].includes(q.category)) f.category = q.category;
  if (q.from || q.to) {
    const r = dates.rangeFromQuery(q);
    f.paymentDate = { $gte: r.from, $lte: r.to };
  }
  if (q.student && /^[a-f0-9]{24}$/i.test(q.student)) f.student = q.student;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    const ids = (await Student.find({ tenantId, $or: [{ fullName: rx }, { studentCode: rx }] }).select('_id').limit(200).lean()).map((s) => s._id);
    f.$or = [{ student: { $in: ids } }, { paymentNo: rx }, { transactionRef: rx }];
  }
  return paginate(StudentPayment, f, {
    page: q.page, limit: q.limit || 25, sort: { paymentDate: -1, createdAt: -1 },
    populate: [{ path: 'student', select: 'fullName studentCode' }, { path: 'receipt', select: 'receiptNo status' }],
  });
}

async function detail(tenantId, id) {
  const payment = await owned(StudentPayment, tenantId, id, 'Payment', {
    populate: [{ path: 'student', select: 'fullName studentCode' }, { path: 'receipt', select: 'receiptNo status' }],
  });
  const allocations = await PaymentAllocation.find({ tenantId, payment: payment._id })
    .populate('invoice', 'invoiceNo description type period total paid status').lean();
  return { payment, allocations };
}

async function listReceipts(tenantId, q = {}) {
  const f = { tenantId };
  if (['valid', 'void'].includes(q.status)) f.status = q.status;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    f.$or = [{ receiptNo: rx }, { 'snapshot.studentName': rx }, { 'snapshot.studentCode': rx }, { 'snapshot.transactionRef': rx }];
  }
  if (q.from || q.to) {
    const r = dates.rangeFromQuery(q);
    f['snapshot.paymentDate'] = { $gte: r.from, $lte: r.to };
  }
  return paginate(StudentReceipt, f, { page: q.page, limit: q.limit || 25, sort: { createdAt: -1 } });
}

const getReceipt = (tenantId, id) => owned(StudentReceipt, tenantId, id, 'Receipt');

async function markPrinted(tenantId, id) {
  await StudentReceipt.updateOne({ tenantId, _id: id }, { $inc: { printCount: 1 }, $set: { lastPrintedAt: new Date() } });
}

module.exports = { record, reverse, list, detail, listReceipts, getReceipt, markPrinted };
