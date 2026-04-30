const notificationService = require('./notification.service');
const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');

const broadcastNotification = asyncHandler(async (req, res) => {
  const { audience, title, body, data } = req.body;
  const result = await notificationService.broadcastNotification({ audience, title, body, data });
  res.status(200).json(new ApiResponse(200, result, 'Notification broadcast initiated'));
});

module.exports = {
  broadcastNotification,
};

