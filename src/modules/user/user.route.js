const express = require('express');
const router = express.Router();
const userController = require('./user.controller');
const { authenticate } = require('../../middlewares/auth.middleware');
const { validateUpdateProfile } = require('../../validators/user.validator');

const { upload, uploadToCloudinary } = require('../../middlewares/cloudinary.middleware');

// All routes require authentication
router.use(authenticate);

router.get('/profile', userController.getProfile);
// Admin routes
router.get('/', userController.getUsers);
router.get('/:userId/coins', userController.getUserCoins);
router.patch(
    '/profile',
    upload.single('photo'),
    uploadToCloudinary('users'),
    validateUpdateProfile,
    userController.updateProfile
);
router.delete('/account', userController.deleteAccount);

module.exports = router;
