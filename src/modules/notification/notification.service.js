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
    return { success: true, messageId: response };
  } catch (error) {
    const errorCode = error.errorInfo?.code || '';
    console.error(`[FCM] Error sending message. Code: ${errorCode}, Message: ${error.message}`);
    return { success: false, error: error.message || String(error), errorCode };
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

    if (params.sendPush) {
      if (!params.fcmToken) {
        notification.pushStatus = 'no_token';
      } else {
        const pushResult = await sendPushNotification(params.fcmToken, {
          title: params.title,
          body: params.body,
          data: {
            notificationId: notification._id.toString(),
            type: params.type,
            ...(params.data || {}),
          },
        });

        notification.fcmTokenUsed = params.fcmToken;
        if (pushResult.success) {
          notification.pushStatus = 'sent';
        } else {
          notification.pushStatus = 'failed';
          notification.pushError = pushResult.error;

          // Auto-clear stale/invalid FCM token from the user/vendor document
          const STALE_TOKEN_ERRORS = [
            'messaging/registration-token-not-registered',
            'messaging/invalid-registration-token',
            'messaging/invalid-argument',
          ];
          if (STALE_TOKEN_ERRORS.includes(pushResult.errorCode) && params.user && params.userModel) {
            try {
              const Model = require('mongoose').model(params.userModel);
              await Model.findByIdAndUpdate(params.user, { $unset: { fcmToken: 1 } });
              console.warn(`[FCM] Cleared stale FCM token for ${params.userModel} ${params.user} (Error: ${pushResult.errorCode})`);
            } catch (clearErr) {
              console.error(`[FCM] Failed to clear stale token:`, clearErr.message);
            }
          }
        }
      }
      await notification.save();
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
  const { audience, title, body, data, sentBy } = params;
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
  const failed = targets.length - successful;
  console.log(`Broadcast completed: ${successful}/${targets.length} successful`);

  if (sentBy) {
    try {
      await createNotification({
        user: sentBy,
        userModel: 'Admin',
        type: 'general',
        title,
        body,
        data: { ...(data || {}), audience, broadcast: true, total: targets.length, successful, failed },
        sendPush: false,
      });
    } catch (err) {
      console.error('Failed to store admin broadcast copy:', err.message);
    }
  }
  
  return {
    total: targets.length,
    successful,
    failed
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

const getAllNotificationsForAdmin = async (query = {}) => {
  const { search = '', limit = 2000 } = query;
  const filter = {};

  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: 'i' } },
      { body: { $regex: search, $options: 'i' } },
      { type: { $regex: search, $options: 'i' } },
    ];
  }

  const notifications = await Notification.find(filter)
    .sort({ createdAt: -1 })
    .limit(parseInt(limit, 10) || 2000)
    .lean();

  const generalBuckets = new Map();
  const rows = [];

  for (const n of notifications) {
    if (n.type === 'general') {
      const minute = new Date(n.createdAt);
      minute.setSeconds(0, 0);
      const key = `${n.title}|${n.body}|${minute.toISOString()}`;
      if (!generalBuckets.has(key)) {
        generalBuckets.set(key, {
          id: n._id.toString(),
          title: n.title,
          body: n.body,
          type: n.type,
          createdAt: n.createdAt,
          recipientCount: 0,
          userModels: new Set(),
          sentCount: 0,
          failedCount: 0,
          readCount: 0,
          recipientName: '',
          pushStatus: n.pushStatus,
          isRead: n.isRead,
        });
      }
      const bucket = generalBuckets.get(key);
      bucket.recipientCount += 1;
      bucket.userModels.add(n.userModel);
      if (n.pushStatus === 'sent') bucket.sentCount += 1;
      if (n.pushStatus === 'failed') bucket.failedCount += 1;
      if (n.isRead) bucket.readCount += 1;
    } else {
      rows.push({
        id: n._id.toString(),
        title: n.title,
        body: n.body,
        type: n.type,
        createdAt: n.createdAt,
        recipientCount: 1,
        audience: n.userModel === 'Vendor' ? 'vendors' : n.userModel === 'Admin' ? 'admins' : 'users',
        recipientName: n.userModel === 'Vendor' ? 'Vendor' : n.userModel === 'Admin' ? 'Admin' : 'User',
        pushStatus: n.pushStatus,
        isRead: n.isRead,
        sentCount: n.pushStatus === 'sent' ? 1 : 0,
        failedCount: n.pushStatus === 'failed' ? 1 : 0,
        readCount: n.isRead ? 1 : 0,
      });
    }
  }

  const broadcastRows = Array.from(generalBuckets.values()).map((b) => {
    const models = [...b.userModels];
    let audience = 'all';
    if (models.length === 1) {
      audience = models[0] === 'Vendor' ? 'vendors' : models[0] === 'Admin' ? 'admins' : 'users';
    }
    return {
      id: b.id,
      title: b.title,
      body: b.body,
      type: b.type,
      createdAt: b.createdAt,
      recipientCount: b.recipientCount,
      audience,
      recipientName: `${b.recipientCount} recipient${b.recipientCount === 1 ? '' : 's'}`,
      pushStatus: b.failedCount && !b.sentCount ? 'failed' : b.sentCount ? 'sent' : 'not_sent',
      isRead: b.readCount === b.recipientCount,
      sentCount: b.sentCount,
      failedCount: b.failedCount,
      readCount: b.readCount,
    };
  });

  const combined = [...broadcastRows, ...rows].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  return {
    notifications: combined,
    total: combined.length,
  };
};

module.exports = {
  sendPushNotification,
  createNotification,
  broadcastNotification,
  getNotificationsForUser,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  getAllNotificationsForAdmin,
};
