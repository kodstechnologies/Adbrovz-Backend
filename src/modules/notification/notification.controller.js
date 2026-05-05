const notificationService = require('./notification.service');
const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');

const broadcastNotification = asyncHandler(async (req, res) => {
  const { audience, title, body, data } = req.body;
  const result = await notificationService.broadcastNotification({ audience, title, body, data });
  res.status(200).json(new ApiResponse(200, result, 'Notification broadcast initiated'));
});

const getNotifications = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const role = req.user.role;
  
  // Map role to userModel
  let userModel = 'User';
  if (role === 'vendor') userModel = 'Vendor';
  else if (['admin', 'super_admin', 'sub_admin'].includes(role)) userModel = 'Admin';

  const result = await notificationService.getNotificationsForUser(userId, userModel, req.query);
  res.status(200).json(new ApiResponse(200, result, 'Notifications retrieved successfully'));
});

const markAsRead = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const result = await notificationService.markAsRead(id, userId);
  if (!result) {
    return res.status(404).json(new ApiResponse(404, null, 'Notification not found'));
  }
  res.status(200).json(new ApiResponse(200, result, 'Notification marked as read'));
});

const markAllAsRead = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const role = req.user.role;
  
  let userModel = 'User';
  if (role === 'vendor') userModel = 'Vendor';
  else if (['admin', 'super_admin', 'sub_admin'].includes(role)) userModel = 'Admin';

  await notificationService.markAllAsRead(userId, userModel);
  res.status(200).json(new ApiResponse(200, null, 'All notifications marked as read'));
});

const getUnreadCount = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const role = req.user.role;
  
  let userModel = 'User';
  if (role === 'vendor') userModel = 'Vendor';
  else if (['admin', 'super_admin', 'sub_admin'].includes(role)) userModel = 'Admin';

  const count = await notificationService.getUnreadCount(userId, userModel);
  res.status(200).json(new ApiResponse(200, { unreadCount: count }, 'Unread count retrieved successfully'));
});

module.exports = {
  broadcastNotification,
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
};

