const Category = require('../../models/Category.model');
const Subcategory = require('../../models/Subcategory.model');
const Service = require('../../models/Service.model');
const ApiError = require('../../utils/ApiError');
const MESSAGES = require('../../constants/messages');

/**
 * =========================
 * PUBLIC APIs
 * =========================
 */

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
        .select('name description icon order price');

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
        .select(
            'title description photo approxCompletionTime adminPrice isAdminPriced moreInfo quantityEnabled priceAdjustmentEnabled'
        );

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
 * Global search across Categories, Subcategories, and Services
 */
const globalSearch = async (query) => {
    if (!query) return { categories: [], subcategories: [], services: [] };

    const searchRegex = { $regex: query, $options: 'i' };

    const [categories, subcategories, services] = await Promise.all([
        Category.find({ name: searchRegex, isActive: true })
            .select('name icon description')
            .limit(10),

        Subcategory.find({ name: searchRegex, isActive: true })
            .populate('category', 'name')
            .select('name icon description category')
            .limit(10),

        Service.find({ title: searchRegex, isActive: true })
            .populate('category', 'name')
            .populate('subcategory', 'name')
            .select(
                'title description photo adminPrice approxCompletionTime category subcategory'
            )
            .limit(20)
    ]);

    return {
        categories,
        subcategories,
        services
    };
};

/**
 * =========================
 * ADMIN APIs
 * =========================
 */

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
    const category = await Category.findById(categoryId);
    if (!category) throw new ApiError(404, 'Category not found');

    if (
        data.icon &&
        category.icon &&
        category.icon.includes('cloudinary.com') &&
        data.icon !== category.icon
    ) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(category.icon);
        } catch (error) {
            console.error('Error deleting old category image from Cloudinary:', error);
        }
    }

    return await Category.findByIdAndUpdate(categoryId, data, { new: true });
};

/**
 * Admin: Delete Category
 */
const deleteCategory = async (categoryId) => {
    const category = await Category.findById(categoryId);
    if (!category) throw new ApiError(404, 'Category not found');

    if (category.icon && category.icon.includes('cloudinary.com')) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(category.icon);
        } catch (error) {
            console.error('Error deleting category image from Cloudinary:', error);
        }
    }

    await Category.findByIdAndDelete(categoryId);
    return category;
};

/**
 * Admin: Create Subcategory
 */
const createSubcategory = async (data) => {
    return await Subcategory.create(data);
};

/**
 * Admin: Update Subcategory
 */
const updateSubcategory = async (subcategoryId, data) => {
    const subcategory = await Subcategory.findById(subcategoryId);
    if (!subcategory) throw new ApiError(404, 'Subcategory not found');

    if (
        data.icon &&
        subcategory.icon &&
        subcategory.icon.includes('cloudinary.com') &&
        data.icon !== subcategory.icon
    ) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(subcategory.icon);
        } catch (error) {
            console.error('Error deleting old subcategory image from Cloudinary:', error);
        }
    }

    return await Subcategory.findByIdAndUpdate(subcategoryId, data, { new: true });
};

/**
 * Admin: Delete Subcategory
 */
const deleteSubcategory = async (subcategoryId) => {
    const subcategory = await Subcategory.findById(subcategoryId);
    if (!subcategory) throw new ApiError(404, 'Subcategory not found');

    if (subcategory.icon && subcategory.icon.includes('cloudinary.com')) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(subcategory.icon);
        } catch (error) {
            console.error('Error deleting subcategory image from Cloudinary:', error);
        }
    }

    await Subcategory.findByIdAndDelete(subcategoryId);
    return subcategory;
};

/**
 * Admin: Create Service
 */
const createService = async (data) => {
    console.log('DEBUG: createService received body (raw):', data);

    const validateId = (id) => {
        if (!id) return null;
        const strId = String(id).trim();
        if (strId === 'null' || strId === 'undefined' || strId === '') return null;
        return strId;
    };

    data.category = validateId(data.category);
    data.subcategory = validateId(data.subcategory);

    if (!data.category) {
        throw new ApiError(400, 'A valid category ID is required');
    }

    const category = await Category.findById(data.category);
    if (!category) {
        throw new ApiError(404, `Category not found with ID: ${data.category}`);
    }

    if (data.subcategory) {
        const subcategory = await Subcategory.findById(data.subcategory);
        if (!subcategory) {
            throw new ApiError(404, `Subcategory not found with ID: ${data.subcategory}`);
        }
    }

    return await Service.create(data);
};

/**
 * Admin: Update Service
 */
const updateService = async (serviceId, data) => {
    const service = await Service.findById(serviceId);
    if (!service) throw new ApiError(404, 'Service not found');

    if (
        data.photo &&
        service.photo &&
        service.photo.includes('cloudinary.com') &&
        data.photo !== service.photo
    ) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(service.photo);
        } catch (error) {
            console.error('Error deleting old service image from Cloudinary:', error);
        }
    }

    return await Service.findByIdAndUpdate(serviceId, data, { new: true });
};

/**
 * Admin: Delete Service
 */
const deleteService = async (serviceId) => {
    const service = await Service.findById(serviceId);
    if (!service) throw new ApiError(404, 'Service not found');

    if (service.photo && service.photo.includes('cloudinary.com')) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(service.photo);
        } catch (error) {
            console.error('Error deleting service image from Cloudinary:', error);
        }
    }

    await Service.findByIdAndDelete(serviceId);
    return service;
};

/**
 * Admin: Get all categories with nested subcategories & services
 */
const getAllCategoriesWithSubcategories = async () => {
    const result = await Category.aggregate([
        { $match: { isActive: true } },
        { $sort: { order: 1, name: 1 } },
        {
            $lookup: {
                from: 'subcategories',
                let: { categoryId: '$_id' },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $eq: ['$category', '$$categoryId'] },
                                    { $eq: ['$isActive', true] }
                                ]
                            }
                        }
                    },
                    { $sort: { order: 1, name: 1 } },
                    {
                        $lookup: {
                            from: 'services',
                            let: { subcatId: '$_id' },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $and: [
                                                { $eq: ['$subcategory', '$$subcatId'] },
                                                { $eq: ['$isActive', true] }
                                            ]
                                        }
                                    }
                                },
                                { $sort: { title: 1 } }
                            ],
                            as: 'services'
                        }
                    }
                ],
                as: 'subcategories'
            }
        },
        {
            $project: {
                _id: 1,
                name: 1,
                description: 1,
                icon: 1,
                membershipFee: 1,
                defaultFreeCredits: 1,
                subcategories: 1
            }
        }
    ]);

    return result.map(cat => ({
        ...cat,
        id: cat._id.toString()
    }));
};

module.exports = {
    getAllCategories,
    getSubcategoriesByCategoryId,
    getServicesBySubcategoryId,
    getServiceById,
    globalSearch,
    createCategory,
    updateCategory,
    deleteCategory,
    createSubcategory,
    updateSubcategory,
    deleteSubcategory,
    createService,
    updateService,
    deleteService,
    getAllCategoriesWithSubcategories
};
