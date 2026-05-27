const express = require('express');
const router = express.Router();
const userController = require('./user.controller');
const couponController = require('../admin/coupon.controller');
const { authenticate, optionalAuth } = require('../../middlewares/auth.middleware');
const { validateUpdateProfile } = require('../../validators/user.validator');

const { upload, uploadToCloudinary } = require('../../middlewares/cloudinary.middleware');

// Public/Optional Auth status endpoint
router.get('/status', optionalAuth, userController.getUserStatus);

// All routes below require authentication
router.use(authenticate);

router.get('/profile', userController.getProfile);
router.get('/coupons', couponController.getMyCoupons);
router.post('/coupons/verify', couponController.verifyCoupon);
router.post('/coupons/apply', couponController.applyCoupon);
// Admin routes
router.get('/', userController.getUsers);
router.get('/:userId/coins', userController.getUserCoins);
router.put(
    '/profile',
    upload.single('image'),
    uploadToCloudinary('users'),
    validateUpdateProfile,
    userController.updateProfile
);
router.put('/fcm-token', userController.updateFcmToken);
router.get('/notifications', require('../notification/notification.controller').getNotifications);
router.delete('/account', userController.deleteAccount);

module.exports = router;
