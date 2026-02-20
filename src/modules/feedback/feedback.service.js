const mongoose = require('mongoose');
const Feedback = require('../../models/Feedback.model');
const Booking = require('../../models/Booking.model');
const ApiError = require('../../utils/ApiError');

/**
 * Submit feedback for a completed booking
 */
const submitFeedback = async (userId, bookingId, { rating, review, vendorId }) => {
    // Verify booking exists and belongs to user
    const booking = await Booking.findOne({
        $or: [
            { _id: mongoose.isValidObjectId(bookingId) ? bookingId : null },
            { bookingID: bookingId }
        ].filter(q => q._id !== null || q.bookingID)
    });

    if (!booking) {
        throw new ApiError(404, 'Booking not found');
    }

    const resolvedBookingId = booking._id;

    // Verify user owns the booking
    if (String(booking.user) !== String(userId)) {
        throw new ApiError(403, 'Not authorized to submit feedback for this booking');
    }

    // Only allow feedback on completed bookings
    if (booking.status !== 'completed') {
        throw new ApiError(400, 'Feedback can only be submitted for completed bookings');
    }

    // Check if feedback already submitted
    const existing = await Feedback.findOne({ booking: resolvedBookingId, user: userId });
    if (existing) {
        throw new ApiError(400, 'Feedback already submitted for this booking');
    }

    // Use vendorId from body, or fall back to booking.vendor
    const resolvedVendorId = vendorId || booking.vendor;

    const feedback = await Feedback.create({
        booking: resolvedBookingId,
        user: userId,
        ...(resolvedVendorId && { vendor: resolvedVendorId }),
        rating,
        review: review || '',
    });

    return {
        id: feedback._id,
        rating: feedback.rating,
        review: feedback.review,
        createdAt: feedback.createdAt,
    };
};

/**
 * Get all feedback for a vendor (vendor-facing)
 */
const getVendorFeedback = async (vendorId) => {
    const feedbacks = await Feedback.find({ vendor: vendorId })
        .populate('user', 'name')
        .populate('booking', 'bookingID scheduledDate services')
        .sort({ createdAt: -1 });

    const totalRating = feedbacks.reduce((sum, f) => sum + f.rating, 0);
    const averageRating = feedbacks.length > 0 ? (totalRating / feedbacks.length).toFixed(1) : 0;

    return {
        averageRating: parseFloat(averageRating),
        totalReviews: feedbacks.length,
        feedbacks: feedbacks.map((f) => ({
            id: f._id,
            rating: f.rating,
            review: f.review,
            userName: f.user?.name || 'User',
            bookingId: f.booking?.bookingID,
            createdAt: f.createdAt,
        })),
    };
};

/**
 * Get feedback submitted by a user
 */
const getUserFeedback = async (userId) => {
    const feedbacks = await Feedback.find({ user: userId })
        .populate('vendor', 'name')
        .populate('booking', 'bookingID scheduledDate')
        .sort({ createdAt: -1 });

    return feedbacks.map((f) => ({
        id: f._id,
        rating: f.rating,
        review: f.review,
        vendorName: f.vendor?.name || 'Vendor',
        bookingId: f.booking?.bookingID,
        createdAt: f.createdAt,
    }));
};

/**
 * Check if user has already submitted feedback for a booking
 */
const hasFeedback = async (userId, bookingId) => {
    const booking = await Booking.findOne({
        $or: [
            { _id: mongoose.isValidObjectId(bookingId) ? bookingId : null },
            { bookingID: bookingId }
        ].filter(q => q._id !== null || q.bookingID)
    });

    if (!booking) {
        return { hasFeedback: false };
    }

    const existing = await Feedback.findOne({ booking: booking._id, user: userId });
    return { hasFeedback: !!existing };
};

module.exports = {
    submitFeedback,
    getVendorFeedback,
    getUserFeedback,
    hasFeedback,
};
