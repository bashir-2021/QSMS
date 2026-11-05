'use strict';
const { ClassShift, Class, Student, StudentAttendance } = require('../models');
const { conflict, notFound } = require('../utils/errors');
const { owned } = require('./scope');

/** The shifts a class runs. Students pick from them, and attendance is taken per shift. */

const forClass = (tenantId, classId, { activeOnly = false } = {}) => ClassShift
  .find({ tenantId, class: classId, ...(activeOnly ? { isActive: true } : {}) })
  .sort({ startTime: 1, name: 1 }).lean();

/** Active shifts of every class, as { [classId]: shifts }, for the student form. */
async function activeByClass(tenantId) {
  const shifts = await ClassShift.find({ tenantId, isActive: true }).sort({ startTime: 1, name: 1 }).lean();
  const map = {};
  shifts.forEach((s) => { (map[String(s.class)] = map[String(s.class)] || []).push(s); });
  return map;
}

/** Shifts of a class with how many active students attend each one. */
async function withStudentCounts(tenantId, classId) {
  const [shifts, counts] = await Promise.all([
    forClass(tenantId, classId),
    Student.aggregate([
      { $match: { tenantId, class: classId, status: 'active' } },
      { $unwind: '$shifts' },
      { $group: { _id: '$shifts', n: { $sum: 1 } } },
    ]),
  ]);
  const map = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  return shifts.map((s) => ({ ...s, studentCount: map[String(s._id)] || 0 }));
}

const readFields = (data) => ({ name: data.name, startTime: data.startTime || undefined, endTime: data.endTime || undefined });

/**
 * Keep every student of the class on a register: anyone left without an active shift
 * (older records, or their only shift was closed) goes on all the class's active shifts.
 */
async function placeUnassignedStudents(tenantId, classId) {
  const active = (await forClass(tenantId, classId, { activeOnly: true })).map((s) => s._id);
  if (active.length) await Student.updateMany({ tenantId, class: classId, shifts: { $nin: active } }, { $set: { shifts: active } });
}

async function saveShift(save) {
  try {
    return await save();
  } catch (err) {
    if (err.code === 11000) throw conflict('This class already has a shift with this name.');
    throw err;
  }
}

async function findShift(tenantId, classId, shiftId) {
  const shift = await owned(ClassShift, tenantId, shiftId, 'Shift', { lean: false });
  if (String(shift.class) !== String(classId)) throw notFound('Shift');
  return shift;
}

/** `data.addStudents` also puts the class's current students on the new shift. */
async function create(ctx, classId, data) {
  const cls = await owned(Class, ctx.tenantId, classId, 'Class');
  const shift = await saveShift(() => ClassShift.create({ ...readFields(data), class: cls._id, tenantId: ctx.tenantId }));
  if (data.addStudents) await Student.updateMany({ tenantId: ctx.tenantId, class: cls._id }, { $addToSet: { shifts: shift._id } });
  await placeUnassignedStudents(ctx.tenantId, cls._id);
  return { cls, shift };
}

async function update(ctx, classId, shiftId, data) {
  const shift = await findShift(ctx.tenantId, classId, shiftId);
  Object.assign(shift, readFields(data));
  await saveShift(() => shift.save());
  return shift;
}

async function setActive(ctx, classId, shiftId, isActive) {
  const shift = await findShift(ctx.tenantId, classId, shiftId);
  shift.isActive = isActive;
  await shift.save();
  await placeUnassignedStudents(ctx.tenantId, shift.class);
  return shift;
}

async function remove(ctx, classId, shiftId) {
  const shift = await findShift(ctx.tenantId, classId, shiftId);
  if (await StudentAttendance.exists({ tenantId: ctx.tenantId, shift: shift._id })) {
    throw conflict('This shift has attendance records. Deactivate it instead.');
  }
  await Student.updateMany({ tenantId: ctx.tenantId, class: shift.class }, { $pull: { shifts: shift._id } });
  await ClassShift.deleteOne({ tenantId: ctx.tenantId, _id: shift._id });
  await placeUnassignedStudents(ctx.tenantId, shift.class);
  return shift;
}

module.exports = { forClass, activeByClass, withStudentCounts, create, update, setActive, remove };
