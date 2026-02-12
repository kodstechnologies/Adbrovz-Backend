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

// Category Management
router.post('/admin/categories', upload.single('icon'), uploadToCloudinary('categories'), serviceController.createCategory);
router.put('/admin/categories/:categoryId', upload.single('icon'), uploadToCloudinary('categories'), serviceController.updateCategory);
router.delete('/admin/categories/:categoryId', serviceController.deleteCategory);

// Subcategory Management
router.post('/admin/subcategories', upload.single('icon'), uploadToCloudinary('subcategories'), serviceController.createSubcategory);
router.put('/admin/subcategories/:subcategoryId', upload.single('icon'), uploadToCloudinary('subcategories'), serviceController.updateSubcategory);
router.delete('/admin/subcategories/:subcategoryId', serviceController.deleteSubcategory);

// Service Management
router.post('/admin/services', upload.single('photo'), uploadToCloudinary('services'), serviceController.createService);
router.put('/admin/services/:serviceId', upload.single('photo'), uploadToCloudinary('services'), serviceController.updateService);
router.delete('/admin/services/:serviceId', serviceController.deleteService);

// ================= PUBLIC ROUTES =================
router.get('/categories', serviceController.getCategories);
router.get('/categories/:categoryId/subcategories', serviceController.getSubcategories);
router.get('/subcategories/:subcategoryId/services', serviceController.getServices);
router.get('/:serviceId', serviceController.getServiceDetails);

module.exports = router;
