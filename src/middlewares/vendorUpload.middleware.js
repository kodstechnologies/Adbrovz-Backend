const multer = require('multer');
const ApiError = require('../utils/ApiError');
const cloudinaryService = require('../services/cloudinary.service');

// Use memory storage for Cloudinary upload
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new ApiError(400, 'Only images and PDF documents are allowed'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

// Use upload.any() to be flexible as per user request ("store whatever data")
const uploadVendorDocs = upload.any();

const processVendorDocs = async (req, res, next) => {
    // Helper: parse stringified JSON array fields (always runs, even with no files)
    const parseJsonFields = () => {
        const jsonFields = ['workPincodes', 'selectedCategories', 'selectedSubcategories', 'selectedServices'];
        jsonFields.forEach(field => {
            const value = req.body[field];
            if (!value) return;
            try {
                if (typeof value === 'string') {
                    // Case 1: Single string that is a JSON array e.g. '["id1","id2"]'
                    if (value.trim().startsWith('[') || value.trim().startsWith('{')) {
                        req.body[field] = JSON.parse(value);
                    } else if (value.includes(',')) {
                        // Case 2: Comma-separated values e.g. "id1,id2"
                        req.body[field] = value.split(',').map(item => item.trim());
                    }
                } else if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
                    // Case 3: Multer wrapped the JSON string in an array e.g. ['["id1","id2"]']
                    const firstItem = value[0].trim();
                    if (firstItem.startsWith('[') || firstItem.startsWith('{')) {
                        req.body[field] = JSON.parse(firstItem);
                    }
                }
                console.log(`[DEBUG] Parsed field ${field}:`, req.body[field]);
            } catch (e) {
                console.error(`[DEBUG] Failed to parse field ${field}:`, e.message);
            }
        });
    };

    // No files uploaded — just parse JSON fields and continue
    if (!req.files || req.files.length === 0) {
        parseJsonFields();
        return next();
    }

    try {
        const uploadPromises = [];

        for (const file of req.files) {
            uploadPromises.push(
                cloudinaryService.uploadToCloudinary(file.buffer, 'vendors/documents')
                    .then(result => ({ fieldName: file.fieldname, url: result.secure_url }))
            );
        }

        const results = await Promise.all(uploadPromises);

        // Map uploaded file URLs back to req.body
        results.forEach(({ fieldName, url }) => {
            const trimmedName = fieldName.trim();
            req.body[trimmedName] = url;
            console.log(`[DEBUG] Uploaded ${trimmedName}: ${url}`);
        });

        // Parse JSON array fields after file upload
        parseJsonFields();

        next();
    } catch (error) {
        console.error('Vendor document upload error:', error);
        const errorMessage = error.message || (typeof error === 'string' ? error : JSON.stringify(error));
        next(new ApiError(500, `Failed to upload vendor documents: ${errorMessage}`));
    }
};

module.exports = {
    uploadVendorDocs,
    processVendorDocs
};
