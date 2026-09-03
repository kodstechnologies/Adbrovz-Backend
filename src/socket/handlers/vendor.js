const { stringifyId } = require('../utils/stringifyId');
const { registerVendorSocket } = require('../maps/vendor');

const registerVendorHandlers = (io, socket) => {
    // Manual register_vendor (fallback for Postman / non-JWT connections)
    socket.on('register_vendor', (vendorId) => {
        const vId = stringifyId(vendorId);
        if (vId) {
            socket.vendorId = vId;
            registerVendorSocket(io, vId, socket.id);
        }
    });
};

module.exports = { registerVendorHandlers };
