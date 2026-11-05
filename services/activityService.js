'use strict';
const { AcademicActivity, ActivityParticipation, Class, Student, Teacher } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const { paginate, escapeRegex } = require('../utils/paginate');
const { badRequest, conflict, forbidden } = require('../utils/errors');
const { owned, ownedOptional } = require('./scope');
const settingsService = require('./settingsService');

/** Subac (سبع) and Duruus (دروس) sessions with per-student participation. */

function assertClassAllowed(classId, restrict) {
  if (restrict && !restrict.map(String).includes(String(classId))) throw forbidden('You can only manage your own classes.');
}

/** Sessions created since deductions were introduced are scored from them; older ones keep their typed score. */
const usesDeductions = (activity) => activity.type === 'subac' && Boolean(activity.frequency);

/** Farbar students are still learning to write, so they sit out daily Subac. */
const rosterFilter = (activity) => (activity.frequency === 'daily' ? { program: { $ne: 'farbar' } } : {});

/** Subac score: the base score, less each error's points, plus or minus the teacher's manual points. */
function subacScore(rates, counts = {}, manualPoints = 0) {
  const round = (n) => Math.round(n * 100) / 100;
  const deducted = round(Object.keys(C.SUBAC_DEDUCTIONS).reduce((sum, key) => sum + (counts[key] || 0) * rates[key], 0));
  return { deducted, score: Math.max(0, Math.min(C.SUBAC_BASE_SCORE, round(C.SUBAC_BASE_SCORE - deducted + manualPoints))) };
}

function buildFilter(tenantId, type, q = {}, restrict) {
  const f = { tenantId, type };
  if (C.SUBAC_FREQUENCIES.includes(q.frequency)) f.frequency = q.frequency;
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

async function readFields(tenantId, data, restrict, frequency) {
  const cls = await owned(Class, tenantId, data.class, 'Class');
  assertClassAllowed(cls._id, restrict);
  if (frequency === 'daily' && cls.level === 'Beginner') throw badRequest('Beginner classes do not have daily Subac. Register a one-time Subac instead.');
  const teacher = await ownedOptional(Teacher, tenantId, data.teacher || cls.teacher, 'Teacher');
  return {
    title: data.title, date: dates.parseDay(data.date) || dates.startOfDay(), class: cls._id,
    teacher: teacher ? teacher._id : undefined, topic: data.topic, objectives: data.objectives,
    evaluation: data.evaluation, remarks: data.remarks,
  };
}

const readFrequency = (data) => (C.SUBAC_FREQUENCIES.includes(data.frequency) ? data.frequency : 'one_time');

async function saveSession(save) {
  try {
    return await save();
  } catch (err) {
    if (err.code === 11000) throw conflict('This class already has a daily Subac on this date.');
    throw err;
  }
}

async function create(ctx, type, data, restrict) {
  const subac = type === 'subac' ? { frequency: readFrequency(data), deductionRates: settingsService.subacRates(ctx.settings) } : {};
  const fields = await readFields(ctx.tenantId, data, restrict, subac.frequency);
  const activity = await saveSession(() => AcademicActivity.create({ ...fields, ...subac, type, tenantId: ctx.tenantId, createdBy: ctx.user._id }));
  // pre-fill the roster with the class's active students as "present"
  const students = await Student.find({ tenantId: ctx.tenantId, class: activity.class, status: 'active', ...rosterFilter(activity) }).select('_id').lean();
  if (students.length) {
    await ActivityParticipation.insertMany(students.map((s) => ({ tenantId: ctx.tenantId, activity: activity._id, student: s._id, attendance: 'present' })));
  }
  return activity;
}

async function update(ctx, type, id, data, restrict) {
  const a = await owned(AcademicActivity, ctx.tenantId, id, 'Activity', { lean: false });
  if (a.type !== type) throw forbidden('Activity not found');
  assertClassAllowed(a.class, restrict);
  const frequency = usesDeductions(a) ? readFrequency(data) : undefined;
  Object.assign(a, await readFields(ctx.tenantId, data, restrict, frequency), frequency ? { frequency } : {});
  await saveSession(() => a.save());
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
    Student.find({ tenantId, class: activity.class._id, status: 'active', ...rosterFilter(activity) }).select('fullName studentCode').sort({ fullName: 1 }).lean(),
    ActivityParticipation.find({ tenantId, activity: activity._id }).populate('student', 'fullName studentCode').lean(),
  ]);
  const byStudent = Object.fromEntries(parts.filter((p) => p.student).map((p) => [String(p.student._id), p]));
  const roster = classStudents.map((s) => ({ student: s, part: byStudent[String(s._id)] || null }));
  parts.forEach((p) => { if (p.student && !classStudents.some((s) => String(s._id) === String(p.student._id))) roster.push({ student: p.student, part: p }); });
  return { activity, roster, usesDeductions: usesDeductions(activity) };
}

/** A Subac row: count each error, then work the score out on the server. Absent students get no score. */
function subacRow(activity, r) {
  const attendance = C.ATTENDANCE_STATUSES.includes(r.attendance) ? r.attendance : 'present';
  const remarks = String(r.remarks || '').slice(0, 500);
  if (!['present', 'late'].includes(attendance)) return { attendance, remarks, deductions: {}, deducted: 0, manualPoints: 0, score: null };
  const sent = r.deductions || {};
  const deductions = Object.fromEntries(Object.keys(C.SUBAC_DEDUCTIONS).map((key) => [key, Math.max(0, Math.min(999, parseInt(sent[key], 10) || 0))]));
  const manualPoints = Math.max(-C.SUBAC_BASE_SCORE, Math.min(C.SUBAC_BASE_SCORE, Number(r.manualPoints) || 0));
  return { attendance, remarks, deductions, manualPoints, ...subacScore(activity.deductionRates, deductions, manualPoints) };
}

async function saveParticipation(ctx, type, id, rows = {}, restrict) {
  const a = await owned(AcademicActivity, ctx.tenantId, id, 'Activity');
  if (a.type !== type) throw forbidden('Activity not found');
  assertClassAllowed(a.class, restrict);
  const ids = Object.keys(rows).filter((x) => /^[a-f0-9]{24}$/i.test(x));
  const valid = new Set((await Student.find({ tenantId: ctx.tenantId, _id: { $in: ids }, ...rosterFilter(a) }).select('_id').lean()).map((s) => String(s._id)));
  const ops = ids.filter((sid) => valid.has(sid)).map((sid) => {
    const r = rows[sid] || {};
    const score = r.score === '' || r.score === undefined ? undefined : Math.max(0, Math.min(100, parseInt(r.score, 10)));
    return {
      updateOne: {
        filter: { tenantId: ctx.tenantId, activity: a._id, student: sid },
        update: {
          $set: usesDeductions(a) ? subacRow(a, r) : {
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

module.exports = { list, create, update, remove, detail, saveParticipation, subacScore };
