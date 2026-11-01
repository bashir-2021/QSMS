'use strict';
/**
 * Platform (SaaS owner) statistics, plans and reports.
 * School-owned collections are only ever *counted* here (skipTenant), never listed,
 * so platform staff see usage without private school records.
 */
const {
  Tenant, Subscription, SubscriptionPlan, SubscriptionPayment, Student, Teacher, Class, SchoolUser,
} = require('../models');
const C = require('../config/constants');
const dates = require('../utils/dates');
const money = require('../utils/money');
const { paginate, escapeRegex } = require('../utils/paginate');
const { badRequest, conflict, notFound } = require('../utils/errors');

const crossTenantCount = (Model, filter = {}) => Model.countDocuments(filter).setOptions({ skipTenant: true });

async function dashboard() {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const sixAgo = dates.periodRange(dates.lastPeriods(6)[0]).start;

  const [
    schools, activeSchools, suspendedSchools, students, teachers, classes,
    subsByStatus, revenueMonth, revenueYear, revenueAll, pending, revenueTrend, recentSchools, expiring, plansAgg,
  ] = await Promise.all([
    Tenant.countDocuments(), Tenant.countDocuments({ status: 'active' }), Tenant.countDocuments({ status: { $in: ['suspended', 'inactive'] } }),
    crossTenantCount(Student), crossTenantCount(Teacher), crossTenantCount(Class),
    Subscription.aggregate([
      { $lookup: { from: 'tenants', localField: '_id', foreignField: 'currentSubscription', as: 't' } },
      { $match: { 't.0': { $exists: true } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    SubscriptionPayment.aggregate([{ $match: { status: 'paid', verifiedAt: { $gte: monthStart } } }, { $group: { _id: null, v: { $sum: '$amount' } } }]),
    SubscriptionPayment.aggregate([{ $match: { status: 'paid', verifiedAt: { $gte: yearStart } } }, { $group: { _id: null, v: { $sum: '$amount' } } }]),
    SubscriptionPayment.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: null, v: { $sum: '$amount' } } }]),
    SubscriptionPayment.find({ status: 'pending' }).populate('tenant', 'name').populate('plan', 'name').sort({ createdAt: 1 }).limit(8).lean(),
    SubscriptionPayment.aggregate([
      { $match: { status: 'paid', verifiedAt: { $gte: sixAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$verifiedAt' } }, v: { $sum: '$amount' } } },
    ]),
    Tenant.find().sort({ createdAt: -1 }).limit(6).populate({ path: 'currentSubscription', select: 'status endDate planSnapshot.name' }).lean(),
    Subscription.find({ status: { $in: ['expiring_soon', 'expired', 'trial'] }, endDate: { $lte: dates.addDays(now, 14) } })
      .populate('tenant', 'name currentSubscription').sort({ endDate: 1 }).limit(10).lean(),
    Subscription.aggregate([
      { $match: { status: { $in: ['trial', 'active', 'expiring_soon'] } } },
      { $group: { _id: '$planSnapshot.name', n: { $sum: 1 } } },
    ]),
  ]);

  const status = Object.fromEntries(C.SUBSCRIPTION_STATUSES.map((s) => [s, 0]));
  subsByStatus.forEach((s) => { status[s._id] = s.n; });
  const months = dates.lastPeriods(6);
  const trendMap = Object.fromEntries(revenueTrend.map((r) => [r._id, r.v]));
  return {
    counts: { schools, activeSchools, suspendedSchools, students, teachers, classes },
    status,
    revenue: { month: revenueMonth[0] ? revenueMonth[0].v : 0, year: revenueYear[0] ? revenueYear[0].v : 0, all: revenueAll[0] ? revenueAll[0].v : 0 },
    pending,
    pendingTotal: money.sum(pending, 'amount'),
    chart: { labels: months.map((m) => dates.periodLabel(m).slice(0, 3)), revenue: months.map((m) => trendMap[m] || 0) },
    plans: { labels: plansAgg.map((p) => p._id || 'Unknown'), values: plansAgg.map((p) => p.n) },
    recentSchools,
    expiring: expiring.filter((s) => s.tenant && String(s.tenant.currentSubscription) === String(s._id)),
  };
}

/* --------------------------------- Schools -------------------------------- */

async function listSchools(q = {}) {
  const f = {};
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    f.$or = [{ name: rx }, { city: rx }, { country: rx }, { email: rx }, { slug: rx }];
  }
  if (C.TENANT_STATUSES.includes(q.status)) f.status = q.status;
  if (C.SUBSCRIPTION_STATUSES.includes(q.subscription)) {
    const subs = await Subscription.find({ status: q.subscription }).select('_id').lean();
    f.currentSubscription = { $in: subs.map((s) => s._id) };
  }
  const page = await paginate(Tenant, f, {
    page: q.page, limit: 20, sort: { createdAt: -1 },
    populate: { path: 'currentSubscription', select: 'status endDate planSnapshot.name' },
  });
  const ids = page.items.map((t) => t._id);
  const [studentCounts, userCounts] = await Promise.all([
    Student.aggregate([{ $match: { tenantId: { $in: ids } } }, { $group: { _id: '$tenantId', n: { $sum: 1 } } }]).option({ skipTenant: true }),
    SchoolUser.aggregate([{ $match: { tenantId: { $in: ids } } }, { $group: { _id: '$tenantId', n: { $sum: 1 } } }]).option({ skipTenant: true }),
  ]);
  const sc = Object.fromEntries(studentCounts.map((x) => [String(x._id), x.n]));
  const uc = Object.fromEntries(userCounts.map((x) => [String(x._id), x.n]));
  page.items.forEach((t) => { t.studentCount = sc[String(t._id)] || 0; t.userCount = uc[String(t._id)] || 0; });
  return page;
}

async function schoolDetail(id) {
  const tenant = await Tenant.findById(id).populate({ path: 'currentSubscription', populate: { path: 'plan', select: 'name code' } }).lean();
  if (!tenant) throw notFound('School');
  const [history, payments, admins] = await Promise.all([
    Subscription.find({ tenant: tenant._id }).sort({ createdAt: -1 }).lean(),
    SubscriptionPayment.find({ tenant: tenant._id }).populate('plan', 'name').sort({ createdAt: -1 }).limit(20).lean(),
    SchoolUser.find({ tenantId: tenant._id, role: 'school_admin' }).select('name email phone lastLoginAt isActive').lean(),
  ]);
  return { tenant, history, payments, admins };
}

/* ---------------------------------- Plans --------------------------------- */

const listPlans = (all = true) => SubscriptionPlan.find(all ? {} : { isActive: true, isPublic: true }).sort({ sortOrder: 1, price: 1 }).lean();

function readPlan(data) {
  const price = money.toMinor(data.price);
  if (price === null || price < 0) throw badRequest('Enter a valid price.');
  if (!C.BILLING_CYCLES[data.billingCycle]) throw badRequest('Choose a billing cycle.');
  const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    name: data.name, code: String(data.code || data.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: data.description,
    price, currency: String(data.currency || 'USD').toUpperCase(), billingCycle: data.billingCycle,
    customDays: data.billingCycle === 'custom' ? num(data.customDays, 30) || 30 : undefined,
    limits: { students: num(data.maxStudents, 0), teachers: num(data.maxTeachers, 0), classes: num(data.maxClasses, 0), users: num(data.maxUsers, 0) },
    features: [].concat(data.features || []).filter((f) => C.PLAN_FEATURES[f]),
    trialDays: num(data.trialDays, 0), graceDays: num(data.graceDays, 0),
    reminderDays: String(data.reminderDays || '7,3,1').split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0 && x <= 90).slice(0, 5),
    isPublic: data.isPublic === 'on', isActive: data.isActive === 'on', sortOrder: num(data.sortOrder, 0),
  };
}

async function savePlan(id, data) {
  const fields = readPlan(data);
  try {
    if (!id) return await SubscriptionPlan.create(fields);
    const plan = await SubscriptionPlan.findById(id);
    if (!plan) throw notFound('Plan');
    Object.assign(plan, fields);
    return await plan.save();
  } catch (err) {
    if (err.code === 11000) throw conflict('A plan with this code already exists.');
    throw err;
  }
}

/* -------------------------------- Payments -------------------------------- */

async function listPayments(q = {}) {
  const f = {};
  if (C.SUBSCRIPTION_PAYMENT_STATUSES.includes(q.status)) f.status = q.status;
  if (q.tenant && /^[a-f0-9]{24}$/i.test(q.tenant)) f.tenant = q.tenant;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), 'i');
    const tenants = await Tenant.find({ name: rx }).select('_id').lean();
    f.$or = [{ reference: rx }, { transactionRef: rx }, { tenant: { $in: tenants.map((t) => t._id) } }];
  }
  return paginate(SubscriptionPayment, f, {
    page: q.page, limit: 25, sort: { createdAt: -1 },
    populate: [{ path: 'tenant', select: 'name' }, { path: 'plan', select: 'name' }, { path: 'verifiedBy', select: 'name' }],
  });
}

/* --------------------------------- Reports -------------------------------- */

const REPORTS = { revenue: 'Platform revenue report', subscriptions: 'Subscriptions report', usage: 'School usage report', pending: 'Pending & renewal report' };

async function buildReport(key, q = {}) {
  if (key === 'revenue') {
    const r = dates.rangeFromQuery(q);
    const list = await SubscriptionPayment.find({ status: 'paid', verifiedAt: { $gte: r.from, $lte: r.to } }).populate('tenant', 'name').populate('plan', 'name').sort({ verifiedAt: 1 }).lean();
    const byPlan = {};
    list.forEach((p) => { const k = p.plan ? p.plan.name : '—'; byPlan[k] = (byPlan[k] || 0) + p.amount; });
    const total = money.sum(list, 'amount');
    return {
      title: REPORTS.revenue, subtitle: `${dates.formatDate(r.from)} – ${dates.formatDate(r.to)}`, filters: { from: r.fromStr, to: r.toStr },
      summary: [{ label: 'Verified payments', value: list.length, type: 'number' }, { label: 'Revenue', value: total, type: 'money' }, ...Object.entries(byPlan).map(([k, v]) => ({ label: k, value: v, type: 'money' }))],
      sections: [{
        title: 'Verified subscription payments',
        columns: [{ key: 'date', label: 'Verified', type: 'date' }, { key: 'ref', label: 'Reference' }, { key: 'school', label: 'School' }, { key: 'plan', label: 'Plan' }, { key: 'periods', label: 'Periods', type: 'number' }, { key: 'method', label: 'Method', type: 'status' }, { key: 'amount', label: 'Amount', type: 'money' }],
        rows: list.map((p) => ({ date: p.verifiedAt, ref: p.reference, school: p.tenant ? p.tenant.name : '', plan: p.plan ? p.plan.name : '', periods: p.periods, method: p.method, amount: p.amount })),
        totals: { date: 'Total', amount: total },
      }],
    };
  }
  if (key === 'subscriptions' || key === 'pending') {
    const tenants = await Tenant.find().populate('currentSubscription').sort({ name: 1 }).lean();
    let rows = tenants.map((t) => {
      const s = t.currentSubscription;
      return { id: t._id, school: t.name, schoolStatus: t.status, plan: s && s.planSnapshot ? s.planSnapshot.name : '—', status: s ? s.status : 'none', start: s ? s.startDate : null, end: s ? s.endDate : null, daysLeft: s ? dates.daysBetween(new Date(), s.endDate) : null, price: s && s.planSnapshot ? s.planSnapshot.price : 0 };
    });
    if (key === 'pending') rows = rows.filter((r) => ['expiring_soon', 'expired', 'trial'].includes(r.status)).sort((a, b) => (a.daysLeft || 0) - (b.daysLeft || 0));
    const pendingPayments = key === 'pending' ? await SubscriptionPayment.find({ status: 'pending' }).populate('tenant', 'name').populate('plan', 'name').lean() : [];
    const sections = [{
      title: key === 'pending' ? 'Subscriptions needing renewal' : 'All school subscriptions',
      columns: [{ key: 'school', label: 'School' }, { key: 'schoolStatus', label: 'Account', type: 'status' }, { key: 'plan', label: 'Plan' }, { key: 'status', label: 'Subscription', type: 'status' }, { key: 'start', label: 'Start', type: 'date' }, { key: 'end', label: 'End', type: 'date' }, { key: 'daysLeft', label: 'Days left', type: 'number' }, { key: 'price', label: 'Plan price', type: 'money' }],
      rows,
    }];
    if (key === 'pending') {
      sections.push({
        title: 'Payments awaiting verification',
        columns: [{ key: 'date', label: 'Submitted', type: 'date' }, { key: 'ref', label: 'Reference' }, { key: 'school', label: 'School' }, { key: 'plan', label: 'Plan' }, { key: 'method', label: 'Method', type: 'status' }, { key: 'txn', label: 'Txn ref' }, { key: 'amount', label: 'Amount', type: 'money' }],
        rows: pendingPayments.map((p) => ({ date: p.createdAt, ref: p.reference, school: p.tenant ? p.tenant.name : '', plan: p.plan ? p.plan.name : '', method: p.method, txn: p.transactionRef || '', amount: p.amount })),
        totals: { date: 'Total', amount: money.sum(pendingPayments, 'amount') },
      });
    }
    const count = (st) => rows.filter((r) => r.status === st).length;
    return {
      title: REPORTS[key], subtitle: `As of ${dates.formatDate(new Date())}`, filters: {},
      summary: C.SUBSCRIPTION_STATUSES.map((s) => ({ label: s.replace('_', ' '), value: count(s), type: 'number' })).filter((x) => key !== 'pending' || x.value),
      sections,
    };
  }
  if (key === 'usage') {
    const tenants = await Tenant.find().populate('currentSubscription', 'planSnapshot status').sort({ name: 1 }).lean();
    const agg = async (Model, extra = {}) => Object.fromEntries((await Model.aggregate([{ $match: { tenantId: { $exists: true }, ...extra } }, { $group: { _id: '$tenantId', n: { $sum: 1 } } }]).option({ skipTenant: true })).map((x) => [String(x._id), x.n]));
    const [st, ast, te, cl, us] = await Promise.all([agg(Student), agg(Student, { status: 'active' }), agg(Teacher), agg(Class), agg(SchoolUser)]);
    const rows = tenants.map((t) => {
      const lim = t.currentSubscription && t.currentSubscription.planSnapshot ? t.currentSubscription.planSnapshot.limits : {};
      const id = String(t._id);
      return {
        school: t.name, location: [t.city, t.country].filter(Boolean).join(', '), plan: t.currentSubscription && t.currentSubscription.planSnapshot ? t.currentSubscription.planSnapshot.name : '—',
        students: st[id] || 0, active: ast[id] || 0, studentLimit: lim && lim.students ? lim.students : 'Unlimited',
        teachers: te[id] || 0, classes: cl[id] || 0, users: us[id] || 0,
      };
    });
    return {
      title: REPORTS.usage, subtitle: 'Aggregate counts only — no private school records', filters: {},
      summary: [{ label: 'Schools', value: rows.length, type: 'number' }, { label: 'Students', value: money.sum(rows, 'students'), type: 'number' }, { label: 'Teachers', value: money.sum(rows, 'teachers'), type: 'number' }, { label: 'Classes', value: money.sum(rows, 'classes'), type: 'number' }],
      sections: [{
        title: 'Usage by school',
        columns: [{ key: 'school', label: 'School' }, { key: 'location', label: 'Location' }, { key: 'plan', label: 'Plan' }, { key: 'students', label: 'Students', type: 'number' }, { key: 'active', label: 'Active', type: 'number' }, { key: 'studentLimit', label: 'Limit' }, { key: 'teachers', label: 'Teachers', type: 'number' }, { key: 'classes', label: 'Classes', type: 'number' }, { key: 'users', label: 'Users', type: 'number' }],
        rows,
      }],
    };
  }
  return null;
}

module.exports = { dashboard, listSchools, schoolDetail, listPlans, savePlan, listPayments, buildReport, REPORTS };
