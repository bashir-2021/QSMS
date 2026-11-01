'use strict';
const { SchoolUser, PlatformUser, Teacher } = require('../models');
const { SCHOOL_ROLES, PLATFORM_ROLES } = require('../config/roles');
const { hashPassword } = require('./authService');
const subscriptionService = require('./subscriptionService');
const { badRequest, conflict, forbidden } = require('../utils/errors');
const { owned, ownedOptional } = require('./scope');

/* ------------------------------ School users ------------------------------ */

const listSchoolUsers = (tenantId) => SchoolUser.find({ tenantId }).populate('teacher', 'fullName teacherCode').sort({ role: 1, name: 1 }).lean();

async function emailTaken(email, exceptId) {
  const f = { email: String(email).toLowerCase().trim() };
  if (exceptId) f._id = { $ne: exceptId };
  const [a, b] = await Promise.all([
    SchoolUser.exists(f).setOptions({ skipTenant: true }),
    PlatformUser.exists(f),
  ]);
  return Boolean(a || b);
}

async function createSchoolUser(ctx, data) {
  if (!SCHOOL_ROLES[data.role]) throw badRequest('Choose a valid role.');
  await subscriptionService.assertLimit(ctx.subscription, ctx.tenantId, 'users');
  if (await emailTaken(data.email)) throw conflict('This email is already used by another account.');
  const teacher = data.role === 'teacher' ? await ownedOptional(Teacher, ctx.tenantId, data.teacher, 'Teacher') : null;
  return SchoolUser.create({
    tenantId: ctx.tenantId, name: data.name, email: data.email, phone: data.phone, role: data.role,
    teacher: teacher ? teacher._id : undefined, passwordHash: await hashPassword(data.password),
  });
}

async function updateSchoolUser(ctx, id, data) {
  const user = await owned(SchoolUser, ctx.tenantId, id, 'User', { lean: false });
  if (!SCHOOL_ROLES[data.role]) throw badRequest('Choose a valid role.');
  const isSelf = String(user._id) === String(ctx.user._id);
  const active = data.isActive === 'on' || data.isActive === 'true';
  if (isSelf && (data.role !== user.role || !active)) throw forbidden('You cannot change your own role or deactivate yourself.');
  if (user.role === 'school_admin' && (data.role !== 'school_admin' || !active)) {
    const admins = await SchoolUser.countDocuments({ tenantId: ctx.tenantId, role: 'school_admin', isActive: true, _id: { $ne: user._id } });
    if (!admins) throw badRequest('The school must keep at least one active administrator.');
  }
  if (active && !user.isActive) await subscriptionService.assertLimit(ctx.subscription, ctx.tenantId, 'users');
  if (data.email && data.email.toLowerCase() !== user.email && await emailTaken(data.email, user._id)) throw conflict('This email is already used by another account.');
  const teacher = data.role === 'teacher' ? await ownedOptional(Teacher, ctx.tenantId, data.teacher, 'Teacher') : null;
  Object.assign(user, { name: data.name, email: data.email, phone: data.phone, role: data.role, isActive: active, teacher: teacher ? teacher._id : undefined });
  if (data.password) user.passwordHash = await hashPassword(data.password);
  await user.save();
  return user;
}

/* ----------------------------- Platform staff ----------------------------- */

const listPlatformUsers = () => PlatformUser.find().sort({ role: 1, name: 1 }).lean();

async function createPlatformUser(data) {
  if (!PLATFORM_ROLES[data.role]) throw badRequest('Choose a valid role.');
  if (await emailTaken(data.email)) throw conflict('This email is already used by another account.');
  return PlatformUser.create({ name: data.name, email: data.email, phone: data.phone, role: data.role, passwordHash: await hashPassword(data.password) });
}

async function updatePlatformUser(actor, id, data) {
  const user = await PlatformUser.findById(id);
  if (!user) throw badRequest('User not found');
  if (!PLATFORM_ROLES[data.role]) throw badRequest('Choose a valid role.');
  const active = data.isActive === 'on' || data.isActive === 'true';
  if (String(user._id) === String(actor._id) && (data.role !== user.role || !active)) throw forbidden('You cannot change your own role or deactivate yourself.');
  if (user.role === 'super_admin' && (data.role !== 'super_admin' || !active)) {
    const others = await PlatformUser.countDocuments({ role: 'super_admin', isActive: true, _id: { $ne: user._id } });
    if (!others) throw badRequest('At least one active Super Admin is required.');
  }
  if (data.email && data.email.toLowerCase() !== user.email && await emailTaken(data.email, user._id)) throw conflict('This email is already used by another account.');
  Object.assign(user, { name: data.name, email: data.email, phone: data.phone, role: data.role, isActive: active });
  if (data.password) user.passwordHash = await hashPassword(data.password);
  await user.save();
  return user;
}

module.exports = { listSchoolUsers, createSchoolUser, updateSchoolUser, listPlatformUsers, createPlatformUser, updatePlatformUser };
