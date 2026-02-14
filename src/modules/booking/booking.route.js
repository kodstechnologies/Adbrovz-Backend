const express = require('express');
const router = express.Router();
const bookingController = require('./booking.controller');
const { authenticate } = require('../../middlewares/auth.middleware');

/**
 * USER – LEAD FLOW
 */
router.post('/request', authenticate, bookingController.requestLead);

/**
 * VENDOR – LEAD FLOW
 */
router.post('/accept/:bookingId', authenticate, bookingController.acceptLead);

/**
 * USER – BOOKING FLOW
 */
router.post('/', authenticate, bookingController.createBooking);
router.get('/my-bookings', authenticate, bookingController.getMyBookings);
router.post('/:id/cancel', authenticate, bookingController.cancelBooking);
router.post('/:id/reschedule', authenticate, bookingController.rescheduleBooking);
router.post('/:id/retry-search', authenticate, bookingController.retrySearch);

module.exports = router;
