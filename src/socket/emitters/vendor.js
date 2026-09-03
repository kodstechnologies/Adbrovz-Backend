const { stringifyId } = require('../utils/stringifyId');
const { activeVendors } = require('../maps/vendor');
const { DIAGNOSTICS_EVENTS } = require('./diagnostics');

let io;
const setIo = (ioInstance) => { io = ioInstance; };

const emitToVendor = (vendorId, event, data) => {
    if (!io) {
        console.warn(`[EMIT-VENDOR] Socket.io not initialized — STOP`);
        return;
    }
    console.log(`🧑‍🔧 Total active vendors: ${activeVendors.size}`);
    console.log(`🧑‍🔧 Active vendor IDs:`, [...activeVendors.keys()]);
    const vIdStr = stringifyId(vendorId);
    const sockets = activeVendors.get(vIdStr) || [];

    console.log(`[EMIT-VENDOR] event='${event}' | vendor=${vIdStr} | sockets=${sockets.length}`);
    console.log(`👷 Online vendors (${activeVendors.size}): [${[...activeVendors.keys()].join(', ') || 'none'}]`);

    if (DIAGNOSTICS_EVENTS.has(event)) {
        io.to('diagnostics').emit(event, data);
    }

    if (sockets.length === 0) {
        console.warn(`[EMIT-VENDOR] No active sockets for Vendor ${vIdStr}. Event '${event}' NOT sent.`);
        return;
    }

    sockets.forEach(socketId => io.to(socketId).emit(event, data));
    console.log(`[EMIT-VENDOR] Emitted '${event}' to Vendor ${vIdStr}`);
};

const isVendorOnline = (vendorId) => {
    const sockets = activeVendors.get(stringifyId(vendorId));
    return !!(sockets && sockets.length > 0);
};

const getVendorSockets = (vendorId) => {
    return activeVendors.get(stringifyId(vendorId)) || [];
};

module.exports = { emitToVendor, isVendorOnline, getVendorSockets, setIo };
