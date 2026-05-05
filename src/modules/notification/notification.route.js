const express = require('express');
const router = express.Router();
const notificationController = require('./notification.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');

router.use(authenticate);
// No global authorize here, so any authenticated user can access /

router.get('/', notificationController.getNotifications);

// Only admins can broadcast
router.post('/broadcast', authorize(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.SUB_ADMIN), notificationController.broadcastNotification);

module.exports = router;

