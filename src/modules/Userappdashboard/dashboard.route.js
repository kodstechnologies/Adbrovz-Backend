const express = require('express');
const router = express.Router();
const dashboardController = require('./dashboard.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');
const { upload, uploadToCloudinary } = require('../../middlewares/cloudinary.middleware');

// ================= PUBLIC ROUTES =================
router.get('/', dashboardController.getDashboardData);
router.get('/service-sections', dashboardController.getAllServiceSections);
router.get('/banners', dashboardController.getAllBanners);
router.get('/vendor-banners', dashboardController.getVendorBanners);
router.get('/best-services', dashboardController.getBestServices);

// ================= ADMIN ROUTES =================
router.use(authenticate);
router.use(authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN));

// Service Sections Management
router.post('/service-sections', dashboardController.createServiceSection);
router.put('/service-sections/:id', dashboardController.updateServiceSection);
router.delete('/service-sections/:id', dashboardController.deleteServiceSection);

// Banners Management
// router.get('/banners', dashboardController.getAllBanners); // Moved to public
router.post('/banners', upload.single('image'), uploadToCloudinary('banners'), dashboardController.createBanner);
router.put('/banners/:id', upload.single('image'), uploadToCloudinary('banners'), dashboardController.updateBanner);
router.delete('/banners/:id', dashboardController.deleteBanner);

module.exports = router;
