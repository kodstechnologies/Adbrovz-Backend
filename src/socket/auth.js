const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { stringifyId } = require('./utils/stringifyId');
const { registerVendorSocket } = require('./maps/vendor');
const { registerUserSocket } = require('./maps/user');

const handleAuthOnConnect = (io, socket) => {
    // ── Dump full handshake so we can see what the app is actually sending ──
    console.log(`[SOCKET-AUTH] ── Handshake dump for ${socket.id} ──`);
    console.log(`[SOCKET-AUTH] auth:`, JSON.stringify(socket.handshake.auth));
    console.log(`[SOCKET-AUTH] query:`, JSON.stringify(socket.handshake.query));
    console.log(`[SOCKET-AUTH] headers.authorization:`, socket.handshake.headers?.authorization || 'none');

    const authHeader = socket.handshake.headers?.authorization;
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const token = socket.handshake.auth?.token || socket.handshake.query?.token || headerToken;

    if (!token) {
        console.log(`[SOCKET-AUTH] ⚠️  No token found in auth / query / Authorization header — socket will stay anonymous until manual register_user / register_vendor`);
        return;
    }

    console.log(`[SOCKET-AUTH] ✅ Token found — verifying...`);

    try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        console.log(`[SOCKET-AUTH] Decoded token:`, JSON.stringify(decoded));
        const role = decoded.role;
        const id = stringifyId(decoded.userId || decoded.id || decoded._id);

        if (!id) {
            console.log(`[SOCKET-AUTH] No valid ID in token — skip auto-register`);
            return;
        }

        if (role === 'vendor') {
            socket.vendorId = id;
            registerVendorSocket(io, id, socket.id).catch((err) => {
                console.error(`[SOCKET-AUTH] Vendor registration failed for ${id}:`, err.message);
            });
        } else if (role === 'user') {
            socket.userId = id;
            registerUserSocket(io, id, socket.id).catch((err) => {
                console.error(`[SOCKET-AUTH] User registration failed for ${id}:`, err.message);
            });
        } else {
            console.log(`[SOCKET-AUTH] Unknown role="${role}" — skip auto-register`);
        }
    } catch (err) {
        console.log(`[SOCKET-AUTH] JWT verify failed: ${err.message}`);
        socket.emit('auth_error', { message: 'Token expired or invalid. Please re-authenticate.', code: 'TOKEN_INVALID' });
    }
};

module.exports = { handleAuthOnConnect };
