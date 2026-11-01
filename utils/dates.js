'use strict';
/** Date helpers. Billing periods are "YYYY-MM" strings; days are handled at UTC midnight. */

const pad = (n) => String(n).padStart(2, '0');

function startOfDay(d = new Date()) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

function endOfDay(d = new Date()) {
  const s = startOfDay(d);
  return new Date(s.getTime() + 24 * 60 * 60 * 1000 - 1);
}

function parseDay(str) {
  if (!str) return null;
  if (str instanceof Date) return startOfDay(str);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toISODate(d) {
  if (!d) return '';
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

function currentPeriod(d = new Date()) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

function isPeriod(p) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));
}

function periodRange(period) {
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1) - 1);
  return { start, end };
}

function periodLabel(period) {
  if (!isPeriod(period)) return period || '';
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function addMonths(d, months) {
  const x = new Date(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + months);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return x;
}

function addDays(d, days) {
  return new Date(new Date(d).getTime() + days * 24 * 60 * 60 * 1000);
}

function daysBetween(a, b) {
  return Math.ceil((startOfDay(b) - startOfDay(a)) / (24 * 60 * 60 * 1000));
}

/** Last N periods ending with the current one, oldest first. */
function lastPeriods(n, from = new Date()) {
  const out = [];
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  for (let i = n - 1; i >= 0; i -= 1) out.push(currentPeriod(new Date(Date.UTC(y, m - i, 1))));
  return out;
}

/** Parse ?from=&to= query strings into an inclusive range, defaulting to the current month. */
function rangeFromQuery(q = {}) {
  const now = new Date();
  const from = parseDay(q.from) || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = parseDay(q.to) || startOfDay(now);
  return { from, to: endOfDay(to), fromStr: toISODate(from), toStr: toISODate(to) };
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

module.exports = {
  startOfDay, endOfDay, parseDay, toISODate, currentPeriod, isPeriod, periodRange, periodLabel,
  addMonths, addDays, daysBetween, lastPeriods, rangeFromQuery, formatDate,
};
