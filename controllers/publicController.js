'use strict';
const platformService = require('../services/platformService');
const tenantService = require('../services/tenantService');
const authService = require('../services/authService');
const notifications = require('../services/notificationService');
const C = require('../config/constants');
const { Tenant, Student } = require('../models');

const layout = 'layouts/public';

async function home(req, res) {
  const [plans, schools, students] = await Promise.all([
    platformService.listPlans(false),
    Tenant.countDocuments({ status: 'active' }),
    Student.countDocuments({}).setOptions({ skipTenant: true }),
  ]);
  res.render('public/home', { layout, title: 'Quran school management, simplified', plans, stats: { schools, students }, page: 'home' });
}

const about = (req, res) => res.render('public/about', { layout, title: 'About Quranic', page: 'about' });
const features = (req, res) => res.render('public/features', { layout, title: 'Features', page: 'features' });

async function plans(req, res) {
  res.render('public/plans', { layout, title: 'Subscription plans', plans: await platformService.listPlans(false), page: 'plans' });
}

const contact = (req, res) => res.render('public/contact', { layout, title: 'Contact us', page: 'contact' });

async function submitContact(req, res) {
  await notifications.toPlatform({
    type: 'support', level: 'info', roles: ['super_admin', 'support_officer'],
    title: `Website enquiry from ${req.body.name}`,
    message: `${req.body.email}${req.body.phone ? ` · ${req.body.phone}` : ''}\n${req.body.message}`.slice(0, 1000),
  });
  req.flash('success', 'Thank you — our team will contact you shortly.');
  res.redirect('/contact');
}

async function registerForm(req, res) {
  const list = await platformService.listPlans(false);
  res.render('public/register', { layout, title: 'Register your school', plans: list, selectedPlan: req.query.plan || '', page: 'register' });
}

async function register(req, res) {
  const { tenant, admin } = await tenantService.registerSchool(req.body, req.file);
  await authService.establishSession(req, { kind: 'school', userId: String(admin._id), tenantId: String(tenant._id) });
  req.flash('success', req.t('Welcome to Quranic, {name}! {school} is ready.', { name: admin.name, school: tenant.name }));
  res.redirect('/school/dashboard');
}

module.exports = { home, about, features, plans, contact, submitContact, registerForm, register, C };
