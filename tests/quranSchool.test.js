'use strict';
const H = require('./helpers');
const tenantContext = require('../utils/tenantContext');

let M;
let s;
let app;
let C;
let students;
let classes;
let shifts;
let attendance;
let lessons;
let activities;
let settings;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
// populate() only runs inside a tenant scope, as it does during a web request
const inSchoolA = (fn) => tenantContext.run(s.a.tenant._id, fn);
const today = () => new Date().toISOString().slice(0, 10);
const student = (cls, extra = {}) => ({ fullName: 'Amina Ali', gender: 'female', program: 'cashra', class: String(cls._id), ...extra });

beforeAll(async () => {
  await H.startDb();
  M = require('../models');
  C = require('../config/constants');
  students = require('../services/studentService');
  classes = require('../services/classService');
  shifts = require('../services/shiftService');
  attendance = require('../services/attendanceService');
  lessons = require('../services/studentLessonService');
  activities = require('../services/activityService');
  settings = require('../services/settingsService');
  app = H.makeApp();
});
afterAll(H.stopDb);
beforeEach(async () => {
  await H.clearDb();
  s = await H.twoSchools();
});

describe('student registration', () => {
  test('a student must be in one of the three categories', async () => {
    await expect(students.create(s.a.ctx, student(s.a.cls, { program: undefined }))).rejects.toMatchObject({ status: 400 });
    await expect(students.create(s.a.ctx, student(s.a.cls, { program: 'hifz' }))).rejects.toMatchObject({ status: 400 });
  });

  test('the form saves mother name, district, category and a photo file', async () => {
    const { agent, csrf } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    const res = await agent.post(`/school/students?_csrf=${csrf}`)
      .field({ fullName: 'Hodan Warsame', gender: 'female', program: 'taxfiid', motherName: 'Faduma Ali', district: 'Hodan', class: String(s.a.cls._id) })
      .attach('photo', PNG, { filename: 'camera-photo.png', contentType: 'image/png' });
    expect(res.status).toBe(302);
    const saved = await M.Student.findOne({ tenantId: s.a.tenant._id, fullName: 'Hodan Warsame' }).lean();
    expect(saved).toMatchObject({ motherName: 'Faduma Ali', district: 'Hodan', program: 'taxfiid' });
    expect(saved.photo).toMatch(/student-/);
  });

  test('the form refuses a student without a category', async () => {
    const { agent, csrf } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    await agent.post(`/school/students?_csrf=${csrf}`).field({ fullName: 'No Category', gender: 'male' });
    expect(await M.Student.countDocuments({ tenantId: s.a.tenant._id, fullName: 'No Category' })).toBe(0);
  });

  test('a record from before categories can still change status and class', async () => {
    await M.Student.collection.updateOne({ _id: s.a.student._id }, { $unset: { program: '' } });
    await expect(students.setStatus(s.a.ctx, s.a.student._id, 'inactive')).resolves.toMatchObject({ status: 'inactive' });
  });
});

describe('class shifts', () => {
  async function threeShifts(key = 'a') {
    const out = [];
    for (const name of ['Morning', 'Evening', 'Night']) out.push((await shifts.create(s[key].ctx, s[key].cls._id, { name })).shift);
    return out;
  }

  test('a new student gets all class shifts by default', async () => {
    const all = await threeShifts();
    const { student: st } = await students.create(s.a.ctx, student(s.a.cls));
    expect(st.shifts.map(String).sort()).toEqual(all.map((x) => String(x._id)).sort());
  });

  test('a student can pick some of the shifts but not none', async () => {
    const [morning, evening] = await threeShifts();
    const { student: st } = await students.create(s.a.ctx, student(s.a.cls, { shifts: [String(morning._id), String(evening._id)], shiftsShown: '1' }));
    expect(st.shifts).toHaveLength(2);
    await expect(students.create(s.a.ctx, student(s.a.cls, { shiftsShown: '1' }))).rejects.toMatchObject({ status: 400 });
  });

  test('a shift of another class or school is refused', async () => {
    await threeShifts();
    const other = await classes.create(s.a.ctx, { name: 'Other', level: 'Mixed', capacity: '10', isActive: 'on' });
    const { shift: otherShift } = await shifts.create(s.a.ctx, other._id, { name: 'Morning' });
    const { shift: foreign } = await shifts.create(s.b.ctx, s.b.cls._id, { name: 'Morning' });
    await expect(students.create(s.a.ctx, student(s.a.cls, { shifts: String(otherShift._id) }))).rejects.toMatchObject({ status: 400 });
    await expect(students.create(s.a.ctx, student(s.a.cls, { shifts: String(foreign._id) }))).rejects.toMatchObject({ status: 400 });
  });

  test('a transfer moves the student onto all shifts of the new class', async () => {
    await threeShifts();
    const { student: st } = await students.create(s.a.ctx, student(s.a.cls));
    const other = await classes.create(s.a.ctx, { name: 'Other', level: 'Mixed', capacity: '10', isActive: 'on' });
    const { shift } = await shifts.create(s.a.ctx, other._id, { name: 'Night' });
    const { student: moved } = await students.transfer(s.a.ctx, st._id, other._id);
    expect(moved.shifts.map(String)).toEqual([String(shift._id)]);
  });

  test('a student who was in the class before it had shifts joins the first shift', async () => {
    const { shift } = await shifts.create(s.a.ctx, s.a.cls._id, { name: 'Morning' });
    const old = await M.Student.findOne({ tenantId: s.a.tenant._id, _id: s.a.student._id }).lean();
    expect(old.shifts.map(String)).toEqual([String(shift._id)]);
  });

  test('closing a student\'s only shift keeps them on a register', async () => {
    const [morning, evening, night] = await threeShifts();
    const { student: st } = await students.create(s.a.ctx, student(s.a.cls, { shifts: String(morning._id) }));
    await shifts.setActive(s.a.ctx, s.a.cls._id, morning._id, false);
    const after = await M.Student.findOne({ tenantId: s.a.tenant._id, _id: st._id }).lean();
    expect(after.shifts.map(String).sort()).toEqual([evening, night].map((x) => String(x._id)).sort());
  });

  test('a shift with attendance cannot be deleted, an unused one can', async () => {
    const [morning, evening] = await threeShifts();
    await attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), { [s.a.student._id]: { status: 'present' } }, null, morning._id);
    await expect(shifts.remove(s.a.ctx, s.a.cls._id, morning._id)).rejects.toMatchObject({ status: 409 });
    await shifts.remove(s.a.ctx, s.a.cls._id, evening._id);
    const after = await M.Student.findOne({ tenantId: s.a.tenant._id, _id: s.a.student._id }).lean();
    expect(after.shifts.map(String)).not.toContain(String(evening._id));
  });

  test('a shift is reached only through its own class', async () => {
    const { shift } = await shifts.create(s.a.ctx, s.a.cls._id, { name: 'Morning' });
    const other = await classes.create(s.a.ctx, { name: 'Other', level: 'Mixed', capacity: '10', isActive: 'on' });
    await expect(shifts.update(s.a.ctx, other._id, shift._id, { name: 'X' })).rejects.toMatchObject({ status: 404 });
    await expect(shifts.setActive(s.b.ctx, s.b.cls._id, shift._id, false)).rejects.toMatchObject({ status: 404 });
  });

  test('duplicate shift names in a class are refused', async () => {
    await shifts.create(s.a.ctx, s.a.cls._id, { name: 'Morning' });
    await expect(shifts.create(s.a.ctx, s.a.cls._id, { name: 'Morning' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('attendance by shift', () => {
  test('one student has a separate record for each shift on the same day', async () => {
    const { shift: morning } = await shifts.create(s.a.ctx, s.a.cls._id, { name: 'Morning' });
    const { shift: night } = await shifts.create(s.a.ctx, s.a.cls._id, { name: 'Night', addStudents: 'on' });
    const id = String(s.a.student._id);
    await attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), { [id]: { status: 'present' } }, null, morning._id);
    await attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), { [id]: { status: 'absent' } }, null, night._id);
    await attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), { [id]: { status: 'late' } }, null, morning._id); // correcting, not adding
    const records = await M.StudentAttendance.find({ tenantId: s.a.tenant._id, student: id }).lean();
    expect(records.map((r) => r.status).sort()).toEqual(['absent', 'late']);
    const sheet = await attendance.studentSheet(s.a.tenant._id, s.a.cls._id, today(), null, night._id);
    expect(sheet.rows[0].record.status).toBe('absent');
  });

  test('a register lists only that shift\'s students', async () => {
    const { shift: morning } = await shifts.create(s.a.ctx, s.a.cls._id, { name: 'Morning' });
    const { shift: night } = await shifts.create(s.a.ctx, s.a.cls._id, { name: 'Night' });
    const { student: nightOnly } = await students.create(s.a.ctx, student(s.a.cls, { shifts: String(night._id) }));
    const sheet = await attendance.studentSheet(s.a.tenant._id, s.a.cls._id, today(), null, morning._id);
    expect(sheet.rows.map((r) => String(r.student._id))).not.toContain(String(nightOnly._id));
    const r = await attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), { [nightOnly._id]: { status: 'present' } }, null, morning._id);
    expect(r.saved).toBe(0);
  });

  test('a class with shifts needs a shift to save, a class without shifts does not', async () => {
    const id = String(s.a.student._id);
    const noShift = await attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), { [id]: { status: 'present' } });
    expect(noShift.saved).toBe(1);
    await shifts.create(s.a.ctx, s.a.cls._id, { name: 'Morning' });
    await expect(attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), { [id]: { status: 'present' } })).rejects.toMatchObject({ status: 400 });
  });

  test('the report can be limited to one shift', async () => {
    const { shift: morning } = await shifts.create(s.a.ctx, s.a.cls._id, { name: 'Morning' });
    const { shift: night } = await shifts.create(s.a.ctx, s.a.cls._id, { name: 'Night', addStudents: 'on' });
    const id = String(s.a.student._id);
    await attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), { [id]: { status: 'present' } }, null, morning._id);
    await attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), { [id]: { status: 'absent' } }, null, night._id);
    const both = await inSchoolA(() => attendance.report(s.a.tenant._id, { class: String(s.a.cls._id), period: 'daily' }));
    const one = await inSchoolA(() => attendance.report(s.a.tenant._id, { class: String(s.a.cls._id), period: 'daily', shift: String(night._id) }));
    expect(both.totals).toMatchObject({ present: 1, absent: 1 });
    expect(one.totals).toMatchObject({ present: 0, absent: 1 });
  });
});

describe('student lessons', () => {
  const portion = (extra = {}) => ({ student: String(s.a.student._id), surah: '67', fromVerse: '1', toVerse: '12', assignedDate: today(), ...extra });

  test('passing grades close the lesson with their score', async () => {
    for (const [grade, score] of [['excellent', 100], ['very_good', 85], ['acceptable', 70]]) {
      const { lesson } = await lessons.assign(s.a.ctx, portion());
      const r = await lessons.review(s.a.ctx, lesson._id, { grade });
      expect(r.passed).toBe(true);
      expect(r.lesson).toMatchObject({ status: 'passed', isOpen: false, grade, score });
    }
  });

  test('not accepted returns the student to the same lesson until they pass', async () => {
    const { lesson } = await lessons.assign(s.a.ctx, portion());
    const first = await lessons.review(s.a.ctx, lesson._id, { grade: 'not_accepted', remarks: 'Mistakes in verse 4' });
    expect(first.passed).toBe(false);
    expect(first.lesson).toMatchObject({ status: 'returned', isOpen: true });
    await expect(lessons.assign(s.a.ctx, portion({ fromVerse: '13', toVerse: '20' }))).rejects.toMatchObject({ status: 409 });
    const second = await lessons.review(s.a.ctx, lesson._id, { grade: 'very_good' });
    expect(second.lesson).toMatchObject({ status: 'passed', score: 85 });
    expect(second.lesson.reviews.map((r) => r.grade)).toEqual(['not_accepted', 'very_good']);
  });

  test('a passed lesson cannot be graded again', async () => {
    const { lesson } = await lessons.assign(s.a.ctx, portion());
    await lessons.review(s.a.ctx, lesson._id, { grade: 'excellent' });
    await expect(lessons.review(s.a.ctx, lesson._id, { grade: 'not_accepted' })).rejects.toMatchObject({ status: 409 });
  });

  test('a lesson needs a valid portion; Taxfiid can use a juz and Farbar a topic', async () => {
    await expect(lessons.assign(s.a.ctx, { student: String(s.a.student._id) })).rejects.toMatchObject({ status: 400 });
    await expect(lessons.assign(s.a.ctx, portion({ toVerse: '31' }))).rejects.toMatchObject({ status: 400 }); // Al-Mulk has 30 verses
    await expect(lessons.assign(s.a.ctx, { student: String(s.a.student._id), juz: '31' })).rejects.toMatchObject({ status: 400 });
    const { lesson } = await lessons.assign(s.a.ctx, { student: String(s.a.student._id), juz: '30' });
    expect(lesson.juz).toBe(30);
    await lessons.remove(s.a.ctx, lesson._id);
    const { lesson: written } = await lessons.assign(s.a.ctx, { student: String(s.a.student._id), topic: 'Alif to Jiim' });
    expect(written.topic).toBe('Alif to Jiim');
  });

  test('the next lesson is suggested from the last one passed', async () => {
    const { lesson } = await lessons.assign(s.a.ctx, portion());
    await lessons.review(s.a.ctx, lesson._id, { grade: 'excellent' });
    const { suggestion } = await inSchoolA(() => lessons.assignForm(s.a.tenant._id, s.a.student._id));
    expect(suggestion).toEqual({ surah: 67, fromVerse: 13 });
  });

  test('the board shows open and last passed lessons', async () => {
    const { lesson } = await lessons.assign(s.a.ctx, portion());
    await lessons.review(s.a.ctx, lesson._id, { grade: 'excellent' });
    await lessons.assign(s.a.ctx, portion({ fromVerse: '13', toVerse: '20' }));
    const page = await inSchoolA(() => lessons.board(s.a.tenant._id, {}));
    expect(page.items[0].openLesson).toMatchObject({ fromVerse: 13 });
    expect(page.items[0].lastPassed).toMatchObject({ grade: 'excellent' });
  });

  test('a teacher only works with their own classes, and schools stay separate', async () => {
    const { lesson } = await lessons.assign(s.a.ctx, portion());
    await expect(lessons.review(s.a.ctx, lesson._id, { grade: 'excellent' }, [])).rejects.toMatchObject({ status: 403 });
    await expect(lessons.review(s.b.ctx, lesson._id, { grade: 'excellent' })).rejects.toMatchObject({ status: 404 });
    await expect(lessons.assign(s.b.ctx, portion())).rejects.toMatchObject({ status: 404 });
  });
});

describe('Subac', () => {
  let cls;
  const session = (extra = {}) => ({ title: 'Subac', date: today(), class: String(cls._id), frequency: 'daily', ...extra });

  beforeEach(async () => {
    cls = await classes.create(s.a.ctx, { name: 'Hifz A', level: 'Hifz', capacity: '20', isActive: 'on' });
  });

  test('the score starts at 100 and loses the points for each error', () => {
    const rates = settings.subacRates({});
    expect(rates).toEqual({ recall_prompt: 0.5, opening_error: 1, pronunciation_error: 0.5, tajweed_error: 0.5, observation_error: 0.5 });
    expect(activities.subacScore(rates, { recall_prompt: 2, opening_error: 1, tajweed_error: 3 })).toEqual({ deducted: 3.5, score: 96.5 });
    expect(activities.subacScore(rates, { opening_error: 1 }, -2.5)).toEqual({ deducted: 1, score: 96.5 });
    expect(activities.subacScore(rates, { opening_error: 1 }, 5).score).toBe(100);
    expect(activities.subacScore(rates, { opening_error: 500 }).score).toBe(0);
  });

  test('a beginner class has no daily Subac but can have a one-time one', async () => {
    await expect(activities.create(s.a.ctx, 'subac', { ...session(), class: String(s.a.cls._id) })).rejects.toMatchObject({ status: 400 });
    const a = await activities.create(s.a.ctx, 'subac', { ...session({ frequency: 'one_time' }), class: String(s.a.cls._id) });
    expect(a.frequency).toBe('one_time');
  });

  test('a class has one daily Subac a day, plus any one-time ones', async () => {
    await activities.create(s.a.ctx, 'subac', session());
    await expect(activities.create(s.a.ctx, 'subac', session())).rejects.toMatchObject({ status: 409 });
    await expect(activities.create(s.a.ctx, 'subac', session({ frequency: 'one_time' }))).resolves.toBeTruthy();
    await expect(activities.create(s.a.ctx, 'subac', session({ frequency: 'one_time' }))).resolves.toBeTruthy();
  });

  test('Farbar students are left out of daily Subac but join a one-time one', async () => {
    const { student: farbar } = await students.create(s.a.ctx, student(cls, { program: 'farbar' }));
    const { student: cashra } = await students.create(s.a.ctx, student(cls, { program: 'cashra' }));
    const daily = await activities.create(s.a.ctx, 'subac', session());
    const roster = (await inSchoolA(() => activities.detail(s.a.tenant._id, 'subac', daily._id))).roster.map((r) => String(r.student._id));
    expect(roster).toEqual([String(cashra._id)]);
    const once = await activities.create(s.a.ctx, 'subac', session({ frequency: 'one_time' }));
    expect((await inSchoolA(() => activities.detail(s.a.tenant._id, 'subac', once._id))).roster.map((r) => String(r.student._id))).toContain(String(farbar._id));
  });

  test('the server works the score out from the counts and manual points', async () => {
    const { student: st } = await students.create(s.a.ctx, student(cls));
    const a = await activities.create(s.a.ctx, 'subac', session());
    await activities.saveParticipation(s.a.ctx, 'subac', a._id, {
      [st._id]: { attendance: 'present', score: '100', deductions: { recall_prompt: '2', opening_error: '1' }, manualPoints: '0.5', remarks: 'Good' },
    });
    const p = await M.ActivityParticipation.findOne({ tenantId: s.a.tenant._id, activity: a._id, student: st._id }).lean();
    expect(p).toMatchObject({ deducted: 2, manualPoints: 0.5, score: 98.5, remarks: 'Good' });
    expect(p.deductions).toMatchObject({ recall_prompt: 2, opening_error: 1, tajweed_error: 0 });
  });

  test('an absent student has no score, even after being scored', async () => {
    const { student: st } = await students.create(s.a.ctx, student(cls));
    const a = await activities.create(s.a.ctx, 'subac', session());
    await activities.saveParticipation(s.a.ctx, 'subac', a._id, { [st._id]: { attendance: 'present', deductions: { opening_error: '3' } } });
    await activities.saveParticipation(s.a.ctx, 'subac', a._id, { [st._id]: { attendance: 'absent', deductions: { opening_error: '3' } } });
    const p = await M.ActivityParticipation.findOne({ tenantId: s.a.tenant._id, activity: a._id, student: st._id }).lean();
    expect(p.score).toBeNull();
    expect(p.deducted).toBe(0);
  });

  test('the manager\'s points apply to new sessions and leave old ones unchanged', async () => {
    const { student: st } = await students.create(s.a.ctx, student(cls));
    const before = await activities.create(s.a.ctx, 'subac', session({ frequency: 'one_time' }));
    await settings.updateSubacDeductions(s.a.tenant._id, { recall_prompt: 2, opening_error: 2, pronunciation_error: 2, tajweed_error: 2, observation_error: 2 });
    const fresh = await M.SchoolSettings.findOne({ tenantId: s.a.tenant._id }).lean();
    const after = await activities.create({ ...s.a.ctx, settings: fresh }, 'subac', session({ frequency: 'one_time' }));
    const rows = { [st._id]: { attendance: 'present', deductions: { recall_prompt: '1' } } };
    await activities.saveParticipation(s.a.ctx, 'subac', before._id, rows);
    await activities.saveParticipation(s.a.ctx, 'subac', after._id, rows);
    const score = async (a) => (await M.ActivityParticipation.findOne({ tenantId: s.a.tenant._id, activity: a._id, student: st._id }).lean()).score;
    expect(await score(before)).toBe(99.5);
    expect(await score(after)).toBe(98);
  });

  test('a Subac session from before deductions keeps its typed score', async () => {
    const { student: st } = await students.create(s.a.ctx, student(cls));
    const a = await activities.create(s.a.ctx, 'subac', session({ frequency: 'one_time' }));
    await M.AcademicActivity.collection.updateOne({ _id: a._id }, { $unset: { frequency: '', deductionRates: '' } });
    await activities.saveParticipation(s.a.ctx, 'subac', a._id, { [st._id]: { attendance: 'present', score: '77', performance: 'good' } });
    const p = await M.ActivityParticipation.findOne({ tenantId: s.a.tenant._id, activity: a._id, student: st._id }).lean();
    expect(p).toMatchObject({ score: 77, performance: 'good' });
    expect((await inSchoolA(() => activities.detail(s.a.tenant._id, 'subac', a._id))).usesDeductions).toBe(false);
  });

  test('Duruus sessions are unaffected', async () => {
    const a = await activities.create(s.a.ctx, 'duruus', { title: 'Dars', date: today(), class: String(s.a.cls._id) });
    expect(a.frequency).toBeUndefined();
    expect((await inSchoolA(() => activities.detail(s.a.tenant._id, 'duruus', a._id))).usesDeductions).toBe(false);
  });
});

describe('pages and permissions', () => {
  test('every new and changed page renders', async () => {
    const { shift } = await shifts.create(s.a.ctx, s.a.cls._id, { name: 'Morning', startTime: '07:00' });
    const sid = String(s.a.student._id);
    const { lesson } = await lessons.assign(s.a.ctx, { student: sid, surah: '1', fromVerse: '1', toVerse: '7' });
    await lessons.review(s.a.ctx, lesson._id, { grade: 'not_accepted' });
    const a = await activities.create(s.a.ctx, 'subac', { title: 'Subac', date: today(), class: String(s.a.cls._id), frequency: 'one_time' });
    await attendance.saveStudentSheet(s.a.ctx, s.a.cls._id, today(), { [sid]: { status: 'present' } }, null, shift._id);
    const { agent } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    const pages = {
      '/school/students': 'Quran category',
      '/school/students/new': 'data-camera',
      [`/school/students/${sid}`]: 'Mother name',
      [`/school/students/${sid}/edit`]: 'data-shift-picker',
      [`/school/classes/${s.a.cls._id}`]: 'Add shift',
      [`/school/attendance?class=${s.a.cls._id}`]: 'name="shift"',
      [`/school/attendance/reports?class=${s.a.cls._id}`]: 'All shifts',
      '/school/student-lessons': 'value="excellent"',
      [`/school/student-lessons/new?student=${sid}`]: 'Give lesson',
      '/school/activities/subac': 'name="frequency"',
      '/school/activities/subac/new': 'name="frequency"',
      [`/school/activities/subac/${a._id}`]: 'data-subac-row',
      [`/school/activities/subac/${a._id}/edit`]: 'name="frequency"',
      '/school/activities/duruus/new': 'name="topic"',
      '/school/settings?tab=subac': 'name="opening_error"',
    };
    for (const [url, marker] of Object.entries(pages)) {
      const res = await agent.get(url);
      expect([url, res.status]).toEqual([url, 200]);
      expect(res.text).toContain(marker);
    }
  });

  test('only a school manager can change deduction points', async () => {
    await M.SchoolUser.create({
      tenantId: s.a.tenant._id, name: 'Teacher', email: 'teacher@a.test', role: 'teacher',
      passwordHash: await require('../services/authService').hashPassword('Pass1234!'),
    });
    const body = { recall_prompt: 3, opening_error: 3, pronunciation_error: 3, tajweed_error: 3, observation_error: 3 };
    const teacher = await H.loginSchool(app, 'teacher@a.test', 'Pass1234!');
    const denied = await teacher.agent.post('/school/settings/subac').type('form').send({ ...body, _csrf: teacher.csrf });
    expect(denied.status).toBe(403);
    const admin = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    await admin.agent.post('/school/settings/subac').type('form').send({ ...body, _csrf: admin.csrf });
    const saved = await M.SchoolSettings.findOne({ tenantId: s.a.tenant._id }).lean();
    expect(saved.subacDeductions).toMatchObject({ recall_prompt: 3, observation_error: 3 });
  });

  test('a shift can be added, then attendance saved for it, through the site', async () => {
    const { agent, csrf } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    await agent.post(`/school/classes/${s.a.cls._id}/shifts`).type('form').send({ _csrf: csrf, name: 'Night', startTime: '19:00', addStudents: 'on' });
    const shift = await M.ClassShift.findOne({ tenantId: s.a.tenant._id, class: s.a.cls._id }).lean();
    expect(shift).toMatchObject({ name: 'Night', startTime: '19:00' });
    const res = await agent.post('/school/attendance').type('form').send({
      _csrf: csrf, class: String(s.a.cls._id), shift: String(shift._id), date: today(), [`att[${s.a.student._id}][status]`]: 'present',
    });
    expect(res.headers.location).toContain(`shift=${shift._id}`);
    expect(await M.StudentAttendance.countDocuments({ tenantId: s.a.tenant._id, shift: shift._id })).toBe(1);
  });

  test('grading through the site goes back to the filtered board, never elsewhere', async () => {
    const { agent, csrf } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    const { lesson } = await lessons.assign(s.a.ctx, { student: String(s.a.student._id), juz: '1' });
    const back = `/school/student-lessons?class=${s.a.cls._id}`;
    const ok = await agent.post(`/school/student-lessons/${lesson._id}/review`).type('form').send({ _csrf: csrf, grade: 'not_accepted', back });
    expect(ok.headers.location).toBe(back);
    const evil = await agent.post(`/school/student-lessons/${lesson._id}/review`).type('form').send({ _csrf: csrf, grade: 'not_accepted', back: 'https://evil.test/' });
    expect(evil.headers.location).toBe('/school/student-lessons');
  });
});

test('categories, grades and deductions match the school\'s rules', () => {
  expect(Object.keys(C.STUDENT_PROGRAMS)).toEqual(['farbar', 'cashra', 'taxfiid']);
  expect(C.STUDENT_LESSON_GRADES.excellent.score).toBe(100);
  expect(C.STUDENT_LESSON_GRADES.not_accepted.passed).toBe(false);
});
