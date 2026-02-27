const Booking = require('../../models/Booking.model');
const Vendor = require('../../models/Vendor.model');
const Service = require('../../models/Service.model');
const User = require('../../models/User.model');

const ApiError = require('../../utils/ApiError');
const cacheService = require('../../services/cache.service');
const adminService = require('../admin/admin.service');

const crypto = require('crypto');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

/**
 * Request a lead (User initiates)
 */
const requestLead = async (
    userId,
    { subcategoryId, address, pincode, scheduledDate, scheduledTime }
) => {
    const todayStr = new Date().toDateString();

    const potentialVendors = await Vendor.find({
        isVerified: true,
        isSuspended: false,
        registrationStep: 'COMPLETED',
        selectedSubcategories: subcategoryId,
        workPincodes: pincode,
        'creditPlan.expiryDate': { $gt: new Date() }
    });

    const dailyLeadsLimit = (await adminService.getSetting('bookings.daily_leads_limit')) || 5;

    const matchingVendors = potentialVendors.filter(vendor => {
        const lastReset = vendor.creditPlan.lastLeadResetDate;
        const currentCount =
            lastReset && lastReset.toDateString() === todayStr
                ? vendor.creditPlan.dailyLeadsCount
                : 0;

        const limit = vendor.creditPlan.dailyLimit || dailyLeadsLimit;
        return currentCount < limit;
    });

    if (matchingVendors.length === 0) {
        throw new ApiError(
            404,
            'No available vendors found for this service and area (or limits reached)'
        );
    }

    const now = new Date();
    for (const vendor of matchingVendors) {
        const lastReset = vendor.creditPlan.lastLeadResetDate;
        if (!lastReset || lastReset.toDateString() !== todayStr) {
            vendor.creditPlan.dailyLeadsCount = 1;
            vendor.creditPlan.lastLeadResetDate = now;
        } else {
            vendor.creditPlan.dailyLeadsCount += 1;
        }
        await vendor.save();
    }

    const booking = await Booking.create({
        bookingID: `BK-${uuidv4().slice(0, 8).toUpperCase()}`,
        user: userId,
        status: 'pending_acceptance',
        scheduledDate: scheduledDate || new Date(),
        scheduledTime: scheduledTime || '00:00',
        location: { address, pincode }
    });

    return {
        booking,
        availableVendorsCount: matchingVendors.length,
        message: 'Lead broadcasted to available vendors'
    };
};

/**
 * Accept a lead (Vendor accepts)
 */
const acceptLead = async (vendorId, bookingId) => {
    const query = mongoose.isValidObjectId(bookingId)
        ? { $or: [{ _id: bookingId }, { bookingID: bookingId }] }
        : { bookingID: bookingId };

    const booking = await Booking.findOne(query);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'pending_acceptance') {
        throw new ApiError(400, 'Lead already accepted or cancelled');
    }

    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Generate Start OTP and assign the vendor

    // Generate Start OTP and assign the vendor
    const startOTP = '1234';
    const completionOTP = '4321';

    booking.vendor = vendorId;
    booking.status = 'pending'; // enters standard booking lifecycle
    booking.otp = { startOTP, completionOTP };

    await booking.save();

    // Fetch fully populated booking object for the frontend
    const populatedBooking = await getBookingDetails(booking._id, vendorId, 'vendor');

    return {
        booking: populatedBooking,
        message: 'Lead accepted successfully'
    };
};

/**
 * Vendor marks themselves as On the Way
 */
const markOnTheWay = async (vendorId, bookingId) => {
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'pending') {
        throw new ApiError(400, 'Booking must be in pending status to mark as on the way');
    }

    booking.status = 'on_the_way';
    await booking.save();

    // Fetch fully populated booking object for the frontend
    const populatedBooking = await getBookingDetails(bookingId, vendorId, 'vendor');

    return { booking: populatedBooking, message: 'Status updated to On The Way' };
};

/**
 * Vendor marks themselves as Arrived
 */
const markArrived = async (vendorId, bookingId) => {
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'on_the_way') {
        throw new ApiError(400, 'Booking must be on the way first');
    }

    booking.status = 'arrived';
    booking.vendorArrivedAt = new Date();
    await booking.save();

    // Fetch fully populated booking object for the frontend
    const populatedBooking = await getBookingDetails(bookingId, vendorId, 'vendor');

    return { booking: populatedBooking, message: 'Status updated to Arrived' };
};

/**
 * Vendor starts work using the Start OTP
 */
const startWork = async (vendorId, bookingId, enteredOTP) => {
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'arrived') {
        throw new ApiError(400, 'Vendor must arrive before starting work');
    }

    const validStartOTP = booking.otp?.startOTP || '1234';
    if (!enteredOTP || enteredOTP.toString() !== validStartOTP) {
        throw new ApiError(400, 'Invalid Start OTP');
    }

    booking.status = 'ongoing';
    booking.workStartedAt = new Date();
    await booking.save();

    // Fetch fully populated booking object for the frontend
    const populatedBooking = await getBookingDetails(bookingId, vendorId, 'vendor');

    return { booking: populatedBooking, message: 'Work started successfully' };
};

/**
 * Request Completion OTP
 */
const requestCompletionOTP = async (vendorId, bookingId) => {
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'ongoing') {
        throw new ApiError(400, 'Booking must be ongoing to request completion');
    }

    const completionOTP = '4321';
    booking.otp = { ...booking.otp, completionOTP };
    await booking.save();

    // Fetch fully populated booking object for the frontend
    const populatedBooking = await getBookingDetails(bookingId, vendorId, 'vendor');

    return { booking: populatedBooking, message: 'Completion OTP generated successfully' };
};

/**
 * Complete Work
 */
const completeWork = async (vendorId, bookingId, enteredOTP, paymentMethod) => {
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'ongoing') {
        throw new ApiError(400, 'Booking must be ongoing to complete');
    }

    if (!booking.otp?.completionOTP) {
        throw new ApiError(400, 'Completion OTP was never requested');
    }

    const validCompletionOTP = booking.otp?.completionOTP || '4321';
    if (!enteredOTP || enteredOTP.toString() !== validCompletionOTP) {
        throw new ApiError(400, 'Invalid Completion OTP');
    }

    if (!paymentMethod || !['cash', 'upi', 'other'].includes(paymentMethod)) {
        throw new ApiError(400, 'Valid payment method is required to complete booking');
    }

    booking.status = 'completed';
    booking.payment = {
        ...booking.payment,
        method: paymentMethod,
        status: 'completed'
    };
    booking.workCompletedAt = new Date();
    await booking.save();

    // Fetch fully populated booking object for the frontend
    const populatedBooking = await getBookingDetails(bookingId, vendorId, 'vendor');

    return { booking: populatedBooking, message: 'Booking completed successfully' };
};

const findBookingByUser = async (bookingId, userId) => {
    const query = { user: userId };

    if (mongoose.isValidObjectId(bookingId)) {
        query.$or = [{ _id: bookingId }, { bookingID: bookingId }];
    } else {
        query.bookingID = bookingId;
    }

    return Booking.findOne(query);
};

/**
 * Get full booking details with population
 */
const getBookingDetails = async (bookingId, userId, role) => {
    const query = role === 'vendor' ? { vendor: userId } : { user: userId };

    if (mongoose.isValidObjectId(bookingId)) {
        query.$or = [{ _id: bookingId }, { bookingID: bookingId }];
    } else {
        query.bookingID = bookingId;
    }

    const booking = await Booking.findOne(query)
        .populate('services.service')
        .populate('vendor', 'name phoneNumber photo')
        .populate('user', 'name phoneNumber photo');

    if (!booking) {
        throw new ApiError(404, 'Booking not found');
    }

    const bookingObj = booking.toObject();

    // User friendly status mapping
    const statusMap = {
        'pending_acceptance': 'Pending Acceptance',
        'pending': 'Accepted',
        'on_the_way': 'Vendor on the Way',
        'arrived': 'Vendor Arrived',
        'ongoing': 'Working',
        'completed': 'Completed',
        'cancelled': 'Cancelled'
    };
    bookingObj.displayStatus = statusMap[booking.status] || booking.status;

    // OTP visibility logic
    if (bookingObj.otp) {
        if (role === 'user') {
            // User sees everything, but we provide helpers for current state
            if (['pending', 'on_the_way', 'arrived'].includes(bookingObj.status)) {
                bookingObj.currentOTP = {
                    label: 'Start OTP',
                    code: bookingObj.otp.startOTP || '1234',
                    instruction: 'Give this to the vendor to Start Work'
                };
            } else if (bookingObj.status === 'ongoing') {
                bookingObj.currentOTP = {
                    label: 'Completion OTP',
                    code: bookingObj.otp.completionOTP || '4321',
                    instruction: 'Give this to the vendor to Complete Work'
                };
            }
            // Keep the raw otp object as user requested "dont want hide"
        } else {
            // Vendors/others never see the OTP codes directly
            delete bookingObj.otp;
        }
    }

    return bookingObj;
};

/**
 * Generate unique booking ID
 */
const generateBookingID = () => {
    const timestamp = Date.now().toString().slice(-6);
    const random = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `B${timestamp}${random}`;
};

/**
 * Create booking (full flow)
 */
const createBooking = async (userId, bookingData) => {
    console.log("createBooking CALLED. userId:", userId);
    console.log("bookingData:", JSON.stringify(bookingData));
    const {
        services,
        date,
        time,
        address,
        totalPrice,
        latitude,
        longitude,
        pincode,
        confirmation,
        otp
    } = bookingData;

    if (!services || services.length === 0) {
        throw new ApiError(400, 'At least one service is required');
    }

    const existingBookingsCount = await Booking.countDocuments({ user: userId });

    // First booking OTP requirement
    if (existingBookingsCount === 0) {
        if (!otp || otp.toString() !== '1234') {
            throw new ApiError(400, 'FIRST_BOOKING_OTP_REQUIRED');
        }
    }

    const processedServices = [];
    for (const item of services) {
        const serviceDoc = await Service.findById(item.serviceId);
        if (!serviceDoc) {
            throw new ApiError(`Service ${item.serviceId} not found`);
        }

        processedServices.push({
            service: serviceDoc._id,
            quantity: item.quantity || 1,
            adminPrice: serviceDoc.adminPrice,
            finalPrice: serviceDoc.adminPrice
                ? serviceDoc.adminPrice * (item.quantity || 1)
                : 0,
            isPriceConfirmed: !!serviceDoc.adminPrice
        });
    }

    const booking = await Booking.create({
        bookingID: generateBookingID(),
        user: userId,
        services: processedServices,
        scheduledDate: new Date(date),
        scheduledTime: time,
        location: { address, latitude, longitude, pincode },
        pricing: { totalPrice: totalPrice || 0, basePrice: totalPrice || 0 },
        status: 'pending_acceptance'
    });

    if (confirmation === true) {
        searchVendors(booking, true).catch(console.error);
    }

    return booking;
};

/**
 * Vendor search and broadcast
 */
const searchVendors = async (booking, broadcast = false) => {
    const radius = (await adminService.getSetting('bookings.vendor_search_radius_km')) || 5;

    const serviceIds = booking.services.map(s => s.service);
    const ignoredVendors = [
        ...(booking.rejectedVendors || []),
        ...(booking.laterVendors || [])
    ].map(id => id.toString());

    const query = {
        isOnline: true,
        isActive: true,
        isVerified: true,
        isSuspended: false,
        isBlocked: false,
        selectedServices: { $in: serviceIds }
    };

    if (ignoredVendors.length > 0) {
        query._id = { $nin: ignoredVendors };
    }

    const vendors = await Vendor.find(query).select('_id');

    if (broadcast) {
        try {
            const { getVendorSockets, getIo } = require('../../socket');
            const io = getIo();
            let broadcastCount = 0;

            const populatedBooking = await Booking.findById(booking._id)
                .populate('services.service', 'title photo adminPrice')
                .populate('user', 'name phoneNumber photo');

            vendors.forEach(v => {
                const socketIds = getVendorSockets(v._id);
                if (socketIds && socketIds.length > 0) {
                    socketIds.forEach(socketId => {
                        io.to(socketId).emit('new_booking_request', populatedBooking);
                    });
                    broadcastCount++;
                }
            });
            console.log(`📡 Broadcasted booking ${booking._id} to ${broadcastCount} vendors via WebSocket.`);
        } catch (error) {
            console.error('Socket.io error during broadcast:', error.message);
        }
    }

    return vendors.map(v => ({
        vendorId: v._id,
        distance: 0 // Placeholder for real distance calculation
    }));
};

const rejectLead = async (vendorId, bookingId) => {
    const booking = await Booking.findById(bookingId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    const vendorIdStr = vendorId.toString();

    // Add to rejected if not already there
    if (!booking.rejectedVendors.some(id => id.toString() === vendorIdStr)) {
        booking.rejectedVendors.push(vendorId);
    }

    // Always remove from laterVendors when rejecting
    booking.laterVendors = booking.laterVendors.filter(id => id.toString() !== vendorIdStr);

    await booking.save();

    return {
        booking,
        message: 'Booking rejected and removed from your list'
    };
};

const markLeadLater = async (vendorId, bookingId) => {
    const booking = await Booking.findById(bookingId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    // Only allow if it's still pending acceptance
    if (booking.status !== 'pending_acceptance') {
        throw new ApiError(400, 'Booking is no longer available');
    }

    const vendorIdStr = vendorId.toString();

    // Add to later if not already there
    if (!booking.laterVendors.some(id => id.toString() === vendorIdStr)) {
        booking.laterVendors.push(vendorId);
    }

    // Remove from rejected if it was there
    booking.rejectedVendors = booking.rejectedVendors.filter(id => id.toString() !== vendorIdStr);

    await booking.save();

    return {
        booking,
        message: 'Booking marked for later successfully'
    };
};

/**
 * Get vendor booking history (including Later)
 */
const getVendorBookingHistory = async (vendorId) => {
    const vendorIdObj = new mongoose.Types.ObjectId(vendorId);

    // 1. Pending (Accepted by vendor but not started)
    // 2. Ongoing (started)
    // 3. Completed
    const activeAndHistoryBookings = await Booking.find({
        vendor: vendorIdObj,
        status: { $in: ['pending', 'ongoing', 'completed', 'on_the_way', 'arrived'] }
    })
        .select('-rejectedVendors -laterVendors')
        .populate('services.service', 'title adminPrice photo')
        .populate('user', 'name phoneNumber photo')
        .sort({ createdAt: -1 });

    const categorized = {
        pending: activeAndHistoryBookings.filter(b => ['pending', 'on_the_way', 'arrived'].includes(b.status)),
        ongoing: activeAndHistoryBookings.filter(b => b.status === 'ongoing'),
        completed: activeAndHistoryBookings.filter(b => b.status === 'completed')
    };

    return categorized;
};

/**
 * Get Vendor's Later Bookings List
 */
const getVendorLaterBookings = async (vendorId) => {
    const vendorIdObj = new mongoose.Types.ObjectId(vendorId);

    // Later Bookings (Only those still pending acceptance!)
    const laterBookings = await Booking.find({
        laterVendors: vendorIdObj,
        status: 'pending_acceptance'
    })
        .select('-rejectedVendors -laterVendors')
        .populate('services.service', 'title adminPrice photo')
        .populate('user', 'name phoneNumber photo')
        .sort({ createdAt: -1 });

    return laterBookings;
};

/**
 * Cancel booking
 */
const cancelBooking = async (userId, bookingId, reason) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    const lockMins = (await adminService.getSetting('bookings.cancellation_lock_mins')) || 60;
    const scheduledTime = new Date(booking.scheduledDate);
    // Parse scheduledTime string (HH:MM) if necessary, but here we assume scheduledDate is the base
    // This part depends on how date/time are stored. Assuming scheduledDate has the correct date.

    const now = new Date();
    const diffMs = scheduledTime - now;
    const diffMins = Math.floor(diffMs / (1000 * 60));

    if (diffMins < lockMins && diffMins > 0) {
        throw new ApiError(400, `Booking cannot be cancelled within ${lockMins} minutes of the scheduled time`);
    }

    booking.status = 'cancelled';
    booking.cancellation = {
        cancelledBy: 'user',
        reason,
        cancelledAt: now
    };

    await booking.save();

    const populatedBooking = await Booking.findById(booking._id)
        .populate('services.service', 'title adminPrice photo')
        .populate('vendor', 'name phoneNumber photo')
        .populate('user', 'name phoneNumber photo');

    return populatedBooking || booking;
};

/**
 * Reschedule booking
 */
const rescheduleBooking = async (userId, bookingId, { date, time }) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    const rescheduleLimit = (await adminService.getSetting('bookings.reschedule_limit')) || 2;
    if (booking.rescheduleCount >= rescheduleLimit) {
        throw new ApiError(400, `Max reschedule limit of ${rescheduleLimit} reached`);
    }

    if (['completed', 'cancelled'].includes(booking.status)) {
        throw new ApiError(400, 'Cannot reschedule');
    }

    booking.scheduledDate = new Date(date);
    booking.scheduledTime = time;
    booking.rescheduleCount += 1;

    await booking.save();

    // Fetch fully populated booking object for the frontend
    const populatedBooking = await getBookingDetails(booking._id, userId, 'user');

    return populatedBooking;
};

const getBookingsByUser = async (userId) =>
    Booking.find({ user: userId })
        .populate('services.service', 'title adminPrice photo')
        .populate('vendor', 'name phoneNumber photo')
        .populate('user', 'name phoneNumber photo')
        .sort({ createdAt: -1 });

const getBookingsByVendor = async (vendorId) =>
    Booking.find({ vendor: vendorId })
        .populate('services.service', 'title adminPrice photo')
        .populate('user', 'name phoneNumber photo')
        .populate('vendor', 'name phoneNumber photo')
        .sort({ createdAt: -1 });

/**
 * Get completed bookings for a user
 */
const getCompletedBookingsByUser = async (userId) => {
    return Booking.find({
        user: userId,
        status: 'completed'
    })
        .populate('services.service', 'title adminPrice photo')
        .populate('vendor', 'name phoneNumber photo')
        .sort({ createdAt: -1 });
};

const retrySearchVendors = async (userId, bookingId) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'pending_acceptance') {
        throw new ApiError(400, 'Retry allowed only for pending bookings');
    }

    const nearby = await searchVendors(booking, true);
    return { found: nearby.length > 0, count: nearby.length };
};

module.exports = {
    // Lead flow
    requestLead,
    acceptLead,
    rejectLead,
    markLeadLater,

    // Booking flow
    createBooking,
    generateBookingID,
    searchVendors,
    cancelBooking,
    rescheduleBooking,
    findBookingByUser,
    getBookingDetails,
    getBookingsByUser,
    getBookingsByVendor,
    getCompletedBookingsByUser,
    getVendorBookingHistory,
    getVendorLaterBookings,
    retrySearchVendors,

    // Post-acceptance execution flow
    markOnTheWay,
    markArrived,
    startWork,
    requestCompletionOTP,
    completeWork
};
