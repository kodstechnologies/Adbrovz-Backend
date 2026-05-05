const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'userModel',
      required: true,
    },
    userModel: {
      type: String,
      enum: ['User', 'Vendor', 'Admin'],
      required: true,
    },
    type: {
      type: String,
      enum: [
        'booking_alert',
        'booking_accepted',
        'booking_cancelled',
        'booking_completed',
        'booking_rescheduled',
        'price_confirmation',
        'reminder',
        'general',
        'account_suspended',
        'account_banned',
        'account_unbanned',
        'deletion_approved',
        'coupon_received',
      ],
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
    },
    isMuted: {
      type: Boolean,
      default: false,
    },
    expiresAt: {
      type: Date,
    },
    pushStatus: {
      type: String,
      enum: ['not_sent', 'sent', 'failed', 'no_token'],
      default: 'not_sent',
    },
    fcmTokenUsed: {
      type: String,
    },
    pushError: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, isRead: 1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;

