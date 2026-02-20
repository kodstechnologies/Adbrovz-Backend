const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');
const config = require('../config/env');

// Configure Cloudinary
if (!config.CLOUDINARY_CLOUD_NAME || !config.CLOUDINARY_API_KEY || !config.CLOUDINARY_API_SECRET) {
    console.error('❌ Cloudinary configuration missing! Check your environment variables.');
}

cloudinary.config({
    cloud_name: config.CLOUDINARY_CLOUD_NAME,
    api_key: config.CLOUDINARY_API_KEY,
    api_secret: config.CLOUDINARY_API_SECRET,
});

/**
 * Upload file buffer to Cloudinary
 * @param {Buffer} fileBuffer - File buffer from multer
 * @param {string} folder - Folder path in Cloudinary (e.g., 'categories', 'subcategories', 'services')
 * @param {string} publicId - Optional public ID for the image
 * @returns {Promise<Object>} Cloudinary upload result
 */
const uploadToCloudinary = async (fileBuffer, folder, publicId = null) => {
    return new Promise((resolve, reject) => {
        const uploadOptions = {
            folder: `adbrovz/${folder}`,
            resource_type: 'auto',
            transformation: [
                { quality: 'auto' },
                { fetch_format: 'auto' }
            ]
        };

        if (publicId) {
            uploadOptions.public_id = publicId;
        }

        const uploadStream = cloudinary.uploader.upload_stream(
            uploadOptions,
            (error, result) => {
                if (error) {
                    console.error('Cloudinary upload error details:', JSON.stringify(error, null, 2));
                    reject(error);
                } else {
                    resolve(result);
                }
            }
        );

        // Convert buffer to stream and pipe to Cloudinary
        Readable.from(fileBuffer).pipe(uploadStream);
    });
};

/**
 * Upload file from path (for existing multer setup)
 * @param {string} filePath - Local file path
 * @param {string} folder - Folder path in Cloudinary
 * @param {string} publicId - Optional public ID
 * @returns {Promise<Object>} Cloudinary upload result
 */
const uploadFromPath = async (filePath, folder, publicId = null) => {
    const uploadOptions = {
        folder: `adbrovz/${folder}`,
        resource_type: 'auto',
        transformation: [
            { quality: 'auto' },
            { fetch_format: 'auto' }
        ]
    };

    if (publicId) {
        uploadOptions.public_id = publicId;
    }

    try {
        const result = await cloudinary.uploader.upload(filePath, uploadOptions);
        return result;
    } catch (error) {
        console.error('Cloudinary upload error:', error);
        throw error;
    }
};

/**
 * Delete image from Cloudinary
 * @param {string} publicId - Public ID of the image (can be full URL or just public_id)
 * @returns {Promise<Object>} Deletion result
 */
const deleteFromCloudinary = async (publicId) => {
    try {
        // Extract public_id from URL if full URL is provided
        let extractedPublicId = publicId;
        if (publicId.includes('cloudinary.com')) {
            // Extract public_id from URL
            const urlParts = publicId.split('/');
            const filename = urlParts[urlParts.length - 1];
            extractedPublicId = filename.split('.')[0];
            // Get folder path
            const folderIndex = urlParts.indexOf('adbrovz');
            if (folderIndex !== -1) {
                const folderParts = urlParts.slice(folderIndex + 1, -1);
                extractedPublicId = `adbrovz/${folderParts.join('/')}/${extractedPublicId}`;
            }
        }

        const result = await cloudinary.uploader.destroy(extractedPublicId);
        return result;
    } catch (error) {
        console.error('Cloudinary delete error:', error);
        throw error;
    }
};

/**
 * Get optimized image URL
 * @param {string} publicId - Public ID or URL
 * @param {Object} options - Transformation options
 * @returns {string} Optimized image URL
 */
const getOptimizedUrl = (publicId, options = {}) => {
    const defaultOptions = {
        quality: 'auto',
        fetch_format: 'auto',
        ...options
    };

    if (publicId.includes('cloudinary.com')) {
        // Already a URL, return as is (or apply transformations)
        return cloudinary.url(publicId, defaultOptions);
    }

    return cloudinary.url(publicId, defaultOptions);
};

module.exports = {
    uploadToCloudinary,
    uploadFromPath,
    deleteFromCloudinary,
    getOptimizedUrl,
    cloudinary
};
