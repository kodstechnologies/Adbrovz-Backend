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
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

// Use upload.any() to be flexible as per user request ("store whatever data")
const uploadVendorDocs = upload.any();

const processVendorDocs = async (req, res, next) => {
    // Helper: parse stringified JSON array fields (always runs, even with no files)
    const parseJsonFields = () => {
        const jsonFields = [
            'workPincodes',
            'selectedCategories', 'selectedCategory', 'categories',
            'selectedSubcategories', 'subcategoryIds', 'subcategories',
            'selectedServiceTypes', 'selectedType', 'serviceTypeIds', 'serviceTypes',
            'selectedServices', 'selectedService', 'serviceIds', 'services',
            'categoryId'
        ];
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

        // Normalize field name variations so vendorSignup always finds them
        // categoryId: accept categoryId, selectedCategory, category (single value)
        if (!req.body.categoryId) {
            const catId = req.body.selectedCategory || req.body.category;
            if (catId) req.body.categoryId = catId;
        }
        // selectedCategories: accept selectedCategories, categories
        if (!req.body.selectedCategories && req.body.categories) {
            req.body.selectedCategories = req.body.categories;
        }
        // selectedSubcategories: accept subcategoryIds, subcategories
        if (!req.body.selectedSubcategories) {
            const val = req.body.subcategoryIds || req.body.subcategories;
            if (val) req.body.selectedSubcategories = val;
        }
        // selectedServiceTypes: accept selectedType, serviceTypeIds, serviceTypes
        if (!req.body.selectedServiceTypes) {
            const val = req.body.selectedType || req.body.serviceTypeIds || req.body.serviceTypes;
            if (val) req.body.selectedServiceTypes = val;
        }
        // selectedServices: accept selectedService, serviceIds, services
        if (!req.body.selectedServices) {
            const val = req.body.selectedService || req.body.serviceIds || req.body.services;
            if (val) req.body.selectedServices = val;
        }

        console.log('[DEBUG] Final normalized body fields:', {
            categoryId: req.body.categoryId,
            selectedCategories: req.body.selectedCategories,
            selectedSubcategories: req.body.selectedSubcategories,
            selectedServiceTypes: req.body.selectedServiceTypes,
            selectedServices: req.body.selectedServices
        });
    };

    // No files uploaded — just parse JSON fields and continue
    if (!req.files || req.files.length === 0) {
        console.log('[VENDOR UPLOAD] No files received');
        parseJsonFields();
        return next();
    }

    console.log(`[VENDOR UPLOAD] Received ${req.files.length} file(s):`, req.files.map(f => ({
        fieldname: f.fieldname,
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size
    })));

    try {
        const uploadPromises = [];

        for (const file of req.files) {
            console.log(`[VENDOR UPLOAD] Processing file: ${file.fieldname} (${file.mimetype}, ${file.size} bytes)`);
            uploadPromises.push(
                cloudinaryService.uploadToCloudinary(file.buffer, 'vendors/documents')
                    .then(result => {
                        console.log(`[VENDOR UPLOAD] Successfully uploaded ${file.fieldname}: ${result.secure_url}`);
                        return { fieldName: file.fieldname, url: result.secure_url };
                    })
                    .catch(error => {
                        console.error(`[VENDOR UPLOAD] Failed to upload ${file.fieldname}:`, error);
                        throw error;
                    })
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

        console.log('[VENDOR UPLOAD] Final req.body after upload:', Object.keys(req.body).filter(k => !k.startsWith('selected')));
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
