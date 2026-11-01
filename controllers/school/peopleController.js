'use strict';
/** Dashboard, students, teachers and classes. */
const ctx = require('../../utils/ctx');
const C = require('../../config/constants');
const dashboardService = require('../../services/dashboardService');
const studentService = require('../../services/studentService');
const teacherService = require('../../services/teacherService');
const classService = require('../../services/classService');
const exportService = require('../../services/exportService');
const audit = require('../../services/auditService');
const { Student, Teacher, Class } = require('../../models');
const { owned } = require('../../services/scope');
const { resolveStored } = require('../../middleware/upload');
const { notFound } = require('../../utils/errors');
const money = require('../../utils/money');

const org = (req) => ({ name: req.tenant.name, logo: req.tenant.logo, address: [req.tenant.address, req.tenant.city, req.tenant.country].filter(Boolean).join(', ') });

/* -------------------------------- Dashboard ------------------------------- */
async function dashboard(req, res) {
  const data = await dashboardService.school(req.tenantId);
  res.render('school/dashboard', { title: 'Dashboard', data, nav: 'dashboard' });
}

/* -------------------------------- Students -------------------------------- */
async function students(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  if (req.query.format) {
    const rows = await studentService.exportRows(req.tenantId, req.query, restrict);
    const report = exportService.listReport('Students', [
      { key: 'studentCode', label: 'Student ID' }, { key: 'fullName', label: 'Name' }, { key: 'gender', label: 'Gender', type: 'status' },
      { key: 'dateOfBirth', label: 'Date of birth', type: 'date' }, { key: 'class', label: 'Class' }, { key: 'teacher', label: 'Teacher' },
      { key: 'guardianName', label: 'Guardian' }, { key: 'guardianPhone', label: 'Guardian phone' }, { key: 'registrationDate', label: 'Registered', type: 'date' }, { key: 'status', label: 'Status', type: 'status' },
    ], rows.map((s) => ({ ...s, class: s.class ? s.class.name : '', teacher: s.teacher ? s.teacher.fullName : '' })));
    if (await exportService.respond(req, res, report, { org: org(req), currency: req.settings.currency })) return;
  }
  const [page, classes] = await Promise.all([studentService.list(req.tenantId, req.query, restrict), classService.all(req.tenantId, restrict)]);
  res.render('students/index', { title: 'Students', page, classes, query: req.query, nav: 'students' });
}

async function studentForm(req, res) {
  const [student, classes, teachers] = await Promise.all([
    req.params.id ? owned(Student, req.tenantId, req.params.id, 'Student') : null,
    classService.all(req.tenantId), teacherService.all(req.tenantId),
  ]);
  res.render('students/form', { title: student ? `Edit ${student.fullName}` : 'Register student', student, classes, teachers, nav: 'students' });
}

async function createStudent(req, res) {
  const s = await studentService.create(ctx(req), req.body, req.file);
  await audit.school(req, 'student.create', { entity: 'Student', entityId: s._id, details: { code: s.studentCode } });
  req.flash('success', `${s.fullName} registered as ${s.studentCode}.`);
  res.redirect(`/school/students/${s._id}`);
}

async function updateStudent(req, res) {
  const s = await studentService.update(ctx(req), req.params.id, req.body, req.file);
  await audit.school(req, 'student.update', { entity: 'Student', entityId: s._id });
  req.flash('success', 'Student updated.');
  res.redirect(`/school/students/${s._id}`);
}

async function studentProfile(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const data = await studentService.profile(req.tenantId, req.params.id);
  if (restrict && !(data.student.class && restrict.map(String).includes(String(data.student.class._id)))) throw notFound('Student');
  const classes = await classService.all(req.tenantId);
  res.render('students/show', { title: data.student.fullName, ...data, classes, nav: 'students', print: req.query.print === '1' });
}

async function transferStudent(req, res) {
  const { student, cls } = await studentService.transfer(ctx(req), req.params.id, req.body.class, req.body.reason);
  await audit.school(req, 'student.transfer', { entity: 'Student', entityId: student._id, details: { to: cls.name, reason: req.body.reason } });
  req.flash('success', `${student.fullName} moved to ${cls.name}.`);
  res.redirect(`/school/students/${student._id}`);
}

async function setStudentStatus(req, res) {
  const s = await studentService.setStatus(ctx(req), req.params.id, req.body.status);
  await audit.school(req, 'student.status', { entity: 'Student', entityId: s._id, details: { status: s.status } });
  req.flash('success', `Status changed to ${s.status}.`);
  res.redirect(`/school/students/${s._id}`);
}

async function studentSearch(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  const items = await studentService.search(req.tenantId, String(req.query.q || '').slice(0, 60), restrict);
  res.json(items.map((s) => ({ id: s._id, name: s.fullName, code: s.studentCode, className: s.class ? s.class.name : '', status: s.status })));
}

/* -------------------------------- Teachers -------------------------------- */
async function teachers(req, res) {
  if (req.query.format) {
    const rows = await Teacher.find({ tenantId: req.tenantId }).sort({ fullName: 1 }).lean();
    const report = exportService.listReport('Teachers', [
      { key: 'teacherCode', label: 'Teacher ID' }, { key: 'fullName', label: 'Name' }, { key: 'phone', label: 'Phone' },
      { key: 'qualification', label: 'Qualification' }, { key: 'specialization', label: 'Specialization' },
      { key: 'employmentDate', label: 'Employed', type: 'date' }, { key: 'monthlySalary', label: 'Salary', type: 'money' }, { key: 'status', label: 'Status', type: 'status' },
    ], rows);
    if (await exportService.respond(req, res, report, { org: org(req), currency: req.settings.currency })) return;
  }
  res.render('teachers/index', { title: 'Teachers', page: await teacherService.list(req.tenantId, req.query), query: req.query, nav: 'teachers' });
}
async function teacherForm(req, res) {
  const teacher = req.params.id ? await owned(Teacher, req.tenantId, req.params.id, 'Teacher') : null;
  res.render('teachers/form', { title: teacher ? `Edit ${teacher.fullName}` : 'Add teacher', teacher, nav: 'teachers' });
}
async function createTeacher(req, res) {
  const t = await teacherService.create(ctx(req), req.body, req.file);
  await audit.school(req, 'teacher.create', { entity: 'Teacher', entityId: t._id });
  req.flash('success', `${t.fullName} added as ${t.teacherCode}.`);
  res.redirect(`/school/teachers/${t._id}`);
}
async function updateTeacher(req, res) {
  const t = await teacherService.update(ctx(req), req.params.id, req.body, req.file);
  await audit.school(req, 'teacher.update', { entity: 'Teacher', entityId: t._id });
  req.flash('success', 'Teacher updated.');
  res.redirect(`/school/teachers/${t._id}`);
}
async function teacherProfile(req, res) {
  res.render('teachers/show', { title: 'Teacher', ...(await teacherService.profile(req.tenantId, req.params.id)), nav: 'teachers' });
}

/* --------------------------------- Classes -------------------------------- */
async function classes(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  res.render('classes/index', { title: 'Classes', page: await classService.list(req.tenantId, req.query, restrict), query: req.query, nav: 'classes' });
}
async function classForm(req, res) {
  const [cls, teachers] = await Promise.all([
    req.params.id ? owned(Class, req.tenantId, req.params.id, 'Class') : null, teacherService.all(req.tenantId),
  ]);
  res.render('classes/form', { title: cls ? `Edit ${cls.name}` : 'New class', cls, teachers, nav: 'classes' });
}
async function createClass(req, res) {
  const c = await classService.create(ctx(req), req.body);
  await audit.school(req, 'class.create', { entity: 'Class', entityId: c._id });
  req.flash('success', `Class ${c.name} created.`);
  res.redirect(`/school/classes/${c._id}`);
}
async function updateClass(req, res) {
  const c = await classService.update(ctx(req), req.params.id, req.body);
  await audit.school(req, 'class.update', { entity: 'Class', entityId: c._id });
  req.flash('success', 'Class updated.');
  res.redirect(`/school/classes/${c._id}`);
}
async function classDetail(req, res) {
  const restrict = await classService.restrictedClassIds(req);
  if (restrict && !restrict.map(String).includes(String(req.params.id))) throw notFound('Class');
  const data = await classService.detail(req.tenantId, req.params.id);
  const candidates = await Student.find({ tenantId: req.tenantId, status: 'active', class: { $ne: data.cls._id } })
    .select('fullName studentCode class').populate('class', 'name').sort({ fullName: 1 }).limit(300).lean();
  res.render('classes/show', { title: data.cls.name, ...data, candidates, fee: data.cls.monthlyFee != null ? data.cls.monthlyFee : req.settings.monthlyFee, nav: 'classes' });
}
async function enrol(req, res) {
  const { cls, moved } = await classService.enrol(ctx(req), req.params.id, req.body.students, studentService);
  await audit.school(req, 'class.enrol', { entity: 'Class', entityId: cls._id, details: { students: moved } });
  req.flash('success', `${moved} student(s) enrolled in ${cls.name}.`);
  res.redirect(`/school/classes/${cls._id}`);
}

/* ------------------------------ Private files ----------------------------- */
/** Serve an uploaded file only if it belongs to the signed-in school. */
async function file(req, res) {
  const rel = `${req.tenantId}/${req.params.name}`;
  if (!/^[\w.-]+$/.test(req.params.name)) throw notFound('File');
  const full = resolveStored(rel);
  if (!full) throw notFound('File');
  res.set('Cache-Control', 'private, max-age=3600');
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(full);
}

module.exports = {
  dashboard, students, studentForm, createStudent, updateStudent, studentProfile, transferStudent, setStudentStatus, studentSearch,
  teachers, teacherForm, createTeacher, updateTeacher, teacherProfile,
  classes, classForm, createClass, updateClass, classDetail, enrol, file, C, money,
};
