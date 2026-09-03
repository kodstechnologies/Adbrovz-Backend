const { stringifyId } = require('../utils/stringifyId');
const { activeVendors } = require('../maps/vendor');

const registerBookingHandlers = (io, socket) => {
    // Simulator: trigger a mock booking to active vendors
    socket.on('trigger_mock_booking', (data) => {
        try {
            const bookingId = stringifyId(data?.bookingId) || ('BK-' + Math.floor(1000 + Math.random() * 9000));
            const userId = stringifyId(data?.userId || socket.userId || '6a0a9ac23acfd6f22281d799');
            const vendorId = stringifyId(data?.vendorId);

            const payload = {
                _id: bookingId,
                bookingID: bookingId,
                status: 'pending_acceptance',
                user: { _id: userId, name: 'Mock Customer', phoneNumber: '9876543210', photo: null },
                category: { _id: '6a0a9c3267ba064f7fde1111', title: data?.category || 'AC Repair & Service', name: data?.category || 'AC Repair & Service' },
                services: [{ service: { _id: '6a0a9c3267ba064f7fde2222', title: data?.serviceTitle || 'AC Cleaning & Deep Wash', serviceCharge: 499, approxCompletionTime: 45 }, quantity: 1, finalPrice: 499 }],
                pricing: { basePrice: 499, travelCharge: 50, totalPrice: 549 },
                location: { address: '123 Premium Glassmorphism Blvd, Indiranagar', latitude: 12.9715987, longitude: 77.5945627 },
                totalDurationMins: 45,
                radius: 5,
                createdAt: new Date()
            };

            if (vendorId) {
                (activeVendors.get(vendorId) || []).forEach(sId => io.to(sId).emit('new_booking_request', payload));
            } else {
                Array.from(activeVendors.keys()).forEach(vId => {
                    (activeVendors.get(vId) || []).forEach(sId => io.to(sId).emit('new_booking_request', payload));
                });
            }

            socket.emit('booking_created_success', { booking: payload, message: 'Mock booking triggered successfully! Broadcasted to active vendors.' });
        } catch (error) {
            console.error(`[SOCKET] trigger_mock_booking error:`, error);
            socket.emit('booking_error', { action: 'trigger_mock_booking', message: error.message });
        }
    });

    socket.on('accept_booking', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId || (typeof data === 'string' ? data : null));

            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');

            if (!/^[0-9a-fA-F]{24}$/.test(bookingId)) {
                socket.emit('booking_accepted_success', { success: true, bookingId, status: 'accepted', message: 'Mock booking accepted successfully!' });
                io.emit('booking_status_updated', { bookingId, status: 'accepted', vendorId });
                return;
            }

            const bookingService = require('../../modules/booking/booking.service');
            await bookingService.acceptBooking(vendorId, bookingId);
        } catch (error) {
            socket.emit('booking_error', { action: 'accept_booking', message: error.message });
        }
    });

    socket.on('reject_booking', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId || (typeof data === 'string' ? data : null));

            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');

            if (!/^[0-9a-fA-F]{24}$/.test(bookingId)) {
                socket.emit('booking_rejected_success', { success: true, bookingId, status: 'rejected', message: 'Mock booking rejected successfully!' });
                io.emit('booking_status_updated', { bookingId, status: 'rejected', vendorId });
                return;
            }

            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.rejectBooking(vendorId, bookingId);
            socket.emit('booking_rejected_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'reject_booking', message: error.message });
        }
    });

    socket.on('later_booking', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId || (typeof data === 'string' ? data : null));
            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.markBookingLater(vendorId, bookingId);
            socket.emit('booking_later_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'later_booking', message: error.message });
        }
    });

    socket.on('mark_on_the_way', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId || (typeof data === 'string' ? data : null));
            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.markOnTheWay(vendorId, bookingId);
            socket.emit('booking_on_the_way_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'mark_on_the_way', message: error.message });
        }
    });

    socket.on('mark_arrived', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId || (typeof data === 'string' ? data : null));
            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.markArrived(vendorId, bookingId);
            socket.emit('booking_arrived_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'mark_arrived', message: error.message });
        }
    });

    socket.on('start_work', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId);
            const { otp } = data || {};
            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.startWork(vendorId, bookingId, otp);
            socket.emit('booking_start_work_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'start_work', message: error.message });
        }
    });

    socket.on('request_completion_otp', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId);
            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.requestCompletionOTP(vendorId, bookingId);
            socket.emit('booking_request_completion_otp_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'request_completion_otp', message: error.message });
        }
    });

    socket.on('complete_work', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId);
            const { otp, paymentMethod } = data || {};
            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.completeWork(vendorId, bookingId, otp, paymentMethod);
            socket.emit('booking_complete_work_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'complete_work', message: error.message });
        }
    });

    socket.on('update_booking_price', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId);
            const { updatedServices } = data || {};
            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.updateBookingPrice(vendorId, bookingId, updatedServices);
            socket.emit('booking_price_proposed', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'update_booking_price', message: error.message });
        }
    });

    socket.on('confirm_booking_price', async (data) => {
        try {
            const userId = stringifyId(data?.userId || socket.userId);
            const bookingId = stringifyId(data?.bookingId);
            const { serviceIds } = data || {};
            if (!userId) throw new Error('User ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.confirmBookingPrice(userId, bookingId, serviceIds);
            socket.emit('booking_update_price_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'confirm_booking_price', message: error.message });
        }
    });

    socket.on('reject_booking_price', async (data) => {
        try {
            const userId = stringifyId(data?.userId || socket.userId);
            const bookingId = stringifyId(data?.bookingId);
            const { reason, serviceIds } = data || {};
            if (!userId) throw new Error('User ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.rejectBookingPrice(userId, bookingId, reason, serviceIds);
            socket.emit('booking_reject_price_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'reject_booking_price', message: error.message });
        }
    });

    socket.on('report_vendor_no_show', async (data) => {
        try {
            const userId = stringifyId(data?.userId || socket.userId);
            const bookingId = stringifyId(data?.bookingId);
            if (!userId) throw new Error('User ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.reportVendorNoShow(userId, bookingId);
            socket.emit('booking_vendor_no_show_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'report_vendor_no_show', message: error.message });
        }
    });

    socket.on('grace_period_cancel', async (data) => {
        try {
            const userId = stringifyId(data?.userId || socket.userId);
            const bookingId = stringifyId(data?.bookingId);
            if (!userId) throw new Error('User ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.gracePeriodCancel(userId, bookingId);
            socket.emit('booking_grace_period_cancel_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'grace_period_cancel', message: error.message });
        }
    });

    socket.on('get_booking_status', async (data) => {
        try {
            const bookingId = stringifyId(data?.bookingId);
            const role = data?.role || (socket.userId ? 'user' : 'vendor');
            const userId = stringifyId(socket.userId || socket.vendorId);
            if (!bookingId) throw new Error('Booking ID is required');
            if (!userId) throw new Error('You must be logged in to check booking status');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.getBookingDetails(bookingId, userId, role);
            socket.emit('booking_status_response', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'get_booking_status', message: error.message });
        }
    });

    socket.on('booking_received_ack', (data) => {
        console.log('✅ Vendor ACK RECEIVED:', data);
    });
};

module.exports = { registerBookingHandlers };
