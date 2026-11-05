'use strict';
const {
  Student, Class, ClassShift, Teacher, StudentEnrollment, StudentInvoice, StudentPayment, StudentAttendance,
  LessonProgress, StudentLesson, ActivityParticipation, StudentReceipt,
} = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const money = require('../utils/money');
const { paginate, escapeRegex } = require('../utils/paginate');
const { badRequest, conflict } = require('../utils/errors');
const { owned, ownedOptional } = require('./scope');
const sequence = require('./sequenceService');
const subscriptionService = require('./subscriptionService');
const billing = require('./billingService');
const { persistUpload, removeStored } = require('../middleware/upload');

function buildFilter(tenantId, q = {}, restrictClassIds) {
  const f = { tenantId };
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    f.$or = [{ fullName: rx }, { studentCode: rx }, { guardianName: rx }, { guardianPhone: rx }];
  }
  if (q.status && C.STUDENT_STATUSES.includes(q.status)) f.status = q.status;
  if (q.gender && C.GENDERS.includes(q.gender)) f.gender = q.gender;
  if (C.STUDENT_PROGRAMS[q.program]) f.program = q.program;
  if (q.program === 'none') f.program = null; // older records still waiting for a category
  if (q.class && /^[a-f0-9]{24}$/i.test(q.class)) f.class = q.class;
  if (restrictClassIds) f.class = q.class && restrictClassIds.map(String).includes(String(q.class)) ? q.class : { $in: restrictClassIds };
  return f;
}

function list(tenantId, q, restrictClassIds) {
  return paginate(Student, buildFilter(tenantId, q, restrictClassIds), {
    page: q.page, limit: q.limit || 20, sort: { fullName: 1 },
    populate: [{ path: 'class', select: 'name' }, { path: 'teacher', select: 'fullName' }],
  });
}

function exportRows(tenantId, q, restrictClassIds) {
  return Student.find(buildFilter(tenantId, q, restrictClassIds)).sort({ fullName: 1 }).limit(5000)
    .populate('class', 'name').populate('teacher', 'fullName').lean();
}

function readFields(data) {
  return {
    fullName: data.fullName,
    gender: data.gender,
    dateOfBirth: dates.parseDay(data.dateOfBirth) || undefined,
    guardianName: data.guardianName,
    guardianPhone: data.guardianPhone,
    guardianRelation: data.guardianRelation,
    motherName: data.motherName,
    district: data.district,
    program: data.program,
    address: data.address,
    registrationDate: dates.parseDay(data.registrationDate) || new Date(),
    status: C.STUDENT_STATUSES.includes(data.status) ? data.status : 'active',
    notes: data.notes,
    feeOverride: data.feeOverride === undefined || data.feeOverride === '' ? undefined : money.toMinor(data.feeOverride),
  };
}

async function resolveRefs(tenantId, data) {
  const cls = await ownedOptional(Class, tenantId, data.class, 'Class');
  const teacher = await ownedOptional(Teacher, tenantId, data.teacher || (cls && cls.teacher), 'Teacher');
  return { cls, teacher };
}

function assertProgram(fields) {
  if (!C.STUDENT_PROGRAMS[fields.program]) throw badRequest('Choose a Quran category: Farbar, Cashra or Taxfiid.');
}

const activeShiftIds = async (tenantId, cls) => (cls
  ? (await ClassShift.find({ tenantId, class: cls._id, isActive: true }).select('_id').lean()).map((s) => s._id)
  : []);

/**
 * The shifts a student attends in `cls`. All of the class's shifts unless some were picked;
 * `data.shiftsShown` means the form offered the choice, so picking none is a mistake.
 */
async function resolveShifts(tenantId, cls, data) {
  const active = await activeShiftIds(tenantId, cls);
  if (!active.length) return [];
  const picked = [].concat(data.shifts || []).filter(Boolean).map(String);
  if (!picked.length) {
    if (data.shiftsShown) throw badRequest('Select at least one shift.');
    return active;
  }
  const chosen = active.filter((id) => picked.includes(String(id)));
  if (chosen.length !== new Set(picked).size) throw badRequest('Choose shifts that belong to the selected class.');
  return chosen;
}

async function assertCapacity(tenantId, cls, excludeStudentId) {
  if (!cls) return;
  const filter = { tenantId, class: cls._id, status: 'active' };
  if (excludeStudentId) filter._id = { $ne: excludeStudentId };
  const count = await Student.countDocuments(filter);
  if (count >= cls.capacity) throw conflict('{name} is full ({n} students).', { name: cls.name, n: cls.capacity });
}

/**
 * Register a student. `registrationFee` (minor units) creates the one-time registration fee
 * invoice, returned as `registrationInvoice`; the caller decides the amount and permissions.
 */
async function create(ctx, data, photoFile, { registrationFee } = {}) {
  await subscriptionService.assertLimit(ctx.subscription, ctx.tenantId, 'students');
  const fields = readFields(data);
  assertProgram(fields);
  if (fields.feeOverride === null) throw badRequest('Custom monthly fee is not a valid amount.');
  const { cls, teacher } = await resolveRefs(ctx.tenantId, data);
  await assertCapacity(ctx.tenantId, cls);
  const shifts = await resolveShifts(ctx.tenantId, cls, data);

  const student = new Student({
    ...fields, tenantId: ctx.tenantId, class: cls ? cls._id : undefined, teacher: teacher ? teacher._id : undefined, shifts,
    studentCode: await sequence.next(ctx.tenantId, 'student', ctx.settings.numbering && ctx.settings.numbering.student),
  });
  if (photoFile) student.photo = persistUpload(photoFile, ctx.tenantId, 'student');
  await student.save();

  if (cls) {
    await StudentEnrollment.create({ tenantId: ctx.tenantId, student: student._id, class: cls._id, startDate: student.registrationDate, recordedBy: ctx.user._id });
  }
  let registrationInvoice = null;
  if (registrationFee > 0) {
    registrationInvoice = await billing.createRegistrationInvoice(ctx, student, { amount: registrationFee });
  }
  return { student, registrationInvoice };
}

async function update(ctx, id, data, photoFile) {
  const student = await owned(Student, ctx.tenantId, id, 'Student', { lean: false });
  const fields = readFields(data);
  assertProgram(fields);
  if (fields.feeOverride === null) throw badRequest('Custom monthly fee is not a valid amount.');
  const { cls, teacher } = await resolveRefs(ctx.tenantId, data);
  const classChanged = String(student.class || '') !== String(cls ? cls._id : '');
  if (classChanged) await assertCapacity(ctx.tenantId, cls, student._id);
  const shiftsGiven = classChanged || data.shifts !== undefined || data.shiftsShown;
  const shifts = shiftsGiven ? await resolveShifts(ctx.tenantId, cls, data) : null;

  Object.assign(student, fields, { teacher: teacher ? teacher._id : undefined });
  if (fields.feeOverride === undefined) student.feeOverride = undefined;
  if (photoFile) {
    const old = student.photo;
    student.photo = persistUpload(photoFile, ctx.tenantId, 'student');
    if (old) removeStored(old);
  }
  if (classChanged) await moveClass(ctx, student, cls, 'Updated from student profile');
  if (shifts) student.shifts = shifts;
  await student.save();
  return student;
}

/** Close the active enrollment and open a new one (transfer). */
async function moveClass(ctx, student, cls, reason) {
  const now = new Date();
  await StudentEnrollment.updateMany(
    { tenantId: ctx.tenantId, student: student._id, status: 'active' },
    { $set: { status: cls ? 'transferred' : 'withdrawn', endDate: now, reason } },
  );
  if (cls) {
    await StudentEnrollment.create({ tenantId: ctx.tenantId, student: student._id, class: cls._id, startDate: now, reason, recordedBy: ctx.user._id });
  }
  student.class = cls ? cls._id : undefined;
  student.shifts = await activeShiftIds(ctx.tenantId, cls); // shifts belong to a class, so start from all of the new one
  if (cls && cls.teacher) student.teacher = cls.teacher;
}

async function transfer(ctx, id, classId, reason) {
  const student = await owned(Student, ctx.tenantId, id, 'Student', { lean: false });
  const cls = await owned(Class, ctx.tenantId, classId, 'Class');
  if (String(student.class) === String(cls._id)) throw badRequest('The student is already in this class.');
  await assertCapacity(ctx.tenantId, cls, student._id);
  await moveClass(ctx, student, cls, reason || 'Class transfer');
  await student.save();
  return { student, cls };
}

async function setStatus(ctx, id, status) {
  if (!C.STUDENT_STATUSES.includes(status)) throw badRequest('Invalid status');
  const student = await owned(Student, ctx.tenantId, id, 'Student', { lean: false });
  if (status === 'active' && student.status !== 'active' && student.status !== 'suspended') {
    await subscriptionService.assertLimit(ctx.subscription, ctx.tenantId, 'students');
  }
  student.status = status;
  await student.save();
  return student;
}

/** Everything the student profile page shows. */
async function profile(tenantId, id) {
  const student = await owned(Student, tenantId, id, 'Student', {
    populate: [{ path: 'class', select: 'name level' }, { path: 'teacher', select: 'fullName phone' }, { path: 'shifts', select: 'name isActive' }],
  });
  const since = dates.addDays(new Date(), -90);
  const [invoices, payments, receipts, attendance, attendanceAgg, progress, studentLessons, participations, enrollments, balance] = await Promise.all([
    StudentInvoice.find({ tenantId, student: student._id }).sort({ issueDate: -1 }).limit(50).lean(),
    StudentPayment.find({ tenantId, student: student._id }).sort({ paymentDate: -1 }).limit(50).lean(),
    StudentReceipt.find({ tenantId, student: student._id }).select('receiptNo payment status').lean(),
    StudentAttendance.find({ tenantId, student: student._id }).sort({ date: -1 }).limit(30).populate('class', 'name').populate('shift', 'name').lean(),
    StudentAttendance.aggregate([
      { $match: { tenantId, student: student._id, date: { $gte: since } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    LessonProgress.find({ tenantId, student: student._id }).sort({ date: -1 }).limit(50)
      .populate({ path: 'lesson', select: 'title category surah fromVerse toVerse' }).lean(),
    StudentLesson.find({ tenantId, student: student._id }).sort({ assignedDate: -1, createdAt: -1 }).limit(50).lean(),
    ActivityParticipation.find({ tenantId, student: student._id }).sort({ createdAt: -1 }).limit(20)
      .populate({ path: 'activity', select: 'title type date' }).lean(),
    StudentEnrollment.find({ tenantId, student: student._id }).sort({ startDate: -1 }).populate('class', 'name').lean(),
    billing.studentOutstanding(tenantId, student._id),
  ]);
  const att = { present: 0, absent: 0, late: 0, excused: 0 };
  attendanceAgg.forEach((a) => { att[a._id] = a.count; });
  const attTotal = Object.values(att).reduce((a, b) => a + b, 0);
  const receiptByPayment = Object.fromEntries(receipts.map((r) => [String(r.payment), r]));
  return {
    student, invoices, payments, receiptByPayment, attendance, att, attTotal,
    attendanceRate: attTotal ? Math.round(((att.present + att.late) / attTotal) * 100) : null,
    progress, studentLessons, participations, enrollments, balance,
    totalPaid: money.sum(payments.filter((p) => p.status === 'confirmed'), 'amount'),
  };
}

/** Lightweight search used by the payment form's student picker. */
async function search(tenantId, term, restrictClassIds) {
  const f = buildFilter(tenantId, { search: term }, restrictClassIds);
  return Student.find(f).select('fullName studentCode class status').populate('class', 'name').limit(15).lean();
}

module.exports = { list, exportRows, create, update, transfer, setStatus, profile, search, buildFilter };
