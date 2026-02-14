const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const disputeService = require('./dispute.service');

// Create Dispute
const createDispute = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    // evidence is now in req.body.evidence (array of URLs) from middleware
    const dispute = await disputeService.createDispute(userId, req.body);
    res.status(201).json(new ApiResponse(201, dispute, 'Dispute raised successfully'));
});

// Get My Disputes
const getMyDisputes = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const disputes = await disputeService.getUserDisputes(userId);
    res.status(200).json(new ApiResponse(200, disputes, 'Disputes retrieved successfully'));
});

// Get All Disputes (Admin)
const getAllDisputes = asyncHandler(async (req, res) => {
    const disputes = await disputeService.getAllDisputes(req.query);
    res.status(200).json(new ApiResponse(200, disputes, 'All disputes retrieved successfully'));
});

const updateDisputeStatus = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, adminComments, resolutionNotes } = req.body;
    const parsedResolutionNotes = typeof resolutionNotes === 'string' ? JSON.parse(resolutionNotes) : resolutionNotes;

    const dispute = await disputeService.updateDisputeStatus(id, { status, adminComments, resolutionNotes: parsedResolutionNotes });
    res.status(200).json(new ApiResponse(200, dispute, 'Dispute status updated successfully'));
});

module.exports = {
    createDispute,
    getMyDisputes,
    getAllDisputes,
    updateDisputeStatus
};
