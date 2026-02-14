const Dispute = require('../../models/Dispute.model');
const Booking = require('../../models/Booking.model');
const ApiError = require('../../utils/ApiError');

// Create a new dispute
const createDispute = async (userId, disputeData) => {
    const { bookingId, reason, description } = disputeData;

    // Check if booking exists
    const booking = await Booking.findOne({ _id: bookingId, user: userId });
    if (!booking) {
        throw new ApiError(404, 'Booking not found or does not belong to user');
    }

    // Check availability: Booking must be COMPLETED or CANCELLED
    // User requested "completed" specifically, but usually disputes happen on cancellations too.
    // Sticking to user request: "for userr ,complted booking they can disputre"
    if (booking.status !== 'completed') {
        throw new ApiError(400, 'Disputes can only be raised for completed bookings');
    }

    // Check if dispute already exists
    const existingDispute = await Dispute.findOne({ booking: bookingId });
    if (existingDispute) {
        throw new ApiError(400, 'A dispute already exists for this booking');
    }

    // Process files (already uploaded to Cloudinary, URLs in disputeData.evidence)
    const evidence = disputeData.evidence || [];

    const dispute = await Dispute.create({
        booking: bookingId,
        raisedBy: userId,
        vendor: booking.vendor || undefined, // Some bookings might not have vendor assigned if cancelled early, but completed usually has.
        reason,
        description,
        evidence,
        status: 'OPEN'
    });

    return dispute;
};

// Get user disputes
const getUserDisputes = async (userId) => {
    return await Dispute.find({ raisedBy: userId })
        .populate('booking', 'bookingID date time status')
        .sort({ createdAt: -1 });
};

// Get all disputes (Admin)
const getAllDisputes = async (query) => {
    const { status, page = 1, limit = 10 } = query;
    const filter = {};
    if (status) {
        filter.status = status;
    }

    const skip = (page - 1) * limit;

    const disputes = await Dispute.find(filter)
        .populate('booking', 'bookingID')
        .populate('raisedBy', 'name phoneNumber')
        .populate('vendor', 'name phoneNumber')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

    const total = await Dispute.countDocuments(filter);

    return {
        disputes,
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit)
    };
};

// Update Dispute Status (Admin)
const updateDisputeStatus = async (disputeId, updateData) => {
    const { status, adminComments, resolutionNotes } = updateData;

    const dispute = await Dispute.findById(disputeId);
    if (!dispute) {
        throw new ApiError(404, 'Dispute not found');
    }

    if (status) dispute.status = status;
    if (adminComments) dispute.adminComments = adminComments;
    if (resolutionNotes) dispute.resolutionNotes = resolutionNotes;

    if (status === 'RESOLVED' && !dispute.resolvedAt) {
        dispute.resolvedAt = new Date();
        // dispute.resolvedBy = adminId; // If we had adminId passed
    }

    await dispute.save();
    return dispute;
};

module.exports = {
    createDispute,
    getUserDisputes,
    getAllDisputes,
    updateDisputeStatus
};
