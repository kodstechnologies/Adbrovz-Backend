const crypto = require('crypto');
const mongoose = require('mongoose');
const Booking = require('../../models/Booking.model');
const { emitToUser, emitToVendor, isVendorOnline } = require('../../socket');
const notificationService = require('../notification/notification.service');
const { getSearchWaveConfig, buildSearchTimingPayload, buildBookingSocketRef } = require('./helpers/search.config');
const { buildNewBookingRequestPayload } = require('./helpers/booking.payload');
const { findEligibleVendors } = require('./helpers/vendor.query');

const LOG = '[BOOKING-SEARCH]';

const ensureSearchId = async (booking) => {
    if (booking.searchId) return booking.searchId;
    booking.searchId = crypto.randomUUID();
    await booking.save();
    console.log(`${LOG} Generated searchId: ${booking.searchId} for booking ${booking._id}`);
    return booking.searchId;
};

const emitSearchFailed = (booking, message) => {
    emitToUser(booking.user, 'booking_search_update', {
        ...buildBookingSocketRef(booking),
        status: 'failed',
        message
    });
};

const notifyVendor = async (vendor, booking, payload, populatedBooking) => {
    const vendorIdStr = vendor._id.toString();
    const online = isVendorOnline(vendorIdStr);
    let notified = false;

    console.log(`${LOG} Notify check → vendor=${vendorIdStr} name=${vendor.name || 'n/a'} socketOnline=${online} hasFcm=${!!vendor.fcmToken}`);

    if (online) {
        emitToVendor(vendorIdStr, 'new_booking_request', payload);
        notified = true;
        console.log(`${LOG} SELECTED: Socket → vendor ${vendorIdStr} (new_booking_request)`);
    } else {
        console.log(`${LOG} SELECTED: Socket SKIP — vendor ${vendorIdStr} NOT in activeVendors map (app socket not connected)`);
    }

    if (vendor.fcmToken) {
        const fcmData = {
            type: 'new_booking_request',
            bookingId: payload.id || booking._id?.toString() || '',
            bookingID: payload.bookingID || '',
            address: payload.location?.address || '',
            booking_data: JSON.stringify(payload)
        };

        try {
            await notificationService.createNotification({
                user: vendor._id,
                userModel: 'Vendor',
                type: 'new_booking',
                title: 'New Booking Request',
                body: `You have a new booking request for ${populatedBooking.category?.title || 'a service'} nearby.`,
                data: fcmData,
                sendPush: true,
                fcmToken: vendor.fcmToken
            });
            notified = true;
            console.log(`${LOG} SELECTED: FCM → vendor ${vendorIdStr}`);
        } catch (err) {
            console.error(`${LOG} FCM failed for vendor ${vendorIdStr}:`, err.message);
        }
    } else if (!online) {
        console.log(`${LOG} Vendor ${vendorIdStr} unreachable (no socket, no FCM)`);
    }

    return notified ? vendor._id : null;
};

const broadcastToVendors = async (booking, vendors, radiusInKm) => {
    const freshBooking = await Booking.findById(booking._id).select('status');
    if (!freshBooking || freshBooking.status !== 'pending_acceptance') {
        console.log(`${LOG} Broadcast aborted — booking ${booking._id} status: ${freshBooking?.status}`);
        return { broadcastCount: 0, notifiedIds: [] };
    }

    const populatedBooking = await Booking.findById(booking._id)
        .populate('services.service', 'title serviceCharge photo approxCompletionTime')
        .populate('category', 'title name')
        .populate('user', 'name phoneNumber photo');

    const payload = buildNewBookingRequestPayload(populatedBooking, radiusInKm);
    const results = await Promise.all(
        vendors.map((vendor) => notifyVendor(vendor, booking, payload, populatedBooking))
    );
    const notifiedIds = results.filter(Boolean);

    if (notifiedIds.length > 0) {
        await Booking.findByIdAndUpdate(booking._id, {
            $addToSet: { notifiedVendors: { $each: notifiedIds } }
        });
    }

    return { broadcastCount: notifiedIds.length, notifiedIds };
};

const emitSearchingUpdate = (booking, { radiusInKm, broadcastCount, matchedCount, waves, totalSearchTimeMins, searchId, retryCount }) => {
    emitToUser(booking.user, 'booking_search_update', {
        ...buildBookingSocketRef(booking),
        status: 'searching',
        radius: radiusInKm,
        vendorCount: broadcastCount,
        matchedVendorCount: matchedCount,
        ...buildSearchTimingPayload({ searchId, retryCount, waves, totalSearchTimeMins }),
        message: matchedCount === 0
            ? `No matching vendors found within ${radiusInKm}km. Expanding search...`
            : broadcastCount > 0
                ? `Searching in ${radiusInKm}km radius... notified ${broadcastCount} vendor(s).`
                : `Found ${matchedCount} nearby vendor(s) but none could be reached. Retrying...`
    });
};
const scheduleNextWave = (booking, currentSearchId, retryCount, waves) => {
    const delayMins = waves[retryCount].mins > 0 ? waves[retryCount].mins : 5;
    console.log(`${LOG} Scheduling wave ${retryCount + 2} in ${delayMins} min (booking ${booking._id})`);

    setTimeout(async () => {
        const current = await Booking.findById(booking._id);
        if (!current || current.status !== 'pending_acceptance' || current.searchId !== currentSearchId) {
            console.log(`${LOG} Wave ${retryCount + 2} skipped for booking ${booking._id}`);
            return;
        }
        current.retryCount = (current.retryCount || 0) + 1;
        await current.save();
        searchVendors(current, true, true).catch(console.error);
    }, delayMins * 60 * 1000);
};

const scheduleHardStop = (booking, currentSearchId, retryCount, waves, totalSearchTimeMins) => {
    const finalWaitMins = waves[retryCount].mins > 0 ? waves[retryCount].mins : 2;
    const maxRadiusKm = waves[waves.length - 1].km;
    console.log(`${LOG} Hard-stop in ${finalWaitMins} min for booking ${booking._id}`);

    setTimeout(async () => {
        const current = await Booking.findById(booking._id);
        if (!current || current.status !== 'pending_acceptance' || current.searchId !== currentSearchId) {
            return;
        }

        emitToUser(current.user, 'booking_search_update', {
            ...buildBookingSocketRef(current),
            status: 'search_completed_no_vendors',
            message: `Could not find any vendors within ${maxRadiusKm}km after ${totalSearchTimeMins} minutes of searching. Please try again manually.`,
            searchCompleted: true,
            ...buildSearchTimingPayload({
                searchId: current.searchId,
                retryCount,
                waves,
                totalSearchTimeMins
            }),
            remainingSearchTimeMins: 0
        });
        console.log(`${LOG} Hard-stop completed for booking ${booking._id}`);
    }, finalWaitMins * 60 * 1000);
};

/**
 * Core vendor discovery + optional broadcast with wave expansion.
 * @param {Object} booking - Mongoose booking document
 * @param {boolean} broadcast - Notify vendors and user via socket/FCM
 * @param {boolean} scheduleWaves - Schedule next wave / hard-stop timers
 */
const searchVendors = async (booking, broadcast = false, scheduleWaves = true) => {
    if (booking.status !== 'pending_acceptance') return [];

    const currentSearchId = await ensureSearchId(booking);

    if (!booking.location?.latitude || !booking.location?.longitude) {
        console.error(`${LOG} Missing coordinates for booking ${booking._id}`);
        if (broadcast) emitSearchFailed(booking, 'Vendor search failed: Missing location coordinates.');
        return [];
    }

    const retryCount = booking.retryCount || 0;
    const { waves, totalSearchTimeMins } = await getSearchWaveConfig();
    const currentWave = waves[Math.min(retryCount, waves.length - 1)];
    const radiusInKm = currentWave.km;

    console.log(`${LOG} Wave ${retryCount + 1}/${waves.length} | radius=${radiusInKm}km | booking=${booking._id}`);

    const { vendors } = await findEligibleVendors(booking, radiusInKm);
    console.log(`${LOG} Matched ${vendors.length} eligible vendor(s)`);
    const { activeVendors } = require('../../socket');
    console.log(`👷 Online vendors (${activeVendors.size}): [${[...activeVendors.keys()].join(', ') || 'none'}]`);

    if (broadcast) {
        try {
            const { broadcastCount } = await broadcastToVendors(booking, vendors, radiusInKm);
            emitSearchingUpdate(booking, {
                radiusInKm,
                broadcastCount,
                matchedCount: vendors.length,
                waves,
                totalSearchTimeMins,
                searchId: currentSearchId,
                retryCount
            });

            if (scheduleWaves) {
                if (retryCount < waves.length - 1) {
                    scheduleNextWave(booking, currentSearchId, retryCount, waves);
                } else if (retryCount === waves.length - 1) {
                    scheduleHardStop(booking, currentSearchId, retryCount, waves, totalSearchTimeMins);
                }
            }
        } catch (error) {
            console.error(`${LOG} Broadcast error:`, error.message);
        }
    }

    return vendors.map((v) => ({ vendorId: v._id }));
};

/**
 * Re-send pending booking requests when a vendor reconnects.
 */
const resendActiveRequestsToVendor = async (vendorId) => {
    try {
        const vIdStr = vendorId.toString();
        const vendorIdObj = new mongoose.Types.ObjectId(vIdStr);

        const activeBookings = await Booking.find({
            status: 'pending_acceptance',
            notifiedVendors: vendorIdObj,
            rejectedVendors: { $nin: [vendorIdObj] },
            laterVendors: { $nin: [vendorIdObj] }
        })
            .populate('services.service', 'title serviceCharge photo approxCompletionTime')
            .populate('category', 'title name')
            .populate('user', 'name phoneNumber photo');

        if (!activeBookings.length) return 0;

        const { waves } = await getSearchWaveConfig();
        const radii = waves.map((w) => w.km);

        for (const booking of activeBookings) {
            const retryCount = booking.retryCount || 0;
            const radiusInKm = radii[Math.min(retryCount, radii.length - 1)];
            const payload = buildNewBookingRequestPayload(booking, radiusInKm);
            emitToVendor(vIdStr, 'new_booking_request', payload);
            console.log(`${LOG} Re-sent booking ${booking._id} to vendor ${vIdStr}`);
        }

        return activeBookings.length;
    } catch (error) {
        console.error(`${LOG} resendActiveRequestsToVendor error:`, error.message);
        return 0;
    }
};

/**
 * Re-send search progress when a user reconnects during vendor matching.
 */
const resendActiveSearchToUser = async (userId) => {
    try {
        const uIdStr = userId.toString();
        const booking = await Booking.findOne({
            user: uIdStr,
            status: 'pending_acceptance'
        }).sort({ createdAt: -1 });

        if (!booking) return false;

        const { waves, totalSearchTimeMins } = await getSearchWaveConfig();
        emitToUser(uIdStr, 'booking_search_update', {
            ...buildBookingSocketRef(booking),
            status: 'searching',
            message: 'Reconnected — vendor search still in progress.',
            searchCompleted: false,
            ...buildSearchTimingPayload({
                searchId: booking.searchId,
                retryCount: booking.retryCount || 0,
                waves,
                totalSearchTimeMins
            })
        });
        console.log(`${LOG} Re-sent search state for booking ${booking._id} to user ${uIdStr}`);
        return true;
    } catch (error) {
        console.error(`${LOG} resendActiveSearchToUser error:`, error.message);
        return false;
    }
};

/**
 * REST fallback: incoming requests for vendor app when socket is disconnected.
 */
const getVendorIncomingRequests = async (vendorId) => {
    const vendorIdObj = new mongoose.Types.ObjectId(vendorId);
    const { waves } = await getSearchWaveConfig();

    const bookings = await Booking.find({
        status: 'pending_acceptance',
        notifiedVendors: vendorIdObj,
        rejectedVendors: { $nin: [vendorIdObj] },
        laterVendors: { $nin: [vendorIdObj] }
    })
        .select('-rejectedVendors -laterVendors')
        .populate('services.service', 'title serviceCharge photo approxCompletionTime')
        .populate('category', 'title name icon')
        .populate('user', 'name phoneNumber photo')
        .sort({ createdAt: -1 });

    return bookings.map((booking) => {
        const retryCount = booking.retryCount || 0;
        const radiusInKm = waves[Math.min(retryCount, waves.length - 1)].km;
        return buildNewBookingRequestPayload(booking, radiusInKm);
    });
};

module.exports = {
    searchVendors,
    resendActiveRequestsToVendor,
    resendActiveSearchToUser,
    getVendorIncomingRequests,
    getSearchWaveConfig,
    buildSearchTimingPayload,
    buildBookingSocketRef,
    buildNewBookingRequestPayload
};
