'use strict';
/** Single import point for every model: `const { Student, Tenant } = require('../models');` */
module.exports = {
  ...require('./platform'),
  ...require('./school'),
  ...require('./academic'),
  ...require('./finance'),
};
