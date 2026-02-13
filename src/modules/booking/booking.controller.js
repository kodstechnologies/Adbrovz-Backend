const bookingService = require('./booking.service');
const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');

/**
 * Create a new service request (Lead)
 */
const requestLead = asyncHandler(async (req, res) => {
    const userId = req.user?._id || req.body.userId; // Support both for demo
    const result = await bookingService.requestLead(userId, req.body);
    res.status(201).json(
        new ApiResponse(201, result, 'Lead request created successfully')
    );
});

/**
 * Vendor accepts a lead
 */
const acceptLead = asyncHandler(async (req, res) => {
    const vendorId = req.user?._id || req.body.vendorId; // Support both for demo
    const { bookingId } = req.params;
    const result = await bookingService.acceptLead(vendorId, bookingId);
    res.status(200).json(
        new ApiResponse(200, result, 'Lead accepted successfully')
    );
});

module.exports = {
    requestLead,
    acceptLead
};
