const { stringifyId } = require('../utils/stringifyId');
const { activeVendors } = require('../maps/vendor');

const registerLocationHandlers = (io, socket) => {
    socket.on('update_location', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            let { lat, lng, accuracy } = data || {};

            if (!vendorId) throw new Error('Vendor ID is required');
            if (lat === undefined || lng === undefined) throw new Error('Latitude and Longitude are required');

            // Auto-correct swapped coordinates (India: lng > lat always)
            if (lng < lat) [lng, lat] = [lat, lng];

            if (accuracy !== undefined && accuracy > 50) {
                console.log(`[SOCKET] Location update skipped for vendor ${vendorId} — poor accuracy: ${accuracy}m`);
                socket.emit('location_updated_success', { lat, lng, ignored: true, reason: 'low_accuracy', timestamp: new Date() });
                return;
            }

            const Vendor = require('../../models/Vendor.model');
            const vendor = await Vendor.findByIdAndUpdate(vendorId, {
                'liveLocation.type': 'Point',
                'liveLocation.coordinates': [lng, lat],
                'liveLocation.updatedAt': new Date()
            });

            if (!vendor) throw new Error('Vendor not found');

            const bookingService = require('../../modules/booking/booking.service');
            if (bookingService.broadcastVendorLocation) {
                await bookingService.broadcastVendorLocation(vendorId, lat, lng);
            }

            socket.emit('location_updated_success', { lat, lng, timestamp: new Date() });
        } catch (error) {
            console.error(`[SOCKET] update_location error: ${error.message}`);
            if (error.message === 'Vendor not found') {
                socket.emit('location_error', { action: 'update_location', message: error.message });
            }
        }
    });

    socket.on('check_vendor_tracking_status', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId || socket.vendorId);
            if (!vendorId) throw new Error('Vendor ID is required');
            const bookingService = require('../../modules/booking/booking.service');
            const isTrackingActive = await bookingService.shouldTrackVendor(vendorId);
            socket.emit('vendor_tracking_status', { vendorId, isTrackingActive, timestamp: new Date() });
        } catch (error) {
            socket.emit('socket_error', { action: 'check_vendor_tracking_status', message: error.message });
        }
    });

    socket.on('get_vendor_location', async (data) => {
        try {
            const vendorId = stringifyId(data?.vendorId);
            if (!vendorId) throw new Error('Vendor ID is required');

            const Vendor = require('../../models/Vendor.model');
            const vendor = await Vendor.findById(vendorId).select('liveLocation isOnline name');
            if (!vendor) throw new Error('Vendor not found');

            const isOnline = activeVendors.has(vendorId.toString());
            const coords = vendor.liveLocation?.coordinates || [0, 0];
            const exists = coords[0] !== 0 || coords[1] !== 0;

            socket.emit('vendor_location_data', {
                vendorId: vendor._id,
                name: vendor.name,
                location: { lng: coords[0], lat: coords[1] },
                isOnline,
                exists,
                updatedAt: vendor.liveLocation?.updatedAt || null,
                timestamp: new Date()
            });
        } catch (error) {
            socket.emit('socket_error', { action: 'get_vendor_location', message: error.message });
        }
    });
};

module.exports = { registerLocationHandlers };
