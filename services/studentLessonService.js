'use strict';
const { Student, StudentLesson, Teacher, Class } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const quran = require('../utils/quran');
const { paginate } = require('../utils/paginate');
const { badRequest, conflict, forbidden } = require('../utils/errors');
const { owned, ownedOptional } = require('./scope');
const studentService = require('./studentService');
const settingsService = require('./settingsService');

/**
 * Each student's own Quran lessons, in two steps:
 *
 *  1. Give: the teacher gives the student a portion (start and end surah/ayah) on a day. The lesson is now
 *     "not listened to yet" and has no score. More lessons can be given before earlier ones are listened to.
 *  2. Listen: later, the teacher listens to a lesson the student has already taken. Each sitting runs through
 *     one chain, using the school's own rules:
 *
 *       attendance -> lesson status -> warnings -> score -> hifz level -> result
 *
 *     Absent: only the absence is kept — no score, level or result; the lesson stays waiting.
 *     Listened to: score = 100 - warnings x points; reaching the warning limit returns the lesson.
 *     Returned: the lesson is to be repeated; the reason is kept.
 *
 * A waiting or returned lesson stays open until it is passed. Each sitting is appended as a new attempt and
 * the earlier ones are never changed or removed.
 */

const SCORE_BASE = C.LESSON_SCORE_BASE;
const round2 = (n) => Math.round(n * 100) / 100;

function assertStudentAllowed(student, restrict) {
  if (restrict && !(student.class && restrict.map(String).includes(String(student.class._id || student.class)))) {
    throw forbidden('You can only manage your own classes.');
  }
}

/* ------------------------------- Scoring chain ------------------------------ */

const lowestLevel = (rules) => rules.levels[rules.levels.length - 1].label;
const levelFor = (rules, score) => (rules.levels.find((l) => score >= l.min) || rules.levels[rules.levels.length - 1]).label;

/**
 * Turn what the teacher entered into the sitting's outcome under the school's rules.
 * Pure function — the lesson form's live preview (public/js/student-lesson.js) mirrors it.
 */
function evaluate(input, rules) {
  const snapshot = { maxWarnings: rules.maxWarnings, pointsPerWarning: rules.pointsPerWarning, returnBelowScore: rules.returnBelowScore };
  if (input.attendance === 'absent') return { attendance: 'absent', rules: snapshot };
  const status = C.LISTEN_STATUSES.includes(input.status) ? input.status : null;
  if (!status) throw badRequest('Choose whether the lesson was listened to or returned.');

  const raw = input.warnings === undefined || input.warnings === '' ? 0 : Number(input.warnings);
  if (!Number.isInteger(raw) || raw < 0 || raw > 1000) throw badRequest('Warnings must be a whole number of 0 or more.');
  const warnings = raw;
  const score = Math.max(0, round2(SCORE_BASE - warnings * rules.pointsPerWarning));
  const reason = String(input.returnReason || '').trim().slice(0, 300);
  const out = { attendance: 'present', warnings, score, rules: snapshot };

  const overLimit = warnings >= rules.maxWarnings;
  const belowMin = rules.returnBelowScore > 0 && score < rules.returnBelowScore;
  if (status === 'returned' || overLimit || belowMin) {
    const auto = status !== 'returned';
    let autoReason;
    if (overLimit) autoReason = `Reached the warning limit (${warnings}/${rules.maxWarnings})`;
    else if (belowMin) autoReason = `Score below ${rules.returnBelowScore}`;
    if (!reason && !autoReason) throw badRequest('Give the reason the lesson is returned.');
    return {
      ...out,
      // a lesson the teacher returns by hand keeps only the reason; one returned by the rules keeps its score
      score: auto ? score : undefined,
      status: 'returned', level: lowestLevel(rules), result: 'repeat',
      autoReturned: auto || undefined, returnReason: reason || autoReason,
    };
  }
  return { ...out, status: 'heard', level: levelFor(rules, score), result: 'passed' };
}

const { reasonText } = quran;

/* --------------------------------- Portions -------------------------------- */

/**
 * The lesson's portion: start and end surah/ayah (a whole juz can be picked to fill them),
 * or a topic alone for Farbar students who are still learning to write.
 */
function readPortion(data, program) {
  const topic = String(data.topic || '').trim().slice(0, 200) || undefined;
  let start = { surah: Number(data.startSurah), ayah: Number(data.startAyah) };
  let end = { surah: Number(data.endSurah), ayah: Number(data.endAyah) };
  if (data.juz && !data.startSurah && !data.endSurah) {
    const range = quran.juzRange(data.juz);
    if (!range) throw badRequest('Juz must be between 1 and 30');
    ({ start, end } = range);
  }
  const any = start.surah || start.ayah || end.surah || end.ayah;
  if (!any) {
    if (topic && program === 'farbar') return { topic, start: undefined, end: undefined };
    throw badRequest(program === 'farbar' ? 'Enter the start and end of the lesson, or a topic.' : 'Enter the start and end of the lesson.');
  }
  for (const [label, ref] of [['start', start], ['end', end]]) {
    const s = quran.getSurah(ref.surah);
    if (!s) throw badRequest(label === 'start' ? 'Choose the surah the lesson starts at.' : 'Choose the surah the lesson ends at.');
    if (!(Number.isInteger(ref.ayah) && ref.ayah >= 1 && ref.ayah <= s.verses)) {
      throw badRequest('{surah} has {verses} ayahs — check the ayah number.', null, { surah: s.name, verses: s.verses });
    }
  }
  const size = quran.measure(start, end);
  if (!size) throw badRequest('The lesson must end at or after the ayah it starts at.');
  return { start, end, topic, ...size };
}


const { portionText } = quran;

/* --------------------------------- Helpers --------------------------------- */

/** The teacher: the one chosen on the form, else the signed-in teacher, else the class's main teacher. */
async function resolveTeacher(ctx, teacherId, student) {
  if (teacherId) return (await ownedOptional(Teacher, ctx.tenantId, teacherId, 'Teacher'))._id;
  if (ctx.user && ctx.user.teacher) return ctx.user.teacher;
  if (student.class) {
    const cls = await Class.findOne({ tenantId: ctx.tenantId, _id: student.class._id || student.class }).select('teachers').lean();
    if (cls && cls.teachers && cls.teachers.length) return cls.teachers[0];
  }
  return undefined;
}

async function currentRules(tenantId) {
  return settingsService.lessonRules(await settingsService.get(tenantId));
}

function readDay(value) {
  if (!value) return dates.startOfDay();
  const d = dates.parseDay(value);
  if (!d) throw badRequest('Enter a valid date.');
  if (d > dates.startOfDay(dates.addDays(new Date(), 1))) throw badRequest('The date cannot be in the future.');
  return d;
}

/** The lesson's top-level fields that mirror its latest sitting. An absence leaves the lesson waiting as it was. */
function mirror(outcome) {
  if (outcome.attendance === 'absent') return { attendance: 'absent' };
  return {
    attendance: 'present',
    status: outcome.status,
    result: outcome.result,
    warnings: outcome.warnings === undefined ? null : outcome.warnings,
    score: outcome.score === undefined ? null : outcome.score,
    level: outcome.level,
    isOpen: outcome.result !== 'passed',
  };
}

/* ---------------------------------- Board ---------------------------------- */

/** One page of active students, each with their open lessons, latest lesson and today's sittings. */
async function board(tenantId, q = {}, restrict) {
  const page = await paginate(Student, studentService.buildFilter(tenantId, { ...q, status: 'active' }, restrict), {
    page: q.page, limit: q.limit || 20, sort: { fullName: 1 }, populate: { path: 'class', select: 'name' },
  });
  const ids = page.items.map((s) => s._id);
  const today = dates.startOfDay();
  const [open, latest, todays] = await Promise.all([
    StudentLesson.find({ tenantId, student: { $in: ids }, isOpen: true }).sort({ date: 1, createdAt: 1 }).lean(),
    StudentLesson.aggregate([
      { $match: { tenantId, student: { $in: ids } } },
      { $sort: { date: -1, createdAt: -1 } },
      { $group: { _id: '$student', lesson: { $first: '$$ROOT' } } },
    ]),
    StudentLesson.find({ tenantId, student: { $in: ids }, 'attempts.date': today }).select('student attempts.date attempts.attendance attempts.status attempts.result').lean(),
  ]);
  const by = (rows, key) => rows.reduce((m, r) => { (m[String(r[key])] = m[String(r[key])] || []).push(r); return m; }, {});
  const openBy = by(open, 'student');
  const latestBy = Object.fromEntries(latest.map((p) => [String(p._id), p.lesson]));
  const todayBy = {};
  todays.forEach((l) => {
    const sittings = l.attempts.filter((a) => String(a.date) === String(today));
    (todayBy[String(l.student)] = todayBy[String(l.student)] || []).push(...sittings);
  });
  page.items.forEach((s) => {
    s.openLessons = openBy[String(s._id)] || [];
    s.lastLesson = latestBy[String(s._id)] || null;
    s.today = todayBy[String(s._id)] || [];
  });
  return page;
}

/* ------------------------------- Lesson forms ------------------------------ */

/** Where the next lesson probably starts: the ayah after the last one given, to the end of that page. */
function suggestNext(last) {
  if (!last || !last.end || !last.end.surah) return {};
  const nextId = quran.ayahId(last.end.surah, last.end.ayah) + 1;
  if (nextId > quran.TOTAL_AYAHS) return {};
  const start = quran.fromAyahId(nextId);
  const page = quran.pageOf(nextId);
  const pageEnd = quran.fromAyahId(page < quran.TOTAL_PAGES ? quran.layout().pageStarts[page] - 1 : quran.TOTAL_AYAHS);
  return { start, end: pageEnd };
}

/**
 * Everything the two forms need: the student, the lesson to listen to (if any), the school's rules, and beside
 * the form the latest lesson, the open lessons and recent history.
 */
async function formData(tenantId, { studentId, lessonId }, restrict, user) {
  let lesson = null;
  if (lessonId) {
    lesson = await owned(StudentLesson, tenantId, lessonId, 'Lesson');
    studentId = lesson.student;
  }
  const student = await owned(Student, tenantId, studentId, 'Student', { populate: { path: 'class', select: 'name teachers' } });
  assertStudentAllowed(student, restrict);
  const [history, open, rules, teachers] = await Promise.all([
    StudentLesson.find({ tenantId, student: student._id }).sort({ date: -1, createdAt: -1 }).limit(15).lean(),
    StudentLesson.find({ tenantId, student: student._id, isOpen: true }).sort({ date: 1, createdAt: 1 }).lean(),
    currentRules(tenantId),
    Teacher.find({ tenantId, status: { $in: ['active', 'on_leave'] } }).sort({ fullName: 1 }).select('fullName').lean(),
  ]);
  const lastLesson = history.find((l) => l.start && l.start.surah) || null;
  const classTeacher = student.class && student.class.teachers && student.class.teachers[0];
  return {
    student, lesson, history, openLessons: open, rules, teachers, lastLesson,
    suggestion: lesson ? {} : suggestNext(lastLesson),
    // the teacher is usually the one signed in; otherwise whoever gave the lesson, else the class's main teacher
    defaultTeacher: (user && user.teacher) || (lesson && lesson.teacher) || classTeacher || null,
  };
}

/* ------------------------------ 1. Give a lesson ---------------------------- */

/** Give a student a new lesson. It waits to be listened to; nothing is scored yet. */
async function give(ctx, data, restrict) {
  const student = await owned(Student, ctx.tenantId, data.student, 'Student');
  assertStudentAllowed(student, restrict);
  if (student.status !== 'active') throw badRequest('Lessons can only be given to active students.');
  const rules = await currentRules(ctx.tenantId);
  const lessonType = String(data.lessonType || '').trim();
  if (!rules.types.includes(lessonType)) throw badRequest('Choose one of the school\'s lesson types.');
  const portion = readPortion(data, student.program);
  const lesson = await StudentLesson.create({
    tenantId: ctx.tenantId, student: student._id, class: student.class, program: student.program,
    teacher: await resolveTeacher(ctx, data.teacher, student), date: readDay(data.date), lessonType, ...portion,
    status: 'pending', result: 'pending', isOpen: true, attempts: [], createdBy: ctx.user._id,
  });
  return { lesson, student };
}

/* ------------------------------ 2. Listen to it ----------------------------- */

/** Listen to a lesson the student has taken (waiting or returned): appends a new sitting. */
async function listen(ctx, id, data, restrict) {
  const lesson = await owned(StudentLesson, ctx.tenantId, id, 'Lesson');
  const student = await owned(Student, ctx.tenantId, lesson.student, 'Student');
  assertStudentAllowed(student, restrict);
  if (!lesson.isOpen) throw conflict('This lesson was already passed and is closed.');
  if (data.attendance !== 'present' && data.attendance !== 'absent') throw badRequest('Choose whether the student is present or absent.');
  const rules = await currentRules(ctx.tenantId);
  const date = readDay(data.date);
  if (date < lesson.date) throw badRequest('A lesson cannot be listened to before the day it was given.');
  const outcome = evaluate(data, rules);
  const attempt = 1 + lesson.attempts.filter((a) => a.status === 'returned').length;
  const recordedAt = new Date();
  const entry = {
    attempt, date, ...outcome, teacher: await resolveTeacher(ctx, data.teacher, student),
    remarks: String(data.remarks || '').trim().slice(0, 500) || undefined, recordedBy: ctx.user._id, recordedAt,
  };
  const set = mirror(outcome);
  if (outcome.result === 'passed') set.passedAt = recordedAt;
  // the attempt count in the filter stops a double submission from recording the sitting twice
  const updated = await StudentLesson.findOneAndUpdate(
    { tenantId: ctx.tenantId, _id: lesson._id, isOpen: true, attempts: { $size: lesson.attempts.length } },
    { $set: set, $push: { attempts: entry } },
    { new: true },
  ).lean();
  if (!updated) throw conflict('This lesson was just updated. Reload the page and try again.');
  return { lesson: updated, student, outcome };
}

/**
 * Remove a lesson given by mistake. Only a lesson that was never listened to can go: results and absences
 * are part of the student's record and are kept.
 */
async function remove(ctx, id, restrict) {
  const lesson = await owned(StudentLesson, ctx.tenantId, id, 'Lesson');
  const student = await owned(Student, ctx.tenantId, lesson.student, 'Student');
  assertStudentAllowed(student, restrict);
  if (lesson.attempts.length) throw conflict('Lessons that were listened to or record an absence are kept and cannot be deleted.');
  const res = await StudentLesson.deleteOne({ tenantId: ctx.tenantId, _id: lesson._id, attempts: { $size: 0 } });
  if (!res.deletedCount) throw conflict('This lesson was just updated. Reload the page and try again.');
  return { lesson, student };
}

/* --------------------------------- Reports --------------------------------- */

const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));

/**
 * Lesson report for a date range (default: today): lessons given in the range, and sittings (listening) in the
 * range — a lesson listened to again on a later day shows on that day too. Filters: student, teacher (who gave or
 * listened), class (halaqa), sitting status and result.
 */
async function report(tenantId, q = {}, restrict) {
  const today = dates.startOfDay();
  let to = dates.parseDay(q.to) || today;
  let from = dates.parseDay(q.from) || today;
  if (to < from) [from, to] = [to, from];
  // at most one year at a time; the report's subtitle shows the dates actually used
  if (dates.daysBetween(from, to) > 365) from = dates.addDays(to, -365);
  const end = dates.endOfDay(to);

  const scope = { tenantId };
  if (isId(q.student)) scope.student = q.student;
  if (isId(q.class)) scope.class = q.class;
  if (restrict) scope.class = scope.class && restrict.map(String).includes(String(scope.class)) ? scope.class : { $in: restrict };

  const teacher = isId(q.teacher) ? String(q.teacher) : null;
  const gaveOrListened = teacher ? { $or: [{ teacher }, { 'attempts.teacher': teacher }] } : {};
  const [lessons, openLessons, givenLessons] = await Promise.all([
    StudentLesson.find({ ...scope, ...gaveOrListened, 'attempts.date': { $gte: from, $lte: end } }).sort({ date: 1, createdAt: 1 }).limit(20000).lean(),
    StudentLesson.find({ ...scope, ...gaveOrListened, isOpen: true }).sort({ date: 1, createdAt: 1 }).limit(5000).lean(),
    StudentLesson.find({ ...scope, ...(teacher ? { teacher } : {}), date: { $gte: from, $lte: end } }).select('student class teacher').limit(20000).lean(),
  ]);
  const all = [...lessons, ...openLessons, ...givenLessons];
  const ids = (key) => [...new Set(all.map((l) => l[key]).filter(Boolean).map(String))];
  const teacherIds = [...new Set([...ids('teacher'), ...lessons.flatMap((l) => l.attempts.map((a) => a.teacher)).filter(Boolean).map(String)])];
  const [students, classes, teachers] = await Promise.all([
    Student.find({ tenantId, _id: { $in: ids('student') } }).select('fullName studentCode').lean(),
    Class.find({ tenantId, _id: { $in: ids('class') } }).select('name').lean(),
    Teacher.find({ tenantId, _id: { $in: teacherIds } }).select('fullName').lean(),
  ]);
  const nameOf = (rows, key) => Object.fromEntries(rows.map((r) => [String(r._id), r[key]]));
  const studentName = nameOf(students, 'fullName');
  const studentCode = nameOf(students, 'studentCode');
  const className = nameOf(classes, 'name');
  const teacherName = nameOf(teachers, 'fullName');
  const common = (l) => ({
    lessonId: String(l._id), studentId: String(l.student), student: studentName[String(l.student)] || '', code: studentCode[String(l.student)] || '',
    className: className[String(l.class)] || '', teacher: teacherName[String(l.teacher)] || '', lessonType: l.lessonType || '',
    portion: portionText(l), portionArabic: portionText(l, { arabic: true }),
    ayahs: l.ayahs, pages: l.pages, juz: l.juz, lessonDate: l.date,
  });

  const wantStatus = q.status === 'absent' || C.LESSON_STATUSES_HEARD[q.status] ? q.status : null;
  const wantResult = C.LESSON_RESULTS[q.result] ? q.result : null;
  const sittings = [];
  lessons.forEach((l) => {
    l.attempts.filter((a) => a.date >= from && a.date <= end).forEach((a) => {
      const status = a.attendance === 'absent' ? 'absent' : a.status;
      if (wantStatus && status !== wantStatus) return;
      if (wantResult && a.result !== wantResult) return;
      const listener = String(a.teacher || l.teacher || '');
      if (teacher && listener !== teacher) return; // sittings belong to the teacher who listened
      sittings.push({
        ...common(l), teacher: teacherName[listener] || '', date: a.date, attempt: a.attempt, attendance: a.attendance, status, warnings: a.warnings,
        score: a.score, level: a.level, result: a.result, reason: a.returnReason, remarks: a.remarks,
      });
    });
  });
  sittings.sort((a, b) => (a.date - b.date) || a.student.localeCompare(b.student));

  // progress per student over the range
  const per = {};
  const entry = (studentId, classId) => per[studentId] || (per[studentId] = {
    studentId, student: studentName[studentId] || '', code: studentCode[studentId] || '', className: className[String(classId)] || '',
    given: 0, sittings: 0, present: 0, absent: 0, passed: 0, returned: 0, warnings: 0, scores: [], ayahs: 0, pages: 0, juz: 0, level: '',
  });
  givenLessons.forEach((l) => { entry(String(l.student), l.class).given += 1; });
  sittings.forEach((r) => {
    const p = per[r.studentId] || entry(r.studentId);
    p.className = p.className || r.className;
    p.sittings += 1;
    if (r.attendance === 'absent') { p.absent += 1; return; }
    p.present += 1;
    if (r.status === 'returned') p.returned += 1;
    if (typeof r.warnings === 'number') p.warnings += r.warnings;
    if (typeof r.score === 'number') p.scores.push(r.score);
    if (r.status === 'heard' || r.status === 'returned') p.level = r.level; // latest, rows are in date order
    if (r.result === 'passed') {
      p.passed += 1;
      p.ayahs += r.ayahs || 0;
      p.pages += r.pages || 0;
      p.juz = round2(p.juz + (r.juz || 0));
    }
  });
  const byStudent = Object.values(per).map((p) => ({
    ...p, avgScore: p.scores.length ? round2(p.scores.reduce((a, b) => a + b, 0) / p.scores.length) : null,
    attendanceRate: p.sittings ? Math.round((p.present / p.sittings) * 100) : null,
  })).sort((a, b) => a.student.localeCompare(b.student));

  const daysWaiting = (d) => Math.max(0, dates.daysBetween(d, today));
  // an open lesson is either waiting to be listened to or returned (an absence leaves its status as it was)
  const waiting = openLessons.filter((l) => l.status === 'pending').map((l) => ({
    ...common(l), attempts: l.attempts.length, days: daysWaiting(l.date), attendance: l.attendance,
  }));
  const returned = openLessons.filter((l) => l.status === 'returned').map((l) => {
    const lastReturn = [...l.attempts].reverse().find((a) => a.status === 'returned') || {};
    return { ...common(l), attempt: lastReturn.attempt, warnings: lastReturn.warnings, score: lastReturn.score, reason: lastReturn.returnReason, returnedOn: lastReturn.date, days: daysWaiting(lastReturn.date || l.date) };
  });

  const present = sittings.filter((r) => r.attendance === 'present');
  const scored = present.filter((r) => typeof r.score === 'number');
  const passed = present.filter((r) => r.result === 'passed');
  const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const totals = {
    sittings: sittings.length,
    present: present.length,
    absent: sittings.length - present.length,
    heard: present.filter((r) => r.status === 'heard').length,
    returned: present.filter((r) => r.status === 'returned').length,
    given: givenLessons.length,
    passed: passed.length,
    warnings: sum(present, 'warnings'),
    avgScore: scored.length ? round2(sum(scored, 'score') / scored.length) : null,
    ayahs: sum(passed, 'ayahs'),
    pages: sum(passed, 'pages'),
    juz: round2(sum(passed, 'juz')),
    waiting: waiting.length,
    openReturned: returned.length,
  };
  return { from, to, sittings, byStudent, waiting, returned, totals };
}

module.exports = {
  evaluate, reasonText, readPortion, portionText, board, formData, give, listen, remove, report, suggestNext,
};
