'use strict';
const { Student, Teacher, Class, StudentInvoice, PaymentAllocation, StudentPayment, Lesson } = require('../models');
const dates = require('../utils/dates');
const reports = require('./reportService');
const attendance = require('./attendanceService');
const expenseService = require('./expenseService');

/** All dashboard numbers are computed live from the database — nothing is hard-coded. */
async function school(tenantId) {
  const period = dates.currentPeriod();
  const { start, end } = dates.periodRange(period);
  const sixMonthsAgo = dates.periodRange(dates.lastPeriods(6)[0]).start;

  const [
    totalStudents, activeStudents, totalTeachers, activeTeachers, totalClasses,
    incomeByType, monthIncome, monthExpenses, outstandingAgg, overdueCount, trend, today,
    recentPayments, recentLessons, dueRecurring, genderAgg,
  ] = await Promise.all([
    Student.countDocuments({ tenantId }),
    Student.countDocuments({ tenantId, status: 'active' }),
    Teacher.countDocuments({ tenantId }),
    Teacher.countDocuments({ tenantId, status: 'active' }),
    Class.countDocuments({ tenantId, isActive: true }),
    PaymentAllocation.aggregate([
      { $match: { tenantId, status: 'active', paymentDate: { $gte: start, $lte: end } } },
      { $group: { _id: '$invoiceType', v: { $sum: '$amount' } } },
    ]),
    reports.incomeTotal(tenantId, start, end),
    reports.expenseTotal(tenantId, start, end),
    StudentInvoice.aggregate([
      { $match: { tenantId, status: { $in: ['unpaid', 'partial', 'overdue'] } } },
      { $group: { _id: null, v: { $sum: { $subtract: ['$total', '$paid'] } }, students: { $addToSet: '$student' } } },
    ]),
    StudentInvoice.countDocuments({ tenantId, status: 'overdue' }),
    reports.series(tenantId, sixMonthsAgo, end, '%Y-%m'),
    attendance.today(tenantId),
    StudentPayment.find({ tenantId }).sort({ createdAt: -1 }).limit(6).populate('student', 'fullName studentCode').populate('receipt', 'receiptNo').lean(),
    Lesson.find({ tenantId }).sort({ date: -1, createdAt: -1 }).limit(5).populate('class', 'name').lean(),
    expenseService.dueRecurring(tenantId),
    Student.aggregate([{ $match: { tenantId, status: 'active' } }, { $group: { _id: '$gender', n: { $sum: 1 } } }]),
  ]);

  const byType = Object.fromEntries(incomeByType.map((x) => [x._id, x.v]));
  const months = dates.lastPeriods(6);
  const trendFull = months.map((p) => trend.find((t) => t.key === p) || { key: p, income: 0, expenses: 0, net: 0 });

  return {
    period,
    counts: { totalStudents, activeStudents, totalTeachers, activeTeachers, totalClasses },
    finance: {
      monthlyFees: byType.monthly || 0,
      registrationFees: byType.registration || 0,
      otherIncome: byType.other || 0,
      income: monthIncome.total,
      expenses: monthExpenses.total,
      net: monthIncome.total - monthExpenses.total,
      outstanding: outstandingAgg[0] ? outstandingAgg[0].v : 0,
      studentsOwing: outstandingAgg[0] ? outstandingAgg[0].students.length : 0,
      overdueCount,
    },
    today,
    chart: {
      labels: trendFull.map((t) => dates.periodLabel(t.key).slice(0, 3)),
      income: trendFull.map((t) => t.income),
      expenses: trendFull.map((t) => t.expenses),
    },
    gender: Object.fromEntries(genderAgg.map((g) => [g._id, g.n])),
    recentPayments, recentLessons, dueRecurring,
  };
}

module.exports = { school };
