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

// ******

const userVerifyPin = asyncHandler(async (req, res) => {
  const { pin } = req.body;
  const result = await authService.verifyUserPin(req.user.id, pin);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const userUpdatePin = asyncHandler(async (req, res) => {
  const { oldPin, newPin, confirmPin } = req.body;
  const result = await authService.updateUserPin(req.user.id, oldPin, newPin, confirmPin);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const userVerifyContact = asyncHandler(async (req, res) => {
  const { email, phoneNumber } = req.body;
  const result = await authService.verifyUserContact(email, phoneNumber);
  res.status(200).json(new ApiResponse(200, result, result.message));
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

const vendorVerifyPin = asyncHandler(async (req, res) => {
  const { pin } = req.body;
  const result = await authService.verifyVendorPin(req.user.id, pin);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const vendorUpdatePin = asyncHandler(async (req, res) => {
  const { oldPin, newPin, confirmPin } = req.body;
  const result = await authService.updateVendorPin(req.user.id, oldPin, newPin, confirmPin);
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const vendorVerifyContact = asyncHandler(async (req, res) => {
  const { email, phoneNumber } = req.body;
  const result = await authService.verifyVendorContact(email, phoneNumber);
  res.status(200).json(new ApiResponse(200, result, result.message));
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

const adminChangePassword = asyncHandler(async (req, res) => {
  const result = await authService.adminChangePassword(req.user.id, req.body);
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

const sendUserPhoneOtp = asyncHandler(async (req, res) => {
  const { phoneNumber } = req.body;
  const result = await authService.sendPhoneOtp(phoneNumber, 'user');
  res.status(200).json(new ApiResponse(200, result, MESSAGES.AUTH.OTP_SENT));
});

const verifyUserPhoneOtp = asyncHandler(async (req, res) => {
  const { id, otp } = req.body;
  const result = await authService.verifyPhoneOtp(id, otp, 'user');
  res.status(200).json(new ApiResponse(200, result, 'OTP verified successfully'));
});

const sendVendorPhoneOtp = asyncHandler(async (req, res) => {
  const { phoneNumber } = req.body;
  const result = await authService.sendPhoneOtp(phoneNumber, 'vendor');
  res.status(200).json(new ApiResponse(200, result, MESSAGES.AUTH.OTP_SENT));
});

const verifyVendorPhoneOtp = asyncHandler(async (req, res) => {
  const { id, otp } = req.body;
  const result = await authService.verifyPhoneOtp(id, otp, 'vendor');
  res.status(200).json(new ApiResponse(200, result, 'OTP verified successfully'));
});

const userForgotPin = asyncHandler(async (req, res) => {
  const { id, newPin, confirmPin } = req.body;
  const result = await authService.forgotPin(id, newPin, confirmPin, 'user');
  res.status(200).json(new ApiResponse(200, result, result.message));
});

const vendorForgotPin = asyncHandler(async (req, res) => {
  const { id, newPin, confirmPin } = req.body;
  const result = await authService.forgotPin(id, newPin, confirmPin, 'vendor');
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
  userVerifyPin,
  userUpdatePin,
  userVerifyContact,
  sendUserPhoneOtp,
  verifyUserPhoneOtp,
  userForgotPin,
  // Vendor
  vendorSignup,
  vendorCompleteSignup,
  vendorLogin,
  vendorInitiateLogin,
  vendorCompleteLogin,
  vendorSendOTP,
  vendorResetPIN,
  vendorLogout,
  vendorVerifyPin,
  vendorUpdatePin,
  vendorVerifyContact,
  sendVendorPhoneOtp,
  verifyVendorPhoneOtp,
  vendorForgotPin,
  // Admin
  adminSignup,
  adminLogin,
  adminLogout,
  adminResetPassword,
  adminChangePassword,
  // Common
  refreshToken,
  sendHomeSMS,
};

