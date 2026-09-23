const express = require('express');
const router = express.Router();
const couponController = require('./coupon.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');
const { upload, uploadToCloudinary } = require('../../middlewares/cloudinary.middleware');

router.post('/verify', authenticate, couponController.verifyCoupon);
router.post('/apply', authenticate, couponController.applyCoupon);

// Admin-only management routes
router.post('/', authenticate, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), upload.single('image'), uploadToCloudinary('coupons'), couponController.createCoupon);
router.get('/', authenticate, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), couponController.getCoupons);
router.get('/:id', authenticate, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), couponController.getCouponById);
router.patch('/:id', authenticate, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), upload.single('image'), uploadToCloudinary('coupons'), couponController.updateCoupon);
router.delete('/:id', authenticate, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), couponController.deleteCoupon);

module.exports = router;
