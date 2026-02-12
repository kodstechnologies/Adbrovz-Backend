const express = require('express');
const router = express.Router();
const adminController = require('./admin.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');

// All routes require admin authentication
router.use(authenticate);
router.use(authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN));

router.get('/dashboard', adminController.getDashboard);
router.get('/users', adminController.getUsers);
router.patch('/users/:userId/status', adminController.updateUserStatus);

// Audit log routes
router.get('/audit-logs/user/:userId', adminController.getUserAuditLogs);
router.get('/audit-logs/action/:action', adminController.getAuditLogsByAction);

// Credit Plan management routes
router.post('/credit-plans', adminController.createCreditPlan);
router.get('/credit-plans', adminController.getCreditPlans);
router.patch('/credit-plans/:planId', adminController.updateCreditPlan);
router.delete('/credit-plans/:planId', adminController.deleteCreditPlan);

module.exports = router;

