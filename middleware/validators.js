'use strict';
/** express-validator chains for every form. Sanitisers trim/escape-free (EJS escapes output). */
const { body } = require('express-validator');
const C = require('../config/constants');

/**
 * Translated message: m('{label} is required', 'Full name') is rendered in the request language.
 * `lower` lowercases the English label inside a sentence ("Enter a valid guardian phone").
 */
const m = (key, label, { lower = false } = {}) => (value, { req }) => {
  const t = req.t || ((s, v) => (v ? s.replace(/\{(\w+)\}/g, (x, k) => v[k]) : s));
  if (label === undefined) return t(key);
  const l = t(label);
  return t(key, { label: lower && l === label ? label.toLowerCase() : l });
};

const text = (field, label, { max = 120, required = true } = {}) => {
  const c = body(field).trim();
  return required
    ? c.notEmpty().withMessage(m('{label} is required', label)).bail().isLength({ max }).withMessage(m('{label} is too long', label))
    : c.optional({ values: 'falsy' }).isLength({ max }).withMessage(m('{label} is too long', label));
};
const email = (field = 'email', required = true) => {
  const c = body(field).trim();
  return (required ? c.notEmpty().withMessage(m('Email is required')).bail() : c.optional({ values: 'falsy' }))
    .isEmail().withMessage(m('Enter a valid email address')).normalizeEmail({ gmail_remove_dots: false });
};
const phone = (field, label = 'Phone', required = false) => {
  const c = body(field).trim();
  return (required ? c.notEmpty().withMessage(m('{label} is required', label)).bail() : c.optional({ values: 'falsy' }))
    .matches(/^[+\d][\d\s-]{5,20}$/).withMessage(m('Enter a valid {label}', label, { lower: true }));
};
const amount = (field, label, { required = true } = {}) => {
  const c = body(field).trim();
  return (required ? c.notEmpty().withMessage(m('{label} is required', label)).bail() : c.optional({ values: 'falsy' }))
    .matches(/^\d{1,9}([.]\d{1,2})?$/).withMessage(m('{label} must be a valid amount (e.g. 25 or 25.50)', label));
};
const date = (field, label, required = false) => {
  const c = body(field).trim();
  return (required ? c.notEmpty().withMessage(m('{label} is required', label)).bail() : c.optional({ values: 'falsy' }))
    .isISO8601().withMessage(m('{label} must be a valid date', label));
};
const objectId = (field, label, required = true) => {
  const c = body(field).trim();
  return (required ? c.notEmpty().withMessage(m('{label} is required', label)).bail() : c.optional({ values: 'falsy' }))
    .isMongoId().withMessage(m('Choose a valid {label}', label, { lower: true }));
};
const password = (field = 'password', required = true) => {
  const c = body(field);
  return (required ? c.notEmpty().withMessage(m('Password is required')).bail() : c.optional({ values: 'falsy' }))
    .isLength({ min: 8, max: 128 }).withMessage(m('Password must be at least 8 characters'))
    .matches(/[A-Za-z]/).withMessage(m('Password must contain a letter'))
    .matches(/\d/).withMessage(m('Password must contain a number'));
};
const confirm = (field = 'confirmPassword', of = 'password') => body(field).custom((v, { req }) => {
  if ((req.body[of] || '') !== (v || '')) throw new Error(req.t ? req.t('Passwords do not match') : 'Passwords do not match');
  return true;
});
const oneOf = (field, list, label, required = true) => {
  const c = body(field);
  return (required ? c.notEmpty().withMessage(m('{label} is required', label)).bail() : c.optional({ values: 'falsy' }))
    .isIn(list).withMessage(m('Choose a valid {label}', label, { lower: true }));
};
const period = (field, label = 'Month') => body(field).trim().matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage(m('{label} is required (YYYY-MM)', label));

module.exports = {
  login: [email(), body('password').notEmpty().withMessage('Password is required')],
  register: [
    text('schoolName', 'School name', { max: 160 }), text('country', 'Country', { max: 80 }), text('city', 'City', { max: 80 }),
    text('address', 'Address', { max: 300, required: false }), text('adminName', 'Administrator name'),
    phone('phone', 'Phone', true), email(), objectId('planId', 'Subscription plan'), password(), confirm(),
    body('terms').equals('on').withMessage('You must accept the terms'),
  ],
  changePassword: [body('currentPassword').notEmpty().withMessage('Current password is required'), password('newPassword'), confirm('confirmPassword', 'newPassword')],
  contact: [text('name', 'Name'), email(), text('message', 'Message', { max: 2000 })],

  student: [
    text('fullName', 'Full name'), oneOf('gender', C.GENDERS, 'Gender'), date('dateOfBirth', 'Date of birth'),
    oneOf('program', Object.keys(C.STUDENT_PROGRAMS), 'Quran category'),
    text('guardianName', 'Guardian name', { required: false }), phone('guardianPhone', 'Guardian phone'),
    text('motherName', 'Mother name', { required: false }), text('district', 'District', { max: 80, required: false }),
    text('address', 'Address', { max: 300, required: false }), date('registrationDate', 'Registration date'),
    objectId('class', 'Class', false), objectId('teacher', 'Teacher', false), oneOf('status', C.STUDENT_STATUSES, 'Status', false),
    amount('feeOverride', 'Custom monthly fee', { required: false }), text('notes', 'Notes', { max: 500, required: false }),
    amount('registrationFee', 'Registration fee', { required: false }), text('paymentMethod', 'Payment method', { max: 60, required: false }),
    text('transactionRef', 'Transaction reference', { required: false }),
  ],
  teacher: [
    text('fullName', 'Full name'), oneOf('gender', C.GENDERS, 'Gender', false), phone('phone', 'Phone', true), email('email', false),
    text('qualification', 'Qualification', { max: 160, required: false }), text('specialization', 'Specialization', { max: 160, required: false }),
    date('employmentDate', 'Employment date'), amount('monthlySalary', 'Monthly salary', { required: false }),
    oneOf('status', C.TEACHER_STATUSES, 'Status', false),
  ],
  class: [
    text('name', 'Class name', { max: 80 }), oneOf('level', C.CLASS_LEVELS, 'Level'), objectId('teacher', 'Teacher', false),
    body('capacity').isInt({ min: 1, max: 500 }).withMessage('Capacity must be between 1 and 500'),
    amount('monthlyFee', 'Monthly fee', { required: false }), date('startDate', 'Start date'), date('endDate', 'End date'),
    body('startTime').optional({ values: 'falsy' }).matches(/^\d{2}:\d{2}$/).withMessage('Invalid start time'),
    body('endTime').optional({ values: 'falsy' }).matches(/^\d{2}:\d{2}$/).withMessage('Invalid end time'),
  ],
  shift: [
    text('name', 'Shift name', { max: 60 }),
    body('startTime').optional({ values: 'falsy' }).matches(/^\d{2}:\d{2}$/).withMessage('Invalid start time'),
    body('endTime').optional({ values: 'falsy' }).matches(/^\d{2}:\d{2}$/).withMessage('Invalid end time'),
  ],
  studentLesson: [
    objectId('student', 'Student'), date('assignedDate', 'Date', true), text('topic', 'Topic', { max: 200, required: false }),
    body('surah').optional({ values: 'falsy' }).isInt({ min: 1, max: 114 }).withMessage('Choose a valid surah'),
    body('fromVerse').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Invalid verse'),
    body('toVerse').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Invalid verse'),
    body('juz').optional({ values: 'falsy' }).isInt({ min: 1, max: 30 }).withMessage('Juz must be between 1 and 30'),
  ],
  lessonReview: [oneOf('grade', Object.keys(C.STUDENT_LESSON_GRADES), 'Grade'), text('remarks', 'Remarks', { max: 500, required: false })],
  lesson: [
    text('title', 'Title', { max: 160 }), oneOf('category', Object.keys(C.LESSON_CATEGORIES), 'Category'),
    objectId('class', 'Class'), date('date', 'Date', true), oneOf('status', C.LESSON_STATUSES, 'Status'),
    body('surah').optional({ values: 'falsy' }).isInt({ min: 1, max: 114 }).withMessage('Choose a valid surah'),
    body('fromVerse').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Invalid verse'),
    body('toVerse').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Invalid verse'),
  ],
  activity: [text('title', 'Title', { max: 160 }), objectId('class', 'Class'), date('date', 'Date', true), text('topic', 'Topic', { max: 300, required: false }), oneOf('frequency', C.SUBAC_FREQUENCIES, 'Frequency', false)],
  subacDeductions: Object.keys(C.SUBAC_DEDUCTIONS).map((key) => body(key).isFloat({ min: 0, max: 100 }).withMessage(m('Deduction points must be between 0 and 100.'))),
  invoice: [
    objectId('student', 'Student'), oneOf('type', Object.keys(C.INVOICE_TYPES), 'Invoice type'), amount('amount', 'Amount'),
    text('description', 'Description', { max: 300, required: false }), date('dueDate', 'Due date'),
  ],
  generate: [period('period', 'Billing month'), objectId('class', 'Class', false)],
  adjust: [amount('discount', 'Discount', { required: false }), body('adjustment').optional({ values: 'falsy' }).matches(/^-?\d{1,9}([.]\d{1,2})?$/).withMessage('Adjustment must be an amount (use - for a credit)'), text('reason', 'Reason', { max: 300 })],
  reason: [text('reason', 'Reason', { max: 300 })],
  payment: [objectId('student', 'Student'), amount('amount', 'Amount'), text('method', 'Payment method', { max: 60 }), date('paymentDate', 'Payment date', true), text('transactionRef', 'Transaction reference', { required: false })],
  expense: [objectId('category', 'Category'), text('description', 'Description', { max: 300 }), amount('amount', 'Amount'), date('expenseDate', 'Date', true), text('recipient', 'Recipient', { required: false }), text('reference', 'Reference', { required: false })],
  expenseEdit: [text('description', 'Description', { max: 300 }), text('recipient', 'Recipient', { required: false }), text('reference', 'Reference', { required: false })],
  salary: [objectId('teacher', 'Teacher'), period('period', 'Salary month'), amount('baseSalary', 'Base salary'), amount('bonus', 'Bonus', { required: false }), amount('deductions', 'Deductions', { required: false }), date('paymentDate', 'Payment date', true)],
  schoolUser: (isNew) => [text('name', 'Name'), email(), phone('phone'), oneOf('role', ['school_admin', 'finance_officer', 'teacher', 'receptionist'], 'Role'), password('password', isNew), objectId('teacher', 'Teacher profile', false)],
  platformUser: (isNew) => [text('name', 'Name'), email(), phone('phone'), oneOf('role', ['super_admin', 'finance_officer', 'support_officer'], 'Role'), password('password', isNew)],
  settings: [text('academicYear', 'Academic year', { max: 20 }), body('currency').trim().isLength({ min: 3, max: 3 }).withMessage('Currency must be a 3-letter code').isAlpha(), amount('registrationFee', 'Registration fee'), amount('monthlyFee', 'Monthly fee'), body('billingDueDay').isInt({ min: 1, max: 28 }).withMessage('Due day must be 1–28'), text('paymentMethods', 'Payment methods', { max: 600 })],
  profile: [text('name', 'School name', { max: 160 }), text('country', 'Country', { max: 80, required: false }), text('city', 'City', { max: 80, required: false }), phone('phone'), email('email', false)],
  category: [text('name', 'Name', { max: 80 }), text('description', 'Description', { max: 300, required: false })],
  plan: [text('name', 'Plan name', { max: 60 }), amount('price', 'Price'), oneOf('billingCycle', Object.keys(C.BILLING_CYCLES), 'Billing cycle'), body('currency').trim().isLength({ min: 3, max: 3 }).withMessage('Currency must be a 3-letter code')],
  subscriptionPayment: [objectId('planId', 'Plan'), body('periods').isInt({ min: 1, max: 24 }).withMessage('Periods must be 1–24'), oneOf('method', C.PLATFORM_PAYMENT_METHODS, 'Method'), text('transactionRef', 'Transaction reference', { max: 120 }), date('paidAt', 'Payment date', true)],
};
