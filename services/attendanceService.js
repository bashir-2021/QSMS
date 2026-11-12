'use strict';
const mongoose = require('mongoose');
const { StudentAttendance, TeacherAttendance, Student, Teacher, Class, ClassShift } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const { badRequest, forbidden } = require('../utils/errors');
const { owned, ownedOptional } = require('./scope');
const shiftService = require('./shiftService');
const config = require('../config');

const oid = (v) => new mongoose.Types.ObjectId(String(v));

/* ------------------------------ Daily registers --------------------------- */

// who saved a record (the user lookup carries the school, as every query must)
const who = (tenantId) => ({ path: 'recordedBy', select: 'name role', match: { tenantId } });

/** The register for one shift of a class (the first shift unless `shiftId` picks another). A class without shifts has one register. */
async function studentSheet(tenantId, classId, day, restrict, shiftId) {
  const cls = await owned(Class, tenantId, classId, 'Class');
  if (restrict && !restrict.map(String).includes(String(cls._id))) throw forbidden('You can only take attendance for your own classes.');
  const date = dates.parseDay(day) || dates.startOfDay();
  const shifts = await shiftService.forClass(tenantId, cls._id, { activeOnly: true });
  const shift = shifts.find((s) => String(s._id) === String(shiftId)) || shifts[0] || null;
  const [students, records] = await Promise.all([
    Student.find({ tenantId, class: cls._id, status: 'active', ...(shift ? { shifts: shift._id } : {}) }).sort({ fullName: 1 }).select('fullName studentCode photo').lean(),
    StudentAttendance.find({ tenantId, class: cls._id, date, shift: shift ? shift._id : null }).populate(who(tenantId)).lean(),
  ]);
  const map = Object.fromEntries(records.map((r) => [String(r.student), r]));
  const rows = students.map((s) => ({ student: s, record: map[String(s._id)] || null }));
  const recorded = rows.filter((r) => r.record).length;
  return { cls, date, shifts, shift, rows, saved: recorded > 0, recorded, total: rows.length };
}

/**
 * entries = { [studentId]: { status, remarks } }. `shiftId` is required when the class has shifts.
 * `only` saves just that one student (the row's own Save button); otherwise every row is saved at once.
 * A row whose status and remarks did not change is left alone, so it keeps the name of whoever recorded it.
 */
async function saveStudentSheet(ctx, classId, day, entries = {}, restrict, shiftId, { only } = {}) {
  const cls = await owned(Class, ctx.tenantId, classId, 'Class');
  if (restrict && !restrict.map(String).includes(String(cls._id))) throw forbidden('You can only take attendance for your own classes.');
  const date = dates.parseDay(day);
  if (!date) throw badRequest('Choose a valid date.');
  if (date > dates.endOfDay()) throw badRequest('Attendance cannot be recorded for a future date.');
  const shifts = await shiftService.forClass(ctx.tenantId, cls._id, { activeOnly: true });
  const shift = shifts.find((s) => String(s._id) === String(shiftId)) || null;
  if (shifts.length && !shift) throw badRequest('Choose a shift of this class.');
  let ids = Object.keys(entries || {}).filter((x) => /^[a-f0-9]{24}$/i.test(x));
  if (only) ids = ids.filter((x) => x === String(only));
  const inRegister = { tenantId: ctx.tenantId, _id: { $in: ids }, class: cls._id, ...(shift ? { shifts: shift._id } : {}) };
  const valid = new Set((await Student.find(inRegister).select('_id').lean()).map((s) => String(s._id)));
  const shiftValue = shift ? shift._id : null;
  const existing = Object.fromEntries((await StudentAttendance.find({ tenantId: ctx.tenantId, student: { $in: [...valid] }, date, shift: shiftValue }).lean())
    .map((r) => [String(r.student), r]));
  const wanted = ids.filter((id) => valid.has(id) && C.ATTENDANCE_STATUSES.includes(entries[id].status));
  const remarksOf = (id) => String(entries[id].remarks || '').slice(0, 300);
  const changed = wanted.filter((id) => !existing[id] || existing[id].status !== entries[id].status || (existing[id].remarks || '') !== remarksOf(id));
  const ops = changed.map((id) => ({
    updateOne: {
      filter: { tenantId: ctx.tenantId, student: id, date, shift: shiftValue },
      update: {
        $set: { status: entries[id].status, remarks: remarksOf(id), class: cls._id, recordedBy: ctx.user._id },
        $setOnInsert: { tenantId: ctx.tenantId, student: id, date, shift: shiftValue },
      },
      upsert: true,
    },
  }));
  if (ops.length) await StudentAttendance.bulkWrite(ops);
  const records = await StudentAttendance.find({ tenantId: ctx.tenantId, student: { $in: wanted }, date, shift: shiftValue }).populate(who(ctx.tenantId)).lean();
  return { cls, date, shift, saved: changed.length, unchanged: wanted.length - changed.length, records };
}

/* ---------------------------- Teacher attendance -------------------------- */

const ACTIVE_TEACHER = ['active', 'on_leave'];
const OFF_STATUSES = ['absent', 'excused'];

/** A teacher's registered time on a day: { scheduledIn, scheduledOut, workDay }. */
function scheduleFor(teacher, day) {
  const days = teacher.workDays || [];
  return {
    scheduledIn: teacher.checkInTime || undefined,
    scheduledOut: teacher.checkOutTime || undefined,
    workDay: days.length ? days.includes(dates.weekdayOf(day)) : true,
  };
}

/** Minutes a time is after the registered one (positive = later), or null. */
function minutesLate(actual, scheduled) {
  const a = dates.minutesOf(actual);
  const s = dates.minutesOf(scheduled);
  return a == null || s == null ? null : a - s;
}

/** The registered time stored on a day's record, or the teacher's current one when the day has none yet. */
const savedSchedule = (record, teacher, day) => (record && record.scheduledIn
  ? { scheduledIn: record.scheduledIn, scheduledOut: record.scheduledOut, workDay: record.workDay !== false }
  : scheduleFor(teacher, day));

/** How late a teacher arrived and how early they left, in minutes (real times first, else what they pressed). */
function timing(record, schedule) {
  if (!record || !schedule.workDay) return { lateBy: null, earlyBy: null };
  const late = minutesLate(record.checkIn || record.selfCheckIn, schedule.scheduledIn);
  const out = minutesLate(record.checkOut || record.selfCheckOut, schedule.scheduledOut);
  return { lateBy: late > 0 ? late : null, earlyBy: out < 0 ? -out : null };
}

const teacherWho = (tenantId) => [who(tenantId), { path: 'approvedBy', select: 'name role', match: { tenantId } }];

async function teacherSheet(tenantId, day) {
  const date = dates.parseDay(day) || dates.clock(config.timeZone).day;
  const [teachers, records] = await Promise.all([
    Teacher.find({ tenantId, status: { $in: ACTIVE_TEACHER } }).sort({ fullName: 1 }).select('fullName teacherCode status workDays checkInTime checkOutTime').lean(),
    TeacherAttendance.find({ tenantId, date }).populate(teacherWho(tenantId)).lean(),
  ]);
  const map = Object.fromEntries(records.map((r) => [String(r.teacher), r]));
  const rows = teachers.map((t) => {
    const record = map[String(t._id)] || null;
    const schedule = savedSchedule(record, t, date);
    return { teacher: t, record, schedule, ...timing(record, schedule) };
  });
  return {
    date, rows, saved: records.length > 0,
    pending: records.filter((r) => r.approval === 'pending').length,
    recorded: records.length, total: rows.length,
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The receptionist's register. Saving a row records the real check-in and check-out and approves them;
 * a row the teacher checked into themselves is approved this way. `only` saves one teacher.
 * Rows already approved with nothing changed are left alone.
 */
async function saveTeacherSheet(ctx, day, entries = {}, { only } = {}) {
  const date = dates.parseDay(day);
  if (!date) throw badRequest('Choose a valid date.');
  if (date > dates.clock(config.timeZone).day) throw badRequest('Attendance cannot be recorded for a future date.');
  let ids = Object.keys(entries || {}).filter((x) => /^[a-f0-9]{24}$/i.test(x));
  if (only) ids = ids.filter((x) => x === String(only));
  const teachers = await Teacher.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).select('workDays checkInTime checkOutTime').lean();
  const byId = Object.fromEntries(teachers.map((t) => [String(t._id), t]));
  const existing = Object.fromEntries((await TeacherAttendance.find({ tenantId: ctx.tenantId, teacher: { $in: teachers.map((t) => t._id) }, date }).lean())
    .map((r) => [String(r.teacher), r]));
  const time = (v) => (TIME.test(String(v || '').trim()) ? String(v).trim() : undefined);
  const ops = [];
  ids.filter((id) => byId[id] && C.ATTENDANCE_STATUSES.includes(entries[id].status)).forEach((id) => {
    const e = entries[id];
    const off = OFF_STATUSES.includes(e.status);
    const next = {
      status: e.status,
      checkIn: off ? undefined : time(e.checkIn),
      checkOut: off ? undefined : time(e.checkOut),
      remarks: String(e.remarks || '').slice(0, 300),
    };
    if (next.checkIn && next.checkOut && next.checkOut < next.checkIn) throw badRequest('The check-out time must be after the check-in time.');
    const old = existing[id];
    const same = old && old.approval === 'approved' && old.status === next.status && (old.checkIn || undefined) === next.checkIn
      && (old.checkOut || undefined) === next.checkOut && (old.remarks || '') === next.remarks;
    if (same) return;
    const set = { status: next.status, remarks: next.remarks, approval: 'approved', approvedBy: ctx.user._id, approvedAt: new Date() };
    const unset = {};
    ['checkIn', 'checkOut'].forEach((k) => { if (next[k]) set[k] = next[k]; else unset[k] = ''; });
    const update = { $set: set, $setOnInsert: { tenantId: ctx.tenantId, teacher: id, date, recordedBy: ctx.user._id, ...scheduleFor(byId[id], date) } };
    if (Object.keys(unset).length) update.$unset = unset;
    ops.push({ updateOne: { filter: { tenantId: ctx.tenantId, teacher: id, date }, update, upsert: true } });
  });
  if (ops.length) await TeacherAttendance.bulkWrite(ops);
  return { date, saved: ops.length };
}

/**
 * A teacher presses Check in or Check out. The time is the school's clock now; it waits for the
 * receptionist to approve it. Arriving after the registered time is suggested as "late".
 */
async function selfCheck(ctx, teacherId, action) {
  if (!teacherId) throw forbidden('Your login is not linked to a teacher record. Ask the school administrator.');
  const teacher = await owned(Teacher, ctx.tenantId, teacherId, 'Teacher');
  if (!ACTIVE_TEACHER.includes(teacher.status)) throw forbidden('Only active teachers can check in.');
  const now = dates.clock(config.timeZone);
  const filter = { tenantId: ctx.tenantId, teacher: teacher._id, date: now.day };
  const record = await TeacherAttendance.findOne(filter);
  if (action === 'in') {
    if (record && (record.selfCheckIn || record.checkIn)) throw badRequest('You have already checked in today.');
    if (record && OFF_STATUSES.includes(record.status)) throw badRequest('Reception has already recorded you for today. Ask reception to change it.');
    const schedule = savedSchedule(record, teacher, now.day);
    const late = schedule.workDay && minutesLate(now.time, schedule.scheduledIn) > 0;
    const fields = { selfCheckIn: now.time, status: late ? 'late' : 'present', approval: 'pending' };
    if (record) {
      Object.assign(record, schedule, fields);
      await record.save();
      return { record, time: now.time, late };
    }
    try {
      const created = await TeacherAttendance.create({ ...filter, ...schedule, ...fields, recordedBy: ctx.user._id });
      return { record: created, time: now.time, late };
    } catch (err) {
      if (err.code === 11000) throw badRequest('You have already checked in today.');
      throw err;
    }
  }
  if (action === 'out') {
    if (!record || !(record.selfCheckIn || record.checkIn)) throw badRequest('Check in first.');
    if (record.selfCheckOut || record.checkOut) throw badRequest('You have already checked out today.');
    record.selfCheckOut = now.time;
    record.approval = 'pending';
    await record.save();
    const early = minutesLate(now.time, record.scheduledOut) < 0;
    return { record, time: now.time, early };
  }
  throw badRequest('Choose check in or check out.');
}

/** A teacher's own page: today's registered time, what they pressed today, and the last 30 days. */
async function myAttendance(tenantId, teacherId) {
  const teacher = await owned(Teacher, tenantId, teacherId, 'Teacher');
  const now = dates.clock(config.timeZone);
  const [today, history] = await Promise.all([
    TeacherAttendance.findOne({ tenantId, teacher: teacher._id, date: now.day }).populate(teacherWho(tenantId)).lean(),
    TeacherAttendance.find({ tenantId, teacher: teacher._id, date: { $gte: dates.addDays(now.day, -30) } }).sort({ date: -1 }).populate(teacherWho(tenantId)).lean(),
  ]);
  const schedule = savedSchedule(today, teacher, now.day);
  return {
    teacher, now, today, schedule, ...timing(today, schedule),
    history: history.map((r) => ({ ...r, ...timing(r, savedSchedule(r, teacher, r.date)) })),
  };
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

module.exports = { studentSheet, saveStudentSheet, teacherSheet, saveTeacherSheet, selfCheck, myAttendance, scheduleFor, minutesLate, report, today };
