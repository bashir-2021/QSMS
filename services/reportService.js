'use strict';
/**
 * School financial reports.
 *
 * Every report returns the same shape so one renderer handles HTML, PDF and Excel:
 *   { title, subtitle, summary: [{label, value, type}], sections: [{ title, columns, rows, totals }] }
 * Column types: text | money | date | number | percent | status
 *
 * Accounting basis (as required): income = confirmed student payments, expenses = recorded
 * expenses, net = income − expenses. Invoices only appear in billing/outstanding reports.
 */
const mongoose = require('mongoose');
const {
  StudentPayment, PaymentAllocation, Expense, StudentInvoice, TeacherSalaryPayment, Student, Class,
} = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const money = require('../utils/money');
const { owned } = require('./scope');

const REPORTS = {
  daily: 'Daily financial report',
  monthly: 'Monthly financial report',
  annual: 'Annual financial report',
  'student-payments': 'Student payment report',
  'registration-fees': 'Registration fee report',
  outstanding: 'Outstanding balance report',
  salaries: 'Teacher salary report',
  'expenses-by-category': 'Expense report by category',
  'income-expenditure': 'Income and expenditure report',
  'net-balance': 'Net balance report',
};

const INCOME_LABEL = { registration: 'Registration fees', monthly: 'Monthly fees', other: 'Other student payments' };

/* -------------------------------- Primitives ------------------------------ */

async function incomeTotal(tenantId, from, to) {
  const r = await StudentPayment.aggregate([
    { $match: { tenantId, status: 'confirmed', paymentDate: { $gte: from, $lte: to } } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  return r[0] || { total: 0, count: 0 };
}

async function expenseTotal(tenantId, from, to) {
  const r = await Expense.aggregate([
    { $match: { tenantId, status: 'recorded', expenseDate: { $gte: from, $lte: to } } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  return r[0] || { total: 0, count: 0 };
}

async function incomeByCategory(tenantId, from, to) {
  const r = await PaymentAllocation.aggregate([
    { $match: { tenantId, status: 'active', paymentDate: { $gte: from, $lte: to } } },
    { $group: { _id: '$invoiceType', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  return r.map((x) => ({ category: INCOME_LABEL[x._id] || x._id, amount: x.amount, count: x.count }))
    .sort((a, b) => b.amount - a.amount);
}

async function expensesByCategory(tenantId, from, to) {
  const r = await Expense.aggregate([
    { $match: { tenantId, status: 'recorded', expenseDate: { $gte: from, $lte: to } } },
    { $group: { _id: '$category', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $lookup: { from: 'expensecategories', localField: '_id', foreignField: '_id', as: 'cat' } },
  ]);
  return r.map((x) => ({ category: x.cat[0] ? x.cat[0].name : 'Uncategorised', amount: x.amount, count: x.count }))
    .sort((a, b) => b.amount - a.amount);
}

/** Group income and expenses by day (fmt %Y-%m-%d) or month (%Y-%m). */
async function series(tenantId, from, to, fmt) {
  const [inc, exp] = await Promise.all([
    StudentPayment.aggregate([
      { $match: { tenantId, status: 'confirmed', paymentDate: { $gte: from, $lte: to } } },
      { $group: { _id: { $dateToString: { format: fmt, date: '$paymentDate' } }, v: { $sum: '$amount' } } },
    ]),
    Expense.aggregate([
      { $match: { tenantId, status: 'recorded', expenseDate: { $gte: from, $lte: to } } },
      { $group: { _id: { $dateToString: { format: fmt, date: '$expenseDate' } }, v: { $sum: '$amount' } } },
    ]),
  ]);
  const map = {};
  inc.forEach((x) => { map[x._id] = { key: x._id, income: x.v, expenses: 0 }; });
  exp.forEach((x) => { map[x._id] = map[x._id] || { key: x._id, income: 0, expenses: 0 }; map[x._id].expenses = x.v; });
  return Object.values(map).sort((a, b) => a.key.localeCompare(b.key)).map((r) => ({ ...r, net: r.income - r.expenses }));
}

const summaryOf = (income, expenses) => [
  { label: 'Confirmed income', value: income, type: 'money' },
  { label: 'Expenses', value: expenses, type: 'money' },
  { label: 'Net balance', value: income - expenses, type: 'money' },
];

const CAT_COLUMNS = [
  { key: 'category', label: 'Category' }, { key: 'count', label: 'Transactions', type: 'number' },
  { key: 'amount', label: 'Amount', type: 'money' },
];
const catSection = (title, rows) => ({ title, columns: CAT_COLUMNS, rows, totals: { category: 'Total', count: money.sum(rows, 'count'), amount: money.sum(rows, 'amount') } });

/* --------------------------------- Reports -------------------------------- */

async function daily(tenantId, q) {
  const day = dates.parseDay(q.date) || dates.startOfDay();
  const from = day; const to = dates.endOfDay(day);
  const [payments, expenses] = await Promise.all([
    StudentPayment.find({ tenantId, status: 'confirmed', paymentDate: { $gte: from, $lte: to } }).populate('student', 'fullName studentCode').sort({ createdAt: 1 }).lean(),
    Expense.find({ tenantId, status: 'recorded', expenseDate: { $gte: from, $lte: to } }).populate('category', 'name').sort({ createdAt: 1 }).lean(),
  ]);
  const inc = money.sum(payments, 'amount');
  const exp = money.sum(expenses, 'amount');
  return {
    title: REPORTS.daily, subtitle: dates.formatDate(day), filters: { date: dates.toISODate(day) },
    summary: summaryOf(inc, exp),
    sections: [
      {
        title: 'Payments received',
        columns: [{ key: 'no', label: 'Payment #' }, { key: 'student', label: 'Student' }, { key: 'category', label: 'Category' }, { key: 'method', label: 'Method' }, { key: 'ref', label: 'Reference' }, { key: 'by', label: 'Received by' }, { key: 'amount', label: 'Amount', type: 'money' }],
        rows: payments.map((p) => ({ no: p.paymentNo, student: p.student ? `${p.student.fullName} (${p.student.studentCode})` : '—', category: p.category, method: p.method, ref: p.transactionRef || '', by: p.receivedByName, amount: p.amount })),
        totals: { no: 'Total', amount: inc },
      },
      {
        title: 'Expenses',
        columns: [{ key: 'no', label: 'Expense #' }, { key: 'category', label: 'Category' }, { key: 'description', label: 'Description' }, { key: 'recipient', label: 'Recipient' }, { key: 'amount', label: 'Amount', type: 'money' }],
        rows: expenses.map((e) => ({ no: e.expenseNo, category: e.category ? e.category.name : '', description: e.description, recipient: e.recipient || '', amount: e.amount })),
        totals: { no: 'Total', amount: exp },
      },
    ],
  };
}

async function monthly(tenantId, q) {
  const period = dates.isPeriod(q.month) ? q.month : dates.currentPeriod();
  const { start, end } = dates.periodRange(period);
  const [days, incCat, expCat, billed] = await Promise.all([
    series(tenantId, start, end, '%Y-%m-%d'),
    incomeByCategory(tenantId, start, end),
    expensesByCategory(tenantId, start, end),
    StudentInvoice.aggregate([
      { $match: { tenantId, type: 'monthly', period, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, total: { $sum: '$total' }, paid: { $sum: '$paid' }, n: { $sum: 1 } } },
    ]),
  ]);
  const inc = money.sum(days, 'income');
  const exp = money.sum(days, 'expenses');
  const b = billed[0] || { total: 0, paid: 0, n: 0 };
  return {
    title: REPORTS.monthly, subtitle: dates.periodLabel(period), filters: { month: period },
    summary: [...summaryOf(inc, exp),
      // labelKey/labelVars let the HTML view translate the interpolated label; exports keep using label.
      { label: `Monthly fees billed (${b.n} invoices)`, labelKey: b.n === 1 ? 'Monthly fees billed (1 invoice)' : 'Monthly fees billed ({n} invoices)', labelVars: { n: b.n }, value: b.total, type: 'money' },
      { label: 'Of which collected', value: b.paid, type: 'money' }],
    chart: { labels: days.map((d) => d.key.slice(8)), income: days.map((d) => d.income), expenses: days.map((d) => d.expenses) },
    sections: [
      {
        title: 'Daily breakdown',
        columns: [{ key: 'key', label: 'Date', type: 'date' }, { key: 'income', label: 'Income', type: 'money' }, { key: 'expenses', label: 'Expenses', type: 'money' }, { key: 'net', label: 'Net', type: 'money' }],
        rows: days, totals: { key: 'Total', income: inc, expenses: exp, net: inc - exp },
      },
      catSection('Income by category', incCat),
      catSection('Expenses by category', expCat),
    ],
  };
}

async function annual(tenantId, q) {
  const year = parseInt(q.year, 10) || new Date().getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1)); const end = new Date(Date.UTC(year + 1, 0, 1) - 1);
  const [months, incCat, expCat] = await Promise.all([
    series(tenantId, start, end, '%Y-%m'), incomeByCategory(tenantId, start, end), expensesByCategory(tenantId, start, end),
  ]);
  const full = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const m = months.find((x) => x.key === key) || { income: 0, expenses: 0, net: 0 };
    return { key, month: dates.periodLabel(key), income: m.income, expenses: m.expenses, net: m.net };
  });
  const inc = money.sum(full, 'income'); const exp = money.sum(full, 'expenses');
  return {
    title: REPORTS.annual, subtitle: String(year), filters: { year },
    summary: summaryOf(inc, exp),
    chart: { labels: full.map((m) => m.month.slice(0, 3)), income: full.map((m) => m.income), expenses: full.map((m) => m.expenses) },
    sections: [
      {
        title: 'Monthly breakdown',
        columns: [{ key: 'month', label: 'Month' }, { key: 'income', label: 'Income', type: 'money' }, { key: 'expenses', label: 'Expenses', type: 'money' }, { key: 'net', label: 'Net', type: 'money' }],
        rows: full, totals: { month: 'Total', income: inc, expenses: exp, net: inc - exp },
      },
      catSection('Income by category', incCat),
      catSection('Expenses by category', expCat),
    ],
  };
}

async function studentPayments(tenantId, q) {
  const r = dates.rangeFromQuery(q);
  const f = { tenantId, status: 'confirmed', paymentDate: { $gte: r.from, $lte: r.to } };
  if (q.method) f.method = String(q.method).slice(0, 60);
  if (q.class) {
    const cls = await owned(Class, tenantId, q.class, 'Class');
    f.student = { $in: (await Student.find({ tenantId, class: cls._id }).select('_id').lean()).map((s) => s._id) };
  }
  const payments = await StudentPayment.find(f).populate({ path: 'student', select: 'fullName studentCode class', populate: { path: 'class', select: 'name' } })
    .populate('receipt', 'receiptNo').sort({ paymentDate: 1, createdAt: 1 }).limit(10000).lean();
  const total = money.sum(payments, 'amount');
  const byMethod = {};
  payments.forEach((p) => { byMethod[p.method] = (byMethod[p.method] || 0) + p.amount; });
  return {
    title: REPORTS['student-payments'], subtitle: `${dates.formatDate(r.from)} – ${dates.formatDate(r.to)}`,
    filters: { from: r.fromStr, to: r.toStr, method: q.method || '', class: q.class || '' },
    summary: [{ label: 'Payments', value: payments.length, type: 'number' }, { label: 'Total collected', value: total, type: 'money' },
      ...Object.entries(byMethod).map(([m, v]) => ({ label: m, value: v, type: 'money' }))],
    sections: [{
      title: 'Payments',
      columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'receipt', label: 'Receipt #' }, { key: 'code', label: 'Student ID' }, { key: 'student', label: 'Student' }, { key: 'class', label: 'Class' }, { key: 'category', label: 'Category' }, { key: 'method', label: 'Method' }, { key: 'amount', label: 'Amount', type: 'money' }],
      rows: payments.map((p) => ({
        date: p.paymentDate, receipt: p.receipt ? p.receipt.receiptNo : '', code: p.student ? p.student.studentCode : '',
        student: p.student ? p.student.fullName : '', class: p.student && p.student.class ? p.student.class.name : '',
        category: p.category, method: p.method, amount: p.amount,
      })),
      totals: { date: 'Total', amount: total },
    }],
  };
}

async function registrationFees(tenantId, q) {
  const f = { tenantId, type: 'registration', status: { $ne: 'cancelled' } };
  if (q.status === 'open') f.status = { $in: ['unpaid', 'partial', 'overdue'] };
  else if (q.status === 'paid') f.status = 'paid';
  const inv = await StudentInvoice.find(f).populate('student', 'fullName studentCode registrationDate').sort({ issueDate: -1 }).limit(10000).lean();
  const billed = money.sum(inv, 'total'); const paid = money.sum(inv, 'paid');
  return {
    title: REPORTS['registration-fees'], subtitle: q.status === 'open' ? 'Unpaid and partially paid' : q.status === 'paid' ? 'Fully paid' : 'All registration invoices',
    filters: { status: q.status || '' },
    summary: [{ label: 'Billed', value: billed, type: 'money' }, { label: 'Collected', value: paid, type: 'money' }, { label: 'Outstanding', value: billed - paid, type: 'money' }],
    sections: [{
      title: 'Registration invoices',
      columns: [{ key: 'invoiceNo', label: 'Invoice #' }, { key: 'code', label: 'Student ID' }, { key: 'student', label: 'Student' }, { key: 'issueDate', label: 'Issued', type: 'date' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'paid', label: 'Paid', type: 'money' }, { key: 'balance', label: 'Balance', type: 'money' }, { key: 'status', label: 'Status', type: 'status' }],
      rows: inv.map((i) => ({ invoiceNo: i.invoiceNo, code: i.student ? i.student.studentCode : '', student: i.student ? i.student.fullName : '', issueDate: i.issueDate, total: i.total, paid: i.paid, balance: i.total - i.paid, status: i.status })),
      totals: { invoiceNo: 'Total', total: billed, paid, balance: billed - paid },
    }],
  };
}

async function outstanding(tenantId, q) {
  const match = { tenantId, status: { $in: ['unpaid', 'partial', 'overdue'] } };
  let subtitle = 'All classes';
  if (q.class) {
    const cls = await owned(Class, tenantId, q.class, 'Class');
    match.class = cls._id; subtitle = cls.name;
  }
  const agg = await StudentInvoice.aggregate([
    { $match: match },
    { $group: { _id: '$student', invoices: { $sum: 1 }, total: { $sum: '$total' }, paid: { $sum: '$paid' }, oldestDue: { $min: '$dueDate' }, overdue: { $sum: { $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0] } } } },
    { $lookup: { from: 'students', localField: '_id', foreignField: '_id', as: 's' } },
    { $unwind: '$s' },
    { $lookup: { from: 'classes', localField: 's.class', foreignField: '_id', as: 'c' } },
    { $sort: { 's.fullName': 1 } },
  ]);
  const rows = agg.map((a) => ({
    code: a.s.studentCode, student: a.s.fullName, guardian: [a.s.guardianName, a.s.guardianPhone].filter(Boolean).join(' · '),
    class: a.c[0] ? a.c[0].name : '—', invoices: a.invoices, overdue: a.overdue, oldestDue: a.oldestDue,
    total: a.total, paid: a.paid, balance: a.total - a.paid,
  })).filter((r) => r.balance > 0);
  const bal = money.sum(rows, 'balance');
  return {
    title: REPORTS.outstanding, subtitle, filters: { class: q.class || '' },
    summary: [{ label: 'Students with balances', value: rows.length, type: 'number' }, { label: 'Total outstanding', value: bal, type: 'money' }],
    sections: [{
      title: 'Outstanding balances by student',
      columns: [{ key: 'code', label: 'Student ID' }, { key: 'student', label: 'Student' }, { key: 'class', label: 'Class' }, { key: 'guardian', label: 'Guardian' }, { key: 'invoices', label: 'Open inv.', type: 'number' }, { key: 'overdue', label: 'Overdue', type: 'number' }, { key: 'oldestDue', label: 'Oldest due', type: 'date' }, { key: 'balance', label: 'Balance', type: 'money' }],
      rows, totals: { code: 'Total', invoices: money.sum(rows, 'invoices'), overdue: money.sum(rows, 'overdue'), balance: bal },
    }],
  };
}

async function salaries(tenantId, q) {
  const fromP = dates.isPeriod(q.fromMonth) ? q.fromMonth : `${new Date().getUTCFullYear()}-01`;
  const toP = dates.isPeriod(q.toMonth) ? q.toMonth : dates.currentPeriod();
  const list = await TeacherSalaryPayment.find({ tenantId, status: 'paid', period: { $gte: fromP, $lte: toP } })
    .populate('teacher', 'fullName teacherCode').sort({ period: 1 }).lean();
  const sum = (k) => money.sum(list, k);
  return {
    title: REPORTS.salaries, subtitle: `${dates.periodLabel(fromP)} – ${dates.periodLabel(toP)}`, filters: { fromMonth: fromP, toMonth: toP },
    summary: [{ label: 'Salary payments', value: list.length, type: 'number' }, { label: 'Total net paid', value: sum('amount'), type: 'money' }],
    sections: [{
      title: 'Salary payments',
      columns: [{ key: 'period', label: 'Month' }, { key: 'code', label: 'Teacher ID' }, { key: 'teacher', label: 'Teacher' }, { key: 'date', label: 'Paid on', type: 'date' }, { key: 'method', label: 'Method' }, { key: 'base', label: 'Base', type: 'money' }, { key: 'bonus', label: 'Bonus', type: 'money' }, { key: 'deductions', label: 'Deductions', type: 'money' }, { key: 'amount', label: 'Net', type: 'money' }],
      rows: list.map((s) => ({ period: dates.periodLabel(s.period), code: s.teacher ? s.teacher.teacherCode : '', teacher: s.teacher ? s.teacher.fullName : '', date: s.paymentDate, method: s.method || '', base: s.baseSalary, bonus: s.bonus, deductions: s.deductions, amount: s.amount })),
      totals: { period: 'Total', base: sum('baseSalary'), bonus: sum('bonus'), deductions: sum('deductions'), amount: sum('amount') },
    }],
  };
}

async function expensesReport(tenantId, q) {
  const r = dates.rangeFromQuery(q);
  const cats = await expensesByCategory(tenantId, r.from, r.to);
  const total = money.sum(cats, 'amount');
  cats.forEach((c) => { c.share = total ? Math.round((c.amount / total) * 1000) / 10 : 0; });
  return {
    title: REPORTS['expenses-by-category'], subtitle: `${dates.formatDate(r.from)} – ${dates.formatDate(r.to)}`, filters: { from: r.fromStr, to: r.toStr },
    summary: [{ label: 'Total expenses', value: total, type: 'money' }, { label: 'Categories used', value: cats.length, type: 'number' }],
    pie: { labels: cats.map((c) => c.category), values: cats.map((c) => c.amount) },
    sections: [{
      title: 'Expenses by category',
      columns: [...CAT_COLUMNS, { key: 'share', label: 'Share', type: 'percent' }],
      rows: cats, totals: { category: 'Total', count: money.sum(cats, 'count'), amount: total, share: total ? 100 : 0 },
    }],
  };
}

async function incomeExpenditure(tenantId, q) {
  const r = dates.rangeFromQuery(q);
  const [incCat, expCat] = await Promise.all([incomeByCategory(tenantId, r.from, r.to), expensesByCategory(tenantId, r.from, r.to)]);
  const inc = money.sum(incCat, 'amount'); const exp = money.sum(expCat, 'amount');
  return {
    title: REPORTS['income-expenditure'], subtitle: `${dates.formatDate(r.from)} – ${dates.formatDate(r.to)}`, filters: { from: r.fromStr, to: r.toStr },
    summary: summaryOf(inc, exp),
    sections: [catSection('Income (confirmed payments)', incCat), catSection('Expenditure (recorded expenses)', expCat), {
      title: 'Result',
      columns: [{ key: 'item', label: 'Item' }, { key: 'amount', label: 'Amount', type: 'money' }],
      rows: [{ item: 'Total income', amount: inc }, { item: 'Total expenditure', amount: exp }],
      totals: { item: inc - exp >= 0 ? 'Surplus' : 'Deficit', amount: inc - exp },
    }],
  };
}

async function netBalance(tenantId, q) {
  const year = parseInt(q.year, 10) || new Date().getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1)); const end = new Date(Date.UTC(year + 1, 0, 1) - 1);
  const [months, opening] = await Promise.all([
    series(tenantId, start, end, '%Y-%m'),
    Promise.all([incomeTotal(tenantId, new Date(0), new Date(start.getTime() - 1)), expenseTotal(tenantId, new Date(0), new Date(start.getTime() - 1))]),
  ]);
  const openingBalance = opening[0].total - opening[1].total;
  let running = openingBalance;
  const rows = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const m = months.find((x) => x.key === key) || { income: 0, expenses: 0, net: 0 };
    running += m.net;
    return { month: dates.periodLabel(key), income: m.income, expenses: m.expenses, net: m.net, cumulative: running };
  });
  const inc = money.sum(rows, 'income'); const exp = money.sum(rows, 'expenses');
  return {
    title: REPORTS['net-balance'], subtitle: String(year), filters: { year },
    summary: [{ label: 'Opening balance', value: openingBalance, type: 'money' }, ...summaryOf(inc, exp), { label: 'Closing balance', value: running, type: 'money' }],
    chart: { labels: rows.map((m) => m.month.slice(0, 3)), income: rows.map((m) => m.income), expenses: rows.map((m) => m.expenses) },
    sections: [{
      title: 'Net balance by month',
      columns: [{ key: 'month', label: 'Month' }, { key: 'income', label: 'Income', type: 'money' }, { key: 'expenses', label: 'Expenses', type: 'money' }, { key: 'net', label: 'Net', type: 'money' }, { key: 'cumulative', label: 'Running balance', type: 'money' }],
      rows, totals: { month: 'Total', income: inc, expenses: exp, net: inc - exp, cumulative: running },
    }],
  };
}

const BUILDERS = {
  daily, monthly, annual, 'student-payments': studentPayments, 'registration-fees': registrationFees,
  outstanding, salaries, 'expenses-by-category': expensesReport, 'income-expenditure': incomeExpenditure, 'net-balance': netBalance,
};

async function build(tenantId, key, q) {
  const fn = BUILDERS[key];
  if (!fn) return null;
  return fn(tenantId, q || {});
}

module.exports = {
  REPORTS, build, incomeTotal, expenseTotal, series, incomeByCategory, expensesByCategory,
  isObjectId: mongoose.isValidObjectId, INCOME_LABEL, C,
};
