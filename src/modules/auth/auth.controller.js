const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const authService = require('./auth.service');
const MESSAGES = require('../../constants/messages');
const User = require('../../models/User.model');
const Vendor = require('../../models/Vendor.model');

// ======================== USER CONTROLLERS ========================

const userSignup = asyncHandler(async (req, res) => {
  const result = await authService.userSignup(req.body);
  res.status(201).json(new ApiResponse(201, result, result.message));
});

const userInitiateSignup = asyncHandler(async (req, res) => {
  const result = await authService.initiateUserSignup(req.body);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const userCompleteSignup = asyncHandler(async (req, res) => {
  const { signupId, pin, confirmPin, acceptedPolicies, fcmToken, deviceId } = req.body;
  const result = await authService.completeUserSignup({ signupId, pin, confirmPin, acceptedPolicies, fcmToken, deviceId }, req);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const userVerifyOTP = asyncHandler(async (req, res) => {
  const { phoneNumber, otp } = req.body;
  const result = await authService.verifySignupOTP(phoneNumber, otp, 'user', req);
  res.status(200).json(new ApiResponse(200, result, 'Verification successful'));
});

const userLogin = asyncHandler(async (req, res) => {
  const { phoneNumber, pin, fcmToken, deviceId } = req.body;
  const result = await authService.login(phoneNumber, pin, 'user', req, fcmToken, deviceId);
  res.status(200).json(new ApiResponse(200, result, MESSAGES.AUTH.LOGIN_SUCCESS));
});

const userInitiateLogin = asyncHandler(async (req, res) => {
  const result = await authService.initiateUserLogin(req.body);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const userCompleteLogin = asyncHandler(async (req, res) => {
  const result = await authService.completeUserLogin(req.body, req);
  res.status(200).json(new ApiResponse(200, result, MESSAGES.AUTH.LOGIN_SUCCESS));
});

const userSendOTP = asyncHandler(async (req, res) => {
  const { phoneNumber } = req.body;
  const result = await authService.sendOTP(phoneNumber, 'user');
  res.status(200).json(new ApiResponse(200, result, MESSAGES.AUTH.OTP_SENT));
});

const userVerifyResetOTP = asyncHandler(async (req, res) => {
  const result = await authService.verifyResetPINOTP(req.body);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const userCompleteResetPIN = asyncHandler(async (req, res) => {
  const result = await authService.completeResetPIN(req.body, req);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const userResetPIN = asyncHandler(async (req, res) => {
  const { phoneNumber, otp, newPin, pin, confirmPin } = req.body;
  const targetPin = newPin || pin;
  const result = await authService.resetPIN(phoneNumber, otp, targetPin, confirmPin, 'user', req);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const userLogout = asyncHandler(async (req, res) => {
  // Clear the user's currentLoginId, FCM token, and deviceId to allow future logins and stop push notifications
  const userId = req.user?.id;
  if (userId) {
    await User.findByIdAndUpdate(userId, {
      $unset: { currentLoginId: 1, fcmToken: 1, deviceId: 1 }
    });
  }
  res.status(200).json(new ApiResponse(200, null, MESSAGES.AUTH.LOGOUT_SUCCESS));
});

// ======================== VENDOR CONTROLLERS ========================

const vendorSignup = asyncHandler(async (req, res) => {
  const result = await authService.vendorSignup(req.body);
  res.status(201).json(new ApiResponse(201, result, result.message));
});

const vendorCompleteSignup = asyncHandler(async (req, res) => {
  const { signupId, pin, confirmPin, acceptedTerms, acceptedPrivacyPolicy, fcmToken, deviceId } = req.body;
  const result = await authService.completeVendorSignup({ signupId, pin, confirmPin, acceptedTerms, acceptedPrivacyPolicy, fcmToken, deviceId });
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const vendorLogin = asyncHandler(async (req, res) => {
  const { phoneNumber, pin, fcmToken, deviceId } = req.body;
  const result = await authService.login(phoneNumber, pin, 'vendor', req, fcmToken, deviceId);
  res.status(200).json(new ApiResponse(200, result, MESSAGES.AUTH.LOGIN_SUCCESS));
});

const vendorInitiateLogin = asyncHandler(async (req, res) => {
  const result = await authService.initiateVendorLogin(req.body);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const vendorCompleteLogin = asyncHandler(async (req, res) => {
  const result = await authService.completeVendorLogin(req.body, req);
  res.status(200).json(new ApiResponse(200, result, MESSAGES.AUTH.LOGIN_SUCCESS));
});

const vendorSendOTP = asyncHandler(async (req, res) => {
  const { phoneNumber } = req.body;
  const result = await authService.sendOTP(phoneNumber, 'vendor');
  res.status(200).json(new ApiResponse(200, result, MESSAGES.AUTH.OTP_SENT));
});

const vendorResetPIN = asyncHandler(async (req, res) => {
  const { phoneNumber, otp, newPin, pin, confirmPin } = req.body;
  const targetPin = newPin || pin;
  const result = await authService.resetPIN(phoneNumber, otp, targetPin, confirmPin, 'vendor', req);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const vendorLogout = asyncHandler(async (req, res) => {
  // Clear the vendor's currentLoginId, FCM token, and deviceId to allow future logins and stop push notifications
  const vendorId = req.user?.id;
  if (vendorId) {
    await Vendor.findByIdAndUpdate(vendorId, {
      $unset: { currentLoginId: 1, fcmToken: 1, deviceId: 1 }
    });
  }
  res.status(200).json(new ApiResponse(200, null, MESSAGES.AUTH.LOGOUT_SUCCESS));
});

// ======================== ADMIN CONTROLLERS ========================

const adminSignup = asyncHandler(async (req, res) => {
  const result = await authService.adminSignup(req.body);
  res.status(201).json(new ApiResponse(201, result, result.message));
});

const adminLogin = asyncHandler(async (req, res) => {
  const result = await authService.adminLogin(req.body, req);
  res.status(200).json(new ApiResponse(200, result, MESSAGES.AUTH.LOGIN_SUCCESS));
});

const adminLogout = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, null, MESSAGES.AUTH.LOGOUT_SUCCESS));
});

const adminResetPassword = asyncHandler(async (req, res) => {
  const { adminId } = req.params;
  const result = await authService.superAdminResetPassword(adminId, req.body, req);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

// ======================== COMMON CONTROLLERS ========================

const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  const result = await authService.refreshToken(refreshToken);
  res.status(200).json(new ApiResponse(200, result, 'Token refreshed successfully'));
});

const sendHomeSMS = asyncHandler(async (req, res) => {
  const result = await authService.sendPostLoginSMS(req.user.userId, req.user.role);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

module.exports = {
  // User
  userSignup,
  userInitiateSignup,
  userCompleteSignup,
  userVerifyOTP,
  userLogin,
  userInitiateLogin,
  userCompleteLogin,
  userSendOTP,
  userVerifyResetOTP,
  userCompleteResetPIN,
  userResetPIN,
  userLogout,
  // Vendor
  vendorSignup,
  vendorCompleteSignup,
  vendorLogin,
  vendorInitiateLogin,
  vendorCompleteLogin,
  vendorSendOTP,
  vendorResetPIN,
  vendorLogout,
  // Admin
  adminSignup,
  adminLogin,
  adminLogout,
  adminResetPassword,
  // Common
  refreshToken,
  sendHomeSMS,
};

