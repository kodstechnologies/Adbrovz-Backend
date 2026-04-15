const express = require('express');
const router = express.Router();
const couponController = require('./coupon.controller');
const { authenticate } = require('../../middlewares/auth.middleware');

router.post('/', authenticate, couponController.createCoupon);
router.get('/', authenticate, couponController.getCoupons);
router.delete('/:id', authenticate, couponController.deleteCoupon);
router.post('/verify', couponController.verifyCoupon);
router.post('/apply', couponController.applyCoupon);

module.exports = router;
