const User = require('../../models/User.model');
const ApiError = require('../../utils/ApiError');
const MESSAGES = require('../../constants/messages');
const Booking = require('../../models/Booking.model');
const Notification = require('../../models/Notification.model');
const Dispute = require('../../models/Dispute.model');

const getUserById = async (userId) => {
  const user = await User.findById(userId).select('-pin -failedAttempts -lockUntil');
  if (!user) {
    throw new ApiError(404, MESSAGES.USER.NOT_FOUND);
  }

  return {
    id: user._id,
    image: user.photo || '',
    name: user.name,
    email: user.email,
    phone: user.phoneNumber,
  };
};

const updateUser = async (userId, updateData, req = null) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, MESSAGES.USER.NOT_FOUND);
  }

  // Map input fields to model fields
  if (updateData.name) user.name = updateData.name;
  if (updateData.email || updateData.mail) user.email = updateData.email || updateData.mail;
  // Accept both phoneNumber (direct) and mobileNumber (alias from mobile apps)
  if (updateData.phoneNumber) user.phoneNumber = updateData.phoneNumber;
  if (updateData.mobileNumber) user.phoneNumber = updateData.mobileNumber;

  // Handle image (from cloudinary middleware or direct URL)
  if (updateData.image || updateData.photo) {
    user.photo = updateData.image || updateData.photo;
  }

  // Handle FCM Token update during profile edit
  if (updateData.fcmToken) {
    user.fcmToken = updateData.fcmToken;
  }

  console.log('DEBUG: updateUser Service Data before save:', { userId, updateData });

  await user.save();

  return getUserById(userId);
};

const deleteUser = async (userId, req = null) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, MESSAGES.USER.NOT_FOUND);
  }

  // Perform Soft Delete (preserve data for user-initiated deletion)
  user.status = 'DELETED';
  user.deletedAt = new Date();
  await user.save();

  return user;
};

const getUserStatus = async (queryParams) => {
  const { userId, phoneNumber, role } = queryParams;
  const Vendor = require('../../models/Vendor.model');

  let user = null;
  let vendor = null;

  // 1. Search by userId/vendorId if provided
  if (userId) {
    if (role === 'vendor') {
      const mongoose = require('mongoose');
      if (mongoose.Types.ObjectId.isValid(userId)) {
        vendor = await Vendor.findById(userId);
      }
      if (!vendor) vendor = await Vendor.findOne({ vendorID: userId });
    } else if (role === 'user') {
      const mongoose = require('mongoose');
      if (mongoose.Types.ObjectId.isValid(userId)) {
        user = await User.findById(userId);
      }
      if (!user) user = await User.findOne({ userID: userId });
    } else {
      const mongoose = require('mongoose');
      const isValidObjectId = mongoose.Types.ObjectId.isValid(userId);
      if (isValidObjectId) {
        user = await User.findById(userId);
        vendor = await Vendor.findById(userId);
      }
      if (!user) user = await User.findOne({ userID: userId });
      if (!vendor) vendor = await Vendor.findOne({ vendorID: userId });
    }
  }

  // 2. Search by phoneNumber if provided and user/vendor not found yet
  if (!user && !vendor && phoneNumber) {
    user = await User.findOne({ phoneNumber });
    vendor = await Vendor.findOne({ phoneNumber });
  }

  // 3. Determine status
  // A vendor is found
  if (vendor) {
    if (vendor.deletedAt || (vendor.deletionRequest && vendor.deletionRequest.isRequested && vendor.deletionRequest.status === 'APPROVED')) {
      return 'deleted';
    }
    if (vendor.isSuspended || vendor.isBlocked) {
      return 'suspend';
    }
    return 'existing';
  }

  // A user is found
  if (user) {
    if (user.status === 'DELETED' || user.deletedAt) {
      return 'deleted';
    }
    if (user.status === 'SUSPENDED' || user.isLocked) {
      return 'suspend';
    }
    return 'existing';
  }

  // If neither is found
  return 'deleted';
};

module.exports = {
  getUserById,
  updateUser,
  deleteUser,
  getUserStatus,
};
