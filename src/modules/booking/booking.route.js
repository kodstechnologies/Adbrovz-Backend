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
router.post('/reject/:id', authenticate, bookingController.rejectLead);
router.post('/later/:id', authenticate, bookingController.markLeadLater);
router.get('/vendor/history', authenticate, bookingController.getVendorHistory);
router.get('/vendor/later', authenticate, bookingController.getVendorLaterBookings);

/**
 * VENDOR – EXECUTION FLOW
 */
router.post('/vendor/:id/on-the-way', authenticate, bookingController.markOnTheWay);
router.post('/vendor/:id/arrived', authenticate, bookingController.markArrived);
router.post('/vendor/:id/start-work', authenticate, bookingController.startWork);
router.post('/vendor/:id/request-completion-otp', authenticate, bookingController.requestCompletionOTP);
router.post('/vendor/:id/complete-work', authenticate, bookingController.completeWork);
router.get('/vendor/:id', authenticate, bookingController.getVendorBookingById);
/**
 * USER – BOOKING FLOW
 */
router.post('/', bookingController.createBooking); // Temporarily bypassed check
router.get('/my-bookings', authenticate, bookingController.getMyBookings);
router.get('/completed-history', authenticate, bookingController.getCompletedHistory);
router.post('/:id/cancel', authenticate, bookingController.cancelBooking);
router.post('/:id/reschedule', authenticate, bookingController.rescheduleBooking);
router.post('/:id/retry-search', authenticate, bookingController.retrySearch);
router.get('/:id', authenticate, bookingController.getBookingById);

module.exports = router;
