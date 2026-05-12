const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const vendorService = require('./vendor.service');
const { parseArrayInput } = require('../../utils/dataParser');

/**
 * Get all vendors (Admin)
 */
const getAllVendors = asyncHandler(async (req, res) => {
    const vendors = await vendorService.getAllVendors();
    res.status(200).json(
        new ApiResponse(200, vendors, 'Vendors retrieved successfully')
    );
});

/**
 * Get membership info for registration
 */
const getMembership = asyncHandler(async (req, res) => {
    const result = await vendorService.getMembershipInfo(req.body);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership info retrieved successfully')
    );
});

/**
 * Get vendor membership details
 */
const getVendorMembership = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getVendorMembershipDetails(vendorId, req.query);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership details retrieved successfully')
    );
});

/**
 * Create Razorpay order for membership
 */
const createMembershipOrder = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.createMembershipOrder(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership order created successfully')
    );
});

/**
 * Verify membership payment
 */
const verifyMembershipPayment = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.verifyMembershipPayment(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership payment verified successfully')
    );
});

/**
 * Step 3: Create Membership (Manual/Internal)
 */
const createMembership = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.purchaseMembership(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership created successfully')
    );
});

/**
 * Step 4: Verify Membership (Manual/Internal)
 */
const verifyMembership = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.purchaseMembership(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership verified successfully')
    );
});

/**
 * Step 2: Select services and calculate fee
 */
const selectServices = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.selectServices(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, 'Services selected and fee calculated successfully')
    );
});

/**
 * Step 3: Purchase Membership
 */
const purchaseMembership = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.purchaseMembership(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership purchased successfully')
    );
});

/**
 * Step 4: Purchase Credit Plan
 */
const purchaseCreditPlan = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.purchaseCreditPlan(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, 'Credit plan purchased successfully')
    );
});

/**
 * Toggle Online/Offline status
 */
const toggleOnlineStatus = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user.id || req.user._id;
    const { isOnline } = req.body;
    const result = await vendorService.toggleOnlineStatus(vendorId, isOnline);
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Get vendor profile
 */
const getProfile = asyncHandler(async (req, res) => {
    const vendorId = req.params.vendorId || req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getVendorProfile(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Profile retrieved successfully')
    );
});

/**
 * Get vendor coins
 */
const getCoins = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const vendor = await require('../../models/Vendor.model').findById(vendorId).select('coins');
    res.status(200).json(
        new ApiResponse(200, { coins: vendor.coins || 0 }, 'Coins retrieved successfully')
    );
});

/**
 * Update vendor profile
 */
const updateProfile = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    
    // If files are uploaded to Cloudinary, they will be in req.file.path or req.files
    const profileData = { ...req.body };
    if (req.file) {
        profileData.image = req.file.path;
    }
    
    const result = await vendorService.updateVendorProfile(vendorId, profileData);
    res.status(200).json(
        new ApiResponse(200, result, 'Profile updated successfully')
    );
});

/**
 * Get verification status
 */
const getVerificationStatus = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getVerificationStatus(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Verification status retrieved successfully')
    );
});

/**
 * Delete account request
 */
const deleteAccount = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.deleteVendorAccount(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Get dashboard metrics
 */
const getDashboardMetrics = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getDashboardMetrics(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Dashboard metrics retrieved successfully')
    );
});

/**
 * Get membership plans
 */
const getMembershipPlans = asyncHandler(async (req, res) => {
    const result = await vendorService.getMembershipPlans();
    res.status(200).json(
        new ApiResponse(200, result, 'Membership plans retrieved successfully')
    );
});

/**
 * Get category registration data
 */
const getCategoryRegistrationData = asyncHandler(async (req, res) => {
    const result = await vendorService.getCategoryRegistrationData();
    res.status(200).json(
        new ApiResponse(200, result, 'Category registration data retrieved successfully')
    );
});

/**
 * Reupload documents
 */
const reuploadDocuments = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.reuploadDocuments(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result.payload, result.payload.message)
    );
});

/**
 * Get subscription status
 */
const getSubscriptionStatus = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getSubscriptionStatus(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Subscription status retrieved successfully')
    );
});

/**
 * Service Renewal: Get fee details
 */
const getServiceRenewalFee = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getServiceRenewalFeeDetails(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Service renewal fee details retrieved successfully')
    );
});

/**
 * Service Renewal: Create order
 */
const createServiceRenewalOrder = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.createServiceRenewalOrder(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Service renewal order created successfully')
    );
});

/**
 * Service Renewal: Verify payment
 */
const verifyServiceRenewalPayment = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.verifyServiceRenewalPayment(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Membership Renewal: Get fee details
 */
const getMembershipRenewalFee = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getMembershipRenewalFeeDetails(vendorId, req.query);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership renewal fee details retrieved successfully')
    );
});

/**
 * Membership Renewal: Create order
 */
const createMembershipRenewalOrder = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.createMembershipRenewalOrder(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership renewal order created successfully')
    );
});

/**
 * Membership Renewal: Verify payment
 */
const verifyMembershipRenewalPayment = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.verifyMembershipRenewalPayment(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Membership Renewal: Get plans with status
 */
const getMembershipPlansWithStatusController = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getMembershipPlansWithStatus(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Membership plans with status retrieved successfully')
    );
});

/**
 * Membership Renewal: Get fee no GST
 */
const getMembershipRenewalFeeNoGstController = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getMembershipRenewalFeeNoGst(vendorId, req.query);
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Membership Renewal: Get hierarchical charges
 */
const getHierarchicalMembershipChargesController = asyncHandler(async (req, res) => {
    const vendorId = req.user.userId || req.user.id || req.user._id;
    const result = await vendorService.getHierarchicalMembershipCharges(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, 'Hierarchical charges retrieved successfully')
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
    const vendorId = req.body.vendorId || req.user.userId || req.user.id || req.user._id;
    const categories = await vendorService.getAvailablePurchaseCategories(vendorId);
    res.status(200).json(
        new ApiResponse(200, categories, 'Available categories fetched successfully')
    );
});

/**
 * POST /vendor/purchase-categories/payment-detail
 * Body: { serviceIds: ["id1", "id2", ...], vendorId: "optional-for-admins" }
 * Returns an itemised payment breakdown for the selected services.
 */
const getPurchasePaymentDetail = asyncHandler(async (req, res) => {
    const vendorId = req.body.vendorId || req.user.userId || req.user.id || req.user._id;

    // Accept array OR comma-separated string
    let { serviceIds } = req.body;
    if (typeof serviceIds === 'string') {
        serviceIds = serviceIds.split(',').map(s => s.trim()).filter(Boolean);
    }
    serviceIds = Array.isArray(serviceIds) ? serviceIds : [];

    const result = await vendorService.calculatePurchasePaymentDetail(vendorId, serviceIds);
    res.status(200).json(
        new ApiResponse(200, result, 'Purchase payment detail calculated successfully')
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
    getPurchasePaymentDetail,
    updateFcmToken,
};
