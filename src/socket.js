const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('./config/env');

// ── Hoist all service/model requires to avoid cold-start latency on first event ──
const Vendor = require('./models/Vendor.model');
const bookingService = require('./modules/booking/booking.service');
const vendorService = require('./modules/vendor/vendor.service');

let io;
const activeVendors = new Map(); // vendorId -> [socketId1, socketId2, ...]
const activeUsers = new Map();   // userId   -> [socketId1, socketId2, ...]
const pendingVendorDisconnects = new Map(); // vendorId -> { timeoutId, nonce }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const emitToDiagnostics = (event, data) => {
    if (io) {
        io.to('diagnostics').emit(event, data);
        console.log(`📡 [DIAGNOSTICS] Direct broadcast: '${event}'`);
    }
};

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

// ── India-specific coordinate range check (replaces fragile lng < lat swap) ───
// Valid Indian lat: 8–37, lng: 68–97. If values look swapped, correct them.
const normalizeIndiaCoords = (lat, lng) => {
    const latInRange = lat >= 8 && lat <= 37;
    const lngInRange = lng >= 68 && lng <= 97;
    if (!latInRange && lngInRange) {
        // Likely swapped
        return { lat: lng, lng: lat };
    }
    return { lat, lng };
};

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register a vendor socket and mark them online in the DB.
 * MUST be awaited so membership checks complete before the caller continues.
 */
const registerVendorSocket = async (vendorId, socketId, socket) => {
    const vId = stringifyId(vendorId);

    if (!vId || vId === '[object Object]') {
        return;
    }

    // Clear any pending disconnect timeout so the vendor stays online
    if (pendingVendorDisconnects.has(vId)) {
        clearTimeout(pendingVendorDisconnects.get(vId).timeoutId);
        pendingVendorDisconnects.delete(vId);
    }

    if (!activeVendors.has(vId)) activeVendors.set(vId, []);
    const sockets = activeVendors.get(vId);
    if (!sockets.includes(socketId)) sockets.push(socketId);

    emitToDiagnostics('socket_registration_event', {
        socketId,
        role: 'vendor',
        id: vId,
        timestamp: new Date()
    });

    // Persist online status to DB (only if membership is valid)
    try {
        const vendor = await Vendor.findById(vId).select('membership.expiryDate serviceRenewal.expiryDate');

        if (!vendor) {
            return;
        }

        const isMembershipExpired = vendor.membership?.expiryDate && new Date(vendor.membership.expiryDate) < new Date();
        const isServiceExpired = vendor.serviceRenewal?.expiryDate && new Date(vendor.serviceRenewal.expiryDate) < new Date();

        if (isMembershipExpired || isServiceExpired) {
            await Vendor.findByIdAndUpdate(vId, { isOnline: false });
            if (io) {
                io.to(socketId).emit('membership_expired_error', {
                    message: 'Your membership or service has expired. Please renew to go online.',
                    expiryDate: vendor.membership?.expiryDate || vendor.serviceRenewal?.expiryDate
                });
            }
            return;
        }

        await Vendor.findByIdAndUpdate(vId, { isOnline: true });

        // Push any pending bookings so events missed during disconnect are not lost
        if (socket && bookingService.getPendingBookingsForVendor) {
            try {
                const pending = await bookingService.getPendingBookingsForVendor(vId);
                if (pending && pending.length > 0) {
                    pending.forEach(booking => io.to(socketId).emit('new_booking_request', booking));
                }
            } catch (err) {
            }
        }
    } catch (err) {
        console.error(`❌ Failed to update vendor ${vId} online status:`, err.message);
    }
};

const registerUserSocket = (userId, socketId) => {
    const uId = stringifyId(userId);
    // FIX: guard '[object Object]' same as registerVendorSocket
    if (!uId || uId === '[object Object]') {
        console.error(`⚠️ Attempted to register user with invalid ID:`, userId);
        return;
    }

    if (!activeUsers.has(uId)) activeUsers.set(uId, []);
    const sockets = activeUsers.get(uId);
    if (!sockets.includes(socketId)) sockets.push(socketId);
    console.log(`✅ User ${uId} registered on socket ${socketId}. Total: ${sockets.length}`);

    emitToDiagnostics('socket_registration_event', {
        socketId,
        role: 'user',
        id: uId,
        timestamp: new Date()
    });
};

// ─── Init ─────────────────────────────────────────────────────────────────────

const initSocket = async (server) => {
    // FIX: Reset all vendors to offline at startup so stale isOnline:true
    // records left by a previous crash are cleared immediately.
    try {
        await Vendor.updateMany({}, { isOnline: false });
        console.log(`🔄 [SOCKET INIT] All vendors reset to offline.`);
    } catch (err) {
        console.error(`[SOCKET INIT] Failed to reset vendor online statuses:`, err.message);
    }

    io = new Server(server, {
        path: '/socket.io/',
        cors: {
            origin: config.CORS_ORIGIN === '*' ? '*' : (config.CORS_ORIGIN?.split(',') || ['http://localhost:3000']),
            methods: ['GET', 'POST'],
            credentials: config.CORS_ORIGIN !== '*'
        },
        transports: ['polling', 'websocket'],
        upgrade: true,
        pingTimeout: 120000,
        pingInterval: 30000,
        connectTimeout: 45000,
        allowEIO3: true,
        maxHttpBufferSize: 1e7
    });

    io.engine.on('connection_error', (err) => {
        console.error(`[SOCKET ENGINE ERROR] Code: ${err.code}, Message: ${err.message}, URL: ${err.req?.url}`);
    });

    io.on('connection', (socket) => {
        const transport = socket.conn.transport.name;
        console.log(`🔌 New Connection: ${socket.id} [Transport: ${transport}] [IP: ${socket.handshake.address}]`);

        emitToDiagnostics('socket_connection_event', {
            type: 'connect',
            socketId: socket.id,
            transport,
            ip: socket.handshake.address,
            timestamp: new Date()
        });

        socket.conn.on('upgrade', () => {
            console.log(`🚀 Socket ${socket.id} upgraded to ${socket.conn.transport.name}`);
        });

        socket.conn.on('close', (reason) => {
            console.log(`🔴 [ENGINE CLOSE] Socket ${socket.id} closed. Reason: ${reason}`);
        });

        socket.conn.on('error', (err) => {
            console.error(`🚨 [ENGINE ERROR] Socket ${socket.id} error:`, err);
        });

        // ─── AUTO-REGISTRATION FROM JWT ───────────────────────────────────────
        // FIX: removed jwt.verifyUnsafe fallback — always verify the signature.
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        console.log(`[SOCKET] Handshake token present: ${!!token} for socket: ${socket.id}`);

        if (token) {
            // Wrap in async IIFE so registerVendorSocket can be properly awaited.
            (async () => {
                try {
                    const decoded = jwt.verify(token, config.JWT_SECRET); // ALWAYS verify signature
                    const role = decoded.role;
                    const id = stringifyId(decoded.userId || decoded.id || decoded._id);
                    console.log(`[SOCKET] Decoded token - role: ${role}, id: ${id}`);

                    if (id) {
                        if (role === 'vendor') {
                            await registerVendorSocket(id, socket.id, socket); // awaited
                            socket.vendorId = id;
                        } else if (role === 'user') {
                            registerUserSocket(id, socket.id);
                            socket.userId = id;
                        }
                    }
                } catch (err) {
                    console.log(`⚠️  Socket JWT auto-auth failed for ${socket.id}: ${err.message}`);
                    socket.emit('auth_error', { message: 'Token expired or invalid. Please re-authenticate.', code: 'TOKEN_INVALID' });
                }
            })();
        }
        // ─────────────────────────────────────────────────────────────────────

        // FIX: Manual register_vendor / register_user fallbacks now require the
        // JWT token to be re-supplied so we never accept an unauthenticated claim.
        socket.on('register_vendor', (data) => {
            (async () => {
                try {
                    const { token: manualToken } = data || {};
                    if (!manualToken) throw new Error('Token required for manual registration');
                    const decoded = jwt.verify(manualToken, config.JWT_SECRET);
                    const vId = stringifyId(decoded.userId || decoded.id || decoded._id);
                    if (!vId) throw new Error('Invalid token payload');
                    if (decoded.role !== 'vendor') throw new Error('Role mismatch');
                    await registerVendorSocket(vId, socket.id, socket);
                    socket.vendorId = vId;
                } catch (err) {
                    console.warn(`[SOCKET] manual register_vendor rejected: ${err.message}`);
                    socket.emit('auth_error', { message: err.message, code: 'TOKEN_INVALID' });
                }
            })();
        });

        socket.on('register_user', (data) => {
            try {
                const { token: manualToken } = data || {};
                if (!manualToken) throw new Error('Token required for manual registration');
                const decoded = jwt.verify(manualToken, config.JWT_SECRET);
                const uId = stringifyId(decoded.userId || decoded.id || decoded._id);
                if (!uId) throw new Error('Invalid token payload');
                if (decoded.role !== 'user') throw new Error('Role mismatch');
                registerUserSocket(uId, socket.id);
                socket.userId = uId;
            } catch (err) {
                console.warn(`[SOCKET] manual register_user rejected: ${err.message}`);
                socket.emit('auth_error', { message: err.message, code: 'TOKEN_INVALID' });
            }
        });

        // FIX: join_diagnostics now requires an admin JWT so booking PII is not
        // leaked to anonymous clients.
        socket.on('join_diagnostics', (data) => {
            try {
                const { token: diagToken } = data || {};
                if (!diagToken) throw new Error('Admin token required');
                const decoded = jwt.verify(diagToken, config.JWT_SECRET);
                if (decoded.role !== 'admin') throw new Error('Admin role required');
                socket.join('diagnostics');
                console.log(`[SOCKET] Admin socket ${socket.id} joined diagnostics room`);
            } catch (err) {
                console.warn(`[SOCKET] join_diagnostics rejected for ${socket.id}: ${err.message}`);
                socket.emit('auth_error', { message: 'Admin access required for diagnostics', code: 'FORBIDDEN' });
            }
        });

        // ─── Mock booking simulator ───────────────────────────────────────────
        socket.on('trigger_mock_booking', (data) => {
            try {
                const bookingId = stringifyId(data?.bookingId) || ('BK-' + Math.floor(1000 + Math.random() * 9000));
                const userId = stringifyId(data?.userId || socket.userId || '6a0a9ac23acfd6f22281d799');
                const vendorId = stringifyId(data?.vendorId);

                console.log(`[SOCKET SIMULATOR] trigger_mock_booking - bookingId: ${bookingId}, userId: ${userId}, vendorId: ${vendorId}`);

                const payload = {
                    _id: bookingId,
                    bookingID: bookingId,
                    status: 'pending_acceptance',
                    user: {
                        _id: userId,
                        name: 'Mock Customer',
                        phoneNumber: '9876543210',
                        photo: null
                    },
                    category: {
                        _id: '6a0a9c3267ba064f7fde1111',
                        title: data?.category || 'AC Repair & Service',
                        name: data?.category || 'AC Repair & Service'
                    },
                    services: [
                        {
                            service: {
                                _id: '6a0a9c3267ba064f7fde2222',
                                title: data?.serviceTitle || 'AC Cleaning & Deep Wash',
                                serviceCharge: 499,
                                approxCompletionTime: 45
                            },
                            quantity: 1,
                            finalPrice: 499
                        }
                    ],
                    pricing: { basePrice: 499, travelCharge: 50, totalPrice: 549 },
                    location: {
                        address: '123 Premium Glassmorphism Blvd, Indiranagar',
                        latitude: 12.9715987,
                        longitude: 77.5945627
                    },
                    totalDurationMins: 45,
                    radius: 5,
                    createdAt: new Date()
                };

                if (vendorId) {
                    const sockets = activeVendors.get(vendorId) || [];
                    sockets.forEach(sId => io.to(sId).emit('new_booking_request', payload));
                    console.log(`📡 [SOCKET SIMULATOR] Sent new_booking_request to Vendor ${vendorId}`);
                } else {
                    const vendorIds = Array.from(activeVendors.keys());
                    if (vendorIds.length > 0) {
                        vendorIds.forEach(vId => {
                            (activeVendors.get(vId) || []).forEach(sId =>
                                io.to(sId).emit('new_booking_request', payload)
                            );
                        });
                        console.log(`📡 [SOCKET SIMULATOR] Broadcasted to all online vendors: ${vendorIds.join(', ')}`);
                    } else {
                        console.log(`⚠️ [SOCKET SIMULATOR] No vendors online.`);
                    }
                }

                socket.emit('booking_created_success', {
                    booking: payload,
                    message: 'Mock booking triggered successfully! Broadcasted to active vendors.'
                });
            } catch (error) {
                console.error(`[SOCKET SIMULATOR] Error in trigger_mock_booking:`, error);
                socket.emit('booking_error', { action: 'trigger_mock_booking', message: error.message });
            }
        });

        // ─── Vendor booking actions ───────────────────────────────────────────

        socket.on('accept_booking', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                const bookingId = stringifyId(data?.bookingId || (typeof data === 'string' ? data : null));
                if (!vendorId) throw new Error('Vendor ID is required');
                if (!bookingId) throw new Error('Booking ID is required');

                if (!/^[0-9a-fA-F]{24}$/.test(bookingId)) {
                    socket.emit('booking_accepted_success', { success: true, bookingId, status: 'accepted', message: 'Mock booking accepted!' });
                    io.emit('booking_status_updated', { bookingId, status: 'accepted', vendorId });
                    return;
                }

                const result = await bookingService.acceptBooking(vendorId, bookingId);
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

                if (!/^[0-9a-fA-F]{24}$/.test(bookingId)) {
                    socket.emit('booking_rejected_success', { success: true, bookingId, status: 'rejected', message: 'Mock booking rejected!' });
                    io.emit('booking_status_updated', { bookingId, status: 'rejected', vendorId });
                    return;
                }

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
                const result = await bookingService.rejectBookingPrice(userId, bookingId, reason);
                socket.emit('booking_reject_price_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'reject_booking_price', message: error.message });
            }
        });

        // ─── Location ─────────────────────────────────────────────────────────

        socket.on('update_location', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                let { lat, lng, accuracy } = data || {};

                if (!vendorId) throw new Error('Vendor ID is required');
                if (lat === undefined || lng === undefined) throw new Error('Latitude and Longitude are required');

                // FIX: Use India-specific range check instead of the fragile lng < lat swap
                ({ lat, lng } = normalizeIndiaCoords(lat, lng));

                if (accuracy !== undefined && accuracy > 50) {
                    console.log(`[SOCKET] Location skipped for vendor ${vendorId}: poor accuracy ${accuracy}m`);
                    socket.emit('location_updated_success', { lat, lng, ignored: true, reason: 'low_accuracy', timestamp: new Date() });
                    return;
                }

                const vendor = await Vendor.findByIdAndUpdate(vendorId, {
                    'liveLocation.type': 'Point',
                    'liveLocation.coordinates': [lng, lat],
                    'liveLocation.updatedAt': new Date()
                });

                if (!vendor) throw new Error('Vendor not found');

                if (bookingService.broadcastVendorLocation) {
                    await bookingService.broadcastVendorLocation(vendorId, lat, lng);
                }

                socket.emit('location_updated_success', { lat, lng, timestamp: new Date() });
            } catch (error) {
                console.error(`[SOCKET] update_location error: ${error.message}`);
                // FIX: Always surface errors to the client so the app can react
                socket.emit('location_error', { action: 'update_location', message: error.message });
            }
        });

        socket.on('check_vendor_tracking_status', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                if (!vendorId) throw new Error('Vendor ID is required');
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

        // ─── User actions ─────────────────────────────────────────────────────

        socket.on('report_vendor_no_show', async (data) => {
            try {
                const userId = stringifyId(data?.userId || socket.userId);
                const bookingId = stringifyId(data?.bookingId);
                if (!userId) throw new Error('User ID is required');
                if (!bookingId) throw new Error('Booking ID is required');
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
                const result = await bookingService.gracePeriodCancel(userId, bookingId);
                socket.emit('booking_grace_period_cancel_success', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'grace_period_cancel', message: error.message });
            }
        });

        // ─── Service negotiation ──────────────────────────────────────────────

        socket.on('add_booking_services', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                const bookingId = stringifyId(data?.bookingId);
                const { newServices } = data || {};
                if (!vendorId) throw new Error('Vendor ID is required');
                if (!bookingId) throw new Error('Booking ID is required');
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
                if (!vendorId) throw new Error('Vendor ID is required');
                if (!bookingId) throw new Error('Booking ID is required');
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
                const result = await bookingService.getBookingDetails(bookingId, userId, role);
                socket.emit('booking_status_response', result);
            } catch (error) {
                socket.emit('booking_error', { action: 'get_booking_status', message: error.message });
            }
        });

        socket.on('booking_received_ack', (data) => {
            console.log('✅ Vendor ACK RECEIVED:', data);
        });

        // ─── Admin / Verification ─────────────────────────────────────────────

        socket.on('verify_vendor_document', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId);
                const { docType, status, reason } = data || {};
                if (!vendorId) throw new Error('Vendor ID is required');
                const result = await vendorService.verifyDocument(vendorId, { docType, status, reason });
                socket.emit('verify_vendor_document_success', result);
            } catch (error) {
                socket.emit('verification_error', { action: 'verify_vendor_document', message: error.message });
            }
        });

        socket.on('get_verification_status', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                if (!vendorId) throw new Error('Vendor ID is required');
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
                const result = await vendorService.verifyAllDocuments(vendorId);
                socket.emit('verify_all_vendor_documents_success', result);
            } catch (error) {
                socket.emit('verification_error', { action: 'verify_all_vendor_documents', message: error.message });
            }
        });

        // ─── Disconnect ───────────────────────────────────────────────────────

        socket.on('disconnect', async (reason) => {
            console.log(`WebSocket Disconnected: ${socket.id}, reason: ${reason}, transport: ${socket.conn?.transport?.name || 'unknown'}`);

            emitToDiagnostics('socket_connection_event', {
                type: 'disconnect',
                socketId: socket.id,
                reason,
                transport: socket.conn?.transport?.name || 'unknown',
                registeredAs: socket.vendorId
                    ? `vendor:${socket.vendorId}`
                    : (socket.userId ? `user:${socket.userId}` : 'anonymous'),
                timestamp: new Date()
            });

            // Remove socket from vendor map
            for (const [vendorId, sockets] of activeVendors.entries()) {
                const index = sockets.indexOf(socket.id);
                if (index !== -1) {
                    sockets.splice(index, 1);
                    console.log(`❌ Socket ${socket.id} removed from Vendor ${vendorId}. Remaining: ${sockets.length}`);

                    if (sockets.length === 0) {
                        console.log(`   Vendor ${vendorId} has 0 active sockets. Scheduling offline in 15s.`);

                        // Clear any existing pending timeout first
                        if (pendingVendorDisconnects.has(vendorId)) {
                            clearTimeout(pendingVendorDisconnects.get(vendorId).timeoutId);
                        }

                        // FIX: Use a nonce so only the most-recent timeout can write to DB.
                        // Earlier timeouts that fire late will detect their nonce is stale and bail.
                        const nonce = Date.now();
                        const timeoutId = setTimeout(async () => {
                            const pending = pendingVendorDisconnects.get(vendorId);

                            // Bail if a newer timeout has taken over (nonce mismatch)
                            if (!pending || pending.nonce !== nonce) {
                                console.log(`   Vendor ${vendorId} timeout superseded (nonce mismatch). Skipping.`);
                                return;
                            }

                            pendingVendorDisconnects.delete(vendorId);

                            const currentSockets = activeVendors.get(vendorId) || [];
                            if (currentSockets.length === 0) {
                                activeVendors.delete(vendorId);
                                console.log(`   Vendor ${vendorId} fully offline after grace period.`);
                                try {
                                    await Vendor.findByIdAndUpdate(vendorId, { isOnline: false });
                                    console.log(`🔴 Vendor ${vendorId} marked offline in DB`);
                                } catch (err) {
                                    console.error(`⚠️ Failed to mark vendor ${vendorId} offline:`, err.message);
                                }
                            } else {
                                console.log(`   Vendor ${vendorId} reconnected during grace period. Keeping online.`);
                            }
                        }, 15000);

                        pendingVendorDisconnects.set(vendorId, { timeoutId, nonce });
                    }
                    break;
                }
            }

            // Remove socket from user map
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

    // FIX: Clear all pending disconnect timers on graceful shutdown so the
    // Node.js event loop can exit cleanly.
    const cleanup = () => {
        console.log('[SOCKET] Cleaning up pending disconnect timers...');
        for (const { timeoutId } of pendingVendorDisconnects.values()) {
            clearTimeout(timeoutId);
        }
        pendingVendorDisconnects.clear();
    };
    process.once('SIGTERM', cleanup);
    process.once('SIGINT', cleanup);

    return io;
};

// ─── Exported helpers ─────────────────────────────────────────────────────────

const getIo = () => {
    if (!io) throw new Error('Socket.io not initialized');
    return io;
};

const DIAGNOSTICS_EVENTS = new Set([
    'new_booking_request', 'booking_status_updated', 'booking_accepted_success',
    'booking_rejected_success', 'booking_created_success', 'service_approval_response',
    'service_approval_update', 'extra_service_approval_update'
]);

const emitToVendor = (vendorId, event, data) => {
    if (!io) {
        console.warn(`[SOCKET] emitToVendor: Socket.io not initialized. Cannot emit '${event}'.`);
        return;
    }
    const vIdStr = vendorId.toString();
    const sockets = activeVendors.get(vIdStr) || [];

    console.log(`[SOCKET DEBUG] emitToVendor: event='${event}', vendorId='${vIdStr}', sockets=${sockets.length}, allVendors=[${[...activeVendors.keys()].join(', ')}]`);

    if (DIAGNOSTICS_EVENTS.has(event)) {
        io.to('diagnostics').emit(event, data);
        console.log(`📡 [DIAGNOSTICS] Forwarded '${event}' to diagnostics room`);
    }

    if (sockets.length === 0) {
        console.warn(`[SOCKET] No active sockets for Vendor ${vIdStr}. FAILED to emit '${event}'.`);
        return;
    }

    sockets.forEach(socketId => io.to(socketId).emit(event, data));
    console.log(`📡 Emitted '${event}' to Vendor ${vIdStr} on ${sockets.length} socket(s)`);
};

const emitToUser = (userId, event, data) => {
    if (!io) {
        console.warn(`[SOCKET] Cannot emit to user ${userId}: Socket.io not initialized`);
        return;
    }
    const userIdStr = userId.toString();
    const sockets = activeUsers.get(userIdStr) || [];

    if (DIAGNOSTICS_EVENTS.has(event)) {
        io.to('diagnostics').emit(event, data);
        console.log(`📡 [DIAGNOSTICS] Forwarded '${event}' to diagnostics room`);
    }

    if (sockets.length === 0) {
        console.warn(`[SOCKET] No active sockets for User ${userIdStr}. FAILED to emit '${event}'.`);
    } else {
        sockets.forEach(socketId => io.to(socketId).emit(event, data));
        console.log(`📡 Emitted '${event}' to User ${userIdStr} on ${sockets.length} socket(s)`);
    }
};

const isVendorOnline = (vendorId) => {
    const sockets = activeVendors.get(vendorId.toString());
    return !!(sockets && sockets.length > 0);
};

const getVendorSockets = (vendorId) => activeVendors.get(vendorId.toString()) || [];

const isUserOnline = (userId) => {
    const sockets = activeUsers.get(userId.toString());
    return !!(sockets && sockets.length > 0);
};

const getUserSockets = (userId) => activeUsers.get(userId.toString()) || [];

module.exports = {
    initSocket,
    getIo,
    isVendorOnline,
    getVendorSockets,
    emitToVendor,
    emitToDiagnostics,
    activeVendors,
    isUserOnline,
    getUserSockets,
    emitToUser,
    activeUsers
};