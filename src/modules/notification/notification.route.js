const express = require('express');
const router = express.Router();
const notificationController = require('./notification.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');

router.use(authenticate);
// No global authorize here, so any authenticated user can access /

router.get('/', notificationController.getNotifications);
router.get('/unread-count', notificationController.getUnreadCount);
router.get(
  '/admin/all',
  authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.SUB_ADMIN),
  notificationController.getAllNotifications
);
router.patch('/mark-all-read', notificationController.markAllAsRead);
router.patch('/:id/read', notificationController.markAsRead);

// Only admins can broadcast
router.post('/broadcast', authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.SUB_ADMIN), notificationController.broadcastNotification);

module.exports = router;

