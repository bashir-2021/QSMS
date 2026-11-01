'use strict';
const config = require('../config');
const { StudentInvoice, SchoolSettings } = require('../models');
const subscriptionService = require('./subscriptionService');
const billingService = require('./billingService');
const notifications = require('./notificationService');
const dates = require('../utils/dates');
const money = require('../utils/money');

/**
 * Periodic housekeeping (runs in-process; for multi-instance deployments run it on one
 * worker only by setting JOB_INTERVAL_MINUTES=0 on the others):
 *   - subscription status refresh + renewal reminders
 *   - mark overdue student invoices
 *   - daily "outstanding fees" notification per school (de-duplicated per day)
 */
async function runOnce() {
  const started = Date.now();
  const subs = await subscriptionService.refreshAll();
  const overdue = await billingService.refreshOverdue();

  const today = dates.toISODate(new Date());
  const perTenant = await StudentInvoice.aggregate([
    { $match: { status: 'overdue' } },
    { $group: { _id: '$tenantId', invoices: { $sum: 1 }, students: { $addToSet: '$student' }, due: { $sum: { $subtract: ['$total', '$paid'] } } } },
  ]).option({ skipTenant: true });
  for (const t of perTenant) {
    const settings = await SchoolSettings.findOne({ tenantId: t._id }).select('currency').lean();
    await notifications.toSchool(t._id, {
      type: 'fees', level: 'warning', roles: ['school_admin', 'finance_officer', 'receptionist'],
      title: `${t.students.length} student(s) have overdue fees`,
      message: `${t.invoices} overdue invoice(s) totalling ${money.format(t.due, settings ? settings.currency : 'USD')}. Follow up with guardians.`,
      link: '/school/reports/outstanding', dedupeKey: `overdue:${t._id}:${today}`,
    });
  }
  return { ...subs, overdueMarked: overdue, ms: Date.now() - started };
}

let timer = null;
function start() {
  const minutes = config.subscription.jobIntervalMinutes;
  if (!minutes || config.isTest) return;
  const tick = () => runOnce().catch((err) => console.error('[jobs] run failed', err));
  setTimeout(tick, 5000);
  timer = setInterval(tick, minutes * 60 * 1000);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
}

module.exports = { runOnce, start, stop };
