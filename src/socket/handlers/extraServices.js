const { stringifyId } = require('../utils/stringifyId');

const parseServiceIds = (data, ...keys) => {
    for (const key of keys) {
        if (data?.[key]) {
            const val = data[key];
            return (Array.isArray(val) ? val : [val])
                .map(id => (id && typeof id === 'object' ? (id.serviceId || id._id || id.id || '').toString() : id?.toString()))
                .filter(Boolean);
        }
    }
    return [];
};

const registerExtraServicesHandlers = (io, socket) => {
    socket.on('add_booking_services', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId);
            const { newServices } = data || {};
            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.addServicesToBooking(vendorId, bookingId, newServices);
            socket.emit('booking_services_proposal_sent', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'add_booking_services', message: error.message });
        }
    });

    socket.on('confirm_proposed_services', async (data) => {
        try {
            const userId = stringifyId(data?.userId || socket.userId);
            const bookingId = stringifyId(data?.bookingId);
            if (!userId) throw new Error('User ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.confirmProposedServices(userId, bookingId);
            socket.emit('booking_services_confirmed_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'confirm_proposed_services', message: error.message });
        }
    });

    socket.on('reject_proposed_services', async (data) => {
        try {
            const userId = stringifyId(data?.userId || socket.userId);
            const bookingId = stringifyId(data?.bookingId);
            const { reason } = data || {};
            if (!userId) throw new Error('User ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.rejectProposedServices(userId, bookingId, reason);
            socket.emit('booking_services_rejected_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'reject_proposed_services', message: error.message });
        }
    });

    socket.on('request_extra_services', async (data) => {
        try {
            const userId = stringifyId(data?.userId || socket.userId);
            const bookingId = stringifyId(data?.bookingId);
            const { services } = data || {};
            if (!userId) throw new Error('User ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.requestExtraServices(userId, bookingId, services);
            socket.emit('extra_services_request_sent', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'request_extra_services', message: error.message });
        }
    });

    socket.on('vendor_confirm_extra_services', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId);
            const { services } = data || {};
            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.vendorConfirmExtraServices(vendorId, bookingId, services);
            socket.emit('vendor_confirm_extra_services_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'vendor_confirm_extra_services', message: error.message });
        }
    });

    socket.on('vendor_accept_extra_services', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId);
            const acceptedServiceIds = parseServiceIds(data, 'acceptedServiceIds', 'serviceIds', 'serviceId');
            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.vendorAcceptExtraServices(vendorId, bookingId, acceptedServiceIds);
            socket.emit('vendor_accept_extra_services_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'vendor_accept_extra_services', message: error.message });
        }
    });

    socket.on('vendor_reject_extra_services', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            const bookingId = stringifyId(data?.bookingId);
            const { reason } = data || {};
            const rejectedServiceIds = parseServiceIds(data, 'rejectedServiceIds', 'serviceIds', 'serviceId');
            if (!vendorId) throw new Error('Vendor ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.vendorRejectExtraServices(vendorId, bookingId, rejectedServiceIds, reason);
            socket.emit('vendor_reject_extra_services_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'vendor_reject_extra_services', message: error.message });
        }
    });

    socket.on('user_confirm_extra_services', async (data) => {
        try {
            const userId = stringifyId(data?.userId || socket.userId);
            const bookingId = stringifyId(data?.bookingId);
            const { acceptedServiceIds } = data || {};
            if (!userId) throw new Error('User ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.userConfirmExtraServices(userId, bookingId, acceptedServiceIds);
            socket.emit('user_confirm_extra_services_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'user_confirm_extra_services', message: error.message });
        }
    });

    socket.on('user_reject_extra_services', async (data) => {
        try {
            const userId = stringifyId(data?.userId || socket.userId);
            const bookingId = stringifyId(data?.bookingId);
            const { reason } = data || {};
            const rejectedServiceIds = parseServiceIds(data, 'rejectedServiceIds', 'serviceIds', 'serviceId');
            if (!userId) throw new Error('User ID is required');
            if (!bookingId) throw new Error('Booking ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const result = await bookingService.userRejectExtraServices(userId, bookingId, rejectedServiceIds, reason);
            socket.emit('user_reject_extra_services_success', result);
        } catch (error) {
            socket.emit('booking_error', { action: 'user_reject_extra_services', message: error.message });
        }
    });
};

module.exports = { registerExtraServicesHandlers };
