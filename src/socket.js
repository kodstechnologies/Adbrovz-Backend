const { Server } = require('socket.io');

let io;
const activeVendors = new Map(); // vendorId -> [socketId1, socketId2, ...]

const initSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
            methods: ['GET', 'POST'],
            credentials: true
        }
    });

    io.on('connection', (socket) => {
        console.log(`🔌 New WebSocket Connection: ${socket.id}`);

        // Vendor identifies themselves (can be part of auth or an initial event)
        socket.on('register_vendor', (vendorId) => {
            if (vendorId) {
                const vId = vendorId.toString();
                if (!activeVendors.has(vId)) {
                    activeVendors.set(vId, []);
                }
                const sockets = activeVendors.get(vId);
                if (!sockets.includes(socket.id)) {
                    sockets.push(socket.id);
                }
                console.log(`✅ Vendor ${vId} registered on socket ${socket.id}. Total connections: ${sockets.length}`);
            }
        });

        // Vendor actions on bookings
        socket.on('accept_booking', async (data) => {
            try {
                const { vendorId, bookingId } = data;
                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.acceptLead(vendorId, bookingId);
                socket.emit('booking_accepted_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'accept_booking', message: error.message });
            }
        });

        socket.on('reject_booking', async (data) => {
            try {
                const { vendorId, bookingId } = data;
                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.rejectLead(vendorId, bookingId);
                socket.emit('booking_rejected_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'reject_booking', message: error.message });
            }
        });

        socket.on('later_booking', async (data) => {
            try {
                const { vendorId, bookingId } = data;
                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.markLeadLater(vendorId, bookingId);
                socket.emit('booking_later_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'later_booking', message: error.message });
            }
        });

        socket.on('disconnect', () => {
            console.log(`🔴 WebSocket Disconnected: ${socket.id}`);
            // Remove socket from active list
            for (const [vendorId, sockets] of activeVendors.entries()) {
                const index = sockets.indexOf(socket.id);
                if (index !== -1) {
                    sockets.splice(index, 1);
                    console.log(`❌ Socket ${socket.id} removed from Vendor ${vendorId}. Remaining: ${sockets.length}`);
                    if (sockets.length === 0) {
                        activeVendors.delete(vendorId);
                        console.log(`   Vendor ${vendorId} fully offline.`);
                    }
                    break;
                }
            }
        });
    });

    return io;
};

const getIo = () => {
    if (!io) {
        throw new Error('Socket.io not initialized');
    }
    return io;
};

/**
 * Emit an event to all socket connections of a given vendor.
 * Safe to call even if the vendor is not connected (no-op).
 */
const emitToVendor = (vendorId, event, data) => {
    if (!io) return;
    const sockets = activeVendors.get(vendorId.toString()) || [];
    sockets.forEach(socketId => {
        io.to(socketId).emit(event, data);
    });
    if (sockets.length > 0) {
        console.log(`📡 Emitted '${event}' to Vendor ${vendorId} on ${sockets.length} socket(s)`);
    }
};

// Helper to check if a specific vendor is online
const isVendorOnline = (vendorId) => {
    const sockets = activeVendors.get(vendorId.toString());
    return sockets && sockets.length > 0;
};

// Helper to get a vendor's socket IDs
const getVendorSockets = (vendorId) => {
    return activeVendors.get(vendorId.toString()) || [];
};

module.exports = {
    initSocket,
    getIo,
    isVendorOnline,
    getVendorSockets,
    emitToVendor,
    activeVendors
};
