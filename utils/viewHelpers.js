'use strict';
/** Helpers exposed to every EJS template via app.locals. */
const money = require('./money');
const dates = require('./dates');
const C = require('../config/constants');
const { getSurah } = require('./quran');

const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const STATUS_COLORS = {
  active: 'success', trial: 'info', expiring_soon: 'warning', expired: 'danger', suspended: 'danger',
  cancelled: 'secondary', inactive: 'secondary', graduated: 'primary',
  pending: 'warning', paid: 'success', failed: 'danger', refunded: 'secondary',
  unpaid: 'danger', partial: 'warning', overdue: 'danger',
  present: 'success', absent: 'danger', late: 'warning', excused: 'info',
  confirmed: 'success', reversed: 'secondary', recorded: 'success', void: 'secondary',
  planned: 'info', in_progress: 'warning', completed: 'success',
  on_leave: 'warning', resigned: 'secondary', terminated: 'danger',
  excellent: 'success', very_good: 'primary', good: 'info', fair: 'warning', needs_improvement: 'danger',
};

function statusBadge(status) {
  const color = STATUS_COLORS[status] || 'secondary';
  return `<span class="badge badge-soft-${color}">${titleCase(status)}</span>`;
}

/** Build a query string from the current query, overriding some keys (used by pagination & filters). */
function qs(query, overrides = {}) {
  const params = new URLSearchParams();
  Object.entries({ ...query, ...overrides }).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, v);
  });
  const s = params.toString();
  return s ? `?${s}` : '';
}

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

const selected = (a, b) => (String(a) === String(b) ? 'selected' : '');
const checked = (cond) => (cond ? 'checked' : '');

/** Format one report cell for HTML (status cells become badges, returned as HTML). */
function reportCell(value, type, currency) {
  if (value === undefined || value === null || value === '') return '';
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  switch (type) {
    case 'money': return typeof value === 'number' ? esc(money.format(value, currency)) : esc(value);
    case 'date': return esc(dates.formatDate(value));
    case 'percent': return `${esc(value)}%`;
    case 'status': return statusBadge(value);
    default: return esc(value);
  }
}

module.exports = {
  reportCell,
  money: money.format,
  moneyInput: money.toDecimalString,
  fmtDate: dates.formatDate,
  isoDate: dates.toISODate,
  periodLabel: dates.periodLabel,
  titleCase,
  statusBadge,
  qs,
  initials,
  selected,
  checked,
  surahName: (n) => { const s = getSurah(n); return s ? `${s.number}. ${s.name}` : ''; },
  C,
};
