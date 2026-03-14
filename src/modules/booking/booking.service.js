const Booking = require('../../models/Booking.model');
const Vendor = require('../../models/Vendor.model');
const Service = require('../../models/Service.model');
const User = require('../../models/User.model');
const { ROLES } = require('../../constants/roles');


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
        statusHistory: [{ status: 'pending_acceptance', timestamp: new Date() }],
        scheduledDate: scheduledDate || new Date(),
        scheduledTime: scheduledTime || '00:00',
        location: { address, pincode }
    });

    const searchTimeoutMins = (await adminService.getSetting('bookings.search_timeout_mins')) || 2;

    // Trigger broadcast (similar to createBooking)
    searchVendors(booking, true).catch(console.error);

    console.log(`[DEBUG] Lead request created: ${booking._id}, status: ${booking.status}`);
    return {
        booking,
        availableVendorsCount: matchingVendors.length,
        searchTimeoutMins,
        message: 'Lead broadcasted to available vendors'
    };
};

/**
 * Accept a lead (Vendor accepts)
 */
const acceptLead = async (vendorId, bookingId) => {
    console.log(`[SOCKET] acceptLead called for vendor: ${vendorId}, booking: ${bookingId}`);
    const query = mongoose.isValidObjectId(bookingId)
        ? { $or: [{ _id: bookingId }, { bookingID: bookingId }] }
        : { bookingID: bookingId };

    const vendor = await Vendor.findById(vendorId);
    if (!vendor) {
        console.log(`[SOCKET] Vendor not found: ${vendorId}`);
        throw new ApiError(404, 'Vendor not found');
    }

    // ── Credit/Coin check DISABLED ──
    /*
    const coinCost = (await adminService.getSetting('pricing.accept_lead_coin_cost')) || 10;
    if (vendor.coins < coinCost) {
        throw new ApiError(400, `Insufficient coins. You need ${coinCost} coins to accept a lead (you have ${vendor.coins}).`);
    }
    */

    // ── Fetch booking first (for overlap check) ──
    const pendingBooking = await Booking.findOne({ ...query, status: 'pending_acceptance' });
    if (!pendingBooking) {
        const existingBooking = await Booking.findOne(query);
        if (!existingBooking) throw new ApiError(404, 'Booking not found');
        throw new ApiError(400, 'You missed your order! This booking has already been accepted by another vendor.');
    }

    // ── Schedule overlap check ──
    const overlapping = await Booking.findOne({
        vendor: vendorId,
        _id: { $ne: pendingBooking._id },
        scheduledDate: pendingBooking.scheduledDate,
        scheduledTime: pendingBooking.scheduledTime,
        status: { $nin: ['cancelled', 'completed', 'pending_acceptance'] }
    });
    if (overlapping) {
        throw new ApiError(400, 'You already have a booking at this date and time slot. Cannot accept overlapping bookings.');
    }

    // ── Grace period calculation ──
    const graceMins = (await adminService.getSetting('bookings.grace_period_mins')) || 30;
    let gracePeriodEnd = null;
    if (pendingBooking.scheduledDate && pendingBooking.scheduledTime) {
        const [hours, minutes] = pendingBooking.scheduledTime.split(':').map(Number);
        const schedDate = new Date(pendingBooking.scheduledDate);
        schedDate.setHours(hours || 0, minutes || 0, 0, 0);
        gracePeriodEnd = new Date(schedDate.getTime() + graceMins * 60 * 1000);
    }

    // Generate Start OTP
    const startOTP = '1234';

    // Atomic update
    console.log(`[SOCKET] Attempting atomic update for booking: ${bookingId}`);
    const booking = await Booking.findOneAndUpdate(
        { _id: pendingBooking._id, status: 'pending_acceptance' },
        {
            $set: {
                vendor: vendorId,
                status: 'pending',
                otp: { startOTP, completionOTP: null },
                ...(gracePeriodEnd && { gracePeriodEnd })
            },
            $push: {
                statusHistory: { status: 'pending', timestamp: new Date() }
            }
        },
        { new: true }
    );

    if (!booking) {
        throw new ApiError(400, 'You missed your order! This booking has already been accepted by another vendor.');
    }

    // ── Emit acceptance update IMMEDIATELY after locking ──
    try {
        const { emitToUser } = require('../../socket');
        emitToUser(booking.user, 'booking_search_update', {
            bookingId: booking._id,
            bookingID: booking.bookingID,
            status: 'accepted',
            message: 'A vendor has accepted your booking request!'
        });
        console.log(`[SOCKET] Emitted 'accepted' status update for user: ${booking.user}`);
    } catch (socketErr) {
        console.error(`[SOCKET] Failed to emit search update in acceptLead: ${socketErr.message}`);
    }

    // ── Deduct coins from vendor DISABLED ──
    /*
    vendor.coins -= coinCost;
    await vendor.save();
    console.log(`[SOCKET] Deducted ${coinCost} coins from vendor ${vendorId}. New balance: ${vendor.coins}`);
    */

    console.log(`[SOCKET] Lead ${bookingId} locked by vendor ${vendorId}`);

    const userPayload = await getBookingDetails(booking._id, booking.user, 'user');
    const vendorPayload = await getBookingDetails(booking._id, vendorId, 'vendor');

    const { emitToUser, emitToVendor, activeVendors, getIo } = require('../../socket');

    const userIdStr = booking.user.toString();
    console.log(`[SOCKET] Emitting standard status updates to user: ${userIdStr}`);

    emitToUser(userIdStr, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    const io = getIo();
    console.log(`[SOCKET] Notifying other vendors about acceptance`);
    const vendorIdStr = vendorId.toString();
    activeVendors.forEach((socketIds, otherVendorId) => {
        if (otherVendorId.toString() !== vendorIdStr) {
            socketIds.forEach(socketId => {
                io.to(socketId).emit('booking_already_accepted', {
                    bookingId: booking._id,
                    bookingID: booking.bookingID,
                    message: 'You missed your order! This booking has already been accepted by another vendor.'
                });
            });
        }
    });

    console.log(`[SOCKET] acceptLead completed successfully for booking: ${bookingId}`);
    return {
        bookingId: booking._id,
        bookingID: booking.bookingID,
        booking: vendorPayload,
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
    booking.statusHistory.push({ status: 'on_the_way', timestamp: new Date() });
    booking.markModified('statusHistory');
    await booking.save();
    console.log(`[DEBUG] Status updated to On The Way: ${bookingId}, history length: ${booking.statusHistory.length}`);

    // Fetch role-specific payloads for the socket emissions
    const userPayload = await getBookingDetails(bookingId, booking.user, ROLES.USER);
    const vendorPayload = await getBookingDetails(bookingId, vendorId, ROLES.VENDOR);

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    return { booking: vendorPayload, message: 'Status updated to On The Way' };
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
    booking.statusHistory.push({ status: 'arrived', timestamp: new Date() });
    booking.markModified('statusHistory');
    booking.vendorArrivedAt = new Date();
    await booking.save();
    console.log(`[DEBUG] Status updated to Arrived: ${bookingId}, history length: ${booking.statusHistory.length}`);

    // Fetch role-specific payloads for the socket emissions
    const userPayload = await getBookingDetails(bookingId, booking.user, 'user');
    const vendorPayload = await getBookingDetails(bookingId, vendorId, 'vendor');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    return { booking: vendorPayload, message: 'Status updated to Arrived' };

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
    if (!booking.isPriceConfirmed) {
        throw new ApiError(400, "Price must be confirmed by user before starting work");
    }
    if (!enteredOTP || enteredOTP.toString() !== validStartOTP) {
        throw new ApiError(400, 'Invalid Start OTP');
    }

    booking.status = 'ongoing';
    booking.statusHistory.push({ status: 'ongoing', timestamp: new Date() });
    booking.markModified('statusHistory');
    booking.workStartedAt = new Date();
    await booking.save();
    console.log(`[DEBUG] Status updated to Ongoing/Working: ${bookingId}, status field is now: ${booking.status}, history length: ${booking.statusHistory.length}`);

    // Fetch role-specific payloads for the socket emissions
    const userPayload = await getBookingDetails(bookingId, booking.user, 'user');
    const vendorPayload = await getBookingDetails(bookingId, vendorId, 'vendor');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    return { booking: vendorPayload, message: 'Work started successfully' };

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
    if (!booking.otp) {
        booking.otp = { startOTP: '1234', completionOTP };
    } else {
        booking.otp.completionOTP = completionOTP;
    }
    booking.markModified('otp');
    await booking.save();

    // Fetch role-specific payloads for the socket emissions
    const userPayload = await getBookingDetails(bookingId, booking.user, 'user');
    const vendorPayload = await getBookingDetails(bookingId, vendorId, 'vendor');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    return { booking: vendorPayload, message: 'Completion OTP generated successfully' };

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
    booking.statusHistory.push({ status: 'completed', timestamp: new Date() });
    booking.markModified('statusHistory');
    booking.payment = {
        ...booking.payment,
        method: paymentMethod,
        status: 'completed'
    };
    booking.workCompletedAt = new Date();
    await booking.save();
    console.log(`[DEBUG] Status updated to Completed: ${bookingId}, history length: ${booking.statusHistory.length}`);

    // Fetch role-specific payloads for the socket emissions
    const userPayload = await getBookingDetails(bookingId, booking.user, 'user');
    const vendorPayload = await getBookingDetails(bookingId, vendorId, 'vendor');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    return { booking: vendorPayload, message: 'Booking completed successfully' };

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
    let query = {};
    const isAdmin = role === 'admin' || role === 'super_admin';

    if (isAdmin) {
        // Admins can see any booking by ID
        query = {};
    } else if (role === 'vendor') {
        query = { vendor: userId };
    } else {
        query = { user: userId };
    }

    if (mongoose.isValidObjectId(bookingId)) {
        if (isAdmin) {
            query._id = bookingId;
        } else {
            query.$or = [{ _id: bookingId }, { bookingID: bookingId }];
        }
    } else {
        query.bookingID = bookingId;
    }

    const booking = await Booking.findOne(query)
        .populate('services.service')
        .populate('proposedServices.service')
        .populate('userRequestedServices.service')
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
        const isUserRole = role === 'user' || role === ROLES.USER;
        const isVendorRole = role === 'vendor' || role === ROLES.VENDOR;

        if (isUserRole) {
            // User sees everything, but we provide helpers for current state
            // and hide completion OTP until it's ready.
            const startOTPCode = bookingObj.otp.startOTP || '1234';
            const completionOTPCode = bookingObj.otp.completionOTP || null;

            bookingObj.currentOTP = {
                startOTP: {
                    label: 'Start OTP',
                    code: startOTPCode,
                    instruction: 'Give this to the vendor to Start Work'
                },
                completionOTP: {
                    label: 'Completion OTP',
                    code: completionOTPCode ? completionOTPCode : 'Hidden',
                    status: completionOTPCode ? 'available' : 'pending',
                    instruction: completionOTPCode
                        ? 'Give this to the vendor to Complete Work'
                        : 'Will be visible once vendor requests completion'
                }
            };

            // Maintain status specific convenience field if needed
            if (['pending', 'on_the_way', 'arrived'].includes(bookingObj.status)) {
                if (bookingObj.isPriceConfirmed) {
                    bookingObj.activeOTP = bookingObj.currentOTP.startOTP;
                } else {
                    bookingObj.activeOTP = {
                        label: 'Start OTP',
                        code: 'Locked',
                        instruction: 'Visible once price is confirmed'
                    };
                    bookingObj.currentOTP.startOTP.code = 'Locked';
                    bookingObj.currentOTP.startOTP.instruction = 'Price confirmation pending';
                }
            } else if (bookingObj.status === 'ongoing') {
                bookingObj.activeOTP = bookingObj.currentOTP.completionOTP;
            }

            // Expose the raw otp object but sanitize based on readiness
            if (!bookingObj.isPriceConfirmed) {
                bookingObj.otp.startOTP = 'Locked (Price Pending)';
            }
            if (!completionOTPCode) {
                bookingObj.otp.completionOTP = 'Hidden (Pending)';
            }
        } else if (isVendorRole) {
            // Vendors never see the OTP codes directly
            delete bookingObj.otp;
            delete bookingObj.currentOTP;
            delete bookingObj.activeOTP;
        }
        // If role is undefined (internal use), we keep the OTP as is
    }

    // Ensure extra services arrays always have pricing fields (for older documents)
    if (bookingObj.userRequestedServices) {
        bookingObj.userRequestedServices = bookingObj.userRequestedServices.map(item => ({
            ...item,
            adminPrice: item.adminPrice,
            vendorPrice: item.vendorPrice,
            finalPrice: item.finalPrice,
            isPriceConfirmed: item.isPriceConfirmed ?? false
        }));
    }


    // Ensure statusHistory is present and formatted
    if (bookingObj.statusHistory) {
        bookingObj.statusHistory = bookingObj.statusHistory.map(h => ({
            status: h.status,
            reason: h.reason,
            actor: h.actor,
            timestamp: h.timestamp,
            displayStatus: statusMap[h.status] || h.status
        }));
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
                : null,
            isPriceConfirmed: !!serviceDoc.adminPrice
        });
    }

    const adminService = require('../admin/admin.service');
    const baseTravelCharge = (await adminService.getSetting('pricing.travel_charge')) || 0;
    
    const calculatedBasePrice = processedServices.reduce((sum, s) => sum + (s.finalPrice || 0), 0);
    const calculatedTotalPrice = calculatedBasePrice + baseTravelCharge;

    const booking = await Booking.create({
        bookingID: generateBookingID(),
        user: userId,
        services: processedServices,
        scheduledDate: new Date(date),
        scheduledTime: time,
        location: { address, latitude, longitude, pincode },
        pricing: { 
            totalPrice: calculatedTotalPrice, 
            basePrice: calculatedBasePrice,
            travelCharge: baseTravelCharge 
        },
        status: 'pending_acceptance',
        statusHistory: [{ status: 'pending_acceptance', timestamp: new Date() }]
    });

    const searchTimeoutMins = (await adminService.getSetting('bookings.search_timeout_mins')) || 2;

    if (confirmation === true) {
        searchVendors(booking, true).catch(console.error);
    }

    return { booking, searchTimeoutMins };
};

/**
 * Helper to get the time range (start and end) for a booking
 */
const getBookingTimeRange = async (booking) => {
    // Ensure services are populated to get approxCompletionTime
    let bookingWithServices = booking;
    if (!booking.services?.[0]?.service?.approxCompletionTime) {
        bookingWithServices = await Booking.findById(booking._id).populate('services.service');
    }

    if (!bookingWithServices || !bookingWithServices.scheduledDate || !bookingWithServices.scheduledTime) {
        return null;
    }

    const [hours, minutes] = bookingWithServices.scheduledTime.split(':').map(Number);
    const start = new Date(bookingWithServices.scheduledDate);
    start.setHours(hours || 0, minutes || 0, 0, 0);

    let totalDuration = 0;
    bookingWithServices.services.forEach(item => {
        const duration = item.service?.approxCompletionTime || 60; // default 60 mins
        totalDuration += duration * (item.quantity || 1);
    });

    const end = new Date(start.getTime() + totalDuration * 60 * 1000);
    return { start, end };
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

    // ── Busy vendor exclusion logic ──
    const currentRange = await getBookingTimeRange(booking);
    const busyVendorIds = [];

    if (currentRange) {
        // Find all accepted/ongoing bookings for the same day
        const activeBookings = await Booking.find({
            scheduledDate: booking.scheduledDate,
            status: { $in: ['pending', 'on_the_way', 'arrived', 'ongoing'] },
            vendor: { $exists: true, $ne: null }
        }).populate('services.service');

        for (const activeBooking of activeBookings) {
            const range = await getBookingTimeRange(activeBooking);
            if (!range) continue;

            // Check for overlap: max(start1, start2) < min(end1, end2)
            const overlap = Math.max(currentRange.start, range.start) < Math.min(currentRange.end, range.end);
            if (overlap) {
                busyVendorIds.push(activeBooking.vendor.toString());
            }
        }
    }

    const query = {
        isOnline: true,
        isActive: true,
        isVerified: true,
        isSuspended: false,
        isBlocked: false,
        selectedServices: { $in: serviceIds }
    };

    const nins = [...new Set([...ignoredVendors, ...busyVendorIds])];
    if (nins.length > 0) {
        query._id = { $nin: nins };
    }

    const vendors = await Vendor.find(query).select('_id');

    if (broadcast) {
        try {
            const { getVendorSockets, getIo } = require('../../socket');
            const io = getIo();
            let broadcastCount = 0;

            const populatedBooking = await Booking.findById(booking._id)
                .populate('services.service', 'title photo adminPrice')
                .populate('proposedServices.service', 'title photo adminPrice')
                .populate('userRequestedServices.service', 'title photo adminPrice')
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

            const { emitToUser } = require('../../socket');
            if (broadcastCount > 0) {
                emitToUser(booking.user, 'booking_search_update', {
                    bookingId: booking._id,
                    bookingID: booking.bookingID,
                    status: 'searching',
                    vendorCount: broadcastCount,
                    message: `Searching for vendors... notified ${broadcastCount} available vendor(s).`
                });
            } else {
                emitToUser(booking.user, 'booking_search_update', {
                    bookingId: booking._id,
                    bookingID: booking.bookingID,
                    status: 'no_vendors_available',
                    message: 'No vendors are currently available in your area. You can try retrying in a few minutes.'
                });
            }

            console.log(`📡 Broadcasted booking ${booking._id} to ${broadcastCount} vendors via WebSocket.`);

            // ── Search Timeout Notification ──
            const searchTimeoutMins = (await adminService.getSetting('bookings.search_timeout_mins')) || 2;
            setTimeout(async () => {
                try {
                    const currentBooking = await Booking.findById(booking._id);
                    if (currentBooking && currentBooking.status === 'pending_acceptance') {
                        emitToUser(booking.user, 'booking_search_update', {
                            bookingId: booking._id,
                            bookingID: booking.bookingID,
                            status: 'timeout',
                            message: `The search window of ${searchTimeoutMins} mins has expired. No vendor has accepted yet. You can try searching again.`
                        });
                        console.log(`⏰ Search timeout notification sent for booking ${booking._id}`);
                    }
                } catch (err) {
                    console.error('Error during scheduled search timeout notification:', err);
                }
            }, searchTimeoutMins * 60 * 1000);
            
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

    if (['completed', 'cancelled'].includes(booking.status)) {
        throw new ApiError(400, 'Cannot cancel a booking that is already completed or cancelled');
    }

    // ── Cancel count enforcement ──
    const cancelLimit = (await adminService.getSetting('bookings.cancel_limit')) || 1;
    if (booking.cancelCount >= cancelLimit) {
        throw new ApiError(400, `Maximum cancellation limit of ${cancelLimit} reached for this booking`);
    }

    const lockMins = (await adminService.getSetting('bookings.cancellation_lock_mins')) || 60;
    
    // Combine scheduledDate and scheduledTime into a proper Date object
    const scheduledDateTime = new Date(booking.scheduledDate);
    if (booking.scheduledTime) {
        const [hours, minutes] = booking.scheduledTime.split(':').map(Number);
        scheduledDateTime.setHours(hours || 0, minutes || 0, 0, 0);
    }

    const now = new Date();
    const diffMs = scheduledDateTime - now;
    const diffMins = Math.floor(diffMs / (1000 * 60));

    if (diffMins < lockMins && diffMins > 0) {
        throw new ApiError(400, `Booking cannot be cancelled within ${lockMins} minutes of the scheduled time`);
    }

    // Determine travel charge based on vendor arrival status
    const vendorHasArrived = booking.status === 'arrived' || booking.status === 'ongoing';
    const travelChargeApplied = vendorHasArrived;

    booking.status = 'cancelled';
    booking.statusHistory.push({ status: 'cancelled', timestamp: new Date() });
    booking.markModified('statusHistory');
    booking.cancelCount += 1;
    booking.cancellation = {
        cancelledBy: 'user',
        reason,
        cancelledAt: now,
        travelChargeApplied
    };

    await booking.save();

    const populatedBooking = await Booking.findById(booking._id)
        .populate('services.service', 'title adminPrice photo')
        .populate('proposedServices.service', 'title adminPrice photo')
        .populate('userRequestedServices.service', 'title adminPrice photo')
        .populate('vendor', 'name phoneNumber photo')
        .populate('user', 'name phoneNumber photo');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', populatedBooking);
    if (booking.vendor) {
        emitToVendor(booking.vendor, 'booking_status_updated', populatedBooking);
    }

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
        .populate('proposedServices.service', 'title adminPrice photo')
        .populate('userRequestedServices.service', 'title adminPrice photo')
        .populate('vendor', 'name phoneNumber photo')
        .populate('user', 'name phoneNumber photo')
        .sort({ createdAt: -1 });

const getBookingsByVendor = async (vendorId) =>
    Booking.find({ vendor: vendorId })
        .populate('services.service', 'title adminPrice photo')
        .populate('proposedServices.service', 'title adminPrice photo')
        .populate('userRequestedServices.service', 'title adminPrice photo')
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
        .populate('proposedServices.service', 'title adminPrice photo')
        .populate('userRequestedServices.service', 'title adminPrice photo')
        .populate('vendor', 'name phoneNumber photo')
        .sort({ createdAt: -1 });
};

const retrySearchVendors = async (userId, bookingId) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'pending_acceptance') {
        throw new ApiError(400, 'Retry allowed only for pending bookings');
    }

    const searchTimeoutMins = (await adminService.getSetting('bookings.search_timeout_mins')) || 2;
    const nearby = await searchVendors(booking, true);

    return {
        found: nearby.length > 0,
        count: nearby.length,
        searchTimeoutMins, // Frontend uses this to know when to show "Try Again" again
        message: nearby.length > 0
            ? `Search sent to ${nearby.length} available vendor(s). Please wait ${searchTimeoutMins} min(s).`
            : 'No vendors are currently available. Please try again later.'
    };
};

/**
 * Get booking status history
 */
const getBookingStatusHistory = async (bookingId, userId, role) => {
    let query = {};
    const isAdmin = role === 'admin' || role === 'super_admin';

    if (isAdmin) {
        // Admins can see history of any booking
        query = {};
    } else if (role === 'vendor') {
        query = { vendor: userId };
    } else {
        query = { user: userId };
    }

    if (mongoose.isValidObjectId(bookingId)) {
        if (isAdmin) {
            query._id = bookingId;
        } else {
            query.$or = [{ _id: bookingId }, { bookingID: bookingId }];
        }
    } else {
        query.bookingID = bookingId;
    }

    const booking = await Booking.findOne(query).select('statusHistory displayStatus status');
    if (!booking) throw new ApiError(404, 'Booking not found');

    // Clean up history by removing any potential Mongoose ID fields for a cleaner response
    const cleanHistory = (booking.statusHistory || []).map(item => ({
        status: item.status,
        timestamp: item.timestamp
    }));

    return cleanHistory;
};

/**
 * Vendor updates price for unpriced services
 */
const updateBookingPrice = async (vendorId, bookingId, updatedServices) => {
    console.log(`[SOCKET] updateBookingPrice called for booking: ${bookingId}`);
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) {
        console.log(`[SOCKET] Booking not found for updateBookingPrice: ${bookingId}`);
        throw new ApiError(404, 'Booking not found');
    }

    if (booking.priceUpdatedOnce) {
        throw new ApiError(400, 'Price can only be updated once per booking');
    }

    if (!['pending', 'on_the_way', 'arrived'].includes(booking.status)) {
        throw new ApiError(400, 'Price can only be updated before starting work');
    }

    console.log(`[SOCKET] Processing updated services for booking: ${bookingId}`);
    let modified = false;
    for (const update of updatedServices) {
        const item = booking.services.find(s => s.service.toString() === update.serviceId.toString());
        if (item) {
            // Check if it was unpriced in Service model
            const serviceDoc = await Service.findById(item.service);
            if (serviceDoc && !serviceDoc.isAdminPriced) {
                console.log(`[SOCKET] Updating price for service: ${item.service}`);
                item.vendorPrice = update.price;
                item.finalPrice = update.price * (item.quantity || 1);
                item.isPriceConfirmed = false;
                modified = true;
            }
        }
    }

    if (!modified) {
        console.log(`[SOCKET] No unpriced services found for update: ${bookingId}`);
        throw new ApiError(400, 'No unpriced services found to update');
    }

    // Removed premature recalculation of total price.
    // The price will be updated when the user confirms the price via `confirmBookingPrice`

    booking.priceUpdatedOnce = true;
    booking.isPriceConfirmed = false;
    booking.priceConfirmationTimeout = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    console.log(`[SOCKET] Saving booking with updated price: ${bookingId}`);
    await booking.save();

    console.log(`[SOCKET] Fetching user payload for price update: ${bookingId}`);
    const userPayload = await getBookingDetails(booking._id, booking.user, 'user');
    const vendorPayload = await getBookingDetails(booking._id, vendorId, 'vendor');

    const { emitToUser, emitToVendor } = require('../../socket');

    // Notify both for state sync
    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    // Specific notification event
    emitToUser(booking.user, 'booking_price_proposed', userPayload);

    console.log(`[SOCKET] updateBookingPrice completed successfully for booking: ${bookingId}`);
    return { booking: userPayload, message: 'Price updated, awaiting user confirmation' };
};

/**
 * User confirms the updated price
 */
const confirmBookingPrice = async (userId, bookingId) => {
    const booking = await Booking.findOne({ _id: bookingId, user: userId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    booking.isPriceConfirmed = true;
    booking.services.forEach(s => s.isPriceConfirmed = true);

    // Recalculate total price now that it's confirmed
    const newBasePrice = booking.services.reduce((sum, s) => sum + (s.finalPrice || 0), 0);
    booking.pricing.basePrice = newBasePrice;
    booking.pricing.totalPrice = newBasePrice + (booking.pricing.travelCharge || 0) + (booking.pricing.additionalCharges || 0);

    // Log confirmation
    booking.statusHistory.push({
        status: 'price_confirmed',
        actor: 'user',
        timestamp: new Date()
    });
    booking.markModified('statusHistory');

    await booking.save();

    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
    const userPayload = await getBookingDetails(booking._id, userId, 'user');

    const { emitToVendor, emitToUser } = require('../../socket');

    // Notify both for state sync
    emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
    emitToUser(userId, 'booking_status_updated', userPayload);

    // Specific notification event
    emitToVendor(booking.vendor, 'booking_price_confirmed', vendorPayload);

    return { booking: userPayload, message: 'Price confirmed successfully' };
};

/**
 * User rejects the updated price
 */
const rejectBookingPrice = async (userId, bookingId, reason) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.isPriceConfirmed) {
        throw new ApiError(400, 'Cannot reject price that is already confirmed');
    }

    const now = new Date();
    booking.status = 'cancelled';
    booking.statusHistory.push({ 
        status: 'price_rejected', 
        actor: 'user',
        reason: reason || 'Price rejected by user',
        timestamp: now 
    });
    booking.markModified('statusHistory');

    booking.cancellation = {
        cancelledBy: 'user',
        reason: reason || 'Price rejected by user',
        cancelledAt: now,
        travelChargeApplied: false
    };

    await booking.save();

    const populatedBooking = await getBookingDetails(booking._id, userId, 'user');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(userId, 'booking_status_updated', populatedBooking);
    if (booking.vendor) {
        emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
    }

    return { booking: populatedBooking, message: 'Price rejected and booking cancelled' };
};

/**
 * Report Vendor No-Show (User triggers when vendor didn't come)
 * Free cancellation if grace period has elapsed and vendor hasn't arrived.
 */
const reportVendorNoShow = async (userId, bookingId) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (!['pending', 'on_the_way'].includes(booking.status)) {
        throw new ApiError(400, 'Vendor no-show can only be reported when vendor has not yet arrived');
    }

    const now = new Date();

    // Check grace period
    if (booking.gracePeriodEnd && now < booking.gracePeriodEnd) {
        throw new ApiError(400, 'Grace period has not yet elapsed. Please wait until the grace period ends.');
    }

    booking.status = 'cancelled';
    booking.statusHistory.push({ status: 'cancelled', timestamp: now });
    booking.markModified('statusHistory');
    booking.cancellation = {
        cancelledBy: 'system',
        reason: 'Vendor no-show — service provider did not arrive',
        cancelledAt: now,
        travelChargeApplied: false
    };

    await booking.save();

    const userPayload = await getBookingDetails(booking._id, userId, 'user');
    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(userId, 'booking_status_updated', userPayload);
    if (booking.vendor) {
        const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
        emitToVendor(booking.vendor, 'booking_vendor_no_show', vendorPayload);
    }

    return { booking: userPayload, message: 'Vendor no-show reported. Booking cancelled with no charges.' };
};

/**
 * Grace Period Cancel (User cancels because vendor missed the grace period)
 */
const gracePeriodCancel = async (userId, bookingId) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (['completed', 'cancelled'].includes(booking.status)) {
        throw new ApiError(400, 'Cannot cancel a completed or already cancelled booking');
    }

    // If vendor already arrived or work started, can't use grace period cancel
    if (['arrived', 'ongoing'].includes(booking.status)) {
        throw new ApiError(400, 'Vendor has already arrived. Grace period cancel is not applicable.');
    }

    const now = new Date();
    if (!booking.gracePeriodEnd || now < booking.gracePeriodEnd) {
        throw new ApiError(400, 'Grace period has not yet elapsed');
    }

    booking.status = 'cancelled';
    booking.statusHistory.push({ status: 'cancelled', timestamp: now });
    booking.markModified('statusHistory');
    booking.cancellation = {
        cancelledBy: 'user',
        reason: 'Cancelled after grace period — vendor did not arrive in time',
        cancelledAt: now,
        travelChargeApplied: false
    };

    await booking.save();

    const userPayload = await getBookingDetails(booking._id, userId, 'user');
    const { emitToUser, emitToVendor } = require('../../socket');

    emitToUser(userId, 'booking_status_updated', userPayload);

    if (booking.vendor) {
        const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
        emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
    }

    return { booking: userPayload, message: 'Booking cancelled (grace period elapsed). No charges applied.' };
};

/**
 * Propose additional services during ongoing booking (vendor proposes, user must confirm)
 */
const addServicesToBooking = async (vendorId, bookingId, newServices) => {
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    const allowedStatuses = ['pending', 'on_the_way', 'arrived', 'ongoing'];
    if (!allowedStatuses.includes(booking.status)) {
        throw new ApiError(400, 'Additional services can only be added after a lead is accepted and before completion');
    }

    if (!newServices || newServices.length === 0) {
        throw new ApiError(400, 'At least one service is required');
    }

    // Append instead of clearing older un-acted proposals
    if (!booking.proposedServices) {
        booking.proposedServices = [];
    }

    for (const item of newServices) {
        const serviceDoc = await Service.findById(item.serviceId);
        if (!serviceDoc) {
            throw new ApiError(404, `Service ${item.serviceId} not found`);
        }

        const qty = item.quantity || 1;
        const adminPrice = serviceDoc.adminPrice || null;
        const vendorPrice = adminPrice ? null : (item.price || null);
        const finalPrice = adminPrice
            ? adminPrice * qty
            : (vendorPrice ? vendorPrice * qty : null);

        // Stage in proposedServices, NOT services yet
        booking.proposedServices.push({
            service: serviceDoc._id,
            quantity: qty,
            adminPrice,
            vendorPrice,
            finalPrice,
        });
    }

    await booking.save();

    // Populate proposed services for the notification payload
    const populatedBooking = await Booking.findById(booking._id)
        .populate('proposedServices.service', 'title photo adminPrice');

    const { emitToUser, emitToVendor } = require('../../socket');
    const userPayload = await getBookingDetails(booking._id, booking.user, 'user');
    const vendorPayload = await getBookingDetails(booking._id, vendorId, 'vendor');

    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    // Legacy event for compatibility if needed, but booking_status_updated is primary
    emitToUser(booking.user, 'booking_services_proposed', {
        bookingId: booking._id,
        bookingID: booking.bookingID,
        proposedServices: populatedBooking.proposedServices,
        message: 'Vendor has proposed additional services. Please confirm or reject.'
    });

    return {
        booking: populatedBooking,
        message: 'Services proposed. Awaiting user confirmation.'
    };
};

/**
 * User confirms proposed services from vendor
 */
const confirmProposedServices = async (userId, bookingId) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (!booking.proposedServices || booking.proposedServices.length === 0) {
        throw new ApiError(400, 'No proposed services to confirm');
    }

    if (booking.status !== 'ongoing') {
        throw new ApiError(400, 'Booking is not in ongoing state');
    }

    // Move all proposed → services
    for (const proposed of booking.proposedServices) {
        booking.services.push({
            service: proposed.service,
            quantity: proposed.quantity,
            adminPrice: proposed.adminPrice,
            vendorPrice: proposed.vendorPrice,
            finalPrice: proposed.finalPrice,
            isPriceConfirmed: true, // User just confirmed
        });
    }

    // Recalculate total
    const newBasePrice = booking.services.reduce((sum, s) => sum + (s.finalPrice || 0), 0);
    booking.pricing.basePrice = newBasePrice;
    booking.pricing.totalPrice = newBasePrice + (booking.pricing.travelCharge || 0) + (booking.pricing.additionalCharges || 0);

    // Clear proposed
    booking.proposedServices = [];
    booking.isPriceConfirmed = true;

    await booking.save();

    const { emitToVendor, emitToUser } = require('../../socket');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
    const userPayload = await getBookingDetails(booking._id, userId, 'user');

    emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
    emitToUser(userId, 'booking_status_updated', userPayload);

    // Specific event
    emitToVendor(booking.vendor, 'booking_services_confirmed', {
        bookingId: booking._id,
        newTotal: booking.pricing.totalPrice,
        message: 'User confirmed the additional services.'
    });

    return {
        booking,
        message: 'Additional services confirmed and added to booking.'
    };
};

/**
 * User rejects proposed services from vendor
 */
const rejectProposedServices = async (userId, bookingId, reason) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (!booking.proposedServices || booking.proposedServices.length === 0) {
        throw new ApiError(400, 'No proposed services to reject');
    }

    // Clear proposed without adding to services
    booking.proposedServices = [];
    
    // Log rejection in history
    booking.statusHistory.push({
        status: 'proposed_services_rejected',
        actor: 'user',
        reason: reason || 'User rejected the additional services.',
        timestamp: new Date()
    });
    booking.markModified('statusHistory');

    await booking.save();

    const { emitToVendor, emitToUser } = require('../../socket');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
    const userPayload = await getBookingDetails(booking._id, userId, 'user');

    emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
    emitToUser(userId, 'booking_status_updated', userPayload);

    // Specific event
    emitToVendor(booking.vendor, 'booking_services_rejected', {
        bookingId: booking._id,
        reason: reason || 'User rejected the additional services.',
        message: 'User rejected the proposed services.'
    });

    return {
        booking,
        message: 'Proposed services rejected.'
    };
};

/**
 * User confirms the priced extra services from the vendor
 */
async function userConfirmExtraServices(userId, bookingId, acceptedServiceIds) {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (!booking.userRequestedServices || booking.userRequestedServices.length === 0) {
        throw new ApiError(400, 'No extra services pending approval');
    }

    if (!acceptedServiceIds || acceptedServiceIds.length === 0) {
        throw new ApiError(400, 'Please provide the IDs of the services you wish to accept');
    }

    let isUpdated = false;

    // Filter which ones the user accepted and which to keep/discard
    const remainingRequests = [];

    for (const requestItem of booking.userRequestedServices) {
        const sid = requestItem.service.toString();
        
        // If user accepted this service
        if (acceptedServiceIds.includes(sid)) {
            // Must have been priced by vendor
            if (requestItem.adminPrice === 0 && requestItem.vendorPrice === 0) {
                // If it's literally free, maybe allow it, but usually this means unpriced
                // We'll trust finalPrice. If finalPrice is undefined, don't allow.
                if (requestItem.finalPrice == null) {
                    remainingRequests.push(requestItem);
                    continue;
                }
            }

            // Move to main services array
            booking.services.push({
                service: requestItem.service,
                quantity: requestItem.quantity,
                adminPrice: requestItem.adminPrice,
                vendorPrice: requestItem.vendorPrice,
                finalPrice: requestItem.finalPrice,
                isPriceConfirmed: true
            });

            isUpdated = true;
        } else {
            // User did not accept this one (maybe they rejected it or ignored it)
            // If they explicitly reject, you might want a separate flow, but usually 
            // we just drop it or keep it pending. Let's drop unaccepted ones for clean state,
            // or we can leave them. Let's assume acceptedServiceIds is the definitive list of what they want.
            // So we drop the rest.
        }
    }

    if (!isUpdated) {
        throw new ApiError(400, 'Could not confirm any of the provided services. Ensure they were priced by the vendor.');
    }

    // Clear userRequestedServices completely since they acted on it
    booking.userRequestedServices = [];

    // Recalculate total price
    const newBasePrice = booking.services.reduce((sum, s) => sum + (s.finalPrice || 0), 0);
    booking.pricing.basePrice = newBasePrice;
    booking.pricing.totalPrice = newBasePrice + (booking.pricing.travelCharge || 0) + (booking.pricing.additionalCharges || 0);

    await booking.save();

    const { emitToVendor, emitToUser } = require('../../socket');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
    const userPayload = await getBookingDetails(booking._id, userId, 'user');

    emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
    emitToUser(userId, 'booking_status_updated', userPayload);

    // Specific event
    emitToVendor(booking.vendor, 'extra_services_confirmed_by_user', {
        bookingId: booking._id,
        newTotal: booking.pricing.totalPrice,
        message: 'User has confirmed the extra services and the new price.'
    });

    return {
        booking: userPayload,
        message: 'Extra services confirmed and added to your booking.'
    };
}

/**
 * User rejects the priced extra service requests
 */
async function userRejectExtraServices(userId, bookingId, reason) {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (!booking.userRequestedServices || booking.userRequestedServices.length === 0) {
        throw new ApiError(400, 'No extra services pending rejection');
    }

    // Clear the requests
    booking.userRequestedServices = [];

    // Log in history
    booking.statusHistory.push({
        status: 'extra_services_rejected',
        actor: 'user',
        reason: reason || 'User rejected their own requested services after pricing.',
        timestamp: new Date()
    });
    booking.markModified('statusHistory');

    await booking.save();

    const { emitToVendor, emitToUser } = require('../../socket');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
    const userPayload = await getBookingDetails(booking._id, userId, 'user');

    emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
    emitToUser(userId, 'booking_status_updated', userPayload);

    // Specific event
    emitToVendor(booking.vendor, 'extra_services_rejected_by_user', {
        bookingId: booking._id,
        reason: reason || 'User rejected the services.',
        message: 'User rejected the priced extra services.'
    });

    return {
        booking: userPayload,
        message: 'Extra services rejected.'
    };
}



/**
 * User requests additional services for an existing booking
 */
async function requestExtraServices(userId, bookingId, newServices) {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    const allowedStatuses = ['pending', 'on_the_way', 'arrived', 'ongoing'];
    if (!allowedStatuses.includes(booking.status)) {
        throw new ApiError(400, 'Extra services can only be requested for active bookings');
    }

    if (!newServices || newServices.length === 0) {
        throw new ApiError(400, 'At least one service is required');
    }

    // Append instead of clearing previous un-acted user requests
    if (!booking.userRequestedServices) {
        booking.userRequestedServices = [];
    }

    for (const item of newServices) {
        const serviceDoc = await Service.findById(item.serviceId);
        if (!serviceDoc) {
            throw new ApiError(404, `Service ${item.serviceId} not found`);
        }
        const qty = item.quantity || 1;
        const adminPrice = serviceDoc.adminPrice || 0;
        const vendorPrice = adminPrice > 0 ? 0 : (item.price || 0);
        const finalPrice = adminPrice > 0
            ? adminPrice * qty
            : (vendorPrice > 0 ? vendorPrice * qty : 0);

        booking.userRequestedServices.push({
            service: serviceDoc._id,
            quantity: qty,
            adminPrice,
            vendorPrice,
            finalPrice,
            isPriceConfirmed: false // Always false until user approves the total change
        });
    }

    await booking.save();

    // Populate for notification
    const populatedBooking = await Booking.findById(booking._id)
        .populate('userRequestedServices.service', 'title');

    // Notify both
    const { emitToVendor, emitToUser } = require('../../socket');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
    const userPayload = await getBookingDetails(booking._id, userId, 'user');

    emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
    emitToUser(userId, 'booking_status_updated', userPayload);

    // Specific event to vendor
    emitToVendor(booking.vendor, 'extra_services_requested_by_user', {
        bookingId: booking._id,
        bookingID: booking.bookingID,
        requestedServices: populatedBooking.userRequestedServices,
        message: 'User has requested additional services. Please confirm and set prices.'
    });

    return {
        booking: populatedBooking,
        message: 'Extra services requested. Awaiting vendor confirmation.'
    };
}

async function vendorConfirmExtraServices(vendorId, bookingId, confirmedServices) {
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (!booking.userRequestedServices || booking.userRequestedServices.length === 0) {
        throw new ApiError(400, 'No pending user service requests to confirm');
    }

    if (!confirmedServices || confirmedServices.length === 0) {
        throw new ApiError(400, 'Vendor must provide pricing for the requested services');
    }

    let isUpdated = false;

    // Update the pricing for the requested services without moving them
    for (const item of confirmedServices) {
        // Find matching service in userRequestedServices
        const requestItem = booking.userRequestedServices.find(
            s => s.service.toString() === item.serviceId.toString()
        );

        if (requestItem) {
            const serviceDoc = await Service.findById(item.serviceId);
            if (!serviceDoc) continue;

            const qty = requestItem.quantity || 1;
            const adminPrice = serviceDoc.adminPrice || 0;
            const vendorPrice = adminPrice > 0 ? 0 : (item.price || 0);

            requestItem.adminPrice = adminPrice;
            requestItem.vendorPrice = vendorPrice;
            requestItem.finalPrice = adminPrice > 0
                ? adminPrice * qty
                : (vendorPrice > 0 ? vendorPrice * qty : 0);
            requestItem.isPriceConfirmed = false; // Still needs user approval
            
            isUpdated = true;
        }
    }

    if (!isUpdated) {
        throw new ApiError(400, 'None of the provided services matched the user requests');
    }

    await booking.save();

    const populatedBooking = await Booking.findById(booking._id)
        .populate('userRequestedServices.service', 'title photo adminPrice');

    const { emitToUser, emitToVendor } = require('../../socket');
    const userPayload = await getBookingDetails(booking._id, booking.user, 'user');
    const vendorPayload = await getBookingDetails(booking._id, vendorId, 'vendor');

    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    // Notify user to approve the prices
    emitToUser(booking.user, 'extra_services_priced_by_vendor', {
        bookingId: booking._id,
        bookingID: booking.bookingID,
        requestedServices: populatedBooking.userRequestedServices,
        message: 'Vendor has set prices for your extra services. Please review and confirm to add them to your booking.'
    });

    return {
        booking: populatedBooking,
        message: 'Prices set for extra services. Awaiting user approval.'
    };
}

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
    getBookingStatusHistory,

    // Post-acceptance execution flow
    markOnTheWay,
    markArrived,
    startWork,
    requestCompletionOTP,
    completeWork,
    updateBookingPrice,
    confirmBookingPrice,
    rejectBookingPrice,

    // New features
    reportVendorNoShow,
    gracePeriodCancel,
    addServicesToBooking,
    confirmProposedServices,
    rejectProposedServices,
    requestExtraServices,
    vendorConfirmExtraServices,
    userConfirmExtraServices,
    userRejectExtraServices
};
