'use strict';
const mongoose = require('mongoose');
const tenantContext = require('../../utils/tenantContext');

/**
 * Tenant isolation plugin — applied to every school-owned collection.
 *
 *  1. Adds a required, immutable, indexed `tenantId`.
 *  2. Every query, update, delete and aggregation must be tenant-scoped:
 *     - if the filter names a tenantId inside a school request, it must be the signed-in school;
 *     - if the filter has no tenantId (e.g. populate()), the request's tenant is added automatically;
 *     - with no tenant in the filter or the request context, the operation is refused.
 *  3. New documents get the request's tenantId and can never be written for another tenant.
 *
 *  Platform-wide statistics opt out explicitly with `{ skipTenant: true }` and only count.
 */
const QUERY_OPS = [
  'find', 'findOne', 'countDocuments', 'distinct',
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
];

class TenantIsolationError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'TenantIsolationError';
    this.status = 500;
  }
}

function filterTenant(filter) {
  if (!filter) return undefined;
  if (filter.tenantId) return filter.tenantId;
  if (Array.isArray(filter.$and)) {
    const f = filter.$and.find((x) => x && x.tenantId);
    return f ? f.tenantId : undefined;
  }
  return undefined;
}

/** True when a filter's tenantId is a single id (not an operator like $in). */
function isPlainId(v) {
  return v instanceof mongoose.Types.ObjectId || typeof v === 'string';
}

function check(modelName, op, filterTid, ctxTid) {
  if (filterTid) {
    if (ctxTid && isPlainId(filterTid) && String(filterTid) !== String(ctxTid)) {
      throw new TenantIsolationError(`${modelName}.${op}() targeted another tenant`);
    }
    if (ctxTid && !isPlainId(filterTid)) {
      throw new TenantIsolationError(`${modelName}.${op}() used a multi-tenant filter inside a school request`);
    }
    return 'ok';
  }
  if (ctxTid) return 'inject';
  throw new TenantIsolationError(`${modelName}.${op}() executed without tenantId`);
}

module.exports = function tenantPlugin(schema) {
  schema.add({
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true, immutable: true },
  });

  schema.pre(QUERY_OPS, async function enforceTenant() {
    if (this.getOptions().skipTenant) return;
    const ctxTid = tenantContext.get();
    if (check(this.model.modelName, this.op, filterTenant(this.getFilter()), ctxTid) === 'inject') {
      this.where({ tenantId: ctxTid });
    }
  });

  schema.pre('aggregate', async function enforceTenantAggregate() {
    if (this.options && this.options.skipTenant) return;
    const name = this._model ? this._model.modelName : 'Model';
    const ctxTid = tenantContext.get();
    const first = this.pipeline()[0];
    const tid = first && first.$match ? filterTenant(first.$match) : undefined;
    if (check(name, 'aggregate', tid, ctxTid) === 'inject') {
      this.pipeline().unshift({ $match: { tenantId: new mongoose.Types.ObjectId(String(ctxTid)) } });
    }
  });

  schema.pre('validate', async function enforceTenantOnWrite() {
    const ctxTid = tenantContext.get();
    if (!ctxTid) return;
    if (!this.tenantId) this.tenantId = ctxTid;
    else if (String(this.tenantId) !== String(ctxTid)) {
      throw new TenantIsolationError(`${this.constructor.modelName}: cannot write a record for another tenant`);
    }
  });
};

module.exports.TenantIsolationError = TenantIsolationError;
