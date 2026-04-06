const AuditLog = require('../../models/AuditLog.model');
const User = require('../../models/User.model');
const Vendor = require('../../models/Vendor.model');
const Booking = require('../../models/Booking.model');
const GlobalConfig = require('../../models/GlobalConfig.model');
const CreditPlan = require('../../models/CreditPlan.model');
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
    // Total Revenue (All Non-Cancelled Bookings to show data)
    const [thisMonthRevenue, lastMonthRevenue] = await Promise.all([
      Booking.aggregate([
        { $match: { status: { $ne: 'cancelled' }, createdAt: { $gte: startOfThisMonth } } },
        { $group: { _id: null, total: { $sum: '$pricing.totalPrice' } } }
      ]).then(res => res[0]?.total || 0),
      Booking.aggregate([
        { $match: { status: { $ne: 'cancelled' }, createdAt: { $gte: startOfLastMonth, $lt: startOfThisMonth } } },
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
      // Use active bookings to show more data in dev
      { $match: { status: { $ne: 'cancelled' }, createdAt: { $gte: startOfThisWeek } } },
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
    const [topVendors, averageVendors, underperformingVendors, unratedVendors] = await Promise.all([
      Vendor.countDocuments({ 'performance.rating': { $gte: 4.5 } }),
      Vendor.countDocuments({ 'performance.rating': { $gte: 3.0, $lt: 4.5 } }),
      Vendor.countDocuments({ 'performance.rating': { $gt: 0, $lt: 3.0 } }),
      Vendor.countDocuments({ 'performance.rating': { $in: [0, null] } }) // Group 0/null as Unrated instead of generic underperforming
    ]);

    const totalVendors = topVendors + averageVendors + underperformingVendors + unratedVendors || 1; // Avoid division by zero
    const vendorPerf = [
      { name: 'Top Vendors', value: Math.round((topVendors / totalVendors) * 100) },
      { name: 'Average', value: Math.round((averageVendors / totalVendors) * 100) },
      { name: 'Underperforming', value: Math.round((underperformingVendors / totalVendors) * 100) },
      { name: 'Unrated', value: Math.round((unratedVendors / totalVendors) * 100) } // Provide visibility for new test accounts
    ].filter(v => v.value > 0); // Recharts pie might error on all zeros, but we added unrated so it should add up to 100%

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

  const oldStatus = user.status || 'ACTIVE';
  user.status = status;
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

const deleteUser = async (userId, adminId) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  user.deletedAt = new Date();
  user.status = 'SUSPENDED';
  await user.save();

  try {
    await AuditLog.create({
      user: adminId,
      userModel: 'Admin',
      action: 'user_deleted',
      details: {
        targetUser: userId,
        reason: 'Admin deleted user'
      }
    });
  } catch (logError) {
    console.error('Audit logging failed:', logError.message);
  }

  return user;
};



// ... existing code ...

const createCreditPlan = async (planData) => {
  return await CreditPlan.create(planData);
};

const getCreditPlans = async () => {
  return await CreditPlan.find({}).sort({ price: 1 });
};

const updateCreditPlan = async (planId, updateData) => {
  let plan;
  if (/^[0-9a-fA-F]{24}$/.test(planId)) {
    plan = await CreditPlan.findByIdAndUpdate(planId, updateData, { new: true });
  } else {
    // Try by name (case-insensitive) if not an ID
    plan = await CreditPlan.findOne({ name: new RegExp(`^${planId}$`, 'i') });
    if (plan) {
      plan = await CreditPlan.findByIdAndUpdate(plan._id, updateData, { new: true });
    } else {
      // Create if it doesn't exist
      // Make sure the name is capitalized appropriately or just use the passed string
      const capName = planId.charAt(0).toUpperCase() + planId.slice(1).toLowerCase();
      plan = await CreditPlan.create({ name: capName, ...updateData });
    }
  }

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
        $set: {
          value,
          lastUpdatedBy: adminId,
          description: DEFAULT_SETTINGS[key]?.description || ''
        },
        $setOnInsert: { key }
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

const getMembershipPricing = async () => {
    // Fetch Membership tiers from CreditPlan collection
    const tiers = await CreditPlan.find({ 
        name: { $in: ['Basic', 'Pro', 'Elite'] } 
    }).lean();

    const basic = tiers.find(t => t.name === 'Basic') || { price: 1000, validityDays: 90 };
    const pro = tiers.find(t => t.name === 'Pro') || { price: 2000, validityDays: 180 };
    const elite = tiers.find(t => t.name === 'Elite') || { price: 4000, validityDays: 360 };
    
    const gstPercent = await getSetting('pricing.membership_gst_percent');

    return {
        // Original keys for backward compatibility (duration-mapped)
        fee3Months: basic.price,
        fee6Months: pro.price,
        fee12Months: elite.price,
        gstPercent: Number(gstPercent) || 18,

        // UI-friendly keys for Basic/Pro/Elite mapping
        basicPrice: basic.price,
        proPrice: pro.price,
        elitePrice: elite.price,

        // Custom Validity Days
        basicValidity: basic.validityDays,
        proValidity: pro.validityDays,
        eliteValidity: elite.validityDays
    };
};

const updateMembershipPricing = async (data, adminId) => {
    const { 
        basicPrice, proPrice, elitePrice,
        basicValidity, proValidity, eliteValidity,
        gstPercent 
    } = data;
    
    const updates = [];
    
    if (basicPrice !== undefined || basicValidity !== undefined) {
        updates.push(CreditPlan.findOneAndUpdate(
            { name: 'Basic' }, 
            { 
                $set: { 
                    ...(basicPrice !== undefined && { price: Number(basicPrice) }),
                    ...(basicValidity !== undefined && { validityDays: Number(basicValidity) })
                } 
            },
            { upsert: true }
        ));
    }
    
    if (proPrice !== undefined || proValidity !== undefined) {
        updates.push(CreditPlan.findOneAndUpdate(
            { name: 'Pro' }, 
            { 
                $set: { 
                    ...(proPrice !== undefined && { price: Number(proPrice) }),
                    ...(proValidity !== undefined && { validityDays: Number(proValidity) })
                } 
            },
            { upsert: true }
        ));
    }
    
    if (elitePrice !== undefined || eliteValidity !== undefined) {
        updates.push(CreditPlan.findOneAndUpdate(
            { name: 'Elite' }, 
            { 
                $set: { 
                    ...(elitePrice !== undefined && { price: Number(elitePrice) }),
                    ...(eliteValidity !== undefined && { validityDays: Number(eliteValidity) })
                } 
            },
            { upsert: true }
        ));
    }

    if (gstPercent !== undefined) {
        await updateGlobalSettings({ 'pricing.membership_gst_percent': Number(gstPercent) }, adminId);
    }

    if (updates.length > 0) {
        await Promise.all(updates);
    }
    
    return await getMembershipPricing();
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
      .populate('vendor', 'name phoneNumber isVerified isSuspended isBlocked documentStatus registrationStep status')
      .populate('services.service', 'title')
      .populate('proposedServices.service', 'title')
      .populate('userRequestedServices.service', 'title'),
    Booking.countDocuments(filter),
  ]);

  // Enhance each booking with computed extra service amounts
  const enhancedBookings = bookings.map(b => {
    const obj = b.toObject ? b.toObject() : b;
    const baseServicesTotal = (obj.services || []).reduce((sum, s) => sum + (s.finalPrice || 0), 0);
    const extraServicesTotal = (obj.userRequestedServices || [])
      .filter(s => ['priced', 'accepted'].includes(s.status) || s.isPriceConfirmed)
      .reduce((sum, s) => sum + (s.finalPrice || 0), 0);
    const proposedServicesTotal = (obj.proposedServices || []).reduce((sum, s) => sum + (s.finalPrice || 0), 0);
    const travelCharge = obj.pricing?.travelCharge || 0;
    const additionalCharges = obj.pricing?.additionalCharges || 0;

    // Format status history for IST
    if (obj.statusHistory) {
      const formatToLocalISOString = (date) => {
        if (!date) return null;
        try {
            const d = new Date(new Date(date).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
            const pad = (n) => n.toString().padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        } catch (e) {
            return date;
        }
      };

      obj.statusHistory = (obj.statusHistory || []).map(h => {
        const istTime = formatToLocalISOString(h.timestamp);
        return {
          ...h,
          timestamp: istTime || h.timestamp,
          timestampIST: istTime
        };
      });
    }

    obj.extraServicesAmount = extraServicesTotal;
    obj.computedTotal = baseServicesTotal + extraServicesTotal + proposedServicesTotal + travelCharge + additionalCharges;
    return obj;
  });

  return {
    bookings: enhancedBookings,
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
    .populate('vendor', 'name phoneNumber email profileImage specialization rating status isSuspended isBlocked isVerified documentStatus registrationStep adminSuspended')
    .populate('services.service', 'title description adminPrice duration photo')
    .populate('proposedServices.service', 'title description adminPrice duration photo')
    .populate('userRequestedServices.service', 'title description adminPrice duration photo')
    .populate('rejectedVendors', 'name')
    .populate('laterVendors', 'name');

  if (!booking) {
    throw new Error('Booking not found');
  }

  console.log('DEBUG: getBookingDetails called for', bookingId);
  console.log('DEBUG: userRequestedServices:', JSON.stringify(booking.userRequestedServices, null, 2));

  // Fetch optional related items
  const [feedback, disputes] = await Promise.all([
    Feedback.findOne({ booking: bookingId }),
    Dispute.find({ booking: bookingId }).populate('raisedBy', 'name role phoneNumber')
  ]);

  // Transform status history for better admin readability
  const statusLabels = {
    'pending_acceptance': 'Waiting for Vendor',
    'pending': 'Accepted by Vendor',
    'price_proposed': 'Price Proposed',
    'price_confirmed': 'Price Confirmed',
    'rescheduled': 'Rescheduled',
    'extra_services_requested': 'Extra Services Requested',
    'extra_services_priced': 'Extra Services Priced',
    'extra_services_accepted': 'Extra Services Accepted',
    'extra_services_rejected': 'Extra Services Rejected',
    'on_the_way': 'Vendor on the Way',
    'arrived': 'Vendor Arrived',
    'ongoing': 'Work in Progress',
    'completed': 'Job Completed',
    'cancelled': 'Cancelled'
  };

  const istOptions = { 
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  };

  const enhancedHistory = [...(booking.statusHistory || [])]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map(h => {
      const istTime = h.timestamp ? new Date(h.timestamp).toLocaleString('en-IN', istOptions) : null;
      return {
        status: h.status,
        label: statusLabels[h.status] || h.status,
        reason: h.reason || null,
        actor: h.actor || null,
        timestamp: istTime || h.timestamp,
        timestampIST: istTime
      };
    });

  // Compute pricing breakdown including extra services
  const baseServicesTotal = (booking.services || []).reduce((sum, s) => sum + (s.finalPrice || 0), 0);
  const extraServicesTotal = (booking.userRequestedServices || [])
    .filter(s => ['priced', 'accepted'].includes(s.status) || s.isPriceConfirmed)
    .reduce((sum, s) => sum + (s.finalPrice || 0), 0);
  const proposedServicesTotal = (booking.proposedServices || []).reduce((sum, s) => sum + (s.finalPrice || 0), 0);
  const travelCharge = booking.pricing?.travelCharge || 0;
  const additionalCharges = booking.pricing?.additionalCharges || 0;
  const computedTotal = baseServicesTotal + extraServicesTotal + proposedServicesTotal + travelCharge + additionalCharges;

  const pricingBreakdown = {
    baseServicesTotal,
    extraServicesTotal,
    proposedServicesTotal,
    travelCharge,
    additionalCharges,
    computedTotal,
    storedTotal: booking.pricing?.totalPrice || 0
  };

  return {
    booking: {
      ...booking.toJSON(),
      statusLabel: statusLabels[booking.status] || booking.status,
      statusHistory: enhancedHistory, // Overwrite original statusHistory with enhanced one for the frontend
      enhancedHistory, // Keep as separate field too just in case
      pricingBreakdown
    },
    feedback,
    disputes
  };
};

const exportBookingsCSV = async (query = {}) => {
  const { bookings } = await getAllBookings({ ...query, limit: 10000 });
  const { parse } = require('json2csv');

  const fields = [
    { label: 'Booking ID', value: 'bookingID' },
    { label: 'Status', value: 'status' },
    { label: 'Scheduled Date', value: (row) => row.scheduledDate ? new Date(row.scheduledDate).toLocaleDateString() : 'N/A' },
    { label: 'Scheduled Time', value: 'scheduledTime' },
    { label: 'User Name', value: 'user.name' },
    { label: 'User Phone', value: 'user.phoneNumber' },
    { label: 'Vendor Name', value: 'vendor.name' },
    { label: 'Vendor Phone', value: 'vendor.phoneNumber' },
    { label: 'Base Price', value: 'pricing.basePrice' },
    { label: 'Extra Services Amount', value: 'extraServicesAmount' },
    { label: 'Travel Charge', value: 'pricing.travelCharge' },
    { label: 'Total Price', value: 'computedTotal' },
    { label: 'Payment Method', value: (row) => row.payment?.method || 'N/A' },
    { label: 'Created At', value: (row) => new Date(row.createdAt).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }) }
  ];

  return parse(bookings, { fields });
};

const exportAuditLogsCSV = async (query = {}) => {
  const { limit = 10000, skip = 0, action } = query;
  const filter = action ? { action } : {};
  const logs = await AuditLog.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip)
    .populate('user', 'name username');

  const { parse } = require('json2csv');

  const fields = [
    { label: 'Date', value: (row) => new Date(row.createdAt).toLocaleString() },
    { label: 'Action', value: 'action' },
    { label: 'Performed By', value: (row) => row.user?.name || row.user?.username || 'System' },
    { label: 'User Model', value: 'userModel' },
    { label: 'IP Address', value: 'ip' },
    { label: 'Details', value: (row) => JSON.stringify(row.details) }
  ];

  return parse(logs, { fields });
};

module.exports = {
  getDashboardStats,
  getAllUsers,
  updateUserStatus,
  deleteUser,
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
  getMembershipPricing,
  updateMembershipPricing,
  getAllBookings,
  getBookingDetails,
  exportBookingsCSV,
  exportAuditLogsCSV,
};
