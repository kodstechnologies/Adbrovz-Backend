const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('./config/env');

let io;
const activeVendors = new Map(); // vendorId -> [socketId1, socketId2, ...]
const activeUsers = new Map(); // userId -> [socketId1, socketId2, ...]

const registerVendorSocket = (vendorId, socketId) => {
    const vId = vendorId.toString();
    if (!activeVendors.has(vId)) activeVendors.set(vId, []);
    const sockets = activeVendors.get(vId);
    if (!sockets.includes(socketId)) sockets.push(socketId);
    console.log(`✅ Vendor ${vId} auto-registered on socket ${socketId}. Total: ${sockets.length}`);
};

const registerUserSocket = (userId, socketId) => {
    const uId = userId.toString();
    if (!activeUsers.has(uId)) activeUsers.set(uId, []);
    const sockets = activeUsers.get(uId);
    if (!sockets.includes(socketId)) sockets.push(socketId);
    console.log(`✅ User ${uId} auto-registered on socket ${socketId}. Total: ${sockets.length}`);
};

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

        // ─── AUTO-REGISTRATION FROM JWT ────────────────────────────────────
        // App passes token via socket.handshake.auth.token or query.token
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        if (token) {
            try {
                const decoded = jwt.verify(token, config.JWT_SECRET);
                const role = decoded.role;
                const id = decoded.userId || decoded.id || decoded._id;
                if (id) {
                    if (role === 'vendor') {
                        registerVendorSocket(id, socket.id);
                        socket.vendorId = id.toString();
                    } else if (role === 'user') {
                        registerUserSocket(id, socket.id);
                        socket.userId = id.toString();
                    }
                }
            } catch (err) {
                console.log(`⚠️  Socket JWT auto-auth failed for ${socket.id}: ${err.message}`);
            }
        }
        // ──────────────────────────────────────────────────────────────────

        // Manual register_vendor (fallback for Postman / non-JWT connections)
        socket.on('register_vendor', (vendorId) => {
            if (vendorId) {
                registerVendorSocket(vendorId, socket.id);
                socket.vendorId = vendorId.toString();
            }
        });

        // Manual register_user (fallback)
        socket.on('register_user', (userId) => {
            if (userId) {
                registerUserSocket(userId, socket.id);
                socket.userId = userId.toString();
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

        socket.on('mark_on_the_way', async (data) => {
            try {
                const { vendorId, bookingId } = data;
                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.markOnTheWay(vendorId, bookingId);
                socket.emit('booking_on_the_way_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'mark_on_the_way', message: error.message });
            }
        });

        socket.on('mark_arrived', async (data) => {
            try {
                const { vendorId, bookingId } = data;
                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.markArrived(vendorId, bookingId);
                socket.emit('booking_arrived_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'mark_arrived', message: error.message });
            }
        });

        socket.on('start_work', async (data) => {
            try {
                const { vendorId, bookingId, otp } = data;
                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.startWork(vendorId, bookingId, otp);
                socket.emit('booking_start_work_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'start_work', message: error.message });
            }
        });

        socket.on('request_completion_otp', async (data) => {
            try {
                const { vendorId, bookingId } = data;
                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.requestCompletionOTP(vendorId, bookingId);
                socket.emit('booking_request_completion_otp_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'request_completion_otp', message: error.message });
            }
        });

        socket.on('complete_work', async (data) => {
            try {
                const { vendorId, bookingId, otp, paymentMethod } = data;
                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.completeWork(vendorId, bookingId, otp, paymentMethod);
                socket.emit('booking_complete_work_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'complete_work', message: error.message });
            }
        });

        // Admin/Verification socket actions
        socket.on('verify_vendor_document', async (data) => {
            try {
                const { vendorId, docType, status, reason } = data;
                const vendorService = require('./modules/vendor/vendor.service');
                const result = await vendorService.verifyDocument(vendorId, { docType, status, reason });
                socket.emit('verify_vendor_document_success', result);
            } catch (error) {
                socket.emit('verification_error', { action: 'verify_vendor_document', message: error.message });
            }
        });

        socket.on('get_verification_status', async (data) => {
            try {
                const { vendorId } = data;
                const vendorService = require('./modules/vendor/vendor.service');
                const result = await vendorService.getVerificationStatus(vendorId);
                socket.emit('verification_status_response', result);
                console.log(`📡 Sent verification status to Vendor ${vendorId} via Socket ${socket.id}`);
            } catch (error) {
                socket.emit('verification_error', { action: 'get_verification_status', message: error.message });
            }
        });

        socket.on('verify_all_vendor_documents', async (data) => {
            try {
                const { vendorId } = data;
                const vendorService = require('./modules/vendor/vendor.service');
                const result = await vendorService.verifyAllDocuments(vendorId);
                socket.emit('verify_all_vendor_documents_success', result);
            } catch (error) {
                socket.emit('verification_error', { action: 'verify_all_vendor_documents', message: error.message });
            }
        });

        socket.on('disconnect', () => {
            console.log(`WebSocket Disconnected: ${socket.id}`);
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

            for (const [userId, sockets] of activeUsers.entries()) {
                const index = sockets.indexOf(socket.id);
                if (index !== -1) {
                    sockets.splice(index, 1);
                    console.log(`❌ Socket ${socket.id} removed from User ${userId}. Remaining: ${sockets.length}`);
                    if (sockets.length === 0) {
                        activeUsers.delete(userId);
                        console.log(`   User ${userId} fully offline.`);
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

/**
 * Emit an event to all socket connections of a given user.
 * Safe to call even if the user is not connected (no-op).
 */
const emitToUser = (userId, event, data) => {
    if (!io) return;
    const sockets = activeUsers.get(userId.toString()) || [];
    sockets.forEach(socketId => {
        io.to(socketId).emit(event, data);
    });
    if (sockets.length > 0) {
        console.log(`📡 Emitted '${event}' to User ${userId} on ${sockets.length} socket(s)`);
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

// Helper to check if a specific user is online
const isUserOnline = (userId) => {
    const sockets = activeUsers.get(userId.toString());
    return sockets && sockets.length > 0;
};

// Helper to get a user's socket IDs
const getUserSockets = (userId) => {
    return activeUsers.get(userId.toString()) || [];
};

module.exports = {
    initSocket,
    getIo,
    isVendorOnline,
    getVendorSockets,
    emitToVendor,
    activeVendors,
    isUserOnline,
    getUserSockets,
    emitToUser,
    activeUsers
};
