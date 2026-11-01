'use strict';
const { SchoolAuditLog, PlatformAuditLog } = require('../models');

/**
 * Audit logging. Failures to write an audit entry are logged but never break the
 * user's request — except inside a financial transaction, where the session is passed
 * so the audit entry commits atomically with the money movement.
 */
async function school(req, action, { entity, entityId, details, session } = {}) {
  try {
    await SchoolAuditLog.create([{
      tenantId: req.tenantId,
      user: req.user && req.user._id,
      userName: req.user && req.user.name,
      action, entity, entityId, details,
      ip: req.ip,
    }], session ? { session } : undefined);
  } catch (err) {
    if (session) throw err;
    console.error('[audit] failed to write school audit log', err.message);
  }
}

async function platform(req, action, { entity, entityId, tenant, details } = {}) {
  try {
    await PlatformAuditLog.create({
      actor: req.user && req.user._id,
      actorName: req.user ? req.user.name : 'system',
      action, entity, entityId, tenant, details,
      ip: req.ip,
    });
  } catch (err) {
    console.error('[audit] failed to write platform audit log', err.message);
  }
}

module.exports = { school, platform };
