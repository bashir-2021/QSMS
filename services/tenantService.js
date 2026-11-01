'use strict';
const { runInTransaction } = require('../config/db');
const C = require('../config/constants');
const {
  Tenant, SchoolUser, SchoolSettings, ExpenseCategory, SubscriptionPlan, Subscription,
  Student, Teacher, Class, StudentPayment, Expense,
} = require('../models');
const { hashPassword } = require('./authService');
const subscriptionService = require('./subscriptionService');
const notifications = require('./notificationService');
const { persistUpload } = require('../middleware/upload');
const { badRequest, conflict, notFound } = require('../utils/errors');

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'school';
}

async function uniqueSlug(name, session) {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; await Tenant.exists({ slug }).session(session || null); i += 1) slug = `${base}-${i}`;
  return slug;
}

/** Default settings + expense categories every new school starts with. */
async function createDefaults(tenantId, session) {
  await SchoolSettings.create([{ tenantId }], { session });
  await ExpenseCategory.insertMany(
    C.DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ tenantId, name, isSystem: name === C.SALARY_CATEGORY })),
    { session },
  );
}

/**
 * Self-service (or platform-initiated) school registration.
 * Atomically creates: Tenant, school administrator account, default settings,
 * expense categories and the initial subscription (trial when the plan offers one).
 */
async function registerSchool(data, logoFile) {
  const email = String(data.email).toLowerCase().trim();
  if (await SchoolUser.exists({ email }).setOptions({ skipTenant: true })) {
    throw conflict('An account with this email already exists. Please log in instead.');
  }
  const plan = await SubscriptionPlan.findOne({ _id: data.planId, isActive: true });
  if (!plan) throw badRequest('Please select a valid subscription plan.');
  const passwordHash = await hashPassword(data.password);

  const result = await runInTransaction(async (session) => {
    const [tenant] = await Tenant.create([{
      name: data.schoolName, slug: await uniqueSlug(data.schoolName, session),
      country: data.country, city: data.city, address: data.address,
      phone: data.phone, email, adminName: data.adminName, status: 'active',
    }], { session });

    const [admin] = await SchoolUser.create([{
      tenantId: tenant._id, name: data.adminName, email, phone: data.phone,
      passwordHash, role: 'school_admin',
    }], { session });

    await createDefaults(tenant._id, session);
    const sub = await subscriptionService.createInitial(tenant._id, plan, { session });
    tenant.currentSubscription = sub._id;
    await tenant.save({ session });
    return { tenant, admin, subscription: sub };
  });

  if (logoFile) {
    try {
      result.tenant.logo = persistUpload(logoFile, result.tenant._id, 'logo');
      await result.tenant.save();
    } catch (err) {
      console.error('[register] logo upload rejected:', err.message);
    }
  }

  await notifications.toPlatform({
    type: 'school', level: 'info', roles: ['super_admin', 'support_officer', 'finance_officer'],
    title: 'New school registered', message: `${result.tenant.name} (${result.tenant.city || ''}, ${result.tenant.country || ''}) joined on the ${plan.name} plan.`,
    link: `/platform/schools/${result.tenant._id}`,
  });
  await notifications.toSchool(result.tenant._id, {
    type: 'system', level: 'success', title: 'Welcome to Quranic',
    message: 'Start by reviewing School Settings (fees, currency, payment methods), then add classes, teachers and students.',
    link: '/school/settings',
  });
  return result;
}

async function setStatus(tenantId, status, reason) {
  if (!C.TENANT_STATUSES.includes(status)) throw badRequest('Invalid status');
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw notFound('School');
  tenant.status = status;
  tenant.statusReason = status === 'active' ? undefined : reason;
  await tenant.save();
  await notifications.toSchool(tenant._id, {
    type: 'system', level: status === 'active' ? 'success' : 'danger', roles: ['school_admin'],
    title: `School account ${status === 'active' ? 'activated' : status}`,
    message: reason || `Your school account status changed to ${status}.`,
  });
  return tenant;
}

/** Aggregate usage numbers only — no private student/financial records are exposed. */
async function usageStats(tenantId) {
  const [students, activeStudents, teachers, classes, users, incomeAgg, expenseAgg] = await Promise.all([
    Student.countDocuments({ tenantId }),
    Student.countDocuments({ tenantId, status: 'active' }),
    Teacher.countDocuments({ tenantId }),
    Class.countDocuments({ tenantId, isActive: true }),
    SchoolUser.countDocuments({ tenantId }),
    StudentPayment.countDocuments({ tenantId, status: 'confirmed' }),
    Expense.countDocuments({ tenantId, status: 'recorded' }),
  ]);
  return { students, activeStudents, teachers, classes, users, paymentsRecorded: incomeAgg, expensesRecorded: expenseAgg };
}

async function subscriptionHistory(tenantId) {
  return Subscription.find({ tenant: tenantId }).sort({ createdAt: -1 }).lean();
}

module.exports = { registerSchool, setStatus, usageStats, subscriptionHistory, slugify, createDefaults };
