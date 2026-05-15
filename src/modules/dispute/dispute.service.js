const Dispute = require('../../models/Dispute.model');
const Booking = require('../../models/Booking.model');
const ApiError = require('../../utils/ApiError');
const { sendPush } = require('../../utils/pushNotification');

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

// Get dispute by booking ID for a specific user
const getDisputeByBookingId = async (userId, bookingId) => {
    const dispute = await Dispute.findOne({ raisedBy: userId, booking: bookingId })
        .populate('booking', 'bookingID date time status')
        .populate('vendor', 'name phoneNumber');

    if (!dispute) {
        throw new ApiError(404, 'Dispute not found for this booking');
    }
    
    return dispute;
};

// Reupload evidence or submit response for a dispute
const reuploadEvidence = async (userId, disputeId, { evidence, userComment }) => {
    const dispute = await Dispute.findOne({ _id: disputeId, raisedBy: userId });
    
    if (!dispute) {
        throw new ApiError(404, 'Dispute not found or does not belong to you');
    }

    if (dispute.status !== 'REOPENED') {
        throw new ApiError(400, 'You can only submit a response if the dispute is REOPENED by the admin');
    }

    if ((!evidence || evidence.length === 0) && !userComment) {
        throw new ApiError(400, 'Please provide new evidence or a comment to submit');
    }

    // Update evidence if provided
    if (evidence && evidence.length > 0) {
        dispute.evidence = evidence;
    }

    // Update user comment if provided
    if (userComment) {
        dispute.userComment = userComment;
    }

    // Set status back to OPEN so admin can review again
    dispute.status = 'OPEN';
    
    await dispute.save();

    // Notify Admin (optional, but good for flow)
    // sendPush(adminId, 'Admin', 'dispute_updated', 'Dispute Updated', `User has submitted evidence for dispute ${dispute._id}`);

    return dispute;
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

    if (status !== undefined) dispute.status = status;
    if (adminComments !== undefined) dispute.adminComments = adminComments;
    
    if (resolutionNotes !== undefined) {
        // Merge with existing notes to avoid overwriting (e.g. if only userNote is sent)
        dispute.resolutionNotes = {
            userNote: resolutionNotes.userNote !== undefined ? resolutionNotes.userNote : dispute.resolutionNotes?.userNote,
            vendorNote: resolutionNotes.vendorNote !== undefined ? resolutionNotes.vendorNote : dispute.resolutionNotes?.vendorNote
        };
    }

    if (status === 'RESOLVED' && !dispute.resolvedAt) {
        dispute.resolvedAt = new Date();
        // Clear evidence images once resolved
        dispute.evidence = [];
        // dispute.resolvedBy = adminId; // If we had adminId passed
    }

    await dispute.save();

    // Notify User
    let userTitle = 'Dispute Update';
    let userBody = `Your dispute status has been updated to ${status}.`;
    if (status === 'REOPENED') {
        userTitle = 'Dispute Reopened';
        userBody = `Your dispute has been reopened by the admin: "${resolutionNotes?.userNote || 'Please provide more details.'}"`;
    } else if (status === 'RESOLVED') {
        userTitle = 'Dispute Resolved';
        userBody = `Your dispute has been resolved by the admin.`;
    }
    
    sendPush(dispute.raisedBy, 'User', 'dispute_update', userTitle, userBody, { disputeId: dispute._id.toString(), status });

    // Notify Vendor if involved
    if (dispute.vendor) {
        let vendorTitle = 'Dispute Update';
        let vendorBody = `The dispute for booking ${dispute.booking?.bookingID || ''} status is now ${status}.`;
        
        sendPush(dispute.vendor, 'Vendor', 'dispute_update', vendorTitle, vendorBody, { disputeId: dispute._id.toString(), status });
    }
    
    // Return populated dispute so frontend reflects details correctly
    return await Dispute.findById(dispute._id)
        .populate('booking', 'bookingID')
        .populate('raisedBy', 'name phoneNumber')
        .populate('vendor', 'name phoneNumber');
};

module.exports = {
    createDispute,
    getUserDisputes,
    getDisputeByBookingId,
    reuploadEvidence,
    getAllDisputes,
    updateDisputeStatus
};
