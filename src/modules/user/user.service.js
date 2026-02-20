const User = require('../../models/User.model');
const ApiError = require('../../utils/ApiError');
const MESSAGES = require('../../constants/messages');
const auditService = require('../../services/audit.service');
const Booking = require('../../models/Booking.model');
const Notification = require('../../models/Notification.model');
const Dispute = require('../../models/Dispute.model');
const AuditLog = require('../../models/AuditLog.model');

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

  // Map input fields to model fields if necessary (mirroring vendor service pattern)
  if (updateData.name) user.name = updateData.name;
  if (updateData.email || updateData.mail) user.email = updateData.email || updateData.mail;
  if (updateData.mobileNumber) user.phoneNumber = updateData.mobileNumber;
  if (updateData.address) user.address = updateData.address;
  if (updateData.city) user.city = updateData.city;
  if (updateData.state) user.state = updateData.state;
  if (updateData.zipcode) user.zipcode = updateData.zipcode;
  if (updateData.country) user.country = updateData.country;

  // Handle image separately (matching vendor pattern: vendor.set('documents.photo.url', ...))
  if (updateData.image || updateData.photo) {
    user.photo = updateData.image || updateData.photo;
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

  // Audit log - Account deleted (before deletion)
  if (req) {
    const { ip, userAgent } = auditService.getRequestInfo(req);
    await auditService.createAuditLog({
      action: 'account_deleted',
      userId: user._id,
      userModel: 'User',
      details: {
        phoneNumber: user.phoneNumber,
        userID: user.userID,
        deletedAt: new Date(),
      },
      ip,
      userAgent,
    });
  }

  // Delete related data (personal data cleanup)
  await Promise.all([
    Booking.deleteMany({ user: userId }),
    Notification.deleteMany({ user: userId }),
    Dispute.deleteMany({ user: userId }),
    AuditLog.deleteMany({ user: userId, userModel: 'User' })
  ]);

  // Finally delete the user
  await User.findByIdAndDelete(userId);

  return user;
};

module.exports = {
  getUserById,
  updateUser,
  deleteUser,

};

