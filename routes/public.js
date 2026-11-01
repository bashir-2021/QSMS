'use strict';
const express = require('express');
const { asyncHandler: h } = require('../utils/errors');
const pub = require('../controllers/publicController');
const auth = require('../controllers/authController');
const v = require('../middleware/validators');
const { handleValidation } = require('../middleware/validate');
const { imageUpload } = require('../middleware/upload');
const { authLimiter, registrationLimiter } = require('../middleware/security');
const { redirectIfAuthenticated } = require('../middleware/auth');

const router = express.Router();

router.get('/', h(pub.home));
router.get('/about', pub.about);
router.get('/features', pub.features);
router.get('/plans', h(pub.plans));
router.get('/contact', pub.contact);
router.post('/contact', registrationLimiter, v.contact, handleValidation('/contact'), h(pub.submitContact));

router.get('/register', redirectIfAuthenticated, h(pub.registerForm));
router.post('/register', registrationLimiter, imageUpload.single('logo'), v.register, handleValidation('/register'), h(pub.register));

router.get('/login', redirectIfAuthenticated, auth.schoolLoginForm);
router.post('/login', authLimiter, v.login, handleValidation('/login'), h(auth.schoolLogin));
router.post('/logout', h(auth.logout));

router.get('/healthz', (req, res) => res.json({ ok: true }));

module.exports = router;
