'use strict';
const { AsyncLocalStorage } = require('async_hooks');

/**
 * Per-request tenant context (AsyncLocalStorage).
 * The school auth middleware stores the signed-in school's tenantId here; the tenant plugin
 * uses it to (a) scope queries that don't name a tenant — e.g. Mongoose populate() — and
 * (b) refuse any query or write that names a *different* tenant.
 */
const als = new AsyncLocalStorage();

/** Express middleware: open an empty context for every request. */
function middleware(req, res, next) {
  als.run({ tenantId: null }, next);
}

function get() {
  const store = als.getStore();
  return store && store.tenantId ? store.tenantId : null;
}

function set(tenantId) {
  const store = als.getStore();
  if (store) store.tenantId = tenantId;
}

/** Run `fn` with a tenant context (used by scripts, jobs and tests). */
function run(tenantId, fn) {
  return als.run({ tenantId }, fn);
}

module.exports = { middleware, get, set, run };
