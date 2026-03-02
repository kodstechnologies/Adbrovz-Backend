const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const bookingService = require('./booking.service');

/**
 * Create a new service request (Lead)
 */
const requestLead = asyncHandler(async (req, res) => {
    const userId = req.user?._id || req.body.userId; // supports demo + auth
    const result = await bookingService.requestLead(userId, req.body);

    res.status(201).json(
        new ApiResponse(201, result, 'Lead request created successfully')
    );
});

/**
 * Vendor accepts a lead
 */
const acceptLead = asyncHandler(async (req, res) => {
    const vendorId = req.user?._id || req.body.vendorId; // supports demo + auth
    const { bookingId } = req.params;

    const result = await bookingService.acceptLead(vendorId, bookingId);

    res.status(200).json(
        new ApiResponse(200, result.booking, result.message)
    );
});

/**
 * Create a new booking
 */
const createBooking = asyncHandler(async (req, res) => {
    const userId = req.user?.userId || req.body.userId;
    const booking = await bookingService.createBooking(userId, req.body);

    res.status(201).json(
        new ApiResponse(
            201,
            {
                booking,
                message: "Request sent, waiting for vendor confirmation.",
                status: "Pending Acceptance"
            },
            'Booking request placed successfully'
        )
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

    res.status(200).json(
        new ApiResponse(200, booking, 'Booking cancelled successfully')
    );
});

/**
 * Reschedule booking
 */
const rescheduleBooking = asyncHandler(async (req, res) => {
    const userId = req.user?.userId;
    const { id } = req.params;
    const { date, time } = req.body;

    if (!date || !time) {
        throw new ApiError(400, 'Both date and time are required for rescheduling');
    }

    const booking = await bookingService.rescheduleBooking(
        userId,
        id,
        { date, time }
    );

    res.status(200).json(
        new ApiResponse(200, booking, 'Booking rescheduled successfully')
    );
});

/**
 * Get bookings for logged-in user or vendor
 */
const getMyBookings = asyncHandler(async (req, res) => {
    const userId = req.user?.userId;
    const role = req.user?.role;

    const rawBookings =
        role === 'vendor'
            ? await bookingService.getBookingsByVendor(userId)
            : await bookingService.getBookingsByUser(userId);

    const statusMap = {
        'pending_acceptance': 'Pending Acceptance',
        'pending': 'Accepted',
        'on_the_way': 'Vendor on the Way',
        'arrived': 'Vendor Arrived',
        'ongoing': 'Working',
        'completed': 'Completed',
        'cancelled': 'Cancelled'
    };

    const enhanceBooking = (b) => {
        const obj = b.toObject ? b.toObject() : b;
        obj.displayStatus = statusMap[obj.status] || obj.status;
        return obj;
    };

    const categorized = {
        pending: rawBookings
            .filter(b => ['pending_acceptance', 'pending'].includes(b.status))
            .map(enhanceBooking),
        active: rawBookings
            .filter(b => ['on_the_way', 'arrived', 'ongoing'].includes(b.status))
            .map(enhanceBooking),
        completed: rawBookings
            .filter(b => b.status === 'completed')
            .map(enhanceBooking),
        cancelled: rawBookings
            .filter(b => b.status === 'cancelled')
            .map(enhanceBooking)
    };

    res.status(200).json(
        new ApiResponse(200, categorized, 'Bookings retrieved successfully')
    );
});

/**
 * Get booking by ID
 */
const getBookingById = asyncHandler(async (req, res) => {
    const userId = req.user?.userId || req.user?._id;
    const role = req.user?.role;
    const { id } = req.params;

    const booking = await bookingService.getBookingDetails(id, userId, role);

    res.status(200).json(
        new ApiResponse(200, booking, 'Booking details retrieved successfully')
    );
});

/**
 * Get booking status history
 */
const getBookingStatusHistory = asyncHandler(async (req, res) => {
    const userId = req.user?.userId || req.user?._id;
    const role = req.user?.role;
    const { id } = req.params;

    const history = await bookingService.getBookingStatusHistory(id, userId, role);

    res.status(200).json(
        new ApiResponse(200, history, 'Booking status history retrieved successfully')
    );
});

/**
 * Vendor specific booking detail (Alias for common logic but cleaner for vendor route)
 */
const getVendorBookingById = getBookingById;

/**
 * Get completed booking history for user
 */
const getCompletedHistory = asyncHandler(async (req, res) => {
    const userId = req.user?.userId;

    const bookings = await bookingService.getCompletedBookingsByUser(userId);

    res.status(200).json(
        new ApiResponse(200, bookings, 'Completed booking history retrieved successfully')
    );
});

/**
 * Retry vendor search
 */
const retrySearch = asyncHandler(async (req, res) => {
    const userId = req.user?.userId;
    const { id } = req.params;

    const result = await bookingService.retrySearchVendors(userId, id);

    res.status(200).json(
        new ApiResponse(200, result, 'Search retried successfully')
    );
});

/**
 * Vendor rejects a lead
 */
const rejectLead = asyncHandler(async (req, res) => {
    const vendorId = req.user?._id || req.user?.userId || req.body.vendorId;
    const { id } = req.params;

    const result = await bookingService.rejectLead(vendorId, id);

    res.status(200).json(
        new ApiResponse(200, result.booking, result.message)
    );
});

/**
 * Vendor marks a lead for later
 */
const markLeadLater = asyncHandler(async (req, res) => {
    const vendorId = req.user?._id || req.user?.userId || req.body.vendorId;
    const { id } = req.params;

    const result = await bookingService.markLeadLater(vendorId, id);

    res.status(200).json(
        new ApiResponse(200, result.booking, result.message)
    );
});

/**
 * Get vendor booking history (excluding pending_acceptance/Later)
 */
const getVendorHistory = asyncHandler(async (req, res) => {
    const vendorId = req.user?._id || req.user?.userId;

    const result = await bookingService.getVendorBookingHistory(vendorId);

    res.status(200).json(
        new ApiResponse(200, result, 'Vendor booking history retrieved successfully')
    );
});

/**
 * Get vendor later bookings list
 */
const getVendorLaterBookings = asyncHandler(async (req, res) => {
    const vendorId = req.user?._id || req.user?.userId;

    const result = await bookingService.getVendorLaterBookings(vendorId);

    res.status(200).json(
        new ApiResponse(200, result, 'Vendor later bookings retrieved successfully')
    );
});

/**
 * Vendor marks booking as On the Way
 */
const markOnTheWay = asyncHandler(async (req, res) => {
    const vendorId = req.user?._id || req.user?.userId || req.body.vendorId;
    const { id } = req.params;

    const result = await bookingService.markOnTheWay(vendorId, id);

    res.status(200).json(new ApiResponse(200, result.booking, result.message));
});

/**
 * Vendor marks booking as Arrived
 */
const markArrived = asyncHandler(async (req, res) => {
    const vendorId = req.user?._id || req.user?.userId || req.body.vendorId;
    const { id } = req.params;

    const result = await bookingService.markArrived(vendorId, id);

    res.status(200).json(new ApiResponse(200, result.booking, result.message));
});

/**
 * Vendor starts work (requires OTP)
 */
const startWork = asyncHandler(async (req, res) => {
    const vendorId = req.user?._id || req.user?.userId || req.body.vendorId;
    const { id } = req.params;
    const { otp } = req.body;

    const result = await bookingService.startWork(vendorId, id, otp);

    res.status(200).json(new ApiResponse(200, result.booking, result.message));
});

/**
 * Request Completion OTP
 */
const requestCompletionOTP = asyncHandler(async (req, res) => {
    const vendorId = req.user?._id || req.user?.userId || req.body.vendorId;
    const { id } = req.params;

    const result = await bookingService.requestCompletionOTP(vendorId, id);

    res.status(200).json(new ApiResponse(200, result.booking, result.message));
});

/**
 * Vendor completes work
 */
const completeWork = asyncHandler(async (req, res) => {
    const vendorId = req.user?._id || req.user?.userId || req.body.vendorId;
    const { id } = req.params;
    const { otp, paymentMethod } = req.body;

    const result = await bookingService.completeWork(vendorId, id, otp, paymentMethod);

    res.status(200).json(new ApiResponse(200, result.booking, result.message));
});

module.exports = {
    // Lead flow
    requestLead,
    acceptLead,
    rejectLead,
    markLeadLater,

    // Booking flow
    createBooking,
    cancelBooking,
    rescheduleBooking,
    getMyBookings,
    getBookingById,
    getCompletedHistory,
    getVendorHistory,
    getVendorLaterBookings,
    retrySearch,

    // Post-acceptance execution flow
    markOnTheWay,
    markArrived,
    startWork,
    requestCompletionOTP,
    completeWork,
    getVendorBookingById,
    getBookingStatusHistory
};
