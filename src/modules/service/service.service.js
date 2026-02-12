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
    const category = await Category.findById(categoryId);
    if (!category) throw new ApiError(404, 'Category not found');
    
    // Delete old image from Cloudinary if new image is being uploaded
    if (data.icon && category.icon && category.icon.includes('cloudinary.com') && data.icon !== category.icon) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(category.icon);
        } catch (error) {
            console.error('Error deleting old category image from Cloudinary:', error);
            // Continue with update even if Cloudinary delete fails
        }
    }
    
    const updatedCategory = await Category.findByIdAndUpdate(categoryId, data, { new: true });
    return updatedCategory;
};

/**
 * Admin: Delete Category
 */
const deleteCategory = async (categoryId) => {
    const category = await Category.findById(categoryId);
    if (!category) throw new ApiError(404, 'Category not found');
    
    // Delete image from Cloudinary if exists
    if (category.icon && category.icon.includes('cloudinary.com')) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(category.icon);
        } catch (error) {
            console.error('Error deleting category image from Cloudinary:', error);
            // Continue with deletion even if Cloudinary delete fails
        }
    }
    
    await Category.findByIdAndDelete(categoryId);
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
    const subcategory = await Subcategory.findById(subcategoryId);
    if (!subcategory) throw new ApiError(404, 'Subcategory not found');
    
    // Delete old image from Cloudinary if new image is being uploaded
    if (data.icon && subcategory.icon && subcategory.icon.includes('cloudinary.com') && data.icon !== subcategory.icon) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(subcategory.icon);
        } catch (error) {
            console.error('Error deleting old subcategory image from Cloudinary:', error);
            // Continue with update even if Cloudinary delete fails
        }
    }
    
    const updatedSubcategory = await Subcategory.findByIdAndUpdate(subcategoryId, data, { new: true });
    return updatedSubcategory;
};

/**
 * Admin: Delete Subcategory
 */
const deleteSubcategory = async (subcategoryId) => {
    const subcategory = await Subcategory.findById(subcategoryId);
    if (!subcategory) throw new ApiError(404, 'Subcategory not found');
    
    // Delete image from Cloudinary if exists
    if (subcategory.icon && subcategory.icon.includes('cloudinary.com')) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(subcategory.icon);
        } catch (error) {
            console.error('Error deleting subcategory image from Cloudinary:', error);
            // Continue with deletion even if Cloudinary delete fails
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

    // Ensure IDs are valid strings and not "null"/"undefined"
    const validateId = (id, name) => {
        if (!id) return null;
        const strId = String(id).trim();
        if (strId === 'null' || strId === 'undefined' || strId === '') {
            console.error(`DEBUG: Invalid ${name} ID received:`, id);
            return null;
        }
        return strId;
    };

    data.category = validateId(data.category, 'category');
    data.subcategory = validateId(data.subcategory, 'subcategory');

    if (!data.category) {
        throw new ApiError(400, 'A valid category ID is required');
    }

    // Verify category exists
    console.log('DEBUG: Finding category by ID:', data.category);
    const category = await Category.findById(data.category);

    if (!category) {
        console.error('DEBUG: Category not found in DB:', data.category);
        // List a few categories for comparison
        const sampleCats = await Category.find().limit(5).select('_id name');
        console.log('DEBUG: Sample Categories in DB:', sampleCats.map(c => ({ id: c._id, name: c.name })));
        throw new ApiError(404, `Category not found with ID: ${data.category}`);
    }

    if (data.subcategory) {
        console.log('DEBUG: Finding subcategory by ID:', data.subcategory);
        const subcategory = await Subcategory.findById(data.subcategory);
        if (!subcategory) {
            console.error('DEBUG: Subcategory not found in DB:', data.subcategory);
            throw new ApiError(404, `Subcategory not found with ID: ${data.subcategory}`);
        }
    }

    const service = await Service.create(data);
    console.log('DEBUG: Service created successfully:', service._id);
    return service;
};

/**
 * Admin: Update Service
 */
const updateService = async (serviceId, data) => {
    const service = await Service.findById(serviceId);
    if (!service) throw new ApiError(404, 'Service not found');
    
    // Delete old image from Cloudinary if new image is being uploaded
    if (data.photo && service.photo && service.photo.includes('cloudinary.com') && data.photo !== service.photo) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(service.photo);
        } catch (error) {
            console.error('Error deleting old service image from Cloudinary:', error);
            // Continue with update even if Cloudinary delete fails
        }
    }
    
    const updatedService = await Service.findByIdAndUpdate(serviceId, data, { new: true });
    return updatedService;
};

/**
 * Admin: Delete Service
 */
const deleteService = async (serviceId) => {
    const service = await Service.findById(serviceId);
    if (!service) throw new ApiError(404, 'Service not found');
    
    // Delete image from Cloudinary if exists
    if (service.photo && service.photo.includes('cloudinary.com')) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(service.photo);
        } catch (error) {
            console.error('Error deleting service image from Cloudinary:', error);
            // Continue with deletion even if Cloudinary delete fails
        }
    }
    
    await Service.findByIdAndDelete(serviceId);
    return service;
};

/**
 * Admin: Get all categories with nested subcategories
 * Optimized using aggregation pipeline for better performance
 */
const getAllCategoriesWithSubcategories = async () => {
    try {
        // Use aggregation pipeline to join Categories -> Subcategories -> Services
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
                                { $sort: { title: 1 } },
                                {
                                    $project: {
                                        _id: 1,
                                        title: 1,
                                        photo: 1,
                                        adminPrice: 1,
                                        price: 1,
                                        approxCompletionTime: 1,
                                        isActive: 1,
                                        description: 1
                                    }
                                }
                            ],
                            as: 'services'
                        }
                    },
                    {
                        $project: {
                            _id: 1,
                            name: 1,
                            description: 1,
                            icon: 1,
                            order: 1,
                            price: { $ifNull: ['$price', 0] },
                            services: 1
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
                subcategories: {
                    $map: {
                        input: '$subcategories',
                        as: 'sub',
                        in: {
                            id: { $toString: '$$sub._id' },
                            _id: '$$sub._id',
                            name: '$$sub.name',
                            description: '$$sub.description',
                            icon: '$$sub.icon',
                            order: '$$sub.order',
                            price: '$$sub.price',
                            services: '$$sub.services'
                        }
                    }
                }
            }
        }
        ]);

        // Convert _id to id for consistency
        return result.map(cat => ({
            ...cat,
            id: cat._id.toString()
        }));
    } catch (error) {
        console.error('Error in getAllCategoriesWithSubcategories:', error);
        throw error;
    }
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
    deleteService,
    getAllCategoriesWithSubcategories
};
