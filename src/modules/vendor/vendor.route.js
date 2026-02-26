const express = require('express');
const router = express.Router();
const vendorController = require('./vendor.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');
const { upload, uploadToCloudinary } = require('../../middlewares/cloudinary.middleware');

// Debugging middleware
router.use((req, res, next) => {
    console.log(`DEBUG: Vendor Route - ${req.method} ${req.originalUrl}`);
    next();
});

// Registration utility routes (Can be called during registration flow)
router.post('/get-membership', vendorController.getMembership);
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

// Vendor status routes
// Vendor status routes
router.patch('/status', authenticate, authorize(ROLES.VENDOR), vendorController.toggleOnlineStatus);
router.patch('/:vendorId/status', authenticate, authorize(ROLES.ADMIN), vendorController.toggleOnlineStatus);

// Profile routes
router.get('/profile', authenticate, authorize(ROLES.VENDOR), vendorController.getProfile);
router.put('/profile', authenticate, authorize(ROLES.VENDOR), upload.single('image'), uploadToCloudinary('vendors'), vendorController.updateProfile);

// Admin can also get profile by ID
router.get('/profile/:vendorId', authenticate, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), vendorController.getProfile);


// Public/Common routes
router.get('/plans', async (req, res) => {
    const CreditPlan = require('../../models/CreditPlan.model');
    const plans = await CreditPlan.find({ isActive: true });
    const ApiResponse = require('../../utils/ApiResponse');
    res.status(200).json(new ApiResponse(200, plans, 'Credit plans retrieved'));
});

// Admin only routes
router.use(authenticate);
router.use(authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN));

router.get('/', vendorController.getAllVendors);

module.exports = router;
