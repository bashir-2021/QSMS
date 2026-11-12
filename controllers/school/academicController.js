'use strict';
/** Lessons & progress, Subac/Duruus activities, attendance. */
const ctx = require('../../utils/ctx');
const C = require('../../config/constants');
const { SURAHS, layout: mushafLayout } = require('../../utils/quran');

const quranLayout = mushafLayout(); // page/juz tables for the lesson form's live preview
const dates = require('../../utils/dates');
const config = require('../../config');
const { fmtClock } = require('../../utils/viewHelpers');
const lessonService = require('../../services/lessonService');
const studentLessonService = require('../../services/studentLessonService');
const shiftService = require('../../services/shiftService');
const activityService = require('../../services/activityService');
const attendanceService = require('../../services/attendanceService');
const classService = require('../../services/classService');
const teacherService = require('../../services/teacherService');
const exportService = require('../../services/exportService');
const audit = require('../../services/auditService');
const { Lesson, Student } = require('../../models');
const { owned } = require('../../services/scope');
const { notFound } = require('../../utils/errors');

const org = (req) => ({ name: req.tenant.name, logo: req.tenant.logo, address: [req.tenant.city, req.tenant.country].filter(Boolean).join(', ') });

/* --------------------------------- Lessons -------------------------------- */
async function lessons(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const [page, classes] = await Promise.all([lessonService.list(req.tenantId, req.query, restrict), classService.all(req.tenantId, restrict)]);
  res.render('lessons/index', { title: 'Quran lessons', page, classes, query: req.query, nav: 'lessons' });
}
async function lessonForm(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const [lesson, classes, teachers] = await Promise.all([
    req.params.id ? owned(Lesson, req.tenantId, req.params.id, 'Lesson') : null,
    classService.all(req.tenantId, restrict), teacherService.all(req.tenantId),
  ]);
  res.render('lessons/form', { title: lesson ? 'Edit lesson' : 'New lesson', lesson, classes, teachers, surahs: SURAHS, nav: 'lessons', presetClass: req.query.class || '' });
}
async function createLesson(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const l = await lessonService.create(ctx(req), req.body, restrict);
  await audit.school(req, 'lesson.create', { entity: 'Lesson', entityId: l._id });
  req.flash('success', 'Lesson created. Record each student’s performance below.');
  res.redirect(`/school/lessons/${l._id}`);
}
async function updateLesson(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const l = await lessonService.update(ctx(req), req.params.id, req.body, restrict);
  await audit.school(req, 'lesson.update', { entity: 'Lesson', entityId: l._id });
  req.flash('success', 'Lesson updated.');
  res.redirect(`/school/lessons/${l._id}`);
}
async function deleteLesson(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const l = await lessonService.remove(ctx(req), req.params.id, restrict);
  await audit.school(req, 'lesson.delete', { entity: 'Lesson', entityId: l._id, details: { title: l.title } });
  req.flash('success', 'Lesson deleted.');
  res.redirect('/school/lessons');
}
async function lessonDetail(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const data = await lessonService.detail(req.tenantId, req.params.id);
  if (restrict && !restrict.map(String).includes(String(data.lesson.class._id))) throw notFound('Lesson');
  res.render('lessons/show', { title: data.lesson.title, ...data, nav: 'lessons' });
}
async function saveProgress(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const n = await lessonService.saveProgress(ctx(req), req.params.id, req.body.rows, restrict);
  await audit.school(req, 'lesson.progress', { entity: 'Lesson', entityId: req.params.id, details: { students: n } });
  req.flash('success', n === 1 ? req.t('Progress saved for 1 student.') : req.t('Progress saved for {n} students.', { n }));
  res.redirect(`/school/lessons/${req.params.id}`);
}

/* ----------------------------- Student lessons ---------------------------- */
/** Go back to the same filtered board after an action; only that page is accepted. */
const boardUrl = (req) => (/^\/school\/student-lessons(\?[\w=&%.+-]*)?$/.test(req.body.back || '') ? req.body.back : '/school/student-lessons');

async function studentLessons(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const [page, classes] = await Promise.all([studentLessonService.board(req.tenantId, req.query, restrict), classService.all(req.tenantId, restrict)]);
  res.render('student-lessons/index', { title: 'Student lessons', page, classes, query: req.query, nav: 'student-lessons' });
}

/** Give a new lesson (?student=), or listen to one the student has taken (/:id/listen). */
async function studentLessonForm(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const data = await studentLessonService.formData(req.tenantId, { studentId: req.query.student, lessonId: req.params.id }, restrict, req.user);
  if (data.lesson && !data.lesson.isOpen) {
    req.flash('info', 'This lesson was already passed and is closed.');
    return res.redirect(`/school/student-lessons/new?student=${data.student._id}`);
  }
  return res.render('student-lessons/form', {
    title: data.lesson ? 'Listen to lesson' : 'Give lesson', ...data, surahs: SURAHS, mushaf: quranLayout,
    back: boardUrl({ body: { back: req.query.back } }), nav: 'student-lessons',
  });
}

/** Keep what the teacher typed when a lesson cannot be saved, and go back to the form. */
async function keepInputOnError(req, res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!err.expose || !err.status || err.status >= 500 || err.status === 403) throw err;
    req.flashForm({}, req.body);
    req.flash('danger', err.i18nKey ? req.t(err.i18nKey, err.vars) : req.t(err.message));
    return res.redirect(req.get('Referrer') || '/school/student-lessons');
  }
}

/** One line that says what the sitting came to, in the chain's own terms. */
function outcomeMessage(req, name, o) {
  if (o.attendance === 'absent') return ['warning', req.t('{name} was absent. Only the absence was recorded.', { name })];
  if (o.status === 'returned') {
    return ['warning', req.t('{name}: the lesson was returned and is to be repeated ({reason}).', { name, reason: studentLessonService.reasonText(req.t, o) })];
  }
  return ['success', req.t('{name} passed the lesson: {score}/100 · {level}.', { name, score: o.score, level: req.t(o.level) })];
}

async function giveStudentLesson(req, res) {
  await keepInputOnError(req, res, async () => {
    const { lesson, student } = await studentLessonService.give(ctx(req), req.body, await classService.restrictedClassIds(req));
    await audit.school(req, 'studentLesson.give', { entity: 'StudentLesson', entityId: lesson._id, details: { student: student.studentCode, portion: studentLessonService.portionText(lesson) } });
    req.flash('success', req.t('Lesson given to {name}. Listen to it when the student is ready.', { name: student.fullName }));
    res.redirect(boardUrl(req));
  });
}
async function listenStudentLesson(req, res) {
  await keepInputOnError(req, res, async () => {
    const { lesson, student, outcome } = await studentLessonService.listen(ctx(req), req.params.id, req.body, await classService.restrictedClassIds(req));
    await audit.school(req, 'studentLesson.listen', { entity: 'StudentLesson', entityId: lesson._id, details: { student: student.studentCode, attempt: lesson.attempts.length, attendance: outcome.attendance, status: outcome.status, score: outcome.score } });
    req.flash(...outcomeMessage(req, student.fullName, outcome));
    res.redirect(boardUrl(req));
  });
}
async function deleteStudentLesson(req, res) {
  const { lesson, student } = await studentLessonService.remove(ctx(req), req.params.id, await classService.restrictedClassIds(req));
  await audit.school(req, 'studentLesson.delete', { entity: 'StudentLesson', entityId: lesson._id, details: { student: student.studentCode } });
  req.flash('success', 'Lesson deleted.');
  res.redirect(boardUrl(req));
}

/** Daily and past lessons, attendance, waiting and returned lessons, levels and progress — HTML, PDF or Excel. */
async function studentLessonReport(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const data = await studentLessonService.report(req.tenantId, req.query, restrict);
  const t = req.t;
  const label = (map, k) => (map[k] ? t(map[k]) : '');
  const statusLabel = (s) => (s === 'absent' ? t('Absent') : label(C.LESSON_STATUSES_HEARD, s));
  const sitting = (r) => ({
    ...r, attendance: r.attendance === 'absent' ? t('Absent') : t('Present'), status: statusLabel(r.status),
    result: label(C.LESSON_RESULTS, r.result), level: r.level ? t(r.level) : '', reason: r.reason ? studentLessonService.reasonText(t, r) : '',
  });
  const portionCols = [
    { key: 'portionArabic', pdfKey: 'portion', label: t('Lesson (start – end)') },
    { key: 'ayahs', label: t('Ayahs'), type: 'number' }, { key: 'pages', label: t('Pages'), type: 'number' }, { key: 'juz', label: t('Juz'), type: 'number' },
  ];
  const tot = data.totals;
  const range = dates.toISODate(data.from) === dates.toISODate(data.to) ? dates.formatDate(data.from) : `${dates.formatDate(data.from)} – ${dates.formatDate(data.to)}`;
  const report = {
    title: t('Student lessons report'),
    subtitle: range,
    summary: [
      { label: t('Lessons given'), value: tot.given, type: 'number' }, { label: t('Sittings'), value: tot.sittings, type: 'number' }, { label: t('Present'), value: tot.present, type: 'number' },
      { label: t('Absent'), value: tot.absent, type: 'number' }, { label: t('Passed'), value: tot.passed, type: 'number' },
      { label: t('Returned'), value: tot.returned, type: 'number' }, { label: t('Waiting to be listened to'), value: tot.waiting, type: 'number' },
      { label: t('Average score'), value: tot.avgScore == null ? '—' : tot.avgScore, type: 'text' }, { label: t('Warnings'), value: tot.warnings, type: 'number' },
      { label: t('Ayahs passed'), value: tot.ayahs, type: 'number' }, { label: t('Pages passed'), value: tot.pages, type: 'number' },
      { label: t('Juz passed'), value: tot.juz, type: 'number' },
    ],
    sections: [{
      title: t('Lessons'),
      columns: [{ key: 'date', label: t('Date'), type: 'date' }, { key: 'student', label: t('Student') }, { key: 'className', label: t('Class') },
        { key: 'teacher', label: t('Teacher listening') }, { key: 'lessonType', label: t('Lesson type') }, ...portionCols,
        { key: 'attempt', label: t('Attempt'), type: 'number' }, { key: 'attendance', label: t('Attendance') }, { key: 'status', label: t('Lesson status') },
        { key: 'warnings', label: t('Warnings'), type: 'number' }, { key: 'score', label: t('Score'), type: 'number' }, { key: 'level', label: t('Hifz level') },
        { key: 'result', label: t('Result') }, { key: 'reason', label: t('Reason') }],
      rows: data.sittings.map(sitting),
    }, {
      title: t('Progress by student'),
      columns: [{ key: 'code', label: t('ID') }, { key: 'student', label: t('Student') }, { key: 'className', label: t('Class') },
        { key: 'given', label: t('Lessons given'), type: 'number' }, { key: 'sittings', label: t('Sittings'), type: 'number' }, { key: 'present', label: t('Present'), type: 'number' }, { key: 'absent', label: t('Absent'), type: 'number' },
        { key: 'passed', label: t('Passed'), type: 'number' }, { key: 'returned', label: t('Returned'), type: 'number' },
        { key: 'warnings', label: t('Warnings'), type: 'number' }, { key: 'avgScore', label: t('Average score'), type: 'number' }, { key: 'level', label: t('Latest hifz level') },
        { key: 'ayahs', label: t('Ayahs passed'), type: 'number' }, { key: 'pages', label: t('Pages passed'), type: 'number' }, { key: 'juz', label: t('Juz passed'), type: 'number' }],
      rows: data.byStudent.map((p) => ({ ...p, level: p.level ? t(p.level) : '' })),
      totals: { code: t('Total'), given: tot.given, sittings: tot.sittings, present: tot.present, absent: tot.absent, passed: tot.passed, returned: tot.returned, warnings: tot.warnings, avgScore: tot.avgScore, ayahs: tot.ayahs, pages: tot.pages, juz: tot.juz },
    }, {
      title: t('Waiting to be listened to'),
      columns: [{ key: 'lessonDate', label: t('Given on'), type: 'date' }, { key: 'student', label: t('Student') }, { key: 'className', label: t('Class') },
        { key: 'teacher', label: t('Teacher') }, ...portionCols, { key: 'days', label: t('Days waiting'), type: 'number' }],
      rows: data.waiting,
    }, {
      title: t('Returned lessons'),
      columns: [{ key: 'returnedOn', label: t('Returned on'), type: 'date' }, { key: 'student', label: t('Student') }, { key: 'className', label: t('Class') },
        { key: 'teacher', label: t('Teacher') }, ...portionCols, { key: 'attempt', label: t('Attempt'), type: 'number' }, { key: 'warnings', label: t('Warnings'), type: 'number' },
        { key: 'reason', label: t('Reason') }],
      rows: data.returned.map((r) => ({ ...r, reason: r.reason ? studentLessonService.reasonText(t, r) : '' })),
    }],
  };
  if (await exportService.respond(req, res, report, { org: org(req), currency: req.settings.currency })) return;
  const [classes, teachers, student] = await Promise.all([
    classService.all(req.tenantId, restrict), teacherService.all(req.tenantId, { activeOnly: false }),
    /^[a-f0-9]{24}$/i.test(req.query.student || '') ? Student.findOne({ tenantId: req.tenantId, _id: req.query.student }).select('fullName').lean() : null,
  ]);
  res.render('student-lessons/report', {
    title: 'Student lessons report', report, query: req.query, from: dates.toISODate(data.from), to: dates.toISODate(data.to),
    classes, teachers, student, nav: 'student-lessons-report',
  });
}

/* ------------------------- Activities (Subac/Duruus) ---------------------- */
const typeOf = (req) => {
  if (!C.ACTIVITY_TYPES[req.params.type]) throw notFound('Activity type');
  return req.params.type;
};
async function activities(req, res) {
  const type = typeOf(req);
  const restrict = await classService.restrictedClassIds(req);
  const [page, classes] = await Promise.all([activityService.list(req.tenantId, type, req.query, restrict), classService.all(req.tenantId, restrict)]);
  res.render('activities/index', { title: C.ACTIVITY_TYPES[type], type, page, classes, query: req.query, nav: type });
}
async function activityForm(req, res) {
  const type = typeOf(req);
  const restrict = await classService.restrictedClassIds(req);
  const [activity, classes, teachers] = await Promise.all([
    req.params.id ? activityService.detail(req.tenantId, type, req.params.id).then((d) => d.activity) : null,
    classService.all(req.tenantId, restrict), teacherService.all(req.tenantId),
  ]);
  res.render('activities/form', { title: req.t(activity ? 'Edit {type}' : 'New {type}', { type: req.t(C.ACTIVITY_TYPES[type]) }), type, activity, classes, teachers, nav: type });
}
async function createActivity(req, res) {
  const type = typeOf(req);
  const a = await activityService.create(ctx(req), type, req.body, await classService.restrictedClassIds(req));
  await audit.school(req, `${type}.create`, { entity: 'AcademicActivity', entityId: a._id });
  req.flash('success', 'Session created. Record participation below.');
  res.redirect(`/school/activities/${type}/${a._id}`);
}
async function updateActivity(req, res) {
  const type = typeOf(req);
  const a = await activityService.update(ctx(req), type, req.params.id, req.body, await classService.restrictedClassIds(req));
  await audit.school(req, `${type}.update`, { entity: 'AcademicActivity', entityId: a._id });
  req.flash('success', 'Session updated.');
  res.redirect(`/school/activities/${type}/${a._id}`);
}
async function deleteActivity(req, res) {
  const type = typeOf(req);
  await activityService.remove(ctx(req), type, req.params.id, await classService.restrictedClassIds(req));
  await audit.school(req, `${type}.delete`, { entity: 'AcademicActivity', entityId: req.params.id });
  req.flash('success', 'Session deleted.');
  res.redirect(`/school/activities/${type}`);
}
async function activityDetail(req, res) {
  const type = typeOf(req);
  const data = await activityService.detail(req.tenantId, type, req.params.id);
  res.render('activities/show', { title: data.activity.title, type, ...data, nav: type });
}
async function saveParticipation(req, res) {
  const type = typeOf(req);
  const n = await activityService.saveParticipation(ctx(req), type, req.params.id, req.body.rows, await classService.restrictedClassIds(req));
  req.flash('success', n === 1 ? req.t('Saved 1 participant record.') : req.t('Saved {n} participant records.', { n }));
  res.redirect(`/school/activities/${type}/${req.params.id}`);
}

/* -------------------------------- Attendance ------------------------------ */
const wantsJson = (req) => req.get('accept') === 'application/json';
/** What a register row shows about its saved record: status, who saved it and when. */
const recordInfo = (r) => ({
  status: r.status, by: r.recordedBy ? r.recordedBy.name : '', at: fmtClock(r.updatedAt), day: dates.formatDate(r.updatedAt),
});

async function attendance(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const classes = await classService.all(req.tenantId, restrict);
  const classId = req.query.class || (classes[0] && String(classes[0]._id));
  const sheet = classId ? await attendanceService.studentSheet(req.tenantId, classId, req.query.date, restrict, req.query.shift) : null;
  res.render('attendance/students', { title: 'Student attendance', classes, sheet, date: dates.toISODate(sheet ? sheet.date : new Date()), nav: 'attendance' });
}
async function saveAttendance(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const only = req.body.only || undefined;
  const r = await attendanceService.saveStudentSheet(ctx(req), req.body.class, req.body.date, req.body.att, restrict, req.body.shift, { only });
  if (r.saved) await audit.school(req, 'attendance.students', { entity: 'Class', entityId: r.cls._id, details: { date: dates.toISODate(r.date), shift: r.shift ? r.shift.name : undefined, saved: r.saved, only } });
  let message;
  if (!r.saved && r.unchanged) message = req.t('Nothing changed. The attendance was already saved.');
  else if (r.saved === 1) message = req.t('Attendance saved for 1 student in {cls}.', { cls: r.cls.name });
  else message = req.t('Attendance saved for {n} students in {cls}.', { n: r.saved, cls: r.cls.name });
  if (wantsJson(req)) {
    return res.json({ ok: true, message, rows: Object.fromEntries(r.records.map((x) => [String(x.student), recordInfo(x)])) });
  }
  req.flash('success', message);
  return res.redirect(`/school/attendance?class=${r.cls._id}&date=${dates.toISODate(r.date)}${r.shift ? `&shift=${r.shift._id}` : ''}${only ? `#st-${only}` : ''}`);
}
async function teacherAttendance(req, res) {
  const sheet = await attendanceService.teacherSheet(req.tenantId, req.query.date);
  res.render('attendance/teachers', { title: 'Teacher attendance', sheet, date: dates.toISODate(sheet.date), today: dates.toISODate(dates.clock(config.timeZone).day), nav: res.locals.can('attendance.manage') ? 'attendance' : 'teacher-attendance' });
}
async function saveTeacherAttendance(req, res) {
  const only = req.body.only || undefined;
  const r = await attendanceService.saveTeacherSheet(ctx(req), req.body.date, req.body.att, { only });
  if (r.saved) await audit.school(req, 'attendance.teachers', { details: { date: dates.toISODate(r.date), saved: r.saved, only } });
  const message = r.saved ? req.t('Teacher attendance saved and approved ({n}).', { n: r.saved }) : req.t('Nothing changed. The attendance was already saved.');
  req.flash('success', message);
  res.redirect(`/school/attendance/teachers?date=${dates.toISODate(r.date)}${only ? `#tc-${only}` : ''}`);
}
/** A teacher's own check-in page. */
async function myAttendance(req, res) {
  if (!req.user.teacher) {
    return res.render('attendance/mine', { title: 'My attendance', data: null, nav: 'my-attendance' });
  }
  const data = await attendanceService.myAttendance(req.tenantId, req.user.teacher);
  return res.render('attendance/mine', { title: 'My attendance', data, nav: 'my-attendance' });
}
async function checkInOut(req, res) {
  const action = req.params.action === 'check-out' ? 'out' : 'in';
  const r = await attendanceService.selfCheck(ctx(req), req.user.teacher, action);
  await audit.school(req, action === 'in' ? 'attendance.check_in' : 'attendance.check_out', { entity: 'Teacher', entityId: req.user.teacher, details: { time: r.time } });
  if (action === 'in') {
    req.flash(r.late ? 'warning' : 'success', req.t(r.late ? 'Checked in at {time}, after your registered time. Reception will approve it.' : 'Checked in at {time}. Reception will approve it.', { time: r.time }));
  } else {
    req.flash(r.early ? 'warning' : 'success', req.t(r.early ? 'Checked out at {time}, before your registered time. Reception will approve it.' : 'Checked out at {time}. Reception will approve it.', { time: r.time }));
  }
  res.redirect('/school/my-attendance');
}
async function attendanceReport(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const data = await attendanceService.report(req.tenantId, req.query, restrict);
  const isTeacher = data.scope === 'teacher';
  const titleParts = String(data.title || '').split(' — ');
  const reportTitle = titleParts.length > 1 ? req.t('{report} — {name}', { report: req.t(titleParts[0]), name: titleParts.slice(1).join(' — ') }) : req.t(data.title);
  const report = {
    title: reportTitle, subtitle: data.label,
    summary: [
      { label: req.t('Records'), value: data.totals.total, type: 'number' }, { label: req.t('Present'), value: data.totals.present, type: 'number' },
      { label: req.t('Absent'), value: data.totals.absent, type: 'number' }, { label: req.t('Late'), value: data.totals.late, type: 'number' },
      { label: req.t('Excused'), value: data.totals.excused, type: 'number' }, { label: req.t('Attendance rate'), value: data.totals.rate == null ? '—' : `${data.totals.rate}%`, type: 'text' },
    ],
    sections: [{
      title: isTeacher ? req.t('By teacher') : req.t('By student'),
      columns: [{ key: 'code', label: req.t('ID') }, { key: 'name', label: req.t('Name') }, ...(isTeacher ? [] : [{ key: 'className', label: req.t('Class') }]),
        { key: 'present', label: req.t('Present'), type: 'number' }, { key: 'absent', label: req.t('Absent'), type: 'number' }, { key: 'late', label: req.t('Late'), type: 'number' },
        { key: 'excused', label: req.t('Excused'), type: 'number' }, { key: 'total', label: req.t(isTeacher ? 'Days' : 'Sessions'), type: 'number' }, { key: 'rate', label: req.t('Rate'), type: 'percent' }],
      rows: data.rows,
      totals: { code: req.t('Total'), present: data.totals.present, absent: data.totals.absent, late: data.totals.late, excused: data.totals.excused, total: data.totals.total, rate: data.totals.rate },
    }, {
      title: req.t('By day'),
      columns: [{ key: 'day', label: req.t('Date'), type: 'date' }, { key: 'present', label: req.t('Present'), type: 'number' }, { key: 'absent', label: req.t('Absent'), type: 'number' }, { key: 'late', label: req.t('Late'), type: 'number' }, { key: 'excused', label: req.t('Excused'), type: 'number' }, { key: 'rate', label: req.t('Rate'), type: 'percent' }],
      rows: data.daily,
    }],
    chart: { labels: data.daily.map((d) => d.day.slice(5)), rate: data.daily.map((d) => d.rate) },
  };
  if (await exportService.respond(req, res, report, { org: org(req), currency: req.settings.currency })) return;
  const [classes, teachers, student, shifts] = await Promise.all([
    classService.all(req.tenantId, restrict), teacherService.all(req.tenantId, { activeOnly: false }),
    req.query.student ? Student.findOne({ tenantId: req.tenantId, _id: req.query.student }).select('fullName').lean() : null,
    req.query.class && !isTeacher ? shiftService.forClass(req.tenantId, req.query.class) : [],
  ]);
  res.render('attendance/report', { title: 'Attendance reports', report, query: req.query, classes, teachers, student, shifts, nav: 'attendance-report' });
}

module.exports = {
  lessons, lessonForm, createLesson, updateLesson, deleteLesson, lessonDetail, saveProgress,
  studentLessons, studentLessonForm, giveStudentLesson, listenStudentLesson, deleteStudentLesson, studentLessonReport,
  activities, activityForm, createActivity, updateActivity, deleteActivity, activityDetail, saveParticipation,
  attendance, saveAttendance, teacherAttendance, saveTeacherAttendance, myAttendance, checkInOut, attendanceReport,
};
