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
 * =========================
 * PUBLIC APIs
 * =========================
 */

const _calculateServicePricing = (service) => {
    const adminPrice = service.bookingPrice || 
                      service.serviceType?.bookingPrice || 
                      service.subcategory?.bookingPrice || 
                      service.category?.bookingPrice ||
                      service.serviceCharge || 
                      service.serviceType?.serviceCharge || 
                      service.subcategory?.serviceCharge || 
                      service.category?.serviceCharge || 0;

    const discountPercentage = service.discount || 
                    service.serviceType?.discount || 
                    service.subcategory?.discount || 
                    service.category?.discount || 0;

    let discountPrice = adminPrice;
    if (adminPrice > 0 && discountPercentage > 0) {
        discountPrice = adminPrice - (adminPrice * (discountPercentage / 100));
        // Round to 2 decimal places to avoid float issues
        discountPrice = Math.round(discountPrice * 100) / 100;
    }

    return {
        adminPrice: adminPrice,
        discountPercentage: discountPercentage,
        discountPrice: discountPrice
    };
};

const _isValidId = (id) => typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id);

const _buildManagementRow = ({ key, label, items, selectedId, dependsOn, emptyMessage }) => ({
    key,
    label,
    selectedId: selectedId || null,
    dependsOn: dependsOn || null,
    isEnabled: !dependsOn || Boolean(dependsOn.selectedId),
    count: items.length,
    emptyMessage,
    items
});

/**
 * Get all categories
 */
const getAllCategories = async () => {
    const categories = await Category.find({})
        .sort({ order: 1, name: 1 })
        .select('name description icon defaultFreeCredits slotStartTime slotEndTime serviceCharge bookingPrice membershipCharge serviceRenewalCharge membershipRenewalCharge renewalCharge');
    return categories;
};

/**
 * Admin/Public helper: return 4-row service management data in a single payload.
 * Row flow: Category -> Subcategory -> Service Type -> Service
 */
const getServiceManagementRows = async ({ categoryId, subcategoryId, serviceTypeId } = {}) => {
    const selected = {
        categoryId: categoryId || null,
        subcategoryId: subcategoryId || null,
        serviceTypeId: serviceTypeId || null
    };

    if (selected.categoryId && !_isValidId(selected.categoryId)) {
        throw new ApiError(400, 'Invalid categoryId');
    }
    if (selected.subcategoryId && !_isValidId(selected.subcategoryId)) {
        throw new ApiError(400, 'Invalid subcategoryId');
    }
    if (selected.serviceTypeId && !_isValidId(selected.serviceTypeId)) {
        throw new ApiError(400, 'Invalid serviceTypeId');
    }

    // Resolve category from selected subcategory when category is missing.
    if (selected.subcategoryId) {
        const selectedSubcategory = await Subcategory.findById(selected.subcategoryId).select('category');
        if (!selectedSubcategory) {
            throw new ApiError(404, 'Subcategory not found');
        }

        if (selected.categoryId && selectedSubcategory.category.toString() !== selected.categoryId) {
            throw new ApiError(400, 'Selected subcategory does not belong to selected category');
        }

        if (!selected.categoryId) {
            selected.categoryId = selectedSubcategory.category.toString();
        }
    }

    // Resolve/validate full chain from selected service type.
    if (selected.serviceTypeId) {
        const selectedType = await ServiceType.findById(selected.serviceTypeId).select('category subcategory');
        if (!selectedType) {
            throw new ApiError(404, 'Service type not found');
        }

        const typeCategoryId = selectedType.category.toString();
        const typeSubcategoryId = selectedType.subcategory.toString();

        if (selected.categoryId && selected.categoryId !== typeCategoryId) {
            throw new ApiError(400, 'Selected service type does not belong to selected category');
        }
        if (selected.subcategoryId && selected.subcategoryId !== typeSubcategoryId) {
            throw new ApiError(400, 'Selected service type does not belong to selected subcategory');
        }

        selected.categoryId = typeCategoryId;
        selected.subcategoryId = typeSubcategoryId;
    }

    let [categories, subcategories, serviceTypes, services] = await Promise.all([
        Category.find({})
            .sort({ order: 1, name: 1 }).lean(),
        selected.categoryId
            ? Subcategory.find({ category: selected.categoryId })
                .sort({ order: 1, name: 1 }).lean()
            : [],
        selected.subcategoryId
            ? ServiceType.find({ subcategory: selected.subcategoryId })
                .sort({ order: 1, name: 1 }).lean()
            : [],
        selected.serviceTypeId
            ? Service.find({ serviceType: selected.serviceTypeId })
                .sort({ title: 1 }).lean()
            : []
    ]);

    categories = await Promise.all(categories.map(async (c) => {
        c.subcategoriesCount = await Subcategory.countDocuments({ category: c._id });
        c.id = c._id.toString();
        return c;
    }));
    
    if (subcategories.length > 0) {
        subcategories = await Promise.all(subcategories.map(async (s) => {
            s.serviceTypesCount = await ServiceType.countDocuments({ subcategory: s._id });
            s.id = s._id.toString();
            return s;
        }));
    }
    
    if (serviceTypes.length > 0) {
        serviceTypes = await Promise.all(serviceTypes.map(async (st) => {
            st.servicesCount = await Service.countDocuments({ serviceType: st._id });
            st.id = st._id.toString();
            return st;
        }));
    }

    if (services.length > 0) {
        services = services.map(s => {
            s.id = s._id.toString();
            return s;
        });
    }

    return {
        selected,
        categories,
        subcategories,
        serviceTypes,
        services,
        rows: {
            categories: _buildManagementRow({
                key: 'categories',
                label: 'Categories',
                items: categories,
                selectedId: selected.categoryId,
                emptyMessage: 'No categories available.'
            }),
            subcategories: _buildManagementRow({
                key: 'subcategories',
                label: 'Subcategories',
                items: subcategories,
                selectedId: selected.subcategoryId,
                dependsOn: {
                    key: 'categories',
                    selectedId: selected.categoryId
                },
                emptyMessage: selected.categoryId
                    ? 'No subcategories found for the selected category.'
                    : 'Select a category to load subcategories.'
            }),
            serviceTypes: _buildManagementRow({
                key: 'serviceTypes',
                label: 'Service Types',
                items: serviceTypes,
                selectedId: selected.serviceTypeId,
                dependsOn: {
                    key: 'subcategories',
                    selectedId: selected.subcategoryId
                },
                emptyMessage: selected.subcategoryId
                    ? 'No service types found for the selected subcategory.'
                    : 'Select a subcategory to load service types.'
            }),
            services: _buildManagementRow({
                key: 'services',
                label: 'Services',
                items: services,
                dependsOn: {
                    key: 'serviceTypes',
                    selectedId: selected.serviceTypeId
                },
                emptyMessage: selected.serviceTypeId
                    ? 'No services found for the selected service type.'
                    : 'Select a service type to load services.'
            })
        }
    };
};

/**
 * Get subcategories by category ID
 */
const getSubcategoriesByCategoryId = async (categoryId) => {
    const subcategories = await Subcategory.find({ category: categoryId })
        .sort({ order: 1, name: 1 })
        .select('name description icon order price serviceCharge bookingPrice coupon discount membershipCharge serviceRenewalCharge membershipRenewalCharge renewalCharge');

    return subcategories;
};

/**
 * Get service types by subcategory ID
 */
const getServiceTypesBySubcategoryId = async (subcategoryId) => {
    const serviceTypes = await ServiceType.find({ subcategory: subcategoryId })
        .populate('category', 'name')
        .populate('subcategory', 'name')
        .sort({ order: 1, name: 1 })
        .select('name description photo order serviceCharge bookingPrice coupon discount membershipCharge serviceRenewalCharge membershipRenewalCharge category subcategory');

    return serviceTypes;
};

/**
 * Get service types by multiple subcategory IDs with details, grouped by subcategory
 */
const getServiceTypesBySubcategories = async (subcategoryIds) => {
    if (!Array.isArray(subcategoryIds) || subcategoryIds.length === 0) {
        throw new ApiError(400, 'subcategoryIds must be a non-empty array');
    }

    const serviceTypes = await ServiceType.find({ subcategory: { $in: subcategoryIds } })
        .populate('category', 'name')
        .populate('subcategory', 'name')
        .sort({ order: 1, name: 1 });

    // Group service types by subcategory name
    const groupedTypes = serviceTypes.reduce((acc, type) => {
        const subName = type.subcategory?.name || 'Other';
        if (!acc[subName]) {
            acc[subName] = {
                subcategoryName: subName,
                serviceTypes: []
            };
        }
        acc[subName].serviceTypes.push(type);
        return acc;
    }, {});

    return Object.values(groupedTypes);
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
            'title description photo approxCompletionTime serviceCharge bookingPrice isAdminPriced moreInfo quantityEnabled priceAdjustmentEnabled coupon discount serviceType subcategory category membershipCharge serviceRenewalCharge membershipRenewalCharge renewalCharge'
        )
        .populate('serviceType', 'serviceCharge bookingPrice discount coupon')
        .populate('subcategory', 'serviceCharge bookingPrice discount coupon')
        .populate('category', 'serviceCharge bookingPrice discount coupon');

    const total = await Service.countDocuments(query);

    const formattedServices = services.map(service => {
        const doc = service.toJSON();
        const pricing = _calculateServicePricing(service);
        
        // Convert populated fields back to string IDs to maintain schema structure
        if (doc.serviceType && doc.serviceType.id) doc.serviceType = doc.serviceType.id;
        else if (doc.serviceType && doc.serviceType._id) doc.serviceType = doc.serviceType._id.toString();
        if (doc.subcategory && doc.subcategory.id) doc.subcategory = doc.subcategory.id;
        else if (doc.subcategory && doc.subcategory._id) doc.subcategory = doc.subcategory._id.toString();
        if (doc.category && doc.category.id) doc.category = doc.category.id;
        else if (doc.category && doc.category._id) doc.category = doc.category._id.toString();

        return {
            ...doc,
            adminPrice: pricing.adminPrice,
            discountPercentage: pricing.discountPercentage,
            discountPrice: pricing.discountPrice
        };
    });

    return {
        categoryId: serviceType.category?._id ? serviceType.category._id.toString() : serviceType.category,
        subcategoryId: serviceType.subcategory?._id ? serviceType.subcategory._id.toString() : serviceType.subcategory,
        services: formattedServices,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
        }
    };
};

/**
 * Get services by multiple service type IDs with pagination
 */
const getServicesByTypes = async (typeIds, options = {}) => {
    const { page = 1, limit = 10, search } = options;
    const skip = (page - 1) * limit;

    if (!Array.isArray(typeIds) || typeIds.length === 0) {
        throw new ApiError(400, 'typeIds must be a non-empty array');
    }

    const query = {
        serviceType: { $in: typeIds }
    };

    if (search) {
        query.title = { $regex: search, $options: 'i' };
    }

    const services = await Service.find(query)
        .sort({ title: 1 })
        .skip(skip)
        .limit(limit)
        .select(
            'title description photo approxCompletionTime serviceCharge bookingPrice isAdminPriced moreInfo quantityEnabled priceAdjustmentEnabled coupon discount serviceType subcategory category membershipCharge serviceRenewalCharge membershipRenewalCharge renewalCharge'
        )
        .populate('serviceType', 'name serviceCharge bookingPrice discount coupon')
        .populate('subcategory', 'serviceCharge bookingPrice discount coupon')
        .populate('category', 'serviceCharge bookingPrice discount coupon');

    const total = await Service.countDocuments(query);

    // Group services by service type ID
    const groupedServices = services.reduce((acc, service) => {
        const typeId = service.serviceType?._id?.toString() || service.serviceType?.toString() || 'Other';
        if (!acc[typeId]) {
            acc[typeId] = {
                serviceTypeId: typeId,
                serviceTypeName: service.serviceType?.name || 'Other',
                servicesGroup: []
            };
        }
        
        const doc = service.toJSON();
        const pricing = _calculateServicePricing(service);
        
        // Convert populated fields back to string IDs
        if (doc.serviceType && doc.serviceType.id) doc.serviceType = doc.serviceType.id;
        else if (doc.serviceType && doc.serviceType._id) doc.serviceType = doc.serviceType._id.toString();
        if (doc.subcategory && doc.subcategory.id) doc.subcategory = doc.subcategory.id;
        else if (doc.subcategory && doc.subcategory._id) doc.subcategory = doc.subcategory._id.toString();
        if (doc.category && doc.category.id) doc.category = doc.category.id;
        else if (doc.category && doc.category._id) doc.category = doc.category._id.toString();

        acc[typeId].servicesGroup.push({
            ...doc,
            adminPrice: pricing.adminPrice,
            discountPercentage: pricing.discountPercentage,
            discountPrice: pricing.discountPrice
        });
        
        return acc;
    }, {});

    // Convert grouped object to array
    const result = Object.values(groupedServices);

    return {
        categoryId: services.length > 0 ? (services[0].category?._id ? services[0].category._id.toString() : services[0].category) : null,
        data: result,
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
            'title description photo approxCompletionTime serviceCharge bookingPrice isAdminPriced moreInfo quantityEnabled priceAdjustmentEnabled coupon discount serviceType subcategory category'
        )
        .populate('serviceType', 'serviceCharge bookingPrice discount coupon')
        .populate('subcategory', 'serviceCharge bookingPrice discount coupon')
        .populate('category', 'serviceCharge bookingPrice discount coupon');

    const total = await Service.countDocuments(query);

    const formattedServices = services.map(service => {
        const doc = service.toJSON();
        const pricing = _calculateServicePricing(service);
        
        // Convert populated fields back to string IDs
        if (doc.serviceType && doc.serviceType.id) doc.serviceType = doc.serviceType.id;
        else if (doc.serviceType && doc.serviceType._id) doc.serviceType = doc.serviceType._id.toString();
        if (doc.subcategory && doc.subcategory.id) doc.subcategory = doc.subcategory.id;
        else if (doc.subcategory && doc.subcategory._id) doc.subcategory = doc.subcategory._id.toString();
        if (doc.category && doc.category.id) doc.category = doc.category.id;
        else if (doc.category && doc.category._id) doc.category = doc.category._id.toString();

        return {
            ...doc,
            adminPrice: pricing.adminPrice,
            discountPercentage: pricing.discountPercentage,
            discountPrice: pricing.discountPrice
        };
    });

    return {
        categoryId: subcategory.category?._id ? subcategory.category._id.toString() : subcategory.category,
        services: formattedServices,
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
            .populate('category', 'name serviceCharge bookingPrice discount coupon')
            .populate('subcategory', 'name serviceCharge bookingPrice discount coupon')
            .populate('serviceType', 'name serviceCharge bookingPrice discount coupon')
            .select(
                'title description photo serviceCharge bookingPrice approxCompletionTime category subcategory serviceType discount coupon'
            )
            .limit(20)
    ]);

    const formattedServices = services.map(service => {
        const doc = service.toJSON();
        const pricing = _calculateServicePricing(service);
        
        // Retain original behavior in globalSearch, but strip out the pricing sub-fields if desired as strings,
        // Wait, for globalSearch, they probably want string IDs as well to be consistent. Let's do that.
        if (doc.serviceType && doc.serviceType.id) doc.serviceType = doc.serviceType.id;
        else if (doc.serviceType && doc.serviceType._id) doc.serviceType = doc.serviceType._id.toString();
        if (doc.subcategory && doc.subcategory.id) doc.subcategory = doc.subcategory.id;
        else if (doc.subcategory && doc.subcategory._id) doc.subcategory = doc.subcategory._id.toString();
        if (doc.category && doc.category.id) doc.category = doc.category.id;
        else if (doc.category && doc.category._id) doc.category = doc.category._id.toString();

        return {
            ...doc,
            adminPrice: pricing.adminPrice,
            discountPercentage: pricing.discountPercentage,
            discountPrice: pricing.discountPrice
        };
    });

    return {
        categories,
        subcategories,
        services: formattedServices
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
        const pricing = _calculateServicePricing(s);
        
        // Optionally revert to string IDs if they are not specifically expected as objects
        // However getAllServices relies on populated names, so we'll just remove serviceCharge/discount wrapper if needed.
        // Since we didn't add serviceCharge to 'category' here, let's leave it intact.
        
        doc.adminPrice = pricing.adminPrice;
        doc.discountPercentage = pricing.discountPercentage;
        doc.discountPrice = pricing.discountPrice;
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
    // Ensure category is present if subcategory is provided
    if (data.subcategory && !data.category) {
        const sub = await Subcategory.findById(data.subcategory);
        if (sub) data.category = sub.category;
    }
    return await ServiceType.create(data);
};

/**
 * Admin: Update Service Type
 */
const updateServiceType = async (serviceTypeId, data) => {
    const serviceType = await ServiceType.findById(serviceTypeId);
    if (!serviceType) throw new ApiError(404, 'Service type not found');

    // Ensure category is present if subcategory is provided/changed
    if (data.subcategory && !data.category) {
        const sub = await Subcategory.findById(data.subcategory);
        if (sub) data.category = sub.category;
    }

    if (
        data.photo &&
        serviceType.photo &&
        serviceType.photo.includes('cloudinary.com') &&
        data.photo !== serviceType.photo
    ) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(serviceType.photo);
        } catch (error) {
            console.error('Error deleting old service type image from Cloudinary:', error);
        }
    }

    return await ServiceType.findByIdAndUpdate(serviceTypeId, data, { new: true });
};

/**
 * Admin: Delete Service Type
 */
const deleteServiceType = async (serviceTypeId) => {
    const serviceType = await ServiceType.findById(serviceTypeId);
    if (!serviceType) throw new ApiError(404, 'Service type not found');

    if (serviceType.photo && serviceType.photo.includes('cloudinary.com')) {
        try {
            const cloudinaryService = require('../services/cloudinary.service');
            await cloudinaryService.deleteFromCloudinary(serviceType.photo);
        } catch (error) {
            console.error('Error deleting service type image from Cloudinary:', error);
        }
    }

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

    // Normalize prices and set isAdminPriced
    const normalizePrice = (val) => (val === '' || val === undefined || val === null || val === 'null' ? 0 : Number(val));
    data.serviceCharge = normalizePrice(data.serviceCharge);
    data.bookingPrice = normalizePrice(data.bookingPrice);
    data.isAdminPriced = data.serviceCharge > 0 || data.bookingPrice > 0;

    return await Service.create(data);
};

/**
 * Admin: Update Service
 */
const updateService = async (serviceId, data) => {
    const service = await Service.findById(serviceId);
    if (!service) throw new ApiError(404, 'Service not found');

    const validateId = (id) => {
        if (!id) return null;
        const strId = String(id).trim();
        if (strId === 'null' || strId === 'undefined' || strId === '') return null;
        return strId;
    };

    if (data.category !== undefined) data.category = validateId(data.category);
    if (data.subcategory !== undefined) data.subcategory = validateId(data.subcategory);
    if (data.serviceType !== undefined) data.serviceType = validateId(data.serviceType);

    if (data.category === null && (data.subcategory || data.serviceType)) {
        // Try to recover category from subcategory if possible
        const subId = data.subcategory || service.subcategory;
        if (subId) {
            const sub = await Subcategory.findById(subId);
            if (sub) data.category = sub.category;
        }
    }

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

    // Normalize prices and set isAdminPriced
    const normalizePrice = (val) => (val === '' || val === undefined || val === null || val === 'null' ? 0 : Number(val));
    data.serviceCharge = normalizePrice(data.serviceCharge);
    data.bookingPrice = normalizePrice(data.bookingPrice);
    data.isAdminPriced = data.serviceCharge > 0 || data.bookingPrice > 0;

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
                                    $addFields: {
                                        description: { $ifNull: ['$description', ''] },
                                        photo: { $ifNull: ['$photo', null] }
                                    }
                                },
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
                serviceCharge: 1,
                bookingPrice: 1,
                coupon: 1,
                discount: 1,
                membershipCharge: 1,
                membershipRenewalCharge: 1,
                serviceRenewalCharge: 1,
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
                            membershipCharge: {
                                $cond: [
                                    { $gt: ['$membershipCharge', 0] },
                                    '$membershipCharge',
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
                serviceRenewalCharge: 1,
                renewalCharge: 1,
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
 * Public: Get full catalogue grouped as category -> subcategory -> service type -> services
 */
const getServiceCatalogue = async () => {
    const categories = await Category.find({})
        .select('name _id')
        .sort({ order: 1, name: 1 })
        .lean();

    const subcategories = await Subcategory.find({})
        .select('name _id category')
        .sort({ order: 1, name: 1 })
        .lean();

    const serviceTypes = await ServiceType.find({})
        .select('name _id category subcategory')
        .sort({ order: 1, name: 1 })
        .lean();

    const services = await Service.find({})
        .select('title _id serviceType subcategory category')
        .sort({ title: 1 })
        .lean();

    const servicesByType = services.reduce((acc, service) => {
        const typeId = service.serviceType?.toString();
        if (!typeId) {
            return acc;
        }

        if (!acc[typeId]) {
            acc[typeId] = [];
        }

        acc[typeId].push({
            serviceId: service._id.toString(),
            serviceName: service.title
        });

        return acc;
    }, {});

    const typesBySubcategory = serviceTypes.reduce((acc, type) => {
        const subcategoryId = type.subcategory?.toString();
        if (!subcategoryId) {
            return acc;
        }

        if (!acc[subcategoryId]) {
            acc[subcategoryId] = [];
        }

        acc[subcategoryId].push({
            typeId: type._id.toString(),
            typeName: type.name,
            services: servicesByType[type._id.toString()] || []
        });

        return acc;
    }, {});

    const subcategoriesByCategory = subcategories.reduce((acc, subcategory) => {
        const categoryId = subcategory.category?.toString();
        if (!categoryId) {
            return acc;
        }

        if (!acc[categoryId]) {
            acc[categoryId] = [];
        }

        acc[categoryId].push({
            subcategoryId: subcategory._id.toString(),
            subcategoryName: subcategory.name,
            serviceTypes: (typesBySubcategory[subcategory._id.toString()] || []).filter(
                type => type.services.length > 0
            )
        });

        return acc;
    }, {});

    return categories
        .map(category => ({
            categoryId: category._id.toString(),
            categoryName: category.name,
            subcategories: (subcategoriesByCategory[category._id.toString()] || []).filter(
                subcategory => subcategory.serviceTypes.length > 0
            )
        }))
        .filter(category => category.subcategories.length > 0);
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
                
                if (isAvailable) {
                    dailySlots.push({
                        time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
                        displayTime: formatDisplayTime(h, m),
                        isAvailable
                    });
                }
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
    getServiceManagementRows,
    getSubcategoriesByCategoryId,
    getServiceTypesBySubcategoryId,
    getServiceTypesBySubcategories,
    getServicesBySubcategoryId,
    getServicesByServiceTypeId,
    getServicesByTypes,
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
