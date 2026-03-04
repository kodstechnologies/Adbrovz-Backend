const ServiceSection = require('../../models/ServiceSection.model');
const Banner = require('../../models/Banner.model');
const Service = require('../../models/Service.model');
const ApiError = require('../../utils/ApiError');

/**
 * USER: Get dashboard data (service sections + banners)
 */
const getDashboardData = async () => {
    // Get active banners
    const banners = await Banner.find({ isActive: true, type: 'user' })
        .sort({ order: 1 })
        .populate('category', '_id name')
        .select('title description image category order')
        .then(docs => docs.filter(doc => doc.category)); // Filter out orphaned banners

    // Get active service sections
    const serviceSections = await ServiceSection.find({ isActive: true })
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
                subcategory: section.subcategory._id,
                isActive: true
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
 * Query params: isActive (boolean), ignoreEmpty (boolean)
 */
const getAllServiceSections = async (query = {}) => {
    const filter = {};
    if (query.isActive) {
        filter.isActive = query.isActive === 'true';
    }

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
                subcategory: section.subcategory._id,
                isActive: true
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

            // Get total count of active services for this subcategory
            const count = await Service.countDocuments({
                category: section.category._id,
                subcategory: section.subcategory._id,
                isActive: true
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
        .select('title description image category order isActive type');
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
    const banners = await Banner.find({ isActive: true, type: 'vendor' })
        .sort({ order: 1 })
        .select('title description image order');
    return banners;
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
    getVendorBanners
};
