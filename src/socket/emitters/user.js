const { stringifyId } = require('../utils/stringifyId');
const { activeUsers } = require('../maps/user');
const { DIAGNOSTICS_EVENTS } = require('./diagnostics');

let io;
const setIo = (ioInstance) => { io = ioInstance; };

const emitToUser = (userId, event, data) => {
    if (!io) {
        console.warn(`[EMIT-USER] Socket.io not initialized — STOP`);
        return;
    }
 console.log(`👥 Total active users: ${activeUsers.size}`);
    console.log(`👥 Active user IDs:`, [...activeUsers.keys()]);

    const userIdStr = stringifyId(userId);
    const sockets = activeUsers.get(userIdStr) || [];

    console.log(`[EMIT-USER] event='${event}' | user=${userIdStr} | sockets=${sockets.length}`);

    if (DIAGNOSTICS_EVENTS.has(event)) {
        io.to('diagnostics').emit(event, data);
    }

    if (sockets.length === 0) {
        console.log(`[EMIT-USER] No active sockets for User ${userIdStr}. Event '${event}' NOT sent.`);
        return;
    }

    sockets.forEach(socketId => io.to(socketId).emit(event, data));
    console.log(`[EMIT-USER] Emitted '${event}' to User ${userIdStr}`);
};

const isUserOnline = (userId) => {
    const sockets = activeUsers.get(stringifyId(userId));
    return sockets && sockets.length > 0;
};

const getUserSockets = (userId) => {
    return activeUsers.get(stringifyId(userId)) || [];
};

module.exports = { emitToUser, isUserOnline, getUserSockets, setIo };
