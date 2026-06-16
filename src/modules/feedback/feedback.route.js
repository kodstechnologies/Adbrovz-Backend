const express = require('express');
const router = express.Router();
const feedbackController = require('./feedback.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');

// User submits feedback for a completed booking
router.post('/', authenticate, authorize(ROLES.USER), feedbackController.submitFeedback);

// User checks if they already submitted feedback for a booking
router.get('/check/:bookingId', authenticate, authorize(ROLES.USER), feedbackController.checkFeedback);

// User sees all feedback they submitted
router.get('/my', authenticate, authorize(ROLES.USER), feedbackController.getMyFeedback);

// Get all feedback for a specific vendor (accessible by vendor, admin, or user)
router.get('/vendor/:vendorId', authenticate, feedbackController.getVendorFeedback);

// Admin and Sub-Admin see all feedback across the platform
router.get('/all', authenticate, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.SUB_ADMIN), feedbackController.getAllFeedback);

module.exports = router;
