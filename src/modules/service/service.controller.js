const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const serviceService = require('./service.service');

// Get all categories
const getCategories = asyncHandler(async (req, res) => {
    const categories = await serviceService.getAllCategories();
    res.status(200).json(
        new ApiResponse(200, categories, 'Categories retrieved successfully')
    );
});

// Service Management: fetch all 4 rows (category -> subcategory -> type -> service)
const getServiceManagementRows = asyncHandler(async (req, res) => {
    const { categoryId, subcategoryId, serviceTypeId } = req.query;

    const result = await serviceService.getServiceManagementRows({
        categoryId,
        subcategoryId,
        serviceTypeId
    });

    res.status(200).json(
        new ApiResponse(200, result, 'Service management data retrieved successfully')
    );
});

// Get slots by category
const getCategorySlots = asyncHandler(async (req, res) => {
    const { categoryId } = req.params;
    const { timezoneOffset } = req.query;
    
    // Default to 330 (IST) if not provided, ensure it's a number
    const offset = timezoneOffset !== undefined ? parseInt(timezoneOffset) : 330;
    
    const slots = await serviceService.getCategorySlots(categoryId, offset);
    res.status(200).json(
        new ApiResponse(200, slots, 'Slots retrieved successfully')
    );
});

// Get subcategories by category
const getSubcategories = asyncHandler(async (req, res) => {
    const { categoryId } = req.params;
    const subcategories = await serviceService.getSubcategoriesByCategoryId(categoryId);
    res.status(200).json(
        new ApiResponse(200, subcategories, 'Subcategories retrieved successfully')
    );
});

// Get service types by subcategory
const getServiceTypes = asyncHandler(async (req, res) => {
    const { subcategoryId } = req.params;
    const serviceTypes = await serviceService.getServiceTypesBySubcategoryId(subcategoryId);
    res.status(200).json(
        new ApiResponse(200, serviceTypes, 'Service types retrieved successfully')
    );
});

// Get services by subcategory
const getServices = asyncHandler(async (req, res) => {
    const { subcategoryId } = req.params;
    const { page, limit, search } = req.query;

    const result = await serviceService.getServicesBySubcategoryId(subcategoryId, {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 10,
        search
    });

    res.status(200).json(
        new ApiResponse(200, result, 'Services retrieved successfully')
    );
});

// Get services by service type
const getServicesByType = asyncHandler(async (req, res) => {
    const { serviceTypeId } = req.params;
    const { page, limit, search } = req.query;

    const result = await serviceService.getServicesByServiceTypeId(serviceTypeId, {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 10,
        search
    });

    res.status(200).json(
        new ApiResponse(200, result, 'Services retrieved successfully')
    );
});

// Get services by multiple service types
const getServicesByTypes = asyncHandler(async (req, res) => {
    // Expected in query like: ?typeIds=id1,id2,id3
    const { typeIds, page, limit, search } = req.query;

    if (!typeIds) {
        return res.status(400).json(new ApiResponse(400, null, 'typeIds query parameter is required'));
    }

    const typeIdsArray = typeIds.split(',').map(id => id.trim()).filter(Boolean);

    const result = await serviceService.getServicesByTypes(typeIdsArray, {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 10,
        search
    });

    res.status(200).json(
        new ApiResponse(200, result, 'Services retrieved successfully')
    );
});

// Get service details
const getServiceDetails = asyncHandler(async (req, res) => {
    const { serviceId } = req.params;
    const service = await serviceService.getServiceById(serviceId);
    res.status(200).json(
        new ApiResponse(200, service, 'Service details retrieved successfully')
    );
});



// Get all services with details
const getAllServices = asyncHandler(async (req, res) => {
    const services = await serviceService.getAllServices();
    res.status(200).json(
        new ApiResponse(200, services, 'All services retrieved successfully')
    );
});

// Helper to map frontend fee names to backend model names
const _mapServiceData = (data) => {
    const mapped = { ...data };
    
    // Convert string-numbers to actual numbers
    const numericFields = [
        'adminPrice', 'bookingPrice', 'concurrencyFee', 'renewalCharge', 
        'price', 'approxCompletionTime', 'order', 'vendorConcurrency'
    ];
    
    numericFields.forEach(field => {
        if (mapped[field] !== undefined) {
            mapped[field] = Number(mapped[field]) || 0;
        }
    });

    // Handle special mappings for price fields
    if (mapped.adminPrice !== undefined) {
        mapped.serviceCharge = mapped.adminPrice;
    }
    
    if (mapped.concurrencyFee !== undefined) {
        mapped.serviceRenewalCharge = mapped.concurrencyFee;
    }
    
    if (mapped.renewalCharge !== undefined) {
        mapped.membershipRenewalCharge = mapped.renewalCharge;
    }

    // Convert string-booleans to actual booleans
    const booleanFields = ['isActive', 'quantityEnabled', 'priceAdjustmentEnabled', 'isAdminPriced'];
    booleanFields.forEach(field => {
        if (mapped[field] !== undefined) {
            const originalValue = mapped[field];
            mapped[field] = String(mapped[field]) === 'true' || mapped[field] === true;
            console.log(`DEBUG: Field ${field} mapped: ${originalValue} -> ${mapped[field]}`);
        }
    });

    // Handle timeSlots (might be stringified JSON from multipart/form-data)
    if (typeof mapped.timeSlots === 'string') {
        try {
            mapped.timeSlots = JSON.parse(mapped.timeSlots);
        } catch (e) {
            console.warn('DEBUG: Failed to parse timeSlots string:', mapped.timeSlots);
        }
    }

    if (Array.isArray(mapped.timeSlots)) {
        mapped.timeSlots = mapped.timeSlots.map(slot => ({
            ...slot,
            isActive: slot.isActive === undefined ? true : (String(slot.isActive) === 'true' || slot.isActive === true)
        }));
    }

    console.log('DEBUG: Final mapped data:', JSON.stringify(mapped, null, 2));
    return mapped;
};

// Admin: Category Management
const createCategory = asyncHandler(async (req, res) => {
    const data = _mapServiceData(req.body);
    if (req.file && req.file.cloudinary) {
        data.icon = req.file.cloudinary.url;
    }
    const category = await serviceService.createCategory(data);
    res.status(201).json(new ApiResponse(201, category, 'Category created successfully'));
});

const updateCategory = asyncHandler(async (req, res) => {
    const data = _mapServiceData(req.body);
    if (req.file && req.file.cloudinary) {
        data.icon = req.file.cloudinary.url;
    }
    const category = await serviceService.updateCategory(req.params.categoryId, data);
    const fs = require('fs');
    fs.appendFileSync('success_debug.log', `[${new Date().toISOString()}] updateCategory success: ${JSON.stringify(category, null, 2)}\n`);
    res.status(200).json(new ApiResponse(200, category, 'Category updated successfully'));
});

const deleteCategory = asyncHandler(async (req, res) => {
    await serviceService.deleteCategory(req.params.categoryId);
    res.status(200).json(new ApiResponse(200, null, 'Category deleted successfully'));
});

// Admin: Subcategory Management
const createSubcategory = asyncHandler(async (req, res) => {
    const data = _mapServiceData(req.body);
    if (req.file && req.file.cloudinary) {
        data.icon = req.file.cloudinary.url;
    }
    const subcategory = await serviceService.createSubcategory(data);
    res.status(201).json(new ApiResponse(201, subcategory, 'Subcategory created successfully'));
});

const updateSubcategory = asyncHandler(async (req, res) => {
    const data = _mapServiceData(req.body);
    if (req.file && req.file.cloudinary) {
        data.icon = req.file.cloudinary.url;
    }
    const subcategory = await serviceService.updateSubcategory(req.params.subcategoryId, data);
    res.status(200).json(new ApiResponse(200, subcategory, 'Subcategory updated successfully'));
});

const deleteSubcategory = asyncHandler(async (req, res) => {
    await serviceService.deleteSubcategory(req.params.subcategoryId);
    res.status(200).json(new ApiResponse(200, null, 'Subcategory deleted successfully'));
});

// Admin: Service Type Management
const getAdminServiceTypes = asyncHandler(async (req, res) => {
    const serviceTypes = await serviceService.getAllServiceTypesWithSubcategories();
    res.status(200).json(
        new ApiResponse(200, serviceTypes, 'Service types retrieved successfully')
    );
});

const createServiceType = asyncHandler(async (req, res) => {
    const data = _mapServiceData(req.body);
    const serviceType = await serviceService.createServiceType(data);
    res.status(201).json(new ApiResponse(201, serviceType, 'Service type created successfully'));
});

const updateServiceType = asyncHandler(async (req, res) => {
    const data = _mapServiceData(req.body);
    if (req.file && req.file.cloudinary) {
        data.photo = req.file.cloudinary.url;
    }
    const serviceType = await serviceService.updateServiceType(req.params.serviceTypeId, data);
    res.status(200).json(new ApiResponse(200, serviceType, 'Service type updated successfully'));
});

const deleteServiceType = asyncHandler(async (req, res) => {
    await serviceService.deleteServiceType(req.params.serviceTypeId);
    res.status(200).json(new ApiResponse(200, null, 'Service type deleted successfully'));
});

// Admin: Service Management
const createService = asyncHandler(async (req, res) => {
    const serviceData = _mapServiceData(req.body);
    if (req.file && req.file.cloudinary) {
        serviceData.photo = req.file.cloudinary.url;
    }
    const service = await serviceService.createService(serviceData);
    res.status(201).json(new ApiResponse(201, service, 'Service created successfully'));
});

const updateService = asyncHandler(async (req, res) => {
    const updateData = _mapServiceData(req.body);
    if (req.file && req.file.cloudinary) {
        updateData.photo = req.file.cloudinary.url;
    }
    const service = await serviceService.updateService(req.params.serviceId, updateData);
    res.status(200).json(new ApiResponse(200, service, 'Service updated successfully'));
});

const deleteService = asyncHandler(async (req, res) => {
    await serviceService.deleteService(req.params.serviceId);
    res.status(200).json(new ApiResponse(200, null, 'Service deleted successfully'));
});

const getAdminServices = asyncHandler(async (req, res) => {
    const services = await serviceService.getAllServicesWithDetails();
    res.status(200).json(
        new ApiResponse(200, services, 'Services retrieved successfully')
    );
});

// Admin: Get all categories with subcategories 
const getCategoriesWithSubcategories = asyncHandler(async (req, res) => {
    try {
        const categories = await serviceService.getAllCategoriesWithSubcategories();
        res.status(200).json(
            new ApiResponse(200, categories, 'Categories with subcategories retrieved successfully')
        );
    } catch (error) {
        console.error('Error in getCategoriesWithSubcategories controller:', error);
        throw error;
    }
});

// Global Search
const globalSearch = asyncHandler(async (req, res) => {
    const { query } = req.query;
    const results = await serviceService.globalSearch(query);
    res.status(200).json(
        new ApiResponse(200, results, 'Search results retrieved successfully')
    );
});

// Get all subcategories with services
const getSubcategoriesWithServices = asyncHandler(async (req, res) => {
    const subcategories = await serviceService.getAllSubcategoriesWithServices();
    res.status(200).json(
        new ApiResponse(200, subcategories, 'Subcategories with services retrieved successfully')
    );
});

// Get nested catalogue
const getServiceCatalogue = asyncHandler(async (req, res) => {
    const catalogue = await serviceService.getServiceCatalogue();
    res.status(200).json(
        new ApiResponse(200, catalogue, 'Service catalogue retrieved successfully')
    );
});

// Get service types by multiple subcategories
const getServiceTypesBySubcategories = asyncHandler(async (req, res) => {
    const { subcategoryIds } = req.query;

    if (!subcategoryIds) {
        throw new ApiError(400, 'subcategoryIds query parameter is required');
    }

    const subcategoryIdsArray = subcategoryIds.split(',').map(id => id.trim()).filter(Boolean);

    const result = await serviceService.getServiceTypesBySubcategories(subcategoryIdsArray);

    res.status(200).json(
        new ApiResponse(200, result, 'Service types retrieved successfully')
    );
});


// Get subcategory by ID
const getSubcategoryById = asyncHandler(async (req, res) => {
    const subcategory = await serviceService.getSubcategoryById(req.params.subcategoryId);
    res.status(200).json(new ApiResponse(200, subcategory, 'Subcategory retrieved successfully'));
});

// Get service type by ID
const getServiceTypeById = asyncHandler(async (req, res) => {
    const serviceType = await serviceService.getServiceTypeById(req.params.serviceTypeId);
    res.status(200).json(new ApiResponse(200, serviceType, 'Service type retrieved successfully'));
});

module.exports = {
    getCategories,
    getServiceManagementRows,
    getCategorySlots,
    getSubcategories,
    getServiceTypes,
    getServices,
    getServicesByType,
    getServicesByTypes,
    getServiceDetails,
    getServiceTypesBySubcategories,
    globalSearch,
    // Admin exports
    createCategory,
    updateCategory,
    deleteCategory,
    createSubcategory,
    updateSubcategory,
    deleteSubcategory,
    createServiceType,
    updateServiceType,
    deleteServiceType,
    getAllServices,
    createService,
    updateService,
    deleteService,
    getAdminServiceTypes,
    getAdminServices,
    getCategoriesWithSubcategories,
    getSubcategoriesWithServices,
    getServiceCatalogue,
    getSubcategoryById,
    getServiceTypeById
};
