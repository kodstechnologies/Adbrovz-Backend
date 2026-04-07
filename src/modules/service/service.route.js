const express = require('express');
const router = express.Router();
const serviceController = require('./service.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');
const { upload, uploadToCloudinary } = require('../../middlewares/cloudinary.middleware');

// ================= ADMIN ROUTES (must come before catch-all routes) =================
router.use('/admin', authenticate);
router.use('/admin', authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN));

// Get all categories with subcategories (Admin)
router.get('/admin/categories', serviceController.getCategoriesWithSubcategories);

router.get('/admin/category-schema', (req, res) => {
    const Category = require('../../models/Category.model');
    res.json(Category.schema.obj);
});

router.get('/admin/subcategory-schema', (req, res) => {
    const Subcategory = require('../../models/Subcategory.model');
    res.json(Subcategory.schema.obj);
});

router.get('/admin/service-type-schema', (req, res) => {
    const ServiceType = require('../../models/ServiceType.model');
    res.json(ServiceType.schema.obj);
});

router.get('/admin/service-schema', (req, res) => {
    const Service = require('../../models/Service.model');
    res.json(Service.schema.obj);
});

// Category Management
router.post('/admin/categories', upload.single('icon'), uploadToCloudinary('categories'), serviceController.createCategory);
router.put('/admin/categories/:categoryId', upload.single('icon'), uploadToCloudinary('categories'), serviceController.updateCategory);
router.delete('/admin/categories/:categoryId', serviceController.deleteCategory);

// Subcategory Management
router.post('/admin/subcategories', upload.single('icon'), uploadToCloudinary('subcategories'), serviceController.createSubcategory);
router.put('/admin/subcategories/:subcategoryId', upload.single('icon'), uploadToCloudinary('subcategories'), serviceController.updateSubcategory);
router.delete('/admin/subcategories/:subcategoryId', serviceController.deleteSubcategory);

// Service Type Management
router.get('/admin/service-types', serviceController.getAdminServiceTypes);
router.post('/admin/service-types', serviceController.createServiceType);
router.put('/admin/service-types/:serviceTypeId', serviceController.updateServiceType);
router.delete('/admin/service-types/:serviceTypeId', serviceController.deleteServiceType);

// Service Management
router.get('/admin/services', serviceController.getAdminServices);
router.post('/admin/services', upload.single('photo'), uploadToCloudinary('services'), serviceController.createService);
router.put('/admin/services/:serviceId', upload.single('photo'), uploadToCloudinary('services'), serviceController.updateService);
router.delete('/admin/services/:serviceId', serviceController.deleteService);

// ================= PUBLIC ROUTES =================
router.get('/all', serviceController.getAllServices);
router.get('/catalogue', serviceController.getServiceCatalogue);
router.get('/search', serviceController.globalSearch);
router.get('/categories', serviceController.getCategories);
router.get('/categories/:categoryId/slots', serviceController.getCategorySlots);
router.get('/subcategories', serviceController.getSubcategoriesWithServices);
router.get('/categories/:categoryId/subcategories', serviceController.getSubcategories);
router.get('/subcategories/:subcategoryId/service-types', serviceController.getServiceTypes);
router.get('/subcategories/:subcategoryId/services', serviceController.getServices);
router.get('/service-types/:serviceTypeId/services', serviceController.getServicesByType);
router.get('/:serviceId', serviceController.getServiceDetails);

module.exports = router;
