const AuditLog = require('../../models/AuditLog.model');
const User = require('../../models/User.model');
const Vendor = require('../../models/Vendor.model');
const Booking = require('../../models/Booking.model');
const GlobalConfig = require('../../models/GlobalConfig.model');
const { DEFAULT_SETTINGS } = require('../../constants/settings');

const CoinTransaction = require('../../models/CoinTransaction.model');

const getDashboardStats = async () => {
  try {
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // Day of week setup for Current Week (Mon-Sun)
    const dayOfWeek = now.getDay();
    const diffToMonday = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const startOfThisWeek = new Date(now.setDate(diffToMonday));
    startOfThisWeek.setHours(0, 0, 0, 0);

    const startOfLastWeek = new Date(startOfThisWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

    // 1. Stat Cards
    // Total Revenue (Completed Bookings)
    const [thisMonthRevenue, lastMonthRevenue] = await Promise.all([
      Booking.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: startOfThisMonth } } },
        { $group: { _id: null, total: { $sum: '$pricing.totalPrice' } } }
      ]).then(res => res[0]?.total || 0),
      Booking.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: startOfLastMonth, $lt: startOfThisMonth } } },
        { $group: { _id: null, total: { $sum: '$pricing.totalPrice' } } }
      ]).then(res => res[0]?.total || 0)
    ]);

    // Active Bookings (Pending, Ongoing, etc)
    const activeStatuses = ['pending_acceptance', 'pending', 'on_the_way', 'arrived', 'ongoing'];
    const [thisWeekActive, lastWeekActive] = await Promise.all([
      Booking.countDocuments({ status: { $in: activeStatuses }, createdAt: { $gte: startOfThisWeek } }),
      Booking.countDocuments({ status: { $in: activeStatuses }, createdAt: { $gte: startOfLastWeek, $lt: startOfThisWeek } })
    ]);

    // Total Vendors (Verified)
    const [totalVendorsThisMonth, totalVendorsLastMonth] = await Promise.all([
      Vendor.countDocuments({ isVerified: true }),
      Vendor.countDocuments({ isVerified: true, createdAt: { $lt: startOfThisMonth } })
    ]);

    // Credits Used
    const [thisMonthCredits, lastMonthCredits] = await Promise.all([
      CoinTransaction.aggregate([
        { $match: { type: 'debit', createdAt: { $gte: startOfThisMonth } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).then(res => res[0]?.total || 0),
      CoinTransaction.aggregate([
        { $match: { type: 'debit', createdAt: { $gte: startOfLastMonth, $lt: startOfThisMonth } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).then(res => res[0]?.total || 0)
    ]);

    // 2. Week Data (Area Chart)
    const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weekBookings = await Booking.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: startOfThisWeek } } },
      {
        $group: {
          _id: { $dayOfWeek: '$createdAt' },
          bookings: { $sum: 1 },
          revenue: { $sum: '$pricing.totalPrice' }
        }
      }
    ]);

    // Map to 'Mon', 'Tue', ...
    const weekData = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(dayName => {
      const dbDayIndex = weekDays.indexOf(dayName) + 1; // MongoDB $dayOfWeek is 1(Sun) to 7(Sat)
      const dayData = weekBookings.find(d => d._id === dbDayIndex);
      return {
        name: dayName,
        bookings: dayData ? dayData.bookings : 0,
        revenue: dayData ? dayData.revenue : 0
      };
    });

    // 3. Vendor Performance (Pie Chart)
    const [topVendors, averageVendors, underperformingVendors] = await Promise.all([
      Vendor.countDocuments({ 'performance.rating': { $gte: 4.5 } }),
      Vendor.countDocuments({ 'performance.rating': { $gte: 3.0, $lt: 4.5 } }),
      Vendor.countDocuments({ 'performance.rating': { $lt: 3.0 } })
    ]);

    const totalRatedVendors = topVendors + averageVendors + underperformingVendors || 1; // Avoid division by zero
    const vendorPerf = [
      { name: 'Top Vendors', value: Math.round((topVendors / totalRatedVendors) * 100) },
      { name: 'Average', value: Math.round((averageVendors / totalRatedVendors) * 100) },
      { name: 'Underperforming', value: Math.round((underperformingVendors / totalRatedVendors) * 100) }
    ];

    // 4. Peak Hours Analysis
    const peakHoursData = await Booking.aggregate([
      { $match: { createdAt: { $gte: new Date(new Date().setDate(new Date().getDate() - 30)) } } }, // Last 30 days
      {
        $group: {
          _id: {
            day: { $dayOfWeek: '$createdAt' },
            hour: { $hour: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ]);

    let maxDailyBookings = 0;
    let busiestDayName = 'N/A';
    if (peakHoursData.length > 0) {
      maxDailyBookings = peakHoursData[0].count;
      busiestDayName = weekDays[peakHoursData[0]._id.day - 1]; // MongoDB $dayOfWeek is 1(Sun) to 7(Sat)
    }

    const calculateTrend = (current, previous) => {
      if (previous === 0) return { trend: current > 0 ? '+100%' : '0%', trendUp: current >= 0 };
      const percent = ((current - previous) / previous) * 100;
      return { trend: `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`, trendUp: percent >= 0 };
    };

    return {
      cards: {
        revenue: { value: thisMonthRevenue, ...calculateTrend(thisMonthRevenue, lastMonthRevenue) },
        bookings: { value: thisWeekActive, ...calculateTrend(thisWeekActive, lastWeekActive) },
        vendors: { value: totalVendorsThisMonth, ...calculateTrend(totalVendorsThisMonth, totalVendorsLastMonth) },
        credits: { value: thisMonthCredits, ...calculateTrend(thisMonthCredits, lastMonthCredits) }
      },
      weekData,
      vendorPerf,
      peakHours: {
        maxDailyBookings,
        busiestDay: busiestDayName
      }
    };
  } catch (error) {
    console.error('Failed to get dashboard stats:', error.message);
    throw error;
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

const getGlobalSettings = async () => {
  const dbSettings = await GlobalConfig.find({});
  const settingsMap = {};

  // Initialize with defaults
  Object.keys(DEFAULT_SETTINGS).forEach(key => {
    settingsMap[key] = {
      ...DEFAULT_SETTINGS[key],
      isDefault: true
    };
  });

  // Override with DB values
  dbSettings.forEach(s => {
    settingsMap[s.key] = {
      value: s.value,
      description: s.description,
      isDefault: false,
      updatedAt: s.updatedAt
    };
  });

  return settingsMap;
};

const updateGlobalSettings = async (settings, adminId) => {
  const updatedSettings = [];

  for (const [key, value] of Object.entries(settings)) {
    const setting = await GlobalConfig.findOneAndUpdate(
      { key },
      {
        value,
        lastUpdatedBy: adminId,
        description: DEFAULT_SETTINGS[key]?.description || ''
      },
      { upsert: true, new: true }
    );
    updatedSettings.push(setting);
  }

  return updatedSettings;
};

const getSetting = async (key) => {
  const setting = await GlobalConfig.findOne({ key });
  if (setting) return setting.value;
  return DEFAULT_SETTINGS[key]?.value;
};

const getAllBookings = async (query = {}) => {
  const { limit = 10, skip = 0, search = '', status, isToday } = query;

  const filter = {};

  if (status) {
    filter.status = status;
  }

  if (isToday === 'true') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    filter.scheduledDate = { $gte: start, $lte: end };
  }

  // Pre-fetch matching users/vendors if search involves names
  if (search) {
    const userMatches = await User.find({ name: { $regex: search, $options: 'i' } }).select('_id');
    const vendorMatches = await Vendor.find({ name: { $regex: search, $options: 'i' } }).select('_id');

    filter.$or = [
      { bookingID: { $regex: search, $options: 'i' } },
      { user: { $in: userMatches.map(u => u._id) } },
      { vendor: { $in: vendorMatches.map(v => v._id) } }
    ];
  }

  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .populate('user', 'name phoneNumber email')
      .populate('vendor', 'name phoneNumber')
      .populate('services.service', 'title'),
    Booking.countDocuments(filter),
  ]);

  return {
    bookings,
    total,
    limit: parseInt(limit),
    skip: parseInt(skip),
  };
};

const getBookingDetails = async (bookingId) => {
  const Dispute = require('../../models/Dispute.model');
  const Feedback = require('../../models/Feedback.model');

  const booking = await Booking.findById(bookingId)
    .populate('user', 'name phoneNumber email profileImage status')
    .populate('vendor', 'name phoneNumber email profileImage specialization rating status isSuspended adminSuspended')
    .populate('services.service', 'title description price duration')
    .populate('rejectedVendors', 'name')
    .populate('laterVendors', 'name');

  if (!booking) {
    throw new Error('Booking not found');
  }

  // Fetch optional related items
  const [feedback, disputes] = await Promise.all([
    Feedback.findOne({ booking: bookingId }),
    Dispute.find({ booking: bookingId }).populate('raisedBy', 'name type')
  ]);

  return {
    booking,
    feedback,
    disputes
  };
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
  getGlobalSettings,
  updateGlobalSettings,
  getSetting,
  getAllBookings,
  getBookingDetails,
};
