const { stringifyId } = require('../utils/stringifyId');
const { registerUserSocket } = require('../maps/user');

const registerUserHandlers = (io, socket) => {
    // Manual register_user (fallback for Postman / non-JWT connections)
    socket.on('register_user', (userId) => {
        const uId = stringifyId(userId);
        if (uId) {
            socket.userId = uId;
            registerUserSocket(io, uId, socket.id);
        }
    });

    socket.on('join_diagnostics', () => {
        socket.join('diagnostics');
        console.log(`[SOCKET] join_diagnostics — socket ${socket.id} joined diagnostics room`);
    });
};

module.exports = { registerUserHandlers };
