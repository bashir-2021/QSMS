'use strict';
/**
 * Small data migrations that run at start-up. Each one is idempotent: it only touches documents
 * still in the old shape, so running it again does nothing.
 */
const { Class, Student } = require('../models');
const C = require('../config/constants');

// Used only when a class has no students to decide its level from.
const OLD_LEVEL_FALLBACK = { Beginner: 'farbar', Elementary: 'farbar', Intermediate: 'cashra', Mixed: 'cashra', Advanced: 'taxfiid', Hifz: 'taxfiid' };

/** Classes had one `teacher`; they now have a `teachers` list. */
async function classTeachers() {
  const res = await Class.collection.updateMany(
    { $or: [{ teacher: { $exists: true } }, { teachers: { $exists: false } }] },
    [{ $set: { teachers: { $cond: [{ $ifNull: ['$teacher', false] }, ['$teacher'], []] } } }, { $unset: 'teacher' }],
  );
  return res.modifiedCount;
}

/** Class levels were Beginner…Mixed; they are now the three Quran categories (most common among the class's students). */
async function classLevels() {
  const old = await Class.collection.find({ level: { $nin: C.CLASS_LEVELS } }).project({ _id: 1, tenantId: 1, level: 1 }).toArray();
  for (const cls of old) {
    // eslint-disable-next-line no-await-in-loop
    const [top] = await Student.collection.aggregate([
      { $match: { tenantId: cls.tenantId, class: cls._id, program: { $in: Object.keys(C.STUDENT_PROGRAMS) } } },
      { $group: { _id: '$program', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 1 },
    ]).toArray();
    const level = top ? top._id : (OLD_LEVEL_FALLBACK[cls.level] || 'cashra');
    // eslint-disable-next-line no-await-in-loop
    await Class.collection.updateOne({ _id: cls._id, level: cls.level }, { $set: { level } });
  }
  return old.length;
}

async function run({ log = true } = {}) {
  const teachers = await classTeachers();
  const levels = await classLevels();
  if (log && (teachers || levels)) console.log(`[migrate] classes: ${teachers} moved to several teachers, ${levels} given a Quran category level`);
  return { teachers, levels };
}

module.exports = { run };
