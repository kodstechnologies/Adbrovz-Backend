const Booking = require('../../models/Booking.model');
const Vendor = require('../../models/Vendor.model');
const Service = require('../../models/Service.model');
const User = require('../../models/User.model');
const Dispute = require('../../models/Dispute.model');
const Feedback = require('../../models/Feedback.model');
const Category = require('../../models/Category.model');
const { ROLES } = require('../../constants/roles');
const { calculateDistance } = require('../../utils/location');

const ApiError = require('../../utils/ApiError');
const cacheService = require('../../services/cache.service');
const adminService = require('../admin/admin.service');

const crypto = require('crypto');
const mongoose = require('mongoose');
const { sendPush } = require('../../utils/pushNotification');
const { activeVendors } = require('../../socket');
const { v4: uuidv4 } = require('uuid');

const getSearchWaveConfig = async () => {
    const [r1_km, r1_min, r2_km, r2_min, r3_km, r3_min] = await Promise.all([
        adminService.getSetting('notifications.radius_row1_km'),
        adminService.getSetting('notifications.radius_row1_mins'),
        adminService.getSetting('notifications.radius_row2_km'),
        adminService.getSetting('notifications.radius_row2_mins'),
        adminService.getSetting('notifications.radius_row3_km'),
        adminService.getSetting('notifications.radius_row3_mins')
    ]);

    const waves = [
        { km: Number(r1_km) || 2, mins: Number(r1_min) || 5 },
        { km: Number(r2_km) || 5, mins: Number(r2_min) || 10 },
        { km: Number(r3_km) || 10, mins: Number(r3_min) || 15 }
    ];

    const totalSearchTimeMins = waves.reduce((sum, wave) => sum + wave.mins, 0);

    return { waves, totalSearchTimeMins };
};

const buildSearchTimingPayload = ({ searchId, retryCount, waves, totalSearchTimeMins }) => {
    const currentRetry = Math.min(retryCount || 0, waves.length - 1);
    const currentWave = waves[currentRetry];
    const remainingSearchTimeMins = waves.slice(currentRetry).reduce((sum, wave) => sum + wave.mins, 0);

    return {
        searchId,
        retryCount: currentRetry,
        currentWave: currentRetry + 1,
        currentWaveTimeMins: currentWave?.mins || 0,
        remainingSearchTimeMins,
        totalSearchTimeMins
    };
};

// Radius expansion tiers are now dynamic and fetched from GlobalConfig (admin settings)

/**
 * Request a Booking (User initiates)
 */
const createBookingRequest = async (
    userId,
    { subcategoryId, address, latitude, longitude, pincode, scheduledDate, scheduledTime }
) => {
    // ── Idempotency Check ──
    const recentBooking = await Booking.findOne({
        user: userId,
        status: 'pending_acceptance',
        createdAt: { $gt: new Date(Date.now() - 30 * 1000) }
    });
    if (recentBooking) {
        return {
            booking: recentBooking,
            availableVendorsCount: 0,
            message: 'Your request is already being processed.'
        };
    }

    const todayStr = new Date().toDateString();

    // ── Auto-Cancel Previous Pending Bookings ──
    // To prevent multiple overlapping search broadcasts for the same user, 
    // we cancel any existing bookings that are still pending acceptance.
    await Booking.updateMany(
        { user: userId, status: 'pending_acceptance' },
        { 
            $set: { 
                status: 'cancelled', 
                'cancellation.cancelledBy': 'system', 
                'cancellation.reason': 'Auto-cancelled because user created a new booking request.',
                'cancellation.cancelledAt': new Date()
            },
            $push: {
                statusHistory: {
                    status: 'cancelled',
                    actor: 'system',
                    reason: 'Auto-cancelled because user created a new booking request.',
                    timestamp: new Date()
                }
            }
        }
    );

    const subcategory = await mongoose.model('Subcategory').findById(subcategoryId).populate('category');
    const leadCategory = subcategory?.category?._id;

    // Find all services under this subcategory so we can also match vendors by selectedServices
    const servicesInSubcategory = await Service.find({ subcategory: subcategoryId }).select('_id');
    const serviceIdsInSubcategory = servicesInSubcategory.map(s => s._id);

    const potentialVendors = await Vendor.find({
        isVerified: true,
        isSuspended: false,
        isBlocked: false,
        // isOnline: true, // Removed strict online requirement to allow pre-check for all active vendors
        registrationStep: 'COMPLETED',
        deletedAt: null,
        $and: [
            {
                $or: [
                    { 'membership.expiryDate': { $exists: false } },
                    { 'membership.expiryDate': { $gt: new Date() } }
                ]
            },
            {
                $or: [
                    { 'serviceRenewal.expiryDate': { $exists: false } },
                    { 'serviceRenewal.expiryDate': { $gt: new Date() } }
                ]
            },
            {
                selectedSubcategories: subcategoryId
            }
        ]
    });

    if (potentialVendors.length === 0) {
        throw new ApiError(
            404,
            'No available vendors found for this service'
        );
    }

    const gstPercentAtCreation = await adminService.getSetting('pricing.booking_gst_percent');
    console.log(`[GST] createBookingRequest: fetched booking_gst_percent = ${gstPercentAtCreation}`);
    const booking = await Booking.create({
        bookingID: `BK-${uuidv4().slice(0, 8).toUpperCase()}`,
        user: userId,
        status: 'pending_acceptance',
        statusHistory: [{ status: 'pending_acceptance', timestamp: new Date(), actor: 'user' }],
        scheduledDate: scheduledDate ? new Date(scheduledDate) : new Date(),
        scheduledTime: scheduledTime || '00:00',
        category: leadCategory,
        location: { address, latitude, longitude, pincode },
        // Set GST percent from global settings
        pricing: {
            gstPercent: gstPercentAtCreation
        }
    });

    // Recalculate full pricing (including GST) after setting GST percent
    await recalculateBookingPrice(booking);
    await booking.save();

    const searchTimeoutMins = (await adminService.getSetting('bookings.search_timeout_mins')) || 2;

    // Trigger broadcast
    const notifiedVendors = await searchVendors(booking, true).catch(err => {
        console.error('Error in initial searchVendors:', err.message);
        return [];
    });

    // ── Emit Success Response via Socket ──
    try {
        const { emitToUser, emitToDiagnostics } = require('../../socket');
        emitToUser(userId, 'booking_created_success', {
            booking,
            message: 'Lead request created successfully. Searching for vendors...'
        });
        // Always broadcast to diagnostics regardless of whether user socket is connected
        emitToDiagnostics('booking_created_success', {
            booking,
            message: `[LIVE] New booking request: ${booking.bookingID || booking._id}`
        });
    } catch (socketErr) {
        console.error('[SOCKET ERROR] Failed to emit booking_created_success in requestLead:', socketErr.message);
    }

    console.log(`[DEBUG] Booking request created: ${booking._id}, status: ${booking.status}. Initial notified vendors: ${notifiedVendors.length}`);
    return {
        booking,
        availableVendorsCount: notifiedVendors.length,
        notifiedVendors,
        searchTimeoutMins,
        message: notifiedVendors.length > 0 
            ? `Booking broadcasted to ${notifiedVendors.length} nearby vendors.`
            : 'Booking created, but no vendors were found nearby at this moment.'
    };

};



/**
 * Accept a Booking (Vendor accepts)
 */
const acceptBooking = async (vendorId, bookingId) => {
    console.log(`[SOCKET] acceptBooking called for vendor: ${vendorId}, booking: ${bookingId}`);
    
    const query = mongoose.isValidObjectId(bookingId)
        ? { $or: [{ _id: bookingId }, { bookingID: bookingId }] }
        : { bookingID: bookingId };

    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // ── Atomic Lock: Try to find and claim a pending booking ──
    // This ensures only one vendor can successfully "claim" the request.
    const booking = await Booking.findOneAndUpdate(
        { ...query, status: 'pending_acceptance' },
        { $set: { status: 'pending' } },
        { new: true }
    );

    if (!booking) {
        // Check the actual status of the booking
        const existingBooking = await Booking.findOne(query);
        if (existingBooking) {
            // Provide status-specific error messages
            if (['cancelled', 'auto_cancelled'].includes(existingBooking.status)) {
                throw new ApiError(400, 'This booking request is no longer available (cancelled by user).');
            } else if (existingBooking.status === 'completed') {
                throw new ApiError(400, 'This booking has already been completed.');
            } else if (['pending', 'arrived', 'ongoing'].includes(existingBooking.status)) {
                throw new ApiError(400, 'You missed your order! This booking has already been accepted by another vendor.');
            } else {
                throw new ApiError(400, 'This booking is no longer available.');
            }
        }
        throw new ApiError(404, 'Booking not found or already expired.');
    }

    // ── Schedule overlap check ──
    const overlapping = await Booking.findOne({
        vendor: vendorId,
        scheduledDate: booking.scheduledDate,
        scheduledTime: booking.scheduledTime,
        status: { $nin: ['cancelled', 'auto_cancelled', 'completed'] },
        _id: { $ne: booking._id }
    });
    if (overlapping) {
        // Rollback booking status
        await Booking.findByIdAndUpdate(booking._id, { status: 'pending_acceptance' });
        throw new ApiError(400, 'You already have a booking at this date and time slot.');
    }

    // ── Finalize Booking Record ──
    const graceMins = (await adminService.getSetting('bookings.grace_period_mins')) || 30;
    let gracePeriodEnd = null;
    const source = booking;

    if (source.scheduledDate && source.scheduledTime) {
        const scheduledAtIST = _getScheduledDateTimeIST(source.scheduledDate, source.scheduledTime);
        if (scheduledAtIST) {
            gracePeriodEnd = new Date(scheduledAtIST.getTime() + graceMins * 60 * 1000);
        }
    }

        // ── Calculate travel charge based on distance ──
        let distance = 0;
        if (vendor?.liveLocation?.coordinates && source.location?.latitude) {
            let [vLng, vLat] = vendor.liveLocation.coordinates;
            // In India, longitude is always > 60 and latitude is < 40.
            // If the database has them swapped, we auto-detect and correct them.
            if (vLng < vLat) {
                [vLng, vLat] = [vLat, vLng];
            }
            // Ignore [0,0] as it's usually a default/invalid location (off Africa coast)
            // Also ensure coordinates are within reasonable bounds for India
            if (vLat !== 0 && vLng !== 0 && vLat > 5 && vLat < 40 && vLng > 65 && vLng < 100) {
                const { latitude: bLat, longitude: bLng } = source.location;
                distance = calculateDistance(vLat, vLng, bLat, bLng);
                console.log(`[DISTANCE] Calculated distance: ${distance} km between vendor (${vLat}, ${vLng}) and booking (${bLat}, ${bLng})`);
            } else {
                console.warn(`[DISTANCE] Vendor ${vendorId} has invalid or default coordinates: [${vLng}, ${vLat}]. Travel charge will use 0km.`);
            }
        }

        const perKmCharge = (await adminService.getSetting('pricing.travel_charge_per_km')) || 10;
        
        // Use Math.ceil to ensure any fractional distance counts towards the next kilometer
        // and ensure a minimum travel distance of 1 km if the vendor is located elsewhere (distance > 0)
        let travelDistance = distance > 0 ? Math.max(1, Math.ceil(distance)) : 0;
        let travelCharge = (travelDistance * perKmCharge);
        
        // Cap travel charge at a reasonable amount (e.g., ₹500)
        if (travelCharge > 500) travelCharge = 500;
        travelCharge = Math.round(travelCharge);

        // Finalize existing Booking
        booking.vendor = vendorId;
        booking.otp = { startOTP: '1234', completionOTP: null };
        if (gracePeriodEnd) booking.gracePeriodEnd = gracePeriodEnd;
        booking.statusHistory.push({ status: 'pending', timestamp: new Date(), actor: 'vendor' });
        
        // Update travel charge and total price with GST
        booking.pricing = booking.pricing || {};
        booking.pricing.travelCharge = travelCharge;
        await recalculateBookingPrice(booking);
        
        booking.markModified('statusHistory');
        booking.markModified('pricing');
        await booking.save();

    // ── Emit acceptance update IMMEDIATELY after locking ──
    try {
        const { emitToUser } = require('../../socket');
        emitToUser(booking.user, 'booking_search_update', {
            bookingId: booking._id,
            bookingID: booking.bookingID,
            status: 'accepted',
            message: 'A vendor has accepted your booking request!',
            searchCompleted: true,
            vendorName: vendor.name,
            vendorPhone: vendor.phoneNumber
        });
        console.log(`[SOCKET] Emitted 'accepted' status update for user: ${booking.user}`);
    } catch (socketErr) {
        console.error(`[SOCKET] Failed to emit search update in acceptBooking: ${socketErr.message}`);
    }

    // ── Deduct coins from vendor DISABLED ──
    /*
    vendor.coins -= coinCost;
    await vendor.save();
    console.log(`[SOCKET] Deducted ${coinCost} coins from vendor ${vendorId}. New balance: ${vendor.coins}`);
    */

    console.log(`[SOCKET] Booking ${bookingId} locked by vendor ${vendorId}`);

    const userPayload = await getBookingDetails(booking._id, booking.user, 'user');
    const vendorPayload = await getBookingDetails(booking._id, vendorId, 'vendor');

    const { emitToUser, emitToVendor, activeVendors, getIo } = require('../../socket');

    const userIdStr = booking.user.toString();
    console.log(`[SOCKET] Emitting standard status updates to user: ${userIdStr}`);

    emitToUser(userIdStr, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    // ── Emit specialized success event for multi-device sync ──
    emitToVendor(vendorId, 'booking_accepted_success', {
        booking: vendorPayload,
        message: 'Booking accepted successfully'
    });

    // ── Send Push Notification to Vendor ──
    sendPush(vendorId, 'Vendor', 'booking_accepted', 'Booking Accepted', `You have accepted booking ${booking.bookingID}.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });

    // ── Send Push Notification to User ──
    sendPush(booking.user, 'User', 'booking_accepted', 'Booking Accepted', `A vendor has accepted your booking ${booking.bookingID}.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });

    // ── Removed broadcast of 'booking_already_accepted' to other vendors to avoid spamming all vendors.
    // Previously, the server emitted a socket event to all other vendors when a booking was accepted.
    // ── Removed push notifications to other vendors about acceptance, as only the attempting vendor should be informed.
    // Previously, push notifications were sent to all vendors who had been notified.

    console.log(`[SOCKET] acceptBooking completed successfully for booking: ${bookingId}`);
    return {
        bookingId: booking._id,
        bookingID: booking.bookingID,
        booking: vendorPayload,
        message: 'Booking accepted successfully'
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

    // ── Timing Guard: Enable only within 2 hours of scheduled time ──
    const scheduledAtIST = _getScheduledDateTimeIST(booking.scheduledDate, booking.scheduledTime);
    
    if (!scheduledAtIST) {
        throw new ApiError(500, 'Invalid scheduling data');
    }

    const now = new Date();
    const diffMs = scheduledAtIST.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours > 2) {
        throw new ApiError(400, `You can only mark "On the Way" within 2 hours of the scheduled time (${booking.scheduledTime}).`);
    }

    booking.status = 'on_the_way';
    booking.statusHistory.push({ status: 'on_the_way', timestamp: new Date(), actor: 'vendor' });
    booking.markModified('statusHistory');
    await booking.save();
    console.log(`[DEBUG] Status updated to On The Way: ${bookingId}, history length: ${booking.statusHistory.length}`);

    // Notify User
    sendPush(
        booking.user,
        'User',
        'booking_update',
        'Vendor on the Way',
        `Vendor for your booking ${booking.bookingID} is on the way.`,
        { bookingId: booking._id.toString(), bookingID: booking.bookingID, status: 'on_the_way' }
    );

    // Fetch role-specific payloads for the socket emissions
    const userPayload = await getBookingDetails(bookingId, booking.user, ROLES.USER);
    const vendorPayload = await getBookingDetails(bookingId, vendorId, ROLES.VENDOR);

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    // ── Emit specialized success event for multi-device sync ──
    emitToVendor(vendorId, 'booking_on_the_way_success', {
        booking: vendorPayload,
        message: 'Status updated to On The Way'
    });

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

    // ── Distance Guard: 1.5km arrival threshold ──
    const vendor = await Vendor.findById(vendorId).select('liveLocation');
    if (vendor?.liveLocation?.coordinates && booking.location?.latitude) {
        let [vLng, vLat] = vendor.liveLocation.coordinates;
        // In India, longitude is always > 60 and latitude is < 40.
        // If the database has them swapped, we auto-detect and correct them.
        if (vLng < vLat) {
            [vLng, vLat] = [vLat, vLng];
        }
        const { latitude: bLat, longitude: bLng } = booking.location;
        
        // Safety check for [0,0]
        if (vLat === 0 || vLng === 0) {
            throw new ApiError(400, 'Your GPS location is invalid. Please ensure GPS is on and try again.');
        }

        const distance = calculateDistance(vLat, vLng, bLat, bLng);
        console.log(`[DISTANCE] markArrived: distance=${distance} km`);
        
        if (distance > 1.5) { // Increased to 1.5km for better tolerance in city areas
            throw new ApiError(400, `Arrival denied. You are ${(distance * 1000).toFixed(0)}m away. Please reach the customer's location first.`);
        }
    }

    booking.status = 'arrived';
    booking.statusHistory.push({ status: 'arrived', timestamp: new Date(), actor: 'vendor' });
    booking.markModified('statusHistory');
    booking.vendorArrivedAt = new Date();
    await booking.save();
    console.log(`[DEBUG] Status updated to Arrived: ${bookingId}, history length: ${booking.statusHistory.length}`);

    // Notify User
    sendPush(
        booking.user,
        'User',
        'booking_update',
        'Vendor Arrived',
        `Vendor for your booking ${booking.bookingID} has arrived at your location.`,
        { bookingId: booking._id.toString(), bookingID: booking.bookingID, status: 'arrived' }
    );

    // Fetch role-specific payloads for the socket emissions
    const userPayload = await getBookingDetails(bookingId, booking.user, 'user');
    const vendorPayload = await getBookingDetails(bookingId, vendorId, 'vendor');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    // ── Emit specialized success event for multi-device sync ──
    emitToVendor(vendorId, 'booking_arrived_success', {
        booking: vendorPayload,
        message: 'Status updated to Arrived'
    });

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
    // ── Per-service price confirmation check ──
    // Work can only start once ALL services have been price-confirmed by the user.
    const unconfirmedServices = (booking.services || []).filter(s => !s.isPriceConfirmed);
    if (unconfirmedServices.length > 0) {
        throw new ApiError(400, `Price must be confirmed by the user for all services before starting work (${unconfirmedServices.length} service(s) still pending).`);
    }

    // ── Block start if vendor has pending proposed services not yet accepted by user ──
    if (booking.proposedServices && booking.proposedServices.length > 0) {
        throw new ApiError(400, 'Cannot start work: vendor has proposed services awaiting user confirmation');
    }

    // ── Block start if extra services are unpriced or not yet accepted ──
    const pendingExtraServices = (booking.userRequestedServices || []).filter(
        s => s.status === 'pending' || s.status === 'priced' || !s.finalPrice || s.finalPrice === 0
    );
    if (pendingExtraServices.length > 0) {
        throw new ApiError(400, `Cannot start work: ${pendingExtraServices.length} extra service(s) still pending pricing or confirmation`);
    }

    if (!enteredOTP || enteredOTP.toString() !== validStartOTP) {
        throw new ApiError(400, 'Invalid Start OTP');
    }

    booking.status = 'ongoing';
    booking.statusHistory.push({ status: 'ongoing', timestamp: new Date(), actor: 'vendor' });
    booking.markModified('statusHistory');
    booking.workStartedAt = new Date();
    await booking.save();
    console.log(`[DEBUG] Status updated to Ongoing/Working: ${bookingId}, status field is now: ${booking.status}, history length: ${booking.statusHistory.length}`);

    // Notify User
    sendPush(
        booking.user,
        'User',
        'booking_update',
        'Work Started',
        `Vendor has started working on your booking ${booking.bookingID}.`,
        { bookingId: booking._id.toString(), bookingID: booking.bookingID, status: 'ongoing' }
    );

    // Fetch role-specific payloads for the socket emissions
    const userPayload = await getBookingDetails(bookingId, booking.user, 'user');
    const vendorPayload = await getBookingDetails(bookingId, vendorId, 'vendor');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    // ── Emit specialized success event for multi-device sync ──
    emitToVendor(vendorId, 'booking_start_work_success', {
        booking: vendorPayload,
        message: 'Work started successfully'
    });

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

    // ── Lock OTP if vendor has pending proposed services or unconfirmed extra services ──
    const hasPendingProposed = booking.proposedServices && booking.proposedServices.length > 0;
    const pendingExtraServices = (booking.userRequestedServices || []).filter(
        s => s.status === 'pending' || s.status === 'priced' || !s.finalPrice || s.finalPrice === 0
    );
    const isLocked = hasPendingProposed || pendingExtraServices.length > 0;

    if (isLocked) {
        // Do NOT generate or send OTP. Just sync state and notify vendor that it is locked.
        const userPayload = await getBookingDetails(bookingId, booking.user, 'user');
        const vendorPayload = await getBookingDetails(bookingId, vendorId, 'vendor');

        const { emitToUser, emitToVendor } = require('../../socket');
        emitToUser(booking.user, 'booking_status_updated', userPayload);
        emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

        emitToVendor(vendorId, 'booking_completion_otp_locked', {
            booking: vendorPayload,
            locked: true,
            reason: hasPendingProposed
                ? 'Vendor has proposed services awaiting user confirmation'
                : `${pendingExtraServices.length} extra service(s) still pending pricing or confirmation`,
            message: 'Completion OTP is locked'
        });

        return { booking: vendorPayload, locked: true, message: 'Completion OTP is locked' };
    }

    // ── Block OTP if any main services have zero amount ──
    const zeroAmountMainServices = (booking.services || []).filter(s => !s.finalPrice || s.finalPrice === 0);
    if (zeroAmountMainServices.length > 0) {
        throw new ApiError(400, `${zeroAmountMainServices.length} service(s) have zero amount. Please propose a price first.`);
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

    // ── Emit specialized success event for multi-device sync ──
    emitToVendor(vendorId, 'booking_completion_otp_requested', {
        booking: vendorPayload,
        message: 'Completion OTP generated successfully'
    });

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

    // ── Block completion if vendor has pending proposed services not yet accepted by user ──
    if (booking.proposedServices && booking.proposedServices.length > 0) {
        throw new ApiError(400, 'Cannot complete work: vendor has proposed services awaiting user confirmation');
    }

    // ── Block completion if extra services are unpriced or not yet accepted ──
    const pendingExtraServices = (booking.userRequestedServices || []).filter(
        s => s.status === 'pending' || s.status === 'priced' || !s.finalPrice || s.finalPrice === 0
    );
    if (pendingExtraServices.length > 0) {
        throw new ApiError(400, `Cannot complete work: ${pendingExtraServices.length} extra service(s) still pending pricing or confirmation`);
    }

    // ── Block completion if any main services have zero amount ──
    const zeroAmountMainServices = (booking.services || []).filter(s => !s.finalPrice || s.finalPrice === 0);
    if (zeroAmountMainServices.length > 0) {
        throw new ApiError(400, `Cannot complete work: ${zeroAmountMainServices.length} service(s) have zero amount. Please propose a price first.`);
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
    booking.statusHistory.push({ status: 'completed', timestamp: new Date(), actor: 'vendor' });
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

    // ── Emit specialized success event for multi-device sync ──
    emitToVendor(vendorId, 'booking_completed_success', {
        booking: vendorPayload,
        message: 'Booking completed successfully'
    });

    // ── Send Push Notification to User ──
    sendPush(booking.user, 'User', 'booking_completed', 'Booking Completed', `Your booking ${booking.bookingID} has been completed successfully.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });


    return { booking: vendorPayload, message: 'Booking completed successfully' };

};

const findBookingByUser = async (bookingId, userId) => {
    if (!userId) {
        throw new ApiError(401, 'Unauthorized user context');
    }

    const query = {};

    if (mongoose.isValidObjectId(bookingId)) {
        query.$or = [{ _id: bookingId }, { bookingID: bookingId }];
    } else {
        query.bookingID = bookingId;
    }

    const booking = await Booking.findOne(query);
    if (!booking) return null;

    if (booking.user?.toString() !== String(userId)) {
        throw new ApiError(403, 'You are not allowed to access this booking');
    }

    return booking;
};

/**
 * Helper to construct a Date object representing a specific IST time.
 */
const _getScheduledDateTimeIST = (date, timeString) => {
    if (!date || !timeString) return null;
    const dateObj = new Date(date);
    // Get YYYY-MM-DD in IST
    const istDateStr = dateObj.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const [hours, minutes] = timeString.split(':').map(Number);
    // Construct ISO string with IST offset (+05:30)
    const isoStr = `${istDateStr}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00+05:30`;
    return new Date(isoStr);
};

/**
 * Internal helper to calculate the start and end time of a booking.
 * Returns { start: Date, end: Date } or null if invalid.
 */
const getBookingTimeRange = async (booking) => {
    const start = _getScheduledDateTimeIST(booking.scheduledDate, booking.scheduledTime);
    if (!start) return null;

    let totalDurationMins = 0;
    
    // Sum up durations of all services
    if (booking.services && booking.services.length > 0) {
        for (const s of booking.services) {
            // Check if service is populated
            const svc = s.service;
            if (svc && typeof svc === 'object') {
                totalDurationMins += (svc.approxCompletionTime || 60) * (s.quantity || 1);
            } else {
                // Fallback: fetch service if not populated (though it usually is in calling contexts)
                const fullSvc = await Service.findById(svc).select('approxCompletionTime');
                totalDurationMins += (fullSvc?.approxCompletionTime || 60) * (s.quantity || 1);
            }
        }
    }

    // Include proposed services if any (vendor might have added them)
    if (booking.proposedServices && booking.proposedServices.length > 0) {
        for (const s of booking.proposedServices) {
            const svc = s.service;
            if (svc && typeof svc === 'object') {
                totalDurationMins += (svc.approxCompletionTime || 30) * (s.quantity || 1);
            } else {
                const fullSvc = await Service.findById(svc).select('approxCompletionTime');
                totalDurationMins += (fullSvc?.approxCompletionTime || 30) * (s.quantity || 1);
            }
        }
    }

    // Default minimum duration 1 hour if nothing found
    if (totalDurationMins === 0) totalDurationMins = 60;

    const end = new Date(start.getTime() + totalDurationMins * 60000);
    return { start, end };
};


/**
 * Helper to consistently format a booking object (convert to IST, handle OTP visibility, etc.)
 */
const _formatBooking = (bookingDoc, role) => {
    let bookingObj;
    if (bookingDoc && typeof bookingDoc.toObject === 'function') {
        bookingObj = bookingDoc.toObject();
    } else if (bookingDoc && typeof bookingDoc.toJSON === 'function') {
        bookingObj = bookingDoc.toJSON();
    } else {
        bookingObj = JSON.parse(JSON.stringify(bookingDoc));
    }

    // User friendly status mapping
    const statusMap = {
        'pending_acceptance': 'Pending Acceptance',
        'pending': 'Accepted',
        'price_proposed': 'Price Proposed',
        'price_confirmed': 'Price Confirmed',
        'rescheduled': 'Rescheduled',
        'extra_services_requested': 'Extra Services Requested',
        'extra_services_priced': 'Extra Services Priced',
        'extra_services_accepted': 'Extra Services Accepted',
        'extra_services_rejected': 'Extra Services Rejected',
        'on_the_way': 'Vendor on the Way',
        'arrived': 'Vendor Arrived',
        'ongoing': 'Working',
        'completed': 'Completed',
        'cancelled': 'Cancelled'
    };
    bookingObj.displayStatus = statusMap[bookingObj.status] || bookingObj.status;

    const formatToLocalISOString = (date) => {
        if (!date) return null;
        try {
            const d = new Date(new Date(date).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
            const pad = (n) => n.toString().padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}+05:30`;
        } catch (e) {
            return date;
        }
    };

    const createdAtIST = formatToLocalISOString(bookingObj.createdAt);
    const updatedAtIST = formatToLocalISOString(bookingObj.updatedAt);
    
    bookingObj.createdAtIST = createdAtIST;
    bookingObj.updatedAtIST = updatedAtIST;
    
    // Replace the main attributes with IST strings as well for consistency across all response consumers
    if (createdAtIST) bookingObj.createdAt = createdAtIST;
    if (updatedAtIST) bookingObj.updatedAt = updatedAtIST;

    if (['cancelled', 'auto_cancelled'].includes(bookingObj.status)) {
        bookingObj.cancelledBy = bookingObj.cancellation?.cancelledBy || 'unknown';
        bookingObj.cancelledAtIST = bookingObj.cancellation?.cancelledAt ? new Date(bookingObj.cancellation.cancelledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : null;
    }

    // Role specific IST timestamps
    bookingObj.vendorArrivedAtIST = formatToLocalISOString(bookingObj.vendorArrivedAt);
    bookingObj.workStartedAtIST = formatToLocalISOString(bookingObj.workStartedAt);
    bookingObj.workCompletedAtIST = formatToLocalISOString(bookingObj.workCompletedAt);

    // Replace tracking attributes with IST strings for consistency across response consumers
    if (bookingObj.vendorArrivedAtIST) bookingObj.vendorArrivedAt = bookingObj.vendorArrivedAtIST;
    if (bookingObj.workStartedAtIST) bookingObj.workStartedAt = bookingObj.workStartedAtIST;
    if (bookingObj.workCompletedAtIST) bookingObj.workCompletedAt = bookingObj.workCompletedAtIST;

    // Ensure sensitive data is hidden for vendors until they accept the booking
    if ((role === 'vendor' || role === 'Vendor') && bookingObj.status === 'pending_acceptance') {
        if (bookingObj.user) {
            bookingObj.user.phoneNumber = '••••••••••';
            bookingObj.user.email = '••••••••••';
        }
        if (bookingObj.location) {
            bookingObj.location.address = 'Location visible after acceptance';
        }
    }

    // OTP visibility logic
    if (bookingObj.otp) {
        const isUserRole = role === 'user' || role === 'User';
        const isVendorRole = role === 'vendor' || role === 'Vendor';

        if (isUserRole) {
            const startOTPCode = bookingObj.otp.startOTP || '1234';
            const completionOTPCode = bookingObj.otp.completionOTP || null;

            bookingObj.currentOTP = {
                startOTP: { label: 'Start OTP', code: startOTPCode, instruction: 'Give this to the vendor to Start Work' },
                completionOTP: {
                    label: 'Completion OTP',
                    code: completionOTPCode ? completionOTPCode : 'Hidden',
                    status: completionOTPCode ? 'available' : 'pending',
                    instruction: completionOTPCode ? 'Give this to the vendor to Complete Work' : 'Will be visible once vendor requests completion'
                }
            };

            // All services must have isPriceConfirmed=true before OTP is revealed.
            const allMainServicesConfirmed = (bookingObj.services || []).length > 0
                ? (bookingObj.services || []).every(s => s.isPriceConfirmed)
                : !!bookingObj.isPriceConfirmed; // fallback for legacy bookings with no services

            // Extra requested services lock the OTP if they are pending or priced (not yet accepted or rejected)
            const allExtraServicesConfirmed = (bookingObj.userRequestedServices || [])
                .every(s => s.status !== 'pending' && s.status !== 'priced');

            const allPricesConfirmed = allMainServicesConfirmed && allExtraServicesConfirmed;

            if (['pending', 'on_the_way', 'arrived'].includes(bookingObj.status)) {
                if (allPricesConfirmed) {
                    bookingObj.activeOTP = bookingObj.currentOTP.startOTP;
                } else {
                    bookingObj.activeOTP = { label: 'Start OTP', code: 'Locked', instruction: 'Visible once price is confirmed for all services' };
                    bookingObj.currentOTP.startOTP.code = 'Locked';
                    bookingObj.currentOTP.startOTP.instruction = 'Price confirmation pending';
                }
            } else if (bookingObj.status === 'ongoing') {
                // ── Lock completion OTP if vendor has pending proposed services or unconfirmed extra services ──
                const hasPendingProposed = bookingObj.proposedServices && bookingObj.proposedServices.length > 0;
                const hasPendingExtra = (bookingObj.userRequestedServices || []).some(
                    s => s.status === 'pending' || s.status === 'priced' || !s.finalPrice || s.finalPrice === 0
                );
                const canComplete = !hasPendingProposed && !hasPendingExtra;

                if (canComplete) {
                    bookingObj.activeOTP = bookingObj.currentOTP.completionOTP;
                } else {
                    bookingObj.activeOTP = { label: 'Completion OTP', code: 'Locked', instruction: 'Visible once all extra services are confirmed and priced' };
                    bookingObj.currentOTP.completionOTP.code = 'Locked';
                    bookingObj.currentOTP.completionOTP.status = 'locked';
                    bookingObj.currentOTP.completionOTP.instruction = hasPendingProposed
                        ? 'Vendor has proposed services awaiting your confirmation'
                        : 'Extra services pricing confirmation pending';
                    // Hide the raw OTP so it cannot leak through any other field
                    bookingObj.otp.completionOTP = 'Locked';
                }
            }

            if (!allPricesConfirmed) bookingObj.otp.startOTP = 'Locked (Price Pending)';

            // If completion is locked due to pending services, always show Locked; otherwise show Hidden (Pending) when not yet generated
            const isCompletionLocked = bookingObj.status === 'ongoing' && (
                (bookingObj.proposedServices && bookingObj.proposedServices.length > 0) ||
                (bookingObj.userRequestedServices || []).some(s => s.status === 'pending' || s.status === 'priced' || !s.finalPrice || s.finalPrice === 0)
            );
            if (isCompletionLocked) {
                bookingObj.otp.completionOTP = 'Locked';
            } else if (!completionOTPCode) {
                bookingObj.otp.completionOTP = 'Hidden (Pending)';
            }
        } else if (isVendorRole) {
            delete bookingObj.otp;
            delete bookingObj.currentOTP;
            delete bookingObj.activeOTP;
        }
    }

    // Ensure extra services arrays always have pricing fields, filtering out rejected ones
    if (bookingObj.userRequestedServices) {
        bookingObj.userRequestedServices = bookingObj.userRequestedServices
            .filter(item => item.status !== 'rejected')
            .map(item => ({
                ...item,
                adminPrice: item.adminPrice,
                vendorPrice: item.vendorPrice,
                finalPrice: item.finalPrice,
                isPriceConfirmed: item.isPriceConfirmed ?? false,
                isExtra: true
            }));
    }

    if (bookingObj.services) {
        bookingObj.services = bookingObj.services.map(item => ({
            ...item,
            isExtra: false
        }));
    }

    // For vendors: identify which services actually need pricing
    if (role === 'vendor' || role === 'Vendor') {
        let unpriced = [];
        if (bookingObj.userRequestedServices && bookingObj.userRequestedServices.length > 0) {
            unpriced = bookingObj.userRequestedServices.filter(s => ['pending', 'accepted'].includes(s.status)).map(s => ({ ...s, isExtra: true }));
        }
        if (unpriced.length === 0 && bookingObj.services) {
            unpriced = bookingObj.services.filter(s => (!s.adminPrice || s.adminPrice === 0) && (!s.vendorPrice || s.vendorPrice === 0)).map(s => ({ ...s, isExtra: false }));
        }
        bookingObj.unpricedServices = unpriced;
    }

    // Status history formatting...
    if (bookingObj.statusHistory) {
        bookingObj.statusHistory = [...bookingObj.statusHistory]
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .filter(h => {
                // 1. Never show 'pending_acceptance' status in the history
                if (h.status === 'pending_acceptance') return false;

                // 2. Only show 'cancelled' status in the history if it was cancelled after acceptance (i.e., there is an assigned vendor)
                if (['cancelled', 'auto_cancelled'].includes(h.status) && !bookingObj.vendor) return false;

                return true;
            })
            .map(h => {
                const istTime = formatToLocalISOString(h.timestamp);
                return {
                    status: h.status, reason: h.reason, actor: h.actor, 
                    timestamp: istTime || h.timestamp,
                    timestampIST: istTime,
                    displayStatus: statusMap[h.status] || h.status
                };
            });
    }

    // Add reschedule info
    const maxReschedule = 2;
    const rescheduleAllowed = bookingObj.status === 'pending' && (bookingObj.rescheduleCount || 0) < maxReschedule;
    let rescheduleReason = "";
    if (bookingObj.status === 'completed') rescheduleReason = "Booking already completed";
    else if (['cancelled', 'auto_cancelled'].includes(bookingObj.status)) rescheduleReason = "Booking already cancelled";
    else if (['on_the_way', 'arrived', 'ongoing'].includes(bookingObj.status)) rescheduleReason = "Work in progress";
    else if (bookingObj.status === 'pending_acceptance') rescheduleReason = "Vendor acceptance pending";
    else if ((bookingObj.rescheduleCount || 0) >= maxReschedule) rescheduleReason = "Maximum reschedule limit reached";

    bookingObj.reschedule = {
        count: bookingObj.rescheduleCount || 0,
        maxAllowed: maxReschedule,
        allowed: rescheduleAllowed,
        reason: rescheduleReason
    };
    
    // Initial actions (to be refined in getBookingDetails if dispute info is needed)
    bookingObj.actions = {
        canReschedule: rescheduleAllowed,
        canCancel: bookingObj.status === 'pending_acceptance',
        canAddService: bookingObj.status === 'ongoing',
        canRaiseDispute: bookingObj.status === 'completed',
        canViewDispute: false,
        canReuploadDispute: false,
        canGiveFeedback: bookingObj.status === 'completed'
    };

    // Give lat/long directly in the user object for easier frontend mapping
    if (bookingObj.user && bookingObj.location) {
        bookingObj.user.latitude = bookingObj.location.latitude;
        bookingObj.user.longitude = bookingObj.location.longitude;
    }

    if (bookingObj.category) {
        bookingObj.categoryName = bookingObj.category.title || bookingObj.category.name || "N/A";
        bookingObj.categoryId = bookingObj.category._id ? bookingObj.category._id : bookingObj.category;
    }

    // Remove rejectedServices history array from the response as requested
    delete bookingObj.rejectedServices;

    // Filter out rejected user requested services for vendor view
    if (role === 'vendor' && bookingObj.userRequestedServices) {
        bookingObj.userRequestedServices = bookingObj.userRequestedServices.filter(item => item.status !== 'rejected');
    }
    return bookingObj;
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
        .populate('rejectedServices.service')
        .populate('category')
        .populate('vendor', 'name phoneNumber photo documents.photo.url')
        .populate('user', 'name phoneNumber photo');

    if (!booking) {
        throw new ApiError(404, 'Booking not found');
    }

    const formattedBooking = _formatBooking(booking, role);
    
    // Check if a dispute exists for this booking
    const dispute = await Dispute.findOne({ booking: booking._id }).lean();
    
    if (dispute) {
        // Embed the full dispute information (similar to get dispute API)
        formattedBooking.dispute = {
            ...dispute,
            exists: true,
            id: dispute._id,
            // Re-map some fields for clarity if needed, though ...dispute covers most
            submittedMessage: dispute.status === 'REOPENED' ? (dispute.resolutionNotes?.userNote || dispute.userComment || "") : (dispute.userComment || ""), // The "submitted message" for the user to see
        };
        
        // Refine actions based on dispute existence and status
        // When dispute is REOPENED: only canReuploadDispute is true, others are false
        // For all other statuses: only canViewDispute is true
        const isReopened = dispute.status === 'REOPENED';
        formattedBooking.actions.canRaiseDispute = false;
        formattedBooking.actions.canViewDispute = true;
        formattedBooking.actions.canReuploadDispute = isReopened;
    } else {
        formattedBooking.dispute = {
            exists: false,
            id: null
        };
        // canRaiseDispute is already set to true for 'completed' in _formatBooking
        formattedBooking.actions.canViewDispute = false;
        formattedBooking.actions.canReuploadDispute = false;
    }

    // Check if feedback exists for this booking
    const feedback = await Feedback.findOne({ booking: booking._id, user: booking.user }).lean();
    if (feedback) {
        formattedBooking.actions.canGiveFeedback = false;
        formattedBooking.feedback = {
            id: feedback._id,
            rating: feedback.rating,
            review: feedback.review,
            createdAt: feedback.createdAt
        };
    } else {
        formattedBooking.feedback = null;
    }

    return formattedBooking;
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
 * Helper to fetch pricing and promotions across the hierarchy
 * Hierarchy: Service -> ServiceType -> Subcategory -> Category
 */
const _getHierarchicalPricing = async (serviceId) => {
    const service = await Service.findById(serviceId)
        .populate('serviceType')
        .populate('subcategory')
        .populate('category');
    
    if (!service) return { adminPrice: 0, coupon: null, discount: 0 };

    const categoryPrice = service.category?.bookingPrice || 0;
    const subcategoryPrice = service.subcategory?.bookingPrice || 0;
    const serviceTypePrice = service.serviceType?.bookingPrice || 0;
    const servicePrice = (service.bookingPrice !== undefined && service.bookingPrice !== null) 
        ? service.bookingPrice 
        : (service.serviceCharge || 0);

    const adminPrice = categoryPrice + subcategoryPrice + serviceTypePrice + servicePrice;

    const coupon = service.coupon || 
                  service.serviceType?.coupon || 
                  service.subcategory?.coupon || 
                  service.category?.coupon || null;

    const discount = service.discount || 
                    service.serviceType?.discount || 
                    service.subcategory?.discount || 
                    service.category?.discount || 0;

    return { adminPrice, coupon, discount };
};

/**
 * Create booking (full flow)
 */
const createBooking = async (userId, bookingData) => {
    console.log("[TRACKING-FLOW] [STEP 1] createBooking CALLED. userId:", userId);
    console.log("[TRACKING-FLOW] [STEP 1.1] Input Booking Data:", JSON.stringify(bookingData, null, 2));
    
    // ── Idempotency Check: Prevent duplicate bookings in a short window ──
    const recentBooking = await Booking.findOne({
        user: userId,
        status: 'pending_acceptance',
        createdAt: { $gt: new Date(Date.now() - 30 * 1000) } // 30 seconds window
    });
    if (recentBooking) {
        console.log(`[TRACKING-FLOW] [STEP 1.2] [IDEMPOTENCY] Found recent pending booking ${recentBooking._id} for user ${userId}. Returning existing.`);
        return {
            booking: _formatBooking(recentBooking, 'user'),
            message: 'Your booking is already being processed. Please wait.'
        };
    }

    // ── Auto-Cancel Previous Pending Bookings ──
    // To prevent multiple overlapping search broadcasts for the same user, 
    // we cancel any existing bookings that are still pending acceptance.
    console.log("[TRACKING-FLOW] [STEP 1.3] Auto-cancelling previous pending bookings for user:", userId);
    const cancelResult = await Booking.updateMany(
        { user: userId, status: 'pending_acceptance' },
        { 
            $set: { 
                status: 'cancelled', 
                'cancellation.cancelledBy': 'system', 
                'cancellation.reason': 'Auto-cancelled because user created a new booking request.',
                'cancellation.cancelledAt': new Date()
            },
            $push: {
                statusHistory: {
                    status: 'cancelled',
                    actor: 'system',
                    reason: 'Auto-cancelled because user created a new booking request.',
                    timestamp: new Date()
                }
            }
        }
    );
    console.log(`[TRACKING-FLOW] [STEP 1.4] Auto-cancel query completed. Modified count: ${cancelResult.modifiedCount}`);

    const {
        services,
        date,
        time,
        scheduledDate,
        scheduledTime,
        address,
        totalPrice,
        latitude,
        longitude,
        pincode,
        confirmation,
        otp
    } = bookingData;

    const bookingDate = date || scheduledDate;
    const bookingTime = time || scheduledTime;

    if (!services || services.length === 0) {
        console.error("[TRACKING-FLOW] [ERROR] At least one service is required");
        throw new ApiError(400, 'At least one service is required');
    }

    if (!latitude || !longitude) {
        console.error("[TRACKING-FLOW] [ERROR] Coordinates (Latitude and Longitude) are required for vendor discovery");
        throw new ApiError(400, 'Coordinates (Latitude and Longitude) are required for vendor discovery');
    }

    const user = await User.findById(userId);
    if (!user) {
        console.error("[TRACKING-FLOW] [ERROR] User not found in DB");
        throw new ApiError(404, 'User not found. Please log in again.');
    }
    
    if (user.bannedUntil && user.bannedUntil > new Date()) {
        console.error(`[TRACKING-FLOW] [ERROR] User is banned until ${user.bannedUntil}`);
        throw new ApiError(403, `You are temporarily banned from making bookings until ${user.bannedUntil.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} due to multiple cancellations.`);
    }

    const existingBookingsCount = await Booking.countDocuments({ user: userId });
    console.log(`[TRACKING-FLOW] [STEP 1.6] User's existing bookings count: ${existingBookingsCount}`);

    // First booking OTP requirement
    if (existingBookingsCount === 0) {
        console.log(`[TRACKING-FLOW] [STEP 1.7] First booking. Verification OTP provided: ${otp}`);
        if (!otp || otp.toString() !== '1234') {
            console.error("[TRACKING-FLOW] [ERROR] FIRST_BOOKING_OTP_REQUIRED");
            throw new ApiError(400, 'FIRST_BOOKING_OTP_REQUIRED');
        }
    }
    

    const processedServices = [];
    let leadCategory = null;

    console.log(`[TRACKING-FLOW] [STEP 1.8] Processing services... count: ${services.length}`);
    for (let i = 0; i < services.length; i++) {
        const item = services[i];
        // Fetch hierarchical pricing (Service -> ServiceType -> Subcategory -> Category)
        const serviceData = await Service.findById(item.serviceId).populate('category');
        const { adminPrice, coupon, discount } = await _getHierarchicalPricing(item.serviceId);
        
        if (i === 0 && serviceData) {
            leadCategory = serviceData.category?._id;
            console.log(`[TRACKING-FLOW] [STEP 1.9] Resolved Lead Category ID: ${leadCategory}`);
        }

        if (adminPrice === 0) {
            console.log(`[TRACKING-FLOW] [WARNING] Service ${item.serviceId} has 0 adminPrice across hierarchy`);
        }

        processedServices.push({
            service: item.serviceId,
            quantity: item.quantity || 1,
            adminPrice: adminPrice,
            coupon: coupon,
            discount: discount,
            finalPrice: adminPrice
                ? (adminPrice * (item.quantity || 1)) * (1 - (discount / 100))
                : null,
            isPriceConfirmed: !!adminPrice
        });
    }

    const perKmCharge = (await adminService.getSetting('pricing.travel_charge_per_km')) || 10;
    
    const distanceKm = 0; // No vendor assigned yet, so distance is 0
    let calculatedTravelCharge = (distanceKm * perKmCharge);
    if (calculatedTravelCharge > 500) calculatedTravelCharge = 500;
    calculatedTravelCharge = Math.round(calculatedTravelCharge * 100) / 100;

    const calculatedBasePrice = processedServices.reduce((sum, s) => sum + (s.finalPrice || 0), 0);
    const calculatedTotalPrice = calculatedBasePrice + calculatedTravelCharge;

    const bookingID = generateBookingID();
    console.log(`[TRACKING-FLOW] [STEP 1.11] Creating booking object in Database... bookingID: ${bookingID}`);
    const booking = await Booking.create({
        bookingID: bookingID,
        user: userId,
        category: leadCategory,
        services: processedServices,
        scheduledDate: new Date(bookingDate),
        scheduledTime: bookingTime,
        location: { address, latitude, longitude, pincode },
        pricing: { 
            basePrice: calculatedBasePrice,
            travelCharge: calculatedTravelCharge 
        },
        status: 'pending_acceptance',
        statusHistory: [{ status: 'pending_acceptance', timestamp: new Date(), actor: 'user' }],
        searchId: require('crypto').randomUUID()
    });

    console.log(`[TRACKING-FLOW] [STEP 1.12] Booking DB record created successfully. _id: ${booking._id}`);
    
    // Apply GST calculation
    console.log(`[TRACKING-FLOW] [STEP 1.13] Recalculating GST and final pricing...`);
    await recalculateBookingPrice(booking);
    await booking.save();
    console.log(`[TRACKING-FLOW] [STEP 1.14] Recalculation complete. Saved pricing details:`, JSON.stringify(booking.pricing, null, 2));

    // Trigger broadcast (Removed duplicate call)
    console.log(`[TRACKING-FLOW] [STEP 1.15] Triggering searchVendors broadcast asynchronously...`);
    searchVendors(booking, true).catch(err => {
        console.error('[TRACKING-FLOW] [BROADCAST ERROR] initial searchVendors failed:', err.message);
    });

    const populatedBooking = await Booking.findById(booking._id).populate('category');
    const formattedBooking = _formatBooking(populatedBooking, 'user');

    // ── Emit Success Response via Socket ──
    try {
        console.log(`[TRACKING-FLOW] [STEP 1.16] Emitting booking_created_success to user: ${userId}`);
        const { emitToUser } = require('../../socket');
        emitToUser(userId, 'booking_created_success', {
            booking: formattedBooking,
            message: 'Booking request placed successfully. Searching for vendors...'
        });
    } catch (socketErr) {
        console.error('[TRACKING-FLOW] [SOCKET ERROR] Failed to emit booking_created_success:', socketErr.message);
    }

    return {
        booking: formattedBooking,
        message: 'Searching for vendors...'
    };
};

const searchVendors = async (booking, broadcast = false, scheduleNextWave = true) => {
    
    // Safety check: only search if booking is actively looking for acceptance
    if (booking.status !== 'pending_acceptance') {
        return [];
    }
    
    let currentSearchId = booking.searchId;
    if (!currentSearchId) {
        currentSearchId = require('crypto').randomUUID();
        booking.searchId = currentSearchId;
        await booking.save();
        console.log(`[TRACKING-FLOW] [STEP 2.1] Generated new searchId: ${currentSearchId}`);
    } else {
        console.log(`[TRACKING-FLOW] [STEP 2.1] Using existing searchId: ${currentSearchId}`);
    }

    if (!booking.location?.latitude || !booking.location?.longitude) {
        console.error(`[TRACKING-FLOW] [ERROR] searchVendors: Missing coordinates for ${booking._id}. Search aborted.`);
        if (broadcast) {
            const { emitToUser } = require('../../socket');
            emitToUser(booking.user, 'booking_search_update', {
                bookingId: booking._id,
                status: 'failed',
                message: 'Vendor search failed: Missing location coordinates.'
            });
        }
        return [];
    }
    console.log(`[TRACKING-FLOW] [STEP 2.2] Location coordinates resolved: lat=${booking.location.latitude}, lng=${booking.location.longitude}`);

    // 1. Determine Dynamic Radius and Waves
    const retryCount = booking.retryCount || 0;
    console.log(`[TRACKING-FLOW] [STEP 2.3] Current retryCount (Wave index): ${retryCount}`);
    
    // Fetch settings for all rows
    const [r1_km, r1_min, r2_km, r2_min, r3_km, r3_min] = await Promise.all([
        adminService.getSetting('notifications.radius_row1_km'),
        adminService.getSetting('notifications.radius_row1_mins'),
        adminService.getSetting('notifications.radius_row2_km'),
        adminService.getSetting('notifications.radius_row2_mins'),
        adminService.getSetting('notifications.radius_row3_km'),
        adminService.getSetting('notifications.radius_row3_mins')
    ]);

    const waves = [
        { km: Number(r1_km) || 1, mins: Number(r1_min) || 5 },
        { km: Number(r2_km) || 1, mins: Number(r2_min) || 10 },
        { km: Number(r3_km) || 1, mins: Number(r3_min) || 15 }
    ];

    const totalSearchTimeMins = waves.reduce((sum, wave) => sum + wave.mins, 0);
    const currentWave = waves[Math.min(retryCount, waves.length - 1)];
    const radiusInKm = currentWave.km;
    
    let categoryIds = [];
    if (booking.category) {
        categoryIds = [booking.category.toString()];
    } else {
        const serviceIds = booking.services.map(s => s.service);
        const services = await Service.find({ _id: { $in: serviceIds } }).select('category');
        categoryIds = [...new Set(services.map(s => s.category.toString()))];
    }
    console.log(`[TRACKING-FLOW] [STEP 2.6] Target Category IDs for vendor discovery:`, categoryIds);

    const ignoredVendors = [
        ...(booking.rejectedVendors || []),
        ...(booking.laterVendors || []),
        ...(booking.notifiedVendors || []) // Exclude already notified vendors to prevent spamming
    ].map(id => id.toString());
    console.log(`[TRACKING-FLOW] [STEP 2.7] Ignored/excluded vendor IDs (rejected/later/already-notified):`, ignoredVendors);

    // ── Find vendors who already have active bookings ──
    // Exclude vendors who have ANY active booking (so they don't get new requests while busy)
    const busyBookings = await Booking.find({
        status: { $in: ['pending', 'on_the_way', 'arrived', 'ongoing'] },
        vendor: { $exists: true, $ne: null }
    }).select('vendor');
    const busyVendorIds = busyBookings.map(b => b.vendor.toString());

    // ── Find services belonging to the booking's categories so we can match vendors by selectedServices too ──
    const servicesInCategories = await Service.find({ category: { $in: categoryIds } }).select('_id');
    const serviceIdsInCategories = servicesInCategories.map(s => s._id);
    console.log(`[TRACKING-FLOW] [STEP 2.8] Found ${serviceIdsInCategories.length} services in categoryIds [${categoryIds}] for cross-matching`);

    // ── Geospatial Query ──
    const serviceIds = (booking.services || []).map(s => s.service);
    let categoryOrServiceFilter = [];

    if (serviceIds.length > 0) {
        const mongoose = require('mongoose');
        const serviceObjectIds = serviceIds.map(id => new mongoose.Types.ObjectId(id));
        // STRICT match: Vendor must have ALL requested services explicitly.
        // Removed the $or fallback to categoryIds to prevent vendors from receiving
        // notifications for services they haven't explicitly purchased/selected.
        categoryOrServiceFilter = [
            { selectedServices: { $all: serviceObjectIds } }
        ];
        console.log(`[TRACKING-FLOW] [STEP 2.9] Applied STRICT Service Filter (ALL serviceIds must match):`, serviceIds);
    } else {
        categoryOrServiceFilter = [
            { selectedCategories: { $in: categoryIds } }
        ];
        if (serviceIdsInCategories.length > 0) {
            categoryOrServiceFilter.push({ selectedServices: { $in: serviceIdsInCategories } });
        }
        console.log(`[TRACKING-FLOW] [STEP 2.9] Applied Category/Service fallback filter`);
    }

    const geoQuery = {
        isVerified: true,
        isSuspended: false,
        isBlocked: false,
        isOnline: true,
        registrationStep: 'COMPLETED',
        deletedAt: null,
        $and: [
            {
                $or: [
                    { 'membership.expiryDate': { $exists: false } },
                    { 'membership.expiryDate': { $gt: new Date() } }
                ]
            },
            {
                $or: [
                    { 'serviceRenewal.expiryDate': { $exists: false } },
                    { 'serviceRenewal.expiryDate': { $gt: new Date() } }
                ]
            },
            {
                $or: categoryOrServiceFilter
            }
        ],
        liveLocation: {
            $nearSphere: {
                $geometry: {
                    type: "Point",
                    coordinates: [booking.location.longitude, booking.location.latitude]
                },
                $maxDistance: radiusInKm * 1000 // Convert km to meters
            }
        }
    };

    const nins = [...new Set([...ignoredVendors, ...busyVendorIds])];
    if (nins.length > 0) {
        geoQuery._id = { $nin: nins };
    }

    console.log(`[TRACKING-FLOW] [STEP 2.10] Final Geospatial Query generated:`, JSON.stringify(geoQuery, null, 2));

    let vendors = await Vendor.find(geoQuery).select('_id name fcmToken categorySubscriptions membership');
    console.log(`[TRACKING-FLOW] [STEP 2.11] MongoDB geoQuery returned raw matched vendors count: ${vendors.length}`);
    
    /* 
    // Filter out vendors whose matched category is expired
    // (Commented out because DB query already filters by selectedServices, membership.expiryDate, and serviceRenewal.expiryDate.)
    vendors = vendors.filter(vendor => {
        const primaryCatId = vendor.membership?.category?.toString();
        const vendorNameStr = vendor.name || 'Unknown';
        
        const hasActiveCategory = categoryIds.some(catId => {
            const catIdStr = catId.toString();
            
            // Primary category check
            if (primaryCatId === catIdStr) {
                console.log(`[TRACKING-FLOW] [STEP 2.12] Vendor ${vendorNameStr} (${vendor._id}) matched primary category: ${catIdStr}`);
                return true; 
            }
            
            // Additional category check
            const catSub = vendor.categorySubscriptions?.find(sub => 
                sub.category && sub.category.toString() === catIdStr
            );
            if (catSub) {
                const subExp = catSub.expiryDate ? new Date(catSub.expiryDate) : null;
                const isSubActive = subExp ? subExp > new Date() : false;
                console.log(`[TRACKING-FLOW] [STEP 2.12] Vendor ${vendorNameStr} (${vendor._id}) categorySubscription check for ${catIdStr}: active=${isSubActive}, status=${catSub.status}`);
                return isSubActive && catSub.status === 'ACTIVE';
            }
            return false;
        });
        
        if (!hasActiveCategory) {
            console.log(`[TRACKING-FLOW] [STEP 2.12] Vendor ${vendorNameStr} (${vendor._id}) EXCLUDED because no active/non-expired subscription matches target categories.`);
        }
        return hasActiveCategory;
    });

    console.log(`[TRACKING-FLOW] [STEP 2.13] After category expiry filtering, total eligible vendors: ${vendors.length}`);
    */
    console.log(`[TRACKING-FLOW] [STEP 2.13] After database filtering, total eligible vendors: ${vendors.length}`);

    if (vendors.length === 0) {
        console.warn('[TRACKING-FLOW] [WARNING] No eligible vendors matched current search filters.');
    }

    if (broadcast) {
        try {
            let broadcastCount = 0;
            console.log(`[TRACKING-FLOW] [STEP 2.14] Initiating socket/push broadcast...`);

            // Fetch populated booking for broadcast payload
            const populatedBooking = await Booking.findById(booking._id)
                .populate('services.service', 'title serviceCharge photo approxCompletionTime')
                .populate('category', 'title name')
                .populate('user', 'name phoneNumber photo');

            let totalDurationMins = 0;

            if (populatedBooking.services && populatedBooking.services.length > 0) {
                populatedBooking.services.forEach(item => {
                    totalDurationMins += (item.service?.approxCompletionTime || 0) * (item.quantity || 1);
                });
            }

            const servicesMapped = (populatedBooking.services || []).map(item => {
                const serviceDetailsObj = item.service ? (item.service.toObject ? item.service.toObject() : item.service) : null;
                if (serviceDetailsObj) {
                    serviceDetailsObj.id = serviceDetailsObj._id ? serviceDetailsObj._id.toString() : '';
                    delete serviceDetailsObj._id;
                }
                return {
                    quantity: item.quantity,
                    adminPrice: item.adminPrice,
                    vendorPrice: item.vendorPrice,
                    finalPrice: item.finalPrice,
                    isPriceConfirmed: item.isPriceConfirmed,
                    id: item._id ? item._id.toString() : '',
                    service: serviceDetailsObj
                };
            });

            // ------------------------------------------------------------------
            // 2️⃣  Strip Mongo internals and force 'id' to be at the very top
            // ------------------------------------------------------------------
            const baseObj = populatedBooking.toObject();
            delete baseObj._id;
            delete baseObj.__v;
            delete baseObj.id; // Remove virtual id if it exists so we can place it first

            const payload = {
                id: populatedBooking._id.toString(),
                bookingID: populatedBooking.bookingID,
                ...baseObj,
                services: servicesMapped,
                totalDurationMins,
                radius: radiusInKm
            };

            // Clean nested objects: replace internal _id with plain id strings
            if (payload.user) {
                payload.user.id = payload.user._id?.toString();
                delete payload.user._id;
            }
            if (payload.category) {
                payload.category.id = payload.category._id?.toString();
                delete payload.category._id;
            }
            // (location does not contain _id, so no change needed)


            // ── Sensitive Data Redaction for unaccepted requests ──
            if (payload.user) {
                payload.user.phoneNumber = '••••••••••';
                if (payload.user.email) payload.user.email = '••••••••••';
            }
            if (payload.location) {
                payload.location.address = 'Location visible after acceptance';
            }

            // Explicitly expose user logic for the socket broadcast
            if (payload.user && payload.location) {
                payload.user.latitude = payload.location.latitude;
                payload.user.longitude = payload.location.longitude;
            }

            const { emitToVendor, isVendorOnline, activeVendors } = require('../../socket');
            const notificationService = require('../notification/notification.service');

            // Build a Set of already-notified vendor IDs for O(1) dedup lookup
            const alreadyNotifiedSet = new Set(
                (booking.notifiedVendors || []).map(id => id.toString())
            );

            const notificationPromises = vendors.map(async (v) => {
                const vendorIdStr = v._id.toString();
                const vendorNameStr = v.name || 'Unknown';

                // ── Deduplication guard ──
                if (alreadyNotifiedSet.has(vendorIdStr)) {
                    console.log(`[TRACKING-FLOW] [STEP 2.15] Skipping Vendor ${vendorNameStr} (${vendorIdStr}) — already notified previously for Booking ${booking._id}`);
                    return null;
                }

                const online = isVendorOnline(vendorIdStr);
                const matchedSockets = activeVendors.get(vendorIdStr) || [];
                
                console.log(`[TRACKING-FLOW] [STEP 2.16] Broadcast vendor evaluation: ID=${vendorIdStr}, Name=${vendorNameStr}, Socket Online=${online}, Socket SocketsCount=${matchedSockets.length}, FCM Token Present=${!!v.fcmToken}`);
                
                try {
                    require('fs').appendFileSync(require('path').join(__dirname, '../../../scratch/notify_debug.txt'), `[DEBUG] ${new Date().toISOString()} | Booking: ${booking._id} | Vendor: ${vendorIdStr} | Socket Online: ${online} | Sockets: ${matchedSockets.join(',')} | FCM Token Present: ${!!v.fcmToken}\n`);
                } catch(e) {}
                

                // ── Socket + FCM Hybrid: Send BOTH socket AND FCM to ensure delivery ──
                // Socket for real-time in-app notifications when app is active
                // FCM as guaranteed delivery mechanism for all cases (background, inactive, offline)
                
                // 1. Always send Socket Notification if vendor is online
                if (online) {
                    console.log(`[TRACKING-FLOW] [STEP 2.17a] Vendor is ONLINE. Emitting 'new_booking_request' via socket(s): ${matchedSockets.join(', ')}`);
                    emitToVendor(vendorIdStr, 'new_booking_request', payload);
                    broadcastCount++;
                }
                
                // 2. ALWAYS send FCM Push Notification as a reliable fallback (whether online or offline)
                // This ensures delivery even if socket fails or app is in background
                if (v.fcmToken) {
                    console.log(`[TRACKING-FLOW] [STEP 2.17b] Sending FCM push notification to Vendor ${vendorNameStr}...`);
                    
                    const fcmData = {
                      type: 'new_booking_request',
                      bookingId: payload.id || booking._id?.toString() || '',
                      bookingID: payload.bookingID || '',
                      address: payload.location?.address || '',
                      booking_data: JSON.stringify(payload)
                    };
                    await notificationService.createNotification({
                        user: v._id,
                        userModel: 'Vendor',
                        type: 'new_booking',
                        title: 'New Booking Request',
                        body: `You have a new booking request for ${populatedBooking.category?.title || 'a service'} nearby.`,
                        data: fcmData,
                        sendPush: true,
                        fcmToken: v.fcmToken
                    }).then(() => {
                        console.log(`[TRACKING-FLOW] [STEP 2.18] Push Notification sent successfully to Vendor ${vendorNameStr}`);
                    }).catch(err => {
                        console.error(`[TRACKING-FLOW] [NOTIFICATION ERROR] Failed to send FCM to Vendor ${vendorNameStr} (${vendorIdStr}):`, err.message);
                    });
                } else {
                    console.log(`[TRACKING-FLOW] [STEP 2.17c] Vendor ${vendorNameStr} has no FCM token. Skipping push notification.`);
                }

                return v._id;
            });

            const notifiedIds = (await Promise.all(notificationPromises)).filter(Boolean);

            // Persist notified vendors to DB
            if (notifiedIds.length > 0) {
                await Booking.findByIdAndUpdate(booking._id, {
                    $addToSet: { notifiedVendors: { $each: notifiedIds } }
                });
                console.log(`[TRACKING-FLOW] [STEP 2.20] Persisted ${notifiedIds.length} newly notified vendor IDs to DB for Booking ${booking._id}`);
            }

            const { emitToUser } = require('../../socket');
            console.log(`[TRACKING-FLOW] [STEP 2.21] Emitting booking_search_update to user: ${booking.user}. notifiedCount: ${broadcastCount}`);
            emitToUser(booking.user, 'booking_search_update', {
                bookingId: booking._id,
                bookingID: booking.bookingID,
                status: 'searching',
                radius: radiusInKm,
                vendorCount: broadcastCount,
                ...buildSearchTimingPayload({
                    searchId: currentSearchId,
                    retryCount,
                    waves,
                    totalSearchTimeMins
                }),
                message: broadcastCount > 0 
                  ? `Searching in ${radiusInKm}km radius... notified ${broadcastCount} vendors.`
                  : `Searching in ${radiusInKm}km radius... no vendors online nearby right now.`
            });

            // ── Schedule Search Expansion (Dynamic Waves) ──
            if (scheduleNextWave) {
                if (retryCount < waves.length - 1) {
                    const delayMins = waves[retryCount].mins > 0 ? waves[retryCount].mins : 5;
                    
                    console.log(`[TRACKING-FLOW] [STEP 2.22] Scheduling Wave ${retryCount + 1} (Radius: ${waves[retryCount+1].km}km) in ${delayMins} minutes`);

                    setTimeout(async () => {
                        console.log(`[TRACKING-FLOW] [STEP 3] Wave timer fired! Checking eligibility of booking ${booking._id}...`);
                        const current = await Booking.findById(booking._id);
                        if (current && current.status === 'pending_acceptance' && current.searchId === currentSearchId) {
                            current.retryCount = (current.retryCount || 0) + 1;
                            await current.save();
                            console.log(`[TRACKING-FLOW] [STEP 3.1] Triggering next wave retry search... retryCount: ${current.retryCount}`);
                            searchVendors(current, true, true).catch(console.error);
                        } else {
                            console.log(`[TRACKING-FLOW] [STEP 3.2] Wave ${retryCount + 1} skipped. Reason: status is ${current ? current.status : 'missing'} (expected 'pending_acceptance'), searchId changed, or booking missing.`);
                        }
                    }, delayMins * 60 * 1000);
                } else if (retryCount === waves.length - 1) {
                    // Hard-Stop: After the final tier
                    const finalWaitMins = waves[retryCount].mins > 0 ? waves[retryCount].mins : 2; 
                    console.log(`[TRACKING-FLOW] [STEP 2.22] Final wave reached. Scheduling Hard-Stop in ${finalWaitMins} minutes`);

                    setTimeout(async () => {
                    console.log(`[TRACKING-FLOW] [STEP 4] Hard-Stop timer fired! Evaluating booking ${booking._id}...`);
                    const current = await Booking.findById(booking._id);
                    if (current && current.status === 'pending_acceptance' && current.searchId === currentSearchId) {
                        // Don't change status to invalid enum value. Keep as 'pending_acceptance' so user can retry.
                        console.warn(`[TRACKING-FLOW] [STEP 4.1] Hard-Stop completed. No vendors found for booking ${booking._id}. Notifying user.`);
                        
                        emitToUser(booking.user, 'booking_search_update', {
                            bookingId: booking._id,
                            bookingID: booking.bookingID,
                            status: 'search_completed_no_vendors',
                            message: `Could not find any vendors within ${waves[waves.length - 1].km}km after ${waves[waves.length - 1].mins} minutes of searching. Please try again manually.`,
                            searchCompleted: true,
                            ...buildSearchTimingPayload({
                                searchId: booking.searchId,
                                retryCount,
                                waves,
                                totalSearchTimeMins
                            }),
                            remainingSearchTimeMins: 0
                        });
                    } else {
                        console.log(`[TRACKING-FLOW] [STEP 4.2] Hard-Stop ignored. Reason: status changed or searchId rotated.`);
                    }
                }, finalWaitMins * 60 * 1000);
            }
        } // Close if (scheduleNextWave)
        } catch (error) {
            console.error('[TRACKING-FLOW] [SOCKET/BROADCAST ERROR] Socket.io error during broadcast:', error.message);
        }
    }

    return vendors.map(v => ({ vendorId: v._id }));
};

/**
 * Reject a Booking Request (Vendor rejects)
 */
const rejectBooking = async (vendorId, bookingId) => {
    let booking = await Booking.findById(bookingId);
    
    if (!booking) throw new ApiError(404, 'Booking not found');

    const vendorIdStr = vendorId.toString();

    // Add to rejected if not already there
    if (!booking.rejectedVendors.some(id => id.toString() === vendorIdStr)) {
        booking.rejectedVendors.push(vendorId);
    }

    // Always remove from laterVendors when rejecting
    if (booking.laterVendors) {
        booking.laterVendors = booking.laterVendors.filter(id => id.toString() !== vendorIdStr);
    }

    await booking.save();

    // ── Socket Sync ──
    try {
        const { emitToVendor, emitToUser } = require('../../socket');
        emitToVendor(vendorId, 'booking_rejected_success', {
            bookingId: booking._id,
            bookingID: booking.bookingID,
            message: 'Booking rejected and removed from your list'
        });
        // Emit search update to user indicating rejection but CONTINUE search (don't mark as completed)
        try {
            const { waves, totalSearchTimeMins } = await getSearchWaveConfig();
            const searchPayload = buildSearchTimingPayload({
                searchId: booking.searchId,
                retryCount: booking.retryCount || 0,
                waves,
                totalSearchTimeMins
            });
            emitToUser(booking.user, 'booking_search_update', {
                bookingId: booking._id,
                bookingID: booking.bookingID,
                status: 'searching',
                message: 'That vendor rejected the request. Continuing search...',
                searchCompleted: false,
                ...searchPayload,
                vendorRejectionCount: booking.rejectedVendors.length
            });
            console.log(`[SOCKET] Emitted rejection update for user: ${booking.user}, continuing search with remaining ${searchPayload.remainingSearchTimeMins} mins`);
        } catch (socketErr) {
            console.error(`[SOCKET] Failed to emit booking_search_update after rejection: ${socketErr.message}`);
        }
    } catch (socketErr) {
        console.error('[SOCKET ERROR] Failed to emit booking_rejected_success:', socketErr.message);
    }

    // ── Re-trigger vendor search to find alternatives (Do NOT duplicate wave timers!) ──
    try {
        await searchVendors(booking, true, false).catch(err => {
            console.error(`[SEARCH] Failed to re-search after rejection: ${err.message}`);
        });
    } catch (err) {
        console.error(`[SEARCH] Error triggering re-search after rejection: ${err.message}`);
    }

    return {
        booking,
        message: 'Booking rejected and removed from your list'
    };
};

/**
 * Mark a Booking Request for Later (Vendor chooses)
 */
const markBookingLater = async (vendorId, bookingId) => {
    let booking = await Booking.findById(bookingId);
    
    if (!booking) throw new ApiError(404, 'Booking not found');

    // Only allow if it's still pending acceptance
    const isAvailable = booking.status === 'pending_acceptance';
    if (!isAvailable) {
        throw new ApiError(400, 'Booking is no longer available');
    }

    const vendorIdStr = vendorId.toString();

    // Add to later if not already there
    if (!booking.laterVendors.some(id => id.toString() === vendorIdStr)) {
        booking.laterVendors.push(vendorId);
    }

    // Remove from rejected if it was there
    if (booking.rejectedVendors) {
        booking.rejectedVendors = booking.rejectedVendors.filter(id => id.toString() !== vendorIdStr);
    }

    await booking.save();

    // ── Socket Sync ──
    try {
        const { emitToVendor, emitToUser } = require('../../socket');
        emitToVendor(vendorId, 'booking_later_success', {
            bookingId: booking._id,
            bookingID: booking.bookingID,
            message: 'Marked as later successfully'
        });
        // Also emit search update to user continuing the search
        try {
            const { waves, totalSearchTimeMins } = await getSearchWaveConfig();
            const searchPayload = buildSearchTimingPayload({
                searchId: booking.searchId,
                retryCount: booking.retryCount || 0,
                waves,
                totalSearchTimeMins
            });
            emitToUser(booking.user, 'booking_search_update', {
                bookingId: booking._id,
                bookingID: booking.bookingID,
                status: 'searching',
                message: 'Vendor marked for later. Continuing search...',
                searchCompleted: false,
                ...searchPayload,
                vendorDeferredCount: booking.laterVendors.length
            });
            console.log(`[SOCKET] Emitted 'later' status update for user: ${booking.user}, continuing search with remaining ${searchPayload.remainingSearchTimeMins} mins`);
        } catch (socketErr) {
            console.error(`[SOCKET] Failed to emit booking_search_update after marking later: ${socketErr.message}`);
        }
    } catch (socketErr) {
        console.error('[SOCKET ERROR] Failed to emit booking_later_success:', socketErr.message);
    }

    // ── Re-trigger vendor search to find alternatives ──
    try {
        await searchVendors(booking, true).catch(err => {
            console.error(`[SEARCH] Failed to re-search after marking later: ${err.message}`);
        });
    } catch (err) {
        console.error(`[SEARCH] Error triggering re-search after marking later: ${err.message}`);
    }

    return {
        booking,
        message: 'Marked as later successfully'
    };
};

/**
 * Get vendor booking history (including Later)
 */
const getVendorBookingHistory = async (vendorId) => {
    const Vendor = require('../../models/Vendor.model');
    const vendorIdObj = new mongoose.Types.ObjectId(vendorId);
    const vendor = await Vendor.findById(vendorId).select('isVerified documentStatus');
    // Allow history if verified OR if they have at least one booking (safety for active vendors)
    const hasBookings = await Booking.exists({ vendor: vendorIdObj });
    
    if (!hasBookings && (!vendor?.isVerified || (vendor?.documentStatus !== 'approved' && vendor?.documentStatus !== 'verified'))) {
        return { pending: [], ongoing: [], completed: [], cancelled: [] };
    }

    // 1. Pending (Accepted by vendor but not started)
    // 2. Ongoing (started)
    // 3. Completed
    // 4. Cancelled
    const activeAndHistoryBookings = await Booking.find({
        vendor: vendorIdObj,
        status: { $in: ['pending', 'ongoing', 'completed', 'on_the_way', 'arrived', 'cancelled', 'auto_cancelled'] }
    })
        .select('-rejectedVendors -laterVendors')
        .populate('services.service', 'title serviceCharge photo')
        .populate('user', 'name phoneNumber photo')
        .sort({ createdAt: -1 });

    const categorized = {
        pending: activeAndHistoryBookings.filter(b => ['pending', 'on_the_way', 'arrived'].includes(b.status)),
        ongoing: activeAndHistoryBookings.filter(b => b.status === 'ongoing'),
        completed: activeAndHistoryBookings.filter(b => b.status === 'completed'),
        cancelled: activeAndHistoryBookings.filter(b => ['cancelled', 'auto_cancelled'].includes(b.status)).map(b => {
            const obj = b.toObject();
            obj.cancelledBy = obj.cancellation?.cancelledBy || 'unknown';
            return obj;
        })
    };

    return categorized;
};

/**
 * Get Vendor's Later Bookings List
 */
const getVendorLaterBookings = async (vendorId) => {
    const Vendor = require('../../models/Vendor.model');
    const vendor = await Vendor.findById(vendorId).select('isVerified documentStatus');
    if (!vendor?.isVerified || vendor?.documentStatus !== 'approved') {
        return [];
    }

    const vendorIdObj = new mongoose.Types.ObjectId(vendorId);

    // Later Bookings (Only those still pending acceptance!)
    const laterBookings = await Booking.find({
        laterVendors: vendorIdObj,
        status: 'pending_acceptance'
    })
        .select('-rejectedVendors -laterVendors')
        .populate('services.service', 'title serviceCharge photo')
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

    // ── Only allow cancellation while searching for vendors ──
    if (booking.status !== 'pending_acceptance') {
        throw new ApiError(400, 'Booking can only be cancelled while searching for vendors. Once a vendor accepts, cancellation is not allowed.');
    }

    // ── Cancel count enforcement ──
    const cancelLimit = (await adminService.getSetting('bookings.cancel_limit')) || 1;
    if (booking.cancelCount >= cancelLimit) {
        throw new ApiError(400, `Maximum cancellation limit of ${cancelLimit} reached for this booking`);
    }

    const now = new Date();

    booking.status = 'cancelled';
    booking.statusHistory.push({ status: 'cancelled', actor: 'user', reason: reason || 'Cancelled by user', timestamp: now });
    booking.markModified('statusHistory');
    booking.cancelCount += 1;
    booking.cancellation = {
        cancelledBy: 'user',
        reason,
        cancelledAt: now,
        travelChargeApplied: false
    };

    await booking.save();

    const populatedBooking = await Booking.findById(booking._id)
        .populate('services.service', 'title serviceCharge photo')
        .populate('proposedServices.service', 'title serviceCharge photo')
        .populate('userRequestedServices.service', 'title serviceCharge photo')
        .populate('category')
        .populate('vendor', 'name phoneNumber photo documents.photo.url')
        .populate('user', 'name phoneNumber photo');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', populatedBooking);
    if (booking.vendor) {
        emitToVendor(booking.vendor, 'booking_cancellation', populatedBooking);

        // ── Send Push Notification to Vendor ──
        sendPush(booking.vendor, 'Vendor', 'booking_cancelled', 'Booking Cancelled', `The user has cancelled booking ${booking.bookingID}.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });
    } else {
        // If the booking had no vendor (still searching), notify ONLY previously-notified vendors
        try {
            const { emitToVendor } = require('../../socket');

            if (booking.notifiedVendors && booking.notifiedVendors.length > 0) {
                booking.notifiedVendors.forEach(nVendorId => {
                    // Socket notify
                    emitToVendor(nVendorId.toString(), 'booking_already_accepted', {
                        bookingId: booking._id,
                        bookingID: booking.bookingID,
                        message: 'This booking request is no longer available.'
                    });
                    // FCM push to clear background notifications
                    sendPush(
                        nVendorId,
                        'Vendor',
                        'booking_already_accepted',
                        'Booking Request Cancelled',
                        'This booking request is no longer available.',
                        { bookingId: booking._id.toString(), bookingID: booking.bookingID }
                    );
                });
                console.log(`[CANCEL] Notified ${booking.notifiedVendors.length} previously-notified vendors about cancellation for Booking ${booking._id}`);
            } else {
                console.log(`[CANCEL] No previously-notified vendors to inform for Booking ${booking._id}`);
            }
        } catch (err) {
            console.error('[SOCKET ERROR] Failed to broadcast search cancellation to vendors:', err.message);
        }
    }

    return populatedBooking || booking;
};

/**
 * Vendor cancels booking
 */
const vendorCancelBooking = async (vendorId, bookingId, reason) => {
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (['completed', 'cancelled', 'auto_cancelled'].includes(booking.status)) {
        throw new ApiError(400, 'Cannot cancel a booking that is already completed or cancelled');
    }

    const vendorHasArrived = booking.status === 'arrived' || booking.status === 'ongoing';
    const travelChargeApplied = vendorHasArrived;
    const now = new Date();

    // ── Task 8 & 10: Exit terminology for User No-Show ──
    const isUserNoShow = reason && (reason.toUpperCase().includes('USER_NOT_AVAILABLE') || reason.toUpperCase().includes('NO_SHOW'));
    const statusLabel = isUserNoShow ? 'exit' : 'cancelled';
    const actionLabel = isUserNoShow ? 'Exit (User No-Show)' : 'Cancellation';

    booking.status = 'cancelled';
    booking.statusHistory.push({ 
        status: 'cancelled', 
        actor: 'vendor', 
        reason: reason || `Vendor ${statusLabel} the order`, 
        timestamp: now,
        note: isUserNoShow ? 'Manual confirmation required for User No-Show Exit.' : undefined
    });
    booking.markModified('statusHistory');
    booking.cancellation = {
        cancelledBy: 'vendor',
        reason: reason || `Vendor ${statusLabel} the order`,
        cancelledAt: now,
        travelChargeApplied,
        isExit: isUserNoShow // Flagging specifically for Task 10
    };

    await booking.save();

    const populatedBooking = await Booking.findById(booking._id)
        .populate('services.service', 'title serviceCharge photo')
        .populate('proposedServices.service', 'title serviceCharge photo')
        .populate('userRequestedServices.service', 'title serviceCharge photo')
        .populate('category')
        .populate('vendor', 'name phoneNumber photo documents.photo.url')
        .populate('user', 'name phoneNumber photo');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', populatedBooking);
    emitToUser(booking.user, 'booking_cancellation', {
        ...populatedBooking.toObject(),
        message: 'The vendor has cancelled your booking.'
    });

    // ── Send Push Notification to User ──
    sendPush(booking.user, 'User', 'booking_cancelled', 'Booking Cancelled', `The vendor has cancelled your booking ${booking.bookingID}.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });
    emitToVendor(vendorId, 'booking_status_updated', populatedBooking);

    return populatedBooking || booking;
};

/**
 * Get available time slots for a vendor on a given date
 * based on category slot configuration (or defaults 08:00–20:00 / 30 min),
 * excluding windows that overlap with existing bookings.
 */
const getAvailableSlots = async (vendorId, date, excludeBookingId, categoryId = null) => {
    // Fetch category slot config if available
    let slotDuration = 30;
    let slotStartTime = '08:00';
    let slotEndTime = '20:00';

    if (categoryId) {
        const category = await Category.findById(categoryId).select('slotDuration slotStartTime slotEndTime');
        if (category) {
            slotDuration = category.slotDuration || 30;
            slotStartTime = category.slotStartTime || '08:00';
            slotEndTime = category.slotEndTime || '20:00';
        }
    }

    const [startH, startM] = slotStartTime.split(':').map(Number);
    const [endH, endM] = slotEndTime.split(':').map(Number);

    const istDateStr = new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const dayStart = new Date(`${istDateStr}T00:00:00+05:30`);
    const dayEnd = new Date(`${istDateStr}T23:59:59.999+05:30`);

    // Fetch all vendor's active bookings on that day
    const vendorBookings = await Booking.find({
        vendor: vendorId,
        _id: { $ne: excludeBookingId },
        scheduledDate: { $gte: dayStart, $lte: dayEnd },
        status: { $nin: ['cancelled', 'auto_cancelled', 'completed', 'pending_acceptance'] }
    }).populate('services.service');


    // Build busy windows
    const busyWindows = [];
    for (const b of vendorBookings) {
        const range = await getBookingTimeRange(b);
        if (range) busyWindows.push(range);
    }

    // Generate candidate slots based on category duration
    const slots = [];
    const slotDurationMs = slotDuration * 60 * 1000;
    let currentMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    while (currentMinutes <= endMinutes) {
        const h = Math.floor(currentMinutes / 60);
        const m = currentMinutes % 60;

        const slotStart = new Date(`${istDateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
        const slotEnd = new Date(slotStart.getTime() + slotDurationMs);

        const overlaps = busyWindows.some(w =>
            Math.max(slotStart, w.start) < Math.min(slotEnd, w.end)
        );

        const isAvailable = slotStart.getTime() > Date.now();
        if (!overlaps && isAvailable) {
            slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
        }

        currentMinutes += slotDuration;
    }

    return slots;
};

/**
 * Reschedule booking
 * - Max 2 reschedules per booking
 * - If vendor assigned: checks for conflicts at new time; returns available slots if busy
 * - Emits socket to vendor on success
 */
const rescheduleBooking = async (userId, bookingId, { date, time }) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    const rescheduleLimit = (await adminService.getSetting('bookings.reschedule_limit')) || 2;
    if (booking.rescheduleCount >= rescheduleLimit) {
        throw new ApiError(400, `Max reschedule limit of ${rescheduleLimit} reached`);
    }

    if (['completed', 'cancelled', 'auto_cancelled'].includes(booking.status)) {
        throw new ApiError(400, 'Cannot reschedule a completed or cancelled booking');
    }

    // --- 2-hour cutoff: cannot reschedule within 2 hours of scheduled start ---
    if (booking.scheduledDate && booking.scheduledTime) {
        const scheduledStart = _getScheduledDateTimeIST(booking.scheduledDate, booking.scheduledTime);

        const now = new Date();
        const diffMs = scheduledStart - now;
        const diffHours = diffMs / (1000 * 60 * 60);

        if (diffHours < 2) {
            throw new ApiError(400, 'Rescheduling is not allowed within 2 hours of the scheduled start time');
        }
    }

    // --- Vendor conflict check (only if a vendor is assigned) ---
    if (booking.vendor) {
        const newDate = new Date(date);

        // Build a temporary booking-like object to compute the time range at the new slot
        const tempBooking = await Booking.findById(booking._id).populate('services.service');
        tempBooking.scheduledDate = newDate;
        tempBooking.scheduledTime = time;
        const newRange = await getBookingTimeRange(tempBooking);

        if (newRange) {
            // Find any active booking for this vendor on that day (excluding current)
            const dayStart = new Date(newDate);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(newDate);
            dayEnd.setHours(23, 59, 59, 999);

            const vendorBookings = await Booking.find({
                vendor: booking.vendor,
                _id: { $ne: booking._id },
                scheduledDate: { $gte: dayStart, $lte: dayEnd },
        status: { $nin: ['cancelled', 'auto_cancelled', 'completed', 'pending_acceptance'] }
            }).populate('services.service');

            for (const vb of vendorBookings) {
                const range = await getBookingTimeRange(vb);
                if (!range) continue;
                const overlaps = Math.max(newRange.start, range.start) < Math.min(newRange.end, range.end);
                if (overlaps) {
                    // Vendor is busy — return available slots instead
                    const availableSlots = await getAvailableSlots(booking.vendor, newDate, booking._id, booking.category);
                    return {
                        vendorBusy: true,
                        message: 'Vendor has bookings at that time. Please choose from the available slots.',
                        availableSlots
                    };
                }
            }
        }
    }

    // --- Save reschedule ---
    booking.scheduledDate = new Date(date);
    booking.scheduledTime = time;
    booking.rescheduleCount += 1;
    booking.statusHistory.push({
        status: 'rescheduled',
        reason: `Rescheduled to ${date} ${time}`,
        actor: 'user',
        timestamp: new Date()
    });
    booking.markModified('statusHistory');
    await booking.save();

    // Fetch populated payloads
    const userPayload = await getBookingDetails(booking._id, userId, 'user');

    // Notify vendor via socket immediately
    if (booking.vendor) {
        try {
            const { emitToVendor } = require('../../socket');
            const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
            emitToVendor(booking.vendor, 'booking_rescheduled', {
                bookingId: booking._id,
                bookingID: booking.bookingID,
                newDate: date,
                newTime: time,
                message: 'User has rescheduled this booking.',
                booking: vendorPayload
            });

            // ── Send Push Notification to Vendor ──
            sendPush(
                booking.vendor, 
                'Vendor', 
                'booking_rescheduled', 
                'Booking Rescheduled', 
                `Your booking ${booking.bookingID} got rescheduled to ${date} at ${time}.`, 
                { bookingId: booking._id.toString(), bookingID: booking.bookingID }
            );
        } catch (socketErr) {
            console.error(`[SOCKET] Failed to notify vendor on reschedule: ${socketErr.message}`);
        }
    }

    return userPayload;
};

const getBookingsByUser = async (userId) => {
    const bookings = await Booking.find({ user: userId })
        .populate('services.service', 'title serviceCharge photo')
        .populate('proposedServices.service', 'title serviceCharge photo')
        .populate('userRequestedServices.service', 'title serviceCharge photo')
        .populate('vendor', 'name phoneNumber photo documents.photo.url')
        .populate('user', 'name phoneNumber photo')
        .sort({ createdAt: -1 });
    
    const formattedBookings = bookings.map(b => _formatBooking(b, 'user'));

    // Batch check for feedback to avoid N+1 queries
    const bookingIds = bookings.map(b => b._id);
    const feedbacks = await Feedback.find({ booking: { $in: bookingIds }, user: userId }).select('booking').lean();
    const feedbackBookingIds = new Set(feedbacks.map(f => f.booking.toString()));

    return formattedBookings.map(fb => {
        if (fb.actions && feedbackBookingIds.has(fb._id.toString())) {
            fb.actions.canGiveFeedback = false;
        }
        return fb;
    });
};

const getBookingsByVendor = async (vendorId) => {
    const Vendor = require('../../models/Vendor.model');
    const vendor = await Vendor.findById(vendorId).select('isVerified documentStatus');
    if (!vendor?.isVerified || vendor?.documentStatus !== 'approved') {
        return [];
    }

    const bookings = await Booking.find({ vendor: vendorId })
        .populate('services.service', 'title serviceCharge photo')
        .populate('proposedServices.service', 'title serviceCharge photo')
        .populate('userRequestedServices.service', 'title serviceCharge photo')
        .populate('user', 'name phoneNumber photo')
        .populate('vendor', 'name phoneNumber photo documents.photo.url')
        .sort({ createdAt: -1 });
    return bookings.map(b => _formatBooking(b, 'vendor'));
};

/**
 * Get completed bookings for a user
 */
const getCompletedBookingsByUser = async (userId) => {
    const bookings = await Booking.find({
        user: userId,
        status: 'completed'
    })
        .populate('services.service', 'title serviceCharge photo')
        .populate('proposedServices.service', 'title serviceCharge photo')
        .populate('userRequestedServices.service', 'title serviceCharge photo')
        .populate('vendor', 'name phoneNumber photo documents.photo.url')
        .populate('user', 'name phoneNumber photo')
        .sort({ createdAt: -1 });
    
    const formattedBookings = bookings.map(b => _formatBooking(b, 'user'));

    // Batch check for feedback
    const bookingIds = bookings.map(b => b._id);
    const feedbacks = await Feedback.find({ booking: { $in: bookingIds }, user: userId }).select('booking').lean();
    const feedbackBookingIds = new Set(feedbacks.map(f => f.booking.toString()));

    return formattedBookings.map(fb => {
        if (fb.actions && feedbackBookingIds.has(fb._id.toString())) {
            fb.actions.canGiveFeedback = false;
        }
        return fb;
    });
};

/**
 * Get cancelled bookings (Admin or User/Vendor)
 */
const getCancelledBookings = async (userId, role) => {
    let query = { status: { $in: ['cancelled', 'auto_cancelled'] } };
    
    if (role === 'vendor') {
        query.vendor = userId;
    } else if (role === 'user' || role === 'User') {
        query.user = userId;
    }

    const bookings = await Booking.find(query)
        .populate('services.service', 'title serviceCharge photo')
        .populate('vendor', 'name phoneNumber photo documents.photo.url')
        .populate('user', 'name phoneNumber photo')
        .sort({ createdAt: -1 });

    return bookings.map(b => {
        const obj = _formatBooking(b, role);
        obj.displayStatus = 'Cancelled';
        obj.cancelledBy = obj.cancellation?.cancelledBy || 'unknown';
        return obj;
    });
};

const retrySearchVendors = async (userId, bookingId) => {
    const booking = await Booking.findOne({ 
        $or: [{ _id: bookingId, user: userId }, { bookingID: bookingId, user: userId }] 
    });

    if (!booking) throw new ApiError(404, 'Booking not found');
    
    console.log(`[DEBUG] retrySearchVendors: Found Booking ${booking._id} with status ${booking.status}`);

    if (booking.status !== 'pending_acceptance') {
        throw new ApiError(400, 'Retry allowed only for pending search requests');
    }

    // Reset status and retryCount for tiered search reset
    booking.status = 'pending_acceptance';
    booking.retryCount = 0;
    booking.searchId = require('crypto').randomUUID();

    // IMPORTANT: Clear previous interactions so vendors are notified again
    booking.laterVendors = [];
    booking.rejectedVendors = [];
    
    if (booking.statusHistory) {
      booking.statusHistory.push({
        status: booking.status,
        timestamp: new Date(),
        actor: 'user',
        reason: 'User retried vendor search'
      });
    }

    await booking.save();
    console.log(`[DEBUG] retrySearchVendors: Status reset to ${booking.status}, exclusion lists cleared.`);

    const nearby = await searchVendors(booking, true);

    return {
        found: nearby.length > 0,
        count: nearby.length,
        notifiedVendorIds: nearby.map(v => v.vendorId),
        message: nearby.length > 0
            ? `Search restarted. Notified ${nearby.length} vendors.`
            : 'No vendors are currently available nearby.'
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

    const booking = await Booking.findOne(query);
    if (!booking) return [];
    
    const formatted = _formatBooking(booking, role);
    return formatted.statusHistory || [];
};

const recalculateBookingPrice = async (booking) => {
    let basePrice = (booking.services || []).reduce((sum, s) => sum + (s.finalPrice || 0), 0);

    // Add vendor proposed services
    if (booking.proposedServices && booking.proposedServices.length > 0) {
        basePrice += booking.proposedServices.reduce((sum, s) => sum + (s.finalPrice || 0), 0);
    }

    // Add user requested extra services that have been priced by vendor
    if (booking.userRequestedServices && booking.userRequestedServices.length > 0) {
        basePrice += booking.userRequestedServices
            .filter(s => s.status === 'priced' || s.status === 'accepted' || s.isPriceConfirmed)
            .reduce((sum, s) => sum + (s.finalPrice || 0), 0);
    }

    const rawGstPercent = await adminService.getSetting('pricing.booking_gst_percent');
    const gstPercent = (rawGstPercent !== undefined && rawGstPercent !== null) ? Number(rawGstPercent) : 0;
    const travelCharge = booking.pricing?.travelCharge || 0;
    const additionalCharges = booking.pricing?.additionalCharges || 0;
    
    const taxableAmount = basePrice + travelCharge + additionalCharges;
    const gstAmount = Math.round((taxableAmount * (gstPercent / 100)) * 100) / 100;
    const totalPrice = Math.round((taxableAmount + gstAmount) * 100) / 100;

    console.log(`[GST DEBUG] Booking ${booking._id} | rawGstPercent: ${rawGstPercent} (type: ${typeof rawGstPercent}) | gstPercent: ${gstPercent} | taxableAmount: ${taxableAmount} | gstAmount: ${gstAmount} | totalPrice: ${totalPrice}`);

    // Properly spread Mongoose subdocument to preserve existing fields
    const existingPricing = booking.pricing?.toObject ? booking.pricing.toObject() : (booking.pricing || {});
    booking.pricing = {
        ...existingPricing,
        basePrice,
        travelCharge,
        additionalCharges,
        gstPercent,
        gstAmount,
        totalPrice
    };
    booking.markModified('pricing');
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

    // Determine if any non‑extra services are being updated. Extra services (userRequestedServices) can be priced multiple times.
    let nonExtraUpdate = false;
    const hasPendingExtraServices = booking.userRequestedServices &&
        booking.userRequestedServices.some(s => s.status === 'pending');
    // The early guard is removed; we will enforce the once‑only rule only when a non‑extra service is updated.


    if (!['pending', 'on_the_way', 'arrived', 'ongoing'].includes(booking.status)) {
        throw new ApiError(400, 'Price can only be updated before work is completed');
    }

    console.log(`[SOCKET] Processing updated services for booking: ${bookingId}`);
    let modified = false;
    for (const update of updatedServices) {
        const updateIdStr = update.serviceId.toString();
        
        let item = booking.services.find(s => 
            s.service.toString() === updateIdStr || 
            (s._id && s._id.toString() === updateIdStr)
        );
        let isExtraService = false;

        // If not in main services, check userRequestedServices
        if (!item && booking.userRequestedServices) {
            item = booking.userRequestedServices.find(s => 
                s.service.toString() === updateIdStr || 
                (s._id && s._id.toString() === updateIdStr)
            );
            isExtraService = !!item;
        }

        if (item) {
            // Check if it was unpriced in Service model or if adminPrice is 0/null
            const serviceDoc = await Service.findById(item.service);
            const hasAdminPrice = (serviceDoc.bookingPrice !== undefined && serviceDoc.bookingPrice !== null && serviceDoc.bookingPrice > 0) || 
                                  (serviceDoc.serviceCharge !== undefined && serviceDoc.serviceCharge !== null && serviceDoc.serviceCharge > 0);
            const isUnpriced = serviceDoc && (!serviceDoc.isAdminPriced || !hasAdminPrice);
            
            if (isUnpriced || isExtraService) {
                console.log(`[SOCKET] Updating price for service: ${item.service}`);
                item.vendorPrice = update.price;
                item.finalPrice = update.price * (item.quantity || 1);
                
                if (isExtraService) {
                    item.status = 'priced';
                    booking.markModified('userRequestedServices');
                } else {
                    item.isPriceConfirmed = false;
                    booking.markModified('services');
                    nonExtraUpdate = true; // mark that a core service price was changed
                }
                
                modified = true;
            }
        }
    }

    if (!modified) {
        console.log(`[SOCKET] No unpriced services found for update: ${bookingId}`);
        throw new ApiError(400, 'No unpriced services found to update');
    }


    booking.priceUpdatedOnce = true;
    // Sync booking-level flag: false because at least one service needs re-confirmation
    booking.isPriceConfirmed = false;
    booking.statusHistory.push({
        status: 'price_proposed',
        reason: 'Vendor proposed new price for services',
        actor: 'vendor',
        timestamp: new Date()
    });
    booking.markModified('statusHistory');
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

    // ── Send Push Notification to User ──
    sendPush(booking.user, 'User', 'price_proposed', 'New Price Proposal', `Vendor has proposed a new price for booking ${booking.bookingID}.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });


    // Specific notification event
    emitToUser(booking.user, 'booking_price_proposed', userPayload);

    console.log(`[SOCKET] updateBookingPrice completed successfully for booking: ${bookingId}`);
    const updatedResults = updatedServices.map(u => ({ serviceId: u.serviceId, newPrice: u.price }));
    return { booking: userPayload, updatedServices: updatedResults, message: 'Price updated, awaiting user confirmation' };
};

/**
 * User confirms the updated price
 */
const confirmBookingPrice = async (userId, bookingId, serviceIds = []) => {
    const booking = await Booking.findOne({ _id: bookingId, user: userId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    // Normalize serviceIds to strings for comparison
    const targetIds = (serviceIds || []).map(id => id.toString()).filter(Boolean);
    const hasTargetIds = targetIds.length > 0;

    const isTargetService = (serviceId) => {
        if (!hasTargetIds) return true;
        return targetIds.includes(serviceId.toString());
    };

    // Confirm matching main services
    let confirmedMainCount = 0;
    booking.services.forEach(s => {
        if (!s.isPriceConfirmed && isTargetService(s.service)) {
            s.isPriceConfirmed = true;
            confirmedMainCount++;
        }
    });

    // Confirm matching user-requested extra services that were priced
    let confirmedExtraCount = 0;
    if (booking.userRequestedServices && booking.userRequestedServices.length > 0) {
        booking.userRequestedServices.forEach(s => {
            if (s.status === 'priced' && !s.isPriceConfirmed && isTargetService(s.service)) {
                s.isPriceConfirmed = true;
                s.status = 'accepted';
                confirmedExtraCount++;
            }
        });
        booking.markModified('userRequestedServices');
    }

    if (hasTargetIds && confirmedMainCount === 0 && confirmedExtraCount === 0) {
        throw new ApiError(400, 'No matching unconfirmed services found for the given service IDs');
    }

    // Sync booking-level flag: true if all remaining services are confirmed
    const remainingAllConfirmed = (booking.services || []).length > 0
        ? (booking.services || []).every(s => s.isPriceConfirmed)
        : true;
    booking.isPriceConfirmed = remainingAllConfirmed;

    // Recalculate total price now that it's confirmed
    await recalculateBookingPrice(booking);

    // Log confirmation
    booking.statusHistory.push({
        status: 'price_confirmed',
        reason: hasTargetIds
            ? `Price confirmed by user for ${confirmedMainCount} service(s) and ${confirmedExtraCount} extra service(s)`
            : 'Price confirmed by user',
        actor: 'user',
        timestamp: new Date()
    });
    booking.markModified('statusHistory');
    booking.markModified('services');

    await booking.save();

    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
    const userPayload = await getBookingDetails(booking._id, userId, 'user');

    const { emitToVendor, emitToUser } = require('../../socket');

    // Notify both for state sync
    emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
    emitToUser(userId, 'booking_status_updated', userPayload);

    // ── Send Push Notification to Vendor ──
    sendPush(booking.vendor, 'Vendor', 'price_confirmed', 'Price Confirmed', `User has confirmed the proposed price for booking ${booking.bookingID}.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });

    // Specific notification event with confirmed service IDs
    emitToVendor(booking.vendor, 'booking_price_confirmed', {
        ...vendorPayload,
        confirmedServiceIds: targetIds,
        confirmedMainCount,
        confirmedExtraCount
    });

    return { booking: userPayload, message: 'Price confirmed successfully', confirmedServiceIds: targetIds };
};

/**
 * User rejects the updated price
 */
const rejectBookingPrice = async (userId, bookingId, reason, serviceIds = []) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    // Normalize serviceIds to strings for comparison
    const targetIds = (serviceIds || []).map(id => id.toString()).filter(Boolean);
    const hasTargetIds = targetIds.length > 0;

    const isTargetService = (serviceId) => {
        if (!hasTargetIds) return true;
        return targetIds.includes(serviceId.toString());
    };

    // Derive from per-service flags: if ALL services already have isPriceConfirmed=true,
    // there is nothing left to reject.
    const alreadyAllConfirmed = (booking.services || []).length > 0
        ? (booking.services || []).every(s => s.isPriceConfirmed)
        : !!booking.isPriceConfirmed;

    if (alreadyAllConfirmed) {
        throw new ApiError(400, 'Cannot reject price — all service prices are already confirmed');
    }

    // Identify unconfirmed services in main services array that match targetIds
    const unconfirmedServices = booking.services.filter(s => !s.isPriceConfirmed && isTargetService(s.service));
    
    // Identify unconfirmed extra services (those priced by vendor but not yet accepted by user)
    const unconfirmedExtraServices = (booking.userRequestedServices || []).filter(
        s => s.status === 'priced' && !s.isPriceConfirmed && isTargetService(s.service)
    );

    if (unconfirmedServices.length === 0 && unconfirmedExtraServices.length === 0) {
        throw new ApiError(400, 'No unconfirmed prices found to reject');
    }

    const now = new Date();
    
    // Move unconfirmed main services to rejectedServices
    unconfirmedServices.forEach(s => {
        booking.rejectedServices.push({
            service: s.service,
            quantity: s.quantity,
            adminPrice: s.adminPrice,
            vendorPrice: s.vendorPrice,
            finalPrice: s.finalPrice,
            rejectedBy: 'user',
            rejectionType: 'proposed_price',
            reason: reason || 'Price rejected by user',
            rejectedAt: now
        });
    });

    // Move unconfirmed extra services to rejectedServices
    unconfirmedExtraServices.forEach(s => {
        booking.rejectedServices.push({
            service: s.service,
            quantity: s.quantity,
            adminPrice: s.adminPrice,
            vendorPrice: s.vendorPrice,
            finalPrice: s.finalPrice,
            rejectedBy: 'user',
            rejectionType: 'extra_service',
            reason: reason || 'Extra service price rejected by user',
            rejectedAt: now
        });
    });

    // Remove rejected services from both arrays (only remove matching targetIds if specified)
    if (hasTargetIds) {
        // When specific IDs are given, only remove those that were rejected
        const rejectedIds = new Set([...unconfirmedServices.map(s => s.service.toString()), ...unconfirmedExtraServices.map(s => s.service.toString())]);
        booking.services = booking.services.filter(s => !rejectedIds.has(s.service.toString()) || s.isPriceConfirmed);
        if (booking.userRequestedServices) {
            booking.userRequestedServices = booking.userRequestedServices.filter(
                s => !rejectedIds.has(s.service.toString()) || !(s.status === 'priced' && !s.isPriceConfirmed)
            );
        }
    } else {
        // Original behavior: remove all unconfirmed
        booking.services = booking.services.filter(s => s.isPriceConfirmed);
        if (booking.userRequestedServices) {
            booking.userRequestedServices = booking.userRequestedServices.filter(
                s => !(s.status === 'priced' && !s.isPriceConfirmed)
            );
        }
    }

    // If no main services left, the booking should be cancelled
    if (booking.services.length === 0) {
        booking.status = 'cancelled';
        booking.cancellation = {
            cancelledBy: 'user',
            reason: reason || 'Booking cancelled because user rejected proposed prices and no services remain.',
            cancelledAt: now,
            travelChargeApplied: false
        };
    }
    
    // Sync booking-level flag: true if all remaining services are confirmed
    const remainingAllConfirmed = (booking.services || []).length > 0
        ? (booking.services || []).every(s => s.isPriceConfirmed)
        : true;
    booking.isPriceConfirmed = remainingAllConfirmed;
    booking.statusHistory.push({ 
        status: booking.status, 
        actor: 'user',
        reason: reason || (booking.status === 'cancelled' ? 'Booking cancelled - all prices rejected' : 'Price rejected by user for specific services'),
        timestamp: now 
    });
    
    booking.markModified('statusHistory');
    booking.markModified('services');
    booking.markModified('userRequestedServices');
    booking.markModified('rejectedServices');

    await recalculateBookingPrice(booking);
    await booking.save();

    const populatedBooking = await getBookingDetails(booking._id, userId, 'user');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(userId, 'booking_status_updated', populatedBooking);
    if (booking.vendor) {
        emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
        
        // ── Send Push Notification to Vendor ──
        sendPush(booking.vendor, 'Vendor', 'price_rejected', 'Price Rejected', `User has rejected the proposed price for booking ${booking.bookingID}.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });

        emitToVendor(booking.vendor, 'booking_price_rejected', {
            bookingId: booking._id,
            reason: reason || 'Price rejected by user',
            rejectedServiceIds: targetIds,
            message: booking.status === 'cancelled' 
                ? 'User rejected the price and the booking was cancelled.'
                : 'User rejected the proposed price for some services.'
        });
    }

    return { 
        booking: populatedBooking,
        rejectedServiceIds: targetIds,
        message: booking.status === 'cancelled'
            ? 'Price rejected. Booking cancelled as no services remain.'
            : 'Price rejected for selected services. Booking remains active.' 
    };
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
    booking.statusHistory.push({ status: 'cancelled', actor: 'system', reason: 'Vendor no-show — service provider did not arrive', timestamp: now });
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

    if (['completed', 'cancelled', 'auto_cancelled'].includes(booking.status)) {
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
    booking.statusHistory.push({ status: 'cancelled', actor: 'user', reason: 'Cancelled after grace period — vendor did not arrive in time', timestamp: now });
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
        throw new ApiError(400, 'Additional services can only be added after a lead is accepted');
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
        const adminPrice = (serviceDoc.bookingPrice !== undefined && serviceDoc.bookingPrice !== null && serviceDoc.bookingPrice > 0)
            ? serviceDoc.bookingPrice
            : (serviceDoc.serviceCharge || null);
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

    await recalculateBookingPrice(booking);
    booking.markModified('proposedServices');
    await booking.save();

    // Populate proposed services for the notification payload
    const populatedBooking = await Booking.findById(booking._id)
        .populate('proposedServices.service', 'title photo serviceCharge');

    const { emitToUser, emitToVendor } = require('../../socket');
    const userPayload = await getBookingDetails(booking._id, booking.user, 'user');
    const vendorPayload = await getBookingDetails(booking._id, vendorId, 'vendor');

    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    // ── Send Push Notification to User ──
    sendPush(booking.user, 'User', 'services_proposed', 'New Services Proposed', `Vendor has proposed additional services for booking ${booking.bookingID}.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });


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
    await recalculateBookingPrice(booking);

    // Clear proposed
    booking.proposedServices = [];
    booking.isPriceConfirmed = true;

    booking.markModified('services');
    booking.markModified('proposedServices');
    await booking.save();

    const { emitToVendor, emitToUser } = require('../../socket');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
    const userPayload = await getBookingDetails(booking._id, userId, 'user');

    emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
    emitToUser(userId, 'booking_status_updated', userPayload);

    // ── Send Push Notification to Vendor ──
    sendPush(booking.vendor, 'Vendor', 'services_confirmed', 'Services Confirmed', `User has confirmed the proposed additional services for booking ${booking.bookingID}.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });


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
        status: booking.status,
        actor: 'user',
        reason: reason || 'User rejected the additional services.',
        timestamp: new Date()
    });
    booking.markModified('statusHistory');

    await recalculateBookingPrice(booking);
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
 * User requests additional services for an existing booking
 */



/**
 * User requests additional services for an existing booking
 */
async function requestExtraServices(userId, bookingId, newServices) {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');
    if (!booking.vendor) throw new ApiError(400, 'Vendor not assigned yet');

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

    const vendor = await Vendor.findById(booking.vendor)
        .select('selectedServices categorySubscriptions')
        .lean();
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const allowedServiceIds = new Set([
        ...((vendor.selectedServices || []).map(id => id.toString())),
        ...((vendor.categorySubscriptions || [])
            .filter(sub => {
                const subExp = sub.expiryDate ? new Date(sub.expiryDate) : null;
                const isSubActive = subExp ? subExp > new Date() : false;
                return isSubActive && sub.status === 'ACTIVE';
            })
            .flatMap(sub => sub.services || [])
            .map(id => id.toString()))
    ]);

    for (const item of newServices) {
        if (!item?.serviceId) throw new ApiError(400, 'serviceId is required for each service');
        const requestedServiceId = item.serviceId.toString();
        if (!allowedServiceIds.has(requestedServiceId)) {
            throw new ApiError(400, `Service ${requestedServiceId} is not available for this vendor`);
        }

        const serviceDoc = await Service.findById(item.serviceId);
        if (!serviceDoc) {
            throw new ApiError(404, `Service ${item.serviceId} not found`);
        }
        const qty = item.quantity || 1;

            // Check if this service was previously requested and price‑confirmed in userRequestedServices
            const existingExtra = booking.userRequestedServices?.find(
                s => s.service.toString() === requestedServiceId && s.isPriceConfirmed === true
            );

            let adminPrice, vendorPrice, finalPrice, isPriceConfirmed, status;

            if (existingExtra) {
                // Reuse the previously confirmed extra service pricing
                adminPrice   = existingExtra.adminPrice || 0;
                vendorPrice  = existingExtra.vendorPrice || 0;
                finalPrice   = existingExtra.finalPrice;
                isPriceConfirmed = true;
                status = 'accepted';
            } else {
                // ── Check if this service was already price‑confirmed in the main services list ──
                const approvedEntry = booking.services.find(
                    s => s.service.toString() === requestedServiceId && s.isPriceConfirmed === true
                );

                if (approvedEntry) {
                    // Reuse the per‑unit price from the already‑confirmed service entry
                    const approvedUnitPrice = approvedEntry.quantity > 0
                        ? approvedEntry.finalPrice / approvedEntry.quantity
                        : approvedEntry.finalPrice;

                    adminPrice   = approvedEntry.adminPrice || 0;
                    vendorPrice  = approvedEntry.vendorPrice || 0;
                    finalPrice   = approvedUnitPrice * qty;
                    isPriceConfirmed = true;
                    status = 'accepted';
                } else {
                    adminPrice  = (serviceDoc.bookingPrice !== undefined && serviceDoc.bookingPrice !== null && serviceDoc.bookingPrice > 0)
                        ? serviceDoc.bookingPrice
                        : (serviceDoc.serviceCharge || 0);
                    vendorPrice = adminPrice > 0 ? 0 : (item.price || 0);
                    finalPrice  = adminPrice > 0
                        ? adminPrice * qty
                        : (vendorPrice > 0 ? vendorPrice * qty : 0);
                    isPriceConfirmed = false;
                    status = 'pending';
                }
            }

        booking.userRequestedServices.push({
            service: serviceDoc._id,
            quantity: qty,
            adminPrice,
            vendorPrice,
            finalPrice,
            isPriceConfirmed,
            status
        });
    }

    // ── Recalculate price to include any auto-approved services ──
    await recalculateBookingPrice(booking);

    // Split newly added entries into auto-approved vs still-pending
    const addedEntries = booking.userRequestedServices.slice(-newServices.length);
    const autoApprovedCount = addedEntries.filter(s => s.isPriceConfirmed === true).length;
    const pendingCount      = addedEntries.filter(s => s.status === 'pending').length;

    booking.statusHistory.push({
        status: 'extra_services_requested',
        reason: 'User requested additional services',
        actor: 'user',
        timestamp: new Date()
    });
    booking.markModified('statusHistory');
    booking.markModified('userRequestedServices');

    await booking.save();

    // Populate for notification
    const populatedBooking = await Booking.findById(booking._id)
        .populate('userRequestedServices.service', 'title');

    // Notify both sides for state sync
    const { emitToVendor, emitToUser } = require('../../socket');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');
    const userPayload   = await getBookingDetails(booking._id, userId, 'user');

    emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
    emitToUser(userId, 'booking_status_updated', userPayload);

    // Only notify vendor if there are services that still need their pricing/acceptance
    const newlyRequestedServices = populatedBooking.userRequestedServices.slice(-newServices.length);
    const pendingForVendor = newlyRequestedServices.filter(s => s.status === 'pending');

    if (pendingForVendor.length > 0) {
        // ── Send Push Notification to Vendor ──
        sendPush(booking.vendor, 'Vendor', 'extra_services_requested', 'Extra Services Requested', `User has requested additional services for booking ${booking.bookingID}.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });

        emitToVendor(booking.vendor, 'extra_services_requested_by_user', {
            bookingId: booking._id,
            bookingID: booking.bookingID,
            requestedServices: pendingForVendor,
            message: 'User has requested additional services. Please confirm and set prices.'
        });
    }

    const message = autoApprovedCount > 0 && pendingCount === 0
        ? 'Extra services added at previously approved price. No additional confirmation needed.'
        : autoApprovedCount > 0
            ? 'Some extra services were auto-approved at previously confirmed prices. Others are awaiting vendor confirmation.'
            : 'Extra services requested. Awaiting vendor confirmation.';

    return {
        booking: populatedBooking,
        message
    };
}

async function getVendorSelectableServicesForBooking(userId, bookingId) {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');
    if (!booking.vendor) throw new ApiError(400, 'Vendor not assigned yet');

    const allowedStatuses = ['pending', 'on_the_way', 'arrived', 'ongoing'];
    if (!allowedStatuses.includes(booking.status)) {
        throw new ApiError(400, 'Vendor service selection is available only for active bookings');
    }

    const vendor = await Vendor.findById(booking.vendor)
        .select('selectedServices categorySubscriptions')
        .lean();
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    const allowedServiceIds = Array.from(new Set([
        ...((vendor.selectedServices || []).map(id => id.toString())),
        ...((vendor.categorySubscriptions || [])
            .filter(sub => {
                const subExp = sub.expiryDate ? new Date(sub.expiryDate) : null;
                const isSubActive = subExp ? subExp > new Date() : false;
                return isSubActive && sub.status === 'ACTIVE';
            })
            .flatMap(sub => sub.services || [])
            .map(id => id.toString()))
    ]));

    const services = await Service.find({
        _id: { $in: allowedServiceIds },
        isActive: true
    })
        .populate('category', 'name')
        .populate('subcategory', 'name')
        .populate('serviceType', 'name')
        .select('title photo serviceCharge bookingPrice category subcategory serviceType quantityEnabled priceAdjustmentEnabled approxCompletionTime')
        .lean();

    return {
        bookingId: booking._id,
        bookingID: booking.bookingID,
        vendorId: booking.vendor,
        services: services.map(service => {
            const bookingCharge = (service.bookingPrice !== undefined && service.bookingPrice !== null && service.bookingPrice > 0)
                ? Number(service.bookingPrice)
                : Number(service.serviceCharge || 0);
            return {
                serviceId: service._id,
                serviceName: service.title,
                serviceImage: service.photo || null,
                categoryId: service.category?._id || null,
                categoryName: service.category?.name || null,
                subcategoryId: service.subcategory?._id || null,
                subcategoryName: service.subcategory?.name || null,
                typeId: service.serviceType?._id || null,
                typeName: service.serviceType?.name || null,
                bookingCharge,
                quantityEnabled: Boolean(service.quantityEnabled),
                priceAdjustmentEnabled: Boolean(service.priceAdjustmentEnabled),
                approxCompletionTime: service.approxCompletionTime || null
            };
        })
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
        const itemIdStr = item.serviceId.toString();
        // Find matching service in userRequestedServices (check both service ID and requested item _id)
        const requestItem = booking.userRequestedServices.find(
            s => s.service.toString() === itemIdStr || (s._id && s._id.toString() === itemIdStr)
        );

        if (!requestItem) continue;

        // If the extra service price is already confirmed by the user, skip any changes
        if (requestItem.isPriceConfirmed) {
            // keep existing price and status as accepted
            continue;
        }

        const serviceDoc = await Service.findById(item.serviceId);
        if (!serviceDoc) continue;

        const qty = requestItem.quantity || 1;
        const adminPrice = (serviceDoc.bookingPrice !== undefined && serviceDoc.bookingPrice !== null && serviceDoc.bookingPrice > 0)
            ? serviceDoc.bookingPrice
            : (serviceDoc.serviceCharge || 0);
        const vendorPrice = adminPrice > 0 ? 0 : (item.price || 0);

        requestItem.adminPrice = adminPrice;
        requestItem.vendorPrice = vendorPrice;
        requestItem.finalPrice = adminPrice > 0
            ? adminPrice * qty
            : (vendorPrice > 0 ? vendorPrice * qty : 0);
        requestItem.isPriceConfirmed = false; // Still needs user approval
        requestItem.status = 'priced';

        isUpdated = true;
    }

    if (!isUpdated) {
        throw new ApiError(400, 'None of the provided services matched the user requests');
    }

    await recalculateBookingPrice(booking);
    booking.statusHistory.push({
        status: 'extra_services_priced',
        reason: 'Vendor priced the requested extra services',
        actor: 'vendor',
        timestamp: new Date()
    });
    booking.markModified('statusHistory');
    booking.markModified('userRequestedServices');
    await booking.save();

    const populatedBooking = await Booking.findById(booking._id)
        .populate('userRequestedServices.service', 'title photo serviceCharge');

    const { emitToUser, emitToVendor } = require('../../socket');
    const userPayload = await getBookingDetails(booking._id, booking.user, 'user');
    const vendorPayload = await getBookingDetails(booking._id, vendorId, 'vendor');

    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    // ── Send Push Notification to User ──
    sendPush(booking.user, 'User', 'extra_services_priced', 'Extra Services Priced', `Vendor has set prices for your extra service requests in booking ${booking.bookingID}.`, { bookingId: booking._id.toString(), bookingID: booking.bookingID });


    // Generic event for legacy/general use
    emitToUser(booking.user, 'extra_services_priced_by_vendor', {
        bookingId: booking._id,
        bookingID: booking.bookingID,
        requestedServices: populatedBooking.userRequestedServices,
        message: 'Vendor has set prices for your extra services.'
    });

    // Specific event to user: vendor has accepted and priced their extra service requests
    const acceptedServiceIds = confirmedServices.map(s => s.serviceId.toString());
    emitToUser(booking.user, 'extra_services_accepted_by_vendor', {
        bookingId: booking._id,
        bookingID: booking.bookingID,
        requestedServices: populatedBooking.userRequestedServices,
        acceptedServiceIds: acceptedServiceIds,
        message: 'Your vendor has accepted the extra services request.'
    });

    return {
        booking: populatedBooking,
        message: 'Prices set for extra services. Awaiting user approval.'
    };
}

/**
 * Vendor simply accepts all pending user-requested extra services (no price override needed)
 * This is the simple "Accept" button flow — vendor agrees to do the services at existing prices.
 */
async function vendorAcceptExtraServices(vendorId, bookingId, acceptedServiceIds) {
    console.log(`[SERVICE] vendorAcceptExtraServices called - vendorId: ${vendorId}, bookingId: ${bookingId}, acceptedServiceIds: ${JSON.stringify(acceptedServiceIds)}`);
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) {
        console.error(`[SERVICE] vendorAcceptExtraServices ERROR: Booking not found for bookingId: ${bookingId}, vendorId: ${vendorId}`);
        throw new ApiError(404, 'Booking not found');
    }
    console.log(`[SERVICE] vendorAcceptExtraServices: Booking found, userRequestedServices length: ${booking.userRequestedServices?.length}`);

    if (!booking.userRequestedServices || booking.userRequestedServices.length === 0) {
        throw new ApiError(400, 'No pending user service requests to accept');
    }

    const acceptIds = acceptedServiceIds && acceptedServiceIds.length > 0 
        ? acceptedServiceIds.map(id => {
            if (id && typeof id === 'object') {
                return (id.serviceId || id.id || id._id || id).toString();
            }
            return id.toString();
        }) 
        : null;

    // Mark pending services as accepted and set pricing
    let anyAccepted = false;
    for (const item of booking.userRequestedServices) {
        const sid = (item.service && (item.service._id || item.service)).toString();
        if (!acceptIds || acceptIds.includes(sid)) {
            if (item.status === 'pending' || !item.status) {
                item.status = 'accepted';
                anyAccepted = true;

                // Set pricing if not already populated
                if (!item.finalPrice || item.finalPrice === 0) {
                    const serviceDoc = await Service.findById(sid).select('bookingPrice serviceCharge');
                    if (serviceDoc) {
                        const qty = item.quantity || 1;
                        const adminPrice = (serviceDoc.bookingPrice !== undefined && serviceDoc.bookingPrice !== null && serviceDoc.bookingPrice > 0)
                            ? serviceDoc.bookingPrice
                            : (serviceDoc.serviceCharge || 0);
                        const vendorPrice = adminPrice > 0 ? 0 : 0;

                        item.adminPrice = adminPrice;
                        item.vendorPrice = vendorPrice;
                        item.finalPrice = adminPrice > 0
                            ? adminPrice * qty
                            : (vendorPrice > 0 ? vendorPrice * qty : 0);
                    }
                }
            } else if (item.status === 'accepted') {
                // If already accepted, treat it as a successful match to prevent throwing errors
                anyAccepted = true;
            }
        }
    }

    if (!anyAccepted) {
        throw new ApiError(400, 'No pending or accepted services found matching the provided IDs');
    }

    booking.markModified('userRequestedServices');
    
    // Recalculate total price to include newly accepted services
    await recalculateBookingPrice(booking);

    booking.statusHistory.push({
        status: 'extra_services_accepted',
        reason: 'Vendor accepted the requested extra services',
        actor: 'vendor',
        timestamp: new Date()
    });
    booking.markModified('statusHistory');
    
    await booking.save();

    const populatedBooking = await Booking.findById(booking._id)
        .populate('userRequestedServices.service', 'title photo serviceCharge');

    const { emitToUser, emitToVendor } = require('../../socket');
    const userPayload = await getBookingDetails(booking._id, booking.user, 'user');
    const vendorPayload = await getBookingDetails(booking._id, vendorId, 'vendor');

    // Notify both for state sync
    emitToUser(booking.user, 'booking_status_updated', userPayload);
    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);

    // Specific event to user: vendor accepted their extra service requests
    emitToUser(booking.user, 'extra_services_accepted_by_vendor', {
        bookingId: booking._id,
        bookingID: booking.bookingID,
        requestedServices: populatedBooking.userRequestedServices,
        message: 'Vendor has accepted your extra service requests.'
    });

    return {
        booking: vendorPayload,
        message: 'Extra service requests accepted.'
    };
}

/**
 * Vendor rejects the user's extra service requests
 */
async function vendorRejectExtraServices(vendorId, bookingId, rejectedServiceIds, reason) {

    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) {
        console.error(`[SERVICE] vendorRejectExtraServices ERROR: Booking not found for bookingId: ${bookingId}, vendorId: ${vendorId}`);
        throw new ApiError(404, 'Booking not found');
    }
    console.log(`[SERVICE] vendorRejectExtraServices: Booking found, userRequestedServices length: ${booking.userRequestedServices?.length}`);

    if (!booking.userRequestedServices || booking.userRequestedServices.length === 0) {
        throw new ApiError(400, 'No pending user service requests to reject');
    }

    const now = new Date();
    const rejectIds = rejectedServiceIds && rejectedServiceIds.length > 0 ? rejectedServiceIds.map(id => id.toString()) : null;

    // Identify items to reject before filtering them out
    const toReject = [];
    const remaining = [];
    for (const item of booking.userRequestedServices) {
        const sid = item.service.toString();
        const shouldReject = (item.status === 'pending' || item.status === 'priced') && (!rejectIds || rejectIds.includes(sid));
        if (shouldReject) {
            toReject.push(item);
        } else {
            remaining.push(item);
        }
    }

    if (toReject.length === 0) {
        throw new ApiError(400, 'Could not reject any services. Ensure valid service IDs were provided.');
    }

    const actualRejectedIds = [];
    for (const item of toReject) {
        const sid = item.service.toString();
        booking.rejectedServices.push({
            service: item.service,
            quantity: item.quantity,
            adminPrice: item.adminPrice,
            vendorPrice: item.vendorPrice,
            finalPrice: item.finalPrice,
            rejectedBy: 'vendor',
            rejectionType: 'extra_service',
            reason: reason || 'Vendor declined the requested extra services.',
            rejectedAt: now
        });
        actualRejectedIds.push(sid);
    }

    // Replace userRequestedServices with only the remaining items
    booking.userRequestedServices = remaining;

    // Log rejection in history
    booking.statusHistory.push({
        status: 'extra_services_rejected',
        actor: 'vendor',
        reason: reason || 'Vendor declined to perform the requested extra services.',
        timestamp: now
    });
    booking.markModified('statusHistory');
    booking.markModified('rejectedServices');
    booking.markModified('userRequestedServices');

    await booking.save();

    const { emitToUser, emitToVendor } = require('../../socket');

    // Populate service details for socket payload
    await booking.populate('rejectedServices.service');
    const rejectedServicesList = booking.rejectedServices
        .filter(item => actualRejectedIds.includes((item.service?._id || item.service)?.toString()))
        .map(item => {
            const itemObj = item.toObject ? item.toObject() : item;
            return {
                ...itemObj,
                isExtra: true
            };
        });

    const vendorPayload = await getBookingDetails(booking._id, vendorId, 'vendor');
    const userPayload = await getBookingDetails(booking._id, booking.user, 'user');

    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);
    emitToUser(booking.user, 'booking_status_updated', userPayload);

    // Specific event to user
    emitToUser(booking.user, 'extra_services_rejected_by_vendor', {
        bookingId: booking._id,
        reason: reason || 'Vendor declined the extra services.',
        message: 'Vendor has rejected your request for additional services.',
        rejectedServices: rejectedServicesList,
        rejectedServiceIds: actualRejectedIds
    });

    // Specific success/info event requested by user to trigger UI feedback
    emitToUser(booking.user, 'booking_services_rejected_success', {
        bookingId: booking._id,
        reason: reason || 'Vendor declined the extra services.',
        message: 'Special service request was rejected by the vendor.',
        rejectedServiceIds: actualRejectedIds
    });

    return {
        booking: vendorPayload,
        message: 'Extra service requests rejected.'
    };
}

/**
 * User confirms the priced extra services from the vendor
 */
async function userConfirmExtraServices(userId, bookingId, acceptedServiceIds) {
    console.log(`[SERVICE] userConfirmExtraServices called - userId: ${userId}, bookingId: ${bookingId}, acceptedServiceIds: ${JSON.stringify(acceptedServiceIds)}`);
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) {
        console.error(`[SERVICE] userConfirmExtraServices ERROR: Booking not found for bookingId: ${bookingId}, userId: ${userId}`);
        throw new ApiError(404, 'Booking not found');
    }
    console.log(`[SERVICE] userConfirmExtraServices: Booking found, userRequestedServices length: ${booking.userRequestedServices?.length}`);

    if (!booking.userRequestedServices || booking.userRequestedServices.length === 0) {
        throw new ApiError(400, 'No pending extra service requests to confirm');
    }

    const now = new Date();
    let hasConfirmed = false;
    const acceptedIds = acceptedServiceIds 
        ? acceptedServiceIds.map(id => {
            if (id && typeof id === 'object') {
                return (id.serviceId || id.id || id._id || id).toString();
            }
            return id.toString();
        }) 
        : [];

    booking.userRequestedServices.forEach(item => {
        const sid = (item.service && (item.service._id || item.service)).toString();
        if (acceptedIds.includes(sid)) {
            if (item.status === 'priced') {
                item.status = 'accepted';
                item.isPriceConfirmed = true;
                hasConfirmed = true;
            } else if (item.status === 'accepted') {
                // If already accepted, treat it as a successful match to prevent throwing errors
                hasConfirmed = true;
            }
        }
    });

    if (!hasConfirmed) {
        throw new ApiError(400, 'No priced extra services matched the provided IDs');
    }

    await recalculateBookingPrice(booking);
    booking.statusHistory.push({
        status: 'extra_services_accepted',
        actor: 'user',
        reason: 'User accepted the proposed price for extra services',
        timestamp: now
    });
    booking.markModified('statusHistory');
    booking.markModified('userRequestedServices');

    await booking.save();

    const { emitToUser, emitToVendor } = require('../../socket');
    const userPayload = await getBookingDetails(booking._id, userId, 'user');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');

    emitToUser(userId, 'booking_status_updated', userPayload);
    if (booking.vendor) {
        emitToVendor(booking.vendor, 'extra_services_accepted_by_user', {
            bookingId: booking._id,
            bookingID: booking.bookingID,
            message: 'User has accepted your price proposal for extra services.',
            booking: vendorPayload
        });
    }

    return {
        booking: userPayload,
        message: 'Extra services confirmed successfully.'
    };
}

/**
 * User rejects the priced extra service requests
 */
async function userRejectExtraServices(userId, bookingId, rejectedServiceIds, reason) {
    console.log(`[SERVICE] userRejectExtraServices called - userId: ${userId}, bookingId: ${bookingId}, rejectedServiceIds: ${JSON.stringify(rejectedServiceIds)}, reason: ${reason}`);
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) {
        console.error(`[SERVICE] userRejectExtraServices ERROR: Booking not found for bookingId: ${bookingId}, userId: ${userId}`);
        throw new ApiError(404, 'Booking not found');
    }
    console.log(`[SERVICE] userRejectExtraServices: Booking found, userRequestedServices length: ${booking.userRequestedServices?.length}`);

    if (!booking.userRequestedServices || booking.userRequestedServices.length === 0) {
        throw new ApiError(400, 'No pending extra service requests to reject');
    }

    const now = new Date();
    let hasRejected = false;
    const rejectIds = rejectedServiceIds ? rejectedServiceIds.map(id => id.toString()) : [];

    booking.userRequestedServices.forEach(item => {
        const sid = item.service.toString();
        if (item.status === 'priced' && (rejectIds.length === 0 || rejectIds.includes(sid))) {
            booking.rejectedServices.push({
                service: item.service,
                quantity: item.quantity,
                adminPrice: item.adminPrice,
                vendorPrice: item.vendorPrice,
                finalPrice: item.finalPrice,
                rejectedBy: 'user',
                rejectionType: 'extra_service',
                reason: reason || 'User declined the proposed price.',
                rejectedAt: now
            });
            item.status = 'rejected';
            hasRejected = true;
        }
    });

    if (!hasRejected) {
        throw new ApiError(400, 'No priced extra services matched the provided IDs');
    }

    booking.statusHistory.push({
        status: 'extra_services_rejected',
        actor: 'user',
        reason: reason || 'User declined the proposed price for extra services',
        timestamp: now
    });
    booking.markModified('statusHistory');
    booking.markModified('rejectedServices');
    booking.markModified('userRequestedServices');

    await booking.save();

    const { emitToUser, emitToVendor } = require('../../socket');
    const userPayload = await getBookingDetails(booking._id, userId, 'user');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');

    emitToUser(userId, 'booking_status_updated', userPayload);
    if (booking.vendor) {
        emitToVendor(booking.vendor, 'extra_services_rejected_by_user', {
            bookingId: booking._id,
            bookingID: booking.bookingID,
            reason: reason || 'User declined the proposed price.',
            message: 'User has rejected your price proposal for extra services.',
            booking: vendorPayload
        });
    }

    return {
        booking: userPayload,
        message: 'Extra services rejected.'
    };
}

/**
 * Check if a vendor should be actively tracking (for discovery/notifications OR active bookings)
 */
const shouldTrackVendor = async (vendorId) => {
    // If vendor is online, we MUST track so they are discoverable for new lead notifications
    const vendor = await Vendor.findById(vendorId).select('isOnline');
    if (vendor?.isOnline) return true;

    // If there is an active booking process, we MUST track for progress updates
    const count = await Booking.countDocuments({
        vendor: vendorId,
        status: { $in: ['on_the_way', 'arrived', 'ongoing'] }
    });
    return count > 0;
};

/**
 * Broadcast vendor live location to users with active bookings
 */
const broadcastVendorLocation = async (vendorId, lat, lng) => {
    const activeBookings = await Booking.find({
        vendor: vendorId,
        status: { $in: ['on_the_way', 'arrived', 'ongoing'] }
    }).select('_id bookingID user status');

    if (!activeBookings.length) return;

    const { emitToUser } = require('../../socket');
    
    activeBookings.forEach(booking => {
        emitToUser(booking.user, 'vendor_location_update', {
            bookingId: booking._id,
            bookingID: booking.bookingID,
            vendorId: vendorId,
            status: booking.status,
            location: { lat, lng },
            updatedAt: new Date()
        });
    });
};

/**
 * Automatically resend active booking requests to a newly registered vendor socket.
 * Typically triggered when a vendor connects/reconnects.
 */
const resendActiveRequestsToVendor = async (vendorId) => {
    try {
        const vIdStr = vendorId.toString();
        // Find all bookings that are in 'pending_acceptance' status,
        // where this vendor is in the 'notifiedVendors' array,
        // and NOT in 'rejectedVendors' or 'laterVendors' arrays
        const activeBookings = await Booking.find({
            status: 'pending_acceptance',
            notifiedVendors: vIdStr,
            rejectedVendors: { $ne: vIdStr },
            laterVendors: { $ne: vIdStr }
        })
        .populate('services.service', 'title serviceCharge photo approxCompletionTime')
        .populate('category', 'title name')
        .populate('user', 'name phoneNumber photo');

        if (!activeBookings.length) return;

        const { emitToVendor } = require('../../socket');

        // Fetch settings for dynamic radius wave display
        const [r1_km, r2_km, r3_km] = await Promise.all([
            adminService.getSetting('notifications.radius_row1_km'),
            adminService.getSetting('notifications.radius_row2_km'),
            adminService.getSetting('notifications.radius_row3_km')
        ]);
        const radii = [r1_km || 2, r2_km || 5, r3_km || 10];

        for (const booking of activeBookings) {
            let totalDurationMins = 0;
            if (booking.services && booking.services.length > 0) {
                booking.services.forEach(item => {
                    totalDurationMins += (item.service?.approxCompletionTime || 0) * (item.quantity || 1);
                });
            }

            const retryCount = booking.retryCount || 0;
            const radiusInKm = radii[Math.min(retryCount, radii.length - 1)];

            const payload = {
                ...(booking.toObject()),
                bookingID: booking.bookingID,
                totalDurationMins,
                radius: radiusInKm
            };

            // ── Sensitive Data Redaction for unaccepted requests ──
            if (payload.user) {
                payload.user.phoneNumber = '••••••••••';
                if (payload.user.email) payload.user.email = '••••••••••';
            }
            if (payload.location) {
                payload.location.address = 'Location visible after acceptance';
            }
            if (payload.user && payload.location) {
                emitToVendor(vIdStr, 'new_booking_request', payload);
            }
        }
    } catch (error) {
        console.error('[RESEND ACTIVE REQUESTS ERROR]', error);
    }
};

const triggerBroadcast = async (bookingId) => {
    const booking = await Booking.findOne({
        $or: [{ _id: bookingId }, { bookingID: bookingId }]
    });

    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'pending_acceptance') {
        throw new ApiError(400, 'Broadcast allowed only for pending bookings');
    }

    // Reset search state
    booking.retryCount = 0;
    booking.searchId = require('crypto').randomUUID();
    booking.laterVendors = [];
    booking.rejectedVendors = [];

    await booking.save();

    const nearby = await searchVendors(booking, true);

    return {
        found: nearby.length > 0,
        count: nearby.length,
        notifiedVendorIds: nearby.map(v => v.vendorId),
        message: nearby.length > 0
            ? `Broadcast triggered. Notified ${nearby.length} vendors.`
            : 'No vendors are currently available nearby.'
    };
};

module.exports = {
    // Lead flow
    requestLead: createBookingRequest,
    acceptLead: acceptBooking,
    acceptBooking,
    rejectLead: rejectBooking,
    rejectBooking,
    markLeadLater: markBookingLater,
    markBookingLater,

    // Booking creation
    createBooking,

    // Booking flow
    cancelBooking,
    vendorCancelBooking,
    getCancelledBookings,
    rescheduleBooking,
    getBookingsByUser,
    getBookingsByVendor,
    getCompletedBookingsByUser,
    retrySearchVendors,
    getVendorBookingHistory,
    getVendorLaterBookings,
    getBookingDetails,
    getBookingStatusHistory,
    markOnTheWay,
    markArrived,
    startWork,
    requestCompletionOTP,
    completeWork,

    // Pricing
    updateBookingPrice,
    confirmBookingPrice,
    rejectBookingPrice,

    // Reporting
    reportVendorNoShow,
    gracePeriodCancel,

    // Services
    addServicesToBooking,
    confirmProposedServices,
    rejectProposedServices,

    // Extra services
    requestExtraServices,
    vendorAcceptExtraServices,
    vendorConfirmExtraServices,
    vendorRejectExtraServices,
    userConfirmExtraServices,
    userRejectExtraServices,
    getVendorSelectableServicesForBooking,

    // Tracking / broadcast
    shouldTrackVendor,
    broadcastVendorLocation,
    triggerBroadcast,
    resendActiveRequestsToVendor
};
