'use strict';

module.exports = {
  TENANT_STATUSES: ['active', 'inactive', 'suspended'],
  SUBSCRIPTION_STATUSES: ['trial', 'active', 'expiring_soon', 'expired', 'suspended', 'cancelled'],
  SUBSCRIPTION_PAYMENT_STATUSES: ['pending', 'paid', 'failed', 'cancelled', 'refunded'],
  BILLING_CYCLES: {
    monthly: { label: 'Monthly', months: 1 },
    quarterly: { label: 'Quarterly', months: 3 },
    six_months: { label: 'Six months', months: 6 },
    annual: { label: 'Annual', months: 12 },
    custom: { label: 'Custom (days)', months: 0 },
  },
  PLAN_FEATURES: {
    students: 'Student management',
    teachers: 'Teacher management',
    classes: 'Class management',
    attendance: 'Attendance',
    lessons: 'Quran lessons & progress',
    activities: 'Subac & Duruus activities',
    finance: 'Fees, billing & receipts',
    expenses: 'Expenses & salaries',
    reports: 'Financial & academic reports',
    exports: 'PDF & Excel exports',
  },
  PLATFORM_PAYMENT_METHODS: ['mobile_money', 'bank_transfer', 'cash', 'card', 'other'],

  STUDENT_STATUSES: ['active', 'inactive', 'graduated', 'suspended'],
  TEACHER_STATUSES: ['active', 'on_leave', 'resigned', 'terminated'],
  GENDERS: ['male', 'female'],
  // Every student studies in exactly one of the school's three categories.
  STUDENT_PROGRAMS: {
    farbar: 'Farbar (beginners, learning to write)',
    cashra: 'Cashra (a lesson every day)',
    taxfiid: 'Taxfiid (listening to verses or a juz every day)',
  },
  CLASS_LEVELS: ['Beginner', 'Elementary', 'Intermediate', 'Advanced', 'Hifz', 'Mixed'],
  WEEKDAYS: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'],

  LESSON_CATEGORIES: {
    hifz: 'Hifz (memorization)',
    reading: 'Quran reading',
    tajweed: 'Tajweed',
    murajaah: "Muraja'ah (revision)",
    islamic_studies: 'Islamic studies',
    arabic: 'Arabic',
  },
  LESSON_STATUSES: ['planned', 'in_progress', 'completed', 'cancelled'],
  PERFORMANCE_LEVELS: ['excellent', 'very_good', 'good', 'fair', 'needs_improvement'],
  // How a teacher grades a recited lesson. Only passing grades let the student move on.
  STUDENT_LESSON_GRADES: {
    excellent: { label: 'Excellent', score: 100, passed: true },
    very_good: { label: 'Very good', score: 85, passed: true },
    acceptable: { label: 'Acceptable', score: 70, passed: true },
    not_accepted: { label: 'Not accepted', score: 0, passed: false },
  },
  STUDENT_LESSON_STATUSES: ['assigned', 'returned', 'passed'],
  ACTIVITY_TYPES: { subac: 'Subac (سبع)', duruus: 'Duruus (دروس)' },
  SUBAC_FREQUENCIES: ['daily', 'one_time'],
  SUBAC_BASE_SCORE: 100,
  // Default points lost per occurrence; each school manager can change them in School Settings.
  SUBAC_DEDUCTIONS: {
    recall_prompt: { label: 'Recall prompts', points: 0.5 },
    opening_error: { label: 'Opening error', points: 1 },
    pronunciation_error: { label: 'Pronunciation error', points: 0.5 },
    tajweed_error: { label: 'Tajweed error', points: 0.5 },
    observation_error: { label: 'Observation error', points: 0.5 },
  },

  ATTENDANCE_STATUSES: ['present', 'absent', 'late', 'excused'],

  INVOICE_TYPES: { registration: 'Registration fee', monthly: 'Monthly fee', other: 'Other' },
  INVOICE_STATUSES: ['unpaid', 'partial', 'paid', 'overdue', 'cancelled'],
  DEFAULT_PAYMENT_METHODS: ['Cash', 'EVC Plus', 'Zaad', 'Sahal', 'eDahab', 'Bank transfer'],
  DEFAULT_EXPENSE_CATEGORIES: [
    'Teacher salaries', 'School rent', 'Internet', 'Electricity', 'Water', 'Teaching materials',
    'Cleaning and maintenance', 'Office supplies', 'Transportation', 'Student activities',
    'Equipment', 'Other expenses',
  ],
  SALARY_CATEGORY: 'Teacher salaries',
  // The full list of 114 surahs with verse counts lives in utils/quran.js
};
