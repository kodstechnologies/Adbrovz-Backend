const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const userService = require('./user.service');
const MESSAGES = require('../../constants/messages');
const { Parser } = require('json2csv');
const Coupon = require('../../models/Coupon.model');

// Get all users (Admin)
const getUsers = asyncHandler(async (req, res) => {
  const result = await userService.getAllUsers(req.query);
  res.status(200).json(new ApiResponse(200, result, 'Users retrieved successfully'));
});

// Get user profile
const getProfile = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const user = await userService.getUserById(userId);
  res.status(200).json(
    new ApiResponse(200, user, 'Profile retrieved successfully')
  );
});

// Update user profile
const updateProfile = asyncHandler(async (req, res) => {
  const userId = req.user.userId || req.user._id;
  const data = { ...req.body };

  if (req.file && req.file.cloudinary) {
    data.image = req.file.cloudinary.url;
  }

  const user = await userService.updateUser(userId, data, req);

  res.status(200).json(
    new ApiResponse(200, user, MESSAGES.USER.PROFILE_UPDATED)
  );
});

// Delete user account
const deleteAccount = asyncHandler(async (req, res) => {
  const userId = req.user.userId;

  await userService.deleteUser(userId, req);

  res.status(200).json(
    new ApiResponse(200, null, MESSAGES.USER.DELETED)
  );
});

// Export users to CSV
const exportUsersToCSV = asyncHandler(async (req, res) => {
  const result = await userService.getAllUsers({ limit: 10000 }); // Get all users (limit huge number)
  const users = result.users;

  const fields = [
    { label: 'Name', value: 'name' },
    { label: 'Email', value: 'email' },
    { label: 'Mobile Number', value: 'phoneNumber' },
    { label: 'Role', value: 'role' },
    { label: 'Status', value: 'status' },
    { label: 'Verified', value: 'isVerified' },
    { label: 'Coins', value: 'coins' },
    { label: 'Account Deletion Status', value: (row) => row.deletedAt ? 'Deleted' : 'Active' },
    { label: 'Created At', value: (row) => new Date(row.createdAt).toLocaleString() }
  ];

  const json2csvParser = new Parser({ fields });
  const csv = json2csvParser.parse(users);

  res.header('Content-Type', 'text/csv');
  res.attachment('users.csv');
  return res.send(csv);
});

// Get user coins
const getUserCoins = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const user = await userService.getUserById(userId);
  res.status(200).json(new ApiResponse(200, { coins: user.coins || 0 }, 'User coins retrieved successfully'));
});

// Get coupons available to the logged-in user
const getMyCoupons = asyncHandler(async (req, res) => {
  const userId = req.user.userId || req.user._id;
  const now = new Date();

  // Fetch all active coupons
  const allCoupons = await Coupon.find({ isActive: true });

  const availableCoupons = allCoupons.filter((coupon) => {
    // Check expiry
    const validityEnd = new Date(coupon.createdAt);
    validityEnd.setDate(validityEnd.getDate() + coupon.validityDays);
    if (now > validityEnd) return false;

    // Check user applicability
    if (coupon.isForAllUsers) return true;
    return coupon.applicableUsers.some((u) => u.toString() === userId.toString());
  });

  const result = availableCoupons.map((coupon) => ({
    id: coupon._id,
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    isForAllUsers: coupon.isForAllUsers,
    validityDays: coupon.validityDays,
    expiresAt: (() => {
      const d = new Date(coupon.createdAt);
      d.setDate(d.getDate() + coupon.validityDays);
      return d;
    })(),
  }));

  res.status(200).json(new ApiResponse(200, result, 'Coupons retrieved successfully'));
});

// Verify a coupon code for a specific user
const verifyCoupon = asyncHandler(async (req, res) => {
  const { code, userId } = req.body;

  if (!code) throw new ApiError(400, 'Coupon code is required');
  if (!userId) throw new ApiError(400, 'User ID is required');

  const coupon = await Coupon.findOne({ code: code.toUpperCase() });
  
  if (!coupon) {
    return res.status(200).json(new ApiResponse(404, { valid: false }, 'Invalid coupon code'));
  }

  if (!coupon.isActive) {
    return res.status(200).json(new ApiResponse(400, { valid: false }, 'Coupon is inactive'));
  }

  const now = new Date();
  const validityEnd = new Date(coupon.createdAt);
  validityEnd.setDate(validityEnd.getDate() + coupon.validityDays);

  if (now > validityEnd) {
    return res.status(200).json(new ApiResponse(400, { valid: false }, 'Coupon has expired'));
  }

  if (!coupon.isForAllUsers) {
    const isApplicable = coupon.applicableUsers.some((u) => u.toString() === userId.toString());
    if (!isApplicable) {
      return res.status(200).json(new ApiResponse(400, { valid: false }, 'This coupon is not applicable for this user'));
    }
  }

  res.status(200).json(new ApiResponse(200, {
    valid: true,
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue
  }, 'Coupon is valid'));
});

// Apply a coupon and calculate discount
const applyCoupon = asyncHandler(async (req, res) => {
  const { code, userId, orderAmount } = req.body;

  if (!code) throw new ApiError(400, 'Coupon code is required');
  if (!userId) throw new ApiError(400, 'User ID is required');
  if (!orderAmount || orderAmount <= 0) throw new ApiError(400, 'Valid order amount is required');

  const coupon = await Coupon.findOne({ code: code.toUpperCase() });

  if (!coupon || !coupon.isActive) {
    throw new ApiError(400, 'Invalid or inactive coupon code');
  }

  const now = new Date();
  const validityEnd = new Date(coupon.createdAt);
  validityEnd.setDate(validityEnd.getDate() + coupon.validityDays);

  if (now > validityEnd) {
    throw new ApiError(400, 'Coupon has expired');
  }

  if (!coupon.isForAllUsers) {
    const isApplicable = coupon.applicableUsers.some((u) => u.toString() === userId.toString());
    if (!isApplicable) {
      throw new ApiError(400, 'This coupon is not applicable for this user');
    }
  }

  let discount = 0;
  if (coupon.discountType === 'amount') {
    discount = coupon.discountValue;
  } else if (coupon.discountType === 'percent') {
    discount = (orderAmount * coupon.discountValue) / 100;
  }

  const finalAmount = Math.max(0, orderAmount - discount);

  res.status(200).json(new ApiResponse(200, {
    valid: true,
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    discount,
    originalAmount: orderAmount,
    finalAmount
  }, 'Coupon applied successfully'));
});

module.exports = {
  getProfile,
  updateProfile,
  deleteAccount,
  getUsers,
  exportUsersToCSV,
  getUserCoins,
  getMyCoupons,
  verifyCoupon,
  applyCoupon,
};
