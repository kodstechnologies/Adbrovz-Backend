const { Server } = require('socket.io');
const config = require('../config/env');

const { setIo: setDiagnosticsIo, emitToDiagnostics } = require('./emitters/diagnostics');
const { setIo: setVendorEmitterIo } = require('./emitters/vendor');
const { setIo: setUserEmitterIo } = require('./emitters/user');

const { activeVendors, pendingVendorDisconnects } = require('./maps/vendor');
const { activeUsers } = require('./maps/user');

const { handleAuthOnConnect } = require('./auth');
const { registerVendorHandlers } = require('./handlers/vendor');
const { registerUserHandlers } = require('./handlers/user');
const { registerBookingHandlers } = require('./handlers/booking');
const { registerLocationHandlers } = require('./handlers/location');
const { registerExtraServicesHandlers } = require('./handlers/extraServices');
const { registerVerificationHandlers } = require('./handlers/verification');

let io;

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
        pingTimeout: 200000,
        pingInterval: 25000,
        connectTimeout: 60000,
        allowEIO3: true,
        maxHttpBufferSize: 1e7
    });

    // Share io instance with all emitters
    setDiagnosticsIo(io);
    setVendorEmitterIo(io);
    setUserEmitterIo(io);

    io.engine.on('connection_error', (err) => {
        console.error(`[SOCKET ENGINE ERROR] Code: ${err.code}, Message: ${err.message}, URL: ${err.req?.url}`);
    });

    io.on('connection', (socket) => {
        const transport = socket.conn.transport.name;
        console.log(`[SOCKET-CONNECT] socketId=${socket.id} | transport=${transport} | ip=${socket.handshake.address}`);

        emitToDiagnostics('socket_connection_event', {
            type: 'connect',
            socketId: socket.id,
            transport,
            ip: socket.handshake.address,
            timestamp: new Date()
        });

        socket.conn.on('upgrade', () => {
            console.log(`[SOCKET-CONNECT] [UPGRADE] Socket ${socket.id} → ${socket.conn.transport.name}`);
        });

        socket.conn.on('close', (reason) => {
            console.log(`[SOCKET-CONNECT] [ENGINE CLOSE] Socket ${socket.id}. Reason: ${reason}`);
        });

        socket.conn.on('error', (err) => {
            console.error(`[SOCKET-CONNECT] [ENGINE ERROR] Socket ${socket.id}:`, err);
        });

        // Log auth state for debugging
        const hasAuthToken = !!socket.handshake.auth?.token;
        const hasQueryToken = !!socket.handshake.query?.token;
        console.log(`[SOCKET-CONNECT] auth.token=${hasAuthToken} | query.token=${hasQueryToken} | headers.authorization=${!!socket.handshake.headers?.authorization}`);

        // JWT auto-registration
        handleAuthOnConnect(io, socket);

        // Register all event handlers
        registerVendorHandlers(io, socket);
        registerUserHandlers(io, socket);
        registerBookingHandlers(io, socket);
        registerLocationHandlers(io, socket);
        registerExtraServicesHandlers(io, socket);
        registerVerificationHandlers(io, socket);

        // Disconnect cleanup
        socket.on('disconnect', async (reason) => {
            console.log(`WebSocket Disconnected: ${socket.id}, reason: ${reason}`);

            emitToDiagnostics('socket_connection_event', {
                type: 'disconnect',
                socketId: socket.id,
                reason,
                transport: socket.conn?.transport?.name || 'unknown',
                registeredAs: socket.vendorId ? `vendor:${socket.vendorId}` : (socket.userId ? `user:${socket.userId}` : 'anonymous'),
                timestamp: new Date()
            });

            // Vendor cleanup with 15s grace period
            for (const [vendorId, sockets] of activeVendors.entries()) {
                const index = sockets.indexOf(socket.id);
                if (index !== -1) {
                    sockets.splice(index, 1);
                    console.log(`❌ Socket ${socket.id} removed from Vendor ${vendorId}. Remaining: ${sockets.length}`);
                    if (sockets.length === 0) {
                        if (pendingVendorDisconnects.has(vendorId)) {
                            clearTimeout(pendingVendorDisconnects.get(vendorId));
                        }
                        const timeoutId = setTimeout(async () => {
                            pendingVendorDisconnects.delete(vendorId);
                            const currentSockets = activeVendors.get(vendorId) || [];
                            if (currentSockets.length === 0) {
                                activeVendors.delete(vendorId);
                                try {
                                    const Vendor = require('../models/Vendor.model');
                                    await Vendor.findByIdAndUpdate(vendorId, { isOnline: false });
                                    console.log(`🔴 Vendor ${vendorId} marked offline in DB`);
                                    console.log(`👷 Online vendors (${activeVendors.size}): [${[...activeVendors.keys()].join(', ') || 'none'}]`);
                                } catch (err) {
                                    console.error(`⚠️ Failed to update vendor ${vendorId} offline status:`, err.message);
                                }
                            }
                        }, 15000);
                        pendingVendorDisconnects.set(vendorId, timeoutId);
                    }
                    break;
                }
            }

            // User cleanup
            for (const [userId, sockets] of activeUsers.entries()) {
                const index = sockets.indexOf(socket.id);
                if (index !== -1) {
                    sockets.splice(index, 1);
                    console.log(`❌ Socket ${socket.id} removed from User ${userId}. Remaining: ${sockets.length}`);
                    if (sockets.length === 0) activeUsers.delete(userId);
                    break;
                }
            }
        });
    });

    return io;
};

const getIo = () => {
    if (!io) throw new Error('Socket.io not initialized');
    return io;
};

// Re-export emitter helpers so existing consumers don't need to change imports
const { emitToVendor, isVendorOnline, getVendorSockets } = require('./emitters/vendor');
const { emitToUser, isUserOnline, getUserSockets } = require('./emitters/user');

module.exports = {
    initSocket,
    getIo,
    emitToVendor,
    emitToUser,
    emitToDiagnostics,
    isVendorOnline,
    getVendorSockets,
    isUserOnline,
    getUserSockets,
    activeVendors,
    activeUsers
};
