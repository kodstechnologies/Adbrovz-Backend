const cron = require('node-cron');
const Booking = require('../models/Booking.model');

/**
 * Job to auto-cancel bookings that have been pending for more than 24 hours.
 * Runs every hour.
 */
const initAutoCancelJob = () => {
    // Schedule to run every hour
    cron.schedule('0 * * * *', async () => {
        console.log('[CRON] Running Booking Auto-Cancel Job...');
        try {
            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

            // Find bookings that are 'pending_acceptance' or 'pending' and older than 24 hours
            const bookingsToCancel = await Booking.find({
                status: { $in: ['pending_acceptance', 'pending'] },
                createdAt: { $lt: twentyFourHoursAgo }
            });

            if (bookingsToCancel.length > 0) {
                console.log(`[CRON] Found ${bookingsToCancel.length} bookings to auto-cancel.`);
                
                for (const booking of bookingsToCancel) {
                    booking.status = 'cancelled';
                    booking.cancellation = {
                        cancelledBy: 'system',
                        reason: 'Auto-cancelled after 24 hours of inactivity.',
                        cancelledAt: new Date()
                    };
                    booking.statusHistory.push({
                        status: 'cancelled',
                        actor: 'system',
                        reason: 'Auto-cancelled after 24 hours of inactivity.',
                        timestamp: new Date()
                    });
                    await booking.save();
                    console.log(`[CRON] Auto-cancelled booking: ${booking._id}`);
                }
            }
        } catch (error) {
            console.error('[CRON] Error in Booking Auto-Cancel Job:', error);
        }
    });

    console.log('✅ Booking Auto-Cancel Job initialized.');
};

module.exports = { initAutoCancelJob };
