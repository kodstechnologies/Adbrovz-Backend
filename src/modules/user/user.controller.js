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

// Update FCM Token for push notifications
const updateFcmToken = asyncHandler(async (req, res) => {
  const userId = req.user.id || req.user.userId || req.user._id;
  const { fcmToken } = req.body;

  console.log(`🔍 [FCM UPDATE] User ${userId}: ${fcmToken ? 'TOKEN_RECEIVED' : 'TOKEN_MISSING'}`);

  if (!fcmToken) {
    throw new ApiError(400, 'fcmToken is required');
  }

  const User = require('../../models/User.model');
  // Support both Mongo _id and custom userID field for backward compatibility
  const filter = { $or: [{ _id: userId }, { userID: userId }] };
  const user = await User.findOneAndUpdate(filter, { fcmToken }, { new: true });
  
  if (!user) {
    console.log(`❌ [FCM UPDATE] User ${userId} not found in User collection`);
    throw new ApiError(404, 'User not found');
  }

  console.log(`✅ [FCM UPDATE] User ${userId} token updated successfully`);

  res.status(200).json(
    new ApiResponse(200, null, 'FCM token updated successfully')
  );
});

// Get user status (existing, suspend, deleted)
const getUserStatus = asyncHandler(async (req, res) => {
  const userId = req.query.userId || req.query.userID || (req.user ? (req.user.userId || req.user.id || req.user._id) : null);
  const phoneNumber = req.query.phoneNumber || (req.user ? req.user.phoneNumber : null);
  const role = req.query.role || (req.user ? req.user.role : null);

  const status = await userService.getUserStatus({ userId, phoneNumber, role });

  res.status(200).json(
    new ApiResponse(200, { status }, 'User status retrieved successfully')
  );
});

module.exports = {
  getProfile,
  updateProfile,
  deleteAccount,
  getUsers,
  exportUsersToCSV,
  getUserCoins,
  updateFcmToken,
  getUserStatus,
};
