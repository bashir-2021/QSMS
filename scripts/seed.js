'use strict';
/**
 * Development seed: realistic sample data for two schools plus platform staff and plans.
 * Every record is created through the same services the app uses, so balances, receipts,
 * numbering and audit logs are all consistent.
 *
 *   npm run seed            (refuses to run if data exists)
 *   npm run seed -- --reset (DROPS the database first — development only)
 */
const mongoose = require('mongoose');
const config = require('../config');
const db = require('../config/db');
const M = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const money = require('../utils/money');
const { hashPassword } = require('../services/authService');
const tenantService = require('../services/tenantService');
const subscriptionService = require('../services/subscriptionService');
const studentService = require('../services/studentService');
const teacherService = require('../services/teacherService');
const classService = require('../services/classService');
const billing = require('../services/billingService');
const payments = require('../services/paymentService');
const expenses = require('../services/expenseService');
const lessonService = require('../services/lessonService');
const activityService = require('../services/activityService');
const attendanceService = require('../services/attendanceService');
const tenantContext = require('../utils/tenantContext');

// deterministic pseudo-random numbers so every seed looks the same
let state = 20261101;
const rand = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const BOYS = ['Abdirahman', 'Mohamed', 'Ahmed', 'Abdullahi', 'Hassan', 'Yusuf', 'Ibrahim', 'Omar', 'Ali', 'Hamza', 'Bilal', 'Khalid', 'Ismail', 'Zakariye', 'Abdiaziz', 'Mustafe'];
const GIRLS = ['Fatima', 'Aisha', 'Hodan', 'Sagal', 'Ifrah', 'Maryan', 'Khadija', 'Asma', 'Hafsa', 'Sumaya', 'Nasra', 'Ruqiya', 'Hibo', 'Ayaan', 'Ubah', 'Zamzam'];
const FATHERS = ['Abdi', 'Farah', 'Warsame', 'Jama', 'Nur', 'Osman', 'Aden', 'Hersi', 'Elmi', 'Gedi', 'Samatar', 'Dahir', 'Ismail', 'Yasin', 'Hirsi', 'Mohamud'];

async function ctxFor(tenantId) {
  const [tenant, user, settings] = await Promise.all([
    M.Tenant.findById(tenantId).lean(),
    M.SchoolUser.findOne({ tenantId, role: 'school_admin' }).lean(),
    M.SchoolSettings.findOne({ tenantId }).lean(),
  ]);
  const subscription = await M.Subscription.findById(tenant.currentSubscription).lean();
  const ctx = { tenantId: tenant._id, tenant, user, settings, subscription };
  const req = { tenantId: tenant._id, user, ip: '127.0.0.1' };
  return { ctx, req };
}

async function seedPlatform() {
  const pass = await hashPassword(process.env.SUPERADMIN_PASSWORD || 'ChangeMe!2026');
  await M.PlatformUser.create([
    { name: process.env.SUPERADMIN_NAME || 'Platform Owner', email: (process.env.SUPERADMIN_EMAIL || 'admin@quranic.app').toLowerCase(), passwordHash: pass, role: 'super_admin' },
    { name: 'Faadumo Hassan', email: 'finance@quranic.app', passwordHash: pass, role: 'finance_officer' },
    { name: 'Abdiqani Yusuf', email: 'support@quranic.app', passwordHash: pass, role: 'support_officer' },
  ]);
  const all = Object.keys(C.PLAN_FEATURES);
  return M.SubscriptionPlan.create([
    { name: 'Basic', code: 'basic', description: 'For small dugsi getting organised.', price: 1500, billingCycle: 'monthly', limits: { students: 60, teachers: 4, classes: 4, users: 2 }, features: ['students', 'teachers', 'classes', 'attendance', 'finance'], trialDays: 14, graceDays: 5, sortOrder: 1 },
    { name: 'Standard', code: 'standard', description: 'Academic tracking and full finance.', price: 3500, billingCycle: 'monthly', limits: { students: 200, teachers: 12, classes: 12, users: 6 }, features: all.filter((f) => f !== 'exports'), trialDays: 14, graceDays: 7, sortOrder: 2 },
    { name: 'Premium', code: 'premium', description: 'Everything, including PDF & Excel exports.', price: 6000, billingCycle: 'monthly', limits: { students: 600, teachers: 40, classes: 40, users: 20 }, features: all, trialDays: 14, graceDays: 7, sortOrder: 3 },
    { name: 'Enterprise', code: 'enterprise', description: 'Networks of schools — billed annually.', price: 120000, billingCycle: 'annual', limits: { students: 0, teachers: 0, classes: 0, users: 0 }, features: all, trialDays: 0, graceDays: 14, sortOrder: 4 },
  ]);
}

async function seedSchool({ name, city, email, plan, verifyPaid, classDefs, teacherDefs, studentsPerClass, staff }) {
  const { tenant, admin } = await tenantService.registerSchool({
    schoolName: name, country: 'Somalia', city, address: `${city} — Main Road`, adminName: staff.admin,
    phone: '+252 61 555 0100', email, planId: plan._id, password: 'School!2026',
  });

  // pay & verify the subscription so the school is active on the paid plan
  if (verifyPaid) {
    const superAdmin = await M.PlatformUser.findOne({ role: 'super_admin' });
    const p = await subscriptionService.submitPayment(tenant._id, { planId: plan._id, periods: 3, method: 'mobile_money', transactionRef: `EVC${Math.floor(rand() * 1e8)}`, payerName: staff.admin, paidAt: dates.toISODate(new Date()) }, { kind: 'school', userId: admin._id, name: staff.admin });
    await subscriptionService.verifyPayment(p._id, superAdmin, db.runInTransaction);
  }

  await M.SchoolSettings.updateOne({ tenantId: tenant._id }, { $set: { registrationFee: 1000, monthlyFee: 1500, currency: 'USD' } });
  // everything below runs inside the school's tenant scope, exactly like a web request
  return tenantContext.run(tenant._id, async () => {
  let { ctx, req } = await ctxFor(tenant._id);

  // extra staff accounts
  const pass = await hashPassword('School!2026');
  const slug = tenant.slug.split('-')[0];
  await M.SchoolUser.create([
    { tenantId: tenant._id, name: staff.finance, email: `finance@${slug}.so`, passwordHash: pass, role: 'finance_officer' },
    { tenantId: tenant._id, name: staff.reception, email: `reception@${slug}.so`, passwordHash: pass, role: 'receptionist' },
  ]);

  const teachers = [];
  for (const t of teacherDefs) {
    teachers.push(await teacherService.create(ctx, { ...t, employmentDate: '2024-09-01', status: 'active' }));
  }
  // teacher login linked to the first teacher profile
  await M.SchoolUser.create({ tenantId: tenant._id, name: teachers[0].fullName, email: `teacher@${slug}.so`, passwordHash: pass, role: 'teacher', teacher: teachers[0]._id });

  const classes = [];
  for (let i = 0; i < classDefs.length; i += 1) {
    classes.push(await classService.create(ctx, { ...classDefs[i], teacher: String(teachers[i % teachers.length]._id), isActive: 'on', startDate: '2026-01-10' }));
  }

  ({ ctx, req } = await ctxFor(tenant._id));
  const students = [];
  for (const cls of classes) {
    for (let i = 0; i < studentsPerClass; i += 1) {
      const female = rand() < 0.45;
      const first = female ? pick(GIRLS) : pick(BOYS);
      const father = pick(FATHERS);
      const year = 2010 + Math.floor(rand() * 9);
      const regDate = dates.toISODate(dates.addDays(new Date(), -Math.floor(60 + rand() * 200)));
      students.push(await studentService.create(ctx, {
        fullName: `${first} ${father} ${pick(FATHERS)}`, gender: female ? 'female' : 'male', dateOfBirth: `${year}-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`,
        guardianName: `${father} ${pick(FATHERS)}`, guardianRelation: 'Father', guardianPhone: `+252 61 ${String(1000000 + Math.floor(rand() * 8999999))}`,
        address: `${city}, ${pick(['Hodan', 'Wadajir', 'Waberi', 'Yaqshid', 'Hamar Weyne', 'Kaaraan'])}`, registrationDate: regDate,
        class: String(cls._id), chargeRegistration: true,
      }));
    }
  }

  // monthly billing for the last 3 months, then payments (some partial, some unpaid)
  for (const period of dates.lastPeriods(3)) await billing.generateMonthly(ctx, period);
  const methods = ctx.settings.paymentMethods;
  for (const s of students) {
    const due = await billing.studentOutstanding(ctx.tenantId, s._id);
    const roll = rand();
    let amount = 0;
    if (roll < 0.55) amount = due; // fully paid
    else if (roll < 0.85) amount = Math.max(500, Math.floor((due * (0.3 + rand() * 0.4)) / 100) * 100); // partial
    if (amount > 0 && amount <= due) {
      await payments.record(ctx, req, {
        student: String(s._id), amount: money.toDecimalString(amount), method: pick(methods),
        transactionRef: `TX${Math.floor(rand() * 1e9)}`, paymentDate: dates.toISODate(dates.addDays(new Date(), -Math.floor(rand() * 40))),
      });
    }
  }

  // expenses for the last 3 months + teacher salaries
  const cats = Object.fromEntries((await M.ExpenseCategory.find({ tenantId: tenant._id }).lean()).map((c) => [c.name, c]));
  const monthly = [['School rent', 'Monthly rent', 40000, 'Landlord — Xamar Properties'], ['Electricity', 'Electricity bill', 6500, 'BECO'], ['Internet', 'Fibre internet', 3500, 'Hormuud Telecom'], ['Water', 'Water supply', 1800, 'Water Agency']];
  for (const [i, period] of dates.lastPeriods(3).entries()) {
    const { start } = dates.periodRange(period);
    const day = dates.addDays(start, 4);
    for (const [cat, desc, amt, recipient] of monthly) {
      const isLast = i === 2;
      await expenses.create(ctx, req, {
        category: String(cats[cat]._id), description: `${desc} — ${dates.periodLabel(period)}`, amount: money.toDecimalString(amt),
        expenseDate: dates.toISODate(day > new Date() ? new Date() : day), method: 'Bank transfer', recipient,
        recurring: isLast && cat === 'School rent' ? 'on' : undefined, frequency: 'monthly',
      });
    }
    await expenses.create(ctx, req, { category: String(cats['Teaching materials']._id), description: 'Mushafs and writing boards (lox)', amount: money.toDecimalString(4500 + Math.floor(rand() * 5000)), expenseDate: dates.toISODate(day > new Date() ? new Date() : day), method: 'Cash', recipient: 'Maktabadda Al-Furqan' });
    if (i < 2) {
      for (const t of teachers) {
        await expenses.paySalary(ctx, req, { teacher: String(t._id), period, baseSalary: money.toDecimalString(t.monthlySalary), paymentDate: dates.toISODate(dates.addDays(dates.periodRange(period).end, -1)), method: 'EVC Plus' });
      }
    }
  }

  // attendance: last 10 school days for students and teachers
  for (let d = 10; d >= 0; d -= 1) {
    const day = dates.addDays(dates.startOfDay(), -d);
    if (day.getUTCDay() === 5) continue; // Friday off
    const iso = dates.toISODate(day);
    for (const cls of classes) {
      const roster = await M.Student.find({ tenantId: tenant._id, class: cls._id, status: 'active' }).select('_id').lean();
      const att = {};
      roster.forEach((s) => { const r = rand(); att[String(s._id)] = { status: r < 0.82 ? 'present' : r < 0.9 ? 'late' : r < 0.96 ? 'absent' : 'excused' }; });
      await attendanceService.saveStudentSheet(ctx, String(cls._id), iso, att);
    }
    const tatt = {};
    teachers.forEach((t) => { tatt[String(t._id)] = { status: rand() < 0.92 ? 'present' : 'late', checkIn: '07:30', checkOut: '12:30' }; });
    await attendanceService.saveTeacherSheet(ctx, iso, tatt);
  }

  // lessons with per-student progress
  const lessonPlan = [['hifz', 67, 1, 10, 'Hifz — Surah Al-Mulk 1–10'], ['murajaah', 78, 1, 20, "Muraja'ah — Surah An-Naba 1–20"], ['tajweed', 1, 1, 7, 'Tajweed — rules of noon sakinah in Al-Fatihah'], ['reading', 36, 1, 12, 'Reading — Surah Ya-Sin 1–12'], ['islamic_studies', null, null, null, 'Pillars of Islam'], ['arabic', null, null, null, 'Arabic letters and harakat']];
  for (const cls of classes) {
    for (let i = 0; i < lessonPlan.length; i += 1) {
      const [category, surah, from, to, title] = lessonPlan[i];
      const lesson = await lessonService.create(ctx, {
        title, category, class: String(cls._id), date: dates.toISODate(dates.addDays(new Date(), -(i * 2 + 1))),
        surah: surah || '', fromVerse: from || '', toVerse: to || '', status: i < 4 ? 'completed' : 'in_progress',
        objectives: 'Accurate recitation with correct makharij and fluent memorisation.',
      });
      const roster = await M.Student.find({ tenantId: tenant._id, class: cls._id, status: 'active' }).select('_id').lean();
      const rows = {};
      roster.forEach((s) => {
        const score = Math.floor(55 + rand() * 45);
        rows[String(s._id)] = { score: String(score), performance: score >= 90 ? 'excellent' : score >= 80 ? 'very_good' : score >= 70 ? 'good' : score >= 60 ? 'fair' : 'needs_improvement', completed: score >= 70 ? 'on' : undefined, remarks: score < 60 ? 'Needs more revision at home' : '' };
      });
      await lessonService.saveProgress(ctx, String(lesson._id), rows);
    }
    // one Subac and one Duruus session per class
    for (const type of ['subac', 'duruus']) {
      const a = await activityService.create(ctx, type, {
        title: type === 'subac' ? 'Weekly Subac — Juz Amma review' : 'Dars — Manners of the student of knowledge',
        date: dates.toISODate(dates.addDays(new Date(), -3)), class: String(cls._id),
        topic: type === 'subac' ? 'Surahs An-Naba to An-Nas' : 'Adab al-talib', objectives: 'Strengthen retention and character.',
        evaluation: 'Most students recited fluently; three need follow-up.',
      });
      const parts = await M.ActivityParticipation.find({ tenantId: tenant._id, activity: a._id }).lean();
      const rows = {};
      parts.forEach((p) => { const sc = Math.floor(60 + rand() * 40); rows[String(p.student)] = { attendance: rand() < 0.9 ? 'present' : 'absent', score: String(sc), performance: sc >= 85 ? 'very_good' : sc >= 70 ? 'good' : 'fair' }; });
      await activityService.saveParticipation(ctx, type, String(a._id), rows);
    }
  }
  return { tenant, email };
  });
}

async function main() {
  await db.connect();
  const reset = process.argv.includes('--reset');
  if (reset) {
    if (config.isProd) throw new Error('Refusing to reset a production database.');
    await mongoose.connection.dropDatabase();
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  } else if (await M.PlatformUser.exists({})) {
    console.log('Database already has data. Use `npm run seed -- --reset` to start over (development only).');
    return;
  }

  const plans = await seedPlatform();
  const premium = plans.find((p) => p.code === 'premium');
  const standard = plans.find((p) => p.code === 'standard');

  const a = await seedSchool({
    name: 'Al-Noor Quran Centre', city: 'Mogadishu', email: 'admin@alnoor.so', plan: premium, verifyPaid: true, studentsPerClass: 9,
    staff: { admin: 'Sheikh Abdullahi Warsame', finance: 'Hodan Ali', reception: 'Nasra Omar' },
    teacherDefs: [
      { fullName: 'Ustaad Hassan Jama', gender: 'male', phone: '+252 61 700 1001', qualification: 'Hafiz · Ijazah in Hafs', specialization: 'Hifz', monthlySalary: '350' },
      { fullName: 'Macallin Ahmed Nur', gender: 'male', phone: '+252 61 700 1002', qualification: 'BA Islamic Studies', specialization: 'Tajweed', monthlySalary: '300' },
      { fullName: 'Macallimad Khadija Osman', gender: 'female', phone: '+252 61 700 1003', qualification: 'Hafiza', specialization: "Muraja'ah", monthlySalary: '300' },
    ],
    classDefs: [
      { name: 'Hifz Group A', level: 'Hifz', capacity: 20, monthlyFee: '20', days: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed'], startTime: '07:00', endTime: '11:00', room: 'Room 1' },
      { name: 'Tajweed Intermediate', level: 'Intermediate', capacity: 25, monthlyFee: '', days: ['Sat', 'Mon', 'Wed'], startTime: '14:00', endTime: '16:00', room: 'Room 2' },
      { name: 'Juz Amma Beginners', level: 'Beginner', capacity: 30, monthlyFee: '12', days: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu'], startTime: '16:00', endTime: '17:30', room: 'Hall' },
    ],
  });

  const b = await seedSchool({
    name: 'Darul Huda Madrasa', city: 'Hargeisa', email: 'admin@darulhuda.so', plan: standard, verifyPaid: false, studentsPerClass: 6,
    staff: { admin: 'Ustaad Ibrahim Elmi', finance: 'Sagal Farah', reception: 'Ayaan Dahir' },
    teacherDefs: [
      { fullName: 'Sheikh Yasin Gedi', gender: 'male', phone: '+252 63 400 2001', qualification: 'Hafiz', specialization: 'Hifz', monthlySalary: '250' },
      { fullName: 'Macallimad Asma Hirsi', gender: 'female', phone: '+252 63 400 2002', qualification: 'Diploma Arabic', specialization: 'Arabic', monthlySalary: '220' },
    ],
    classDefs: [
      { name: 'Hifz Morning', level: 'Hifz', capacity: 15, monthlyFee: '18', days: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed'], startTime: '06:30', endTime: '10:00' },
      { name: 'Qaida & Reading', level: 'Beginner', capacity: 25, monthlyFee: '', days: ['Sat', 'Mon', 'Wed'], startTime: '15:00', endTime: '17:00' },
    ],
  });

  // a pending subscription payment for the platform finance team to verify
  const adminB = await M.SchoolUser.findOne({ tenantId: b.tenant._id, role: 'school_admin' }).lean();
  await subscriptionService.submitPayment(b.tenant._id, { planId: standard._id, periods: 1, method: 'mobile_money', transactionRef: 'ZAAD88231904', payerName: 'Ustaad Ibrahim Elmi', paidAt: dates.toISODate(new Date()) }, { kind: 'school', userId: adminB._id, name: adminB.name });

  console.log('\nSeed complete.\n');
  console.log('Platform console  /platform/login');
  console.log(`  super admin     ${(process.env.SUPERADMIN_EMAIL || 'admin@quranic.app').toLowerCase()} / ${process.env.SUPERADMIN_PASSWORD || 'ChangeMe!2026'}`);
  console.log('  finance         finance@quranic.app (same password)');
  console.log('  support         support@quranic.app (same password)');
  console.log('School login      /login   (password School!2026 for every school user)');
  for (const s of [a, b]) {
    const slug = s.tenant.slug.split('-')[0];
    console.log(`  ${s.tenant.name.padEnd(22)} ${s.email}, finance@${slug}.so, reception@${slug}.so, teacher@${slug}.so`);
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.disconnect());
