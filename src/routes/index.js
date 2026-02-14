const express = require('express');
const router = express.Router();

// Import route modules
const authRoutes = require('../modules/auth/auth.route');
const userRoutes = require('../modules/user/user.route');
const adminRoutes = require('../modules/admin/admin.route');
const serviceRoutes = require('../modules/service/service.route');
const dashboardRoutes = require('../modules/Userappdashboard/dashboard.route');
const vendorRoutes = require('../modules/vendor/vendor.route');
const mediaRoutes = require('../modules/media/media.route');
const bookingRoutes = require('../modules/booking/booking.route');
const disputeRoutes = require('../modules/dispute/dispute.route');

// Health check
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
  });
});

// Welcome message
router.get('/', (req, res) => {
  res.status(200).json({
    message: 'Welcome to Adbrovz API',
    version: 'v1.0.0',
    documentation: 'https://api.adbrovz.com/docs',
  });
});

// Mount routes
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/admin', adminRoutes);
router.use('/services', serviceRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/vendors', vendorRoutes);
router.use('/media', mediaRoutes);
router.use('/bookings', bookingRoutes);
router.use('/disputes', disputeRoutes);

module.exports = router;

