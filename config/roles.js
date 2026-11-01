'use strict';
/**
 * Role-based access control matrix.
 * Permissions are plain strings; a role is a list of permissions. '*' grants everything.
 * Every school route declares the permission it needs (see routes/school.js).
 */

const SCHOOL_ROLES = {
  school_admin: { label: 'School Administrator', permissions: ['*'] },
  finance_officer: {
    label: 'Finance Officer',
    permissions: [
      'dashboard.view', 'students.view', 'teachers.view', 'classes.view',
      'invoices.view', 'invoices.manage', 'payments.view', 'payments.create', 'payments.reverse',
      'receipts.view', 'expenses.view', 'expenses.manage', 'salaries.view', 'salaries.manage',
      'reports.finance', 'subscription.manage', 'notifications.view',
    ],
  },
  teacher: {
    label: 'Teacher',
    permissions: [
      'dashboard.view', 'students.view', 'classes.view',
      'lessons.view', 'lessons.manage', 'activities.view', 'activities.manage',
      'attendance.view', 'attendance.manage', 'reports.academic', 'notifications.view',
    ],
  },
  receptionist: {
    label: 'Receptionist',
    permissions: [
      'dashboard.view', 'students.view', 'students.manage', 'teachers.view', 'classes.view',
      'attendance.view', 'invoices.view', 'payments.view', 'payments.create', 'receipts.view',
      'notifications.view',
    ],
  },
};

const PLATFORM_ROLES = {
  super_admin: { label: 'Super Admin', permissions: ['*'] },
  finance_officer: {
    label: 'Platform Finance Officer',
    permissions: [
      'platform.dashboard', 'schools.view', 'subscriptions.view', 'subscriptions.manage',
      'payments.view', 'payments.verify', 'reports.view', 'plans.view',
    ],
  },
  support_officer: {
    label: 'Platform Support Officer',
    permissions: ['platform.dashboard', 'schools.view', 'schools.status', 'subscriptions.view', 'plans.view'],
  },
};

function can(rolesMap, role, permission) {
  const def = rolesMap[role];
  if (!def) return false;
  return def.permissions.includes('*') || def.permissions.includes(permission);
}

module.exports = {
  SCHOOL_ROLES,
  PLATFORM_ROLES,
  schoolCan: (role, perm) => can(SCHOOL_ROLES, role, perm),
  platformCan: (role, perm) => can(PLATFORM_ROLES, role, perm),
};
