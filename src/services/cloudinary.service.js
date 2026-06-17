const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

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
const generateFilename = (originalName = '', ext = '.jpg') => {
    const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(6).toString('hex');
    if (originalName && originalName.includes('.')) {
        const origExt = path.extname(originalName).toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(origExt)) {
            return `img_${uniqueSuffix}${origExt}`;
        }
    }
    return `img_${uniqueSuffix}${ext}`;
};

/**
 * Mock Cloudinary Result Object
 */
const createMockResult = (filename, size = 0, width = 800, height = 800) => {
    return {
        secure_url: `${CDN_BASE_URL}${filename}`,
        public_id: filename,
        width,
        height,
        format: path.extname(filename).replace('.', '') || 'jpg',
        bytes: size
    };
};

/**
 * Compress and resize an image buffer using sharp.
 * Non-image buffers (e.g. PDF) are returned unchanged.
 */
const compressImage = async (fileBuffer) => {
    try {
        const metadata = await sharp(fileBuffer).metadata();
        if (!metadata.format || metadata.format === 'svg') {
            return { buffer: fileBuffer, format: metadata.format, width: metadata.width, height: metadata.height };
        }

        const pipeline = sharp(fileBuffer)
            .rotate() // auto-rotate based on EXIF orientation
            .resize({
                width: 1920,
                height: 1920,
                fit: 'inside',
                withoutEnlargement: true
            })
            .jpeg({ quality: 80, mozjpeg: true });

        const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
        console.log(`[Image Compressor] Compressed: ${(fileBuffer.length / 1024).toFixed(1)}KB -> ${(info.size / 1024).toFixed(1)}KB (${metadata.format} -> jpeg, ${info.width}x${info.height})`);
        return { buffer: data, format: 'jpeg', width: info.width, height: info.height };
    } catch (err) {
        console.log(`[Image Compressor] Skipped (not an image or unsupported format): ${err.message}`);
        return { buffer: fileBuffer, format: null, width: null, height: null };
    }
};

/**
 * Upload file buffer locally (replacing Cloudinary) with automatic compression
 * @param {Buffer} fileBuffer - File buffer from multer
 * @param {string} folder - Ignored, all images go to root of CDN url
 * @param {string} publicId - Optional public ID
 * @returns {Promise<Object>} Mock Cloudinary upload result
 */
const uploadToCloudinary = async (fileBuffer, folder, publicId = null) => {
    try {
        const { buffer, format, width, height } = await compressImage(fileBuffer);
        const isImage = format !== null;
        const filename = publicId
            ? `${publicId}.${isImage ? 'jpg' : 'png'}`
            : generateFilename(null, isImage ? '.jpg' : '.png');
        const filePath = path.join(UPLOAD_DIR, filename);

        await fs.promises.writeFile(filePath, buffer);
        console.log(`[CDN Storage] Saved file locally to ${filePath}`);
        return createMockResult(filename, buffer.length, width || 800, height || 800);
    } catch (error) {
        console.error('Local upload error:', error);
        throw error;
    }
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
                // Check if they stored public_id without extension but exists with .jpg or .png
                const filePathJpg = filePath + '.jpg';
                const filePathPng = filePath + '.png';
                if (fs.existsSync(filePathJpg)) {
                    fs.unlink(filePathJpg, (err) => {
                        if (err) return reject(err);
                        resolve({ result: 'ok' });
                    });
                } else if (fs.existsSync(filePathPng)) {
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
