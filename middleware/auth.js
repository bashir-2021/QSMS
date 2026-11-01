'use strict';
const { PlatformUser, SchoolUser, Tenant, SchoolSettings, Subscription } = require('../models');
const { schoolCan, platformCan, SCHOOL_ROLES, PLATFORM_ROLES } = require('../config/roles');
const subscriptionService = require('../services/subscriptionService');
const { forbidden } = require('../utils/errors');
const C = require('../config/constants');
const tenantContext = require('../utils/tenantContext');

/**
 * Session shape: req.session.auth = { kind: 'school' | 'platform', userId, tenantId? }
 * The tenantId used for every school query comes ONLY from this server-side session,
 * never from the request body, query or URL.
 */

async function loadPlatformContext(req, res, next) {
  try {
    const auth = req.session.auth;
    if (!auth || auth.kind !== 'platform') return res.redirect(`/platform/login?next=${encodeURIComponent(req.originalUrl)}`);
    const user = await PlatformUser.findOne({ _id: auth.userId, isActive: true }).lean();
    if (!user) {
      req.session.auth = null;
      return res.redirect('/platform/login');
    }
    req.user = user;
    res.locals.currentUser = user;
    res.locals.roleLabel = PLATFORM_ROLES[user.role].label;
    res.locals.can = (perm) => platformCan(user.role, perm);
    return next();
  } catch (err) {
    return next(err);
  }
}

async function loadSchoolContext(req, res, next) {
  try {
    const auth = req.session.auth;
    if (!auth || auth.kind !== 'school') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    const [user, tenant] = await Promise.all([
      SchoolUser.findOne({ _id: auth.userId, tenantId: auth.tenantId, isActive: true }).lean(),
      Tenant.findOne({ _id: auth.tenantId }).lean(),
    ]);
    if (!user || !tenant) {
      req.session.auth = null;
      return res.redirect('/login');
    }
    const [settings, subscription] = await Promise.all([
      SchoolSettings.findOne({ tenantId: tenant._id }).lean(),
      tenant.currentSubscription ? Subscription.findOne({ _id: tenant.currentSubscription }).lean() : null,
    ]);

    // From here on every query in this request is scoped to the signed-in school.
    tenantContext.set(tenant._id);
    req.user = user;
    req.tenant = tenant;
    req.tenantId = tenant._id;
    req.settings = settings || { currency: 'USD', paymentMethods: [] };
    req.subscription = subscription;
    req.access = subscriptionService.computeAccess(tenant, subscription);

    res.locals.currentUser = user;
    res.locals.tenant = tenant;
    res.locals.settings = req.settings;
    res.locals.currency = req.settings.currency || 'USD';
    res.locals.subscription = subscription;
    res.locals.access = req.access;
    res.locals.roleLabel = SCHOOL_ROLES[user.role].label;
    res.locals.can = (perm) => schoolCan(user.role, perm);
    res.locals.hasFeature = (f) => subscriptionService.hasFeature(subscription, f);
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Enforce the subscription/tenant access policy:
 *  - full: everything allowed
 *  - read_only: only GET requests (school can still see and export its data)
 *  - blocked: only the subscription & account pages
 */
function subscriptionGate(req, res, next) {
  const open = /^\/school\/(subscription|account|logout|notifications)/.test(req.originalUrl);
  if (open || req.access.mode === 'full') return next();
  if (req.access.mode === 'read_only') {
    if (req.method === 'GET') return next();
    req.flash('warning', req.t ? req.t(req.access.messageKey || req.access.message, req.access.messageVars) : req.access.message);
    return res.redirect(req.get('Referrer') || '/school/dashboard');
  }
  return res.status(403).render('school/blocked', {
    title: 'Access restricted', message: req.access.message, messageKey: req.access.messageKey, messageVars: req.access.messageVars,
  });
}

function requirePermission(perm) {
  return (req, res, next) => {
    const ok = req.session.auth.kind === 'platform' ? platformCan(req.user.role, perm) : schoolCan(req.user.role, perm);
    return ok ? next() : next(forbidden());
  };
}

function requireFeature(feature) {
  return (req, res, next) => {
    if (subscriptionService.hasFeature(req.subscription, feature)) return next();
    const err = forbidden('Your subscription plan does not include {feature}. Upgrade your plan to use this module.', { feature });
    // Show the translated module name to non-English users (err.message stays the English text).
    if (req.lang && req.lang !== 'en' && req.t) err.vars = { feature: req.t(C.PLAN_FEATURES[feature] || feature) };
    return next(err);
  };
}

function redirectIfAuthenticated(req, res, next) {
  const auth = req.session.auth;
  if (auth && auth.kind === 'school') return res.redirect('/school/dashboard');
  if (auth && auth.kind === 'platform') return res.redirect('/platform/dashboard');
  return next();
}

module.exports = {
  loadPlatformContext, loadSchoolContext, subscriptionGate, requirePermission, requireFeature, redirectIfAuthenticated,
};
