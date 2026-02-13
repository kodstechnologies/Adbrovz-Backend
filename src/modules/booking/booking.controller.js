const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const bookingService = require('./booking.service');

/**
 * Create a new booking
 */
const createBooking = asyncHandler(async (req, res) => {
    const userId = req.user?.userId;
    const booking = await bookingService.createBooking(userId, req.body);

    res.status(201).json(
        new ApiResponse(201, {
            booking,
            message: "Request sent, waiting for vendor confirmation.",
            status: "Pending Acceptance"
        }, 'Booking request placed successfully')
    );
});

/**
 * Cancel booking
 */
const cancelBooking = asyncHandler(async (req, res) => {
    const userId = req.user?.userId;
    const { id } = req.params;
    const { reason } = req.body;
    const booking = await bookingService.cancelBooking(userId, id, reason);
    res.status(200).json(new ApiResponse(200, booking, 'Booking cancelled successfully'));
});

/**
 * Reschedule booking
 */
const rescheduleBooking = asyncHandler(async (req, res) => {
    const userId = req.user?.userId;
    const { id } = req.params;
    const { date, time } = req.body;

    console.log(`[DEBUG] Attempting to reschedule booking ${id} for user ${userId}`);
    console.log(`[DEBUG] New schedule - Date: ${date}, Time: ${time}`);

    if (!date || !time) {
        throw new ApiErrotr(400, 'Both date and time are required for rescheduling');
    }

    const booking = await bookingService.rescheduleBooking(userId, id, { date, time });
    res.status(200).json(new ApiResponse(200, booking, 'Booking rescheduled successfully'));
});

/**
 * Get bookings for the logged-in user or vendor
 * Categorized by: pending, active, completed, cancelled
 */
const getMyBookings = asyncHandler(async (req, res) => {
    const userId = req.user?.userId;
    const role = req.user?.role;

    let rawBookings;
    if (role === 'vendor') {
        rawBookings = await bookingService.getBookingsByVendor(userId);
    } else {
        rawBookings = await bookingService.getBookingsByUser(userId);
    }

    // Categorize bookings for the user
    const categorized = {
        pending: rawBookings.filter(b => ['pending_acceptance', 'pending'].includes(b.status)),
        active: rawBookings.filter(b => ['on_the_way', 'arrived', 'ongoing'].includes(b.status)),
        completed: rawBookings.filter(b => b.status === 'completed'),
        cancelled: rawBookings.filter(b => b.status === 'cancelled')
    };

    res.status(200).json(new ApiResponse(200, categorized, 'Bookings retrieved successfully'));
});

/**
 * Retry vendor search
 */
const retrySearch = asyncHandler(async (req, res) => {
    const userId = req.user?.userId;
    const { id } = req.params;
    const result = await bookingService.retrySearchVendors(userId, id);
    res.status(200).json(new ApiResponse(200, result, 'Search retried successfully'));
});

module.exports = {
    createBooking,
    cancelBooking,
    rescheduleBooking,
    getMyBookings,
    retrySearch
};
