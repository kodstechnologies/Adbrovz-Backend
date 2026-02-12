const multer = require('multer');
const ApiError = require('../utils/ApiError');
const cloudinaryService = require('../services/cloudinary.service');

// Configure multer to store files in memory (for Cloudinary)
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    // Allow images only
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new ApiError(400, 'Only images are allowed'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

/**
 * Middleware to upload file to Cloudinary after multer processing
 * @param {string} folder - Cloudinary folder name (categories, subcategories, services)
 * @returns {Function} Express middleware
 */
const uploadToCloudinary = (folder) => {
    return async (req, res, next) => {
        if (!req.file) {
            return next();
        }

        try {
            // Upload to Cloudinary
            const result = await cloudinaryService.uploadToCloudinary(
                req.file.buffer,
                folder,
                null // Let Cloudinary generate public_id
            );

            // Replace file object with Cloudinary result
            req.file.cloudinary = {
                url: result.secure_url,
                public_id: result.public_id,
                width: result.width,
                height: result.height,
                format: result.format,
                bytes: result.bytes
            };

            // Store URL in req.body for easy access
            if (req.file.fieldname === 'icon') {
                req.body.icon = result.secure_url;
            } else if (req.file.fieldname === 'photo') {
                req.body.photo = result.secure_url;
            }

            next();
        } catch (error) {
            console.error('Cloudinary upload middleware error:', error);
            next(new ApiError(500, 'Failed to upload image to Cloudinary'));
        }
    };
};

/**
 * Middleware to handle multiple file uploads (if needed in future)
 */
const uploadMultipleToCloudinary = (folder, maxCount = 5) => {
    return async (req, res, next) => {
        if (!req.files || req.files.length === 0) {
            return next();
        }

        try {
            const uploadPromises = req.files.map(file =>
                cloudinaryService.uploadToCloudinary(file.buffer, folder)
            );

            const results = await Promise.all(uploadPromises);

            req.files = results.map((result, index) => ({
                ...req.files[index],
                cloudinary: {
                    url: result.secure_url,
                    public_id: result.public_id,
                    width: result.width,
                    height: result.height,
                    format: result.format,
                    bytes: result.bytes
                }
            }));

            next();
        } catch (error) {
            console.error('Cloudinary multiple upload error:', error);
            next(new ApiError(500, 'Failed to upload images to Cloudinary'));
        }
    };
};

module.exports = {
    upload,
    uploadToCloudinary,
    uploadMultipleToCloudinary
};
