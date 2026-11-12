'use strict';
const H = require('./helpers');

let M;
let s;
let app;
let attendance;
let teachers;
let students;
let parents;
let dates;
let config;

const ALL_DAYS = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const today = () => new Date().toISOString().slice(0, 10);
const hash = (pw) => require('../services/authService').hashPassword(pw);

beforeAll(async () => {
  await H.startDb();
  M = require('../models');
  attendance = require('../services/attendanceService');
  teachers = require('../services/teacherService');
  students = require('../services/studentService');
  parents = require('../services/parentService');
  dates = require('../utils/dates');
  config = require('../config');
  app = H.makeApp();
});
afterAll(H.stopDb);
beforeEach(async () => {
  await H.clearDb();
  s = await H.twoSchools();
});

async function staff(role, email, extra = {}) {
  return M.SchoolUser.create({ tenantId: s.a.tenant._id, name: `${role} user`, email, role, passwordHash: await hash('Pass1234!'), ...extra });
}
const teacherBody = (extra = {}) => ({ fullName: 'Ustaad Ali', phone: '+252 61 700 0001', workDays: ['Sat', 'Sun', 'Mon'], checkInTime: '07:00', checkOutTime: '12:00', ...extra });

describe('school clock', () => {
  test('the local day, time and weekday follow the school time zone', () => {
    const c = dates.clock('Africa/Mogadishu', new Date('2026-01-01T22:30:00Z')); // 01:30 the next morning in Mogadishu
    expect(c).toEqual({ day: new Date('2026-01-02T00:00:00Z'), time: '01:30', weekday: 'Fri' });
    expect(dates.weekdayOf(new Date('2026-01-03T00:00:00Z'))).toBe('Sat');
    expect(dates.minutesOf('07:45')).toBe(465);
  });
});

describe('student register: one row or all at once, and who recorded it', () => {
  test('saving one student leaves the others unsaved', async () => {
    const { student: two } = await students.create(s.a.ctx, { fullName: 'Second', gender: 'male', program: 'cashra', class: String(s.a.cls._id) });
    const entries = { [s.a.student._id]: { status: 'present' }, [two._id]: { status: 'absent' } };
    const r = await attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), entries, null, null, { only: String(two._id) });
    expect(r.saved).toBe(1);
    const rows = await M.StudentAttendance.find({ tenantId: s.a.tenant._id }).lean();
    expect(rows.map((x) => [String(x.student), x.status])).toEqual([[String(two._id), 'absent']]);
  });

  test('saving everyone keeps the original recorder on rows that did not change', async () => {
    const reception = await staff('receptionist', 'rec@a.test');
    const { student: two } = await students.create(s.a.ctx, { fullName: 'Second', gender: 'male', program: 'cashra', class: String(s.a.cls._id) });
    await attendance.saveStudentSheet({ ...s.a.ctx, user: reception }, s.a.cls._id, today(), { [s.a.student._id]: { status: 'present' } });
    const r = await attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), { [s.a.student._id]: { status: 'present' }, [two._id]: { status: 'late' } });
    expect(r).toMatchObject({ saved: 1, unchanged: 1 });
    const sheet = await require('../utils/tenantContext').run(s.a.tenant._id, () => attendance.studentSheet(s.a.tenant._id, s.a.cls._id, today()));
    const by = Object.fromEntries(sheet.rows.map((x) => [x.student.fullName, x.record.recordedBy.name]));
    expect(by).toEqual({ 'Student a': 'receptionist user', Second: 'Admin a' });
    expect(sheet).toMatchObject({ recorded: 2, total: 2 });
  });

  test('a row saved from the page answers in JSON with who saved it', async () => {
    const { agent, csrf } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    const res = await agent.post('/school/attendance').set('Accept', 'application/json').type('form').send({
      _csrf: csrf, class: String(s.a.cls._id), date: today(), only: String(s.a.student._id), [`att[${s.a.student._id}][status]`]: 'late',
    });
    expect(res.status).toBe(200);
    expect(res.body.rows[String(s.a.student._id)]).toMatchObject({ status: 'late', by: 'Admin a', at: expect.stringMatching(/^\d{2}:\d{2}$/) });
    const page = await agent.get(`/school/attendance?class=${s.a.cls._id}`);
    expect(page.text).toContain('Admin a');
    expect(page.text).toContain('data-att-save');
  });
});

describe('student registration: guardian and mother phone', () => {
  test('both phone numbers are required on the form, and the mother phone is saved', async () => {
    const { agent, csrf } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    const base = { fullName: 'Hodan Warsame', gender: 'female', program: 'taxfiid', class: String(s.a.cls._id) };
    await agent.post(`/school/students?_csrf=${csrf}`).field({ ...base, guardianPhone: '0615550101' });
    expect(await M.Student.countDocuments({ tenantId: s.a.tenant._id, fullName: 'Hodan Warsame' })).toBe(0);
    await agent.post(`/school/students?_csrf=${csrf}`).field({ ...base, motherPhone: '0615550102' });
    expect(await M.Student.countDocuments({ tenantId: s.a.tenant._id, fullName: 'Hodan Warsame' })).toBe(0);
    const ok = await agent.post(`/school/students?_csrf=${csrf}`).field({ ...base, guardianPhone: '0615550101', motherPhone: '0615550102' });
    expect(ok.status).toBe(302);
    expect(await M.Student.findOne({ tenantId: s.a.tenant._id, fullName: 'Hodan Warsame' }).lean()).toMatchObject({ guardianPhone: '0615550101', motherPhone: '0615550102' });
  });

  test('the mother can sign in to the parent portal with her own number', async () => {
    const { student } = await students.create(s.a.ctx, { fullName: 'Child', gender: 'male', program: 'cashra', class: String(s.a.cls._id), guardianPhone: '0615550101', motherPhone: '0615550102' });
    const r = await parents.login('+252 61 555 0102', '0615550102');
    expect(r.matches).toHaveLength(1);
    const kids = await require('../utils/tenantContext').run(s.a.tenant._id, () => parents.children(s.a.tenant._id, '615550102'));
    expect(kids.map((k) => String(k._id))).toEqual([String(student._id)]);
    const logins = await parents.loginFor(s.a.tenant._id, student);
    expect(logins.map((l) => [l.who, l.key, Boolean(l.account)])).toEqual([['Guardian', '615550101', false], ['Mother', '615550102', true]]);
    // resetting one number leaves the other alone
    await parents.login('0615550101', '0615550101');
    await parents.resetForStudent(s.a.ctx, student._id, '0615550102');
    expect((await M.ParentAccount.find({ tenantId: s.a.tenant._id }).lean()).map((a) => a.phoneKey)).toEqual(['615550101']);
    await expect(parents.resetForStudent(s.a.ctx, student._id, '0619999999')).rejects.toMatchObject({ status: 404 });
  });
});

describe('teacher working time', () => {
  test('the teacher form needs working days and check-in and check-out times', async () => {
    const { agent, csrf } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    await agent.post(`/school/teachers?_csrf=${csrf}`).field({ fullName: 'No Days', phone: '0617000001', checkInTime: '07:00', checkOutTime: '12:00' });
    await agent.post(`/school/teachers?_csrf=${csrf}`).field({ fullName: 'Backwards', phone: '0617000002', workDays: 'Sat', checkInTime: '12:00', checkOutTime: '07:00' });
    expect(await M.Teacher.countDocuments({ tenantId: s.a.tenant._id })).toBe(0);
    const ok = await agent.post(`/school/teachers?_csrf=${csrf}`).field({ fullName: 'Ustaad Ali', phone: '0617000003', workDays: ['Mon', 'Sat', 'Wed'], checkInTime: '07:00', checkOutTime: '12:30' });
    expect(ok.status).toBe(302);
    const t = await M.Teacher.findOne({ tenantId: s.a.tenant._id }).lean();
    expect(t).toMatchObject({ workDays: ['Sat', 'Mon', 'Wed'], checkInTime: '07:00', checkOutTime: '12:30' });
    const page = await agent.get(`/school/teachers/${t._id}`);
    expect(page.text).toContain('07:00 – 12:30');
  });
});

describe('teacher check-in, check-out and approval by reception', () => {
  async function setup(extra) {
    const t = await teachers.create(s.a.ctx, teacherBody({ workDays: ALL_DAYS, ...extra }));
    const user = await staff('teacher', 'teacher@a.test', { teacher: t._id });
    const reception = await staff('receptionist', 'rec@a.test');
    return { t, tctx: { ...s.a.ctx, user }, rctx: { ...s.a.ctx, user: reception } };
  }

  test('a teacher checks in and out; the times wait for reception and are then approved', async () => {
    const { t, tctx, rctx } = await setup({ checkInTime: '00:00', checkOutTime: '23:59' });
    const now = dates.clock(config.timeZone);
    const checkIn = await attendance.selfCheck(tctx, t._id, 'in');
    expect(checkIn.time).toBe(now.time);
    await expect(attendance.selfCheck(tctx, t._id, 'in')).rejects.toMatchObject({ status: 400 });
    let rec = await M.TeacherAttendance.findOne({ tenantId: s.a.tenant._id, teacher: t._id }).lean();
    expect(rec).toMatchObject({ selfCheckIn: now.time, approval: 'pending', scheduledIn: '00:00', scheduledOut: '23:59', workDay: true });
    if (now.time > '00:00') expect(rec.status).toBe('late');
    await attendance.selfCheck(tctx, t._id, 'out');
    await expect(attendance.selfCheck(tctx, t._id, 'out')).rejects.toMatchObject({ status: 400 });

    // reception approves, correcting the check-in
    await attendance.saveTeacherSheet(rctx, dates.toISODate(now.day), { [t._id]: { status: 'present', checkIn: '00:00', checkOut: rec.selfCheckOut || now.time } });
    rec = await M.TeacherAttendance.findOne({ tenantId: s.a.tenant._id, teacher: t._id }).lean();
    expect(rec).toMatchObject({ status: 'present', checkIn: '00:00', approval: 'approved', approvedBy: rctx.user._id, selfCheckIn: now.time });
  });

  test('checking out before checking in is refused, and a day reception marked absent cannot be checked into', async () => {
    const { t, tctx, rctx } = await setup();
    await expect(attendance.selfCheck(tctx, t._id, 'out')).rejects.toMatchObject({ status: 400 });
    const day = dates.toISODate(dates.clock(config.timeZone).day);
    await attendance.saveTeacherSheet(rctx, day, { [t._id]: { status: 'absent', checkIn: '07:00' } });
    const rec = await M.TeacherAttendance.findOne({ tenantId: s.a.tenant._id, teacher: t._id }).lean();
    expect(rec.checkIn).toBeUndefined(); // no times on an absent day
    await expect(attendance.selfCheck(tctx, t._id, 'in')).rejects.toMatchObject({ status: 400 });
  });

  test('the register shows the registered time, what the teacher pressed and how late', async () => {
    const { t, rctx } = await setup({ workDays: ['Sat'], checkInTime: '07:00', checkOutTime: '12:00' });
    const saturday = '2026-01-03';
    await M.TeacherAttendance.create({ tenantId: s.a.tenant._id, teacher: t._id, date: dates.parseDay(saturday), status: 'late', scheduledIn: '07:00', scheduledOut: '12:00', selfCheckIn: '07:20', selfCheckOut: '11:50', approval: 'pending' });
    const sheet = await require('../utils/tenantContext').run(s.a.tenant._id, () => attendance.teacherSheet(s.a.tenant._id, saturday));
    expect(sheet.pending).toBe(1);
    expect(sheet.rows[0]).toMatchObject({ lateBy: 20, earlyBy: 10, schedule: { scheduledIn: '07:00', scheduledOut: '12:00', workDay: true } });
    // the teacher's own times become the real times unless reception changes them
    await attendance.saveTeacherSheet(rctx, saturday, { [t._id]: { status: 'late', checkIn: '07:20', checkOut: '11:50' } });
    const again = await require('../utils/tenantContext').run(s.a.tenant._id, () => attendance.teacherSheet(s.a.tenant._id, saturday));
    expect(again.pending).toBe(0);
    // a Sunday is not one of this teacher's days
    expect(attendance.scheduleFor({ workDays: ['Sat'], checkInTime: '07:00' }, dates.parseDay('2026-01-04')).workDay).toBe(false);
  });

  test('only reception (and the administrator) can approve; teachers use their own page', async () => {
    const { t } = await setup();
    const teacher = await H.loginSchool(app, 'teacher@a.test', 'Pass1234!');
    const day = dates.toISODate(dates.clock(config.timeZone).day);
    const denied = await teacher.agent.post('/school/attendance/teachers').type('form').send({ _csrf: teacher.csrf, date: day, [`att[${t._id}][status]`]: 'present' });
    expect(denied.status).toBe(403);
    const mine = await teacher.agent.get('/school/my-attendance');
    expect(mine.status).toBe(200);
    expect(mine.text).toContain('/school/my-attendance/check-in');
    expect(mine.text).toContain('07:00');
    await teacher.agent.post('/school/my-attendance/check-in').type('form').send({ _csrf: teacher.csrf });
    expect(await M.TeacherAttendance.countDocuments({ tenantId: s.a.tenant._id, approval: 'pending' })).toBe(1);

    const reception = await H.loginSchool(app, 'rec@a.test', 'Pass1234!');
    const page = await reception.agent.get(`/school/attendance/teachers?date=${day}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Waiting for approval');
    expect(page.text).toContain('07:00 – 12:00');
    const ok = await reception.agent.post('/school/attendance/teachers').type('form').send({ _csrf: reception.csrf, date: day, only: String(t._id), [`att[${t._id}][status]`]: 'present', [`att[${t._id}][checkIn]`]: '07:00' });
    expect(ok.status).toBe(302);
    expect(await M.TeacherAttendance.findOne({ tenantId: s.a.tenant._id, teacher: t._id }).lean()).toMatchObject({ approval: 'approved', checkIn: '07:00' });
    // reception also keeps teacher records
    expect((await reception.agent.get('/school/teachers/new')).status).toBe(200);
    expect((await reception.agent.get('/school/my-attendance')).status).toBe(403);
  });
});
