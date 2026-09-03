const { stringifyId } = require('../utils/stringifyId');
const { emitToDiagnostics } = require('../emitters/diagnostics');

const activeVendors = new Map(); // vendorId -> [socketId1, socketId2, ...]
const pendingVendorDisconnects = new Map(); // vendorId -> setTimeout ID

const removeSocketFromVendorMap = (entityId, socketId) => {
    const id = stringifyId(entityId);
    const sockets = activeVendors.get(id);
    if (!sockets) return;
    const index = sockets.indexOf(socketId);
    if (index !== -1) sockets.splice(index, 1);
    if (sockets.length === 0) activeVendors.delete(id);
};

const unregisterVendorSocket = (vendorId, socketId) => {
    removeSocketFromVendorMap(vendorId, socketId);
};

const registerVendorSocket = async (io, vendorId, socketId) => {
    console.log("\n================ VENDOR REGISTRATION ================");
    console.log("📥 vendorId:", vendorId);
    console.log("🔌 socketId:", socketId);

    const vId = stringifyId(vendorId);
    if (!vId || vId === '[object Object]') {
        console.error(`[SOCKET-VENDOR] Invalid vendor ID — STOP. Raw:`, vendorId);
        return;
    }

    if (pendingVendorDisconnects.has(vId)) {
        clearTimeout(pendingVendorDisconnects.get(vId));
        pendingVendorDisconnects.delete(vId);
    }

    if (!activeVendors.has(vId)) activeVendors.set(vId, []);
    const sockets = activeVendors.get(vId);
    if (!sockets.includes(socketId)) sockets.push(socketId);

    console.log(`🟢 VENDOR REGISTERED | id=${vId} | sockets=${sockets.length}`);
    console.log(`👷 Online vendors (${activeVendors.size}): [${[...activeVendors.keys()].join(', ') || 'none'}]`);

    emitToDiagnostics('socket_registration_event', { socketId, role: 'vendor', id: vId, timestamp: new Date() });

    try {
        const Vendor = require('../../models/Vendor.model');
        const vendor = await Vendor.findById(vId).select('isVerified isSuspended isBlocked isLocked registrationStep membership.expiryDate serviceRenewal.expiryDate');

        if (!vendor) {
            console.error(`[SOCKET-VENDOR] Vendor not found in DB — STOP`);
            return;
        }

        const isMembershipExpired = vendor.membership?.expiryDate && new Date(vendor.membership.expiryDate) < new Date();
        const isServiceExpired = vendor.serviceRenewal?.expiryDate && new Date(vendor.serviceRenewal.expiryDate) < new Date();
        const isRegistrationEligible = ['MEMBERSHIP_PAID', 'PLAN_PAID', 'COMPLETED'].includes(vendor.registrationStep);

        if (!vendor.isVerified || vendor.isSuspended || vendor.isBlocked || vendor.isLocked || !isRegistrationEligible) {
            unregisterVendorSocket(vId, socketId);
            await Vendor.findByIdAndUpdate(vId, { isOnline: false });
            io.to(socketId).emit('online_denied', {
                message: 'Your account is not eligible to go online. Please complete your membership or resolve account issues.'
            });
            return;
        }

        if (isMembershipExpired || isServiceExpired) {
            unregisterVendorSocket(vId, socketId);
            await Vendor.findByIdAndUpdate(vId, { isOnline: false });
            io.to(socketId).emit('membership_expired_error', {
                message: 'Your membership or service has expired. Please renew to go online.',
                expiryDate: vendor.membership?.expiryDate || vendor.serviceRenewal?.expiryDate
            });
            return;
        }

        await Vendor.findByIdAndUpdate(vId, { isOnline: true });

        try {
            const bookingSearch = require('../../modules/booking/booking.search');
            const pendingCount = await bookingSearch.resendActiveRequestsToVendor(vId);
            io.to(socketId).emit('socket_connected', {
                role: 'vendor',
                vendorId: vId,
                pendingIncomingCount: pendingCount,
                message: pendingCount > 0 ? `${pendingCount} incoming booking request(s) waiting` : 'Socket connected successfully'
            });
        } catch (resendErr) {
            console.error(`[SOCKET-VENDOR] Resend failed:`, resendErr.message);
            io.to(socketId).emit('socket_connected', { role: 'vendor', vendorId: vId, pendingIncomingCount: 0, message: 'Socket connected successfully' });
        }
    } catch (err) {
        console.error(`[SOCKET-VENDOR] Failed to update vendor ${vId} online status:`, err.message);
    }
};

module.exports = { activeVendors, pendingVendorDisconnects, registerVendorSocket, unregisterVendorSocket };
