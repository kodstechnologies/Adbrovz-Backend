const mongoose = require('mongoose');
const notificationService = require('../modules/notification/notification.service');

/**
 * Centralized utility to send push notifications and save them in DB.
 * It automatically fetches the FCM token for the user/vendor.
 * 
 * @param {string|mongoose.Types.ObjectId} userId - Recipient ID
 * @param {string} userModel - 'User' or 'Vendor'
 * @param {string} type - Notification type (e.g., 'booking_update', 'account_status')
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Extra data for the push notification
 */
const sendPush = async (userId, userModel, type, title, body, data = {}) => {
    try {
        if (!userId) return;

        // Dynamic model resolution to avoid circular dependencies in some cases
        const Model = mongoose.model(userModel);
        const recipient = await Model.findById(userId).select('fcmToken');
        
        // We always create the notification in DB, but only attempt push if token exists
        await notificationService.createNotification({
            user: userId,
            userModel,
            type,
            title,
            body,
            data: { ...data, type },
            sendPush: !!recipient?.fcmToken,
            fcmToken: recipient?.fcmToken
        });
    } catch (err) {
        console.error(`[PUSH ERROR] Failed to notify ${userModel} of ${type}:`, err.message);
    }
};

module.exports = { sendPush };
