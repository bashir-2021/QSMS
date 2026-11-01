'use strict';
/** Lessons & progress, Subac/Duruus activities, attendance. */
const ctx = require('../../utils/ctx');
const C = require('../../config/constants');
const { SURAHS } = require('../../utils/quran');
const dates = require('../../utils/dates');
const lessonService = require('../../services/lessonService');
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
async function attendance(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const classes = await classService.all(req.tenantId, restrict);
  const classId = req.query.class || (classes[0] && String(classes[0]._id));
  const sheet = classId ? await attendanceService.studentSheet(req.tenantId, classId, req.query.date, restrict) : null;
  res.render('attendance/students', { title: 'Student attendance', classes, sheet, date: dates.toISODate(sheet ? sheet.date : new Date()), nav: 'attendance' });
}
async function saveAttendance(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const r = await attendanceService.saveStudentSheet(ctx(req), req.body.class, req.body.date, req.body.att, restrict);
  await audit.school(req, 'attendance.students', { entity: 'Class', entityId: r.cls._id, details: { date: dates.toISODate(r.date), saved: r.saved } });
  req.flash('success', r.saved === 1 ? req.t('Attendance saved for 1 student in {cls}.', { cls: r.cls.name }) : req.t('Attendance saved for {n} students in {cls}.', { n: r.saved, cls: r.cls.name }));
  res.redirect(`/school/attendance?class=${r.cls._id}&date=${dates.toISODate(r.date)}`);
}
async function teacherAttendance(req, res) {
  const sheet = await attendanceService.teacherSheet(req.tenantId, req.query.date);
  res.render('attendance/teachers', { title: 'Teacher attendance', sheet, date: dates.toISODate(sheet.date), nav: 'attendance' });
}
async function saveTeacherAttendance(req, res) {
  const r = await attendanceService.saveTeacherSheet(ctx(req), req.body.date, req.body.att);
  await audit.school(req, 'attendance.teachers', { details: { date: dates.toISODate(r.date), saved: r.saved } });
  req.flash('success', req.t('Teacher attendance saved ({n}).', { n: r.saved }));
  res.redirect(`/school/attendance/teachers?date=${dates.toISODate(r.date)}`);
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
        { key: 'excused', label: req.t('Excused'), type: 'number' }, { key: 'total', label: req.t('Days'), type: 'number' }, { key: 'rate', label: req.t('Rate'), type: 'percent' }],
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
  const [classes, teachers, student] = await Promise.all([
    classService.all(req.tenantId, restrict), teacherService.all(req.tenantId, { activeOnly: false }),
    req.query.student ? Student.findOne({ tenantId: req.tenantId, _id: req.query.student }).select('fullName').lean() : null,
  ]);
  res.render('attendance/report', { title: 'Attendance reports', report, query: req.query, classes, teachers, student, nav: 'attendance-report' });
}

module.exports = {
  lessons, lessonForm, createLesson, updateLesson, deleteLesson, lessonDetail, saveProgress,
  activities, activityForm, createActivity, updateActivity, deleteActivity, activityDetail, saveParticipation,
  attendance, saveAttendance, teacherAttendance, saveTeacherAttendance, attendanceReport,
};
