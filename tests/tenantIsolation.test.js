'use strict';
const H = require('./helpers');

let app;
let M;
let s;

beforeAll(async () => {
  await H.startDb();
  M = require('../models');
  app = H.makeApp();
});
afterAll(H.stopDb);
beforeEach(async () => {
  await H.clearDb();
  s = await H.twoSchools();
});

describe('tenant isolation — data layer', () => {
  test('queries without tenantId are refused', async () => {
    await expect(M.Student.find({})).rejects.toThrow(/without tenantId/);
    await expect(M.Student.findById(s.a.student._id)).rejects.toThrow(/without tenantId/);
    await expect(M.StudentInvoice.updateMany({}, { $set: { paid: 0 } })).rejects.toThrow(/without tenantId/);
    await expect(M.Student.aggregate([{ $group: { _id: null } }])).rejects.toThrow(/tenantId/);
  });

  test('a scoped query never returns another school\'s records', async () => {
    const found = await M.Student.find({ tenantId: s.a.tenant._id }).lean();
    expect(found).toHaveLength(1);
    expect(String(found[0]._id)).toBe(String(s.a.student._id));
    const cross = await M.Student.findOne({ tenantId: s.a.tenant._id, _id: s.b.student._id });
    expect(cross).toBeNull();
  });

  test('inside a school request, unscoped queries are auto-scoped and other tenants are refused', async () => {
    const tenantContext = require('../utils/tenantContext');
    await tenantContext.run(s.a.tenant._id, async () => {
      const all = await M.Student.find({}).lean(); // e.g. what populate() issues
      expect(all.map((x) => String(x._id))).toEqual([String(s.a.student._id)]);
      await expect(M.Student.find({ tenantId: s.b.tenant._id })).rejects.toThrow(/another tenant/);
      await expect(M.Class.create({ tenantId: s.b.tenant._id, name: 'Sneaky' })).rejects.toThrow(/another tenant/);
      const inv = await M.StudentInvoice.find({}).populate('student').lean();
      expect(inv.every((i) => String(i.tenantId) === String(s.a.tenant._id))).toBe(true);
    });
  });

  test('services reject references to another school\'s records', async () => {
    const studentService = require('../services/studentService');
    await expect(studentService.create(s.a.ctx, { fullName: 'X', gender: 'male', class: String(s.b.cls._id) })).rejects.toMatchObject({ status: 404 });
    const payments = require('../services/paymentService');
    await expect(payments.record(s.a.ctx, s.a.req, { student: String(s.b.student._id), amount: '5', method: 'Cash', paymentDate: '2026-01-01' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('tenant isolation — HTTP', () => {
  test('school A cannot open school B\'s student, class or invoice', async () => {
    const billing = require('../services/billingService');
    const inv = await billing.createRegistrationInvoice(s.b.ctx, s.b.student);
    const { agent } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    expect((await agent.get(`/school/students/${s.a.student._id}`)).status).toBe(200);
    expect((await agent.get(`/school/students/${s.b.student._id}`)).status).toBe(404);
    expect((await agent.get(`/school/classes/${s.b.cls._id}`)).status).toBe(404);
    expect((await agent.get(`/school/finance/invoices/${inv._id}`)).status).toBe(404);
  });

  test('a tenantId sent by the browser is ignored', async () => {
    const { agent, csrf } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    const res = await agent.post('/school/classes').type('form').send({ _csrf: csrf, name: 'Injected', level: 'Beginner', capacity: '10', isActive: 'on', tenantId: String(s.b.tenant._id) });
    expect(res.status).toBe(302);
    const created = await M.Class.findOne({ tenantId: s.a.tenant._id, name: 'Injected' });
    expect(created).not.toBeNull();
    expect(await M.Class.findOne({ tenantId: s.b.tenant._id, name: 'Injected' })).toBeNull();
  });

  test('school sessions cannot reach the platform console', async () => {
    const { agent } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    const res = await agent.get('/platform/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/platform\/login/);
  });

  test('state-changing requests without a CSRF token are rejected', async () => {
    const { agent } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    const res = await agent.post('/school/classes').type('form').send({ name: 'NoToken', level: 'Beginner', capacity: '10' });
    expect(res.status).toBe(403);
  });
});

describe('role-based access', () => {
  test('a teacher cannot open finance pages; a receptionist cannot reverse payments', async () => {
    const { hashPassword } = require('../services/authService');
    const pass = await hashPassword('Pass1234!');
    await M.SchoolUser.create([
      { tenantId: s.a.tenant._id, name: 'T', email: 't@a.test', passwordHash: pass, role: 'teacher' },
      { tenantId: s.a.tenant._id, name: 'R', email: 'r@a.test', passwordHash: pass, role: 'receptionist' },
    ]);
    const teacher = await H.loginSchool(app, 't@a.test', 'Pass1234!');
    expect((await teacher.agent.get('/school/finance/invoices')).status).toBe(403);
    expect((await teacher.agent.get('/school/lessons')).status).toBe(200);

    const billing = require('../services/billingService');
    const payments = require('../services/paymentService');
    await billing.createRegistrationInvoice(s.a.ctx, s.a.student);
    const { payment } = await payments.record(s.a.ctx, s.a.req, { student: String(s.a.student._id), amount: '10', method: 'Cash', paymentDate: '2026-01-02' });
    const rec = await H.loginSchool(app, 'r@a.test', 'Pass1234!');
    const res = await rec.agent.post(`/school/finance/payments/${payment._id}/reverse`).type('form').send({ _csrf: rec.csrf, reason: 'test' });
    expect(res.status).toBe(403);
  });
});
