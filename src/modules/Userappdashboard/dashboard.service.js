const ServiceSection = require('../../models/ServiceSection.model');
const Banner = require('../../models/Banner.model');
const Service = require('../../models/Service.model');
const ApiError = require('../../utils/ApiError');

/**
 * USER: Get dashboard data (service sections + banners)
 */
const getDashboardData = async () => {
    // Get active banners
    const banners = await Banner.find({ isActive: true })
        .sort({ order: 1 })
        .populate('category', '_id name')
        .select('title image category order');

    // Get active service sections
    const serviceSections = await ServiceSection.find({ isActive: true })
        .sort({ order: 1 })
        .populate('category', '_id name')
        .populate('subcategory', '_id name');

    // For each service section, get the services
    const sectionsWithServices = await Promise.all(
        serviceSections.map(async (section) => {
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
        serviceSections: sectionsWithServices
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
        .populate('category', 'name')
        .populate('subcategory', 'name');

    const sectionsWithServices = await Promise.all(
        sections.map(async (section) => {
            // Find services for this section
            const services = await Service.find({
                category: section.category._id,
                subcategory: section.subcategory._id,
                isActive: true
            })
                .limit(section.limit) // limit to section's limit
                .sort({ order: 1 }) // implied service order, or createdAt
                .select('title description photo approxCompletionTime adminPrice isAdminPriced category subcategory')
                .populate('category', '_id name')
                .populate('subcategory', '_id name');

            // If ignoreEmpty is true and no services, filter this section out
            if (query.ignoreEmpty === 'true' && services.length === 0) {
                return null;
            }

            return {
                ...section.toObject(),
                services
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
const getAllBanners = async () => {
    const banners = await Banner.find()
        .sort({ order: 1 })
        .populate('category', 'name');
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

module.exports = {
    getDashboardData,
    getAllServiceSections,
    createServiceSection,
    updateServiceSection,
    deleteServiceSection,
    getAllBanners,
    createBanner,
    updateBanner,
    deleteBanner
};
