const express = require('express');
const router = express.Router();
const bookingController = require('./booking.controller');

// User routes
router.post('/request', bookingController.requestLead);

// Vendor routes
router.post('/accept/:bookingId', bookingController.acceptLead);

module.exports = router;
