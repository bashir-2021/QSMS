'use strict';
const mongoose = require('mongoose');
const { StudentAttendance, TeacherAttendance, Student, Teacher, Class, ClassShift } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const { badRequest, forbidden } = require('../utils/errors');
const { owned, ownedOptional } = require('./scope');
const shiftService = require('./shiftService');

const oid = (v) => new mongoose.Types.ObjectId(String(v));

/* ------------------------------ Daily registers --------------------------- */

/** The register for one shift of a class (the first shift unless `shiftId` picks another). A class without shifts has one register. */
async function studentSheet(tenantId, classId, day, restrict, shiftId) {
  const cls = await owned(Class, tenantId, classId, 'Class');
  if (restrict && !restrict.map(String).includes(String(cls._id))) throw forbidden('You can only take attendance for your own classes.');
  const date = dates.parseDay(day) || dates.startOfDay();
  const shifts = await shiftService.forClass(tenantId, cls._id, { activeOnly: true });
  const shift = shifts.find((s) => String(s._id) === String(shiftId)) || shifts[0] || null;
  const [students, records] = await Promise.all([
    Student.find({ tenantId, class: cls._id, status: 'active', ...(shift ? { shifts: shift._id } : {}) }).sort({ fullName: 1 }).select('fullName studentCode photo').lean(),
    StudentAttendance.find({ tenantId, class: cls._id, date, shift: shift ? shift._id : null }).lean(),
  ]);
  const map = Object.fromEntries(records.map((r) => [String(r.student), r]));
  return { cls, date, shifts, shift, rows: students.map((s) => ({ student: s, record: map[String(s._id)] || null })), saved: records.length > 0 };
}

/** entries = { [studentId]: { status, remarks } }. `shiftId` is required when the class has shifts. */
async function saveStudentSheet(ctx, classId, day, entries = {}, restrict, shiftId) {
  const cls = await owned(Class, ctx.tenantId, classId, 'Class');
  if (restrict && !restrict.map(String).includes(String(cls._id))) throw forbidden('You can only take attendance for your own classes.');
  const date = dates.parseDay(day);
  if (!date) throw badRequest('Choose a valid date.');
  if (date > dates.endOfDay()) throw badRequest('Attendance cannot be recorded for a future date.');
  const shifts = await shiftService.forClass(ctx.tenantId, cls._id, { activeOnly: true });
  const shift = shifts.find((s) => String(s._id) === String(shiftId)) || null;
  if (shifts.length && !shift) throw badRequest('Choose a shift of this class.');
  const ids = Object.keys(entries).filter((x) => /^[a-f0-9]{24}$/i.test(x));
  const inRegister = { tenantId: ctx.tenantId, _id: { $in: ids }, class: cls._id, ...(shift ? { shifts: shift._id } : {}) };
  const valid = new Set((await Student.find(inRegister).select('_id').lean()).map((s) => String(s._id)));
  const shiftValue = shift ? shift._id : null;
  const ops = ids.filter((id) => valid.has(id) && C.ATTENDANCE_STATUSES.includes(entries[id].status)).map((id) => ({
    updateOne: {
      filter: { tenantId: ctx.tenantId, student: id, date, shift: shiftValue },
      update: {
        $set: { status: entries[id].status, remarks: String(entries[id].remarks || '').slice(0, 300), class: cls._id, recordedBy: ctx.user._id },
        $setOnInsert: { tenantId: ctx.tenantId, student: id, date, shift: shiftValue },
      },
      upsert: true,
    },
  }));
  if (ops.length) await StudentAttendance.bulkWrite(ops);
  return { cls, date, shift, saved: ops.length };
}

async function teacherSheet(tenantId, day) {
  const date = dates.parseDay(day) || dates.startOfDay();
  const [teachers, records] = await Promise.all([
    Teacher.find({ tenantId, status: { $in: ['active', 'on_leave'] } }).sort({ fullName: 1 }).select('fullName teacherCode status').lean(),
    TeacherAttendance.find({ tenantId, date }).lean(),
  ]);
  const map = Object.fromEntries(records.map((r) => [String(r.teacher), r]));
  return { date, rows: teachers.map((t) => ({ teacher: t, record: map[String(t._id)] || null })), saved: records.length > 0 };
}

async function saveTeacherSheet(ctx, day, entries = {}) {
  const date = dates.parseDay(day);
  if (!date) throw badRequest('Choose a valid date.');
  if (date > dates.endOfDay()) throw badRequest('Attendance cannot be recorded for a future date.');
  const ids = Object.keys(entries).filter((x) => /^[a-f0-9]{24}$/i.test(x));
  const valid = new Set((await Teacher.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).select('_id').lean()).map((t) => String(t._id)));
  const time = (v) => (/^\d{2}:\d{2}$/.test(v || '') ? v : undefined);
  const ops = ids.filter((id) => valid.has(id) && C.ATTENDANCE_STATUSES.includes(entries[id].status)).map((id) => ({
    updateOne: {
      filter: { tenantId: ctx.tenantId, teacher: id, date },
      update: {
        $set: {
          status: entries[id].status, checkIn: time(entries[id].checkIn), checkOut: time(entries[id].checkOut),
          remarks: String(entries[id].remarks || '').slice(0, 300), recordedBy: ctx.user._id,
        },
        $setOnInsert: { tenantId: ctx.tenantId, teacher: id, date },
      },
      upsert: true,
    },
  }));
  if (ops.length) await TeacherAttendance.bulkWrite(ops);
  return { date, saved: ops.length };
}

/* --------------------------------- Reports -------------------------------- */

function rangeFor(q) {
  const period = q.period || 'monthly';
  const anchor = dates.parseDay(q.date) || dates.startOfDay();
  if (period === 'daily') return { from: anchor, to: dates.endOfDay(anchor), label: dates.formatDate(anchor) };
  if (period === 'weekly') {
    const from = dates.addDays(anchor, -6);
    return { from, to: dates.endOfDay(anchor), label: `${dates.formatDate(from)} – ${dates.formatDate(anchor)}` };
  }
  if (period === 'custom') {
    const r = dates.rangeFromQuery(q);
    return { from: r.from, to: r.to, label: `${dates.formatDate(r.from)} – ${dates.formatDate(r.to)}` };
  }
  const p = dates.isPeriod(q.month) ? q.month : dates.currentPeriod(anchor);
  const r = dates.periodRange(p);
  return { from: r.start, to: r.end, label: dates.periodLabel(p) };
}

const tally = () => ({ present: 0, absent: 0, late: 0, excused: 0, total: 0 });
const rate = (t) => (t.total ? Math.round(((t.present + t.late) / t.total) * 100) : null);

/**
 * Attendance report.
 * q.scope: 'student' (default) or 'teacher'; q.period: daily | weekly | monthly | custom;
 * optional q.class / q.shift / q.student / q.teacher filters.
 */
async function report(tenantId, q = {}, restrict) {
  const { from, to, label } = rangeFor(q);
  const scope = q.scope === 'teacher' ? 'teacher' : 'student';
  const match = { tenantId, date: { $gte: from, $lte: to } };
  let title;

  if (scope === 'teacher') {
    const teacher = await ownedOptional(Teacher, tenantId, q.teacher, 'Teacher');
    if (teacher) match.teacher = teacher._id;
    title = teacher ? `Teacher attendance — ${teacher.fullName}` : 'Teacher attendance';
    const agg = await TeacherAttendance.aggregate([{ $match: match }, { $group: { _id: { t: '$teacher', s: '$status' }, n: { $sum: 1 } } }]);
    const teachers = await Teacher.find({ tenantId, _id: { $in: [...new Set(agg.map((a) => String(a._id.t)))].map(oid) } }).select('fullName teacherCode').lean();
    const rows = {};
    teachers.forEach((t) => { rows[String(t._id)] = { name: t.fullName, code: t.teacherCode, ...tally() }; });
    agg.forEach((a) => { const r = rows[String(a._id.t)]; if (r) { r[a._id.s] += a.n; r.total += a.n; } });
    const list = Object.values(rows).sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ ...r, rate: rate(r) }));
    return { scope, title, label, from, to, rows: list, totals: totalsOf(list), daily: await dailySeries(TeacherAttendance, match) };
  }

  if (q.class) {
    const cls = await owned(Class, tenantId, q.class, 'Class');
    if (restrict && !restrict.map(String).includes(String(cls._id))) throw forbidden('You can only view your own classes.');
    match.class = cls._id;
    title = `Student attendance — ${cls.name}`;
    const shift = /^[a-f0-9]{24}$/i.test(q.shift || '') ? await ClassShift.findOne({ tenantId, _id: q.shift, class: cls._id }).lean() : null;
    if (shift) {
      match.shift = shift._id;
      title = `Student attendance — ${cls.name} · ${shift.name}`;
    }
  } else if (restrict) {
    match.class = { $in: restrict };
  }
  if (q.student) {
    const st = await owned(Student, tenantId, q.student, 'Student');
    match.student = st._id;
    title = `Student attendance — ${st.fullName}`;
  }
  title = title || 'Student attendance';
  const agg = await StudentAttendance.aggregate([{ $match: match }, { $group: { _id: { st: '$student', s: '$status' }, n: { $sum: 1 } } }]);
  const students = await Student.find({ tenantId, _id: { $in: [...new Set(agg.map((a) => String(a._id.st)))].map(oid) } })
    .select('fullName studentCode class').populate('class', 'name').lean();
  const rows = {};
  students.forEach((s) => { rows[String(s._id)] = { name: s.fullName, code: s.studentCode, className: s.class ? s.class.name : '—', ...tally() }; });
  agg.forEach((a) => { const r = rows[String(a._id.st)]; if (r) { r[a._id.s] += a.n; r.total += a.n; } });
  const list = Object.values(rows).sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ ...r, rate: rate(r) }));
  return { scope, title, label, from, to, rows: list, totals: totalsOf(list), daily: await dailySeries(StudentAttendance, match) };
}

function totalsOf(list) {
  const t = tally();
  list.forEach((r) => C.ATTENDANCE_STATUSES.forEach((s) => { t[s] += r[s]; t.total += r[s]; }));
  return { ...t, rate: rate(t) };
}

async function dailySeries(Model, match) {
  const agg = await Model.aggregate([
    { $match: match },
    { $group: { _id: { d: '$date', s: '$status' }, n: { $sum: 1 } } },
    { $sort: { '_id.d': 1 } },
  ]);
  const days = {};
  agg.forEach((a) => {
    const k = dates.toISODate(a._id.d);
    days[k] = days[k] || tally();
    days[k][a._id.s] += a.n;
    days[k].total += a.n;
  });
  return Object.entries(days).map(([day, t]) => ({ day, ...t, rate: rate(t) }));
}

/** Today's numbers for the dashboard. */
async function today(tenantId) {
  const date = dates.startOfDay();
  const [s, t, activeStudents] = await Promise.all([
    StudentAttendance.aggregate([{ $match: { tenantId, date } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    TeacherAttendance.aggregate([{ $match: { tenantId, date } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Student.countDocuments({ tenantId, status: 'active' }),
  ]);
  const toT = (agg) => { const x = tally(); agg.forEach((a) => { x[a._id] = a.n; x.total += a.n; }); return { ...x, rate: rate(x) }; };
  return { students: toT(s), teachers: toT(t), activeStudents };
}

module.exports = { studentSheet, saveStudentSheet, teacherSheet, saveTeacherSheet, report, today };
