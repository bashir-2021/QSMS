'use strict';
const H = require('./helpers');

let M;
let s;
let billing;
let payments;
let reports;
let subs;

beforeAll(async () => {
  await H.startDb();
  M = require('../models');
  billing = require('../services/billingService');
  payments = require('../services/paymentService');
  reports = require('../services/reportService');
  subs = require('../services/subscriptionService');
});
afterAll(H.stopDb);
beforeEach(async () => {
  await H.clearDb();
  s = await H.twoSchools();
});

describe('monthly billing', () => {
  test('never bills the same student twice for one period', async () => {
    const first = await billing.generateMonthly(s.a.ctx, '2026-10');
    const second = await billing.generateMonthly(s.a.ctx, '2026-10');
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    await expect(billing.createOther(s.a.ctx, { student: String(s.a.student._id), type: 'monthly', period: '2026-10', amount: '15' })).rejects.toMatchObject({ status: 409 });
    expect(await M.StudentInvoice.countDocuments({ tenantId: s.a.tenant._id, type: 'monthly', period: '2026-10' })).toBe(1);
  });

  test('a cancelled bill frees the period for re-billing', async () => {
    await billing.generateMonthly(s.a.ctx, '2026-09');
    const inv = await M.StudentInvoice.findOne({ tenantId: s.a.tenant._id, period: '2026-09' });
    await billing.cancel(s.a.ctx, inv._id, 'Wrong fee');
    const again = await billing.generateMonthly(s.a.ctx, '2026-09');
    expect(again.created).toBe(1);
  });
});

describe('payments, receipts and reversals', () => {
  test('partial payment, allocation oldest-first and receipt snapshot', async () => {
    await billing.createRegistrationInvoice(s.a.ctx, s.a.student); // 10.00
    await billing.generateMonthly(s.a.ctx, '2026-10'); // 15.00
    const { payment, receipt } = await payments.record(s.a.ctx, s.a.req, { student: String(s.a.student._id), amount: '12.50', method: 'Cash', paymentDate: '2026-10-05' });
    expect(payment.amount).toBe(1250);
    const invs = await M.StudentInvoice.find({ tenantId: s.a.tenant._id }).sort({ issueDate: 1, createdAt: 1 }).lean();
    expect(invs.map((i) => [i.type, i.paid, i.status === 'paid' || i.status === 'partial' || i.status === 'overdue'])).toEqual([['registration', 1000, true], ['monthly', 250, true]]);
    expect(invs[0].status).toBe('paid');
    expect(receipt.snapshot.amountPaid).toBe(1250);
    expect(receipt.snapshot.remainingBalance).toBe(1250);
    expect(receipt.receiptNo).toMatch(/^RCT-\d{4}-00001$/);
  });

  test('overpayment is rejected and nothing is written', async () => {
    await billing.createRegistrationInvoice(s.a.ctx, s.a.student);
    await expect(payments.record(s.a.ctx, s.a.req, { student: String(s.a.student._id), amount: '10.01', method: 'Cash', paymentDate: '2026-10-05' })).rejects.toMatchObject({ status: 400 });
    expect(await M.StudentPayment.countDocuments({ tenantId: s.a.tenant._id })).toBe(0);
    expect(await M.StudentReceipt.countDocuments({ tenantId: s.a.tenant._id })).toBe(0);
  });

  test('reversal re-opens invoices, voids the receipt and keeps the record', async () => {
    await billing.createRegistrationInvoice(s.a.ctx, s.a.student);
    const { payment } = await payments.record(s.a.ctx, s.a.req, { student: String(s.a.student._id), amount: '10', method: 'Cash', paymentDate: '2026-10-05' });
    await payments.reverse(s.a.ctx, s.a.req, payment._id, 'Bounced transfer');
    const p = await M.StudentPayment.findOne({ tenantId: s.a.tenant._id, _id: payment._id }).lean();
    const inv = await M.StudentInvoice.findOne({ tenantId: s.a.tenant._id }).lean();
    const r = await M.StudentReceipt.findOne({ tenantId: s.a.tenant._id }).lean();
    expect(p.status).toBe('reversed');
    expect(inv.paid).toBe(0);
    expect(r.status).toBe('void');
    expect(await M.SchoolAuditLog.countDocuments({ tenantId: s.a.tenant._id, action: 'payment.reverse' })).toBe(1);
  });
});

describe('financial reports', () => {
  test('income counts confirmed payments only — never unpaid invoices or reversals', async () => {
    const expenses = require('../services/expenseService');
    await billing.createRegistrationInvoice(s.a.ctx, s.a.student); // 10.00 billed
    await billing.generateMonthly(s.a.ctx, '2026-10'); // 15.00 billed
    const { payment } = await payments.record(s.a.ctx, s.a.req, { student: String(s.a.student._id), amount: '20', method: 'Cash', paymentDate: '2026-10-05' });
    await payments.record(s.a.ctx, s.a.req, { student: String(s.a.student._id), amount: '5', method: 'Cash', paymentDate: '2026-10-06' });
    await payments.reverse(s.a.ctx, s.a.req, payment._id, 'error');
    const cat = await M.ExpenseCategory.findOne({ tenantId: s.a.tenant._id, name: 'Internet' }).lean();
    await expenses.create(s.a.ctx, s.a.req, { category: String(cat._id), description: 'Internet', amount: '3', expenseDate: '2026-10-07' });

    const r = await reports.build(s.a.tenant._id, 'income-expenditure', { from: '2026-10-01', to: '2026-10-31' });
    const [income, exp, net] = r.summary.map((x) => x.value);
    expect(income).toBe(500);
    expect(exp).toBe(300);
    expect(net).toBe(200);
    // school B is unaffected
    const rb = await reports.build(s.b.tenant._id, 'income-expenditure', { from: '2026-10-01', to: '2026-10-31' });
    expect(rb.summary[0].value).toBe(0);
  });
});

describe('subscriptions', () => {
  test('only a verified payment activates a subscription; limits are enforced server-side', async () => {
    const { runInTransaction } = require('../config/db');
    const root = await M.PlatformUser.findOne({});
    const p = await subs.submitPayment(s.a.tenant._id, { planId: s.plan._id, periods: 2, method: 'mobile_money', transactionRef: 'X1', paidAt: '2026-10-01' }, { kind: 'school' });
    let tenant = await M.Tenant.findById(s.a.tenant._id).lean();
    let sub = await M.Subscription.findById(tenant.currentSubscription).lean();
    expect(sub.status).toBe('trial');
    await subs.verifyPayment(p._id, root, runInTransaction);
    tenant = await M.Tenant.findById(s.a.tenant._id).lean();
    sub = await M.Subscription.findById(tenant.currentSubscription).lean();
    expect(['active', 'expiring_soon']).toContain(sub.status);
    expect((await M.SubscriptionPayment.findById(p._id)).status).toBe('paid');

    const limited = { ...sub, planSnapshot: { ...sub.planSnapshot, limits: { ...sub.planSnapshot.limits, students: 1 } } };
    await expect(subs.assertLimit(limited, s.a.tenant._id, 'students')).rejects.toMatchObject({ status: 403 });
  });

  test('expired subscriptions become read-only after the grace period, data is kept', () => {
    const tenant = { status: 'active' };
    const past = new Date(Date.now() - 30 * 86400000);
    const access = subs.computeAccess(tenant, { status: 'active', endDate: past, graceEndDate: new Date(Date.now() - 86400000), planSnapshot: { graceDays: 5 } });
    expect(access.mode).toBe('read_only');
    const grace = subs.computeAccess(tenant, { status: 'active', endDate: new Date(Date.now() - 86400000), graceEndDate: new Date(Date.now() + 3 * 86400000), planSnapshot: {} });
    expect(grace.mode).toBe('full');
    expect(grace.inGrace).toBe(true);
  });
});
