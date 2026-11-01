'use strict';
/**
 * Academic collections (tenant-scoped):
 * Lesson, LessonProgress, AcademicActivity, ActivityParticipation, StudentAttendance, TeacherAttendance
 */
const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenant');
const C = require('../config/constants');

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

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

/* ---------------------------- AcademicActivity ---------------------------- */
const activitySchema = new Schema({
  type: { type: String, enum: Object.keys(C.ACTIVITY_TYPES), required: true }, // subac | duruus
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

/* -------------------------- ActivityParticipation ------------------------- */
const participationSchema = new Schema({
  activity: { type: ObjectId, ref: 'AcademicActivity', required: true },
  student: { type: ObjectId, ref: 'Student', required: true },
  attendance: { type: String, enum: C.ATTENDANCE_STATUSES, default: 'present' },
  performance: { type: String, enum: C.PERFORMANCE_LEVELS },
  score: { type: Number, min: 0, max: 100 },
  remarks: { type: String, maxlength: 500 },
}, { timestamps: true });
participationSchema.plugin(tenantPlugin);
participationSchema.index({ tenantId: 1, activity: 1, student: 1 }, { unique: true });
participationSchema.index({ tenantId: 1, student: 1 });

/* ---------------------------- StudentAttendance --------------------------- */
const studentAttendanceSchema = new Schema({
  student: { type: ObjectId, ref: 'Student', required: true },
  class: { type: ObjectId, ref: 'Class', required: true },
  date: { type: Date, required: true }, // UTC midnight
  status: { type: String, enum: C.ATTENDANCE_STATUSES, required: true },
  remarks: { type: String, maxlength: 300 },
  recordedBy: { type: ObjectId, ref: 'SchoolUser' },
}, { timestamps: true });
studentAttendanceSchema.plugin(tenantPlugin);
studentAttendanceSchema.index({ tenantId: 1, student: 1, date: 1 }, { unique: true });
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
  AcademicActivity: mongoose.model('AcademicActivity', activitySchema),
  ActivityParticipation: mongoose.model('ActivityParticipation', participationSchema),
  StudentAttendance: mongoose.model('StudentAttendance', studentAttendanceSchema),
  TeacherAttendance: mongoose.model('TeacherAttendance', teacherAttendanceSchema),
};
