const express = require('express');
const router = express.Router();
const mediaController = require('./media.controller');
const { upload, uploadToCloudinary } = require('../../middlewares/cloudinary.middleware');

// Upload single image
// Field name should be 'image'
router.post('/upload',
    upload.single('image'),
    uploadToCloudinary('media'),
    mediaController.uploadImage
);

module.exports = router;
