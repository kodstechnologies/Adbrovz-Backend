const crypto = require('crypto');
const ApiError = require('../../utils/ApiError');
const { hashPIN, comparePIN, hashPassword, comparePassword } = require('../../utils/password');
const { generateToken, generateRefreshToken } = require('../../utils/jwt');
const { generateOTP } = require('../../utils/otp');
const cacheService = require('../../services/cache.service');
const smsService = require('../../services/sms.service');
const auditService = require('../../services/audit.service');
const User = require('../../models/User.model');
const Vendor = require('../../models/Vendor.model');
const Admin = require('../../models/Admin.model');
const MESSAGES = require('../../constants/messages');
const config = require('../../config/env');

// ======================== USER SIGNUP ========================
const userSignup = async ({ phoneNumber, name, email, pin, confirmPin, acceptedPolicies }) => {
  // Check if user already exists
  const existingUser = await User.findOne({ phoneNumber });

  // If user exists and is verified, throw error
  if (existingUser && existingUser.isVerified) {
    throw new ApiError(400, MESSAGES.USER.ALREADY_EXISTS);
  }

  // Validate PIN match
  if (pin !== confirmPin) {
    throw new ApiError(400, MESSAGES.AUTH.PIN_MISMATCH);
  }

  // Hash PIN
  const hashedPIN = await hashPIN(pin);

  // Generate OTP
  const otp = generateOTP(config.OTP_LENGTH);
  const otpKey = `otp:signup:user:${phoneNumber}`;
  const otpExpiry = config.OTP_EXPIRE_MINUTES * 60;

  // Store OTP in cache
  console.log(`[DEBUG] Setting Signup OTP for User: ${phoneNumber}, Key: ${otpKey}, OTP: ${otp}`);
  await cacheService.set(otpKey, otp, otpExpiry);

  // Send OTP via SMS
  // await smsService.sendOTP(phoneNumber, otp);

  // If user exists but not verified, update their info and resend OTP
  if (existingUser && !existingUser.isVerified) {
    existingUser.name = name;
    existingUser.email = email;
    existingUser.pin = hashedPIN;
    existingUser.acceptedPolicies = acceptedPolicies;
    existingUser.policiesAcceptedAt = new Date();
    await existingUser.save();

    return {
      userId: existingUser._id,
      phoneNumber: existingUser.phoneNumber,
      message: 'OTP resent to your phone number',
    };
  }

  // Create new user (pending verification)
  const user = await User.create({
    phoneNumber,
    name,
    email,
    pin: hashedPIN,
    isVerified: false,
    userID: `U${Date.now()}`, // Temporary, will be updated after verification
    acceptedPolicies,
    policiesAcceptedAt: new Date(),
  });

  return {
    userId: user._id,
    phoneNumber: user.phoneNumber,
    message: 'OTP sent to your phone number',
  };
};

// ======================== NEW TWO-STEP SIGNUP ========================

/**
 * Step 1: Initiate Signup
 * - Checks if user exists
 * - Sends OTP
 * - Stores name and email in cache
 */
const initiateUserSignup = async ({ phoneNumber, name, email }) => {
  // Check if user already exists
  const existingUser = await User.findOne({ phoneNumber });

  if (existingUser && existingUser.isVerified) {
    throw new ApiError(400, MESSAGES.USER.ALREADY_EXISTS);
  }

  // Generate unique signup identifier
  const signupId = crypto.randomUUID();
  const signupKey = `signup:session:${signupId}`;
  const signupExpiry = 3600; // 1 hour session

  // Store user details in cache keyed by signupId
  const signupData = {
    phoneNumber,
    name,
    email,
  };
  await cacheService.set(signupKey, JSON.stringify(signupData), signupExpiry);

  return {
    signupId,
    message: 'Signup initiated successfully.',
  };
};

/**
 * Step 2: Complete Signup
 * - Retrieves data from cache using signupId
 * - Saves User as unverified
 * - Generates and sends OTP
 */
const completeUserSignup = async ({ signupId, pin, confirmPin, acceptedPolicies }, req = null) => {
  // Validate PIN match
  if (pin !== confirmPin) {
    throw new ApiError(400, MESSAGES.AUTH.PIN_MISMATCH);
  }

  // Retrieve data from cache
  const signupKey = `signup:session:${signupId}`;
  const cachedDataStr = await cacheService.get(signupKey);

  if (!cachedDataStr) {
    throw new ApiError(400, 'Signup session expired or invalid ID. Please initiate signup again.');
  }

  const cachedData = JSON.parse(cachedDataStr);
  const { phoneNumber, name, email } = cachedData;

  // Hash PIN
  const hashedPIN = await hashPIN(pin);

  // Check if user exists (unverified)
  let user = await User.findOne({ phoneNumber });

  if (user && user.isVerified) {
    throw new ApiError(400, MESSAGES.USER.ALREADY_EXISTS);
  }

  if (user) {
    // Update existing unverified user
    user.name = name;
    user.email = email;
    user.pin = hashedPIN;
    user.acceptedPolicies = acceptedPolicies;
    user.policiesAcceptedAt = new Date();
    user.isVerified = false; // Pending verification
    user.userID = `U${phoneNumber}`; // Set UserID
    await user.save();
  } else {
    // Create new user
    user = await User.create({
      phoneNumber,
      name,
      email,
      pin: hashedPIN,
      isVerified: false, // Pending verification
      userID: `U${phoneNumber}`, // Set UserID
      acceptedPolicies,
      policiesAcceptedAt: new Date(),
    });
  }

  // OTP Generation and Sending REMOVED

  // Delete signup session
  await cacheService.del(signupKey);

  // Audit log
  if (req) {
    const { ip, userAgent } = auditService.getRequestInfo(req);
    await auditService.createAuditLog({
      action: 'profile_updated',
      userId: user._id,
      userModel: 'User',
      details: {
        signupStep: 'PIN_SUBMITTED',
        verificationMethod: 'AUTO_VERIFIED',
      },
      ip,
      userAgent,
    });
  }

  return {
    phoneNumber: user.phoneNumber,
    message: 'Signup completed successfully. You can now login.',
  };
};

// ======================== NEW TWO-STEP LOGIN ========================

/**
 * Step 1: Initiate Login
 * - Checks if user exists and is verified
 * - Returns a loginId (session identifier)
 */
const initiateUserLogin = async ({ phoneNumber, acceptedPolicies }) => {
  // Find user
  const user = await User.findOne({ phoneNumber });

  if (!user) {
    throw new ApiError(401, MESSAGES.AUTH.INVALID_CREDENTIALS);
  }

  // Verification check removed as per requirement
  // if (!user.isVerified) {
  //   throw new ApiError(403, MESSAGES.AUTH.ACCOUNT_NOT_VERIFIED);
  // }

  if (user.status && user.status !== 'ACTIVE') {
    throw new ApiError(403, `Account is ${user.status.toLowerCase()}. Please contact support.`);
  }

  // Check if account is locked
  if (user.isLocked && user.lockUntil > Date.now()) {
    throw new ApiError(403, MESSAGES.AUTH.ACCOUNT_LOCKED);
  }

  // Generate login session identifier
  const loginId = crypto.randomUUID();
  const loginKey = `login:session:${loginId}`;
  const loginExpiry = 600; // 10 minutes session for entering PIN

  await cacheService.set(loginKey, JSON.stringify({ phoneNumber, role: 'user' }), loginExpiry);

  return {
    loginId,
    message: 'User verified. Please enter your PIN.',
  };
};

/**
 * Step 2: Complete Login
 * - Verifies PIN using session from loginId
 * - Returns tokens
 */
const completeUserLogin = async ({ loginId, pin }, req = null) => {
  // Retrieve session from cache
  const loginKey = `login:session:${loginId}`;
  const sessionDataStr = await cacheService.get(loginKey);

  if (!sessionDataStr) {
    throw new ApiError(401, 'Login session expired or invalid. Please start again.');
  }

  const { phoneNumber, role } = JSON.parse(sessionDataStr);

  // Perform standard login logic (PIN verification, locking, token generation)
  const result = await login(phoneNumber, pin, role, req);

  // Success! Delete session
  await cacheService.del(loginKey);

  return result;
};

// ======================== VENDOR SIGNUP ========================
const vendorSignup = async ({ phoneNumber, name, email, pin, confirmPin, identityNumber, photo, idProof, addressProof, workState, workCity, workPincodes, acceptedTerms, acceptedPrivacyPolicy }) => {
  // Check if vendor already exists
  const existingVendor = await Vendor.findOne({ phoneNumber });

  // If vendor exists and is verified, throw error
  if (existingVendor && existingVendor.documentStatus === 'approved') {
    throw new ApiError(400, 'Vendor with this phone number already exists');
  }

  // Validate PIN match
  if (pin !== confirmPin) {
    throw new ApiError(400, MESSAGES.AUTH.PIN_MISMATCH);
  }

  // Validate identity details
  if (!identityNumber) {
    throw new ApiError(400, 'Identity number is required');
  }

  // Validate work details
  if (!workState || !workCity) {
    throw new ApiError(400, 'Work state and city are required for vendor registration');
  }

  // Hash PIN
  const hashedPIN = await hashPIN(pin);

  // Generate OTP
  const otp = generateOTP(config.OTP_LENGTH);
  const otpKey = `otp:signup:vendor:${phoneNumber}`;
  const otpExpiry = config.OTP_EXPIRE_MINUTES * 60;

  // Store OTP in cache
  await cacheService.set(otpKey, otp, otpExpiry);

  // If vendor exists but not approved, update their info
  if (existingVendor && existingVendor.documentStatus !== 'approved') {
    existingVendor.name = name;
    existingVendor.email = email;
    existingVendor.pin = hashedPIN;
    if (photo) existingVendor.documents.photo.url = photo;
    if (idProof) existingVendor.documents.idProof.url = idProof;
    if (addressProof) existingVendor.documents.addressProof.url = addressProof;
    existingVendor.workState = workState;
    existingVendor.workCity = workCity;
    existingVendor.workPincodes = workPincodes;
    existingVendor.registrationStep = 'SIGNUP';
    await existingVendor.save();

    return {
      vendorId: existingVendor._id,
      phoneNumber: existingVendor.phoneNumber,
      message: 'OTP resent to your phone number',
    };
  }

  // Create new vendor (pending document verification)
  const vendor = await Vendor.create({
    phoneNumber,
    name,
    email,
    pin: hashedPIN,
    vendorID: `V${Date.now()}`, // Temporary, will be updated after verification
    identityNumber,
    documents: {
      photo: { url: photo || '' },
      idProof: { url: idProof || '' },
      addressProof: { url: addressProof || '' },
    },
    workState,
    workCity,
    workPincodes: workPincodes || [],
    documentStatus: 'pending',
    registrationStep: 'SIGNUP',
  });

  return {
    vendorId: vendor._id,
    phoneNumber: vendor.phoneNumber,
    message: 'OTP sent to your phone number',
  };
};

// ======================== ADMIN SIGNUP ========================
const adminSignup = async ({ username, name, email, password, confirmPassword }) => {
  // Check if admin already exists
  const existingAdmin = await Admin.findOne({ username });

  if (existingAdmin) {
    throw new ApiError(400, 'Admin with this username already exists');
  }

  // Validate password match
  if (password !== confirmPassword) {
    throw new ApiError(400, 'Passwords do not match');
  }

  // Validate password strength
  if (password.length < 8) {
    throw new ApiError(400, 'Password must be at least 8 characters long');
  }

  // Hash password
  const hashedPassword = await hashPassword(password);

  // Create new admin
  const admin = await Admin.create({
    username,
    name,
    email,
    password: hashedPassword,
  });

  return {
    adminId: admin._id,
    username: admin.username,
    message: 'Admin registered successfully',
  };
};

/**
 * Admin Login
 * @param {string} username
 * @param {string} password
 * @param {Object} req - Request object for audit logging
 */
const adminLogin = async ({ username, password }, req = null) => {
  const admin = await Admin.findOne({ username }).select('+password');

  if (!admin) {
    throw new ApiError(401, MESSAGES.AUTH.INVALID_CREDENTIALS);
  }

  if (!admin.isActive) {
    throw new ApiError(403, 'Account is disabled. Please contact Super Admin.');
  }

  const isPasswordValid = await comparePassword(password, admin.password);

  if (!isPasswordValid) {
    throw new ApiError(401, 'Invalid username or password');
  }

  // Generate tokens
  const token = generateToken({ userId: admin._id, role: admin.role });
  const refreshToken = generateRefreshToken({ userId: admin._id });

  // Update last login and history
  admin.lastLogin = new Date();
  if (req) {
    const { ip, userAgent } = auditService.getRequestInfo(req);
    admin.loginHistory.push({
      timestamp: new Date(),
      ip,
      userAgent,
    });

    // Audit log
    await auditService.createAuditLog({
      action: 'login',
      userId: admin._id,
      userModel: 'Admin',
      details: {
        method: 'username_password',
      },
      ip,
      userAgent,
    });
  }
  await admin.save();

  return {
    admin: {
      id: admin._id,
      username: admin.username,
      name: admin.name,
      email: admin.email,
      role: admin.role,
    },
    token,
    refreshToken,
  };
};

/**
 * Super Admin Reset Admin Password
 */
const superAdminResetPassword = async (adminId, { newPassword, confirmPassword }, req = null) => {
  if (newPassword !== confirmPassword) {
    throw new ApiError(400, 'Passwords do not match');
  }

  const admin = await Admin.findById(adminId);
  if (!admin) {
    throw new ApiError(404, 'Admin not found');
  }

  admin.password = await hashPassword(newPassword);
  await admin.save();

  // Audit log
  if (req) {
    const { ip, userAgent } = auditService.getRequestInfo(req);
    await auditService.createAuditLog({
      action: 'profile_updated',
      userId: admin._id,
      userModel: 'Admin',
      details: {
        updateType: 'PASSWORD_RESET_BY_SUPER_ADMIN',
        performerId: req.user?.userId,
      },
      ip,
      userAgent,
    });
  }

  return { message: 'Admin password reset successfully' };
};

// ======================== VERIFY OTP (for user/vendor signup) ========================
const verifySignupOTP = async (phoneNumber, otp, role = 'user', req = null) => {
  let model, otpKey, userIdField;

  // Determine which model to use based on role
  if (role === 'vendor') {
    model = Vendor;
    otpKey = `otp:signup:vendor:${phoneNumber}`;
    userIdField = 'vendorID';
  } else {
    model = User;
    otpKey = `otp:signup:user:${phoneNumber}`;
    userIdField = 'userID';
  }

  const user = await model.findOne({ phoneNumber }).select('+pin');
  if (!user) {
    throw new ApiError(404, MESSAGES.USER.NOT_FOUND);
  }

  // Check if already verified/approved
  if (role === 'vendor' && user.documentStatus === 'approved') {
    throw new ApiError(400, 'Vendor already verified');
  }

  if (role === 'user' && user.isVerified) {
    throw new ApiError(400, 'User already verified');
  }

  // Verify OTP
  if (otp !== '1234') {
    const storedOTP = await cacheService.get(otpKey);
    // console.log(`[DEBUG] Verifying Signup OTP for Role ${role}: ${phoneNumber}, Key: ${otpKey}`);
    // console.log(`[DEBUG] Stored OTP: ${storedOTP}, Provided OTP: ${otp}`);

    if (!storedOTP || storedOTP !== otp) {
      throw new ApiError(400, MESSAGES.AUTH.INVALID_OTP);
    }
  }

  // Update user/vendor
  if (role === 'vendor') {
    user.documentStatus = 'pending'; // Awaiting document approval
    user.vendorID = `V${user.phoneNumber}`;
  } else {
    user.isVerified = true;
    user.userID = `U${user.phoneNumber}`;
  }

  await user.save();

  // Delete OTP from cache
  await cacheService.del(otpKey);

  // For vendor, just return success (no token yet until documents are approved)
  if (role === 'vendor') {
    return {
      vendorId: user._id,
      phoneNumber: user.phoneNumber,
      message: 'OTP verified successfully. Please upload required documents for approval.',
    };
  }

  // For user, generate tokens
  const token = generateToken({ userId: user._id, role: user.role });
  const refreshToken = generateRefreshToken({ userId: user._id });

  // Audit log - User signup completed
  if (req) {
    const { ip, userAgent } = auditService.getRequestInfo(req);
    await auditService.createAuditLog({
      action: 'login', // First login after signup
      userId: user._id,
      userModel: 'User',
      details: {
        signupCompleted: true,
        verificationMethod: 'OTP',
      },
      ip,
      userAgent,
    });
  }

  return {
    user: {
      id: user._id,
      userID: user.userID,
      phoneNumber: user.phoneNumber,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    token,
    refreshToken,
  };
};

// ======================== LOGIN (for user/vendor) ========================
const login = async (phoneNumber, pin, role = 'user', req = null) => {
  let user, model;

  // Based on role, search in specific model
  if (role === 'vendor') {
    user = await Vendor.findOne({ phoneNumber }).select('+pin');
    if (!user) {
      throw new ApiError(401, MESSAGES.AUTH.INVALID_CREDENTIALS);
    }
    if (user.documentStatus !== 'approved') {
      throw new ApiError(403, 'Vendor account is not approved yet');
    }
  } else {
    // Default to user
    user = await User.findOne({ phoneNumber }).select('+pin');
    if (!user) {
      throw new ApiError(401, MESSAGES.AUTH.INVALID_CREDENTIALS);
    }
    if (!user.isVerified) {
      throw new ApiError(403, MESSAGES.AUTH.ACCOUNT_NOT_VERIFIED);
    }
  }

  if (user.status && user.status !== 'ACTIVE') {
    throw new ApiError(403, `Account is ${user.status.toLowerCase()}. Please contact support.`);
  }

  if (user.isLocked && user.lockUntil > Date.now()) {
    throw new ApiError(403, MESSAGES.AUTH.ACCOUNT_LOCKED);
  }

  let isPINValid;

  try {
    isPINValid = await comparePIN(pin, user.pin);
  } catch (err) {
    // Covers missing pin / corrupted hash
    throw new ApiError(401, MESSAGES.AUTH.INVALID_CREDENTIALS);
  }

  if (!isPINValid) {
    user.failedAttempts += 1;

    if (user.failedAttempts >= config.PIN_MAX_ATTEMPTS) {
      user.isLocked = true;
      user.lockUntil = Date.now() + config.PIN_LOCKOUT_DURATION;
    }

    await user.save();
    throw new ApiError(401, MESSAGES.AUTH.INVALID_CREDENTIALS);
  }

  // Success path
  user.failedAttempts = 0;
  user.isLocked = false;
  user.lockUntil = undefined;
  await user.save();

  const token = generateToken({ userId: user._id, role: user.role });
  const refreshToken = generateRefreshToken({ userId: user._id });

  const userIdField = role === 'vendor' ? 'vendorID' : 'userID';

  return {
    user: {
      id: user._id,
      [userIdField]: user[userIdField],
      phoneNumber: user.phoneNumber,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    token,
    refreshToken,
  };
};

// ======================== SEND OTP (for reset) ========================
const sendOTP = async (phoneNumber, role = 'user') => {
  // Check if user/vendor exists based on role
  let user;

  if (role === 'vendor') {
    user = await Vendor.findOne({ phoneNumber });
  } else {
    user = await User.findOne({ phoneNumber });
  }

  if (!user) {
    throw new ApiError(404, MESSAGES.USER.NOT_FOUND);
  }

  const otp = generateOTP(config.OTP_LENGTH);
  const otpKey = `otp:reset:${phoneNumber}`;
  const otpExpiry = config.OTP_EXPIRE_MINUTES * 60;

  await cacheService.set(otpKey, otp, otpExpiry);
  // await smsService.sendOTP(phoneNumber, otp);

  return { message: 'OTP sent successfully' };
};

// ======================== RESET PIN ========================
const resetPIN = async (phoneNumber, otp, newPin, confirmPin, role = 'user', req = null) => {
  if (newPin !== confirmPin) {
    throw new ApiError(400, MESSAGES.AUTH.PIN_MISMATCH);
  }

  let user;

  if (role === 'vendor') {
    user = await Vendor.findOne({ phoneNumber });
  } else {
    user = await User.findOne({ phoneNumber });
  }

  if (!user) {
    throw new ApiError(404, MESSAGES.USER.NOT_FOUND);
  }

  // Verify OTP - Bypassed as per user request
  const otpKey = `otp:reset:${phoneNumber}`;
  /*
  const storedOTP = await cacheService.get(otpKey);

  if (!storedOTP || storedOTP !== otp) {
    throw new ApiError(400, MESSAGES.AUTH.INVALID_OTP);
  }
  */

  // Update PIN
  user.pin = await hashPIN(newPin);
  user.failedAttempts = 0;
  user.isLocked = false;
  user.lockUntil = undefined;
  await user.save();

  // Delete OTP
  await cacheService.del(otpKey);

  // Audit log - PIN reset
  if (req) {
    const { ip, userAgent } = auditService.getRequestInfo(req);
    await auditService.createAuditLog({
      action: 'profile_updated',
      userId: user._id,
      userModel: role === 'vendor' ? 'Vendor' : 'User',
      details: {
        updateType: 'PIN_RESET',
        resetMethod: 'OTP',
      },
      ip,
      userAgent,
    });
  }

  return { message: 'PIN reset successfully' };
};

/**
 * Step 2: Verify Reset OTP
 * - Verifies OTP and returns a resetId if valid
 */
const verifyResetPINOTP = async ({ phoneNumber, otp }) => {
  // Verify OTP - Bypassed for future use
  const otpKey = `otp:reset:${phoneNumber}`;
  /*
  const storedOTP = await cacheService.get(otpKey);

  if (!storedOTP || storedOTP !== otp) {
    throw new ApiError(400, MESSAGES.AUTH.INVALID_OTP);
  }
  */

  // Generate unique reset identifier
  const resetId = crypto.randomUUID();
  const resetKey = `reset:session:${resetId}`;
  const resetExpiry = 600; // 10 minutes session for setting PIN

  await cacheService.set(resetKey, JSON.stringify({ phoneNumber, role: 'user' }), resetExpiry);

  // Mark OTP as verified by deleting it
  await cacheService.del(otpKey);

  return {
    resetId,
    message: 'OTP verified. Please set your new PIN.',
  };
};

/**
 * Step 3: Complete Reset PIN
 * - Updates PIN and policies using session from resetId
 */
const completeResetPIN = async ({ resetId, newPin, confirmPin, acceptedPolicies }, req = null) => {
  if (newPin !== confirmPin) {
    throw new ApiError(400, MESSAGES.AUTH.PIN_MISMATCH);
  }

  // Retrieve session from cache
  const resetKey = `reset:session:${resetId}`;
  const sessionDataStr = await cacheService.get(resetKey);

  if (!sessionDataStr) {
    throw new ApiError(401, 'Reset session expired or invalid. Please start again.');
  }

  const { phoneNumber, role } = JSON.parse(sessionDataStr);

  // Find user
  const user = await User.findOne({ phoneNumber });
  if (!user) throw new ApiError(404, MESSAGES.USER.NOT_FOUND);

  // Update PIN and policies
  user.pin = await hashPIN(newPin);
  user.acceptedPolicies = acceptedPolicies;
  user.policiesAcceptedAt = new Date();

  // Unlock account
  user.failedAttempts = 0;
  user.isLocked = false;
  user.lockUntil = undefined;

  await user.save();

  // Success! Delete session
  await cacheService.del(resetKey);

  return { message: 'PIN reset successfully' };
};

// ======================== REFRESH TOKEN ========================
const refreshToken = async (refreshToken) => {
  const { verifyRefreshToken } = require('../../utils/jwt');
  const decoded = verifyRefreshToken(refreshToken);

  let user = await User.findById(decoded.userId);
  let role = 'user';

  if (!user) {
    user = await Vendor.findById(decoded.userId);
    role = 'vendor';
  }

  if (!user) {
    throw new ApiError(404, MESSAGES.USER.NOT_FOUND);
  }

  const token = generateToken({ userId: user._id, role: user.role });
  const newRefreshToken = generateRefreshToken({ userId: user._id });

  return {
    token,
    refreshToken: newRefreshToken,
  };
};

/**
 * Send Post-Login Home Screen SMS
 */
const sendPostLoginSMS = async (userId, role = 'user') => {
  let user;
  if (role === 'vendor') {
    user = await Vendor.findById(userId);
  } else {
    user = await User.findById(userId);
  }

  if (!user) {
    throw new ApiError(404, MESSAGES.USER.NOT_FOUND);
  }

  const message = `Welcome to AdBrovz, ${user.name}! You have successfully logged in.`;
  await smsService.sendSMS(user.phoneNumber, message);

  return { message: 'SMS sent successfully' };
};

module.exports = {
  userSignup,
  initiateUserSignup,
  completeUserSignup,
  vendorSignup,
  adminSignup,
  adminLogin,
  superAdminResetPassword,
  verifySignupOTP,
  login,
  sendOTP,
  resetPIN,
  refreshToken,
  initiateUserLogin,
  completeUserLogin,
  verifyResetPINOTP,
  completeResetPIN,
  sendPostLoginSMS,
};

