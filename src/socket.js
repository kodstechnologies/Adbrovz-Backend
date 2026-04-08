const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('./config/env');

let io;
const activeVendors = new Map(); // vendorId -> [socketId1, socketId2, ...]
const activeUsers = new Map(); // userId -> [socketId1, socketId2, ...]

const stringifyId = (id) => {
    if (!id) return null;
    if (typeof id === 'string') return id;
    if (typeof id === 'object') {
        if (id._id) return id._id.toString();
        if (id.id) return id.id.toString();
        if (id.userId) return id.userId.toString();
    }
    return id.toString();
};

const registerVendorSocket = async (vendorId, socketId) => {
    const vId = stringifyId(vendorId);
    if (!vId || vId === '[object Object]') {
        console.error(` Attempted to register vendor with invalid ID:`, vendorId);
        return;
    }

    if (!activeVendors.has(vId)) activeVendors.set(vId, []);
    const sockets = activeVendors.get(vId);
    if (!sockets.includes(socketId)) sockets.push(socketId);
    console.log(`✅ Vendor ${vId} auto-registered on socket ${socketId}. Total: ${sockets.length}`);

    // Persist online status to DB
    try {
        const Vendor = require('./models/Vendor.model');
        await Vendor.findByIdAndUpdate(vId, { isOnline: true });
        console.log(` Vendor ${vId} marked online in DB`);
    } catch (err) {
        console.error(`Failed to update vendor ${vId} online status:`, err.message);
    }
};

const registerUserSocket = (userId, socketId) => {
    const uId = stringifyId(userId);
    if (!uId || uId === '[object Object]') {
        console.error(`⚠️ Attempted to register user with invalid ID:`, userId);
        return;
    }

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
        },
        pingTimeout: 60000,
        pingInterval: 25000,
    });

    io.on('connection', (socket) => {
        console.log(`🔌 New WebSocket Connection: ${socket.id}`);

        // ─── AUTO-REGISTRATION FROM JWT ────────────────────────────────────
        // App passes token via socket.handshake.auth.token or query.token
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        if (token) {
            try {
                const decoded = jwt.verifyUnsafe ? jwt.verifyUnsafe(token) : jwt.verify(token, config.JWT_SECRET);
                const role = decoded.role;
                const id = stringifyId(decoded.userId || decoded.id || decoded._id);
                if (id) {
                    if (role === 'vendor') {
                        registerVendorSocket(id, socket.id);
                        socket.vendorId = id;
                    } else if (role === 'user') {
                        registerUserSocket(id, socket.id);
                        socket.userId = id;
                    }
                }
            } catch (err) {
                console.log(`⚠️  Socket JWT auto-auth failed for ${socket.id}: ${err.message}`);
            }
        }
        // ──────────────────────────────────────────────────────────────────

        // Manual register_vendor (fallback for Postman / non-JWT connections)
        socket.on('register_vendor', (vendorId) => {
            const vId = stringifyId(vendorId);
            console.log(`[SOCKET] Manual register_vendor request for ID: ${vId}`);
            if (vId) {
                registerVendorSocket(vId, socket.id);
                socket.vendorId = vId;
            }
        });

        // Manual register_user (fallback)
        socket.on('register_user', (userId) => {
            const uId = stringifyId(userId);
            console.log(`[SOCKET] Manual register_user request for ID: ${uId}`);
            if (uId) {
                registerUserSocket(uId, socket.id);
                socket.userId = uId;
            }
        });

        // Vendor actions on bookings
        socket.on('accept_booking', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                const bookingId = stringifyId(data?.bookingId || (typeof data === 'string' ? data : null));

                console.log(`[SOCKET] accept_booking - vendorId: ${vendorId}, bookingId: ${bookingId}`);

                if (!vendorId) throw new Error('Vendor ID is required');
                if (!bookingId) throw new Error('Booking ID is required');

                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.acceptLead(vendorId, bookingId);
                socket.emit('booking_accepted_success', result);
            } catch (error) {
                console.error(`[SOCKET] accept_booking error: ${error.message}`);
                socket.emit('booking_error', { action: 'accept_booking', message: error.message });
            }
        });

        socket.on('reject_booking', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                const bookingId = stringifyId(data?.bookingId || (typeof data === 'string' ? data : null));

                if (!vendorId) throw new Error('Vendor ID is required');
                if (!bookingId) throw new Error('Booking ID is required');

                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.rejectLead(vendorId, bookingId);
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

                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.markLeadLater(vendorId, bookingId);
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

                const bookingService = require('./modules/booking/booking.service');
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

                const bookingService = require('./modules/booking/booking.service');
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

                const bookingService = require('./modules/booking/booking.service');
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

                const bookingService = require('./modules/booking/booking.service');
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

                const bookingService = require('./modules/booking/booking.service');
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

                const bookingService = require('./modules/booking/booking.service');
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

                if (!userId) throw new Error('User ID is required');
                if (!bookingId) throw new Error('Booking ID is required');

                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.confirmBookingPrice(userId, bookingId);
                socket.emit('booking_update_price_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'confirm_booking_price', message: error.message });
            }
        });

        socket.on('reject_booking_price', async (data) => {
            try {
                const userId = stringifyId(data?.userId || socket.userId);
                const bookingId = stringifyId(data?.bookingId);
                const { reason } = data || {};

                if (!userId) throw new Error('User ID is required');
                if (!bookingId) throw new Error('Booking ID is required');

                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.rejectBookingPrice(userId, bookingId, reason);
                socket.emit('booking_reject_price_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'reject_booking_price', message: error.message });
            }
        });

        // ── New real-time actions ──

        socket.on('report_vendor_no_show', async (data) => {
            try {
                const userId = stringifyId(data?.userId || socket.userId);
                const bookingId = stringifyId(data?.bookingId);

                if (!userId) throw new Error('User ID is required');
                if (!bookingId) throw new Error('Booking ID is required');

                const bookingService = require('./modules/booking/booking.service');
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

                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.gracePeriodCancel(userId, bookingId);
                socket.emit('booking_grace_period_cancel_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'grace_period_cancel', message: error.message });
            }
        });

        socket.on('add_booking_services', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                const bookingId = stringifyId(data?.bookingId);
                const { newServices } = data || {};

                if (!vendorId) throw new Error('Vendor ID is required');
                if (!bookingId) throw new Error('Booking ID is required');

                const bookingService = require('./modules/booking/booking.service');
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

                const bookingService = require('./modules/booking/booking.service');
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

                const bookingService = require('./modules/booking/booking.service');
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

                const bookingService = require('./modules/booking/booking.service');
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

                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.vendorConfirmExtraServices(vendorId, bookingId, services);
                socket.emit('vendor_confirm_extra_services_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'vendor_confirm_extra_services', message: error.message });
            }
        });

        // Simple accept — vendor agrees to do user's requested extra services (no price change needed)
        socket.on('vendor_accept_extra_services', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                const bookingId = stringifyId(data?.bookingId);

                if (!vendorId) throw new Error('Vendor ID is required');
                if (!bookingId) throw new Error('Booking ID is required');

                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.vendorAcceptExtraServices(vendorId, bookingId);
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

                if (!vendorId) throw new Error('Vendor ID is required');
                if (!bookingId) throw new Error('Booking ID is required');

                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.vendorRejectExtraServices(vendorId, bookingId, reason);
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

                const bookingService = require('./modules/booking/booking.service');
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

                if (!userId) throw new Error('User ID is required');
                if (!bookingId) throw new Error('Booking ID is required');

                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.userRejectExtraServices(userId, bookingId, reason);
                socket.emit('user_reject_extra_services_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'user_reject_extra_services', message: error.message });
            }
        });

        socket.on('get_booking_status', async (data) => {
            try {
                const bookingId = stringifyId(data?.bookingId);
                const role = data?.role || (socket.userId ? 'user' : 'vendor');
                const userId = stringifyId(socket.userId || socket.vendorId);

                if (!bookingId) throw new Error('Booking ID is required');
                if (!userId) throw new Error('You must be logged in to check booking status');

                const bookingService = require('./modules/booking/booking.service');
                const result = await bookingService.getBookingDetails(bookingId, userId, role);
                socket.emit('booking_status_response', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'get_booking_status', message: error.message });
            }
        });

        // Admin/Verification socket actions
        socket.on('verify_vendor_document', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId);
                const { docType, status, reason } = data || {};

                if (!vendorId) throw new Error('Vendor ID is required');

                const vendorService = require('./modules/vendor/vendor.service');
                const result = await vendorService.verifyDocument(vendorId, { docType, status, reason });
                socket.emit('verify_vendor_document_success', result);
            } catch (error) {
                socket.emit('verification_error', { action: 'verify_vendor_document', message: error.message });
            }
        });

        socket.on('get_verification_status', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                console.log(`[SOCKET] get_verification_status request. vendorId: ${vendorId}, socket.id: ${socket.id}`);
                
                if (!vendorId) {
                    console.warn(`[SOCKET] No vendorId provided for verification status request.`);
                    throw new Error('Vendor ID is required');
                }

                const vendorService = require('./modules/vendor/vendor.service');
                const result = await vendorService.getVerificationStatus(vendorId);
                socket.emit('verification_status_response', result);
                console.log(`📡 [SOCKET] Sent verification status to Vendor ${vendorId} via Socket ${socket.id}`);
            } catch (error) {
                console.error(`[SOCKET] get_verification_status error: ${error.message}`);
                socket.emit('verification_error', { action: 'get_verification_status', message: error.message });
            }
        });

        socket.on('verify_all_vendor_documents', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId);
                if (!vendorId) throw new Error('Vendor ID is required');

                const vendorService = require('./modules/vendor/vendor.service');
                const result = await vendorService.verifyAllDocuments(vendorId);
                socket.emit('verify_all_vendor_documents_success', result);
            } catch (error) {
                socket.emit('verification_error', { action: 'verify_all_vendor_documents', message: error.message });
            }
        });

        socket.on('disconnect', async () => {
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

                        // Persist offline status to DB
                        try {
                            const Vendor = require('./models/Vendor.model');
                            await Vendor.findByIdAndUpdate(vendorId, { isOnline: false });
                            console.log(`🔴 Vendor ${vendorId} marked offline in DB`);
                        } catch (err) {
                            console.error(`⚠️ Failed to update vendor ${vendorId} offline status:`, err.message);
                        }
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
    if (!io) {
        console.warn(`[SOCKET] emitToVendor: Socket.io not initialized. Cannot emit '${event}'.`);
        return;
    }
    const vIdStr = vendorId.toString();
    const sockets = activeVendors.get(vIdStr) || [];

    console.log(`[SOCKET DEBUG] emitToVendor called: event='${event}', vendorId='${vIdStr}', matchedSockets=${sockets.length}, allRegisteredVendors=[${[...activeVendors.keys()].join(', ')}]`);

    if (sockets.length === 0) {
        console.warn(`[SOCKET] No active sockets for Vendor ${vIdStr}. FAILED to emit '${event}'.`);
        return;
    }

    sockets.forEach(socketId => {
        io.to(socketId).emit(event, data);
    });
    console.log(`📡 Emitted '${event}' to Vendor ${vIdStr} on ${sockets.length} socket(s)`);
};

/**
 * Emit an event to all socket connections of a given user.
 * Safe to call even if the user is not connected (no-op).
 */
const emitToUser = (userId, event, data) => {
    if (!io) {
        console.warn(`[SOCKET] Cannot emit to user ${userId}: Socket.io not initialized`);
        return;
    }
    const userIdStr = userId.toString();
    const sockets = activeUsers.get(userIdStr) || [];
    
    if (sockets.length === 0) {
        console.log(`[SOCKET] No active sockets found for User ${userIdStr}. FAILED to emit '${event}'.`);
    } else {
        sockets.forEach(socketId => {
            io.to(socketId).emit(event, data);
        });
        console.log(`📡 Emitted '${event}' to User ${userIdStr} on ${sockets.length} socket(s)`);
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
