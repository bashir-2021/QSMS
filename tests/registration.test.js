'use strict';
const H = require('./helpers');

let M;
let s;
let billing;
let students;
let payments;

beforeAll(async () => {
  await H.startDb();
  M = require('../models');
  billing = require('../services/billingService');
  students = require('../services/studentService');
  payments = require('../services/paymentService');
});
afterAll(H.stopDb);
beforeEach(async () => {
  await H.clearDb();
  s = await H.twoSchools();
});

describe('one-time registration fee', () => {
  test('registering with a fee creates one registration invoice, with a custom amount', async () => {
    const { student, registrationInvoice } = await students.create(s.a.ctx, { fullName: 'New Student', gender: 'female', program: 'cashra' }, null, { registrationFee: 750 });
    expect(registrationInvoice).toMatchObject({ type: 'registration', total: 750, paid: 0 });
    await expect(billing.createRegistrationInvoice(s.a.ctx, student)).rejects.toMatchObject({ status: 409 });
    await expect(billing.createOther(s.a.ctx, { student: String(student._id), type: 'registration', amount: '5' })).rejects.toMatchObject({ status: 409 });
    expect(await M.StudentInvoice.countDocuments({ tenantId: s.a.tenant._id, student: student._id, type: 'registration' })).toBe(1);
  });

  test('registering without a fee creates no invoice', async () => {
    const { student, registrationInvoice } = await students.create(s.a.ctx, { fullName: 'No Fee', gender: 'male', program: 'cashra' });
    expect(registrationInvoice).toBeNull();
    expect(await M.StudentInvoice.countDocuments({ tenantId: s.a.tenant._id, student: student._id })).toBe(0);
  });

  test('the registration fee can be paid immediately and is then settled', async () => {
    const { student, registrationInvoice: inv } = await students.create(s.a.ctx, { fullName: 'Pays Now', gender: 'male', program: 'cashra' }, null, { registrationFee: s.a.ctx.settings.registrationFee });
    const { receipt } = await payments.record(s.a.ctx, s.a.req, { student: String(student._id), invoices: [String(inv._id)], amount: '10.00', method: 'Cash' });
    expect(receipt.snapshot.category).toBe('registration');
    const after = await M.StudentInvoice.findOne({ tenantId: s.a.tenant._id, _id: inv._id }).lean();
    expect(after).toMatchObject({ status: 'paid', paid: 1000 });
  });
});
