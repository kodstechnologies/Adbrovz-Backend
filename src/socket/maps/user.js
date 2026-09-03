const { stringifyId } = require('../utils/stringifyId');
const { emitToDiagnostics } = require('../emitters/diagnostics');

const activeUsers = new Map(); // userId -> [socketId1, socketId2, ...]

const removeSocketFromUserMap = (entityId, socketId) => {
    const id = stringifyId(entityId);
    const sockets = activeUsers.get(id);
    if (!sockets) return;
    const index = sockets.indexOf(socketId);
    if (index !== -1) sockets.splice(index, 1);
    if (sockets.length === 0) activeUsers.delete(id);
};

const unregisterUserSocket = (userId, socketId) => {
    removeSocketFromUserMap(userId, socketId);
};

const registerUserSocket = async (io, userId, socketId) => {
    console.log(`[SOCKET-USER] Start registerUserSocket | userId: ${userId} | socketId: ${socketId}`);

    const uId = stringifyId(userId);
    if (!uId || uId === '[object Object]') {
        console.error(`[SOCKET-USER] Invalid user ID — STOP. Raw:`, userId);
        return;
    }

    if (!activeUsers.has(uId)) activeUsers.set(uId, []);
    const sockets = activeUsers.get(uId);
    if (!sockets.includes(socketId)) sockets.push(socketId);

    console.log(`[SOCKET-USER] User ${uId} registered | sockets=${sockets.length}`);
    console.log('👥 ===============================');
    console.log('👥 ACTIVE USERS');
    console.log('👥 Total users:', activeUsers.size);

    for (const [userId, sockets] of activeUsers.entries()) {
        console.log(`   User: ${userId} | Sockets: ${sockets.length}`);
    }

    console.log('👥 ===============================');
    emitToDiagnostics('socket_registration_event', { socketId, role: 'user', id: uId, timestamp: new Date() });

    try {
        const bookingSearch = require('../../modules/booking/booking.search');
        const searchActive = await bookingSearch.resendActiveSearchToUser(uId);
        io.to(socketId).emit('socket_connected', {
            role: 'user',
            userId: uId,
            searchActive,
            message: searchActive ? 'Reconnected — vendor search still in progress' : 'Socket connected successfully'
        });
    } catch (resendErr) {
        console.error(`[SOCKET-USER] Resend failed:`, resendErr.message);
        io.to(socketId).emit('socket_connected', { role: 'user', userId: uId, searchActive: false, message: 'Socket connected successfully' });
    }
};

module.exports = { activeUsers, registerUserSocket, unregisterUserSocket };
