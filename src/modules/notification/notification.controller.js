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

module.exports = {
  broadcastNotification,
  getNotifications,
};

