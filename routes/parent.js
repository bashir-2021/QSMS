'use strict';
const express = require('express');
const { body } = require('express-validator');
const { asyncHandler: h } = require('../utils/errors');
const parent = require('../controllers/parentController');
const { handleValidation } = require('../middleware/validate');
const { authLimiter } = require('../middleware/security');

const router = express.Router();

const signedIn = (req, res, next) => (req.session.auth && req.session.auth.kind === 'parent' ? res.redirect('/parent') : next());
const loginRules = [
  body('phone').trim().notEmpty().withMessage('Enter your phone number'),
  body('password').notEmpty().withMessage('Password is required'),
];

router.get('/login', signedIn, parent.loginForm);
router.post('/login', authLimiter, loginRules, handleValidation('/parent/login'), h(parent.login));
router.get('/choose', parent.chooseForm);
router.post('/choose', authLimiter, h(parent.choose));
router.post('/logout', h(parent.logout));

router.use(parent.loadParentContext);
router.get('/', h(parent.home));
router.get('/children/:id', h(parent.childPage));
router.get('/password', parent.passwordForm);
router.post('/password', authLimiter, h(parent.changePassword));

module.exports = router;
