const express = require('express');
const router = express.Router();
const disputeController = require('./dispute.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const uploadDisputeEvidence = require('../../middlewares/disputeUpload.middleware');
const { ROLES } = require('../../constants/roles');

// Protected routes
router.use(authenticate);

// User Routes
router.post('/',
    uploadDisputeEvidence.upload.array('evidence', 5),
    uploadDisputeEvidence.uploadToCloudinary,
    disputeController.createDispute
);
router.patch('/:id/reupload-evidence',
    uploadDisputeEvidence.upload.array('evidence', 5),
    uploadDisputeEvidence.uploadToCloudinary,
    disputeController.reuploadEvidence
);
router.get('/my-disputes', disputeController.getMyDisputes);
router.get('/booking/:bookingId', disputeController.getDisputeByBookingId);

// Admin Routes
router.get('/admin/all', authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), disputeController.getAllDisputes);
router.patch('/:id/status', authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), disputeController.updateDisputeStatus);

module.exports = router;
