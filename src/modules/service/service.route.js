const express = require('express');
const router = express.Router();
const serviceController = require('./service.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');

// ================= PUBLIC ROUTES =================
router.get('/categories', serviceController.getCategories);
router.get('/categories/:categoryId/subcategories', serviceController.getSubcategories);
router.get('/subcategories/:subcategoryId/services', serviceController.getServices);
router.get('/:serviceId', serviceController.getServiceDetails);

// ================= ADMIN ROUTES =================
router.use(authenticate);
router.use(authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN));

// Category Management
router.post('/categories', serviceController.createCategory);
router.put('/categories/:categoryId', serviceController.updateCategory);
router.delete('/categories/:categoryId', serviceController.deleteCategory);

// Subcategory Management
router.post('/subcategories', serviceController.createSubcategory);
router.put('/subcategories/:subcategoryId', serviceController.updateSubcategory);
router.delete('/subcategories/:subcategoryId', serviceController.deleteSubcategory);

// Service Management
router.post('/services', serviceController.createService);
router.put('/services/:serviceId', serviceController.updateService);
router.delete('/services/:serviceId', serviceController.deleteService);

module.exports = router;
