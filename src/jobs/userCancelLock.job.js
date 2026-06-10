const cron = require('node-cron');
const User = require('../models/User.model');
const { sendPush } = require('../utils/pushNotification');

/**
 * Job to auto-unlock users after their cancellation lock period has expired.
 * Runs every 15 minutes to check for users whose lock has expired.
 */
const initUserCancelLockJob = () => {
    // Schedule to run every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
        console.log('[CRON] Running User Cancel Lock Check Job...');
        try {
            const now = new Date();

            // Find users whose lock has expired
            const usersToUnlock = await User.find({
                cancelLockUntil: { $lt: now, $exists: true }
            });

            if (usersToUnlock.length > 0) {
                console.log(`[CRON] Found ${usersToUnlock.length} users to unlock from cancellation lock.`);

                for (const user of usersToUnlock) {
                    user.cancelLockUntil = null;
                    user.dailyCancelCount = 0;
                    await user.save();
                    console.log(`[CRON] Unlocked user ${user._id} from cancellation lock.`);

                    // Send FCM notification about unlock
                    if (user.fcmToken) {
                        await sendPush(
                            user._id,
                            'User',
                            'account_unlocked',
                            'Account Unlocked',
                            'Your account is now unlocked. You can make new bookings again.',
                            { unlockedAt: now }
                        );
                    }
                }
            }
        } catch (error) {
            console.error('[CRON] Error in User Cancel Lock Job:', error);
        }
    });

    console.log('✅ User Cancel Lock Job initialized.');
};

module.exports = { initUserCancelLockJob };
