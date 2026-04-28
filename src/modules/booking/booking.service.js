const Booking = require('../../models/Booking.model');
const Vendor = require('../../models/Vendor.model');
const Service = require('../../models/Service.model');
const User = require('../../models/User.model');
const Dispute = require('../../models/Dispute.model');
const Feedback = require('../../models/Feedback.model');
const { ROLES } = require('../../constants/roles');
const { calculateDistance } = require('../../utils/location');

const ApiError = require('../../utils/ApiError');
const cacheService = require('../../services/cache.service');
const adminService = require('../admin/admin.service');

const crypto = require('crypto');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const RADIUS_TIERS = [5, 15, 50]; // Progressive search expansion

/**
 * Request a Booking (User initiates)
 */
const createBookingRequest = async (
    userId,
    { subcategoryId, address, latitude, longitude, pincode, scheduledDate, scheduledTime }
) => {
    const todayStr = new Date().toDateString();

    const subcategory = await mongoose.model('Subcategory').findById(subcategoryId).populate('category');
    const leadCategory = subcategory?.category?._id;

    // ── Time Slot Validation ──
    if (subcategory?.timeSlots && subcategory.timeSlots.length > 0) {
        const activeSlots = subcategory.timeSlots.filter(s => s.isActive);
        if (activeSlots.length > 0) {
            const normalizedTime = String(scheduledTime || '').slice(0, 5);
            const isValid = activeSlots.some(s => s.startTime.slice(0, 5) === normalizedTime);
            
            if (!isValid) {
                const slotLabels = activeSlots.map(s => s.label || s.startTime).join(', ');
                throw new ApiError(400, `The selected time ${normalizedTime} is not valid for "${subcategory.name}". Please choose from: ${slotLabels}`);
            }
        }
    }

    // Find all services under this subcategory so we can also match vendors by selectedServices
    const servicesInSubcategory = await Service.find({ subcategory: subcategoryId }).select('_id');
    const serviceIdsInSubcategory = servicesInSubcategory.map(s => s._id);

    const potentialVendors = await Vendor.find({
        isVerified: true,
        isSuspended: false,
        registrationStep: 'COMPLETED',
        $or: [
            { selectedSubcategories: subcategoryId },
            { selectedServices: { $in: serviceIdsInSubcategory } }
        ]
    });

    if (potentialVendors.length === 0) {
        throw new ApiError(
            404,
            'No available vendors found for this service'
        );
    }

    const booking = await Booking.create({
        bookingID: `BK-${uuidv4().slice(0, 8).toUpperCase()}`,
        user: userId,
        status: 'pending_acceptance',
        statusHistory: [{ status: 'pending_acceptance', timestamp: new Date(), actor: 'user' }],
        scheduledDate: scheduledDate || new Date(),
        scheduledTime: scheduledTime || '00:00',
        category: leadCategory,
        location: { address, latitude, longitude, pincode }
    });


    const searchTimeoutMins = (await adminService.getSetting('bookings.search_timeout_mins')) || 2;

    // Trigger broadcast
    searchVendors(booking, true).catch(console.error);

    console.log(`[DEBUG] Booking request created: ${booking._id}, status: ${booking.status}`);
    return {
        booking,
        availableVendorsCount: potentialVendors.length,
        searchTimeoutMins,
        message: 'Booking broadcasted to available vendors'
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
        // Check if it was already accepted by someone else
        const acceptedBooking = await Booking.findOne(query);
        if (acceptedBooking) {
            throw new ApiError(400, 'You missed your order! This booking has already been accepted by another vendor.');
        }
        throw new ApiError(404, 'Booking not found or already expired.');
    }

    // ── Schedule overlap check ──
    const overlapping = await Booking.findOne({
        vendor: vendorId,
        scheduledDate: booking.scheduledDate,
        scheduledTime: booking.scheduledTime,
        status: { $nin: ['cancelled', 'completed'] },
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
            const [vLng, vLat] = vendor.liveLocation.coordinates;
            // Ignore [0,0] as it's usually a default/invalid location (off Africa coast)
            if (vLat !== 0 && vLng !== 0) {
                const { latitude: bLat, longitude: bLng } = source.location;
                distance = calculateDistance(vLat, vLng, bLat, bLng);
            }
        }

        const perKmCharge = (await adminService.getSetting('pricing.travel_charge_per_km')) || 10;
        const baseCharge = 50; // Default base visit charge
        let travelCharge = baseCharge + (distance * perKmCharge);
        
        // Cap travel charge at a reasonable amount (e.g., ₹500)
        if (travelCharge > 500) travelCharge = 500;
        travelCharge = Math.round(travelCharge * 100) / 100; // Round to 2 decimals

        // Finalize existing Booking
        booking.vendor = vendorId;
        booking.otp = { startOTP: '1234', completionOTP: null };
        if (gracePeriodEnd) booking.gracePeriodEnd = gracePeriodEnd;
        booking.statusHistory.push({ status: 'pending', timestamp: new Date(), actor: 'vendor' });
        
        // Update travel charge and total price
        booking.pricing = {
            ...booking.pricing,
            travelCharge: travelCharge,
            totalPrice: (booking.pricing?.basePrice || 0) + travelCharge
        };
        
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
            message: 'A vendor has accepted your booking request!'
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

    // ── Distance Guard: 1km arrival threshold ──
    const vendor = await Vendor.findById(vendorId).select('liveLocation');
    if (vendor?.liveLocation?.coordinates && booking.location?.latitude) {
        const [vLng, vLat] = vendor.liveLocation.coordinates;
        const { latitude: bLat, longitude: bLng } = booking.location;
        
        const distance = calculateDistance(vLat, vLng, bLat, bLng);
        if (distance > 1.0) { // 1 km
            throw new ApiError(400, `Arrival denied. You are ${(distance * 1000).toFixed(0)}m away. Please reach the customer's location first.`);
        }
    }

    booking.status = 'arrived';
    booking.statusHistory.push({ status: 'arrived', timestamp: new Date(), actor: 'vendor' });
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
    booking.statusHistory.push({ status: 'ongoing', timestamp: new Date(), actor: 'vendor' });
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

    if (bookingObj.status === 'cancelled') {
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

            if (['pending', 'on_the_way', 'arrived'].includes(bookingObj.status)) {
                if (bookingObj.isPriceConfirmed) {
                    bookingObj.activeOTP = bookingObj.currentOTP.startOTP;
                } else {
                    bookingObj.activeOTP = { label: 'Start OTP', code: 'Locked', instruction: 'Visible once price is confirmed' };
                    bookingObj.currentOTP.startOTP.code = 'Locked';
                    bookingObj.currentOTP.startOTP.instruction = 'Price confirmation pending';
                }
            } else if (bookingObj.status === 'ongoing') {
                bookingObj.activeOTP = bookingObj.currentOTP.completionOTP;
            }

            if (!bookingObj.isPriceConfirmed) bookingObj.otp.startOTP = 'Locked (Price Pending)';
            if (!completionOTPCode) bookingObj.otp.completionOTP = 'Hidden (Pending)';
        } else if (isVendorRole) {
            delete bookingObj.otp;
            delete bookingObj.currentOTP;
            delete bookingObj.activeOTP;
        }
    }

    // Ensure extra services arrays always have pricing fields
    if (bookingObj.userRequestedServices) {
        bookingObj.userRequestedServices = bookingObj.userRequestedServices.map(item => ({
            ...item,
            adminPrice: item.adminPrice, vendorPrice: item.vendorPrice, finalPrice: item.finalPrice, isPriceConfirmed: item.isPriceConfirmed ?? false
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
    else if (bookingObj.status === 'cancelled') rescheduleReason = "Booking already cancelled";
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
        canCancel: ['pending_acceptance', 'pending'].includes(bookingObj.status),
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
        .populate('vendor', 'name phoneNumber photo')
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
            submittedMessage: dispute.userComment || "", // The "submitted message" from user
        };
        
        // Refine actions based on dispute existence and status
        // When dispute is REOPENED: only canReuploadDispute is true, others are false
        // For all other statuses: only canViewDispute is true
        const isReopened = dispute.status === 'REOPENED';
        formattedBooking.actions.canRaiseDispute = false;
        formattedBooking.actions.canViewDispute = !isReopened;
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

    const adminPrice = service.bookingPrice || 
                      service.serviceType?.bookingPrice || 
                      service.subcategory?.bookingPrice || 
                      service.category?.bookingPrice ||
                      service.serviceCharge || 
                      service.serviceType?.serviceCharge || 
                      service.subcategory?.serviceCharge || 
                      service.category?.serviceCharge || 0;

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

    if (!latitude || !longitude) {
        throw new ApiError(400, 'Coordinates (Latitude and Longitude) are required for vendor discovery');
    }

    const user = await User.findById(userId);
    if (user.bannedUntil && user.bannedUntil > new Date()) {
        throw new ApiError(403, `You are temporarily banned from making bookings until ${user.bannedUntil.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} due to multiple cancellations.`);
    }

    const existingBookingsCount = await Booking.countDocuments({ user: userId });

    // First booking OTP requirement
    if (existingBookingsCount === 0) {
        if (!otp || otp.toString() !== '1234') {
            throw new ApiError(400, 'FIRST_BOOKING_OTP_REQUIRED');
        }
    }
    

    const processedServices = [];
    let leadCategory = null;

    for (let i = 0; i < services.length; i++) {
        const item = services[i];
        // Fetch hierarchical pricing (Service -> ServiceType -> Subcategory -> Category)
        const serviceData = await Service.findById(item.serviceId).populate('category');
        const { adminPrice, coupon, discount } = await _getHierarchicalPricing(item.serviceId);
        
        if (i === 0 && serviceData) {
            leadCategory = serviceData.category?._id;
        }

        // ── Time Slot Validation ──
        if (serviceData?.timeSlots && serviceData.timeSlots.length > 0) {
            const activeSlots = serviceData.timeSlots.filter(s => s.isActive);
            if (activeSlots.length > 0) {
                // Ensure the selected time matches at least one startTime
                // Normalizing time format (taking HH:mm)
                const normalizedTime = String(time || '').slice(0, 5); 
                const isValid = activeSlots.some(s => s.startTime.slice(0, 5) === normalizedTime);
                
                if (!isValid) {
                    const slotLabels = activeSlots.map(s => s.label || s.startTime).join(', ');
                    throw new ApiError(400, `The selected time ${normalizedTime} is not valid for "${serviceData.title}". Please choose from: ${slotLabels}`);
                }
            }
        }

        if (adminPrice === 0) {
            // Log a warning or handle as unpriced
            console.log(`[WARNING] Service ${item.serviceId} has 0 adminPrice across hierarchy`);
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

    const perKmCharge = (await adminService.getSetting('pricing.travel_charge_per_km')) || 0;
    
    // Calculate initial travel charge
    const distanceKm = bookingData.distance || 0;
    const calculatedTravelCharge = distanceKm * perKmCharge;

    const calculatedBasePrice = processedServices.reduce((sum, s) => sum + (s.finalPrice || 0), 0);
    const calculatedTotalPrice = calculatedBasePrice + calculatedTravelCharge;

    const bookingID = generateBookingID();
    const booking = await Booking.create({
        bookingID: bookingID,
        user: userId,
        category: leadCategory,
        services: processedServices,
        scheduledDate: new Date(date),
        scheduledTime: time,
        location: { address, latitude, longitude, pincode },
        pricing: { 
            totalPrice: calculatedTotalPrice, 
            basePrice: calculatedBasePrice,
            travelCharge: calculatedTravelCharge 
        },
        status: 'pending_acceptance',
        statusHistory: [{ status: 'pending_acceptance', timestamp: new Date(), actor: 'user' }]
    });

    if (confirmation === true) {
        searchVendors(booking, true).catch(console.error);
    } else {
        searchVendors(booking, true).catch(console.error);
    }

    const populatedBooking = await Booking.findById(booking._id).populate('category');
    const formattedBooking = _formatBooking(populatedBooking, 'user');

    return {
        booking: formattedBooking,
        message: 'Searching for vendors...'
    };
};

const searchVendors = async (booking, broadcast = false) => {
    if (!booking.location?.latitude || !booking.location?.longitude) {
        console.error(`[ERROR] searchVendors: Missing coordinates for ${booking._id}. Search aborted.`);
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

    // 1. Determine Radius
    const retryCount = booking.retryCount || 0;
    const radiusTiers = RADIUS_TIERS;
    const radiusInKm = radiusTiers[Math.min(retryCount, radiusTiers.length - 1)];
    
    let categoryIds = [];
    if (booking.category) {
        categoryIds = [booking.category.toString()];
    } else {
        const serviceIds = booking.services.map(s => s.service);
        const services = await Service.find({ _id: { $in: serviceIds } }).select('category');
        categoryIds = [...new Set(services.map(s => s.category.toString()))];
    }

    const ignoredVendors = [
        ...(booking.rejectedVendors || []),
        ...(booking.laterVendors || [])
    ].map(id => id.toString());

    // ── Vendors can receive new requests even if they have ongoing bookings (Allow concurrent orders) ──
    const busyVendorIds = []; // Initialized as empty to allow concurrent orders by default

    // ── Find services belonging to the booking's categories so we can match vendors by selectedServices too ──
    const servicesInCategories = await Service.find({ category: { $in: categoryIds } }).select('_id');
    const serviceIdsInCategories = servicesInCategories.map(s => s._id);
    console.log(`[SEARCH] Found ${serviceIdsInCategories.length} services in categoryIds [${categoryIds}] for cross-matching`);

    // ── Geospatial Query ──
    // Match vendors who have the category selected OR have any services from that category
    const categoryOrServiceFilter = [
        { selectedCategories: { $in: categoryIds } }
    ];
    if (serviceIdsInCategories.length > 0) {
        categoryOrServiceFilter.push({ selectedServices: { $in: serviceIdsInCategories } });
    }

    const geoQuery = {
        isVerified: true,
        isSuspended: false,
        isBlocked: false,
        $or: categoryOrServiceFilter,
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

    console.log(`[SEARCH] Searching for vendors for booking ${booking._id} in categoryIds:`, categoryIds);

    let vendors = await Vendor.find(geoQuery).select('_id');
    console.log(`[DEBUG] searchVendors - Geo query found ${vendors.length} vendors within ${radiusInKm}km radius`);

    // ── Fallback: If no geo results, notify all verified vendors in the category ──
    if (vendors.length === 0) {
        console.warn(`[SEARCH] No vendors found within ${radiusInKm}km geo radius. Falling back to category/service-based search.`);
        const fallbackQuery = {
            isVerified: true,
            isSuspended: false,
            isBlocked: false,
            $or: categoryOrServiceFilter,
        };
        if (nins.length > 0) {
            fallbackQuery._id = { $nin: nins };
        }
        vendors = await Vendor.find(fallbackQuery).select('_id');
        console.log(`[DEBUG] searchVendors - Fallback query found ${vendors.length} vendors (Verified & Category/Service matching)`);
    }

    if (broadcast) {
        try {
            const { getVendorSockets, getIo } = require('../../socket');
            const io = getIo();
            let broadcastCount = 0;

            // Fetch latest data for broadcast
            const populatedBooking = await Booking.findById(booking._id)
                .populate('services.service', 'title serviceCharge photo approxCompletionTime')
                .populate('category', 'title name')
                .populate('user', 'name phoneNumber photo');

            if (!populatedBooking) return [];

            let totalDurationMins = 0;
            if (populatedBooking.services && populatedBooking.services.length > 0) {
                populatedBooking.services.forEach(item => {
                    totalDurationMins += (item.service?.approxCompletionTime || 0) * (item.quantity || 1);
                });
            }

            const payload = {
                ...(populatedBooking.toObject()),
                bookingID: populatedBooking.bookingID,
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
                // We keep lat/long for map display but hide exact address string
            }

            // Explicitly expose user logic for the socket broadcast
            if (payload.user && payload.location) {
                payload.user.latitude = payload.location.latitude;
                payload.user.longitude = payload.location.longitude;
            }

            const notifiedIds = [];
            const { emitToVendor, isVendorOnline } = require('../../socket');

            vendors.forEach(v => {
                const vendorIdStr = v._id.toString();
                const online = isVendorOnline(vendorIdStr);
                
                console.log(`[DEBUG] searchVendors checking Vendor ${vendorIdStr} - Online: ${online}`);
                
                if (online) {
                    emitToVendor(vendorIdStr, 'new_booking_request', payload);
                    broadcastCount++;
                    notifiedIds.push(v._id);
                } else {
                    console.log(`[DEBUG] Vendor ${vendorIdStr} has no active sockets - SKIPPED broadcast`);
                }
            });

            // Persist notified vendors to DB
            if (notifiedIds.length > 0) {
                await Booking.findByIdAndUpdate(booking._id, {
                    $addToSet: { notifiedVendors: { $each: notifiedIds } }
                });
                console.log(`[DEBUG] Persisted ${notifiedIds.length} notified vendor IDs to database for Booking ${booking._id}`);
            }

            const { emitToUser } = require('../../socket');
            emitToUser(booking.user, 'booking_search_update', {
                bookingId: booking._id,
                bookingID: booking.bookingID,
                status: 'searching',
                radius: radiusInKm,
                vendorCount: broadcastCount,
                message: broadcastCount > 0 
                  ? `Searching in ${radiusInKm}km radius... notified ${broadcastCount} vendors.`
                  : `Searching in ${radiusInKm}km radius... no vendors online nearby right now.`
            });

            // ── Schedule Search Expansion (Retries: 2/2/1 mins for total of 5 mins) ──
            if (retryCount < radiusTiers.length - 1) {
                // Tier 0 (2km) -> 2 mins, Tier 1 (4km) -> 2 mins, Tier 2 (5km) -> 1 min (final)
                const delayMins = retryCount < 2 ? 2 : 1;
                
                setTimeout(async () => {
                    const current = await Booking.findById(booking._id);
                    if (current && current.status === 'pending_acceptance') {
                        current.retryCount = (current.retryCount || 0) + 1;
                        await current.save();
                        searchVendors(current, true).catch(console.error);
                    }
                }, delayMins * 60 * 1000);
            } else if (retryCount === radiusTiers.length - 1) {
                // Hard-Stop: After the final tier (reaches the end of 5 mins total)
                setTimeout(async () => {
                    const current = await Booking.findById(booking._id);
                    if (current && current.status === 'pending_acceptance') {
                        current.status = 'no_vendors_available';
                        await current.save();
                        
                        emitToUser(booking.user, 'booking_search_update', {
                            bookingId: booking._id,
                            bookingID: booking.bookingID,
                            status: 'no_vendors_available',
                            message: `Could not find any vendors within ${RADIUS_TIERS[RADIUS_TIERS.length - 1]}km after 5 minutes of searching. Please try again manually.`
                        });
                    }
                }, 1 * 60 * 1000); // Wait 1 more min for the 5km tier before stopping
            }
            
        } catch (error) {
            console.error('Socket.io error during broadcast:', error.message);
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

    return {
        booking,
        message: 'Marked as later successfully'
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
    // 4. Cancelled
    const activeAndHistoryBookings = await Booking.find({
        vendor: vendorIdObj,
        status: { $in: ['pending', 'ongoing', 'completed', 'on_the_way', 'arrived', 'cancelled'] }
    })
        .select('-rejectedVendors -laterVendors')
        .populate('services.service', 'title serviceCharge photo')
        .populate('user', 'name phoneNumber photo')
        .sort({ createdAt: -1 });

    const categorized = {
        pending: activeAndHistoryBookings.filter(b => ['pending', 'on_the_way', 'arrived'].includes(b.status)),
        ongoing: activeAndHistoryBookings.filter(b => b.status === 'ongoing'),
        completed: activeAndHistoryBookings.filter(b => b.status === 'completed'),
        cancelled: activeAndHistoryBookings.filter(b => b.status === 'cancelled').map(b => {
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

    if (['completed', 'cancelled'].includes(booking.status)) {
        throw new ApiError(400, 'Cannot cancel a booking that is already completed or cancelled');
    }

    // ── Cancel count enforcement ──
    const cancelLimit = (await adminService.getSetting('bookings.cancel_limit')) || 1;
    if (booking.cancelCount >= cancelLimit) {
        throw new ApiError(400, `Maximum cancellation limit of ${cancelLimit} reached for this booking`);
    }

    const lockMins = (await adminService.getSetting('bookings.cancellation_lock_mins')) || 60;
    
    // Combine scheduledDate and scheduledTime into a proper Date object in IST
    const scheduledDateTime = _getScheduledDateTimeIST(booking.scheduledDate, booking.scheduledTime);

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
    booking.statusHistory.push({ status: 'cancelled', actor: 'user', reason: reason || 'Cancelled by user', timestamp: now });
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
        .populate('services.service', 'title serviceCharge photo')
        .populate('proposedServices.service', 'title serviceCharge photo')
        .populate('userRequestedServices.service', 'title serviceCharge photo')
        .populate('vendor', 'name phoneNumber photo')
        .populate('user', 'name phoneNumber photo');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', populatedBooking);
    if (booking.vendor) {
        emitToVendor(booking.vendor, 'booking_cancellation', populatedBooking);
    }

    return populatedBooking || booking;
};

/**
 * Vendor cancels booking
 */
const vendorCancelBooking = async (vendorId, bookingId, reason) => {
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (['completed', 'cancelled'].includes(booking.status)) {
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
        .populate('vendor', 'name phoneNumber photo')
        .populate('user', 'name phoneNumber photo');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(booking.user, 'booking_status_updated', populatedBooking);
    emitToUser(booking.user, 'booking_cancellation', {
        ...populatedBooking.toObject(),
        message: 'The vendor has cancelled your booking.'
    });
    emitToVendor(vendorId, 'booking_status_updated', populatedBooking);

    return populatedBooking || booking;
};

/**
 * Get available 1-hour time slots for a vendor on a given date (08:00–20:00)
 * excluding windows that overlap with existing bookings.
 */
const getAvailableSlots = async (vendorId, date, excludeBookingId) => {
    const istDateStr = new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const dayStart = new Date(`${istDateStr}T00:00:00+05:30`);
    const dayEnd = new Date(`${istDateStr}T23:59:59.999+05:30`);

    // Fetch all vendor's active bookings on that day
    const vendorBookings = await Booking.find({
        vendor: vendorId,
        _id: { $ne: excludeBookingId },
        scheduledDate: { $gte: dayStart, $lte: dayEnd },
        status: { $nin: ['cancelled', 'completed', 'pending_acceptance'] }
    }).populate('services.service');

    // Build busy windows
    const busyWindows = [];
    for (const b of vendorBookings) {
        const range = await getBookingTimeRange(b);
        if (range) busyWindows.push(range);
    }

    // Generate candidate slots every 30 mins from 08:00 to 20:00
    const slots = [];
    const slotDurationMs = 60 * 60 * 1000; // 1 hour window to check
    for (let h = 8; h < 20; h++) {
        for (let m = 0; m < 60; m += 30) {
            const slotStart = new Date(`${istDateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
            const slotEnd = new Date(slotStart.getTime() + slotDurationMs);

            const overlaps = busyWindows.some(w =>
                Math.max(slotStart, w.start) < Math.min(slotEnd, w.end)
            );

            if (!overlaps) {
                slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
            }
        }
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

    if (['completed', 'cancelled'].includes(booking.status)) {
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
                status: { $nin: ['cancelled', 'completed', 'pending_acceptance'] }
            }).populate('services.service');

            for (const vb of vendorBookings) {
                const range = await getBookingTimeRange(vb);
                if (!range) continue;
                const overlaps = Math.max(newRange.start, range.start) < Math.min(newRange.end, range.end);
                if (overlaps) {
                    // Vendor is busy — return available slots instead
                    const availableSlots = await getAvailableSlots(booking.vendor, newDate, booking._id);
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
        .populate('vendor', 'name phoneNumber photo')
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
    const bookings = await Booking.find({ vendor: vendorId })
        .populate('services.service', 'title serviceCharge photo')
        .populate('proposedServices.service', 'title serviceCharge photo')
        .populate('userRequestedServices.service', 'title serviceCharge photo')
        .populate('user', 'name phoneNumber photo')
        .populate('vendor', 'name phoneNumber photo')
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
        .populate('vendor', 'name phoneNumber photo')
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
    let query = { status: 'cancelled' };
    
    if (role === 'vendor') {
        query.vendor = userId;
    } else if (role === 'user' || role === 'User') {
        query.user = userId;
    }

    const bookings = await Booking.find(query)
        .populate('services.service', 'title serviceCharge photo')
        .populate('vendor', 'name phoneNumber photo')
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

    if (booking.status !== 'pending_acceptance' && booking.status !== 'no_vendors_available') {
        throw new ApiError(400, 'Retry allowed only for pending search requests');
    }

    // Reset status and retryCount for tiered search reset
    booking.status = 'pending_acceptance';
    booking.retryCount = 0;

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
        message: nearby.length > 0
            ? `Search restarted from ${RADIUS_TIERS[0]}km radius. Please wait.`
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

const recalculateBookingPrice = (booking) => {
    let basePrice = booking.services.reduce((sum, s) => sum + (s.finalPrice || 0), 0);

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

    booking.pricing = booking.pricing || {};
    booking.pricing.basePrice = basePrice;
    booking.pricing.totalPrice = basePrice + (booking.pricing.travelCharge || 0) + (booking.pricing.additionalCharges || 0);
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

    // Block repricing of regular services (but allow if only extra services need pricing)
    const hasPendingExtraServices = booking.userRequestedServices &&
        booking.userRequestedServices.some(s => s.status === 'pending');

    if (booking.priceUpdatedOnce && !hasPendingExtraServices) {
        throw new ApiError(400, 'Price can only be updated once per booking');
    }

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
            const isUnpriced = serviceDoc && (!serviceDoc.isAdminPriced || !serviceDoc.serviceCharge || serviceDoc.serviceCharge === 0);
            
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
                }
                
                modified = true;
            }
        }
    }

    if (!modified) {
        console.log(`[SOCKET] No unpriced services found for update: ${bookingId}`);
        throw new ApiError(400, 'No unpriced services found to update');
    }

    // Recalculate total price so the user can see the proposed amount before confirming
    recalculateBookingPrice(booking);

    booking.priceUpdatedOnce = true;
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

    // Also confirm any user-requested extra services that were priced
    if (booking.userRequestedServices && booking.userRequestedServices.length > 0) {
        booking.userRequestedServices.forEach(s => {
            if (s.status === 'priced') {
                s.isPriceConfirmed = true;
                s.status = 'accepted';
            }
        });
        booking.markModified('userRequestedServices');
    }

    // Recalculate total price now that it's confirmed
    recalculateBookingPrice(booking);

    // Log confirmation
    booking.statusHistory.push({
        status: 'price_confirmed',
        reason: 'Price confirmed by user',
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

    // Identify unconfirmed services in main services array
    const unconfirmedServices = booking.services.filter(s => !s.isPriceConfirmed);
    
    // Identify unconfirmed extra services (those priced by vendor but not yet accepted by user)
    const unconfirmedExtraServices = (booking.userRequestedServices || []).filter(
        s => s.status === 'priced' && !s.isPriceConfirmed
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

    // Remove rejected services from both arrays
    booking.services = booking.services.filter(s => s.isPriceConfirmed);
    
    if (booking.userRequestedServices) {
        booking.userRequestedServices = booking.userRequestedServices.filter(
            s => !(s.status === 'priced' && !s.isPriceConfirmed)
        );
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
    
    booking.isPriceConfirmed = true; // Remaining ones are confirmed
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

    recalculateBookingPrice(booking);
    await booking.save();

    const populatedBooking = await getBookingDetails(booking._id, userId, 'user');
    const vendorPayload = await getBookingDetails(booking._id, booking.vendor, 'vendor');

    const { emitToUser, emitToVendor } = require('../../socket');
    emitToUser(userId, 'booking_status_updated', populatedBooking);
    if (booking.vendor) {
        emitToVendor(booking.vendor, 'booking_status_updated', vendorPayload);
        emitToVendor(booking.vendor, 'booking_price_rejected', {
            bookingId: booking._id,
            reason: reason || 'Price rejected by user',
            message: booking.status === 'cancelled' 
                ? 'User rejected the price and the booking was cancelled.'
                : 'User rejected the proposed price for some services.'
        });
    }

    return { 
        booking: populatedBooking, 
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
        const adminPrice = serviceDoc.serviceCharge || null;
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

    recalculateBookingPrice(booking);
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
    recalculateBookingPrice(booking);

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

    recalculateBookingPrice(booking);
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
    recalculateBookingPrice(booking);

    booking.markModified('services');
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
        acceptedServiceIds: acceptedServiceIds,
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
async function userRejectExtraServices(userId, bookingId, rejectedServiceIds, reason) {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (!booking.userRequestedServices || booking.userRequestedServices.length === 0) {
        throw new ApiError(400, 'No extra services pending rejection');
    }

    const now = new Date();
    let hasRejected = false;
    let actualRejectedIds = [];

    const rejectIds = rejectedServiceIds && rejectedServiceIds.length > 0 
        ? rejectedServiceIds.map(id => id.toString()) 
        : null;

    const remainingRequests = [];

    booking.userRequestedServices.forEach(s => {
        const sid = s.service.toString();
        if (!rejectIds || rejectIds.includes(sid)) {
            booking.rejectedServices.push({
                service: s.service,
                quantity: s.quantity,
                adminPrice: s.adminPrice,
                vendorPrice: s.vendorPrice,
                finalPrice: s.finalPrice,
                rejectedBy: 'user',
                rejectionType: 'extra_service',
                reason: reason || 'User rejected their own requested services after pricing.',
                rejectedAt: now
            });
            actualRejectedIds.push(sid);
            hasRejected = true;
        } else {
            remainingRequests.push(s);
        }
    });

    if (!hasRejected) {
        throw new ApiError(400, 'Could not reject any services. Ensure valid service IDs were provided.');
    }

    // Update the requests to only have the remaining ones
    booking.userRequestedServices = remainingRequests;

    // Log in history
    booking.statusHistory.push({
        status: 'extra_services_rejected',
        actor: 'user',
        reason: reason || 'User rejected their own requested services after pricing.',
        timestamp: now
    });
    booking.markModified('statusHistory');
    booking.markModified('rejectedServices');
    booking.markModified('userRequestedServices');

    recalculateBookingPrice(booking);
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
        message: 'User rejected the priced extra services.',
        rejectedServiceIds: actualRejectedIds
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
        const adminPrice = serviceDoc.serviceCharge || 0;
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

    booking.statusHistory.push({
        status: 'extra_services_requested',
        reason: 'User requested additional services',
        actor: 'user',
        timestamp: new Date()
    });
    booking.markModified('statusHistory');

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
    const newlyRequestedServices = populatedBooking.userRequestedServices.slice(-newServices.length);
    emitToVendor(booking.vendor, 'extra_services_requested_by_user', {
        bookingId: booking._id,
        bookingID: booking.bookingID,
        requestedServices: newlyRequestedServices,
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
        const itemIdStr = item.serviceId.toString();
        // Find matching service in userRequestedServices (check both service ID and requested item _id)
        const requestItem = booking.userRequestedServices.find(
            s => s.service.toString() === itemIdStr || (s._id && s._id.toString() === itemIdStr)
        );

        if (requestItem) {
            const serviceDoc = await Service.findById(item.serviceId);
            if (!serviceDoc) continue;

            const qty = requestItem.quantity || 1;
            const adminPrice = serviceDoc.serviceCharge || 0;
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
    }

    if (!isUpdated) {
        throw new ApiError(400, 'None of the provided services matched the user requests');
    }

    recalculateBookingPrice(booking);
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
async function vendorAcceptExtraServices(vendorId, bookingId) {
    const booking = await Booking.findOne({ _id: bookingId, vendor: vendorId });
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (!booking.userRequestedServices || booking.userRequestedServices.length === 0) {
        throw new ApiError(400, 'No pending user service requests to accept');
    }

    // Mark all pending services as accepted
    let anyAccepted = false;
    for (const item of booking.userRequestedServices) {
        if (item.status === 'pending' || !item.status) {
            item.status = 'accepted';
            anyAccepted = true;
        }
    }

    if (!anyAccepted) {
        throw new ApiError(400, 'No pending services found to accept');
    }

    booking.markModified('userRequestedServices');
    
    // Recalculate total price to include newly accepted services
    recalculateBookingPrice(booking);

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
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (!booking.userRequestedServices || booking.userRequestedServices.length === 0) {
        throw new ApiError(400, 'No pending user service requests to reject');
    }

    const now = new Date();
    let hasRejected = false;
    let actualRejectedIds = [];

    const rejectIds = rejectedServiceIds && rejectedServiceIds.length > 0 
        ? rejectedServiceIds.map(id => id.toString()) 
        : null;

    booking.userRequestedServices.forEach(item => {
        const sid = item.service.toString();
        if ((item.status === 'pending' || item.status === 'priced') && (!rejectIds || rejectIds.includes(sid))) {
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
            item.status = 'rejected';
            actualRejectedIds.push(sid);
            hasRejected = true;
        }
    });

    if (!hasRejected) {
        throw new ApiError(400, 'Could not reject any services. Ensure valid service IDs were provided.');
    }

    // Log in history
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
    const vendorPayload = await getBookingDetails(booking._id, vendorId, 'vendor');
    const userPayload = await getBookingDetails(booking._id, booking.user, 'user');

    emitToVendor(vendorId, 'booking_status_updated', vendorPayload);
    emitToUser(booking.user, 'booking_status_updated', userPayload);

    // Specific event to user
    emitToUser(booking.user, 'extra_services_rejected_by_vendor', {
        bookingId: booking._id,
        reason: reason || 'Vendor declined the extra services.',
        message: 'Vendor has rejected your request for additional services.',
        rejectedServices: userPayload.userRequestedServices.filter(s => s.status === 'rejected'),
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
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (!booking.userRequestedServices || booking.userRequestedServices.length === 0) {
        throw new ApiError(400, 'No pending extra service requests to confirm');
    }

    const now = new Date();
    let hasConfirmed = false;
    const acceptedIds = acceptedServiceIds ? acceptedServiceIds.map(id => id.toString()) : [];

    booking.userRequestedServices.forEach(item => {
        const sid = item.service.toString();
        if (item.status === 'priced' && acceptedIds.includes(sid)) {
            item.status = 'accepted';
            item.isPriceConfirmed = true;
            hasConfirmed = true;
        }
    });

    if (!hasConfirmed) {
        throw new ApiError(400, 'No priced extra services matched the provided IDs');
    }

    recalculateBookingPrice(booking);
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
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

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
 * Trigger a broadcast for a specific booking to all matched vendors via socket.
 * Can be called via API to manually re-trigger order notifications.
 */
const triggerBroadcast = async (bookingId) => {
    const booking = await Booking.findById(bookingId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'pending_acceptance') {
        throw new ApiError(400, `Cannot broadcast: booking status is '${booking.status}'. Only 'pending_acceptance' bookings can be broadcasted.`);
    }

    console.log(`[BROADCAST] Manual trigger for booking ${booking._id}`);
    const vendors = await searchVendors(booking, true);
    return {
        bookingId: booking._id,
        bookingID: booking.bookingID,
        vendorsSearched: vendors.length,
        message: `Broadcast triggered. Found ${vendors.length} matching vendors.`
    };
};

module.exports = {
    // Booking flow
    createBookingRequest,
    createBooking,
    generateBookingID,
    searchVendors,
    acceptBooking,
    rejectBooking,
    markBookingLater,
    cancelBooking,
    vendorCancelBooking,
    rescheduleBooking,
    findBookingByUser,
    getBookingDetails,
    getBookingsByUser,
    getBookingsByVendor,
    getCompletedBookingsByUser,
    getCancelledBookings,
    getVendorBookingHistory,
    getVendorLaterBookings,
    retrySearchVendors,
    getBookingStatusHistory,
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
    vendorAcceptExtraServices,
    vendorConfirmExtraServices,
    vendorRejectExtraServices,
    userConfirmExtraServices,
    userRejectExtraServices,
    shouldTrackVendor,
    broadcastVendorLocation,
    triggerBroadcast
};
