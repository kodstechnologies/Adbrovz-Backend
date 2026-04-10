const express = require('express');
const router = express.Router();
const vendorController = require('./vendor.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');
const { upload, uploadToCloudinary } = require('../../middlewares/cloudinary.middleware');
const { uploadVendorDocs, processVendorDocs } = require('../../middlewares/vendorUpload.middleware');

// Debugging middleware
router.use((req, res, next) => {
    console.log(`🔍 [VENDOR REQ] ${req.method} ${req.originalUrl}`);
    if (Object.keys(req.params).length) console.log(`   Params:`, req.params);
    if (Object.keys(req.body).length) console.log(`   Body:`, JSON.stringify(req.body));
    next();
});

// Registration utility routes (Can be called during registration flow)
router.post('/get-membership', vendorController.getMembership);
router.get('/membership-plans', vendorController.getMembershipPlans);
router.get('/membership-detail', authenticate, authorize(ROLES.VENDOR), vendorController.getVendorMembership);
router.get('/membership-details', authenticate, authorize(ROLES.VENDOR), vendorController.getVendorMembership);
router.get('/:vendorId/membership-detail', authenticate, authorize(ROLES.ADMIN), vendorController.getVendorMembership);
router.post('/register/select-services', authenticate, authorize(ROLES.VENDOR), vendorController.selectServices);
router.post('/register/purchase-membership', authenticate, authorize(ROLES.VENDOR), vendorController.purchaseMembership);
router.post('/register/purchase-plan', authenticate, authorize(ROLES.VENDOR), vendorController.purchaseCreditPlan);
router.post('/register/:vendorId/select-services', authenticate, authorize(ROLES.ADMIN), vendorController.selectServices);
router.post('/register/:vendorId/purchase-membership', authenticate, authorize(ROLES.ADMIN), vendorController.purchaseMembership);
router.post('/register/:vendorId/purchase-plan', authenticate, authorize(ROLES.ADMIN), vendorController.purchaseCreditPlan);

// Membership create-order — vendorId is extracted from JWT token, NOT from URL
router.post('/membership/create-order', authenticate, authorize(ROLES.VENDOR), vendorController.createMembershipOrder);
router.post('/membership/create', authenticate, authorize(ROLES.VENDOR), vendorController.createMembership);

// Membership verify-payment — verifies Razorpay signature and activates membership
router.post('/membership/verify-payment', authenticate, authorize(ROLES.VENDOR), vendorController.verifyMembershipPayment);
router.post('/membership/verify', authenticate, authorize(ROLES.VENDOR), vendorController.verifyMembership);

// Service Renewal API
router.get('/renewal/fee', authenticate, authorize(ROLES.VENDOR), vendorController.getServiceRenewalFee);
router.post('/renewal/create-order', authenticate, authorize(ROLES.VENDOR), vendorController.createServiceRenewalOrder);
router.post('/renewal/verify-payment', authenticate, authorize(ROLES.VENDOR), vendorController.verifyServiceRenewalPayment);

// Membership Renewal API
router.get('/membership/renewal/fee', authenticate, authorize(ROLES.VENDOR), vendorController.getMembershipRenewalFee);
router.get('/membership/renewal/fee-no-gst', authenticate, authorize(ROLES.VENDOR), vendorController.getMembershipRenewalFeeNoGst);
router.get('/membership/hierarchical-charges', authenticate, authorize(ROLES.VENDOR), vendorController.getHierarchicalMembershipCharges);
router.get('/membership-plans-with-status', authenticate, authorize(ROLES.VENDOR), vendorController.getMembershipPlansWithStatus);
router.post('/membership/renewal/create-order', authenticate, authorize(ROLES.VENDOR), vendorController.createMembershipRenewalOrder);
router.post('/membership/renewal/createOrder', authenticate, authorize(ROLES.VENDOR), vendorController.createMembershipRenewalOrder);
router.post('/membership/renewal/verify-payment', authenticate, authorize(ROLES.VENDOR), vendorController.verifyMembershipRenewalPayment);
router.post('/membership/renewal/verify', authenticate, authorize(ROLES.VENDOR), vendorController.verifyMembershipRenewalPayment);

// Vendor status routes
router.patch('/status', authenticate, authorize(ROLES.VENDOR), vendorController.toggleOnlineStatus);
router.patch('/:vendorId/status', authenticate, authorize(ROLES.ADMIN), vendorController.toggleOnlineStatus);

// Profile routes
router.get('/profile', authenticate, authorize(ROLES.VENDOR), vendorController.getProfile);
router.get('/subscription-status', authenticate, authorize(ROLES.VENDOR), vendorController.getSubscriptionStatus);
router.get('/dashboard/metrics', authenticate, authorize(ROLES.VENDOR), vendorController.getDashboardMetrics);
router.get('/coins', authenticate, authorize(ROLES.VENDOR), vendorController.getCoins);
router.put('/profile', authenticate, authorize(ROLES.VENDOR), upload.single('image'), uploadToCloudinary('vendors'), vendorController.updateProfile);
router.put('/documents/reupload', authenticate, authorize(ROLES.VENDOR), uploadVendorDocs, processVendorDocs, vendorController.reuploadDocuments);
router.get('/verification-status', authenticate, authorize(ROLES.VENDOR), vendorController.getVerificationStatus);
router.delete('/account', authenticate, authorize(ROLES.VENDOR), vendorController.deleteAccount);


// Admin can also get profile by ID
router.get('/profile/:vendorId', authenticate, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), vendorController.getProfile);


// Public/Common routes
router.get('/plans', async (req, res) => {
    const CreditPlan = require('../../models/CreditPlan.model');
    const plans = await CreditPlan.find({});
    const ApiResponse = require('../../utils/ApiResponse');
    res.status(200).json(new ApiResponse(200, plans, 'Credit plans retrieved'));
});

// Admin only routes
router.use(authenticate);
router.use(authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN));

router.get('/', vendorController.getAllVendors);

module.exports = router;
