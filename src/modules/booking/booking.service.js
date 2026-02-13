const Booking = require('../../models/Booking.model');
const Vendor = require('../../models/Vendor.model');
const vendorService = require('../vendor/vendor.service');
const ApiError = require('../../utils/ApiError');
const { v4: uuidv4 } = require('uuid');

/**
 * Request a lead (User initiates)
 * @param {string} userId - ID of the user requesting service
 * @param {Object} details - Subcategory ID and Location Info
 */
const requestLead = async (userId, { subcategoryId, address, pincode, scheduledDate, scheduledTime }) => {
    const todayStr = new Date().toDateString();

    // 1. Find potential vendors: Verified, Online, and matches subcategory + pincode + Active Plan
    const potentialVendors = await Vendor.find({
        isVerified: true,
        isSuspended: false,
        registrationStep: 'COMPLETED',
        selectedSubcategories: subcategoryId,
        workPincodes: pincode,
        'creditPlan.expiryDate': { $gt: new Date() }
    });

    // 2. Filter vendors by daily lead limit
    const matchingVendors = potentialVendors.filter(vendor => {
        const lastReset = vendor.creditPlan.lastLeadResetDate;
        const currentCount = (lastReset && lastReset.toDateString() === todayStr)
            ? vendor.creditPlan.dailyLeadsCount
            : 0;

        const limit = vendor.creditPlan.dailyLimit || 5;
        return currentCount < limit;
    });

    if (matchingVendors.length === 0) {
        throw new ApiError(404, 'No available vendors found for this service and area (or limits reached)');
    }

    // 3. Increment daily lead count for matching vendors
    const vendorIds = matchingVendors.map(v => v._id);
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

    // 4. Create a booking/lead record
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
 * @param {string} vendorId - ID of the vendor accepting
 * @param {string} bookingId - ID of the booking/lead
 */
const acceptLead = async (vendorId, bookingId) => {
    const booking = await Booking.findById(bookingId);
    if (!booking) throw new ApiError(404, 'Booking not found');

    if (booking.status !== 'pending_acceptance') {
        throw new ApiError(400, 'Lead already accepted or cancelled');
    }

    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // 2. Assign vendor to booking
    booking.vendor = vendorId;
    booking.status = 'pending'; // Moves to standard booking flow
    await booking.save();

    return {
        booking,
        message: 'Lead accepted successfully'
    };
};

module.exports = {
    requestLead,
    acceptLead
};
