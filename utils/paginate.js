'use strict';

/**
 * Paginate a Mongoose query. `filter` must already contain tenantId for school models
 * (the tenant plugin enforces it).
 */
async function paginate(Model, filter, { page = 1, limit = 20, sort = { createdAt: -1 }, populate, select, lean = true } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  let q = Model.find(filter).sort(sort).skip((p - 1) * l).limit(l);
  if (select) q = q.select(select);
  if (populate) [].concat(populate).forEach((pp) => { q = q.populate(pp); });
  if (lean) q = q.lean();
  const [items, total] = await Promise.all([q, Model.countDocuments(filter)]);
  return { items, total, page: p, limit: l, pages: Math.max(1, Math.ceil(total / l)) };
}

/** Escape user text for safe use inside a RegExp search. */
function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 100);
}

module.exports = { paginate, escapeRegex };
