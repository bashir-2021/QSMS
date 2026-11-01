'use strict';
/**
 * Platform-level collections (not tenant-scoped):
 * PlatformUser, Tenant, SubscriptionPlan, Subscription, SubscriptionPayment, PlatformAuditLog,
 * plus Counter (sequences) and Notification (platform and school notifications).
 */
const mongoose = require('mongoose');
const C = require('../config/constants');
const { PLATFORM_ROLES } = require('../config/roles');

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const money = { type: Number, default: 0, validate: { validator: Number.isSafeInteger, message: 'Money must be integer minor units' } };

/* ------------------------------ PlatformUser ------------------------------ */
const platformUserSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 160 },
  phone: { type: String, trim: true, maxlength: 40 },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: Object.keys(PLATFORM_ROLES), required: true },
  isActive: { type: Boolean, default: true },
  lastLoginAt: Date,
}, { timestamps: true });
platformUserSchema.index({ email: 1 }, { unique: true });

/* --------------------------------- Tenant --------------------------------- */
const tenantSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
  logo: String, // path relative to the uploads dir: "<tenantId>/logo-xxx.png"
  country: { type: String, trim: true, maxlength: 80 },
  city: { type: String, trim: true, maxlength: 80 },
  address: { type: String, trim: true, maxlength: 300 },
  phone: { type: String, trim: true, maxlength: 40 },
  email: { type: String, trim: true, lowercase: true, maxlength: 160 },
  adminName: { type: String, trim: true, maxlength: 120 },
  status: { type: String, enum: C.TENANT_STATUSES, default: 'active' },
  statusReason: { type: String, maxlength: 300 },
  currentSubscription: { type: ObjectId, ref: 'Subscription' },
}, { timestamps: true });
tenantSchema.index({ slug: 1 }, { unique: true });
tenantSchema.index({ status: 1 });

/* ---------------------------- SubscriptionPlan ---------------------------- */
const planSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  code: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
  description: { type: String, maxlength: 500 },
  price: { ...money, required: true },
  currency: { type: String, default: 'USD', uppercase: true, maxlength: 3 },
  billingCycle: { type: String, enum: Object.keys(C.BILLING_CYCLES), default: 'monthly' },
  customDays: { type: Number, min: 1, max: 1825 },
  limits: {
    students: { type: Number, min: 0, default: 100 }, // 0 = unlimited
    teachers: { type: Number, min: 0, default: 10 },
    classes: { type: Number, min: 0, default: 10 },
    users: { type: Number, min: 0, default: 5 },
  },
  features: [{ type: String, enum: Object.keys(C.PLAN_FEATURES) }],
  trialDays: { type: Number, min: 0, max: 365, default: 14 },
  graceDays: { type: Number, min: 0, max: 90, default: 7 },
  reminderDays: { type: [Number], default: [7, 3, 1] },
  isPublic: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });
planSchema.index({ code: 1 }, { unique: true });

/* ------------------------------ Subscription ------------------------------ */
const subscriptionSchema = new Schema({
  tenant: { type: ObjectId, ref: 'Tenant', required: true },
  plan: { type: ObjectId, ref: 'SubscriptionPlan', required: true },
  status: { type: String, enum: C.SUBSCRIPTION_STATUSES, default: 'trial' },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  graceEndDate: Date,
  // snapshot of plan terms at the time of subscription, so plan edits don't silently change contracts
  planSnapshot: {
    name: String, price: Number, currency: String, billingCycle: String, customDays: Number,
    limits: { students: Number, teachers: Number, classes: Number, users: Number },
    features: [String], graceDays: Number, reminderDays: [Number],
  },
  remindersSent: [{ daysBefore: Number, sentAt: Date }],
  cancelledAt: Date,
  notes: { type: String, maxlength: 500 },
}, { timestamps: true });
subscriptionSchema.index({ tenant: 1, createdAt: -1 });
subscriptionSchema.index({ status: 1, endDate: 1 });

/* --------------------------- SubscriptionPayment -------------------------- */
const subscriptionPaymentSchema = new Schema({
  reference: { type: String, required: true }, // internal number SP-2026-00001
  tenant: { type: ObjectId, ref: 'Tenant', required: true },
  subscription: { type: ObjectId, ref: 'Subscription', required: true },
  plan: { type: ObjectId, ref: 'SubscriptionPlan', required: true },
  amount: { ...money, required: true },
  currency: { type: String, default: 'USD' },
  periods: { type: Number, min: 1, max: 24, default: 1 },
  method: { type: String, enum: C.PLATFORM_PAYMENT_METHODS, required: true },
  transactionRef: { type: String, trim: true, maxlength: 120 },
  payerName: { type: String, trim: true, maxlength: 120 },
  paidAt: Date,
  status: { type: String, enum: C.SUBSCRIPTION_PAYMENT_STATUSES, default: 'pending' },
  submittedBy: { kind: { type: String, enum: ['school', 'platform'] }, userId: ObjectId, name: String },
  verifiedBy: { type: ObjectId, ref: 'PlatformUser' },
  verifiedAt: Date,
  periodStart: Date,
  periodEnd: Date,
  notes: { type: String, maxlength: 500 },
  gateway: { provider: String, payload: Schema.Types.Mixed }, // reserved for future gateway integrations
}, { timestamps: true });
subscriptionPaymentSchema.index({ reference: 1 }, { unique: true });
subscriptionPaymentSchema.index({ tenant: 1, createdAt: -1 });
subscriptionPaymentSchema.index({ status: 1, createdAt: -1 });

/* ---------------------------- PlatformAuditLog ---------------------------- */
const platformAuditSchema = new Schema({
  actor: { type: ObjectId, ref: 'PlatformUser' },
  actorName: String,
  action: { type: String, required: true },
  entity: String,
  entityId: ObjectId,
  tenant: { type: ObjectId, ref: 'Tenant' },
  details: Schema.Types.Mixed,
  ip: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
platformAuditSchema.index({ createdAt: -1 });

/* -------------------------------- Counter --------------------------------- */
// Atomic sequence generator; tenantId null for platform-wide sequences.
const counterSchema = new Schema({
  tenantId: { type: ObjectId, default: null },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });

/* ------------------------------ Notification ------------------------------ */
const notificationSchema = new Schema({
  audience: { type: String, enum: ['platform', 'school'], required: true },
  tenantId: { type: ObjectId, ref: 'Tenant' }, // required when audience = school
  roles: [String], // empty = everyone in the audience
  type: { type: String, default: 'info' }, // subscription, payment, fees, academic, system
  level: { type: String, enum: ['info', 'success', 'warning', 'danger'], default: 'info' },
  title: { type: String, required: true, maxlength: 160 },
  message: { type: String, maxlength: 1000 },
  link: String,
  dedupeKey: String, // prevents the reminder job sending the same notice twice
  readBy: [ObjectId],
  channels: { type: [String], default: ['in_app'] }, // future: email, whatsapp
}, { timestamps: true });
notificationSchema.index({ audience: 1, tenantId: 1, createdAt: -1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });

module.exports = {
  PlatformUser: mongoose.model('PlatformUser', platformUserSchema),
  Tenant: mongoose.model('Tenant', tenantSchema),
  SubscriptionPlan: mongoose.model('SubscriptionPlan', planSchema),
  Subscription: mongoose.model('Subscription', subscriptionSchema),
  SubscriptionPayment: mongoose.model('SubscriptionPayment', subscriptionPaymentSchema),
  PlatformAuditLog: mongoose.model('PlatformAuditLog', platformAuditSchema),
  Counter: mongoose.model('Counter', counterSchema),
  Notification: mongoose.model('Notification', notificationSchema),
};
