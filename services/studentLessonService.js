'use strict';
const { Student, StudentLesson } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const { getSurah } = require('../utils/quran');
const { paginate } = require('../utils/paginate');
const { badRequest, conflict, forbidden } = require('../utils/errors');
const { owned } = require('./scope');
const studentService = require('./studentService');

/**
 * Each student's own lessons. A student is given a portion, memorises it and recites it to the
 * teacher, who grades it. A passing grade closes the lesson; "Not accepted" returns the student
 * to the same lesson until they pass it.
 */

function assertStudentAllowed(student, restrict) {
  if (restrict && !(student.class && restrict.map(String).includes(String(student.class)))) {
    throw forbidden('You can only manage your own classes.');
  }
}

/** One page of active students, each with their open lesson and the last lesson they passed. */
async function board(tenantId, q = {}, restrict) {
  const page = await paginate(Student, studentService.buildFilter(tenantId, { ...q, status: 'active' }, restrict), {
    page: q.page, limit: q.limit || 20, sort: { fullName: 1 }, populate: { path: 'class', select: 'name' },
  });
  const ids = page.items.map((s) => s._id);
  const [open, passed] = await Promise.all([
    StudentLesson.find({ tenantId, student: { $in: ids }, isOpen: true }).lean(),
    StudentLesson.aggregate([
      { $match: { tenantId, student: { $in: ids }, status: 'passed' } },
      { $sort: { passedAt: -1 } },
      { $group: { _id: '$student', lesson: { $first: '$$ROOT' } } },
    ]),
  ]);
  const openBy = Object.fromEntries(open.map((l) => [String(l.student), l]));
  const passedBy = Object.fromEntries(passed.map((p) => [String(p._id), p.lesson]));
  page.items.forEach((s) => {
    s.openLesson = openBy[String(s._id)] || null;
    s.lastPassed = passedBy[String(s._id)] || null;
  });
  return page;
}

/** The portion after the last passed lesson, to pre-fill the next assignment. */
async function suggestNext(tenantId, studentId) {
  const last = await StudentLesson.findOne({ tenantId, student: studentId, status: 'passed' }).sort({ passedAt: -1 }).lean();
  if (!last) return {};
  if (last.juz) return { juz: last.juz < 30 ? last.juz + 1 : undefined };
  const surah = getSurah(last.surah);
  if (!surah || last.toVerse >= surah.verses) return {};
  return { surah: surah.number, fromVerse: last.toVerse + 1 };
}

async function assignForm(tenantId, studentId, restrict) {
  const student = await owned(Student, tenantId, studentId, 'Student', { populate: { path: 'class', select: 'name' } });
  assertStudentAllowed({ class: student.class && student.class._id }, restrict);
  return { student, suggestion: await suggestNext(tenantId, student._id) };
}

function readPortion(data) {
  const portion = { surah: undefined, fromVerse: undefined, toVerse: undefined, juz: undefined, topic: String(data.topic || '').trim() || undefined };
  if (data.surah) {
    const s = getSurah(data.surah);
    if (!s) throw badRequest('Choose a valid surah.');
    const from = parseInt(data.fromVerse, 10) || 1;
    const to = parseInt(data.toVerse, 10) || from;
    if (from < 1 || to < from || to > s.verses) throw badRequest('{surah} has {verses} verses — check the verse range.', null, { surah: s.name, verses: s.verses });
    Object.assign(portion, { surah: s.number, fromVerse: from, toVerse: to });
  }
  if (data.juz) {
    const juz = parseInt(data.juz, 10);
    if (!(juz >= 1 && juz <= 30)) throw badRequest('Juz must be between 1 and 30');
    portion.juz = juz;
  }
  if (!portion.surah && !portion.juz && !portion.topic) throw badRequest('Enter a surah and verses, a juz or a topic for the lesson.');
  return portion;
}

async function assign(ctx, data, restrict) {
  const student = await owned(Student, ctx.tenantId, data.student, 'Student');
  assertStudentAllowed(student, restrict);
  if (student.status !== 'active') throw badRequest('Lessons can only be given to active students.');
  const portion = readPortion(data);
  try {
    const lesson = await StudentLesson.create({
      ...portion, tenantId: ctx.tenantId, student: student._id, class: student.class, program: student.program,
      assignedDate: dates.parseDay(data.assignedDate) || dates.startOfDay(), assignedBy: ctx.user._id,
    });
    return { lesson, student };
  } catch (err) {
    if (err.code === 11000) throw conflict('{name} already has an open lesson. Grade it before giving a new one.', { name: student.fullName });
    throw err;
  }
}

async function lessonWithStudent(tenantId, id, restrict) {
  const lesson = await owned(StudentLesson, tenantId, id, 'Lesson');
  const student = await owned(Student, tenantId, lesson.student, 'Student');
  assertStudentAllowed(student, restrict);
  return { lesson, student };
}

/** Record the teacher's grade. The filter on isOpen means a lesson can only be passed once. */
async function review(ctx, id, data, restrict) {
  const { lesson, student } = await lessonWithStudent(ctx.tenantId, id, restrict);
  const grade = C.STUDENT_LESSON_GRADES[data.grade];
  if (!grade) throw badRequest('Choose a valid grade.');
  const entry = { grade: data.grade, score: grade.score, remarks: String(data.remarks || '').slice(0, 500), reviewedBy: ctx.user._id, reviewedAt: new Date() };
  const outcome = grade.passed
    ? { status: 'passed', isOpen: false, grade: data.grade, score: grade.score, passedAt: entry.reviewedAt }
    : { status: 'returned' };
  const updated = await StudentLesson.findOneAndUpdate(
    { tenantId: ctx.tenantId, _id: lesson._id, isOpen: true },
    { $set: outcome, $push: { reviews: entry } },
    { new: true },
  ).lean();
  if (!updated) throw conflict('This lesson has already been passed.');
  return { lesson: updated, student, passed: grade.passed };
}

/** Remove a lesson entered by mistake, including one that was graded wrongly. */
async function remove(ctx, id, restrict) {
  const { lesson, student } = await lessonWithStudent(ctx.tenantId, id, restrict);
  await StudentLesson.deleteOne({ tenantId: ctx.tenantId, _id: lesson._id });
  return { lesson, student };
}

module.exports = { board, assignForm, assign, review, remove };
