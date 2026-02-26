const express = require('express');
const coinController = require('./coin.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { ROLES } = require('../../constants/roles');

const router = express.Router();

router.get('/stats', coinController.getCoinStats);
router.patch('/settings', coinController.updateCoinSettings);
router.post('/mass-credit', coinController.massCredit);
router.post('/credit', coinController.creditIndividual);
router.get('/history', coinController.getTransactionHistory);
router.get('/list/:targetModel', coinController.getEntitiesWithCoins);

module.exports = router;
