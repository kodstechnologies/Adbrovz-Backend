const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const dashboardService = require('./dashboard.service');

// USER: Get dashboard data
const getDashboardData = asyncHandler(async (req, res) => {
    const data = await dashboardService.getDashboardData();
    res.status(200).json(
        new ApiResponse(200, data, 'Dashboard data retrieved successfully')
    );
});

// USER: Get vendor banners
const getVendorBanners = asyncHandler(async (req, res) => {
    const banners = await dashboardService.getVendorBanners();
    res.status(200).json(
        new ApiResponse(200, banners, 'Vendor banners retrieved successfully')
    );
});

// ADMIN: Service Sections
const getAllServiceSections = asyncHandler(async (req, res) => {
    try {
        const sections = await dashboardService.getAllServiceSections(req.query);
        res.status(200).json(new ApiResponse(200, sections, 'Service sections retrieved successfully'));
    } catch (error) {
        console.error('DEBUG: getAllServiceSections error:', error);
        throw error;
    }
});

const createServiceSection = asyncHandler(async (req, res) => {
    const section = await dashboardService.createServiceSection(req.body);
    res.status(201).json(new ApiResponse(201, section, 'Service section created successfully'));
});

const updateServiceSection = asyncHandler(async (req, res) => {
    const section = await dashboardService.updateServiceSection(req.params.id, req.body);
    res.status(200).json(new ApiResponse(200, section, 'Service section updated successfully'));
});

const deleteServiceSection = asyncHandler(async (req, res) => {
    await dashboardService.deleteServiceSection(req.params.id);
    res.status(200).json(new ApiResponse(200, null, 'Service section deleted successfully'));
});

// ADMIN: Banners
const getAllBanners = asyncHandler(async (req, res) => {
    const banners = await dashboardService.getAllBanners(req.query);
    res.status(200).json(new ApiResponse(200, banners, 'Banners retrieved successfully'));
});

const createBanner = asyncHandler(async (req, res) => {
    const data = { ...req.body };
    if (req.file && req.file.cloudinary) {
        data.image = req.file.cloudinary.url;
    } else if (req.file) {
        data.image = req.file.path.replace(/\\/g, '/');
    }
    const banner = await dashboardService.createBanner(data);
    res.status(201).json(new ApiResponse(201, banner, 'Banner created successfully'));
});

const updateBanner = asyncHandler(async (req, res) => {
    const data = { ...req.body };
    if (req.file && req.file.cloudinary) {
        data.image = req.file.cloudinary.url;
    } else if (req.file) {
        data.image = req.file.path.replace(/\\/g, '/');
    }
    const banner = await dashboardService.updateBanner(req.params.id, data);
    res.status(200).json(new ApiResponse(200, banner, 'Banner updated successfully'));
});

const deleteBanner = asyncHandler(async (req, res) => {
    await dashboardService.deleteBanner(req.params.id);
    res.status(200).json(new ApiResponse(200, null, 'Banner deleted successfully'));
});

// USER: Get top 4 best services based on ratings
const getBestServices = asyncHandler(async (req, res) => {
    const services = await dashboardService.getBestServices();
    res.status(200).json(
        new ApiResponse(200, services, 'Best services retrieved successfully')
    );
});

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
