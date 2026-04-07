const Category = require('../../models/Category.model');
const Subcategory = require('../../models/Subcategory.model');
const ServiceType = require('../../models/ServiceType.model');
const Service = require('../../models/Service.model');
const ApiError = require('../../utils/ApiError');
const MESSAGES = require('../../constants/messages');

/**
 * =========================
 * PUBLIC APIs
 * =========================
 */

/**
 * Get all categories
 */
const getAllCategories = async () => {
    const categories = await Category.find({})
        .sort({ order: 1, name: 1 })
        .select('name description icon defaultFreeCredits slotStartTime slotEndTime');
    return categories;
};

/**
 * Get subcategories by category ID
 */
const getSubcategoriesByCategoryId = async (categoryId) => {
    const subcategories = await Subcategory.find({ category: categoryId })
        .sort({ order: 1, name: 1 })
        .select('name description icon order price adminPrice coupon discount membershipFee');

    return subcategories;
};

/**
 * Get service types by subcategory ID
 */
const getServiceTypesBySubcategoryId = async (subcategoryId) => {
    const serviceTypes = await ServiceType.find({ subcategory: subcategoryId })
        .sort({ order: 1, name: 1 })
        .select('name order adminPrice coupon discount membershipFee');

    return serviceTypes;
};

/**
 * Get services by service type ID with pagination
 */
const getServicesByServiceTypeId = async (serviceTypeId, options = {}) => {
    const { page = 1, limit = 10, search } = options;
    const skip = (page - 1) * limit;

    const serviceType = await ServiceType.findById(serviceTypeId);
    if (!serviceType) {
        throw new ApiError(404, 'Service type not found');
    }

    const query = {
        serviceType: serviceTypeId
    };

    if (search) {
        query.title = { $regex: search, $options: 'i' };
    }

    const services = await Service.find(query)
        .sort({ title: 1 })
        .skip(skip)
        .limit(limit)
        .select(
            'title description photo approxCompletionTime adminPrice isAdminPriced moreInfo quantityEnabled priceAdjustmentEnabled coupon discount'
        );

    const total = await Service.countDocuments(query);

    return {
        categoryId: serviceType.category,
        subcategoryId: serviceType.subcategory,
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
 * Get services by subcategory ID with pagination
 */
const getServicesBySubcategoryId = async (subcategoryId, options = {}) => {
    const { page = 1, limit = 10, search } = options;
    const skip = (page - 1) * limit;

    // Fetch subcategory to get categoryId
    const subcategory = await Subcategory.findById(subcategoryId);
    if (!subcategory) {
        throw new ApiError(404, 'Subcategory not found');
    }

    const query = {
        subcategory: subcategoryId
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
        categoryId: subcategory.category,
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
    const service = await Service.findById(serviceId)
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
        Category.find({ name: searchRegex })
            .select('name icon description')
            .limit(10),

        Subcategory.find({ name: searchRegex })
            .populate('category', 'name')
            .select('name icon description category')
            .limit(10),

        Service.find({ title: searchRegex })
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
 * Public: Get all services with details
 */
const getAllServices = async () => {
    let services = await Service.find({ isActive: { $ne: false } })
        .populate('category', 'name')
        .populate('subcategory', 'name')
        .sort({ title: 1 });
        
    return services.map(s => {
        const doc = s.toJSON ? s.toJSON() : s;
        if (doc.isActive === undefined) {
            doc.isActive = true;
        }
        return doc;
    });
};

/**
 * =========================
 * ADMIN APIs
 * =========================
 */

/**
 * Admin: Get all Service Types with Subcategories
 */
const getAllServiceTypesWithSubcategories = async () => {
    return await ServiceType.find().populate('subcategory', 'name');
};

/**
 * Admin: Create Service Type
 */
const createServiceType = async (data) => {
    return await ServiceType.create(data);
};

/**
 * Admin: Update Service Type
 */
const updateServiceType = async (serviceTypeId, data) => {
    const serviceType = await ServiceType.findById(serviceTypeId);
    if (!serviceType) throw new ApiError(404, 'Service type not found');

    return await ServiceType.findByIdAndUpdate(serviceTypeId, data, { new: true });
};

/**
 * Admin: Delete Service Type
 */
const deleteServiceType = async (serviceTypeId) => {
    const serviceType = await ServiceType.findById(serviceTypeId);
    if (!serviceType) throw new ApiError(404, 'Service type not found');

    await ServiceType.findByIdAndDelete(serviceTypeId);
    return serviceType;
};

/**
 * Admin: Get all Services with Details
 */
const getAllServicesWithDetails = async () => {
    return await Service.find()
        .populate('category', 'name')
        .populate('subcategory', 'name')
        .populate('serviceType', 'name');
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

    if (data.serviceType) {
        const serviceType = await ServiceType.findById(data.serviceType);
        if (!serviceType) {
            throw new ApiError(404, `Service type not found with ID: ${data.serviceType}`);
        }
    }

    // Normalize adminPrice and set isAdminPriced
    if (data.adminPrice === '' || data.adminPrice === undefined || data.adminPrice === null || data.adminPrice === 'null') {
        data.adminPrice = 0;
        data.isAdminPriced = false;
    } else {
        data.adminPrice = Number(data.adminPrice);
        data.isAdminPriced = data.adminPrice > 0;
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

    // Normalize adminPrice and set isAdminPriced
    if (data.adminPrice === '' || data.adminPrice === undefined || data.adminPrice === null || data.adminPrice === 'null') {
        data.adminPrice = 0;
        data.isAdminPriced = false;
    } else {
        data.adminPrice = Number(data.adminPrice);
        data.isAdminPriced = data.adminPrice > 0;
    }

    return await Service.findByIdAndUpdate(serviceId, data, { new: true, runValidators: true });
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
 * Admin: Get all categories with nested subcategories, service types & services
 */
const getAllCategoriesWithSubcategories = async () => {
    const result = await Category.aggregate([
        { $sort: { order: 1, name: 1 } },
        {
            $lookup: {
                from: 'subcategories',
                let: { categoryId: '$_id' },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $eq: ['$category', '$$categoryId']
                            }
                        }
                    },
                    { $sort: { order: 1, name: 1 } },
                    {
                        $lookup: {
                            from: 'servicetypes',
                            let: { subcatId: '$_id' },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $eq: ['$subcategory', '$$subcatId']
                                        }
                                    }
                                },
                                { $sort: { order: 1, name: 1 } },
                                {
                                    $lookup: {
                                        from: 'services',
                                        let: { typeId: '$_id' },
                                        pipeline: [
                                            {
                                                $match: {
                                                    $expr: {
                                                        $eq: ['$serviceType', '$$typeId']
                                                    }
                                                }
                                            },
                                            { $sort: { title: 1 } }
                                        ],
                                        as: 'services'
                                    }
                                }
                            ],
                            as: 'serviceTypes'
                        }
                    }
                ],
                as: 'subcategories'
            }
        },
        {
            $project: {
                name: 1,
                description: 1,
                icon: 1,
                defaultFreeCredits: 1,
                slotStartTime: 1,
                slotEndTime: 1,
                adminPrice: 1,
                coupon: 1,
                discount: 1,
                membershipFee: 1,
                renewalCharge: 1,
                subcategories: 1
            }
        }
    ]);

    // Recursive helper to clean IDs and remove internal fields
    const cleanDoc = (doc) => {
        if (!doc) return doc;
        const cleaned = { ...doc, id: doc._id?.toString() || doc.id };
        delete cleaned._id;
        delete cleaned.__v;

        if (cleaned.subcategories) {
            cleaned.subcategories = cleaned.subcategories.map(cleanDoc);
        }
        if (cleaned.serviceTypes) {
            cleaned.serviceTypes = cleaned.serviceTypes.map(cleanDoc);
        }
        if (cleaned.services) {
            cleaned.services = cleaned.services.map(cleanDoc);
        }
        return cleaned;
    };

    return result.map(cleanDoc);
};

/**
 * Public: Get all subcategories with their services
 */
const getAllSubcategoriesWithServices = async () => {
    const result = await Subcategory.aggregate([
        { $sort: { order: 1, name: 1 } },
        {
            $lookup: {
                from: 'services',
                let: { subcatId: '$_id' },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $eq: ['$subcategory', '$$subcatId']
                            }
                        }
                    },
                    { $sort: { title: 1 } },
                    {
                        $project: {
                            _id: 1,
                            title: 1,
                            membershipFee: {
                                $cond: [
                                    { $gt: ['$membershipFee', 0] },
                                    '$membershipFee',
                                    '$$REMOVE'
                                ]
                            }
                        }
                    }
                ],
                as: 'services'
            }
        },
        {
            $project: {
                name: 1,
                description: 1,
                icon: 1,
                order: 1,
                price: 1,
                services: 1,
                category: 1
            }
        }
    ]);

    // Recursive helper to clean IDs and remove internal fields
    const cleanDoc = (doc) => {
        if (!doc) return doc;
        const cleaned = { ...doc, id: doc._id?.toString() || doc.id };
        delete cleaned._id;
        delete cleaned.__v;

        if (cleaned.services) {
            cleaned.services = cleaned.services.map(cleanDoc);
        }
        return cleaned;
    };

    return result.map(cleanDoc);
};

/**
 * Public: Get flat list of all services (name and ID only)
 */
const getServiceCatalogue = async () => {
    const services = await Service.find({})
        .select('title _id')
        .sort({ title: 1 });

    return services.map(service => ({
        name: service.title,
        serviceId: service._id
    }));
};

/**
 * Public: Get generic available time slots for a category
 * @param {string} categoryId
 * @param {number} timezoneOffset Offset in minutes (e.g., IST = 330). Default is IST.
 */
const getCategorySlots = async (categoryId, timezoneOffset = 330) => {
    const category = await Category.findById(categoryId);
    if (!category) throw new ApiError(404, 'Category not found');

    const parseTime = (timeStr, fallbackH) => {
        if (!timeStr) return [fallbackH, 0];
        const [h, m] = timeStr.split(':').map(Number);
        return [isNaN(h) ? fallbackH : h, isNaN(m) ? 0 : m];
    };

    const [slotStartH, slotStartM] = parseTime(category.slotStartTime, 8);
    const [slotEndH, slotEndM] = parseTime(category.slotEndTime, 20);

    const formatDisplayTime = (h, m) => {
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hours12 = h % 12 || 12;
        return `${String(hours12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
    };

    const now = new Date();
    const daysList = [];
    const windowDays = 7;
    const slotDurationMs = 60 * 60 * 1000;

    // Correctly calculate the start of the user's "Today" in UTC
    // 1. Get current time in user's local milliseconds
    const nowLocalMs = now.getTime() + (timezoneOffset * 60000);
    // 2. Find the start of that day (00:00) in "local" time
    const startOfUserTodayLocal = new Date(nowLocalMs);
    startOfUserTodayLocal.setUTCHours(0, 0, 0, 0);
    // 3. Convert that "local 00:00" back to UTC
    const todayBaseMs = startOfUserTodayLocal.getTime() - (timezoneOffset * 60000);
    const todayBase = new Date(todayBaseMs);

    for (let dayOffset = 0; dayOffset < windowDays; dayOffset++) {
        // Construct the date for this offset using UTC methods to maintain day boundaries
        const loopDate = new Date(todayBase.getTime());
        loopDate.setUTCDate(loopDate.getUTCDate() + dayOffset);
        
        // Re-calculate the actual local date string for this day
        const localDateForLoop = new Date(loopDate.getTime() + (timezoneOffset * 60000));
        const dateStr = localDateForLoop.toISOString().split('T')[0];
        let dayLabel = dayOffset === 0 ? 'Today' : (dayOffset === 1 ? 'Tomorrow' : '');
        
        if (!dayLabel) {
            // Faster manual formatting for generic labels
            const options = { weekday: 'short', month: 'short', day: 'numeric' };
            dayLabel = loopDate.toLocaleDateString('en-US', options);
        }

        const dailySlots = [];
        const categoryEndMs = (slotEndH * 60 + slotEndM) * 60000;

        for (let h = slotStartH; h <= slotEndH; h++) {
            for (let m = (h === slotStartH ? slotStartM : 0); m < 60; m += 30) {
                const currentMinutes = h * 60 + m;
                if (h === slotEndH && m >= slotEndM) break;
                
                // Calculate Slot Start and End in UTC to compare with 'now'
                // since todayBase/loopDate are already normalized to UTC start of the local day.
                const slotStartUTCMs = loopDate.getTime() + (currentMinutes * 60000);
                const slotEndUTCMs = slotStartUTCMs + slotDurationMs;
                
                // Construct category end in UTC
                const categoryEndUTCMs = loopDate.getTime() + categoryEndMs;
                
                if (slotEndUTCMs > categoryEndUTCMs) break;

                const isAvailable = slotStartUTCMs > now.getTime();
                
                dailySlots.push({
                    time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
                    displayTime: formatDisplayTime(h, m),
                    isAvailable
                });
            }
        }

        daysList.push({
            date: dateStr,
            dayLabel,
            slots: dailySlots
        });
    }

    return daysList;
};

module.exports = {
    getCategorySlots,
    getAllCategories,
    getSubcategoriesByCategoryId,
    getServiceTypesBySubcategoryId,
    getServicesBySubcategoryId,
    getServicesByServiceTypeId,
    getServiceById,
    globalSearch,
    getAllServices,
    createCategory,
    updateCategory,
    deleteCategory,
    createSubcategory,
    updateSubcategory,
    deleteSubcategory,
    createServiceType,
    updateServiceType,
    deleteServiceType,
    createService,
    updateService,
    deleteService,
    getServiceCatalogue,
    getAllServicesWithDetails,
    getAllServiceTypesWithSubcategories,
    getAllCategoriesWithSubcategories,
    getAllSubcategoriesWithServices
};
