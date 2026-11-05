'use strict';
const { SchoolSettings, Tenant, ExpenseCategory, Expense } = require('../models');
const money = require('../utils/money');
const { persistUpload, removeStored } = require('../middleware/upload');
const { badRequest, conflict, notFound } = require('../utils/errors');
const { owned } = require('./scope');
const C = require('../config/constants');

async function get(tenantId) {
  let s = await SchoolSettings.findOne({ tenantId });
  if (!s) s = await SchoolSettings.create({ tenantId });
  return s;
}

async function updateProfile(tenantId, data, logoFile) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw notFound('School');
  ['name', 'country', 'city', 'address', 'phone', 'email'].forEach((k) => { if (data[k] !== undefined) tenant[k] = data[k]; });
  if (logoFile) {
    const old = tenant.logo;
    tenant.logo = persistUpload(logoFile, tenantId, 'logo');
    if (old) removeStored(old);
  }
  await tenant.save();
  return tenant;
}

async function updateSettings(tenantId, data) {
  const s = await get(tenantId);
  const regFee = money.toMinor(data.registrationFee);
  const monthlyFee = money.toMinor(data.monthlyFee);
  if (regFee === null || regFee < 0 || monthlyFee === null || monthlyFee < 0) throw badRequest('Fees must be valid non-negative amounts.');
  s.academicYear = data.academicYear;
  s.currency = String(data.currency || 'USD').toUpperCase();
  s.registrationFee = regFee;
  s.monthlyFee = monthlyFee;
  s.billingDueDay = parseInt(data.billingDueDay, 10) || 10;
  s.paymentMethods = String(data.paymentMethods || '').split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
  if (!s.paymentMethods.length) throw badRequest('Add at least one payment method.');
  const fmt = (v, d) => {
    const f = String(v || '').trim();
    if (!f) return d;
    if (!/\{SEQ(:\d)?\}/.test(f)) throw badRequest('Number format "{format}" must contain {SEQ} or {SEQ:n}.', null, { format: f });
    if (f.length > 40) throw badRequest('Number formats must be 40 characters or fewer.');
    return f;
  };
  ['student', 'teacher', 'invoice', 'receipt', 'payment', 'expense'].forEach((k) => {
    s.numbering[k] = fmt(data[`numbering_${k}`], s.numbering[k]);
  });
  s.receiptFooter = data.receiptFooter;
  await s.save();
  return s;
}

/* ----------------------------- Subac deductions --------------------------- */

/** Points lost per occurrence for each Subac error, falling back to the defaults. */
function subacRates(settings) {
  const saved = (settings && settings.subacDeductions) || {};
  return Object.fromEntries(Object.entries(C.SUBAC_DEDUCTIONS).map(([key, d]) => [key, typeof saved[key] === 'number' ? saved[key] : d.points]));
}

async function updateSubacDeductions(tenantId, data) {
  const s = await get(tenantId);
  Object.keys(C.SUBAC_DEDUCTIONS).forEach((key) => {
    const points = Number(data[key]);
    if (!Number.isFinite(points) || points < 0 || points > 100) throw badRequest('Deduction points must be between 0 and 100.');
    s.subacDeductions[key] = points;
  });
  await s.save();
  return s;
}

/* --------------------------- Expense categories --------------------------- */

const listCategories = (tenantId, { activeOnly = false } = {}) => ExpenseCategory
  .find({ tenantId, ...(activeOnly ? { isActive: true } : {}) }).sort({ name: 1 }).lean();

async function createCategory(tenantId, { name, description }) {
  if (await ExpenseCategory.exists({ tenantId, name: new RegExp(`^${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })) {
    throw conflict('A category with this name already exists.');
  }
  return ExpenseCategory.create({ tenantId, name, description });
}

async function updateCategory(tenantId, id, { name, description, isActive }) {
  const cat = await owned(ExpenseCategory, tenantId, id, 'Category', { lean: false });
  if (cat.isSystem && name && name !== cat.name) throw badRequest('System categories cannot be renamed.');
  if (name) cat.name = name;
  cat.description = description;
  if (!cat.isSystem) cat.isActive = isActive === 'on' || isActive === true || isActive === 'true';
  await cat.save();
  return cat;
}

async function deleteCategory(tenantId, id) {
  const cat = await owned(ExpenseCategory, tenantId, id, 'Category', { lean: false });
  if (cat.isSystem) throw badRequest('System categories cannot be deleted.');
  if (await Expense.exists({ tenantId, category: cat._id })) throw conflict('This category has expenses. Deactivate it instead.');
  await ExpenseCategory.deleteOne({ tenantId, _id: cat._id });
}

module.exports = { get, updateProfile, updateSettings, subacRates, updateSubacDeductions, listCategories, createCategory, updateCategory, deleteCategory };
