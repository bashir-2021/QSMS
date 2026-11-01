'use strict';
const { Counter } = require('../models');

/**
 * Generate human-readable, gap-free document numbers from configurable formats.
 * Tokens: {YYYY} {YY} {MM} {SEQ:n} (zero-padded to n digits).
 * When a format contains {YYYY}/{YY} the counter restarts each year.
 *
 *   next(tenantId, 'receipt', 'RCT-{YYYY}-{SEQ:5}')  ->  "RCT-2026-00042"
 */
function render(format, seq, now) {
  const yyyy = String(now.getUTCFullYear());
  return format
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yyyy.slice(2))
    .replace(/\{MM\}/g, String(now.getUTCMonth() + 1).padStart(2, '0'))
    .replace(/\{SEQ(?::(\d+))?\}/g, (_, n) => String(seq).padStart(Number(n || 1), '0'));
}

async function next(tenantId, kind, format, { session, now = new Date() } = {}) {
  const fmt = format || `${kind.toUpperCase().slice(0, 3)}-{YYYY}-{SEQ:5}`;
  const yearly = /\{YY(YY)?\}/.test(fmt);
  const key = yearly ? `${kind}:${now.getUTCFullYear()}` : kind;
  const counter = await Counter.findOneAndUpdate(
    { tenantId: tenantId || null, key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session: session || undefined },
  );
  return render(fmt, counter.seq, now);
}

module.exports = { next, render };
