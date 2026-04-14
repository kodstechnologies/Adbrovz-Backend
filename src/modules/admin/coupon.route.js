const express = require('express');
const router = express.Router();
const couponController = require('./coupon.controller');

router.post('/', couponController.createCoupon);
router.get('/', couponController.getCoupons);
router.delete('/:id', couponController.deleteCoupon);

module.exports = router;
