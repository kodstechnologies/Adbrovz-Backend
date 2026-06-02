const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('./config/env');

let io;
const activeVendors = new Map(); // vendorId -> [socketId1, socketId2, ...]
const activeUsers = new Map(); // userId -> [socketId1, socketId2, ...]
const pendingVendorDisconnects = new Map(); // vendorId -> setTimeout ID

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

const registerVendorSocket = async (vendorId, socketId) => {
    const vId = stringifyId(vendorId);
    console.log(`[SOCKET] Registration request - vendorId: ${vendorId}, stringified: ${vId}, socketId: ${socketId}`);
    
    if (!vId || vId === '[object Object]') {
        console.error(`⚠️ Attempted to register vendor with invalid ID:`, vendorId);
        return;
    }

    // Clear any pending disconnect timeout if the vendor reconnects/registers
    if (pendingVendorDisconnects.has(vId)) {
        console.log(`♻️ Vendor ${vId} reconnected before offline timeout. Clearing timeout.`);
        clearTimeout(pendingVendorDisconnects.get(vId));
        pendingVendorDisconnects.delete(vId);
    }


    if (!activeVendors.has(vId)) activeVendors.set(vId, []);
    const sockets = activeVendors.get(vId);
    if (!sockets.includes(socketId)) sockets.push(socketId);
    console.log(`✅ Vendor ${vId} auto-registered on socket ${socketId}. Total sockets for this vendor: ${sockets.length}. All active vendors: ${[...activeVendors.keys()].join(', ')}`);
    emitToDiagnostics('socket_registration_event', {
        socketId,
        role: 'vendor',
        id: vId,
        timestamp: new Date()
    });

    // Persist online status to DB (only if membership is valid)
    try {
        const Vendor = require('./models/Vendor.model');
        const vendor = await Vendor.findById(vId).select('isVerified isSuspended isBlocked isLocked registrationStep membership.expiryDate serviceRenewal.expiryDate');
        
        if (!vendor) {
            console.error(`⚠️ Vendor ${vId} not found during socket registration`);
            return;
        }

        const isMembershipExpired = vendor.membership?.expiryDate && new Date(vendor.membership.expiryDate) < new Date();
        const isServiceExpired = vendor.serviceRenewal?.expiryDate && new Date(vendor.serviceRenewal.expiryDate) < new Date();
        const isRegistrationEligible = ['MEMBERSHIP_PAID', 'PLAN_PAID', 'COMPLETED'].includes(vendor.registrationStep);

        if (!vendor.isVerified || vendor.isSuspended || vendor.isBlocked || vendor.isLocked || !isRegistrationEligible) {
            console.log(`🚫 Vendor ${vId} is not eligible to go online. verified=${vendor.isVerified}, suspended=${vendor.isSuspended}, blocked=${vendor.isBlocked}, locked=${vendor.isLocked}, registrationStep=${vendor.registrationStep}`);
            await Vendor.findByIdAndUpdate(vId, { isOnline: false });
            if (io) {
                io.to(socketId).emit('online_denied', {
                    message: 'Your account is not eligible to go online. Please complete your membership or resolve account issues.'
                });
            }
            return;
        }

        if (isMembershipExpired || isServiceExpired) {
            console.log(`🚫 Vendor ${vId} membership or service expired. Keeping offline.`);
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
        console.log(`📡 Vendor ${vId} marked online in DB`);
    } catch (err) {
        console.error(`❌ Failed to update vendor ${vId} online status:`, err.message);
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
    emitToDiagnostics('socket_registration_event', {
        socketId,
        role: 'user',
        id: uId,
        timestamp: new Date()
    });
};

const initSocket = (server) => {
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

    // Log connection errors for debugging
    io.engine.on("connection_error", (err) => {
        console.error(`[SOCKET ENGINE ERROR] Code: ${err.code}, Message: ${err.message}, URL: ${err.req?.url}`);
    });

    io.on('connection', (socket) => {
        const transport = socket.conn.transport.name;
        console.log(`🔌 New Connection: ${socket.id} [Transport: ${transport}] [IP: ${socket.handshake.address}]`);

        // Broadcast new connection to diagnostics room
        emitToDiagnostics('socket_connection_event', {
            type: 'connect',
            socketId: socket.id,
            transport,
            ip: socket.handshake.address,
            timestamp: new Date()
        });

        // Log upgrade events
        socket.conn.on('upgrade', () => {
            const upgradedTransport = socket.conn.transport.name;
            console.log(`🚀 Socket ${socket.id} upgraded to ${upgradedTransport}`);
        });

        // Log underlying Engine.IO connection close and error events
        socket.conn.on("close", (reason) => {
            console.log(`🔴 [ENGINE CLOSE] Socket ${socket.id} closed. Reason: ${reason}`);
        });

        socket.conn.on("error", (err) => {
            console.error(`🚨 [ENGINE ERROR] Socket ${socket.id} error:`, err);
        });

        // ─── AUTO-REGISTRATION FROM JWT ────────────────────────────────────
        // App passes token via socket.handshake.auth.token or query.token
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        console.log(`[SOCKET] Handshake token present: ${!!token} for socket: ${socket.id}`);
        
        if (token) {
            try {
                const decoded = jwt.verifyUnsafe ? jwt.verifyUnsafe(token) : jwt.verify(token, config.JWT_SECRET);
                const role = decoded.role;
                const id = stringifyId(decoded.userId || decoded.id || decoded._id);
                console.log(`[SOCKET] Decoded token - role: ${role}, id: ${id}`);
                
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
                socket.emit('auth_error', { message: 'Token expired or invalid. Please re-authenticate.', code: 'TOKEN_INVALID' });
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

        // Register to join the global diagnostics channel
        socket.on('join_diagnostics', () => {
            socket.join('diagnostics');
            console.log(`[SOCKET] Socket ${socket.id} successfully joined diagnostics room`);
        });

        // Simulator for testing: User triggers a mock booking that automatically notifies active vendors
        socket.on('trigger_mock_booking', (data) => {
            try {
                const bookingId = stringifyId(data?.bookingId) || ("BK-" + Math.floor(1000 + Math.random() * 9000));
                const userId = stringifyId(data?.userId || socket.userId || "6a0a9ac23acfd6f22281d799");
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
                    pricing: { 
                        basePrice: 499,
                        travelCharge: 50,
                        totalPrice: 549 
                    },
                    location: { 
                        address: '123 Premium Glassmorphism Blvd, Indiranagar', 
                        latitude: 12.9715987, 
                        longitude: 77.5945627 
                    },
                    totalDurationMins: 45,
                    radius: 5,
                    createdAt: new Date()
                };

                // Emit new_booking_request to target vendor if provided, or to all active vendors
                if (vendorId) {
                    const sockets = activeVendors.get(vendorId) || [];
                    sockets.forEach(sId => {
                        io.to(sId).emit('new_booking_request', payload);
                    });
                    console.log(`📡 [SOCKET SIMULATOR] Sent new_booking_request to specific Vendor ${vendorId}`);
                } else {
                    const vendorIds = Array.from(activeVendors.keys());
                    if (vendorIds.length > 0) {
                        vendorIds.forEach(vId => {
                            const sockets = activeVendors.get(vId) || [];
                            sockets.forEach(sId => {
                                io.to(sId).emit('new_booking_request', payload);
                            });
                        });
                        console.log(`📡 [SOCKET SIMULATOR] Broadcasted new_booking_request to all online vendors: ${vendorIds.join(', ')}`);
                    } else {
                        console.log(`⚠️ [SOCKET SIMULATOR] No vendors online in activeVendors map.`);
                    }
                }

                // Confirm back to the user client
                socket.emit('booking_created_success', {
                    booking: payload,
                    message: 'Mock booking triggered successfully! Broadcasted to active vendors.'
                });
            } catch (error) {
                console.error(`[SOCKET SIMULATOR] Error in trigger_mock_booking:`, error);
                socket.emit('booking_error', { action: 'trigger_mock_booking', message: error.message });
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

                // If this is a mock booking (not a 24-hex-character ObjectId), handle it in-memory
                if (!/^[0-9a-fA-F]{24}$/.test(bookingId)) {
                    console.log(`📡 [SOCKET SIMULATOR] Intercepted mock booking acceptance in memory for ID: ${bookingId}`);
                    socket.emit('booking_accepted_success', {
                        success: true,
                        bookingId: bookingId,
                        status: 'accepted',
                        message: 'Mock booking accepted successfully!'
                    });
                    if (io) {
                        io.emit('booking_status_updated', {
                            bookingId: bookingId,
                            status: 'accepted',
                            vendorId: vendorId
                        });
                    }
                    return;
                }

                const bookingService = require('./modules/booking/booking.service');
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

                // If this is a mock booking (not a 24-hex-character ObjectId), handle it in-memory
                if (!/^[0-9a-fA-F]{24}$/.test(bookingId)) {
                    console.log(`📡 [SOCKET SIMULATOR] Intercepted mock booking rejection in memory for ID: ${bookingId}`);
                    socket.emit('booking_rejected_success', {
                        success: true,
                        bookingId: bookingId,
                        status: 'rejected',
                        message: 'Mock booking rejected successfully!'
                    });
                    if (io) {
                        io.emit('booking_status_updated', {
                            bookingId: bookingId,
                            status: 'rejected',
                            vendorId: vendorId
                        });
                    }
                    return;
                }

                const bookingService = require('./modules/booking/booking.service');
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

                const bookingService = require('./modules/booking/booking.service');
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

        socket.on('update_location', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                let { lat, lng, accuracy } = data || {};

                if (!vendorId) throw new Error('Vendor ID is required');
                if (lat === undefined || lng === undefined) throw new Error('Latitude and Longitude are required');

                // In India, longitude is always > 60 and latitude is < 40.
                // If they are sent swapped from the app, we auto-detect and correct them.
                if (lng < lat) {
                    [lng, lat] = [lat, lng];
                }

                // Filter by location accuracy (only update if accuracy is <= 50 meters)
                if (accuracy !== undefined && accuracy > 50) {
                    console.log(`[SOCKET] Location update skipped for vendor ${vendorId} due to poor accuracy: ${accuracy}m`);
                    socket.emit('location_updated_success', {
                        lat,
                        lng,
                        ignored: true,
                        reason: 'low_accuracy',
                        timestamp: new Date()
                    });
                    return;
                }

                const Vendor = require('./models/Vendor.model');
                // Update location and check existence
                const vendor = await Vendor.findByIdAndUpdate(vendorId, {
                    'liveLocation.type': 'Point',
                    'liveLocation.coordinates': [lng, lat],
                    'liveLocation.updatedAt': new Date()
                });

                if (!vendor) {
                    throw new Error('Vendor not found');
                }

                const bookingService = require('./modules/booking/booking.service');
                if (bookingService.broadcastVendorLocation) {
                    await bookingService.broadcastVendorLocation(vendorId, lat, lng);
                }

                socket.emit('location_updated_success', { lat, lng, timestamp: new Date() });
            } catch (error) {
                console.error(`[SOCKET] update_location error: ${error.message}`);
                // Only emit error if it's a critical existence failure
                if (error.message === 'Vendor not found') {
                    socket.emit('location_error', { action: 'update_location', message: error.message });
                }
            }
        });

        /**
         * Check if a vendor should be actively tracking (has active bookings)
         * Used by mobile app to save battery.
         */
        socket.on('check_vendor_tracking_status', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId || socket.vendorId);
                if (!vendorId) throw new Error('Vendor ID is required');
 
                const bookingService = require('./modules/booking/booking.service');
                const isTrackingActive = await bookingService.shouldTrackVendor(vendorId);
 
                socket.emit('vendor_tracking_status', { 
                    vendorId, 
                    isTrackingActive,
                    timestamp: new Date() 
                });
            } catch (error) {
                socket.emit('socket_error', { action: 'check_vendor_tracking_status', message: error.message });
            }
        });

        /**
         * Explicitly pull a vendor's current location and online status.
         * Used by Admin/Users to see where a vendor is.
         */
        socket.on('get_vendor_location', async (data) => {
            try {
                const vendorId = stringifyId(data?.vendorId);
                if (!vendorId) throw new Error('Vendor ID is required');

                const Vendor = require('./models/Vendor.model');
                const vendor = await Vendor.findById(vendorId).select('liveLocation isOnline name');
                if (!vendor) throw new Error('Vendor not found');

                // Check activeVendors Map for real-time online status
                const isOnline = activeVendors.has(vendorId.toString());
                const coords = vendor.liveLocation?.coordinates || [0, 0];
                const exists = coords[0] !== 0 || coords[1] !== 0;

                socket.emit('vendor_location_data', {
                    vendorId: vendor._id,
                    name: vendor.name,
                    location: {
                        lng: coords[0],
                        lat: coords[1]
                    },
                    isOnline,
                    exists,
                    updatedAt: vendor.liveLocation?.updatedAt || null,
                    timestamp: new Date()
                });
            } catch (error) {
                socket.emit('socket_error', { action: 'get_vendor_location', message: error.message });
            }
        });

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
            console.log(`[SOCKET] Received 'vendor_accept_extra_services' event with data:`, JSON.stringify(data));
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
            console.log(`[SOCKET] Received 'vendor_reject_extra_services' event with data:`, JSON.stringify(data));
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
            console.log(`[SOCKET] Received 'user_confirm_extra_services' event with data:`, JSON.stringify(data));
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
            console.log(`[SOCKET] Received 'user_reject_extra_services' event with data:`, JSON.stringify(data));
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

        socket.on("booking_received_ack", (data) => {
            console.log("✅ Vendor ACK RECEIVED:", data);
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

        socket.on('disconnect', async (reason) => {
            console.log(`WebSocket Disconnected: ${socket.id}, reason: ${reason}, transport: ${socket.conn?.transport?.name || 'unknown'}`);

            // Broadcast disconnection to diagnostics room
            emitToDiagnostics('socket_connection_event', {
                type: 'disconnect',
                socketId: socket.id,
                reason,
                transport: socket.conn?.transport?.name || 'unknown',
                registeredAs: socket.vendorId ? `vendor:${socket.vendorId}` : (socket.userId ? `user:${socket.userId}` : 'anonymous'),
                timestamp: new Date()
            });

            // Remove socket from active list
            for (const [vendorId, sockets] of activeVendors.entries()) {
                const index = sockets.indexOf(socket.id);
                if (index !== -1) {
                    sockets.splice(index, 1);
                    console.log(`❌ Socket ${socket.id} removed from Vendor ${vendorId}. Remaining: ${sockets.length}`);
                    if (sockets.length === 0) {
                        console.log(`   Vendor ${vendorId} has 0 active sockets. Scheduling offline status update in 15 seconds.`);
                        
                        // Clear any existing timeout for this vendor just in case
                        if (pendingVendorDisconnects.has(vendorId)) {
                            clearTimeout(pendingVendorDisconnects.get(vendorId));
                        }
                        
                        const timeoutId = setTimeout(async () => {
                            pendingVendorDisconnects.delete(vendorId);
                            
                            // Double check if they are still at 0 sockets
                            const currentSockets = activeVendors.get(vendorId) || [];
                            if (currentSockets.length === 0) {
                                activeVendors.delete(vendorId);
                                console.log(`   Vendor ${vendorId} fully offline after grace period.`);
                                try {
                                    const Vendor = require('./models/Vendor.model');
                                    await Vendor.findByIdAndUpdate(vendorId, { isOnline: false });
                                    console.log(`🔴 Vendor ${vendorId} marked offline in DB`);
                                } catch (err) {
                                    console.error(`⚠️ Failed to update vendor ${vendorId} offline status:`, err.message);
                                }
                            } else {
                                console.log(`   Vendor ${vendorId} reconnected during grace period. Keeping online.`);
                            }
                        }, 15000); // 15 seconds grace period
                        
                        pendingVendorDisconnects.set(vendorId, timeoutId);
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
    const vIdStr = stringifyId(vendorId);
    const sockets = activeVendors.get(vIdStr) || [];

    console.log(`[SOCKET DEBUG] emitToVendor called: event='${event}', vendorId='${vIdStr}', stringified='${vIdStr}', matchedSockets=${sockets.length}, allRegisteredVendors=[${[...activeVendors.keys()].join(', ')}]`);

    // Copy to diagnostics room so the Socket Simulator page captures all system booking actions in real time
    if (['new_booking_request', 'booking_status_updated', 'booking_accepted_success', 'booking_rejected_success', 'booking_created_success', 'booking_search_update', 'service_approval_response', 'service_approval_update', 'extra_service_approval_update'].includes(event)) {
        io.to('diagnostics').emit(event, data);
        console.log(`📡 [DIAGNOSTICS] Forwarded copy of '${event}' to diagnostics room`);
    }

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
    const userIdStr = stringifyId(userId);
    const sockets = activeUsers.get(userIdStr) || [];

    console.log(`[SOCKET DEBUG] emitToUser called: event='${event}', userId='${userId}', stringified='${userIdStr}', matchedSockets=${sockets.length}, allRegisteredUsers=[${[...activeUsers.keys()].join(', ')}]`);

    // Copy to diagnostics room so the Socket Simulator page captures all system booking actions in real time
    if (['new_booking_request', 'booking_status_updated', 'booking_accepted_success', 'booking_rejected_success', 'booking_created_success', 'booking_search_update', 'service_approval_response', 'service_approval_update', 'extra_service_approval_update'].includes(event)) {
        io.to('diagnostics').emit(event, data);
        console.log(`📡 [DIAGNOSTICS] Forwarded copy of '${event}' to diagnostics room`);
    }
    
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
    const sockets = activeVendors.get(stringifyId(vendorId));
    return !!(sockets && sockets.length > 0);
};

// Helper to get a vendor's socket IDs
const getVendorSockets = (vendorId) => {
    return activeVendors.get(stringifyId(vendorId)) || [];
};

// Helper to check if a specific user is online
const isUserOnline = (userId) => {
    const sockets = activeUsers.get(stringifyId(userId));
    return sockets && sockets.length > 0;
};

// Helper to get a user's socket IDs
const getUserSockets = (userId) => {
    return activeUsers.get(stringifyId(userId)) || [];
};

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
