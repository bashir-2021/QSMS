'use strict';
const mongoose = require('mongoose');
const { notFound, badRequest } = require('../utils/errors');

/**
 * Tenant-ownership helpers used by every school service.
 * Any id that arrives from the browser (student, class, invoice, ...) is resolved with
 * `owned()` before use, so a school can never reference another school's records.
 */
async function owned(Model, tenantId, id, label = 'Record', { session, populate, lean = true } = {}) {
  if (!mongoose.isValidObjectId(id)) throw notFound(label);
  let q = Model.findOne({ _id: id, tenantId });
  if (session) q = q.session(session);
  if (populate) [].concat(populate).forEach((p) => { q = q.populate(p); });
  if (lean) q = q.lean();
  const doc = await q;
  if (!doc) throw notFound(label);
  return doc;
}

/** Same as owned() but returns null for empty input (optional references). */
async function ownedOptional(Model, tenantId, id, label, opts) {
  if (id === undefined || id === null || id === '') return null;
  return owned(Model, tenantId, id, label, opts);
}

/** Verify a list of ids all belong to the tenant; returns the docs. */
async function ownedMany(Model, tenantId, ids, label = 'Records') {
  const list = [...new Set([].concat(ids || []).filter(Boolean).map(String))];
  if (!list.every((id) => mongoose.isValidObjectId(id))) throw badRequest(`Invalid ${label}`);
  const docs = await Model.find({ _id: { $in: list }, tenantId }).lean();
  if (docs.length !== list.length) throw notFound(label);
  return docs;
}

module.exports = { owned, ownedOptional, ownedMany };
