const Notification = require('../../models/Notification.model');
const firebaseAdmin = require('../../config/firebase');

/**
 * Send a push notification using Firebase Cloud Messaging
 * @param {string} token - FCM Device Token
 * @param {object} payload - Notification payload { title, body, data }
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
const sendPushNotification = async (token, payload) => {
  if (!token) return false;

  try {
    const message = {
      token,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data || {},
    };

    const response = await firebaseAdmin.messaging().send(message);
    console.log('Successfully sent message:', response);
    return true;
  } catch (error) {
    console.error('Error sending message:', error);
    // If token is invalid or expired, we might want to remove it from the DB
    // but for now we just log it
    return false;
  }
};

/**
 * Creates a notification in DB and optionally sends a push notification
 * @param {object} params - { user, userModel, type, title, body, data, sendPush }
 */
const createNotification = async (params) => {
  try {
    const notification = await Notification.create({
      user: params.user,
      userModel: params.userModel, // 'User', 'Vendor', 'Admin'
      type: params.type,
      title: params.title,
      body: params.body,
      data: params.data,
    });

    if (params.sendPush && params.fcmToken) {
      await sendPushNotification(params.fcmToken, {
        title: params.title,
        body: params.body,
        data: {
          notificationId: notification._id.toString(),
          type: params.type,
          ...(params.data || {}),
        },
      });
    }

    // Note: If you have Socket.io running, you could also emit an event here
    // const io = require('../../socket').getIO();
    // io.to(`${params.userModel.toLowerCase()}_${params.user}`).emit('new_notification', notification);

    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
};

module.exports = {
  sendPushNotification,
  createNotification,
};
