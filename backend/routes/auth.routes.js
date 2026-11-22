// backend/routes/auth.routes.js
const express = require('express');
const router = express.Router();
// Bổ sung updateProfile
const { registerUser, loginUser, logoutUser, getMe, verifyEKYC, updateProfile, forgotPassword, resetPassword } = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth.middleware');
const {
  loginLimiter,
  forgotPasswordLimiter,
  aiLimiter
} = require('../middleware/rateLimit.middleware');

router.post('/register', registerUser);
router.post('/login', loginLimiter, loginUser);
router.post('/logout', protect, logoutUser);
router.get('/me', protect, getMe);

// >>> THÊM ROUTE UPDATE PROFILE <<<
router.put('/profile', protect, updateProfile);

router.post('/verify-ekyc', aiLimiter, protect, verifyEKYC);

router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);
router.put('/reset-password/:token', forgotPasswordLimiter, resetPassword);

module.exports = router;