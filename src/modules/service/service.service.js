const Category = require('../../models/Category.model');
const Subcategory = require('../../models/Subcategory.model');
const Service = require('../../models/Service.model');
const ApiError = require('../../utils/ApiError');
const MESSAGES = require('../../constants/messages');

/**
 * Get all active categories
 */
const getAllCategories = async () => {
    const categories = await Category.find({ isActive: true })
        .sort({ order: 1, name: 1 })
        .select('name description icon membershipFee defaultFreeCredits');
    return categories;
};

/**
 * Get subcategories by category ID
 */
const getSubcategoriesByCategoryId = async (categoryId) => {
    const subcategories = await Subcategory.find({
        category: categoryId,
        isActive: true
    })
        .sort({ order: 1, name: 1 })
        .select('name description icon');

    return subcategories;
};

/**
 * Get services by subcategory ID with pagination
 */
const getServicesBySubcategoryId = async (subcategoryId, options = {}) => {
    const { page = 1, limit = 10, search } = options;
    const skip = (page - 1) * limit;

    const query = {
        subcategory: subcategoryId,
        isActive: true
    };

    if (search) {
        query.title = { $regex: search, $options: 'i' };
    }

    const services = await Service.find(query)
        .sort({ title: 1 })
        .skip(skip)
        .limit(limit)
        .select('title description photo approxCompletionTime adminPrice isAdminPriced moreInfo quantityEnabled priceAdjustmentEnabled');

    const total = await Service.countDocuments(query);

    return {
        services,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

/**
 * Get service details by ID
 */
const getServiceById = async (serviceId) => {
    const service = await Service.findOne({ _id: serviceId, isActive: true })
        .populate('category', 'name')
        .populate('subcategory', 'name');

    if (!service) {
        throw new ApiError(404, 'Service not found');
    }

    return service;
};

/**
 * Admin: Create Category
 */
const createCategory = async (data) => {
    const category = await Category.create(data);
    return category;
};

/**
 * Admin: Update Category
 */
const updateCategory = async (categoryId, data) => {
    const category = await Category.findByIdAndUpdate(categoryId, data, { new: true });
    if (!category) throw new ApiError(404, 'Category not found');
    return category;
};

/**
 * Admin: Delete Category
 */
const deleteCategory = async (categoryId) => {
    const category = await Category.findByIdAndDelete(categoryId);
    if (!category) throw new ApiError(404, 'Category not found');
    return category;
};

/**
 * Admin: Create Subcategory
 */
const createSubcategory = async (data) => {
    const subcategory = await Subcategory.create(data);
    return subcategory;
};

/**
 * Admin: Update Subcategory
 */
const updateSubcategory = async (subcategoryId, data) => {
    const subcategory = await Subcategory.findByIdAndUpdate(subcategoryId, data, { new: true });
    if (!subcategory) throw new ApiError(404, 'Subcategory not found');
    return subcategory;
};

/**
 * Admin: Delete Subcategory
 */
const deleteSubcategory = async (subcategoryId) => {
    const subcategory = await Subcategory.findByIdAndDelete(subcategoryId);
    if (!subcategory) throw new ApiError(404, 'Subcategory not found');
    return subcategory;
};

/**
 * Admin: Create Service
 */
const createService = async (data) => {
    // Verify category and subcategory exist
    const categoryExists = await Category.exists({ _id: data.category });
    if (!categoryExists) throw new ApiError(404, 'Category not found');

    if (data.subcategory) {
        const subcategoryExists = await Subcategory.exists({ _id: data.subcategory });
        if (!subcategoryExists) throw new ApiError(404, 'Subcategory not found');
    }

    const service = await Service.create(data);
    return service;
};

/**
 * Admin: Update Service
 */
const updateService = async (serviceId, data) => {
    const service = await Service.findByIdAndUpdate(serviceId, data, { new: true });
    if (!service) throw new ApiError(404, 'Service not found');
    return service;
};

/**
 * Admin: Delete Service
 */
const deleteService = async (serviceId) => {
    const service = await Service.findByIdAndDelete(serviceId);
    if (!service) throw new ApiError(404, 'Service not found');
    return service;
};

module.exports = {
    getAllCategories,
    getSubcategoriesByCategoryId,
    getServicesBySubcategoryId,
    getServiceById,
    // Admin exports
    createCategory,
    updateCategory,
    deleteCategory,
    createSubcategory,
    updateSubcategory,
    deleteSubcategory,
    createService,
    updateService,
    deleteService
};
