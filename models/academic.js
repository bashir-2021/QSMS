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
// One student's own lesson: assigned, recited to the teacher, then passed or returned.
const lessonReviewSchema = new Schema({
  grade: { type: String, enum: Object.keys(C.STUDENT_LESSON_GRADES), required: true },
  score: { type: Number, min: 0, max: 100 },
  remarks: { type: String, maxlength: 500 },
  reviewedBy: { type: ObjectId, ref: 'SchoolUser' },
  reviewedAt: { type: Date, default: Date.now },
}, { _id: false });

const studentLessonSchema = new Schema({
  student: { type: ObjectId, ref: 'Student', required: true },
  class: { type: ObjectId, ref: 'Class' },
  program: { type: String, enum: Object.keys(C.STUDENT_PROGRAMS) },
  surah: { type: Number, min: 1, max: 114 },
  fromVerse: { type: Number, min: 1 },
  toVerse: { type: Number, min: 1 },
  juz: { type: Number, min: 1, max: 30 },
  topic: { type: String, trim: true, maxlength: 200 }, // e.g. the letters a Farbar student is writing
  assignedDate: { type: Date, required: true },
  status: { type: String, enum: C.STUDENT_LESSON_STATUSES, default: 'assigned' },
  isOpen: { type: Boolean, default: true }, // false once passed
  grade: { type: String, enum: Object.keys(C.STUDENT_LESSON_GRADES) }, // passing grade
  score: { type: Number, min: 0, max: 100 },
  passedAt: Date,
  reviews: [lessonReviewSchema],
  assignedBy: { type: ObjectId, ref: 'SchoolUser' },
}, { timestamps: true });
studentLessonSchema.plugin(tenantPlugin);
// A student works on one lesson at a time.
studentLessonSchema.index({ tenantId: 1, student: 1 }, { unique: true, partialFilterExpression: { isOpen: true } });
studentLessonSchema.index({ tenantId: 1, student: 1, assignedDate: -1 });

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
  checkIn: String,
  checkOut: String,
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
