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
    const data = { ...req.body };
    // If not in body, try to get from authenticated user
    if (!data.vendorId && req.user) {
        data.vendorId = req.user.userId || req.user.id || req.user._id;
    }

    const result = await vendorService.getMembershipInfo(data);
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

    // Support passing serviceIds or subcategoryIds in body or query for dynamic calculation
    const overrides = { ...req.body };
    if (req.query.serviceIds) {
        overrides.serviceIds = Array.isArray(req.query.serviceIds)
            ? req.query.serviceIds
            : req.query.serviceIds.split(',');
    }
    if (req.query.subcategoryIds) {
        overrides.subcategoryIds = Array.isArray(req.query.subcategoryIds)
            ? req.query.subcategoryIds
            : req.query.subcategoryIds.split(',');
    }
    if (req.query.categoryId) {
        overrides.categoryId = req.query.categoryId;
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
    const result = await vendorService.createMembershipOrder(vendorId, req.body);
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
    // Accept both membershipId and planId — the app may send either
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, membershipId, planId } = req.body;
    const result = await vendorService.verifyMembershipPayment(vendorId, {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        membershipId,
        planId,
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

/**
 * Get vendor verification status
 */
const getVerificationStatus = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId;
    const result = await vendorService.getVerificationStatus(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Verification status retrieved successfully')
    );
});

/**
 * Delete vendor account (Self-service)
 */
const deleteAccount = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.deleteVendorAccount(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Account deleted successfully')
    );
});

/**
 * Get vendor dashboard metrics
 */
const getDashboardMetrics = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const metrics = await vendorService.getDashboardMetrics(vendorId);
    res.status(200).json(
        new ApiResponse(200, metrics, 'Dashboard metrics retrieved successfully')
    );
});

/**
 * Get available membership plans
 */
const getMembershipPlans = asyncHandler(async (req, res) => {
    const vendorId = req.user?.userId || req.user?.id || req.user?._id || req.query.vendorId;
    const plans = await vendorService.getMembershipPlans(undefined, { vendorId });
    res.status(200).json(
        new ApiResponse(200, plans, 'Membership plans retrieved successfully')
    );
});

/**
 * Get all categories with subcategories and services for registration
 */
const getCategoryRegistrationData = asyncHandler(async (req, res) => {
    const data = await vendorService.getCategoryRegistrationData();
    res.status(200).json(
        new ApiResponse(200, data, 'Registration category data retrieved successfully')
    );
});

/**
 * Reupload rejected documents
 */
const reuploadDocuments = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    
    // Cloudinary middleware (uploadToCloudinary/processVendorDocs) places the URLs directly into req.body
    const result = await vendorService.reuploadDocuments(vendorId, req.body);
    
    res.status(200).json(
        new ApiResponse(200, result, 'Documents reuploaded successfully')
    );
});

/**
 * Get Subscription Status for Mobile App
 */
const getSubscriptionStatus = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getSubscriptionStatus(vendorId);
    res.status(200).json(result);
});

/**
 * Service Renewal: Get Fee Details
 */
const getServiceRenewalFee = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getServiceRenewalFeeDetails(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Service renewal fee retrieved successfully')
    );
});

/**
 * Service Renewal: Create Razorpay Order
 */
const createServiceRenewalOrder = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.createServiceRenewalOrder(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Service renewal order created successfully')
    );
});

/**
 * Service Renewal: Verify Payment
 */
const verifyServiceRenewalPayment = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const result = await vendorService.verifyServiceRenewalPayment(vendorId, {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
    });
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Membership Renewal: Get Fee Details
 */
const getMembershipRenewalFee = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const { durationMonths, planId } = req.query;
    const result = await vendorService.getMembershipRenewalFeeDetails(vendorId, { durationMonths, planId });
    res.status(200).json(
        new ApiResponse(200, result, 'Membership renewal fee retrieved successfully')
    );
});

/**
 * Membership Renewal: Create Razorpay Order
 */
const createMembershipRenewalOrder = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const { durationMonths, planId } = req.body;
    const result = await vendorService.createMembershipRenewalOrder(vendorId, { durationMonths, planId });
    res.status(200).json(
        new ApiResponse(200, result, 'Membership renewal order created successfully')
    );
});

/**
 * Membership Renewal: Verify Payment
 */
const verifyMembershipRenewalPayment = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, durationMonths, planId } = req.body;
    const result = await vendorService.verifyMembershipRenewalPayment(vendorId, {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        durationMonths,
        planId
    });
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});


/**
 * API 1: List all membership plans with vendor status (expiry and renewal totals)
 */
const getMembershipPlansWithStatusController = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getMembershipPlansWithStatus(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership plans with status retrieved successfully')
    );
});

/**
 * API 2: Renewal Membership without GST
 */
const getMembershipRenewalFeeNoGstController = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const { durationMonths } = req.query;
    const result = await vendorService.getMembershipRenewalFeeNoGst(vendorId, { durationMonths });
    res.status(200).json(
        new ApiResponse(200, result, 'Membership renewal fee (no GST) retrieved successfully')
    );
});

/**
 * API 3: Hierarchical Renewal Charges Only
 */
const getHierarchicalMembershipChargesController = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getHierarchicalMembershipCharges(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Hierarchical membership charges retrieved successfully')
    );
});

/**
 * Add Category: Get fee details
 */
const getAddCategoryFee = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getAddCategoryFeeDetails(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, 'Add category fee details retrieved successfully')
    );
});

/**
 * Add Category: Create Razorpay order
 */
const createAddCategoryOrder = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.createAddCategoryOrder(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, 'Add category payment order created successfully')
    );
});

/**
 * Add Category: Verify Payment
 */
const verifyAddCategoryPayment = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.verifyAddCategoryPayment(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Add Category: Direct Activation (Admin bypass)
 */
const activateAddCategory = asyncHandler(async (req, res) => {
    const { vendorId } = req.params;
    const { categoryId, subcategoryIds, serviceIds } = req.body;
    
    // Simulate a completed payment for direct activation
    const result = await vendorService.verifyAddCategoryPayment(vendorId, {
        razorpay_order_id: `admin_skip_${Date.now()}`,
        razorpay_payment_id: `admin_manual_${Date.now()}`,
        razorpay_signature: 'skipped_by_admin',
        isAdminBypass: true,
        categoryId,
        selectedSubcategories: subcategoryIds,
        selectedServices: serviceIds
    });

    res.status(200).json(
        new ApiResponse(200, result, 'Category activated successfully by admin')
    );
});

/**
 * Get available categories for purchase (Excluding already selected ones)
 */
const getPurchaseCategories = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const categories = await vendorService.getAvailablePurchaseCategories(vendorId);
    res.status(200).json(
        new ApiResponse(200, categories, 'Available categories fetched successfully')
    );
});

/**
 * Update FCM Token for push notifications
 */
const updateFcmToken = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const { fcmToken } = req.body;
    
    await require('../../models/Vendor.model').findByIdAndUpdate(vendorId, { fcmToken });
    res.status(200).json(
        new ApiResponse(200, null, 'FCM token updated successfully')
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
    getVerificationStatus,
    deleteAccount,
    getDashboardMetrics,
    getMembershipPlans,
    getCategoryRegistrationData,
    reuploadDocuments,
    getSubscriptionStatus,
    getServiceRenewalFee,
    createServiceRenewalOrder,
    verifyServiceRenewalPayment,
    getMembershipRenewalFee,
    createMembershipRenewalOrder,
    verifyMembershipRenewalPayment,
    getMembershipPlansWithStatus: getMembershipPlansWithStatusController,
    getMembershipRenewalFeeNoGst: getMembershipRenewalFeeNoGstController,
    getHierarchicalMembershipCharges: getHierarchicalMembershipChargesController,
    getAddCategoryFee,
    createAddCategoryOrder,
    verifyAddCategoryPayment,
    activateAddCategory,
    getPurchaseCategories,
    updateFcmToken,
};

