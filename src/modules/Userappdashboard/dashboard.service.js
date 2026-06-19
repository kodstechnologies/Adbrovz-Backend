const ServiceSection = require('../../models/ServiceSection.model');
const Banner = require('../../models/Banner.model');
const Service = require('../../models/Service.model');
const Booking = require('../../models/Booking.model');
const Category = require('../../models/Category.model');
const Subcategory = require('../../models/Subcategory.model');
const ApiError = require('../../utils/ApiError');

/**
 * USER: Get dashboard data (service sections + banners)
 */
const getDashboardData = async () => {
    const { isCategoryValid, isSubcategoryValid, isServiceTypeValid } = require('../service/service.service');

    // Get banners
    const banners = await Banner.find({ type: 'user' })
        .sort({ order: 1 })
        .populate('category')
        .select('title description image category order');

    // Filter banners to ensure their category is active and valid
    const filteredBanners = [];
    for (const banner of banners) {
        if (banner.category && banner.category.isActive !== false) {
            const isValid = await isCategoryValid(banner.category._id);
            if (isValid) {
                // Keep only name and id in populated category to match original behavior
                banner.category = {
                    _id: banner.category._id,
                    name: banner.category.name
                };
                filteredBanners.push(banner);
            }
        }
    }

    // Get service sections
    const serviceSections = await ServiceSection.find({})
        .sort({ order: 1 })
        .populate('category')
        .populate('subcategory');

    // For each service section, get the services
    const sectionsWithServices = await Promise.all(
        serviceSections.map(async (section) => {
            // Check if category or subcategory is missing or inactive
            if (!section.category || section.category.isActive === false ||
                !section.subcategory || section.subcategory.isActive === false) {
                return null;
            }

            const isCatOk = await isCategoryValid(section.category._id);
            const isSubOk = await isSubcategoryValid(section.subcategory._id);
            if (!isCatOk || !isSubOk) {
                return null;
            }

            const services = await Service.find({
                category: section.category._id,
                subcategory: section.subcategory._id,
                isActive: { $ne: false }
            })
                .limit(section.limit)
                .select('title description photo approxCompletionTime serviceCharge isAdminPriced category subcategory serviceType')
                .populate('category', '_id name')
                .populate('subcategory', '_id name')
                .populate('serviceType');

            // Filter services to ensure their serviceType (if any) is valid
            const filteredServices = [];
            for (const s of services) {
                if (s.serviceType) {
                    const isTypeOk = await isServiceTypeValid(s.serviceType._id);
                    if (isTypeOk) {
                        filteredServices.push(s);
                    }
                } else {
                    filteredServices.push(s);
                }
            }

            if (filteredServices.length === 0) {
                return null;
            }

            return {
                _id: section._id,
                title: section.title,
                category: { _id: section.category._id, name: section.category.name },
                subcategory: { _id: section.subcategory._id, name: section.subcategory.name },
                services: filteredServices
            };
        })
    );

    return {
        banners: filteredBanners,
        serviceSections: sectionsWithServices.filter(Boolean)
    };
};

/**
 * ADMIN/PUBLIC: Get all service sections
 * Query params: ignoreEmpty (boolean)
 */
const getAllServiceSections = async (query = {}) => {
    const { isCategoryValid, isSubcategoryValid, isServiceTypeValid } = require('../service/service.service');
    const filter = {};

    const sections = await ServiceSection.find(filter)
        .sort({ order: 1 })
        .populate('category')
        .populate('subcategory');

    const sectionsWithServices = await Promise.all(
        sections.map(async (section) => {
            // Handle missing or inactive category or subcategory
            if (!section.category || section.category.isActive === false ||
                !section.subcategory || section.subcategory.isActive === false) {
                return {
                    ...section.toObject(),
                    services: [],
                    totalServices: 0,
                    isOrphaned: true
                };
            }

            const isCatOk = await isCategoryValid(section.category._id);
            const isSubOk = await isSubcategoryValid(section.subcategory._id);
            if (!isCatOk || !isSubOk) {
                return {
                    ...section.toObject(),
                    services: [],
                    totalServices: 0,
                    isOrphaned: true
                };
            }

            // Find services for this section
            const services = await Service.find({
                category: section.category._id,
                subcategory: section.subcategory._id,
                isActive: { $ne: false }
            })
                .limit(section.limit) // limit to section's limit
                .sort({ order: 1 })
                .populate('category', '_id name icon')
                .populate('subcategory', '_id name icon')
                .populate('serviceType');

            const filteredServices = [];
            for (const s of services) {
                if (s.serviceType) {
                    const isTypeOk = await isServiceTypeValid(s.serviceType._id);
                    if (isTypeOk) {
                        filteredServices.push(s);
                    }
                } else {
                    filteredServices.push(s);
                }
            }

            // If ignoreEmpty is true and no services, filter this section out
            if (query.ignoreEmpty === 'true' && filteredServices.length === 0) {
                return null;
            }

            const count = filteredServices.length;

            return {
                ...section.toObject(),
                category: { _id: section.category._id, name: section.category.name, icon: section.category.icon },
                subcategory: { _id: section.subcategory._id, name: section.subcategory.name, icon: section.subcategory.icon },
                services: filteredServices,
                totalServices: count
            };
        })
    );

    return sectionsWithServices.filter(Boolean);
};

/**
 * ADMIN: Create service section
 */
const createServiceSection = async (data) => {
    const section = await ServiceSection.create(data);
    return section;
};

/**
 * ADMIN: Update service section
 */
const updateServiceSection = async (id, data) => {
    const section = await ServiceSection.findByIdAndUpdate(id, data, { new: true });
    if (!section) throw new ApiError(404, 'Service section not found');
    return section;
};

/**
 * ADMIN: Delete service section
 */
const deleteServiceSection = async (id) => {
    const section = await ServiceSection.findByIdAndDelete(id);
    if (!section) throw new ApiError(404, 'Service section not found');
    return section;
};

/**
 * Get all banners (role-aware: user, vendor, or admin)
 */
const getAllBanners = async (query = {}) => {
    const filter = {};

    if (query.type) {
        filter.type = query.type;
    } else if (query.fetchAll === 'true') {
        // Admin fetching all — no type filter
    } else {
        // Auto-detect based on role
        const role = (query.role || '').toLowerCase();
        if (role === 'vendor') {
            filter.type = 'vendor';
        } else {
            // Default to user (for user role, admin without fetchAll, or unknown)
            filter.type = 'user';
        }
    }

    const banners = await Banner.find(filter)
        .sort({ order: 1 })
        .populate('category', 'name')
        .select('title description image category order type');
    return banners;
};

/**
 * ADMIN: Create banner
 */
const createBanner = async (data) => {
    const banner = await Banner.create(data);
    return banner;
};

/**
 * ADMIN: Update banner
 */
const updateBanner = async (id, data) => {
    const banner = await Banner.findByIdAndUpdate(id, data, { new: true });
    if (!banner) throw new ApiError(404, 'Banner not found');
    return banner;
};

/**
 * ADMIN: Delete banner
 */
const deleteBanner = async (id) => {
    const banner = await Banner.findByIdAndDelete(id);
    if (!banner) throw new ApiError(404, 'Banner not found');
    return banner;
};

/**
 * USER: Get vendor banners (only vendors can access)
 */
const getVendorBanners = async (role) => {
    const normalizedRole = (role || '').toLowerCase();
    if (normalizedRole !== 'vendor') {
        return [];
    }
    const banners = await Banner.find({ type: 'vendor' })
        .sort({ order: 1 })
        .select('title description image order');
    return banners;
};

/**
 * PUBLIC: Get top 4 best services based on average rating
 */
const getBestServices = async () => {
    const { isCategoryValid, isSubcategoryValid, isServiceTypeValid } = require('../service/service.service');

    const result = await Booking.aggregate([
        // Only completed bookings with a rating
        { $match: { status: 'completed', 'rating.value': { $exists: true, $ne: null } } },
        // Unwind services array to get individual service entries
        { $unwind: '$services' },
        // Group by service ID and calculate average rating
        {
            $group: {
                _id: '$services.service',
                avgRating: { $avg: '$rating.value' },
                totalRatings: { $sum: 1 }
            }
        },
        // Sort by average rating descending
        { $sort: { avgRating: -1 } },
        // Take a larger limit initially so we can filter inactive/empty ones in JS and still have enough
        { $limit: 30 },
        // Lookup service details
        {
            $lookup: {
                from: 'services',
                localField: '_id',
                foreignField: '_id',
                as: 'service'
            }
        },
        { $unwind: '$service' },
        // Only keep active services
        { $match: { 'service.isActive': { $ne: false } } },
        // Lookup category
        {
            $lookup: {
                from: 'categories',
                localField: 'service.category',
                foreignField: '_id',
                as: 'category'
            }
        },
        // Lookup subcategory
        {
            $lookup: {
                from: 'subcategories',
                localField: 'service.subcategory',
                foreignField: '_id',
                as: 'subcategory'
            }
        },
        // Project final shape
        {
            $project: {
                _id: '$service._id',
                title: '$service.title',
                description: '$service.description',
                photo: '$service.photo',
                adminPrice: '$service.serviceCharge',
                isAdminPriced: '$service.isAdminPriced',
                approxCompletionTime: '$service.approxCompletionTime',
                avgRating: { $round: ['$avgRating', 1] },
                totalRatings: 1,
                category: { $arrayElemAt: [{ $map: { input: '$category', as: 'c', in: { _id: '$$c._id', name: '$$c.name', isActive: '$$c.isActive' } } }, 0] },
                subcategory: { $arrayElemAt: [{ $map: { input: '$subcategory', as: 's', in: { _id: '$$s._id', name: '$$s.name', isActive: '$$s.isActive' } } }, 0] }
            }
        }
    ]);

    // Now validate hierarchy on the result in JavaScript
    const filteredResult = [];
    for (const r of result) {
        if (!r.category || r.category.isActive === false) continue;
        if (r.subcategory && r.subcategory.isActive === false) continue;

        // Find if service type is active/valid
        const serviceDoc = await Service.findById(r._id);
        if (serviceDoc && serviceDoc.serviceType) {
            const isTypeOk = await isServiceTypeValid(serviceDoc.serviceType);
            if (!isTypeOk) continue;
        }

        const isCatOk = await isCategoryValid(r.category._id);
        const isSubOk = r.subcategory ? await isSubcategoryValid(r.subcategory._id) : true;
        if (isCatOk && isSubOk) {
            filteredResult.push({
                _id: r._id,
                title: r.title,
                description: r.description,
                photo: r.photo,
                adminPrice: r.adminPrice,
                isAdminPriced: r.isAdminPriced,
                approxCompletionTime: r.approxCompletionTime,
                avgRating: r.avgRating,
                totalRatings: r.totalRatings,
                category: { _id: r.category._id, name: r.category.name },
                subcategory: r.subcategory ? { _id: r.subcategory._id, name: r.subcategory.name } : null
            });
        }
    }

    // Limit to top 4
    const finalResult = filteredResult.slice(0, 4);

    // If there are less than 4 rated services, fetch additional services to fill the gap
    if (finalResult.length < 4) {
        const excludeIds = finalResult.map(s => s._id);

        // Fetch a pool of active services and filter them in JS
        const pool = await Service.find({ _id: { $nin: excludeIds }, isActive: { $ne: false } })
            .populate('category')
            .populate('subcategory')
            .populate('serviceType');

        const additional = [];
        for (const s of pool) {
            if (additional.length >= (4 - finalResult.length)) break;

            if (!s.category || s.category.isActive === false) continue;
            if (s.subcategory && s.subcategory.isActive === false) continue;

            const isTypeOk = s.serviceType ? await isServiceTypeValid(s.serviceType._id) : true;
            const isSubOk = s.subcategory ? await isSubcategoryValid(s.subcategory._id) : true;
            const isCatOk = await isCategoryValid(s.category._id);

            if (isTypeOk && isSubOk && isCatOk) {
                additional.push({
                    _id: s._id,
                    title: s.title,
                    description: s.description,
                    photo: s.photo,
                    adminPrice: s.serviceCharge,
                    isAdminPriced: s.isAdminPriced,
                    approxCompletionTime: s.approxCompletionTime,
                    avgRating: 0,
                    totalRatings: 0,
                    category: { _id: s.category._id, name: s.category.name },
                    subcategory: s.subcategory ? { _id: s.subcategory._id, name: s.subcategory.name } : null
                });
            }
        }

        finalResult.push(...additional);
    }

    return finalResult;
};

module.exports = {
    getDashboardData,
    getAllServiceSections,
    createServiceSection,
    updateServiceSection,
    deleteServiceSection,
    getAllBanners,
    createBanner,
    updateBanner,
    deleteBanner,
    getVendorBanners,
    getBestServices
};
