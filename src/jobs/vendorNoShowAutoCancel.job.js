const cron = require('node-cron');
const Booking = require('../models/Booking.model');
const User = require('../models/User.model');
const Vendor = require('../models/Vendor.model');
const { createNotification } = require('../modules/notification/notification.service');
const { getIo } = require('../socket');

/**
 * Job to auto-cancel bookings when the vendor does not arrive within the grace period.
 * Runs every 5 minutes to check for expired grace periods.
 */
const initVendorNoShowAutoCancelJob = () => {
    // Schedule to run every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
        console.log('[CRON] Running Vendor No-Show Auto-Cancel Job...');
        try {
            const now = new Date();

            // Find bookings where vendor has not arrived and grace period has expired
            const bookingsToCancel = await Booking.find({
                status: { $in: ['pending', 'on_the_way'] },
                gracePeriodEnd: { $lt: now },
                vendor: { $exists: true, $ne: null }
            }).populate('user').populate('vendor');

            if (bookingsToCancel.length > 0) {
                console.log(`[CRON] Found ${bookingsToCancel.length} bookings to auto-cancel for vendor no-show.`);

                for (const booking of bookingsToCancel) {
                    const previousStatus = booking.status;
                    booking.status = 'auto_cancelled';
                    booking.statusHistory.push({
                        status: 'auto_cancelled',
                        actor: 'system',
                        reason: 'Vendor did not arrive within the allowed grace period',
                        timestamp: now
                    });
                    booking.markModified('statusHistory');
                    booking.cancellation = {
                        cancelledBy: 'system',
                        reason: 'Vendor did not arrive within the allowed grace period',
                        cancelledAt: now,
                        travelChargeApplied: false
                    };

                    await booking.save();
                    console.log(`[CRON] Auto-cancelled booking ${booking._id} due to vendor no-show.`);

                    // Emit socket events
                    const io = getIo();
                    if (io) {
                        const userPayload = {
                            bookingId: booking._id,
                            status: 'auto_cancelled',
                            reason: 'Auto Cancelled - Vendor Did Not Arrive',
                            previousStatus: previousStatus,
                            timestamp: now
                        };
                        const vendorPayload = {
                            bookingId: booking._id,
                            status: 'auto_cancelled',
                            reason: 'Auto Cancelled - Vendor Did Not Arrive',
                            previousStatus: previousStatus,
                            timestamp: now
                        };

                        io.to(`user_${booking.user._id}`).emit('booking_auto_cancelled', userPayload);
                        io.to(`vendor_${booking.vendor._id}`).emit('booking_auto_cancelled', vendorPayload);
                    }

                    // Send push notification to user
                    if (booking.user && booking.user.fcmToken) {
                        await createNotification({
                            user: booking.user._id,
                            userModel: 'User',
                            type: 'booking_auto_cancelled',
                            title: 'Booking Auto Cancelled',
                            body: 'Your booking has been automatically cancelled because the vendor did not arrive within the scheduled time and grace period.',
                            data: {
                                bookingId: booking._id.toString(),
                                status: 'auto_cancelled',
                                reason: 'Auto Cancelled - Vendor Did Not Arrive'
                            },
                            sendPush: true,
                            fcmToken: booking.user.fcmToken
                        });
                    }

                    // Send push notification to vendor
                    if (booking.vendor && booking.vendor.fcmToken) {
                        await createNotification({
                            user: booking.vendor._id,
                            userModel: 'Vendor',
                            type: 'booking_auto_cancelled',
                            title: 'Booking Auto Cancelled',
                            body: 'This booking has been automatically cancelled because you did not arrive within the scheduled time and grace period.',
                            data: {
                                bookingId: booking._id.toString(),
                                status: 'auto_cancelled',
                                reason: 'Auto Cancelled - Vendor Did Not Arrive'
                            },
                            sendPush: true,
                            fcmToken: booking.vendor.fcmToken
                        });
                    }
                }
            }
        } catch (error) {
            console.error('[CRON] Error in Vendor No-Show Auto-Cancel Job:', error);
        }
    });

    console.log('✅ Vendor No-Show Auto-Cancel Job initialized.');
};

module.exports = { initVendorNoShowAutoCancelJob };
