const multer = require('multer');
const ApiError = require('../utils/ApiError');
const cloudinaryService = require('../services/cloudinary.service');

// Use memory storage for Cloudinary upload
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        console.log(`[DEBUG] Object upload rejected. Mimetype was: ${file.mimetype}`);
        cb(new ApiError(400, 'Only images (.jpg, .png, .webp) and PDF documents are allowed'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

const uploadToCloudinary = async (req, res, next) => {
    if (!req.files || req.files.length === 0) {
        return next();
    }

    try {
        const uploadPromises = req.files.map(file =>
            cloudinaryService.uploadToCloudinary(file.buffer, 'disputes')
        );

        const results = await Promise.all(uploadPromises);

        // Attach Cloudinary URLs to the request object
        req.body.evidence = results.map(result => result.secure_url);

        next();
    } catch (error) {
        console.error('Dispute upload error:', error);
        next(new ApiError(500, 'Failed to upload dispute evidence'));
    }
};

module.exports = {
    upload,
    uploadToCloudinary
};
