'use strict';
const { Teacher, Class, TeacherSalaryPayment, TeacherAttendance, Student } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const money = require('../utils/money');
const { paginate, escapeRegex } = require('../utils/paginate');
const { badRequest } = require('../utils/errors');
const { owned } = require('./scope');
const sequence = require('./sequenceService');
const subscriptionService = require('./subscriptionService');
const { persistUpload, removeStored } = require('../middleware/upload');

function buildFilter(tenantId, q = {}) {
  const f = { tenantId };
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    f.$or = [{ fullName: rx }, { teacherCode: rx }, { phone: rx }, { specialization: rx }];
  }
  if (C.TEACHER_STATUSES.includes(q.status)) f.status = q.status;
  return f;
}

const list = (tenantId, q) => paginate(Teacher, buildFilter(tenantId, q), { page: q.page, limit: q.limit || 20, sort: { fullName: 1 } });
const all = (tenantId, { activeOnly = true } = {}) => Teacher.find({ tenantId, ...(activeOnly ? { status: { $in: ['active', 'on_leave'] } } : {}) }).sort({ fullName: 1 }).select('fullName teacherCode monthlySalary').lean();

function readFields(data) {
  const salary = money.toMinor(data.monthlySalary || '0');
  if (salary === null || salary < 0) throw badRequest('Monthly salary must be a valid amount.');
  return {
    fullName: data.fullName, gender: data.gender || undefined, dateOfBirth: dates.parseDay(data.dateOfBirth) || undefined,
    phone: data.phone, email: data.email || undefined, address: data.address,
    qualification: data.qualification, specialization: data.specialization,
    employmentDate: dates.parseDay(data.employmentDate) || undefined, monthlySalary: salary,
    status: C.TEACHER_STATUSES.includes(data.status) ? data.status : 'active', notes: data.notes,
  };
}

async function create(ctx, data, photo) {
  await subscriptionService.assertLimit(ctx.subscription, ctx.tenantId, 'teachers');
  const t = new Teacher({
    ...readFields(data), tenantId: ctx.tenantId,
    teacherCode: await sequence.next(ctx.tenantId, 'teacher', ctx.settings.numbering && ctx.settings.numbering.teacher),
  });
  if (photo) t.photo = persistUpload(photo, ctx.tenantId, 'teacher');
  await t.save();
  return t;
}

async function update(ctx, id, data, photo) {
  const t = await owned(Teacher, ctx.tenantId, id, 'Teacher', { lean: false });
  const fields = readFields(data);
  const reactivating = ['active', 'on_leave'].includes(fields.status) && !['active', 'on_leave'].includes(t.status);
  if (reactivating) await subscriptionService.assertLimit(ctx.subscription, ctx.tenantId, 'teachers');
  Object.assign(t, fields);
  if (photo) {
    const old = t.photo;
    t.photo = persistUpload(photo, ctx.tenantId, 'teacher');
    if (old) removeStored(old);
  }
  await t.save();
  return t;
}

async function profile(tenantId, id) {
  const teacher = await owned(Teacher, tenantId, id, 'Teacher');
  const [classes, salaries, attendance, studentCount] = await Promise.all([
    Class.find({ tenantId, teacher: teacher._id }).sort({ name: 1 }).lean(),
    TeacherSalaryPayment.find({ tenantId, teacher: teacher._id }).sort({ period: -1 }).limit(24).lean(),
    TeacherAttendance.find({ tenantId, teacher: teacher._id }).sort({ date: -1 }).limit(30).lean(),
    Student.countDocuments({ tenantId, teacher: teacher._id, status: 'active' }),
  ]);
  return {
    teacher, classes, salaries, attendance, studentCount,
    totalPaid: money.sum(salaries.filter((s) => s.status === 'paid'), 'amount'),
  };
}

module.exports = { list, all, create, update, profile };
