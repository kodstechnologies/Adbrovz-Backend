const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// We no longer need the actual cloudinary module, but we export an empty object 
// in case any service expects it to exist.
const cloudinary = {}; 

const CDN_BASE_URL = 'http://cdn.adbrovz.tech/cdn/images/';
const UPLOAD_DIR = path.join(__dirname, '../../uploads/images');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Generate a unique filename
 */
const generateFilename = (originalName = '') => {
    const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(6).toString('hex');
    let ext = '';
    // Try to extract extension if originalName is provided, otherwise default to .png
    if (originalName && originalName.includes('.')) {
        ext = path.extname(originalName);
    }
    if (!ext) {
        ext = '.png'; // Default to png for buffers without name
    }
    return `img_${uniqueSuffix}${ext}`;
};

/**
 * Mock Cloudinary Result Object
 */
const createMockResult = (filename, size = 0) => {
    return {
        secure_url: `${CDN_BASE_URL}${filename}`,
        public_id: filename,
        width: 800, // mock width
        height: 800, // mock height
        format: path.extname(filename).replace('.', '') || 'png',
        bytes: size
    };
};

/**
 * Upload file buffer locally (replacing Cloudinary)
 * @param {Buffer} fileBuffer - File buffer from multer
 * @param {string} folder - Ignored, all images go to root of CDN url
 * @param {string} publicId - Optional public ID
 * @returns {Promise<Object>} Mock Cloudinary upload result
 */
const uploadToCloudinary = async (fileBuffer, folder, publicId = null) => {
    return new Promise((resolve, reject) => {
        try {
            const filename = publicId ? `${publicId}.png` : generateFilename();
            const filePath = path.join(UPLOAD_DIR, filename);

            fs.writeFile(filePath, fileBuffer, (err) => {
                if (err) {
                    console.error('Local upload error:', err);
                    return reject(err);
                }
                console.log(`[CDN Storage] Saved file locally to ${filePath}`);
                resolve(createMockResult(filename, fileBuffer.length));
            });
        } catch (error) {
            reject(error);
        }
    });
};

/**
 * Upload file from path locally (replacing Cloudinary)
 * @param {string} filePath - Local file path
 * @param {string} folder - Ignored
 * @param {string} publicId - Optional public ID
 * @returns {Promise<Object>} Mock Cloudinary upload result
 */
const uploadFromPath = async (filePath, folder, publicId = null) => {
    return new Promise((resolve, reject) => {
        try {
            const originalName = path.basename(filePath);
            const filename = publicId ? `${publicId}${path.extname(originalName)}` : generateFilename(originalName);
            const destPath = path.join(UPLOAD_DIR, filename);

            fs.copyFile(filePath, destPath, (err) => {
                if (err) {
                    console.error('Local file copy error:', err);
                    return reject(err);
                }
                
                // Get file stats for size
                fs.stat(destPath, (err, stats) => {
                    resolve(createMockResult(filename, stats ? stats.size : 0));
                });
            });
        } catch (error) {
            reject(error);
        }
    });
};

/**
 * Delete image locally (replacing Cloudinary)
 * @param {string} publicId - Public ID of the image (can be full URL or just public_id)
 * @returns {Promise<Object>} Deletion result
 */
const deleteFromCloudinary = async (publicId) => {
    return new Promise((resolve, reject) => {
        try {
            let filename = publicId;
            if (publicId.includes('/')) {
                const parts = publicId.split('/');
                filename = parts[parts.length - 1];
            }
            
            const filePath = path.join(UPLOAD_DIR, filename);
            
            if (fs.existsSync(filePath)) {
                fs.unlink(filePath, (err) => {
                    if (err) {
                        console.error('Local delete error:', err);
                        return reject(err);
                    }
                    resolve({ result: 'ok' });
                });
            } else {
                // Check if they stored public_id without extension but it exists with .png
                const filePathPng = filePath + '.png';
                if (fs.existsSync(filePathPng)) {
                    fs.unlink(filePathPng, (err) => {
                        if (err) return reject(err);
                        resolve({ result: 'ok' });
                    });
                } else {
                    resolve({ result: 'not found' });
                }
            }
        } catch (error) {
            reject(error);
        }
    });
};

/**
 * Get optimized image URL
 * @param {string} publicId - Public ID or URL
 * @param {Object} options - Ignored options
 * @returns {string} Image URL
 */
const getOptimizedUrl = (publicId, options = {}) => {
    let filename = publicId;
    if (publicId.includes('/')) {
        const parts = publicId.split('/');
        filename = parts[parts.length - 1];
    }
    return `${CDN_BASE_URL}${filename}`;
};

module.exports = {
    uploadToCloudinary,
    uploadFromPath,
    deleteFromCloudinary,
    getOptimizedUrl,
    cloudinary
};
