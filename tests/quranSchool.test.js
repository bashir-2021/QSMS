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
      .field({ fullName: 'Hodan Warsame', gender: 'female', program: 'taxfiid', motherName: 'Faduma Ali', guardianPhone: '0615550101', motherPhone: '0615550102', district: 'Hodan', class: String(s.a.cls._id) })
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
    const other = await classes.create(s.a.ctx, { name: 'Other', level: 'cashra', capacity: '10', isActive: 'on' });
    const { shift: otherShift } = await shifts.create(s.a.ctx, other._id, { name: 'Morning' });
    const { shift: foreign } = await shifts.create(s.b.ctx, s.b.cls._id, { name: 'Morning' });
    await expect(students.create(s.a.ctx, student(s.a.cls, { shifts: String(otherShift._id) }))).rejects.toMatchObject({ status: 400 });
    await expect(students.create(s.a.ctx, student(s.a.cls, { shifts: String(foreign._id) }))).rejects.toMatchObject({ status: 400 });
  });

  test('a transfer moves the student onto all shifts of the new class', async () => {
    await threeShifts();
    const { student: st } = await students.create(s.a.ctx, student(s.a.cls));
    const other = await classes.create(s.a.ctx, { name: 'Other', level: 'cashra', capacity: '10', isActive: 'on' });
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
    const other = await classes.create(s.a.ctx, { name: 'Other', level: 'cashra', capacity: '10', isActive: 'on' });
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

describe('Madinah Mushaf measurements', () => {
  const quran = require('../utils/quran');
  const m = (a, b, c, d) => quran.measure({ surah: a, ayah: b }, { surah: c, ayah: d });

  test('surahs carry their Arabic names', () => {
    const bare = (s) => s.replace(/[ً-ْٓ-ٰٕ]/g, ''); // without vowel marks
    expect(bare(quran.getSurah(1).arabic)).toBe('الفاتحة');
    expect(bare(quran.getSurah(67).arabic)).toBe('الملك');
    expect(bare(quran.getSurah(114).arabic)).toBe('الناس');
    expect(quran.SURAHS.every((s) => s.arabic)).toBe(true);
  });

  test('ayahs, pages and juz follow the 604-page Mushaf', () => {
    expect(m(1, 1, 1, 7)).toMatchObject({ ayahs: 7, startPage: 1, endPage: 1, pages: 1, startJuz: 1, endJuz: 1 });
    expect(m(1, 1, 114, 6)).toMatchObject({ ayahs: 6236, startPage: 1, endPage: 604, pages: 604, juz: 30 });
    expect(m(78, 1, 114, 6)).toMatchObject({ ayahs: 564, startPage: 582, endPage: 604, pages: 23, juz: 1 });
    expect(m(67, 27, 68, 15)).toMatchObject({ ayahs: 19, startJuz: 29, endJuz: 29 }); // across two surahs
    expect(m(2, 142, 2, 202)).toMatchObject({ startPage: 22, endPage: 31, pages: 10, juz: 0.5 });
    expect(m(2, 5, 2, 3)).toBeNull();
    expect(m(1, 1, 1, 8)).toBeNull();
  });

  test('juz start pages match the Madinah index', () => {
    const index = [1, 22, 42, 62, 82, 102, 121, 142, 162, 182, 201, 222, 242, 262, 282, 302, 322, 342, 362, 382, 402, 422, 442, 462, 482, 502, 522, 542, 562, 582];
    expect(index.map((p, i) => { const r = quran.juzRange(i + 1); return quran.pageOf(quran.ayahId(r.start.surah, r.start.ayah)); })).toEqual(index);
    expect(quran.juzRange(30)).toEqual({ start: { surah: 78, ayah: 1 }, end: { surah: 114, ayah: 6 } });
  });
});

describe('student lessons', () => {
  const sid = () => String(s.a.student._id);
  // giving a lesson: the portion only
  const lessonFor = (extra = {}) => ({
    student: sid(), date: today(), lessonType: 'New lesson', startSurah: '67', startAyah: '1', endSurah: '67', endAyah: '12', ...extra,
  });
  // listening to it later
  const heard = (extra = {}) => ({ date: today(), attendance: 'present', status: 'heard', warnings: '0', ...extra });
  const giveAndListen = async (ctx, give, listen) => {
    const { lesson } = await lessons.give(ctx, give);
    return lessons.listen(ctx, lesson._id, heard(listen));
  };
  const rules = () => settings.lessonRules(null);

  test('the chain: warnings lower the score, set the level and return the lesson at the limit', () => {
    // the school's example: 3 warnings allowed, 5 points each
    const at = (warnings) => lessons.evaluate({ attendance: 'present', status: 'heard', warnings }, rules());
    expect(at(0)).toMatchObject({ status: 'heard', score: 100, level: 'Very Good', result: 'passed' });
    expect(at(1)).toMatchObject({ status: 'heard', score: 95, result: 'passed' });
    expect(at(2)).toMatchObject({ status: 'heard', score: 90, level: 'Very Good', result: 'passed' });
    expect(at(3)).toMatchObject({ status: 'returned', score: 85, level: 'Needs revision', result: 'repeat', autoReturned: true });
    expect(at(3).returnReason).toBe('Reached the warning limit (3/3)');
    const custom = { ...rules(), maxWarnings: 10, pointsPerWarning: 4 };
    expect(lessons.evaluate({ attendance: 'present', status: 'heard', warnings: 3 }, custom)).toMatchObject({ score: 88, level: 'Good', result: 'passed' });
    expect(lessons.evaluate({ attendance: 'present', status: 'heard', warnings: 6 }, custom)).toMatchObject({ score: 76, level: 'Average' });
    expect(lessons.evaluate({ attendance: 'present', status: 'heard', warnings: 9 }, custom)).toMatchObject({ score: 64, level: 'Weak' });
    expect(lessons.evaluate({ attendance: 'present', status: 'heard', warnings: 2 }, { ...custom, returnBelowScore: 95 })).toMatchObject({ status: 'returned', score: 92 });
  });

  test('absent keeps only the absence; listening needs listened to or returned', () => {
    expect(lessons.evaluate({ attendance: 'absent', status: 'heard', warnings: 2 }, rules())).toEqual({ attendance: 'absent', rules: expect.any(Object) });
    expect(() => lessons.evaluate({ attendance: 'present', status: 'pending' }, rules())).toThrow(/listened/);
    expect(() => lessons.evaluate({ attendance: 'present' }, rules())).toThrow(/listened/);
  });

  test('a teacher\'s own return needs a reason and gives no score', () => {
    expect(() => lessons.evaluate({ attendance: 'present', status: 'returned' }, rules())).toThrow(/reason/);
    const r = lessons.evaluate({ attendance: 'present', status: 'returned', returnReason: 'Weak on the second page' }, rules());
    expect(r).toMatchObject({ status: 'returned', result: 'repeat', level: 'Needs revision', returnReason: 'Weak on the second page' });
    expect(r.score).toBeUndefined();
  });

  test('a given lesson waits with no score; it is scored only when listened to', async () => {
    const { lesson } = await lessons.give(s.a.ctx, lessonFor({ attendance: 'present', status: 'heard', warnings: '1' }));
    expect(lesson).toMatchObject({
      status: 'pending', result: 'pending', isOpen: true, lessonType: 'New lesson',
      start: { surah: 67, ayah: 1 }, end: { surah: 67, ayah: 12 }, ayahs: 12, startPage: 562, endPage: 562, pages: 1, startJuz: 29,
    });
    expect(lesson.attempts).toHaveLength(0);
    expect(lesson.score).toBeUndefined();
    const { lesson: done } = await lessons.listen(s.a.ctx, lesson._id, heard({ warnings: '1' }));
    expect(done).toMatchObject({ status: 'heard', result: 'passed', isOpen: false, score: 95, level: 'Very Good' });
    expect(done.attempts).toHaveLength(1);
    expect(done.attempts[0]).toMatchObject({ attempt: 1, attendance: 'present', warnings: 1, score: 95, rules: { maxWarnings: 3, pointsPerWarning: 5 } });
  });

  test('several lessons can be given before any is listened to, then listened to in any order', async () => {
    const one = (await lessons.give(s.a.ctx, lessonFor())).lesson;
    const two = (await lessons.give(s.a.ctx, lessonFor({ startAyah: '13', endAyah: '26' }))).lesson;
    const three = (await lessons.give(s.a.ctx, lessonFor({ startAyah: '27', endAyah: '30' }))).lesson;
    let page = await inSchoolA(() => lessons.board(s.a.tenant._id, {}));
    expect(page.items[0].openLessons.map((l) => String(l._id))).toEqual([one, two, three].map((l) => String(l._id)));
    await lessons.listen(s.a.ctx, two._id, heard());
    page = await inSchoolA(() => lessons.board(s.a.tenant._id, {}));
    expect(page.items[0].openLessons.map((l) => String(l._id))).toEqual([one, three].map((l) => String(l._id)));
    expect(page.items[0].lastLesson).toMatchObject({ end: { surah: 67, ayah: 30 } });
  });

  test('an absent student at listening keeps only the absence; the lesson stays waiting', async () => {
    const { lesson } = await lessons.give(s.a.ctx, lessonFor());
    const { lesson: after } = await lessons.listen(s.a.ctx, lesson._id, { date: today(), attendance: 'absent', status: 'heard', warnings: '2' });
    expect(after).toMatchObject({ status: 'pending', result: 'pending', attendance: 'absent', isOpen: true });
    expect(after.score).toBeUndefined();
    expect(after.attempts[0]).toMatchObject({ attendance: 'absent' });
    expect(after.attempts[0].score).toBeUndefined();
    expect(after.attempts[0].status).toBeUndefined();
  });

  test('a returned lesson is listened to again as a new attempt; earlier attempts are kept', async () => {
    const { lesson } = await giveAndListen(s.a.ctx, lessonFor(), { warnings: '3' });
    expect(lesson).toMatchObject({ status: 'returned', result: 'repeat', isOpen: true, score: 85 });
    await lessons.listen(s.a.ctx, lesson._id, { date: today(), attendance: 'absent' });
    const again = await lessons.listen(s.a.ctx, lesson._id, heard());
    expect(again.lesson).toMatchObject({ status: 'heard', result: 'passed', isOpen: false, score: 100 });
    expect(again.lesson.attempts.map((a) => [a.attempt, a.attendance, a.status || null, a.score === undefined ? null : a.score]))
      .toEqual([[1, 'present', 'returned', 85], [2, 'absent', null, null], [2, 'present', 'heard', 100]]);
    await expect(lessons.listen(s.a.ctx, lesson._id, heard())).rejects.toMatchObject({ status: 409 });
    await expect(lessons.remove(s.a.ctx, lesson._id)).rejects.toMatchObject({ status: 409 });
  });

  test('a lesson never listened to can be removed; one with any sitting cannot', async () => {
    const { lesson } = await lessons.give(s.a.ctx, lessonFor());
    const { lesson: other } = await lessons.give(s.a.ctx, lessonFor({ startAyah: '13', endAyah: '20' }));
    await lessons.listen(s.a.ctx, other._id, { date: today(), attendance: 'absent' });
    await lessons.remove(s.a.ctx, lesson._id);
    await expect(lessons.remove(s.a.ctx, other._id)).rejects.toMatchObject({ status: 409 });
    expect(await M.StudentLesson.countDocuments({ tenantId: s.a.tenant._id })).toBe(1);
  });

  test('a lesson cannot be listened to before the day it was given', async () => {
    const { lesson } = await lessons.give(s.a.ctx, lessonFor());
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    await expect(lessons.listen(s.a.ctx, lesson._id, heard({ date: yesterday }))).rejects.toMatchObject({ status: 400 });
  });

  test('the form suggests the next portion: the ayah after the last lesson to the end of its page', async () => {
    await lessons.give(s.a.ctx, lessonFor());
    const { suggestion, lastLesson } = await inSchoolA(() => lessons.formData(s.a.tenant._id, { studentId: s.a.student._id }));
    expect(lastLesson).toMatchObject({ end: { surah: 67, ayah: 12 } });
    expect(suggestion).toEqual({ start: { surah: 67, ayah: 13 }, end: { surah: 67, ayah: 26 } }); // page 563
  });

  test('a lesson needs a valid portion and type; Taxfiid can pick a juz and Farbar a topic', async () => {
    const none = { startSurah: '', startAyah: '', endSurah: '', endAyah: '' };
    await expect(lessons.give(s.a.ctx, lessonFor(none))).rejects.toMatchObject({ status: 400 });
    await expect(lessons.give(s.a.ctx, lessonFor({ endAyah: '31' }))).rejects.toMatchObject({ status: 400 }); // Al-Mulk has 30 ayahs
    await expect(lessons.give(s.a.ctx, lessonFor({ startAyah: '10', endAyah: '5' }))).rejects.toMatchObject({ status: 400 });
    await expect(lessons.give(s.a.ctx, lessonFor({ lessonType: 'Something else' }))).rejects.toMatchObject({ status: 400 });
    const juz = await lessons.give(s.a.ctx, lessonFor({ ...none, juz: '30' }));
    expect(juz.lesson).toMatchObject({ start: { surah: 78, ayah: 1 }, end: { surah: 114, ayah: 6 }, pages: 23, juz: 1 });
    await expect(lessons.give(s.a.ctx, lessonFor({ ...none, topic: 'Alif to Jiim' }))).rejects.toMatchObject({ status: 400 });
    const { student: farbar } = await students.create(s.a.ctx, student(s.a.cls, { program: 'farbar' }));
    const written = await lessons.give(s.a.ctx, lessonFor({ ...none, student: String(farbar._id), topic: 'Alif to Jiim' }));
    expect(written.lesson.topic).toBe('Alif to Jiim');
  });

  test('each school sets its own rules; new rules never change earlier results', async () => {
    const before = await giveAndListen(s.a.ctx, lessonFor(), { warnings: '2' });
    expect(before.lesson.score).toBe(90);
    await settings.updateLessonRules(s.a.tenant._id, {
      maxWarnings: '6', pointsPerWarning: '2.5', returnBelowScore: '0', lessonTypes: 'Sabaq\nSabqi\nManzil',
      levels: { 0: { label: 'Mumtaz', min: '95' }, 1: { label: 'Jayyid', min: '75' }, 2: { label: 'Muraja', min: '0' }, 3: { label: '', min: '' } },
    });
    const after = await giveAndListen(s.a.ctx, lessonFor({ lessonType: 'Sabaq', startAyah: '13', endAyah: '20' }), { warnings: '3' });
    expect(after.lesson).toMatchObject({ status: 'heard', score: 92.5, level: 'Jayyid', result: 'passed' });
    expect(after.lesson.attempts[0].rules).toMatchObject({ maxWarnings: 6, pointsPerWarning: 2.5 });
    const kept = await M.StudentLesson.findOne({ tenantId: s.a.tenant._id, _id: before.lesson._id }).lean();
    expect(kept).toMatchObject({ score: 90, level: 'Very Good' });
    expect(kept.attempts[0].rules).toMatchObject({ maxWarnings: 3, pointsPerWarning: 5 });
    // the other school still uses the defaults
    const other = await giveAndListen(s.b.ctx, { ...lessonFor(), student: String(s.b.student._id) }, { warnings: '3' });
    expect(other.lesson).toMatchObject({ status: 'returned', score: 85 });
    await expect(lessons.give(s.b.ctx, { ...lessonFor(), student: String(s.b.student._id), lessonType: 'Sabaq' })).rejects.toMatchObject({ status: 400 });
  });

  test('lesson rules are checked before they are saved', async () => {
    const ok = { maxWarnings: '3', pointsPerWarning: '5', lessonTypes: 'New lesson', levels: [{ label: 'Good', min: '50' }, { label: 'Needs revision', min: '0' }] };
    await expect(settings.updateLessonRules(s.a.tenant._id, { ...ok, levels: [{ label: 'Only', min: '0' }] })).rejects.toMatchObject({ status: 400 });
    await expect(settings.updateLessonRules(s.a.tenant._id, { ...ok, levels: [{ label: 'A', min: '50' }, { label: 'B', min: '10' }] })).rejects.toMatchObject({ status: 400 });
    await expect(settings.updateLessonRules(s.a.tenant._id, { ...ok, levels: [{ label: 'A', min: '50' }, { label: 'B', min: '50' }, { label: 'C', min: '0' }] })).rejects.toMatchObject({ status: 400 });
    await expect(settings.updateLessonRules(s.a.tenant._id, { ...ok, maxWarnings: '0' })).rejects.toMatchObject({ status: 400 });
    await expect(settings.updateLessonRules(s.a.tenant._id, { ...ok, lessonTypes: '  ' })).rejects.toMatchObject({ status: 400 });
    await expect(settings.updateLessonRules(s.a.tenant._id, ok)).resolves.toBeTruthy();
  });

  test('the report counts lessons given, sittings, attendance, waiting and returned lessons and progress', async () => {
    await giveAndListen(s.a.ctx, lessonFor(), { warnings: '1' }); // passed, 12 ayahs, 1 page
    const returned = await giveAndListen(s.a.ctx, lessonFor({ startAyah: '13', endAyah: '26' }), { warnings: '3' });
    await lessons.give(s.a.ctx, lessonFor({ startAyah: '27', endAyah: '30' })); // waiting
    const { student: other } = await students.create(s.a.ctx, student(s.a.cls, { fullName: 'Bilal Omar' }));
    const otherLesson = (await lessons.give(s.a.ctx, lessonFor({ student: String(other._id) }))).lesson;
    await lessons.listen(s.a.ctx, otherLesson._id, { date: today(), attendance: 'absent' });
    const r = await inSchoolA(() => lessons.report(s.a.tenant._id, {}));
    expect(r.totals).toMatchObject({ given: 4, sittings: 3, present: 2, absent: 1, passed: 1, returned: 1, waiting: 2, openReturned: 1, ayahs: 12, pages: 1, warnings: 4 });
    expect(r.totals.avgScore).toBe(90); // (95 + 85) / 2
    expect(r.returned[0]).toMatchObject({ lessonId: String(returned.lesson._id), reason: 'Reached the warning limit (3/3)' });
    expect(r.sittings.find((x) => x.status === 'heard').portionArabic).toBe('المُلك 1–12');
    expect(r.byStudent.find((p) => p.studentId === sid())).toMatchObject({ given: 3, sittings: 2, passed: 1, returned: 1, level: 'Needs revision' });
    expect(r.byStudent.find((p) => p.studentId === String(other._id))).toMatchObject({ given: 1, sittings: 1, absent: 1 });
    expect((await inSchoolA(() => lessons.report(s.a.tenant._id, { status: 'absent' }))).sittings).toHaveLength(1);
    const otherSchool = await tenantContext.run(s.b.tenant._id, () => lessons.report(s.b.tenant._id, {}));
    expect(otherSchool.totals.sittings).toBe(0);
  });

  test('a teacher only works with their own classes, and schools stay separate', async () => {
    const { lesson } = await lessons.give(s.a.ctx, lessonFor());
    await expect(lessons.listen(s.a.ctx, lesson._id, heard(), [])).rejects.toMatchObject({ status: 403 });
    await expect(lessons.give(s.a.ctx, lessonFor(), [])).rejects.toMatchObject({ status: 403 });
    await expect(lessons.listen(s.b.ctx, lesson._id, heard())).rejects.toMatchObject({ status: 404 });
    await expect(lessons.give(s.b.ctx, lessonFor())).rejects.toMatchObject({ status: 404 });
  });
});

describe('classes', () => {
  async function twoTeachers() {
    const teacherService = require('../services/teacherService');
    const one = await teacherService.create(s.a.ctx, { fullName: 'Ustaad Ali', status: 'active' });
    const two = await teacherService.create(s.a.ctx, { fullName: 'Macallimad Hodan', status: 'active' });
    return [one, two];
  }

  test('a class can have several teachers, and each of them can work with it', async () => {
    const [one, two] = await twoTeachers();
    const cls = await classes.create(s.a.ctx, { name: 'Hifz B', level: 'taxfiid', capacity: '20', isActive: 'on', mainTeacher: String(one._id), teachers: [String(two._id)] });
    expect(cls.teachers.map(String)).toEqual([String(one._id), String(two._id)]);
    for (const tch of [one, two]) {
      const ids = await classes.restrictedClassIds({ tenantId: s.a.tenant._id, user: { role: 'teacher', teacher: tch._id } });
      expect(ids.map(String)).toEqual([String(cls._id)]);
    }
    // a new student gets the main teacher
    const { student: st } = await students.create(s.a.ctx, student(cls, { program: 'taxfiid' }));
    expect(String(st.teacher)).toBe(String(one._id));
    // the second teacher can listen to that student's lesson
    const restrict = await classes.restrictedClassIds({ tenantId: s.a.tenant._id, user: { role: 'teacher', teacher: two._id } });
    const given = await lessons.give(s.a.ctx, { student: String(st._id), date: today(), lessonType: 'New lesson', juz: '30' }, restrict);
    const ctxTwo = { ...s.a.ctx, user: { ...s.a.ctx.user, teacher: two._id } };
    const { lesson } = await lessons.listen(ctxTwo, given.lesson._id, { date: today(), attendance: 'present', status: 'heard' }, restrict);
    expect(String(lesson.attempts[0].teacher)).toBe(String(two._id));
  });

  test('a teacher from another school cannot be added to a class', async () => {
    const other = await require('../services/teacherService').create(s.b.ctx, { fullName: 'Elsewhere', status: 'active' });
    await expect(classes.create(s.a.ctx, { name: 'X', level: 'cashra', capacity: '10', isActive: 'on', teachers: [String(other._id)] })).rejects.toMatchObject({ status: 404 });
  });

  test('class levels are the three Quran categories', async () => {
    expect(C.CLASS_LEVELS).toEqual(Object.keys(C.STUDENT_PROGRAMS));
    const cls = await classes.create(s.a.ctx, { name: 'Odd', level: 'Hifz', capacity: '10', isActive: 'on' });
    expect(cls.level).toBe('cashra'); // an unknown level falls back to Cashra
  });

  test('old classes move to a teachers list and a Quran category level', async () => {
    const [one] = await twoTeachers();
    const raw = M.Class.collection;
    const { insertedId } = await raw.insertOne({ tenantId: s.a.tenant._id, name: 'Legacy', level: 'Beginner', teacher: one._id, capacity: 10, isActive: true });
    const { insertedId: empty } = await raw.insertOne({ tenantId: s.a.tenant._id, name: 'Legacy 2', level: 'Hifz', capacity: 10, isActive: true });
    await M.Student.collection.insertOne({ tenantId: s.a.tenant._id, fullName: 'Old', studentCode: 'OLD-1', gender: 'male', program: 'taxfiid', class: insertedId, status: 'active' });
    const migrations = require('../services/migrationService');
    await migrations.run({ log: false });
    const moved = await raw.findOne({ _id: insertedId });
    expect(moved).toMatchObject({ teachers: [one._id], level: 'taxfiid' }); // from its students
    expect(moved.teacher).toBeUndefined();
    expect(await raw.findOne({ _id: empty })).toMatchObject({ teachers: [], level: 'taxfiid' }); // no students: from the old level
    await expect(migrations.run({ log: false })).resolves.toEqual({ teachers: 0, levels: 0 });
  });
});

describe('parent portal', () => {
  const parents = () => require('../services/parentService');
  const PHONE = '+252 61 555 0199';
  async function family() {
    const { student: one } = await students.create(s.a.ctx, student(s.a.cls, { fullName: 'Child One', guardianPhone: PHONE }));
    const { student: two } = await students.create(s.a.ctx, student(s.a.cls, { fullName: 'Child Two', guardianPhone: '0615550199' }));
    const { student: stranger } = await students.create(s.a.ctx, student(s.a.cls, { fullName: 'Not Mine', guardianPhone: '+252 61 999 1234' }));
    return { one, two, stranger };
  }
  async function signIn(phone, password) {
    const agent = require('supertest').agent(app);
    const page = await agent.get('/parent/login');
    const res = await agent.post('/parent/login').type('form').send({ _csrf: H.csrfFrom(page.text), phone, password });
    return { agent, res };
  }

  test('phone numbers match however they are written', () => {
    const { phoneKey } = require('../utils/phone');
    expect(['+252 61 555 0199', '252615550199', '0615550199', '61-555-0199'].map(phoneKey)).toEqual(Array(4).fill('615550199'));
    expect(phoneKey('12')).toBeNull();
  });

  test('the first sign-in uses the phone number as password, then a new password must be chosen', async () => {
    await family();
    expect((await signIn('615550199', 'wrong')).res.headers.location).toBe('/parent/login');
    const { agent, res } = await signIn('061 555 0199', '+252615550199');
    expect(res.headers.location).toBe('/parent/password');
    expect((await agent.get('/parent')).headers.location).toBe('/parent/password'); // nothing else opens yet
    const form = await agent.get('/parent/password');
    const csrf = H.csrfFrom(form.text);
    await agent.post('/parent/password').type('form').send({ _csrf: csrf, newPassword: '0615550199x', confirmPassword: '0615550199x' });
    let account = await M.ParentAccount.findOne({ tenantId: s.a.tenant._id }).lean();
    expect(account.mustChangePassword).toBe(true); // the phone number is not allowed as the new password
    await agent.post('/parent/password').type('form').send({ _csrf: csrf, newPassword: 'Hooyo2026', confirmPassword: 'Hooyo2026' });
    account = await M.ParentAccount.findOne({ tenantId: s.a.tenant._id }).lean();
    expect(account).toMatchObject({ phoneKey: '615550199', mustChangePassword: false });
    expect((await signIn('615550199', '615550199')).res.headers.location).toBe('/parent/login'); // the old password stops working
    expect((await signIn('615550199', 'Hooyo2026')).res.headers.location).toBe('/parent');
  });

  test('a parent sees only their own children, and nothing of the school', async () => {
    const { one, two, stranger } = await family();
    await M.ParentAccount.create({ tenantId: s.a.tenant._id, phoneKey: '615550199', passwordHash: await require('../services/authService').hashPassword('Hooyo2026'), mustChangePassword: false });
    const { agent } = await signIn('615550199', 'Hooyo2026');
    const home = await agent.get('/parent');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Child One');
    expect(home.text).toContain('Child Two');
    expect(home.text).not.toContain('Not Mine');
    await lessons.give(s.a.ctx, { student: String(one._id), date: today(), lessonType: 'New lesson', juz: '30' });
    const page = await agent.get(`/parent/children/${one._id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('النَّبَإ'.slice(0, 1)); // the lesson's Arabic surah name is shown
    expect((await agent.get(`/parent/children/${two._id}`)).status).toBe(200);
    expect((await agent.get(`/parent/children/${stranger._id}`)).status).toBe(404);
    expect((await agent.get(`/parent/children/${s.b.student._id}`)).status).toBe(404);
    expect((await agent.get('/school/dashboard')).headers.location).toMatch(/^\/login/);
  });

  test('the same phone at two schools signs in to the right one', async () => {
    await family();
    await students.create(s.b.ctx, { ...student(s.b.cls, { fullName: 'Child Elsewhere' }), guardianPhone: PHONE });
    const { agent, res } = await signIn(PHONE, PHONE);
    expect(res.headers.location).toBe('/parent/choose');
    const choose = await agent.get('/parent/choose');
    const ids = [...choose.text.matchAll(/name="accountId" value="([a-f0-9]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    const accountB = await M.ParentAccount.findOne({ tenantId: s.b.tenant._id }).lean();
    await agent.post('/parent/choose').type('form').send({ _csrf: H.csrfFrom(choose.text), accountId: String(accountB._id) });
    await agent.get('/parent/password').then((p) => agent.post('/parent/password').type('form').send({ _csrf: H.csrfFrom(p.text), newPassword: 'Hooyo2026', confirmPassword: 'Hooyo2026' }));
    const home = await agent.get('/parent');
    expect(home.text).toContain('Child Elsewhere');
    expect(home.text).not.toContain('Child One');
  });

  test('school staff can reset a parent password back to the phone number', async () => {
    const { one } = await family();
    await M.ParentAccount.create({ tenantId: s.a.tenant._id, phoneKey: '615550199', passwordHash: 'x', mustChangePassword: false });
    const { agent, csrf } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    expect((await agent.get(`/school/students/${one._id}`)).text).toContain('Reset parent password');
    await agent.post(`/school/students/${one._id}/parent-reset`).type('form').send({ _csrf: csrf });
    expect(await M.ParentAccount.countDocuments({ tenantId: s.a.tenant._id })).toBe(0);
    expect((await signIn('615550199', '615550199')).res.headers.location).toBe('/parent/password');
    expect(await inSchoolA(() => parents().children(s.a.tenant._id, '615550199'))).toHaveLength(2);
  });
});

describe('Subac', () => {
  let cls;
  const session = (extra = {}) => ({ title: 'Subac', date: today(), class: String(cls._id), frequency: 'daily', ...extra });

  beforeEach(async () => {
    cls = await classes.create(s.a.ctx, { name: 'Hifz A', level: 'taxfiid', capacity: '20', isActive: 'on' });
  });

  test('the score starts at 100 and loses the points for each error', () => {
    const rates = settings.subacRates({});
    expect(rates).toEqual({ recall_prompt: 0.5, opening_error: 1, pronunciation_error: 0.5, tajweed_error: 0.5, observation_error: 0.5 });
    expect(activities.subacScore(rates, { recall_prompt: 2, opening_error: 1, tajweed_error: 3 })).toEqual({ deducted: 3.5, score: 96.5 });
    expect(activities.subacScore(rates, { opening_error: 1 }, -2.5)).toEqual({ deducted: 1, score: 96.5 });
    expect(activities.subacScore(rates, { opening_error: 1 }, 5).score).toBe(100);
    expect(activities.subacScore(rates, { opening_error: 500 }).score).toBe(0);
  });

  test('a Farbar class has no daily Subac but can have a one-time one', async () => {
    const farbarClass = await classes.create(s.a.ctx, { name: 'Farbar A', level: 'farbar', capacity: '20', isActive: 'on' });
    await expect(activities.create(s.a.ctx, 'subac', { ...session(), class: String(farbarClass._id) })).rejects.toMatchObject({ status: 400 });
    const a = await activities.create(s.a.ctx, 'subac', { ...session({ frequency: 'one_time' }), class: String(farbarClass._id) });
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
    const lessonBody = { student: sid, date: today(), lessonType: 'New lesson', startSurah: '1', startAyah: '1', endSurah: '1', endAyah: '7' };
    const { lesson } = await lessons.give(s.a.ctx, lessonBody);
    await lessons.listen(s.a.ctx, lesson._id, { date: today(), attendance: 'present', status: 'heard', warnings: '3' }); // returned, still open
    const done = (await lessons.give(s.a.ctx, lessonBody)).lesson;
    await lessons.listen(s.a.ctx, done._id, { date: today(), attendance: 'present', status: 'heard', warnings: '0' });
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
      '/school/student-lessons': `/school/student-lessons/${lesson._id}/listen`,
      [`/school/student-lessons/new?student=${sid}`]: 'name="startSurah"',
      [`/school/student-lessons/${lesson._id}/listen`]: 'Earlier sittings of this lesson',
      '/school/student-lessons/report': 'Returned lessons',
      [`/school/student-lessons/report?student=${sid}&from=2020-01-01`]: 'Progress by student',
      '/school/settings?tab=lessons': 'name="levels[0][label]"',
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

  test('giving and listening through the site goes back to the filtered board, never elsewhere', async () => {
    const { agent, csrf } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    const back = `/school/student-lessons?class=${s.a.cls._id}`;
    const ok = await agent.post('/school/student-lessons').type('form').send({
      _csrf: csrf, back, student: String(s.a.student._id), date: today(), lessonType: 'New lesson', juz: '30',
    });
    expect(ok.headers.location).toBe(back);
    const lesson = await M.StudentLesson.findOne({ tenantId: s.a.tenant._id }).lean();
    expect(lesson).toMatchObject({ status: 'pending', pages: 23, start: { surah: 78, ayah: 1 }, attempts: [] });
    const listened = await agent.post(`/school/student-lessons/${lesson._id}/listen`).type('form').send({ _csrf: csrf, back, date: today(), attendance: 'present', status: 'heard', warnings: '3' });
    expect(listened.headers.location).toBe(back);
    expect(await M.StudentLesson.findOne({ tenantId: s.a.tenant._id, _id: lesson._id }).lean()).toMatchObject({ status: 'returned', score: 85 });
    const evil = await agent.post(`/school/student-lessons/${lesson._id}/listen`).type('form').send({ _csrf: csrf, date: today(), attendance: 'present', status: 'heard', warnings: '1', back: 'https://evil.test/' });
    expect(evil.headers.location).toBe('/school/student-lessons');
    expect(await M.StudentLesson.findOne({ tenantId: s.a.tenant._id, _id: lesson._id }).lean()).toMatchObject({ status: 'heard', result: 'passed', score: 95 });
  });

  test('a lesson that cannot be saved goes back to the form with what was typed', async () => {
    const { agent, csrf } = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    const form = `/school/student-lessons/new?student=${s.a.student._id}`;
    const res = await agent.post('/school/student-lessons').set('Referer', form).type('form').send({
      _csrf: csrf, student: String(s.a.student._id), date: today(), lessonType: 'New lesson',
      startSurah: '67', startAyah: '20', endSurah: '67', endAyah: '5',
    });
    expect(res.headers.location).toBe(form);
    const page = await agent.get(form);
    expect(page.text).toContain('value="20"');
    expect(page.text).toContain('value="67" data-verses="30" selected');
    expect(await M.StudentLesson.countDocuments({ tenantId: s.a.tenant._id })).toBe(0);
  });

  test('only a school manager changes lesson rules; reports export to PDF and Excel', async () => {
    await M.SchoolUser.create({
      tenantId: s.a.tenant._id, name: 'Teacher', email: 'teacher@a.test', role: 'teacher',
      passwordHash: await require('../services/authService').hashPassword('Pass1234!'),
    });
    const body = { maxWarnings: '5', pointsPerWarning: '4', returnBelowScore: '0', lessonTypes: 'Sabaq\nManzil', 'levels[0][label]': 'Top', 'levels[0][min]': '80', 'levels[1][label]': 'Low', 'levels[1][min]': '0' };
    const teacher = await H.loginSchool(app, 'teacher@a.test', 'Pass1234!');
    expect((await teacher.agent.post('/school/settings/lessons').type('form').send({ ...body, _csrf: teacher.csrf })).status).toBe(403);
    const admin = await H.loginSchool(app, 'admin@a.test', 'Pass1234!');
    await admin.agent.post('/school/settings/lessons').type('form').send({ ...body, _csrf: admin.csrf });
    const saved = await M.SchoolSettings.findOne({ tenantId: s.a.tenant._id }).lean();
    expect(saved).toMatchObject({ lessonRules: { maxWarnings: 5, pointsPerWarning: 4 }, lessonTypes: ['Sabaq', 'Manzil'], hifzLevels: [{ label: 'Top', min: 80 }, { label: 'Low', min: 0 }] });
    const given = await lessons.give(s.a.ctx, { student: String(s.a.student._id), date: today(), lessonType: 'Sabaq', startSurah: '1', startAyah: '1', endSurah: '1', endAyah: '7' });
    await lessons.listen(s.a.ctx, given.lesson._id, { date: today(), attendance: 'present', status: 'heard', warnings: '2' });
    const pdf = await admin.agent.get('/school/student-lessons/report?format=pdf').buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
    const xlsx = await admin.agent.get('/school/student-lessons/report?format=xlsx').buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    const cells = [];
    wb.worksheets[0].eachRow((row) => row.eachCell((c) => cells.push(String(c.value))));
    expect(cells).toContain('الفَاتِحة 1–7');
    expect(cells).toContain('Top');
  });
});

test('categories and default lesson rules match the school\'s rules', () => {
  expect(Object.keys(C.STUDENT_PROGRAMS)).toEqual(['farbar', 'cashra', 'taxfiid']);
  expect(C.DEFAULT_LESSON_RULES).toEqual({ maxWarnings: 3, pointsPerWarning: 5, returnBelowScore: 0 });
  expect(C.DEFAULT_HIFZ_LEVELS.map((l) => l.min)).toEqual([90, 80, 70, 60, 0]);
});
