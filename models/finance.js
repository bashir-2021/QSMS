'use strict';
/**
 * Finance collections (tenant-scoped). All money is integer minor units (cents).
 * StudentInvoice, StudentPayment, PaymentAllocation, StudentReceipt,
 * Expense, ExpenseCategory, TeacherSalaryPayment
 *
 * Accounting rules:
 *  - Invoices are what a student owes; they are NOT income.
 *  - Income = confirmed StudentPayments. Expenses = recorded Expenses. Net = income - expenses.
 *  - Confirmed payments and recorded expenses are never deleted; they are reversed/cancelled
 *    with a reason, actor and timestamp (and an audit-log entry).
 */
const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenant');
const C = require('../config/constants');

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const isInt = { validator: Number.isSafeInteger, message: 'Money must be integer minor units' };
const money = { type: Number, default: 0, min: 0, validate: isInt };
const signedMoney = { type: Number, default: 0, validate: isInt };
const cancellation = {
  at: Date,
  by: { type: ObjectId, ref: 'SchoolUser' },
  byName: String,
  reason: { type: String, maxlength: 300 },
};

/* ----------------------------- StudentInvoice ----------------------------- */
const invoiceSchema = new Schema({
  invoiceNo: { type: String, required: true },
  student: { type: ObjectId, ref: 'Student', required: true },
  class: { type: ObjectId, ref: 'Class' },
  type: { type: String, enum: Object.keys(C.INVOICE_TYPES), required: true },
  period: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/ }, // monthly invoices
  description: { type: String, maxlength: 300 },
  amount: { ...money, required: true }, // gross fee
  discount: money,
  adjustment: signedMoney, // + surcharge / - credit
  total: { ...money, required: true }, // amount - discount + adjustment
  paid: money,
  previousBalance: money, // outstanding from earlier invoices at generation time (informational)
  status: { type: String, enum: C.INVOICE_STATUSES, default: 'unpaid' },
  issueDate: { type: Date, default: Date.now },
  dueDate: Date,
  // Present only while the invoice is live; a unique partial index on it prevents duplicate
  // bills for the same student + type + period. Removed on cancellation.
  billingKey: String,
  cancelled: cancellation,
  createdBy: { type: ObjectId, ref: 'SchoolUser' },
}, { timestamps: true });
invoiceSchema.plugin(tenantPlugin);
invoiceSchema.virtual('balance').get(function balance() { return this.total - this.paid; });
invoiceSchema.set('toJSON', { virtuals: true });
invoiceSchema.index({ tenantId: 1, invoiceNo: 1 }, { unique: true });
invoiceSchema.index({ tenantId: 1, billingKey: 1 }, { unique: true, partialFilterExpression: { billingKey: { $type: 'string' } } });
invoiceSchema.index({ tenantId: 1, student: 1, status: 1 });
invoiceSchema.index({ tenantId: 1, type: 1, period: 1 });
invoiceSchema.index({ tenantId: 1, status: 1, dueDate: 1 });

/* ----------------------------- StudentPayment ----------------------------- */
const paymentSchema = new Schema({
  paymentNo: { type: String, required: true },
  student: { type: ObjectId, ref: 'Student', required: true },
  amount: { ...money, required: true, min: 1 },
  method: { type: String, required: true, maxlength: 60 },
  transactionRef: { type: String, trim: true, maxlength: 120 },
  paymentDate: { type: Date, required: true },
  category: { type: String, enum: ['registration', 'monthly', 'other', 'mixed'] },
  receivedBy: { type: ObjectId, ref: 'SchoolUser' },
  receivedByName: String,
  status: { type: String, enum: ['confirmed', 'reversed'], default: 'confirmed' },
  reversal: cancellation,
  receipt: { type: ObjectId, ref: 'StudentReceipt' },
  notes: { type: String, maxlength: 300 },
}, { timestamps: true });
paymentSchema.plugin(tenantPlugin);
paymentSchema.index({ tenantId: 1, paymentNo: 1 }, { unique: true });
paymentSchema.index({ tenantId: 1, student: 1, paymentDate: -1 });
paymentSchema.index({ tenantId: 1, status: 1, paymentDate: -1 });

/* ---------------------------- PaymentAllocation --------------------------- */
const allocationSchema = new Schema({
  payment: { type: ObjectId, ref: 'StudentPayment', required: true },
  invoice: { type: ObjectId, ref: 'StudentInvoice', required: true },
  student: { type: ObjectId, ref: 'Student', required: true },
  invoiceType: String,
  paymentDate: Date, // copied from the payment so income-by-category reports need no join
  amount: { ...money, required: true, min: 1 },
  status: { type: String, enum: ['active', 'reversed'], default: 'active' },
}, { timestamps: true });
allocationSchema.plugin(tenantPlugin);
allocationSchema.index({ tenantId: 1, payment: 1 });
allocationSchema.index({ tenantId: 1, invoice: 1 });
allocationSchema.index({ tenantId: 1, status: 1, paymentDate: 1 });

/* ----------------------------- StudentReceipt ----------------------------- */
// Immutable snapshot of what was printed, so reprints always match the original.
const receiptSchema = new Schema({
  receiptNo: { type: String, required: true },
  payment: { type: ObjectId, ref: 'StudentPayment', required: true },
  student: { type: ObjectId, ref: 'Student', required: true },
  snapshot: {
    schoolName: String,
    schoolAddress: String,
    schoolPhone: String,
    schoolLogo: String,
    currency: String,
    studentName: String,
    studentCode: String,
    className: String,
    category: String,
    periods: [String],
    lines: [{ invoiceNo: String, description: String, total: Number, applied: Number, balanceAfter: Number }],
    totalAmount: Number, // total of the invoices this payment settled
    amountPaid: Number,
    remainingBalance: Number, // student's total outstanding after this payment
    method: String,
    transactionRef: String,
    paymentDate: Date,
    receivedBy: String,
    footer: String,
  },
  status: { type: String, enum: ['valid', 'void'], default: 'valid' },
  printCount: { type: Number, default: 0 },
  lastPrintedAt: Date,
}, { timestamps: true });
receiptSchema.plugin(tenantPlugin);
receiptSchema.index({ tenantId: 1, receiptNo: 1 }, { unique: true });
receiptSchema.index({ tenantId: 1, payment: 1 }, { unique: true });
receiptSchema.index({ tenantId: 1, student: 1, createdAt: -1 });

/* ----------------------------- ExpenseCategory ---------------------------- */
const expenseCategorySchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, maxlength: 300 },
  isSystem: { type: Boolean, default: false }, // e.g. Teacher salaries, used by payroll
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
expenseCategorySchema.plugin(tenantPlugin);
expenseCategorySchema.index({ tenantId: 1, name: 1 }, { unique: true });

/* --------------------------------- Expense -------------------------------- */
const expenseSchema = new Schema({
  expenseNo: { type: String, required: true },
  category: { type: ObjectId, ref: 'ExpenseCategory', required: true },
  description: { type: String, required: true, maxlength: 300 },
  amount: { ...money, required: true, min: 1 },
  expenseDate: { type: Date, required: true },
  method: { type: String, maxlength: 60 },
  recipient: { type: String, maxlength: 120 },
  reference: { type: String, maxlength: 120 },
  attachment: String, // private file path relative to uploads dir
  attachmentName: String,
  recurring: {
    enabled: { type: Boolean, default: false },
    frequency: { type: String, enum: ['monthly', 'quarterly', 'annual'] },
    nextDueDate: Date,
  },
  salaryPayment: { type: ObjectId, ref: 'TeacherSalaryPayment' },
  recordedBy: { type: ObjectId, ref: 'SchoolUser' },
  recordedByName: String,
  status: { type: String, enum: ['recorded', 'cancelled'], default: 'recorded' },
  cancelled: cancellation,
}, { timestamps: true });
expenseSchema.plugin(tenantPlugin);
expenseSchema.index({ tenantId: 1, expenseNo: 1 }, { unique: true });
expenseSchema.index({ tenantId: 1, status: 1, expenseDate: -1 });
expenseSchema.index({ tenantId: 1, category: 1, expenseDate: -1 });

/* -------------------------- TeacherSalaryPayment -------------------------- */
const salarySchema = new Schema({
  teacher: { type: ObjectId, ref: 'Teacher', required: true },
  period: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
  baseSalary: money,
  bonus: money,
  deductions: money,
  amount: { ...money, required: true, min: 1 }, // net paid
  method: { type: String, maxlength: 60 },
  reference: { type: String, maxlength: 120 },
  paymentDate: { type: Date, required: true },
  expense: { type: ObjectId, ref: 'Expense' },
  status: { type: String, enum: ['paid', 'cancelled'], default: 'paid' },
  salaryKey: String, // "<teacherId>:<period>" while live — one salary payment per teacher per month
  notes: { type: String, maxlength: 300 },
  recordedBy: { type: ObjectId, ref: 'SchoolUser' },
  recordedByName: String,
  cancelled: cancellation,
}, { timestamps: true });
salarySchema.plugin(tenantPlugin);
salarySchema.index({ tenantId: 1, salaryKey: 1 }, { unique: true, partialFilterExpression: { salaryKey: { $type: 'string' } } });
salarySchema.index({ tenantId: 1, teacher: 1, period: -1 });
salarySchema.index({ tenantId: 1, period: 1 });

module.exports = {
  StudentInvoice: mongoose.model('StudentInvoice', invoiceSchema),
  StudentPayment: mongoose.model('StudentPayment', paymentSchema),
  PaymentAllocation: mongoose.model('PaymentAllocation', allocationSchema),
  StudentReceipt: mongoose.model('StudentReceipt', receiptSchema),
  ExpenseCategory: mongoose.model('ExpenseCategory', expenseCategorySchema),
  Expense: mongoose.model('Expense', expenseSchema),
  TeacherSalaryPayment: mongoose.model('TeacherSalaryPayment', salarySchema),
};
