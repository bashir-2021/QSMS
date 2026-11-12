'use strict';
/**
 * Academic collections (tenant-scoped):
 * Lesson, LessonProgress, StudentLesson, AcademicActivity, ActivityParticipation, StudentAttendance, TeacherAttendance
 */
const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenant');
const C = require('../config/constants');

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const numberPerDeduction = (opts) => Object.fromEntries(Object.keys(C.SUBAC_DEDUCTIONS).map((k) => [k, { type: Number, ...opts }]));

/* --------------------------------- Lesson --------------------------------- */
const lessonSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  category: { type: String, enum: Object.keys(C.LESSON_CATEGORIES), required: true },
  class: { type: ObjectId, ref: 'Class', required: true },
  teacher: { type: ObjectId, ref: 'Teacher' },
  date: { type: Date, required: true },
  surah: { type: Number, min: 1, max: 114 },
  fromVerse: { type: Number, min: 1 },
  toVerse: { type: Number, min: 1 },
  objectives: { type: String, maxlength: 1000 },
  description: { type: String, maxlength: 2000 },
  status: { type: String, enum: C.LESSON_STATUSES, default: 'planned' },
  remarks: { type: String, maxlength: 1000 },
  createdBy: { type: ObjectId, ref: 'SchoolUser' },
}, { timestamps: true });
lessonSchema.plugin(tenantPlugin);
lessonSchema.index({ tenantId: 1, class: 1, date: -1 });
lessonSchema.index({ tenantId: 1, category: 1, date: -1 });

/* ----------------------------- LessonProgress ----------------------------- */
// One row per student per lesson: how the student performed on it.
const lessonProgressSchema = new Schema({
  lesson: { type: ObjectId, ref: 'Lesson', required: true },
  student: { type: ObjectId, ref: 'Student', required: true },
  category: { type: String, enum: Object.keys(C.LESSON_CATEGORIES) },
  date: Date,
  surah: Number,
  fromVerse: Number,
  toVerse: Number,
  performance: { type: String, enum: C.PERFORMANCE_LEVELS },
  score: { type: Number, min: 0, max: 100 },
  completed: { type: Boolean, default: false },
  remarks: { type: String, maxlength: 500 },
}, { timestamps: true });
lessonProgressSchema.plugin(tenantPlugin);
lessonProgressSchema.index({ tenantId: 1, lesson: 1, student: 1 }, { unique: true });
lessonProgressSchema.index({ tenantId: 1, student: 1, date: -1 });

/* ------------------------------ StudentLesson ----------------------------- */
// One student's own lesson: a portion of the Quran (or a Farbar topic) given on a day, then listened to later.
// Every sitting (listening) is appended to `attempts` and never changed or removed; the top-level fields mirror the
// latest sitting so lists and reports can filter on them.
const ayahRef = { surah: { type: Number, min: 1, max: 114 }, ayah: { type: Number, min: 1 } };

const lessonAttemptSchema = new Schema({
  attempt: { type: Number, min: 1, required: true }, // 1, then +1 after each time the lesson was returned
  date: { type: Date, required: true },
  teacher: { type: ObjectId, ref: 'Teacher' }, // the teacher who listened (a class can have several)
  attendance: { type: String, enum: C.LESSON_ATTENDANCE, required: true },
  status: { type: String, enum: Object.keys(C.LESSON_STATUSES_HEARD) }, // unset when absent
  warnings: { type: Number, min: 0 },
  score: { type: Number, min: 0, max: 100 }, // only once listened to
  level: { type: String, maxlength: 60 }, // hifz level label at the time
  result: { type: String, enum: Object.keys(C.LESSON_RESULTS) }, // unset when absent
  autoReturned: Boolean, // returned because the warning limit or minimum score was reached
  returnReason: { type: String, maxlength: 300 },
  remarks: { type: String, maxlength: 500 },
  // the school's rules this sitting was scored with, so later changes never alter it
  rules: { maxWarnings: Number, pointsPerWarning: Number, returnBelowScore: Number },
  recordedBy: { type: ObjectId, ref: 'SchoolUser' },
  recordedAt: { type: Date, default: Date.now },
});

const studentLessonSchema = new Schema({
  student: { type: ObjectId, ref: 'Student', required: true },
  class: { type: ObjectId, ref: 'Class' },
  teacher: { type: ObjectId, ref: 'Teacher' }, // the teacher who gave the lesson
  program: { type: String, enum: Object.keys(C.STUDENT_PROGRAMS) },
  lessonType: { type: String, trim: true, maxlength: 60 },
  date: { type: Date, required: true }, // the day the lesson was given (UTC midnight)
  start: ayahRef,
  end: ayahRef,
  topic: { type: String, trim: true, maxlength: 200 }, // e.g. the letters a Farbar student is writing
  // size of the portion in the Madinah Mushaf (604 pages)
  ayahs: { type: Number, min: 0 },
  startPage: Number,
  endPage: Number,
  pages: { type: Number, min: 0 },
  startJuz: Number,
  endJuz: Number,
  juz: { type: Number, min: 0 },
  // mirror of the latest sitting
  attendance: { type: String, enum: C.LESSON_ATTENDANCE },
  status: { type: String, enum: C.STUDENT_LESSON_STATUSES, required: true },
  result: { type: String, enum: Object.keys(C.LESSON_RESULTS) },
  warnings: Number,
  score: { type: Number, min: 0, max: 100 },
  level: String,
  isOpen: { type: Boolean, default: true }, // true while waiting to be listened to or returned
  passedAt: Date,
  attempts: [lessonAttemptSchema],
  createdBy: { type: ObjectId, ref: 'SchoolUser' },
}, { timestamps: true });
studentLessonSchema.plugin(tenantPlugin);
studentLessonSchema.index({ tenantId: 1, student: 1, date: -1 });
studentLessonSchema.index({ tenantId: 1, student: 1, isOpen: 1 });
studentLessonSchema.index({ tenantId: 1, date: -1, status: 1 });
studentLessonSchema.index({ tenantId: 1, class: 1, date: -1 });

/* ---------------------------- AcademicActivity ---------------------------- */
const activitySchema = new Schema({
  type: { type: String, enum: Object.keys(C.ACTIVITY_TYPES), required: true }, // subac | duruus
  frequency: { type: String, enum: C.SUBAC_FREQUENCIES }, // Subac only; unset on sessions from before deductions
  deductionRates: numberPerDeduction({ min: 0 }), // the school's points when the session was created
  title: { type: String, required: true, trim: true, maxlength: 160 },
  date: { type: Date, required: true },
  class: { type: ObjectId, ref: 'Class', required: true },
  teacher: { type: ObjectId, ref: 'Teacher' },
  topic: { type: String, maxlength: 300 },
  objectives: { type: String, maxlength: 1000 },
  evaluation: { type: String, maxlength: 1000 },
  remarks: { type: String, maxlength: 1000 },
  createdBy: { type: ObjectId, ref: 'SchoolUser' },
}, { timestamps: true });
activitySchema.plugin(tenantPlugin);
activitySchema.index({ tenantId: 1, type: 1, date: -1 });
// A class has at most one daily Subac per day.
activitySchema.index({ tenantId: 1, class: 1, date: 1 }, { unique: true, partialFilterExpression: { frequency: 'daily' } });

/* -------------------------- ActivityParticipation ------------------------- */
const participationSchema = new Schema({
  activity: { type: ObjectId, ref: 'AcademicActivity', required: true },
  student: { type: ObjectId, ref: 'Student', required: true },
  attendance: { type: String, enum: C.ATTENDANCE_STATUSES, default: 'present' },
  performance: { type: String, enum: C.PERFORMANCE_LEVELS },
  score: { type: Number, min: 0, max: 100 },
  deductions: numberPerDeduction({ min: 0 }), // Subac: occurrences of each error
  deducted: { type: Number, min: 0 }, // Subac: total points lost
  manualPoints: Number, // Subac: points the teacher added (+) or removed (-) by hand
  remarks: { type: String, maxlength: 500 },
}, { timestamps: true });
participationSchema.plugin(tenantPlugin);
participationSchema.index({ tenantId: 1, activity: 1, student: 1 }, { unique: true });
participationSchema.index({ tenantId: 1, student: 1 });

/* ---------------------------- StudentAttendance --------------------------- */
const studentAttendanceSchema = new Schema({
  student: { type: ObjectId, ref: 'Student', required: true },
  class: { type: ObjectId, ref: 'Class', required: true },
  shift: { type: ObjectId, ref: 'ClassShift' }, // unset for classes without shifts
  date: { type: Date, required: true }, // UTC midnight
  status: { type: String, enum: C.ATTENDANCE_STATUSES, required: true },
  remarks: { type: String, maxlength: 300 },
  recordedBy: { type: ObjectId, ref: 'SchoolUser' },
}, { timestamps: true });
studentAttendanceSchema.plugin(tenantPlugin);
studentAttendanceSchema.index({ tenantId: 1, student: 1, date: 1, shift: 1 }, { unique: true });
studentAttendanceSchema.index({ tenantId: 1, class: 1, date: 1 });
studentAttendanceSchema.index({ tenantId: 1, date: 1, status: 1 });

/* ---------------------------- TeacherAttendance --------------------------- */
const teacherAttendanceSchema = new Schema({
  teacher: { type: ObjectId, ref: 'Teacher', required: true },
  date: { type: Date, required: true },
  status: { type: String, enum: C.ATTENDANCE_STATUSES, required: true },
  // the registered time for that day (copied from the teacher record, so later schedule changes don't rewrite history)
  scheduledIn: String,
  scheduledOut: String,
  workDay: { type: Boolean, default: true }, // false when the teacher came on a day they are not registered for
  // what the teacher pressed themselves (school local time)
  selfCheckIn: String,
  selfCheckOut: String,
  // the real times, as approved by the receptionist
  checkIn: String,
  checkOut: String,
  approval: { type: String, enum: C.TEACHER_ATTENDANCE_APPROVAL, default: 'approved' },
  approvedBy: { type: ObjectId, ref: 'SchoolUser' },
  approvedAt: Date,
  remarks: { type: String, maxlength: 300 },
  recordedBy: { type: ObjectId, ref: 'SchoolUser' },
}, { timestamps: true });
teacherAttendanceSchema.plugin(tenantPlugin);
teacherAttendanceSchema.index({ tenantId: 1, teacher: 1, date: 1 }, { unique: true });
teacherAttendanceSchema.index({ tenantId: 1, date: 1 });

module.exports = {
  Lesson: mongoose.model('Lesson', lessonSchema),
  LessonProgress: mongoose.model('LessonProgress', lessonProgressSchema),
  StudentLesson: mongoose.model('StudentLesson', studentLessonSchema),
  AcademicActivity: mongoose.model('AcademicActivity', activitySchema),
  ActivityParticipation: mongoose.model('ActivityParticipation', participationSchema),
  StudentAttendance: mongoose.model('StudentAttendance', studentAttendanceSchema),
  TeacherAttendance: mongoose.model('TeacherAttendance', teacherAttendanceSchema),
};
