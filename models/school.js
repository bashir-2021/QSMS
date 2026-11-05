'use strict';
/**
 * School core collections (all tenant-scoped through the tenant plugin):
 * SchoolUser, SchoolSettings, Student, Teacher, Class, ClassShift, StudentEnrollment, SchoolAuditLog
 */
const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenant');
const C = require('../config/constants');
const { SCHOOL_ROLES } = require('../config/roles');

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const money = { type: Number, default: 0, min: 0, validate: { validator: Number.isSafeInteger, message: 'Money must be integer minor units' } };
const subacDeductionPaths = Object.fromEntries(Object.entries(C.SUBAC_DEDUCTIONS).map(([key, d]) => [key, { type: Number, min: 0, max: 100, default: d.points }]));

/* ------------------------------- SchoolUser ------------------------------- */
const schoolUserSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 160 },
  phone: { type: String, trim: true, maxlength: 40 },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: Object.keys(SCHOOL_ROLES), required: true },
  teacher: { type: ObjectId, ref: 'Teacher' }, // links a Teacher-role login to a teacher profile
  isActive: { type: Boolean, default: true },
  lastLoginAt: Date,
}, { timestamps: true });
schoolUserSchema.plugin(tenantPlugin);
// Email is the login identity, so it is unique across the whole platform.
schoolUserSchema.index({ email: 1 }, { unique: true });

/* ----------------------------- SchoolSettings ----------------------------- */
const schoolSettingsSchema = new Schema({
  academicYear: { type: String, default: () => { const y = new Date().getFullYear(); return `${y}-${y + 1}`; } },
  currency: { type: String, default: 'USD', uppercase: true, maxlength: 3 },
  registrationFee: money,
  monthlyFee: money, // global default; class.monthlyFee overrides when set
  billingDueDay: { type: Number, min: 1, max: 28, default: 10 },
  paymentMethods: { type: [String], default: () => [...C.DEFAULT_PAYMENT_METHODS] },
  numbering: {
    student: { type: String, default: 'STU-{SEQ:4}' },
    teacher: { type: String, default: 'TCH-{SEQ:3}' },
    invoice: { type: String, default: 'INV-{YYYY}-{SEQ:5}' },
    receipt: { type: String, default: 'RCT-{YYYY}-{SEQ:5}' },
    payment: { type: String, default: 'PAY-{YYYY}-{SEQ:5}' },
    expense: { type: String, default: 'EXP-{YYYY}-{SEQ:5}' },
  },
  receiptFooter: { type: String, maxlength: 300, default: 'Thank you. May Allah reward your support for Quran education.' },
  subacDeductions: subacDeductionPaths, // points lost per occurrence, set by the school manager
}, { timestamps: true });
schoolSettingsSchema.plugin(tenantPlugin);
// One settings document per school: replace the plugin's plain tenantId index with a unique one.
schoolSettingsSchema.path('tenantId').index(false);
schoolSettingsSchema.index({ tenantId: 1 }, { unique: true });

/* --------------------------------- Teacher -------------------------------- */
const teacherSchema = new Schema({
  teacherCode: { type: String, required: true },
  fullName: { type: String, required: true, trim: true, maxlength: 120 },
  gender: { type: String, enum: C.GENDERS },
  dateOfBirth: Date,
  phone: { type: String, trim: true, maxlength: 40 },
  email: { type: String, trim: true, lowercase: true, maxlength: 160 },
  address: { type: String, trim: true, maxlength: 300 },
  qualification: { type: String, trim: true, maxlength: 160 },
  specialization: { type: String, trim: true, maxlength: 160 },
  employmentDate: Date,
  monthlySalary: money,
  status: { type: String, enum: C.TEACHER_STATUSES, default: 'active' },
  photo: String,
  notes: { type: String, maxlength: 500 },
}, { timestamps: true });
teacherSchema.plugin(tenantPlugin);
teacherSchema.index({ tenantId: 1, teacherCode: 1 }, { unique: true });
teacherSchema.index({ tenantId: 1, fullName: 1 });

/* ---------------------------------- Class --------------------------------- */
const classSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  level: { type: String, enum: C.CLASS_LEVELS, default: 'Beginner' },
  teacher: { type: ObjectId, ref: 'Teacher' },
  capacity: { type: Number, min: 1, max: 500, default: 30 },
  schedule: {
    days: [{ type: String, enum: C.WEEKDAYS }],
    startTime: String, // "08:00"
    endTime: String,
    room: { type: String, maxlength: 60 },
  },
  monthlyFee: { type: Number, min: 0, validate: { validator: (v) => v == null || Number.isSafeInteger(v) } }, // null => use global fee
  startDate: Date,
  endDate: Date,
  isActive: { type: Boolean, default: true },
  description: { type: String, maxlength: 500 },
}, { timestamps: true });
classSchema.plugin(tenantPlugin);
classSchema.index({ tenantId: 1, name: 1 }, { unique: true });

/* ------------------------------- ClassShift ------------------------------- */
// The shifts a class runs (e.g. Morning, Evening, Night). Attendance is taken per shift.
const classShiftSchema = new Schema({
  class: { type: ObjectId, ref: 'Class', required: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  startTime: String, // "08:00"
  endTime: String,
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
classShiftSchema.plugin(tenantPlugin);
classShiftSchema.index({ tenantId: 1, class: 1, name: 1 }, { unique: true });

/* --------------------------------- Student -------------------------------- */
const studentSchema = new Schema({
  studentCode: { type: String, required: true },
  fullName: { type: String, required: true, trim: true, maxlength: 120 },
  gender: { type: String, enum: C.GENDERS, required: true },
  dateOfBirth: Date,
  photo: String,
  guardianName: { type: String, trim: true, maxlength: 120 },
  guardianPhone: { type: String, trim: true, maxlength: 40 },
  guardianRelation: { type: String, trim: true, maxlength: 40 },
  motherName: { type: String, trim: true, maxlength: 120 },
  district: { type: String, trim: true, maxlength: 80 },
  address: { type: String, trim: true, maxlength: 300 },
  registrationDate: { type: Date, default: Date.now },
  // Required by studentService for new students; left optional here so older records still save.
  program: { type: String, enum: Object.keys(C.STUDENT_PROGRAMS) },
  class: { type: ObjectId, ref: 'Class' },
  shifts: [{ type: ObjectId, ref: 'ClassShift' }], // shifts of the student's class
  teacher: { type: ObjectId, ref: 'Teacher' },
  status: { type: String, enum: C.STUDENT_STATUSES, default: 'active' },
  feeOverride: { type: Number, min: 0, validate: { validator: (v) => v == null || Number.isSafeInteger(v) } }, // optional custom monthly fee
  notes: { type: String, maxlength: 500 },
}, { timestamps: true });
studentSchema.plugin(tenantPlugin);
studentSchema.index({ tenantId: 1, studentCode: 1 }, { unique: true });
studentSchema.index({ tenantId: 1, status: 1, class: 1 });
studentSchema.index({ tenantId: 1, fullName: 1 });

/* ---------------------------- StudentEnrollment --------------------------- */
// History of class placements (enrol / transfer / withdraw).
const enrollmentSchema = new Schema({
  student: { type: ObjectId, ref: 'Student', required: true },
  class: { type: ObjectId, ref: 'Class', required: true },
  startDate: { type: Date, default: Date.now },
  endDate: Date,
  status: { type: String, enum: ['active', 'transferred', 'withdrawn', 'completed'], default: 'active' },
  reason: { type: String, maxlength: 300 },
  recordedBy: { type: ObjectId, ref: 'SchoolUser' },
}, { timestamps: true });
enrollmentSchema.plugin(tenantPlugin);
enrollmentSchema.index({ tenantId: 1, student: 1, startDate: -1 });
enrollmentSchema.index({ tenantId: 1, class: 1, status: 1 });

/* ----------------------------- SchoolAuditLog ----------------------------- */
const schoolAuditSchema = new Schema({
  user: { type: ObjectId, ref: 'SchoolUser' },
  userName: String,
  action: { type: String, required: true }, // e.g. payment.create, invoice.cancel, user.login
  entity: String,
  entityId: ObjectId,
  details: Schema.Types.Mixed,
  ip: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
schoolAuditSchema.plugin(tenantPlugin);
schoolAuditSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = {
  SchoolUser: mongoose.model('SchoolUser', schoolUserSchema),
  SchoolSettings: mongoose.model('SchoolSettings', schoolSettingsSchema),
  Teacher: mongoose.model('Teacher', teacherSchema),
  Class: mongoose.model('Class', classSchema),
  ClassShift: mongoose.model('ClassShift', classShiftSchema),
  Student: mongoose.model('Student', studentSchema),
  StudentEnrollment: mongoose.model('StudentEnrollment', enrollmentSchema),
  SchoolAuditLog: mongoose.model('SchoolAuditLog', schoolAuditSchema),
};
