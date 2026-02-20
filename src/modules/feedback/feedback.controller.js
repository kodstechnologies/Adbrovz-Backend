const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const feedbackService = require('./feedback.service');

/**
 * POST /api/v1/feedback
 * User submits feedback for a completed booking
 */
const submitFeedback = asyncHandler(async (req, res) => {
    const userId = req.body.userId || req.user.userId || req.user._id;
    const { bookingId, rating, review } = req.body;

    const result = await feedbackService.submitFeedback(userId, bookingId, { rating, review });

    res.status(201).json(new ApiResponse(201, result, 'Feedback submitted successfully'));
});

/**
 * GET /api/v1/feedback/vendor/:vendorId
 * Get all feedback for a vendor (public or vendor-only)
 */
const getVendorFeedback = asyncHandler(async (req, res) => {
    const { vendorId } = req.params;
    const result = await feedbackService.getVendorFeedback(vendorId);
    res.status(200).json(new ApiResponse(200, result, 'Vendor feedback fetched'));
});

/**
 * GET /api/v1/feedback/my
 * User sees their own submitted feedback
 */
const getMyFeedback = asyncHandler(async (req, res) => {
    const userId = req.user.userId || req.user._id;
    const result = await feedbackService.getUserFeedback(userId);
    res.status(200).json(new ApiResponse(200, result, 'My feedback fetched'));
});

/**
 * GET /api/v1/feedback/check/:bookingId
 * Check if user already submitted feedback for a booking
 */
const checkFeedback = asyncHandler(async (req, res) => {
    const userId = req.user.userId || req.user._id;
    const { bookingId } = req.params;
    const result = await feedbackService.hasFeedback(userId, bookingId);
    res.status(200).json(new ApiResponse(200, result, 'Feedback check done'));
});

module.exports = {
    submitFeedback,
    getVendorFeedback,
    getMyFeedback,
    checkFeedback,
};
