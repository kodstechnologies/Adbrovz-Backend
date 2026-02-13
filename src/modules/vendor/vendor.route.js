const express = require('express');
const router = express.Router();
const vendorController = require('./vendor.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');

// Registration utility routes (Can be called during registration flow)
router.post('/register/:vendorId/select-services', vendorController.selectServices);
router.post('/register/:vendorId/purchase-membership', vendorController.purchaseMembership);
router.post('/register/:vendorId/purchase-plan', vendorController.purchaseCreditPlan);

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
