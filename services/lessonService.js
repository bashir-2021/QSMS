'use strict';
const { Lesson, LessonProgress, Class, Student, Teacher } = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const { getSurah } = require('../utils/quran');
const { paginate, escapeRegex } = require('../utils/paginate');
const { badRequest, forbidden } = require('../utils/errors');
const { owned, ownedOptional } = require('./scope');

function assertClassAllowed(cls, restrict) {
  if (restrict && !restrict.map(String).includes(String(cls._id))) throw forbidden('You can only manage your own classes.');
}

function buildFilter(tenantId, q = {}, restrict) {
  const f = { tenantId };
  if (C.LESSON_CATEGORIES[q.category]) f.category = q.category;
  if (C.LESSON_STATUSES.includes(q.status)) f.status = q.status;
  if (q.class && /^[a-f0-9]{24}$/i.test(q.class)) f.class = q.class;
  if (restrict) f.class = q.class && restrict.map(String).includes(String(q.class)) ? q.class : { $in: restrict };
  if (q.from || q.to) {
    const r = dates.rangeFromQuery(q);
    f.date = { $gte: r.from, $lte: r.to };
  }
  if (q.search) f.title = new RegExp(escapeRegex(q.search), 'i');
  return f;
}

const list = (tenantId, q, restrict) => paginate(Lesson, buildFilter(tenantId, q, restrict), {
  page: q.page, limit: q.limit || 20, sort: { date: -1, createdAt: -1 },
  populate: [{ path: 'class', select: 'name' }, { path: 'teacher', select: 'fullName' }],
});

async function readFields(tenantId, data, restrict) {
  const cls = await owned(Class, tenantId, data.class, 'Class');
  assertClassAllowed(cls, restrict);
  const teacher = await ownedOptional(Teacher, tenantId, data.teacher || cls.teacher, 'Teacher');
  const out = {
    title: data.title, category: data.category, class: cls._id, teacher: teacher ? teacher._id : undefined,
    date: dates.parseDay(data.date) || dates.startOfDay(), objectives: data.objectives, description: data.description,
    status: C.LESSON_STATUSES.includes(data.status) ? data.status : 'planned', remarks: data.remarks,
    surah: undefined, fromVerse: undefined, toVerse: undefined,
  };
  if (data.surah) {
    const s = getSurah(data.surah);
    if (!s) throw badRequest('Choose a valid surah.');
    const from = parseInt(data.fromVerse, 10) || 1;
    const to = parseInt(data.toVerse, 10) || from;
    if (from < 1 || to < from || to > s.verses) throw badRequest('{surah} has {verses} verses — check the verse range.', null, { surah: s.name, verses: s.verses });
    Object.assign(out, { surah: s.number, fromVerse: from, toVerse: to });
  }
  return out;
}

async function create(ctx, data, restrict) {
  return Lesson.create({ ...(await readFields(ctx.tenantId, data, restrict)), tenantId: ctx.tenantId, createdBy: ctx.user._id });
}

async function update(ctx, id, data, restrict) {
  const lesson = await owned(Lesson, ctx.tenantId, id, 'Lesson', { lean: false });
  assertClassAllowed({ _id: lesson.class }, restrict);
  Object.assign(lesson, await readFields(ctx.tenantId, data, restrict));
  await lesson.save();
  // keep denormalised fields on progress rows in sync
  await LessonProgress.updateMany({ tenantId: ctx.tenantId, lesson: lesson._id }, {
    $set: { category: lesson.category, date: lesson.date, surah: lesson.surah, fromVerse: lesson.fromVerse, toVerse: lesson.toVerse },
  });
  return lesson;
}

async function remove(ctx, id, restrict) {
  const lesson = await owned(Lesson, ctx.tenantId, id, 'Lesson');
  assertClassAllowed({ _id: lesson.class }, restrict);
  await LessonProgress.deleteMany({ tenantId: ctx.tenantId, lesson: lesson._id });
  await Lesson.deleteOne({ tenantId: ctx.tenantId, _id: lesson._id });
  return lesson;
}

async function detail(tenantId, id) {
  const lesson = await owned(Lesson, tenantId, id, 'Lesson', {
    populate: [{ path: 'class', select: 'name' }, { path: 'teacher', select: 'fullName' }],
  });
  const [students, progress] = await Promise.all([
    Student.find({ tenantId, class: lesson.class._id, status: 'active' }).sort({ fullName: 1 }).select('fullName studentCode').lean(),
    LessonProgress.find({ tenantId, lesson: lesson._id }).lean(),
  ]);
  const byStudent = Object.fromEntries(progress.map((p) => [String(p.student), p]));
  // include students who left the class but already have a progress entry
  const missing = progress.filter((p) => !students.some((s) => String(s._id) === String(p.student))).map((p) => p.student);
  const former = missing.length ? await Student.find({ tenantId, _id: { $in: missing } }).select('fullName studentCode').lean() : [];
  return { lesson, roster: [...students, ...former].map((s) => ({ student: s, progress: byStudent[String(s._id)] || null })), surah: getSurah(lesson.surah) };
}

/** Save per-student performance for a lesson. `rows` = { [studentId]: { performance, score, completed, remarks } } */
async function saveProgress(ctx, id, rows = {}, restrict) {
  const lesson = await owned(Lesson, ctx.tenantId, id, 'Lesson');
  assertClassAllowed({ _id: lesson.class }, restrict);
  const ids = Object.keys(rows);
  const valid = await Student.find({ tenantId: ctx.tenantId, _id: { $in: ids.filter((x) => /^[a-f0-9]{24}$/i.test(x)) } }).select('_id').lean();
  const validSet = new Set(valid.map((s) => String(s._id)));
  const ops = [];
  for (const sid of ids) {
    if (!validSet.has(sid)) continue;
    const r = rows[sid] || {};
    if (!r.performance && !r.score && !r.remarks && !r.completed) continue;
    const score = r.score === '' || r.score === undefined ? undefined : Math.max(0, Math.min(100, parseInt(r.score, 10)));
    ops.push({
      updateOne: {
        filter: { tenantId: ctx.tenantId, lesson: lesson._id, student: sid },
        update: {
          $set: {
            performance: C.PERFORMANCE_LEVELS.includes(r.performance) ? r.performance : undefined,
            score: Number.isFinite(score) ? score : undefined, completed: r.completed === 'on',
            remarks: String(r.remarks || '').slice(0, 500), category: lesson.category, date: lesson.date,
            surah: lesson.surah, fromVerse: lesson.fromVerse, toVerse: lesson.toVerse,
          },
          $setOnInsert: { tenantId: ctx.tenantId, lesson: lesson._id, student: sid },
        },
        upsert: true,
      },
    });
  }
  if (ops.length) await LessonProgress.bulkWrite(ops);
  return ops.length;
}

module.exports = { list, create, update, remove, detail, saveProgress, buildFilter };
