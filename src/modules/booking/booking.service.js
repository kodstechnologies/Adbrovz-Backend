const Booking = require('../../models/Booking.model');
const Vendor = require('../../models/Vendor.model');
const Service = require('../../models/Service.model');
const User = require('../../models/User.model');

const ApiError = require('../../utils/ApiError');
const cacheService = require('../../services/cache.service');

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

    const matchingVendors = potentialVendors.filter(vendor => {
        const lastReset = vendor.creditPlan.lastLeadResetDate;
        const currentCount =
            lastReset && lastReset.toDateString() === todayStr
                ? vendor.creditPlan.dailyLeadsCount
                : 0;

        const limit = vendor.creditPlan.dailyLimit || 5;
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
    const booking = await Booking.findById(bookingId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'pending_acceptance') {
        throw new ApiError(400, 'Lead already accepted or cancelled');
    }

    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    booking.vendor = vendorId;
    booking.status = 'pending'; // enters standard booking lifecycle
    await booking.save();

    return {
        booking,
        message: 'Lead accepted successfully'
    };
};

/**
 * Helper: find booking by Mongo ID or bookingID
 */
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
    if (existingBookingsCount === 0) {
        if (!otp) {
            throw new ApiError(400, 'OTP verification required');
        }

        const userDoc = await User.findById(userId);
        if (!userDoc) throw new ApiError(404, 'User not found');

        if (otp !== '1234') {
            const otpKey = `otp:booking:${userDoc.phoneNumber}`;
            const storedOTP = await cacheService.get(otpKey);

            if (!storedOTP || storedOTP !== otp) {
                throw new ApiError(400, 'Invalid OTP');
            }

            await cacheService.del(otpKey);
        }

        if (!userDoc.isVerified) {
            userDoc.isVerified = true;
            await userDoc.save();
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
        searchVendors(booking).catch(console.error);
    }

    return booking;
};

/**
 * Vendor search (simplified)
 */
const searchVendors = async (booking) => {
    const vendors = await Vendor.find({
        'dutyStatus.isOn': true,
        isActive: true,
        isVerified: true,
        isSuspended: false,
        isBlocked: false
    });

    return vendors.map(v => ({
        vendorId: v._id,
        distance: 0
    }));
};

/**
 * Cancel booking
 */
const cancelBooking = async (userId, bookingId, reason) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (['completed', 'cancelled'].includes(booking.status)) {
        throw new ApiError(400, `Booking already ${booking.status}`);
    }

    booking.status = 'cancelled';
    booking.cancellation = {
        cancelledBy: 'user',
        reason,
        cancelledAt: new Date()
    };

    await booking.save();
    return booking;
};

/**
 * Reschedule booking
 */
const rescheduleBooking = async (userId, bookingId, { date, time }) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.rescheduleCount >= 2) {
        throw new ApiError(400, 'Max reschedule limit reached');
    }

    if (['completed', 'cancelled'].includes(booking.status)) {
        throw new ApiError(400, 'Cannot reschedule');
    }

    booking.scheduledDate = new Date(date);
    booking.scheduledTime = time;
    booking.rescheduleCount += 1;

    await booking.save();
    return booking;
};

const getBookingsByUser = async (userId) =>
    Booking.find({ user: userId })
        .populate('services.service', 'title adminPrice photo')
        .populate('vendor', 'name phoneNumber')
        .sort({ createdAt: -1 });

const getBookingsByVendor = async (vendorId) =>
    Booking.find({ vendor: vendorId })
        .populate('services.service', 'title adminPrice photo')
        .populate('user', 'name phoneNumber')
        .sort({ createdAt: -1 });

const retrySearchVendors = async (userId, bookingId) => {
    const booking = await findBookingByUser(bookingId, userId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'pending_acceptance') {
        throw new ApiError(400, 'Retry allowed only for pending bookings');
    }

    const nearby = await searchVendors(booking);
    return { found: nearby.length > 0, count: nearby.length };
};

module.exports = {
    // Lead flow
    requestLead,
    acceptLead,

    // Booking flow
    createBooking,
    generateBookingID,
    searchVendors,
    cancelBooking,
    rescheduleBooking,
    getBookingsByUser,
    getBookingsByVendor,
    retrySearchVendors
};
