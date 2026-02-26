const vendorService = require('./vendor.service');
const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');

/**
 * Get all vendors
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getAllVendors = asyncHandler(async (req, res) => {
    const vendors = await vendorService.getAllVendors();
    res.status(200).json(
        new ApiResponse(200, vendors, 'Vendors retrieved successfully')
    );
});

/**
 * Get membership info and total fee
 */
const getMembership = asyncHandler(async (req, res) => {
    const result = await vendorService.getMembershipInfo(req.body);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership details retrieved successfully')
    );
});

/**
 * Get membership info for a specific vendor
 */
const getVendorMembership = asyncHandler(async (req, res) => {
    // Extract vendorId from token if not in params
    const vendorId = req.params.vendorId || req.user.userId || req.user._id;
    console.log('DEBUG: getVendorMembership called for vendorId:', vendorId);

    // Support passing serviceIds in body or query for dynamic calculation
    const overrides = { ...req.body };
    if (req.query.serviceIds) {
        overrides.serviceIds = Array.isArray(req.query.serviceIds)
            ? req.query.serviceIds
            : req.query.serviceIds.split(',');
    }

    const result = await vendorService.getVendorMembershipDetails(vendorId, overrides);
    res.status(200).json(
        new ApiResponse(200, result, 'Vendor membership details retrieved successfully')
    );
});

/**
 * Select services and calculate fee
 */
const selectServices = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user._id;
    const result = await vendorService.selectServices(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, 'Services selected and price calculated')
    );
});

/**
 * Create Razorpay order for membership payment
 * vendorId is taken from token — NOT from URL
 */
const createMembershipOrder = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.createMembershipOrder(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership order created successfully')
    );
});

/**
 * Verify Razorpay payment for membership
 * vendorId from token; razorpay_* from body
 */
const verifyMembershipPayment = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const result = await vendorService.verifyMembershipPayment(vendorId, {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
    });
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Membership aliases - create and verify
 */
const createMembership = createMembershipOrder;
const verifyMembership = verifyMembershipPayment;


const purchaseMembership = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user._id;
    const result = await vendorService.purchaseMembership(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Purchase credit plan (Demo)
 */
const purchaseCreditPlan = asyncHandler(async (req, res) => {
    const { vendorId } = req.params;
    const result = await vendorService.purchaseCreditPlan(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Toggle online/offline status
 */
const toggleOnlineStatus = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user._id;
    const { isOnline } = req.body;
    const result = await vendorService.toggleOnlineStatus(vendorId, isOnline);
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Get logged-in vendor profile
 */
const getProfile = asyncHandler(async (req, res) => {
    // If vendorId is provided in params (admin use case), use it. Otherwise use logged-in user.
    const vendorId = req.params.vendorId || req.user.userId;
    const profile = await vendorService.getVendorProfile(vendorId);
    res.status(200).json(
        new ApiResponse(200, profile, 'Vendor profile retrieved successfully')
    );
});

/**
 * Get vendor coins balance
 */
const getCoins = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId;
    const vendor = await require('../../models/Vendor.model').findById(vendorId);
    if (!vendor) {
        const ApiError = require('../../utils/ApiError');
        throw new ApiError(404, 'Vendor not found');
    }
    res.status(200).json(
        new ApiResponse(200, { coins: vendor.coins || 0 }, 'Vendor coins retrieved successfully')
    );
});

/**
 * Update logged-in vendor profile
 */
const updateProfile = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId;
    const data = { ...req.body };

    if (req.file && req.file.cloudinary) {
        data.image = req.file.cloudinary.url;
    }

    const profile = await vendorService.updateVendorProfile(vendorId, data);
    res.status(200).json(
        new ApiResponse(200, profile, 'Vendor profile updated successfully')
    );
});

module.exports = {
    getAllVendors,
    getMembership,
    getVendorMembership,
    createMembershipOrder,
    verifyMembershipPayment,
    createMembership,
    verifyMembership,
    selectServices,
    purchaseMembership,
    purchaseCreditPlan,
    toggleOnlineStatus,
    getProfile,
    getCoins,
    updateProfile,
};

