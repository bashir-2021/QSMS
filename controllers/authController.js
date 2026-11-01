'use strict';
const authService = require('../services/authService');
const audit = require('../services/auditService');
const { SchoolUser, PlatformUser } = require('../models');

const layout = 'layouts/public';

/** Only allow local redirect targets after login (prevents open redirects). */
function safeNext(next, prefix) {
  return typeof next === 'string' && next.startsWith(prefix) && !next.startsWith('//') ? next : null;
}

const schoolLoginForm = (req, res) => res.render('auth/login', { layout, title: 'Sign in', mode: 'school', next: req.query.next || '', page: 'login' });

async function schoolLogin(req, res) {
  const { user, tenant, error } = await authService.loginSchoolUser(req.body.email, req.body.password);
  if (error) {
    req.flashForm({}, { email: req.body.email });
    req.flash('danger', error);
    return res.redirect('/login');
  }
  await authService.establishSession(req, { kind: 'school', userId: String(user._id), tenantId: String(tenant._id) });
  req.tenantId = tenant._id;
  req.user = user;
  await audit.school(req, 'user.login', { entity: 'SchoolUser', entityId: user._id });
  return res.redirect(safeNext(req.body.next, '/school/') || '/school/dashboard');
}

const platformLoginForm = (req, res) => res.render('auth/login', { layout, title: 'Platform sign in', mode: 'platform', next: req.query.next || '', page: 'login' });

async function platformLogin(req, res) {
  const { user, error } = await authService.loginPlatformUser(req.body.email, req.body.password);
  if (error) {
    req.flashForm({}, { email: req.body.email });
    req.flash('danger', error);
    return res.redirect('/platform/login');
  }
  await authService.establishSession(req, { kind: 'platform', userId: String(user._id) });
  req.user = user;
  await audit.platform(req, 'user.login', { entity: 'PlatformUser', entityId: user._id });
  return res.redirect(safeNext(req.body.next, '/platform/') || '/platform/dashboard');
}

async function logout(req, res) {
  const kind = req.session.auth && req.session.auth.kind;
  await authService.destroySession(req);
  res.clearCookie('quranic.sid');
  res.redirect(kind === 'platform' ? '/platform/login' : '/login');
}

/* ----------------------------- Account pages ------------------------------ */

function accountPage(kind) {
  return (req, res) => res.render(`${kind}/account`, { title: 'My account' });
}

function changePassword(kind) {
  return async (req, res) => {
    const Model = kind === 'school' ? SchoolUser : PlatformUser;
    const filter = kind === 'school' ? { _id: req.user._id, tenantId: req.tenantId } : { _id: req.user._id };
    const { error } = await authService.changePassword(Model, filter, req.body.currentPassword, req.body.newPassword);
    if (error) {
      req.flash('danger', error);
    } else {
      req.flash('success', 'Your password has been changed.');
      if (kind === 'school') await audit.school(req, 'user.password_change', { entity: 'SchoolUser', entityId: req.user._id });
      else await audit.platform(req, 'user.password_change', { entity: 'PlatformUser', entityId: req.user._id });
    }
    res.redirect(`/${kind}/account`);
  };
}

module.exports = { schoolLoginForm, schoolLogin, platformLoginForm, platformLogin, logout, accountPage, changePassword };
