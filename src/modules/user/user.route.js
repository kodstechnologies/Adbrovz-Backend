const express = require('express');
const router = express.Router();
const userController = require('./user.controller');
const { authenticate } = require('../../middlewares/auth.middleware');
const { validateUpdateProfile } = require('../../validators/user.validator');

const { upload, uploadToCloudinary } = require('../../middlewares/cloudinary.middleware');

// All routes require authentication
router.use(authenticate);

router.get('/profile', userController.getProfile);
router.get('/coupons', userController.getMyCoupons);
router.post('/coupons/verify', userController.verifyCoupon);
router.post('/coupons/apply', userController.applyCoupon);
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
router.delete('/account', userController.deleteAccount);

module.exports = router;
