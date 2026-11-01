'use strict';
const { Notification } = require('../models');

/**
 * In-app notifications. `channels` is stored so email / WhatsApp senders can later be
 * added as dispatchers without changing callers (see `dispatchers` below).
 */
const dispatchers = {
  in_app: async () => {}, // stored in MongoDB; nothing else to do
  // email: async (n) => mailer.send(...),
  // whatsapp: async (n) => whatsappClient.send(...),
};

async function create(data) {
  try {
    const n = await Notification.create(data);
    await Promise.all((n.channels || []).map((c) => (dispatchers[c] ? dispatchers[c](n) : null)));
    return n;
  } catch (err) {
    if (err.code === 11000) return null; // dedupeKey already sent
    throw err;
  }
}

const toSchool = (tenantId, data) => create({ ...data, audience: 'school', tenantId });
const toPlatform = (data) => create({ ...data, audience: 'platform' });

function visibilityFilter(audience, user, tenantId) {
  const f = { audience, $or: [{ roles: { $size: 0 } }, { roles: user.role }] };
  if (audience === 'school') f.tenantId = tenantId;
  return f;
}

async function listFor(audience, user, tenantId, { limit = 50 } = {}) {
  const items = await Notification.find(visibilityFilter(audience, user, tenantId)).sort({ createdAt: -1 }).limit(limit).lean();
  return items.map((n) => ({ ...n, isRead: (n.readBy || []).some((id) => String(id) === String(user._id)) }));
}

async function unreadCount(audience, user, tenantId) {
  return Notification.countDocuments({ ...visibilityFilter(audience, user, tenantId), readBy: { $ne: user._id } });
}

async function markRead(audience, user, tenantId, id) {
  const f = visibilityFilter(audience, user, tenantId);
  if (id) f._id = id;
  await Notification.updateMany(f, { $addToSet: { readBy: user._id } });
}

module.exports = { toSchool, toPlatform, listFor, unreadCount, markRead };
