const express = require('express');
const router = express.Router();
const authController = require('./auth.controller');
const {
  validateUserSignup,
  validateInitiateUserSignup,
  validateCompleteUserSignup,
  validateVendorSignup,
  validateAdminSignup,
  validateAdminLogin,
  validateLogin,
  validateInitiateLogin,
  validateCompleteLogin,
  validateOTP,
  validateResetPIN,
  validateVerifyResetOTP,
  validateCompleteResetPIN,
} = require('../../validators/auth.validator');
const { authLimiter, otpLimiter } = require('../../middlewares/rateLimiter.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');

// ======================== USER ROUTES ========================
router.post('/users/signup', authLimiter, validateUserSignup, authController.userSignup);
router.post('/users/initiate-signup', authLimiter, validateInitiateUserSignup, authController.userInitiateSignup);
router.post('/users/complete-signup', authLimiter, validateCompleteUserSignup, authController.userCompleteSignup);
router.post('/users/verify-otp', authLimiter, validateOTP, authController.userVerifyOTP);
router.post('/users/login', authLimiter, validateLogin, authController.userLogin);
router.post('/users/initiate-login', authLimiter, validateInitiateLogin, authController.userInitiateLogin);
router.post('/users/complete-login', authLimiter, validateCompleteLogin, authController.userCompleteLogin);
router.post('/users/send-otp', otpLimiter, authController.userSendOTP);
router.post('/users/verify-reset-otp', authLimiter, validateVerifyResetOTP, authController.userVerifyResetOTP);
router.post('/users/complete-reset-pin', authLimiter, validateCompleteResetPIN, authController.userCompleteResetPIN);
router.post('/users/reset-pin', authLimiter, validateResetPIN, authController.userResetPIN);
router.post('/users/logout', authController.userLogout);

// ======================== VENDOR ROUTES ========================
router.post('/vendors/signup', authLimiter, validateVendorSignup, authController.vendorSignup);
router.post('/vendors/verify-otp', authLimiter, validateOTP, authController.vendorVerifyOTP);
router.post('/vendors/login', authLimiter, validateLogin, authController.vendorLogin);
router.post('/vendors/send-otp', otpLimiter, authController.vendorSendOTP);
router.post('/vendors/reset-pin', authLimiter, validateResetPIN, authController.vendorResetPIN);
router.post('/vendors/logout', authController.vendorLogout);

// ======================== ADMIN ROUTES ========================
router.post('/admins/signup', authLimiter, validateAdminSignup, authController.adminSignup);
router.post('/admins/login', authLimiter, validateAdminLogin, authController.adminLogin);
router.patch('/admins/reset-password/:adminId', authenticate, authorize(ROLES.SUPER_ADMIN), authController.adminResetPassword);
router.post('/admins/logout', authController.adminLogout);

// ======================== COMMON ROUTES (All roles) ========================
router.post('/refresh-token', authController.refreshToken);
router.post('/send-home-sms', authenticate, authController.sendHomeSMS);

// ======================== BACKWARD COMPATIBILITY (deprecated) ========================
// Old generic endpoints - map to user role for backward compatibility
router.post('/verify-otp', authLimiter, validateOTP, authController.userVerifyOTP);
router.post('/login', authLimiter, validateLogin, authController.userLogin);
router.post('/send-otp', otpLimiter, authController.userSendOTP);
router.post('/reset-pin', authLimiter, validateResetPIN, authController.userResetPIN);
router.post('/logout', authController.userLogout);

// Old signup endpoint
router.post('/signup', authLimiter, validateUserSignup, authController.userSignup);

module.exports = router;

