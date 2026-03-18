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
    // Get banners
    const banners = await Banner.find({ type: 'user' })
        .sort({ order: 1 })
        .populate('category', '_id name')
        .select('title description image category order')
        .then(docs => docs.filter(doc => doc.category)); // Filter out orphaned banners

    // Get service sections
    const serviceSections = await ServiceSection.find({})
        .sort({ order: 1 })
        .populate('category', '_id name')
        .populate('subcategory', '_id name');

    // For each service section, get the services
    const sectionsWithServices = await Promise.all(
        serviceSections.map(async (section) => {
            // Check if category or subcategory is missing
            if (!section.category || !section.subcategory) {
                return null;
            }

            const services = await Service.find({
                category: section.category._id,
                subcategory: section.subcategory._id
            })
                .limit(section.limit)
                .select('title description photo approxCompletionTime adminPrice isAdminPriced category subcategory')
                .populate('category', '_id name')
                .populate('subcategory', '_id name');

            return {
                _id: section._id,
                title: section.title,
                category: section.category,
                subcategory: section.subcategory,
                services
            };
        })
    );

    return {
        banners,
        serviceSections: sectionsWithServices.filter(Boolean)
    };
};

/**
 * ADMIN/PUBLIC: Get all service sections
 * Query params: ignoreEmpty (boolean)
 */
const getAllServiceSections = async (query = {}) => {
    const filter = {};

    const sections = await ServiceSection.find(filter)
        .sort({ order: 1 })
        .populate('category', 'name icon')
        .populate('subcategory', 'name icon');

    const sectionsWithServices = await Promise.all(
        sections.map(async (section) => {
            // Handle missing category or subcategory
            if (!section.category || !section.subcategory) {
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
                subcategory: section.subcategory._id
            })
                .limit(section.limit) // limit to section's limit
                .sort({ order: 1 }) // implied service order, or createdAt
                // .select('title description photo approxCompletionTime adminPrice isAdminPriced category subcategory') // Removed to return everything
                .populate('category', '_id name icon')
                .populate('subcategory', '_id name icon');

            // If ignoreEmpty is true and no services, filter this section out
            if (query.ignoreEmpty === 'true' && services.length === 0) {
                return null;
            }

            // Get total count of services for this subcategory
            const count = await Service.countDocuments({
                category: section.category._id,
                subcategory: section.subcategory._id
            });

            return {
                ...section.toObject(),
                services,
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
 * ADMIN: Get all banners
 */
const getAllBanners = async (query = {}) => {
    const filter = {};

    if (query.type) {
        filter.type = query.type;
    } else if (query.fetchAll !== 'true') {
        // Default to user banners if not fetching all (Admin requires all)
        filter.type = 'user';
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
 * USER: Get vendor banners
 */
const getVendorBanners = async () => {
    const banners = await Banner.find({ type: 'vendor' })
        .sort({ order: 1 })
        .select('title description image order');
    return banners;
};

/**
 * PUBLIC: Get top 4 best services based on average rating
 */
const getBestServices = async () => {
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
        // Take top 4
        { $limit: 4 },
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
                adminPrice: '$service.adminPrice',
                isAdminPriced: '$service.isAdminPriced',
                approxCompletionTime: '$service.approxCompletionTime',
                avgRating: { $round: ['$avgRating', 1] },
                totalRatings: 1,
                category: { $arrayElemAt: [{ $map: { input: '$category', as: 'c', in: { _id: '$$c._id', name: '$$c.name' } } }, 0] },
                subcategory: { $arrayElemAt: [{ $map: { input: '$subcategory', as: 's', in: { _id: '$$s._id', name: '$$s.name' } } }, 0] }
            }
        }
    ]);

    // If there are less than 4 rated services, fetch additional services to fill the gap
    if (result.length < 4) {
        const excludeIds = result.map(s => s._id);
        const limit = 4 - result.length;

        const additionalServices = await Service.find({ _id: { $nin: excludeIds } })
            .limit(limit)
            .select('title description photo approxCompletionTime adminPrice isAdminPriced category subcategory')
            .populate('category', '_id name')
            .populate('subcategory', '_id name');

        const formattedAdditional = additionalServices.map(s => ({
            _id: s._id,
            title: s.title,
            description: s.description,
            photo: s.photo,
            adminPrice: s.adminPrice,
            isAdminPriced: s.isAdminPriced,
            approxCompletionTime: s.approxCompletionTime,
            avgRating: 0,
            totalRatings: 0,
            category: s.category,
            subcategory: s.subcategory
        }));

        result.push(...formattedAdditional);
    }

    return result;
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
