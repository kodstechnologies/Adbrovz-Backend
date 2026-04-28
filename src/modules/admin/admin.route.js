const express = require('express');
const router = express.Router();
const adminController = require('./admin.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');

// All routes require admin authentication
router.use((req, res, next) => {
    console.log(`🔍 [ADMIN REQ] ${req.method} ${req.originalUrl}`);
    if (Object.keys(req.params).length) console.log(`   Params:`, req.params);
    if (Object.keys(req.body).length) console.log(`   Body:`, JSON.stringify(req.body));
    next();
});

// Coupon management - mounted before global admin auth to allow role-based access within the module
const couponRoutes = require('./coupon.route');
router.use('/coupons', couponRoutes);

router.use(authenticate);
router.use(authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.SUB_ADMIN));

router.get('/dashboard', adminController.getDashboard);
router.get('/users', adminController.getUsers);
router.patch('/users/:userId/status', adminController.updateUserStatus);
router.delete('/users/:userId', adminController.deleteUser);


// Transactions
router.get('/transactions', adminController.getGlobalTransactions);

// Credit Plan management routes
router.post('/credit-plans', adminController.createCreditPlan);
router.get('/credit-plans', adminController.getCreditPlans);
router.patch('/credit-plans/:planId', adminController.updateCreditPlan);
router.delete('/credit-plans/:planId', adminController.deleteCreditPlan);

// Vendor management
router.patch('/vendors/:vendorId/verify', adminController.verifyVendor);
router.patch('/vendors/:vendorId/verify-document', adminController.verifyVendorDocument);
router.patch('/vendors/:vendorId/verify-all', adminController.verifyAllVendorDocuments);
router.patch('/vendors/:vendorId/toggle-suspension', adminController.toggleVendorSuspension);
router.patch('/vendors/:vendorId/reject', adminController.rejectVendorAccount);
router.get  ('/vendors/eligible', adminController.getEligibleVendors);
router.get('/vendors/:vendorId/payment-history', adminController.getVendorPaymentHistory);
router.post('/vendors/:vendorId/deletion-request', adminController.respondToVendorDeletionRequest);

// Global Settings management
router.get('/settings', adminController.getGlobalSettings);
router.patch('/settings', adminController.updateGlobalSettings);

// Membership Pricing management
router.get('/membership-pricing', adminController.getMembershipPricing);
router.patch('/membership-pricing', adminController.updateMembershipPricing);

// Bookings management
router.get('/bookings/export', adminController.exportBookings);
router.get('/bookings', adminController.getAllBookings);
router.get('/bookings/:id', adminController.getBookingDetails);

// Sub-Admin management
router.post('/sub-admins', adminController.createSubAdmin);
router.get('/sub-admins', adminController.getSubAdmins);
router.put('/sub-admins/:id', adminController.updateSubAdmin);
router.delete('/sub-admins/:id', adminController.deleteSubAdmin);

module.exports = router;

