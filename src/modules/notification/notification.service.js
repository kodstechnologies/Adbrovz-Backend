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

  // Check if Firebase is initialized
  if (!firebaseAdmin.apps.length) {
    console.warn('Cannot send push notification: Firebase Admin SDK not initialized.');
    return false;
  }

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

/**
 * Broadcasts a notification to all users, vendors, or both
 * @param {object} params - { audience: 'all' | 'users' | 'vendors', title, body, data }
 */
const broadcastNotification = async (params) => {
  const { audience, title, body, data } = params;
  const User = require('../../models/User.model');
  const Vendor = require('../../models/Vendor.model');

  let targets = [];
  if (audience === 'all' || audience === 'users') {
    const users = await User.find({ deletedAt: null }).select('_id fcmToken');
    targets.push(...users.map(u => ({ id: u._id, model: 'User', token: u.fcmToken })));
  }
  if (audience === 'all' || audience === 'vendors') {
    const vendors = await Vendor.find({ deletedAt: null }).select('_id fcmToken');
    targets.push(...vendors.map(v => ({ id: v._id, model: 'Vendor', token: v.fcmToken })));
  }

  const results = await Promise.allSettled(targets.map(target => 
    createNotification({
      user: target.id,
      userModel: target.model,
      type: 'general',
      title,
      body,
      data,
      sendPush: true,
      fcmToken: target.token
    })
  ));

  const successful = results.filter(r => r.status === 'fulfilled').length;
  console.log(`Broadcast completed: ${successful}/${targets.length} successful`);
  
  return {
    total: targets.length,
    successful,
    failed: targets.length - successful
  };
};

/**
 * Gets notifications for a specific user with filtering and pagination
 * @param {string} userId - ID of the user
 * @param {string} userModel - Model of the user ('User', 'Vendor', 'Admin')
 * @param {object} query - { startDate, endDate, limit, skip, isRead }
 */
const getNotificationsForUser = async (userId, userModel, query = {}) => {
  const { startDate, endDate, limit = 20, skip = 0, isRead } = query;
  
  const filter = {
    user: userId,
    userModel: userModel
  };

  if (isRead !== undefined) {
    filter.isRead = isRead === 'true';
  }

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) filter.createdAt.$lte = new Date(endDate);
  }

  const [notifications, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip)),
    Notification.countDocuments(filter)
  ]);

  return {
    notifications,
    total,
    limit: parseInt(limit),
    skip: parseInt(skip)
  };
};

/**
 * Marks a single notification as read
 * @param {string} notificationId - ID of the notification
 * @param {string} userId - ID of the user (for security)
 */
const markAsRead = async (notificationId, userId) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, user: userId },
    { isRead: true, readAt: new Date() },
    { new: true }
  );
  return notification;
};

/**
 * Marks all notifications for a user as read
 * @param {string} userId - ID of the user
 * @param {string} userModel - Model of the user
 */
const markAllAsRead = async (userId, userModel) => {
  return await Notification.updateMany(
    { user: userId, userModel: userModel, isRead: false },
    { isRead: true, readAt: new Date() }
  );
};

/**
 * Gets the count of unread notifications for a user
 * @param {string} userId - ID of the user
 * @param {string} userModel - Model of the user
 */
const getUnreadCount = async (userId, userModel) => {
  return await Notification.countDocuments({
    user: userId,
    userModel: userModel,
    isRead: false
  });
};

module.exports = {
  sendPushNotification,
  createNotification,
  broadcastNotification,
  getNotificationsForUser,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
};
