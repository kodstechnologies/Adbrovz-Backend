const express = require('express');
const router = express.Router();
const serviceController = require('./service.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');
const upload = require('../../middlewares/upload.middleware');

// ================= PUBLIC ROUTES =================
router.get('/categories', serviceController.getCategories);
router.get('/categories/:categoryId/subcategories', serviceController.getSubcategories);
router.get('/subcategories/:subcategoryId/services', serviceController.getServices);
router.get('/:serviceId', serviceController.getServiceDetails);

// ================= ADMIN ROUTES =================
router.use(authenticate);
router.use(authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN));

// Category Management
router.post('/categories', upload.single('icon'), serviceController.createCategory);
router.put('/categories/:categoryId', upload.single('icon'), serviceController.updateCategory);
router.delete('/categories/:categoryId', serviceController.deleteCategory);

// Subcategory Management
router.post('/subcategories', upload.single('icon'), serviceController.createSubcategory);
router.put('/subcategories/:subcategoryId', upload.single('icon'), serviceController.updateSubcategory);
router.delete('/subcategories/:subcategoryId', serviceController.deleteSubcategory);

// Service Management
router.post('/services', upload.single('photo'), serviceController.createService);
router.put('/services/:serviceId', upload.single('photo'), serviceController.updateService);
router.delete('/services/:serviceId', serviceController.deleteService);

module.exports = router;
