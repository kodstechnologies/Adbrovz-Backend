const AuditLog = require('../../models/AuditLog.model');
const User = require('../../models/User.model');
const Vendor = require('../../models/Vendor.model');
const Booking = require('../../models/Booking.model');

// Placeholder admin service
const getDashboardStats = async () => {
  try {
    const [
      totalUsers,
      totalVendors,
      totalBookings,
      recentLogins,
      recentPayments,
    ] = await Promise.all([
      User.countDocuments({ isActive: true }),
      Vendor.countDocuments({ isActive: true, isVerified: true }),
      Booking.countDocuments(),
      AuditLog.countDocuments({ action: 'login', timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
      AuditLog.countDocuments({ action: 'payment', timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
    ]);

    return {
      totalUsers,
      totalVendors,
      totalBookings,
      recentLogins,
      recentPayments,
    };
  } catch (error) {
    console.error('Failed to get dashboard stats:', error.message);
    return {
      totalUsers: 0,
      totalVendors: 0,
      totalBookings: 0,
      recentLogins: 0,
      recentPayments: 0,
    };
  }
};

const getAllUsers = async (query = {}) => {
  const { limit = 10, skip = 0, search = '', includeDeleted = false } = query;

  // Build filter - include deleted users if requested (for exports)
  const filter = {};

  // Only filter out deleted users if includeDeleted is not true
  // This allows exports to show all users including deleted ones
  if (includeDeleted !== 'true' && includeDeleted !== true) {
    filter.deletedAt = null;
  }

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phoneNumber: { $regex: search, $options: 'i' } },
    ];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip)),
    User.countDocuments(filter),
  ]);

  return {
    users,
    total,
    limit: parseInt(limit),
    skip: parseInt(skip),
  };
};

const updateUserStatus = async (userId, status, adminId) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const oldStatus = user.status || (user.isActive ? 'ACTIVE' : 'SUSPENDED');
  user.status = status;
  user.isActive = (status === 'ACTIVE');
  await user.save();

  // Log the action
  try {
    await AuditLog.create({
      user: adminId,
      userModel: 'Admin',
      action: 'user_status_updated',
      details: {
        targetUser: userId,
        oldStatus,
        newStatus: status
      }
    });
  } catch (logError) {
    console.error('Audit logging failed:', logError.message);
    // Don't fail the primary action (status update) if logging fails
  }

  return user;
};

const CreditPlan = require('../../models/CreditPlan.model');

// ... existing code ...

const createCreditPlan = async (planData) => {
  return await CreditPlan.create(planData);
};

const getCreditPlans = async (includeInactive = true) => {
  const filter = includeInactive ? {} : { isActive: true };
  return await CreditPlan.find(filter).sort({ price: 1 });
};

const updateCreditPlan = async (planId, updateData) => {
  const plan = await CreditPlan.findByIdAndUpdate(planId, updateData, { new: true });
  if (!plan) {
    throw new Error('Credit plan not found');
  }
  return plan;
};

const deleteCreditPlan = async (planId) => {
  // Soft delete or deactivate? User said "set by admin", so let's allow actual deletion or just deactivation.
  // We'll do a real delete for now or just set isActive to false.
  const plan = await CreditPlan.findByIdAndDelete(planId);
  if (!plan) {
    throw new Error('Credit plan not found');
  }
  return plan;
};

const verifyVendor = async (vendorId, statusData) => {
  const vendorService = require('../vendor/vendor.service');
  return await vendorService.verifyVendor(vendorId, statusData);
};

const verifyVendorDocument = async (vendorId, docData) => {
  const vendorService = require('../vendor/vendor.service');
  return await vendorService.verifyDocument(vendorId, docData);
};

const verifyAllVendorDocuments = async (vendorId) => {
  const vendorService = require('../vendor/vendor.service');
  return await vendorService.verifyAllDocuments(vendorId);
};

const toggleVendorSuspension = async (vendorId, statusData) => {
  const vendorService = require('../vendor/vendor.service');
  return await vendorService.toggleVendorSuspension(vendorId, statusData);
};

const rejectVendorAccount = async (vendorId, reasonData) => {
  const vendorService = require('../vendor/vendor.service');
  return await vendorService.rejectVendorAccount(vendorId, reasonData);
};

const getEligibleVendors = async () => {
  return await Vendor.find({
    isVerified: true,
    isSuspended: false,
    registrationStep: 'COMPLETED',
    'creditPlan.expiryDate': { $gt: new Date() }
  });
};

module.exports = {
  getDashboardStats,
  getAllUsers,
  updateUserStatus,
  createCreditPlan,
  getCreditPlans,
  updateCreditPlan,
  deleteCreditPlan,
  verifyVendor,
  verifyVendorDocument,
  verifyAllVendorDocuments,
  toggleVendorSuspension,
  rejectVendorAccount,
  getEligibleVendors,
};
