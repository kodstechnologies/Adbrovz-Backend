const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const serviceService = require('./service.service');

// Get all categories
const getCategories = asyncHandler(async (req, res) => {
    const categories = await serviceService.getAllCategories();
    res.status(200).json(
        new ApiResponse(200, categories, 'Categories retrieved successfully')
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

// Get service details
const getServiceDetails = asyncHandler(async (req, res) => {
    const { serviceId } = req.params;
    const service = await serviceService.getServiceById(serviceId);
    res.status(200).json(
        new ApiResponse(200, service, 'Service details retrieved successfully')
    );
});

// Admin: Category Management
const createCategory = asyncHandler(async (req, res) => {
    const data = { ...req.body };
    // Cloudinary URL is already set in req.body.icon by uploadToCloudinary middleware
    if (req.file && req.file.cloudinary) {
        data.icon = req.file.cloudinary.url;
    }
    const category = await serviceService.createCategory(data);
    res.status(201).json(new ApiResponse(201, category, 'Category created successfully'));
});

const updateCategory = asyncHandler(async (req, res) => {
    const data = { ...req.body };
    // Cloudinary URL is already set in req.body.icon by uploadToCloudinary middleware
    if (req.file && req.file.cloudinary) {
        data.icon = req.file.cloudinary.url;
    }
    const category = await serviceService.updateCategory(req.params.categoryId, data);
    res.status(200).json(new ApiResponse(200, category, 'Category updated successfully'));
});

const deleteCategory = asyncHandler(async (req, res) => {
    await serviceService.deleteCategory(req.params.categoryId);
    res.status(200).json(new ApiResponse(200, null, 'Category deleted successfully'));
});

// Admin: Subcategory Management
const createSubcategory = asyncHandler(async (req, res) => {
    const data = { ...req.body };
    // Cloudinary URL is already set in req.body.icon by uploadToCloudinary middleware
    if (req.file && req.file.cloudinary) {
        data.icon = req.file.cloudinary.url;
    }
    const subcategory = await serviceService.createSubcategory(data);
    res.status(201).json(new ApiResponse(201, subcategory, 'Subcategory created successfully'));
});

const updateSubcategory = asyncHandler(async (req, res) => {
    const data = { ...req.body };
    // Cloudinary URL is already set in req.body.icon by uploadToCloudinary middleware
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

// Admin: Service Management
const createService = asyncHandler(async (req, res) => {
    console.log('DEBUG: createService req.body:', req.body);
    console.log('DEBUG: createService req.file:', req.file);
    const serviceData = { ...req.body };

    // Cloudinary URL is already set in req.body.photo by uploadToCloudinary middleware
    if (req.file && req.file.cloudinary) {
        serviceData.photo = req.file.cloudinary.url;
    }

    const service = await serviceService.createService(serviceData);
    res.status(201).json(new ApiResponse(201, service, 'Service created successfully'));
});

const updateService = asyncHandler(async (req, res) => {
    const updateData = { ...req.body };

    // Cloudinary URL is already set in req.body.photo by uploadToCloudinary middleware
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

module.exports = {
    getCategories,
    getSubcategories,
    getServices,
    getServiceDetails,
    // Admin exports
    createCategory,
    updateCategory,
    deleteCategory,
    createSubcategory,
    updateSubcategory,
    deleteSubcategory,
    createService,
    updateService,
    deleteService,
    getCategoriesWithSubcategories
};
