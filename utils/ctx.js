'use strict';
/** The server-side school context passed to services. tenantId comes from the session only. */
module.exports = function ctx(req) {
  return {
    tenantId: req.tenantId,
    tenant: req.tenant,
    user: req.user,
    settings: req.settings,
    subscription: req.subscription,
  };
};
