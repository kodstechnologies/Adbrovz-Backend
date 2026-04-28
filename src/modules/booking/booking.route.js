const express = require('express');
const router = express.Router();
const bookingController = require('./booking.controller');
const { authenticate } = require('../../middlewares/auth.middleware');

/**
 * USER – LEAD  
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
router.post('/vendor/:id/update-price', authenticate, bookingController.updatePrice);
router.get('/vendor/:id', authenticate, bookingController.getVendorBookingById);
/**
 * USER – BOOKING FLOW
 */
router.post('/', bookingController.createBooking); // Temporarily bypassed check
router.get('/my-bookings', authenticate, bookingController.getMyBookings);
router.get('/completed-history', authenticate, bookingController.getCompletedHistory);
router.post('/:id/confirm-price', authenticate, bookingController.confirmPrice);
router.post('/:id/reject-price', authenticate, bookingController.rejectPrice);
router.post('/:id/cancel', authenticate, bookingController.cancelBooking);
router.post('/:id/reschedule', authenticate, bookingController.rescheduleBooking);
router.post('/:id/retry-search', authenticate, bookingController.retrySearch);
router.get('/:id/status-history', authenticate, bookingController.getBookingStatusHistory);

// New feature routes
router.post('/:id/vendor-no-show', authenticate, bookingController.reportVendorNoShow);
router.post('/:id/grace-period-cancel', authenticate, bookingController.gracePeriodCancel);
router.post('/:id/confirm-services', authenticate, bookingController.confirmProposedServices);
router.post('/:id/reject-services', authenticate, bookingController.rejectProposedServices);
router.post('/vendor/:id/add-services', authenticate, bookingController.addServices);

// User-initiated Extra Services (New)
router.post('/:id/request-extra-services', authenticate, bookingController.requestExtraServices);
router.post('/vendor/:id/confirm-extra-services', authenticate, bookingController.vendorConfirmExtraServices);
router.post('/vendor/:id/reject-extra-services', authenticate, bookingController.vendorRejectExtraServices);
router.post('/:id/user-confirm-extra-services', authenticate, bookingController.userConfirmExtraServices);
router.post('/:id/user-reject-extra-services', authenticate, bookingController.userRejectExtraServices);

// Cancelled bookings list (Common for User/Vendor/Admin based on role)
router.get('/history/cancelled', authenticate, bookingController.getCancelledBookings);

// Vendor can also cancel
router.post('/vendor/:id/cancel', authenticate, bookingController.vendorCancelBooking);

router.get('/:id', authenticate, bookingController.getBookingById);

// API trigger: manually re-broadcast an order to vendors via socket
router.post('/broadcast/:bookingId', bookingController.triggerBroadcast);

// TEMPORARY: Debug route to trigger notification
router.post('/debug/trigger-notification', async (req, res) => {
    try {
        const { bookingId, vendorId } = req.body;
        const Booking = require('../../models/Booking.model');
        const Vendor = require('../../models/Vendor.model');
        const { getVendorSockets, getIo } = require('../../socket');
        const bookingService = require('./booking.service');

        const booking = await Booking.findById(bookingId).populate('services.service').populate('user');
        if (!booking) return res.status(404).json({ message: 'Booking not found' });

        const vendor = await Vendor.findById(vendorId);
        if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

        const io = getIo();
        const socketIds = getVendorSockets(vendorId);
        
        let totalDurationMins = 0;
        if (booking.services && booking.services.length > 0) {
            booking.services.forEach(item => {
                totalDurationMins += (item.service?.approxCompletionTime || 0) * (item.quantity || 1);
            });
        }

        const payload = {
            ...(booking.toObject()),
            bookingID: booking.bookingID,
            totalDurationMins,
            radius: 5 // Default
        };

        if (payload.user && payload.location) {
            payload.user.latitude = payload.location.latitude;
            payload.user.longitude = payload.location.longitude;
        }

        if (socketIds && socketIds.length > 0) {
            socketIds.forEach(socketId => {
                io.to(socketId).emit('new_booking_request', payload);
            });
            return res.status(200).json({ message: `Notification sent to ${socketIds.length} sockets` });
        } else {
            return res.status(200).json({ message: 'Vendor is offline, no notification sent' });
        }
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
