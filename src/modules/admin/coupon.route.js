const express = require('express');
const router = express.Router();
const couponController = require('./coupon.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');

router.post('/', authenticate, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), couponController.createCoupon);
router.get('/', authenticate, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), couponController.getCoupons);
router.delete('/:id', authenticate, authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN), couponController.deleteCoupon);

module.exports = router;
