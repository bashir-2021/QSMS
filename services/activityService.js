'use strict';
const { AcademicActivity, ActivityParticipation, Class, Student, Teacher } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const { paginate, escapeRegex } = require('../utils/paginate');
const { forbidden } = require('../utils/errors');
const { owned, ownedOptional } = require('./scope');

/** Subac (سبع) and Duruus (دروس) sessions with per-student participation. */

function assertClassAllowed(classId, restrict) {
  if (restrict && !restrict.map(String).includes(String(classId))) throw forbidden('You can only manage your own classes.');
}

function buildFilter(tenantId, type, q = {}, restrict) {
  const f = { tenantId, type };
  if (q.class && /^[a-f0-9]{24}$/i.test(q.class)) f.class = q.class;
  if (restrict) f.class = q.class && restrict.map(String).includes(String(q.class)) ? q.class : { $in: restrict };
  if (q.from || q.to) {
    const r = dates.rangeFromQuery(q);
    f.date = { $gte: r.from, $lte: r.to };
  }
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    f.$or = [{ title: rx }, { topic: rx }];
  }
  return f;
}

async function list(tenantId, type, q, restrict) {
  const page = await paginate(AcademicActivity, buildFilter(tenantId, type, q, restrict), {
    page: q.page, limit: q.limit || 20, sort: { date: -1 },
    populate: [{ path: 'class', select: 'name' }, { path: 'teacher', select: 'fullName' }],
  });
  const counts = await ActivityParticipation.aggregate([
    { $match: { tenantId, activity: { $in: page.items.map((a) => a._id) } } },
    { $group: { _id: '$activity', n: { $sum: 1 }, present: { $sum: { $cond: [{ $in: ['$attendance', ['present', 'late']] }, 1, 0] } } } },
  ]);
  const map = Object.fromEntries(counts.map((c) => [String(c._id), c]));
  page.items.forEach((a) => { a.participants = map[String(a._id)] || { n: 0, present: 0 }; });
  return page;
}

async function readFields(tenantId, data, restrict) {
  const cls = await owned(Class, tenantId, data.class, 'Class');
  assertClassAllowed(cls._id, restrict);
  const teacher = await ownedOptional(Teacher, tenantId, data.teacher || cls.teacher, 'Teacher');
  return {
    title: data.title, date: dates.parseDay(data.date) || dates.startOfDay(), class: cls._id,
    teacher: teacher ? teacher._id : undefined, topic: data.topic, objectives: data.objectives,
    evaluation: data.evaluation, remarks: data.remarks,
  };
}

async function create(ctx, type, data, restrict) {
  const activity = await AcademicActivity.create({ ...(await readFields(ctx.tenantId, data, restrict)), type, tenantId: ctx.tenantId, createdBy: ctx.user._id });
  // pre-fill the roster with the class's active students as "present"
  const students = await Student.find({ tenantId: ctx.tenantId, class: activity.class, status: 'active' }).select('_id').lean();
  if (students.length) {
    await ActivityParticipation.insertMany(students.map((s) => ({ tenantId: ctx.tenantId, activity: activity._id, student: s._id, attendance: 'present' })));
  }
  return activity;
}

async function update(ctx, type, id, data, restrict) {
  const a = await owned(AcademicActivity, ctx.tenantId, id, 'Activity', { lean: false });
  if (a.type !== type) throw forbidden('Activity not found');
  assertClassAllowed(a.class, restrict);
  Object.assign(a, await readFields(ctx.tenantId, data, restrict));
  await a.save();
  return a;
}

async function remove(ctx, type, id, restrict) {
  const a = await owned(AcademicActivity, ctx.tenantId, id, 'Activity');
  if (a.type !== type) throw forbidden('Activity not found');
  assertClassAllowed(a.class, restrict);
  await ActivityParticipation.deleteMany({ tenantId: ctx.tenantId, activity: a._id });
  await AcademicActivity.deleteOne({ tenantId: ctx.tenantId, _id: a._id });
}

async function detail(tenantId, type, id) {
  const activity = await owned(AcademicActivity, tenantId, id, 'Activity', {
    populate: [{ path: 'class', select: 'name' }, { path: 'teacher', select: 'fullName' }],
  });
  if (activity.type !== type) throw forbidden('Activity not found');
  const [classStudents, parts] = await Promise.all([
    Student.find({ tenantId, class: activity.class._id, status: 'active' }).select('fullName studentCode').sort({ fullName: 1 }).lean(),
    ActivityParticipation.find({ tenantId, activity: activity._id }).populate('student', 'fullName studentCode').lean(),
  ]);
  const byStudent = Object.fromEntries(parts.filter((p) => p.student).map((p) => [String(p.student._id), p]));
  const roster = classStudents.map((s) => ({ student: s, part: byStudent[String(s._id)] || null }));
  parts.forEach((p) => { if (p.student && !classStudents.some((s) => String(s._id) === String(p.student._id))) roster.push({ student: p.student, part: p }); });
  return { activity, roster };
}

async function saveParticipation(ctx, type, id, rows = {}, restrict) {
  const a = await owned(AcademicActivity, ctx.tenantId, id, 'Activity');
  if (a.type !== type) throw forbidden('Activity not found');
  assertClassAllowed(a.class, restrict);
  const ids = Object.keys(rows).filter((x) => /^[a-f0-9]{24}$/i.test(x));
  const valid = new Set((await Student.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).select('_id').lean()).map((s) => String(s._id)));
  const ops = ids.filter((sid) => valid.has(sid)).map((sid) => {
    const r = rows[sid] || {};
    const score = r.score === '' || r.score === undefined ? undefined : Math.max(0, Math.min(100, parseInt(r.score, 10)));
    return {
      updateOne: {
        filter: { tenantId: ctx.tenantId, activity: a._id, student: sid },
        update: {
          $set: {
            attendance: C.ATTENDANCE_STATUSES.includes(r.attendance) ? r.attendance : 'present',
            performance: C.PERFORMANCE_LEVELS.includes(r.performance) ? r.performance : undefined,
            score: Number.isFinite(score) ? score : undefined, remarks: String(r.remarks || '').slice(0, 500),
          },
          $setOnInsert: { tenantId: ctx.tenantId, activity: a._id, student: sid },
        },
        upsert: true,
      },
    };
  });
  if (ops.length) await ActivityParticipation.bulkWrite(ops);
  return ops.length;
}

module.exports = { list, create, update, remove, detail, saveParticipation };
