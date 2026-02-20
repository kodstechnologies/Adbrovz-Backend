const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');
const config = require('../config/env');

// Log Cloudinary initialization status at startup
const _initCloudName = process.env.CLOUDINARY_CLOUD_NAME || config.CLOUDINARY_CLOUD_NAME;
const _initApiKey = process.env.CLOUDINARY_API_KEY || config.CLOUDINARY_API_KEY;
const _initApiSecret = process.env.CLOUDINARY_API_SECRET || config.CLOUDINARY_API_SECRET;

if (!_initCloudName || !_initApiKey || !_initApiSecret) {
    console.error('❌ Cloudinary ENV MISSING at startup! cloud_name:', !!_initCloudName, 'api_key:', !!_initApiKey, 'api_secret:', !!_initApiSecret);
} else {
    console.log('✅ Cloudinary ENV OK at startup with cloud_name:', _initCloudName);
}

cloudinary.config({
    cloud_name: _initCloudName,
    api_key: _initApiKey,
    api_secret: _initApiSecret,
});

/**
 * Helper to get fresh Cloudinary credentials at runtime.
 * This is critical for Render, where env vars may not be loaded at module-init time.
 */
const getCloudinaryCredentials = () => {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME || config.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY || config.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET || config.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
        throw new Error(
            `Cloudinary credentials missing at runtime: cloud_name=${!!cloudName}, api_key=${!!apiKey}, api_secret=${!!apiSecret}. Check your Render Environment Variables.`
        );
    }

    // Force re-configure every time to guarantee fresh credentials
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });

    return { cloudName, apiKey, apiSecret };
};

/**
 * Upload file buffer to Cloudinary
 * @param {Buffer} fileBuffer - File buffer from multer
 * @param {string} folder - Folder path in Cloudinary (e.g., 'categories', 'subcategories', 'services')
 * @param {string} publicId - Optional public ID for the image
 * @returns {Promise<Object>} Cloudinary upload result
 */
const uploadToCloudinary = async (fileBuffer, folder, publicId = null) => {
    return new Promise((resolve, reject) => {
        try {
            // Reinitialize credentials at runtime (Render fix)
            getCloudinaryCredentials();
        } catch (err) {
            return reject(err);
        }

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
                    console.error('Cloudinary upload stream callback error:', JSON.stringify(error));
                    reject(error);
                } else {
                    console.log('Cloudinary upload stream success!');
                    resolve(result);
                }
            }
        );

        // Convert buffer to stream and pipe to Cloudinary
        console.log('DEBUG: piping buffer to cloudinary upload stream...');
        const stream = Readable.from(fileBuffer);
        stream.on('error', (err) => {
            console.error('Buffer stream internal error:', err);
            reject(err);
        });
        stream.pipe(uploadStream);
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
    // Reinitialize credentials at runtime (Render fix)
    getCloudinaryCredentials();

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
        console.error('Cloudinary upload error:', JSON.stringify(error));
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
        let extractedPublicId = publicId;
        if (publicId.includes('cloudinary.com')) {
            const urlParts = publicId.split('/');
            const filename = urlParts[urlParts.length - 1];
            extractedPublicId = filename.split('.')[0];
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

    return cloudinary.url(publicId, defaultOptions);
};

module.exports = {
    uploadToCloudinary,
    uploadFromPath,
    deleteFromCloudinary,
    getOptimizedUrl,
    cloudinary
};
