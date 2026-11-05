'use strict';
/** Dashboard, students, teachers and classes. */
const ctx = require('../../utils/ctx');
const C = require('../../config/constants');
const dashboardService = require('../../services/dashboardService');
const studentService = require('../../services/studentService');
const teacherService = require('../../services/teacherService');
const classService = require('../../services/classService');
const shiftService = require('../../services/shiftService');
const exportService = require('../../services/exportService');
const audit = require('../../services/auditService');
const paymentService = require('../../services/paymentService');
const subscriptionService = require('../../services/subscriptionService');
const { schoolCan } = require('../../config/roles');
const { Student, Teacher, Class } = require('../../models');
const { owned } = require('../../services/scope');
const { resolveStored } = require('../../middleware/upload');
const { notFound, badRequest, forbidden } = require('../../utils/errors');
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
    const report = exportService.listReport(req.t('Students'), [
      { key: 'studentCode', label: req.t('Student ID') }, { key: 'fullName', label: req.t('Name') }, { key: 'gender', label: req.t('Gender'), type: 'status' },
      { key: 'dateOfBirth', label: req.t('Date of birth'), type: 'date' }, { key: 'program', label: req.t('Quran category'), type: 'status' }, { key: 'class', label: req.t('Class') }, { key: 'teacher', label: req.t('Teacher') },
      { key: 'guardianName', label: req.t('Guardian') }, { key: 'guardianPhone', label: req.t('Guardian phone') }, { key: 'motherName', label: req.t('Mother name') }, { key: 'district', label: req.t('District') },
      { key: 'registrationDate', label: req.t('Registered'), type: 'date' }, { key: 'status', label: req.t('Status'), type: 'status' },
    ], rows.map((s) => ({ ...s, class: s.class ? s.class.name : '', teacher: s.teacher ? s.teacher.fullName : '' })));
    if (await exportService.respond(req, res, report, { org: org(req), currency: req.settings.currency })) return;
  }
  const [page, classes] = await Promise.all([studentService.list(req.tenantId, req.query, restrict), classService.all(req.tenantId, restrict)]);
  res.render('students/index', { title: 'Students', page, classes, query: req.query, nav: 'students' });
}

async function studentForm(req, res) {
  const [student, classes, teachers, classShifts] = await Promise.all([
    req.params.id ? owned(Student, req.tenantId, req.params.id, 'Student') : null,
    classService.all(req.tenantId), teacherService.all(req.tenantId), shiftService.activeByClass(req.tenantId),
  ]);
  res.render('students/form', { title: student ? req.t('Edit {name}', { name: student.fullName }) : 'Register student', student, classes, teachers, classShifts, nav: 'students' });
}

/**
 * One-time registration fee options from the registration form. The amount can be changed
 * (e.g. reduced) only by staff who manage invoices; others charge the school fee.
 */
function registrationFeeOptions(req) {
  const can = (perm) => schoolCan(req.user.role, perm);
  const b = req.body;
  if (!b.chargeRegistration || !subscriptionService.hasFeature(req.subscription, 'finance')) return { amount: 0 };
  if (!can('invoices.manage') && !can('payments.create')) throw forbidden();
  let amount = req.settings.registrationFee || 0;
  if (can('invoices.manage') && b.registrationFee !== undefined && String(b.registrationFee).trim() !== '') {
    amount = money.toMinor(b.registrationFee);
    if (amount === null || amount <= 0) throw badRequest('Enter a registration fee greater than zero.');
  }
  if (amount <= 0) throw badRequest('Registration fee is not configured in School Settings.');
  const collect = Boolean(b.collectRegistration) && can('payments.create');
  if (collect && !(req.settings.paymentMethods || []).includes(b.paymentMethod)) throw badRequest('Choose a payment method configured in School Settings.');
  return { amount, collect, method: b.paymentMethod, transactionRef: b.transactionRef };
}

async function createStudent(req, res) {
  const fee = registrationFeeOptions(req);
  const { student: s, registrationInvoice: inv } = await studentService.create(ctx(req), req.body, req.file, { registrationFee: fee.amount });
  await audit.school(req, 'student.create', { entity: 'Student', entityId: s._id, details: { code: s.studentCode } });
  if (inv) await audit.school(req, 'invoice.create', { entity: 'StudentInvoice', entityId: inv._id, details: { invoiceNo: inv.invoiceNo, type: 'registration' } });
  req.flash('success', req.t('{name} registered as {code}.', { name: s.fullName, code: s.studentCode }));

  if (inv && fee.collect) {
    try {
      const { receipt } = await paymentService.record(ctx(req), req, {
        student: String(s._id), invoices: [String(inv._id)], amount: money.toDecimalString(inv.total),
        method: fee.method, transactionRef: fee.transactionRef, notes: 'Registration fee paid at registration',
      });
      req.flash('success', req.t('Registration fee of {amount} received. Receipt {receipt} issued.', { amount: money.format(inv.total, req.settings.currency), receipt: receipt.receiptNo }));
    } catch (err) {
      // the student and the invoice are saved; the fee can still be collected from Payments
      req.flash('warning', req.t('The registration fee invoice {invoice} was created, but the payment was not recorded: {error}', { invoice: inv.invoiceNo, error: req.t(err.expose ? err.message : 'Something went wrong. The error has been logged.') }));
    }
  } else if (inv) {
    req.flash('info', req.t('Registration fee invoice {invoice} created ({amount}).', { invoice: inv.invoiceNo, amount: money.format(inv.total, req.settings.currency) }));
  }
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
  req.flash('success', req.t('{name} moved to {class}.', { name: student.fullName, class: cls.name }));
  res.redirect(`/school/students/${student._id}`);
}

async function setStudentStatus(req, res) {
  const s = await studentService.setStatus(ctx(req), req.params.id, req.body.status);
  await audit.school(req, 'student.status', { entity: 'Student', entityId: s._id, details: { status: s.status } });
  req.flash('success', req.t('Status changed to {status}.', { status: req.t(s.status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())) }));
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
    const report = exportService.listReport(req.t('Teachers'), [
      { key: 'teacherCode', label: req.t('Teacher ID') }, { key: 'fullName', label: req.t('Name') }, { key: 'phone', label: req.t('Phone') },
      { key: 'qualification', label: req.t('Qualification') }, { key: 'specialization', label: req.t('Specialization') },
      { key: 'employmentDate', label: req.t('Employed'), type: 'date' }, { key: 'monthlySalary', label: req.t('Salary'), type: 'money' }, { key: 'status', label: req.t('Status'), type: 'status' },
    ], rows);
    if (await exportService.respond(req, res, report, { org: org(req), currency: req.settings.currency })) return;
  }
  res.render('teachers/index', { title: 'Teachers', page: await teacherService.list(req.tenantId, req.query), query: req.query, nav: 'teachers' });
}
async function teacherForm(req, res) {
  const teacher = req.params.id ? await owned(Teacher, req.tenantId, req.params.id, 'Teacher') : null;
  res.render('teachers/form', { title: teacher ? req.t('Edit {name}', { name: teacher.fullName }) : 'Add teacher', teacher, nav: 'teachers' });
}
async function createTeacher(req, res) {
  const t = await teacherService.create(ctx(req), req.body, req.file);
  await audit.school(req, 'teacher.create', { entity: 'Teacher', entityId: t._id });
  req.flash('success', req.t('{name} added as {code}.', { name: t.fullName, code: t.teacherCode }));
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
  res.render('classes/form', { title: cls ? req.t('Edit {name}', { name: cls.name }) : 'New class', cls, teachers, nav: 'classes' });
}
async function createClass(req, res) {
  const c = await classService.create(ctx(req), req.body);
  await audit.school(req, 'class.create', { entity: 'Class', entityId: c._id });
  req.flash('success', req.t('Class {name} created.', { name: c.name }));
  req.flash('info', 'Add the shifts this class runs, such as Morning, Evening or Night.');
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
  const [candidates, shifts] = await Promise.all([
    Student.find({ tenantId: req.tenantId, status: 'active', class: { $ne: data.cls._id } })
      .select('fullName studentCode class').populate('class', 'name').sort({ fullName: 1 }).limit(300).lean(),
    shiftService.withStudentCounts(req.tenantId, data.cls._id),
  ]);
  res.render('classes/show', { title: data.cls.name, ...data, candidates, shifts, fee: data.cls.monthlyFee != null ? data.cls.monthlyFee : req.settings.monthlyFee, nav: 'classes' });
}
async function enrol(req, res) {
  const { cls, moved } = await classService.enrol(ctx(req), req.params.id, req.body.students, studentService);
  await audit.school(req, 'class.enrol', { entity: 'Class', entityId: cls._id, details: { students: moved } });
  req.flash('success', moved === 1 ? req.t('1 student enrolled in {class}.', { class: cls.name }) : req.t('{n} students enrolled in {class}.', { n: moved, class: cls.name }));
  res.redirect(`/school/classes/${cls._id}`);
}

/* ------------------------------- Class shifts ----------------------------- */
async function createShift(req, res) {
  const { cls, shift } = await shiftService.create(ctx(req), req.params.id, req.body);
  await audit.school(req, 'shift.create', { entity: 'Class', entityId: cls._id, details: { shift: shift.name } });
  req.flash('success', req.t('Shift {name} added.', { name: shift.name }));
  res.redirect(`/school/classes/${cls._id}`);
}
async function updateShift(req, res) {
  const shift = await shiftService.update(ctx(req), req.params.id, req.params.shiftId, req.body);
  await audit.school(req, 'shift.update', { entity: 'Class', entityId: shift.class, details: { shift: shift.name } });
  req.flash('success', 'Shift updated.');
  res.redirect(`/school/classes/${shift.class}`);
}
async function setShiftStatus(req, res) {
  const shift = await shiftService.setActive(ctx(req), req.params.id, req.params.shiftId, req.body.isActive === 'on');
  await audit.school(req, 'shift.status', { entity: 'Class', entityId: shift.class, details: { shift: shift.name, isActive: shift.isActive } });
  req.flash('success', shift.isActive ? 'Shift activated.' : 'Shift deactivated.');
  res.redirect(`/school/classes/${shift.class}`);
}
async function deleteShift(req, res) {
  const shift = await shiftService.remove(ctx(req), req.params.id, req.params.shiftId);
  await audit.school(req, 'shift.delete', { entity: 'Class', entityId: shift.class, details: { shift: shift.name } });
  req.flash('success', 'Shift deleted.');
  res.redirect(`/school/classes/${shift.class}`);
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
  classes, classForm, createClass, updateClass, classDetail, enrol, createShift, updateShift, setShiftStatus, deleteShift, file, C, money,
};
