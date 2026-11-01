'use strict';
const { Class, Teacher, Student, StudentAttendance, LessonProgress, Lesson, StudentEnrollment } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const money = require('../utils/money');
const { paginate, escapeRegex } = require('../utils/paginate');
const { badRequest, conflict } = require('../utils/errors');
const { owned, ownedOptional } = require('./scope');
const subscriptionService = require('./subscriptionService');

const PERF_SCORE = { excellent: 95, very_good: 85, good: 75, fair: 60, needs_improvement: 45 };

/**
 * Classes a user may work with. Teacher-role users linked to a teacher profile are limited
 * to their own classes; everyone else sees all classes of the school. Returns null = no limit.
 */
async function restrictedClassIds(req) {
  if (req.user.role !== 'teacher' || !req.user.teacher) return null;
  const classes = await Class.find({ tenantId: req.tenantId, teacher: req.user.teacher }).select('_id').lean();
  return classes.map((c) => c._id);
}

function buildFilter(tenantId, q = {}, restrict) {
  const f = { tenantId };
  if (q.search) f.name = new RegExp(escapeRegex(q.search), 'i');
  if (C.CLASS_LEVELS.includes(q.level)) f.level = q.level;
  if (q.active === 'yes') f.isActive = true;
  if (q.active === 'no') f.isActive = false;
  if (restrict) f._id = { $in: restrict };
  return f;
}

async function list(tenantId, q, restrict) {
  const page = await paginate(Class, buildFilter(tenantId, q, restrict), {
    page: q.page, limit: q.limit || 20, sort: { name: 1 }, populate: { path: 'teacher', select: 'fullName' },
  });
  const counts = await Student.aggregate([
    { $match: { tenantId, status: 'active', class: { $in: page.items.map((c) => c._id) } } },
    { $group: { _id: '$class', n: { $sum: 1 } } },
  ]);
  const map = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  page.items.forEach((c) => { c.studentCount = map[String(c._id)] || 0; });
  return page;
}

const all = (tenantId, restrict) => Class.find({ tenantId, isActive: true, ...(restrict ? { _id: { $in: restrict } } : {}) })
  .sort({ name: 1 }).select('name level teacher monthlyFee capacity').lean();

async function readFields(tenantId, data) {
  const teacher = await ownedOptional(Teacher, tenantId, data.teacher, 'Teacher');
  const fee = data.monthlyFee === '' || data.monthlyFee === undefined ? null : money.toMinor(data.monthlyFee);
  if (data.monthlyFee && (fee === null || fee < 0)) throw badRequest('Monthly fee must be a valid amount.');
  const start = dates.parseDay(data.startDate);
  const end = dates.parseDay(data.endDate);
  if (start && end && end < start) throw badRequest('End date must be after the start date.');
  return {
    name: data.name, level: C.CLASS_LEVELS.includes(data.level) ? data.level : 'Beginner',
    teacher: teacher ? teacher._id : null, capacity: parseInt(data.capacity, 10) || 30,
    schedule: {
      days: [].concat(data.days || []).filter((d) => C.WEEKDAYS.includes(d)),
      startTime: data.startTime, endTime: data.endTime, room: data.room,
    },
    monthlyFee: fee, startDate: start || undefined, endDate: end || undefined,
    isActive: data.isActive === 'on' || data.isActive === 'true' || data.isActive === true,
    description: data.description,
  };
}

async function create(ctx, data) {
  await subscriptionService.assertLimit(ctx.subscription, ctx.tenantId, 'classes');
  try {
    return await Class.create({ ...(await readFields(ctx.tenantId, data)), tenantId: ctx.tenantId });
  } catch (err) {
    if (err.code === 11000) throw conflict('A class with this name already exists.');
    throw err;
  }
}

async function update(ctx, id, data) {
  const cls = await owned(Class, ctx.tenantId, id, 'Class', { lean: false });
  const fields = await readFields(ctx.tenantId, data);
  if (fields.isActive && !cls.isActive) await subscriptionService.assertLimit(ctx.subscription, ctx.tenantId, 'classes');
  const active = await Student.countDocuments({ tenantId: ctx.tenantId, class: cls._id, status: 'active' });
  if (fields.capacity < active) throw badRequest('Capacity cannot be lower than the {n} active students in this class.', null, { n: active });
  Object.assign(cls, fields);
  try {
    await cls.save();
  } catch (err) {
    if (err.code === 11000) throw conflict('A class with this name already exists.');
    throw err;
  }
  // keep students' assigned teacher in sync with the class teacher
  if (fields.teacher) await Student.updateMany({ tenantId: ctx.tenantId, class: cls._id }, { $set: { teacher: fields.teacher } });
  return cls;
}

/** Class page: roster plus performance (attendance rate and average lesson score). */
async function detail(tenantId, id) {
  const cls = await owned(Class, tenantId, id, 'Class', { populate: { path: 'teacher', select: 'fullName phone' } });
  const since = dates.addDays(new Date(), -30);
  const [students, attendance, lessons, enrollments] = await Promise.all([
    Student.find({ tenantId, class: cls._id, status: 'active' }).sort({ fullName: 1 }).lean(),
    StudentAttendance.aggregate([
      { $match: { tenantId, class: cls._id, date: { $gte: since } } },
      { $group: { _id: { student: '$student', status: '$status' }, n: { $sum: 1 } } },
    ]),
    Lesson.find({ tenantId, class: cls._id }).sort({ date: -1 }).limit(10).lean(),
    StudentEnrollment.find({ tenantId, class: cls._id }).sort({ startDate: -1 }).limit(20).populate('student', 'fullName studentCode').lean(),
  ]);
  const lessonIds = (await Lesson.find({ tenantId, class: cls._id, date: { $gte: dates.addDays(new Date(), -90) } }).select('_id').lean()).map((l) => l._id);
  const progress = await LessonProgress.find({ tenantId, lesson: { $in: lessonIds } }).select('student performance score').lean();

  const perStudent = {};
  students.forEach((s) => { perStudent[String(s._id)] = { present: 0, total: 0, scores: [] }; });
  attendance.forEach((a) => {
    const p = perStudent[String(a._id.student)];
    if (!p) return;
    p.total += a.n;
    if (['present', 'late'].includes(a._id.status)) p.present += a.n;
  });
  progress.forEach((pr) => {
    const p = perStudent[String(pr.student)];
    if (!p) return;
    const score = pr.score != null ? pr.score : PERF_SCORE[pr.performance];
    if (score != null) p.scores.push(score);
  });
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  students.forEach((s) => {
    const p = perStudent[String(s._id)];
    s.attendanceRate = p.total ? Math.round((p.present / p.total) * 100) : null;
    s.avgScore = avg(p.scores);
  });
  const rates = students.map((s) => s.attendanceRate).filter((x) => x != null);
  const scores = students.map((s) => s.avgScore).filter((x) => x != null);
  return {
    cls, students, lessons, enrollments,
    summary: { attendanceRate: avg(rates), avgScore: avg(scores), lessonsLast90: lessonIds.length },
  };
}

/** Bulk-enrol unassigned (or other-class) students into this class. */
async function enrol(ctx, classId, studentIds, studentService) {
  const cls = await owned(Class, ctx.tenantId, classId, 'Class');
  const ids = [].concat(studentIds || []).filter(Boolean);
  if (!ids.length) throw badRequest('Select at least one student.');
  let moved = 0;
  for (const sid of ids) {
    // eslint-disable-next-line no-await-in-loop
    await studentService.transfer(ctx, sid, cls._id, 'Enrolled from class page');
    moved += 1;
  }
  return { cls, moved };
}

module.exports = { restrictedClassIds, list, all, create, update, detail, enrol, PERF_SCORE };
