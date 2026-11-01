'use strict';
/**
 * Money handling: every monetary value is stored and computed as an integer number of
 * minor units (cents). Strings from forms are parsed digit-by-digit, never via parseFloat,
 * so no binary floating-point error can enter a balance.
 */

const MINOR_DIGITS = 2;
const FACTOR = 10 ** MINOR_DIGITS;

/** Parse "1,250.5" / "1250.50" / 1250 into integer minor units (125050). Returns null if invalid. */
function toMinor(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    input = input.toFixed(MINOR_DIGITS);
  }
  const s = String(input).trim().replace(/[,\s]/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const [, neg, whole, frac = ''] = m;
  const minor = Number(whole) * FACTOR + Number((frac + '00').slice(0, MINOR_DIGITS));
  if (!Number.isSafeInteger(minor)) return null;
  return neg ? -minor : minor;
}

/** Integer minor units -> "1250.50" (for form inputs). */
function toDecimalString(minor) {
  const n = Number(minor) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / FACTOR);
  const frac = String(abs % FACTOR).padStart(MINOR_DIGITS, '0');
  return `${sign}${whole}.${frac}`;
}

/** Integer minor units -> "$1,250.50" style display string. */
function format(minor, currency = 'USD') {
  const n = Number(minor) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / FACTOR).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % FACTOR).padStart(MINOR_DIGITS, '0');
  const symbols = { USD: '$', EUR: '€', GBP: '£', KES: 'KSh ', SOS: 'Sh.So. ', ETB: 'Br ', DJF: 'Fdj ' };
  const sym = symbols[currency];
  return sym ? `${sign}${sym}${whole}.${frac}` : `${sign}${whole}.${frac} ${currency}`;
}

function assertInt(...values) {
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new Error(`Money value must be an integer of minor units, got ${v}`);
  }
}

function add(...values) {
  assertInt(...values);
  return values.reduce((a, b) => a + b, 0);
}

function sub(a, b) {
  assertInt(a, b);
  return a - b;
}

/** Sum a field across an array of objects (all integers). */
function sum(items, field) {
  return items.reduce((acc, it) => {
    const v = field ? it[field] : it;
    assertInt(v || 0);
    return acc + (v || 0);
  }, 0);
}

module.exports = { toMinor, toDecimalString, format, add, sub, sum, FACTOR };
