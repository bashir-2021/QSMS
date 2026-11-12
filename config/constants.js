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
  // A class is at one of the same three levels as the Quran categories of its students.
  CLASS_LEVELS: ['farbar', 'cashra', 'taxfiid'],
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
  /*
   * Student lessons. Each sitting follows one chain:
   * attendance -> lesson status -> warnings -> score -> hifz level -> result.
   */
  LESSON_ATTENDANCE: ['present', 'absent'],
  // What happened to the lesson at a sitting where the student was present.
  LESSON_STATUSES_HEARD: {
    pending: 'Not listened to yet',
    heard: 'Listened to',
    returned: 'Returned',
  },
  // The lesson record's own status: the three above, or "absent" for a day the student was away.
  STUDENT_LESSON_STATUSES: ['absent', 'pending', 'heard', 'returned'],
  // What the teacher can record when listening to a lesson the student was present for.
  LISTEN_STATUSES: ['heard', 'returned'],
  LESSON_RESULTS: {
    passed: 'Passed',
    repeat: 'Lesson to repeat',
    pending: 'Waiting to be listened to',
  },
  LESSON_SCORE_BASE: 100,
  // Defaults for a new school; each school manager changes them under School settings > Lesson rules.
  DEFAULT_LESSON_RULES: { maxWarnings: 3, pointsPerWarning: 5, returnBelowScore: 0 },
  DEFAULT_HIFZ_LEVELS: [
    { label: 'Very Good', min: 90 },
    { label: 'Good', min: 80 },
    { label: 'Average', min: 70 },
    { label: 'Weak', min: 60 },
    { label: 'Needs revision', min: 0 },
  ],
  DEFAULT_LESSON_TYPES: ['New lesson', 'Revision', 'Juz listening'],
  MAX_HIFZ_LEVELS: 10,
  MAX_LESSON_TYPES: 20,
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
  // A teacher's own check-in or check-out waits for the receptionist to approve the real times.
  TEACHER_ATTENDANCE_APPROVAL: ['pending', 'approved'],

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
