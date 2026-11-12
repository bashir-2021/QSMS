'use strict';
/** Parent portal: sign in with the guardian phone number, then see each child's lessons, attendance and fees. */
const authService = require('../services/authService');
const parentService = require('../services/parentService');
const subscriptionService = require('../services/subscriptionService');
const { ParentAccount, Tenant, SchoolSettings, Subscription } = require('../models');
const tenantContext = require('../utils/tenantContext');

const layout = 'layouts/parent';

/* --------------------------------- Sign in -------------------------------- */

function loginForm(req, res) {
  res.render('parent/login', { layout, title: 'Parent sign in' });
}

async function login(req, res) {
  const { matches, error } = await parentService.login(req.body.phone, req.body.password);
  if (error) {
    req.flashForm({}, { phone: req.body.phone });
    req.flash('danger', error);
    return res.redirect('/parent/login');
  }
  if (matches.length === 1) {
    const { account, tenant } = matches[0];
    await authService.establishSession(req, { kind: 'parent', accountId: String(account._id), tenantId: String(tenant._id) });
    return res.redirect(account.mustChangePassword ? '/parent/password' : '/parent');
  }
  // children in more than one school: pick one (only the schools the password was right for)
  await authService.establishSession(req, { kind: 'parent-choice', options: matches.map((m) => ({ accountId: String(m.account._id), tenantId: String(m.tenant._id), name: m.tenant.name })) });
  return res.redirect('/parent/choose');
}

function chooseForm(req, res) {
  const auth = req.session.auth;
  if (!auth || auth.kind !== 'parent-choice') return res.redirect('/parent/login');
  return res.render('parent/choose', { layout, title: 'Choose a school', options: auth.options });
}

async function choose(req, res) {
  const auth = req.session.auth;
  const option = auth && auth.kind === 'parent-choice' && auth.options.find((o) => o.accountId === String(req.body.accountId || ''));
  if (!option) return res.redirect('/parent/login');
  const account = await ParentAccount.findOne({ _id: option.accountId, tenantId: option.tenantId }).lean();
  if (!account) return res.redirect('/parent/login');
  await authService.establishSession(req, { kind: 'parent', accountId: option.accountId, tenantId: option.tenantId });
  return res.redirect(account.mustChangePassword ? '/parent/password' : '/parent');
}

async function logout(req, res) {
  await authService.destroySession(req);
  res.clearCookie('quranic.sid');
  res.redirect('/parent/login');
}

/* ------------------------------ Signed-in pages ---------------------------- */

/** Load the parent's account and school for every portal page; until the password is changed, only that page opens. */
async function loadParentContext(req, res, next) {
  try {
    const auth = req.session.auth;
    if (!auth || auth.kind !== 'parent') return res.redirect('/parent/login');
    const [account, tenant] = await Promise.all([
      ParentAccount.findOne({ _id: auth.accountId, tenantId: auth.tenantId, isActive: true }).lean(),
      Tenant.findOne({ _id: auth.tenantId }).lean(),
    ]);
    const sub = tenant && tenant.currentSubscription ? await Subscription.findById(tenant.currentSubscription).lean() : null;
    if (!account || !tenant || subscriptionService.computeAccess(tenant, sub).mode === 'blocked') {
      await authService.destroySession(req);
      req.flash && req.flash('warning', 'Please sign in again.');
      return res.redirect('/parent/login');
    }
    tenantContext.set(tenant._id); // every query in this request is scoped to the parent's school
    const settings = await SchoolSettings.findOne({ tenantId: tenant._id }).lean();
    req.parent = account;
    req.tenant = tenant;
    req.tenantId = tenant._id;
    res.locals.parent = account;
    res.locals.tenant = tenant;
    res.locals.currency = (settings && settings.currency) || 'USD';
    res.locals.finance = subscriptionService.hasFeature(sub, 'finance');
    req.finance = res.locals.finance;
    if (account.mustChangePassword && !/^\/parent\/(password|logout)/.test(req.originalUrl)) return res.redirect('/parent/password');
    return next();
  } catch (err) {
    return next(err);
  }
}

async function home(req, res) {
  const kids = await parentService.overview(req.tenantId, req.parent.phoneKey, { finance: req.finance });
  res.render('parent/index', { layout, title: 'My children', kids });
}

async function childPage(req, res) {
  const data = await parentService.childDetail(req.tenantId, req.parent.phoneKey, req.params.id, { finance: req.finance });
  res.render('parent/child', { layout, title: data.student.fullName, ...data });
}

function passwordForm(req, res) {
  res.render('parent/password', { layout, title: 'Change password', first: req.parent.mustChangePassword });
}

async function changePassword(req, res) {
  try {
    await parentService.changePassword(req.tenantId, req.parent._id, req.body);
  } catch (err) {
    if (err.status !== 400) throw err;
    req.flash('danger', err.i18nKey ? req.t(err.i18nKey, err.vars) : req.t(err.message));
    return res.redirect('/parent/password');
  }
  req.flash('success', 'Your password has been changed.');
  return res.redirect('/parent');
}

module.exports = { loginForm, login, chooseForm, choose, logout, loadParentContext, home, childPage, passwordForm, changePassword };
