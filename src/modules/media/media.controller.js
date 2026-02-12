const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');

/**
 * Upload a single image
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const uploadImage = asyncHandler(async (req, res) => {
    if (!req.file || !req.file.cloudinary) {
        throw new ApiError(400, 'Image upload failed or no image provided');
    }

    res.status(200).json(
        new ApiResponse(200, {
            url: req.file.cloudinary.url,
            public_id: req.file.cloudinary.public_id,
            format: req.file.cloudinary.format,
            bytes: req.file.cloudinary.bytes
        }, 'Image uploaded successfully')
    );
});

module.exports = {
    uploadImage
};
