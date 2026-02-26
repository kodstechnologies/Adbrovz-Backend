const asyncHandler = require('../../utils/asyncHandler');
const coinService = require('./coin.service');
const adminService = require('./admin.service');

const getCoinStats = asyncHandler(async (req, res) => {
    const stats = await coinService.getCoinStats();
    res.send({ success: true, data: stats });
});

const updateCoinSettings = asyncHandler(async (req, res) => {
    const { userSignupBonus, vendorSignupBonus } = req.body;
    const settings = {};

    if (userSignupBonus !== undefined) settings['pricing.signup_welcome_coins'] = userSignupBonus;
    if (vendorSignupBonus !== undefined) settings['pricing.vendor_signup_welcome_coins'] = vendorSignupBonus;

    await adminService.updateGlobalSettings(settings, req.user.userId);
    res.send({ success: true, message: 'Coin settings updated successfully' });
});

const massCredit = asyncHandler(async (req, res) => {
    const { targetModel, amount, purpose, description } = req.body;
    const result = await coinService.massCredit({
        targetModel,
        amount,
        purpose,
        description,
        adminId: req.user.userId
    });
    res.send({ success: true, ...result });
});

const getTransactionHistory = asyncHandler(async (req, res) => {
    const result = await coinService.getTransactionHistory(req.query);
    res.send({ success: true, data: result });
});

const getEntitiesWithCoins = asyncHandler(async (req, res) => {
    const { targetModel } = req.params;
    const result = await coinService.getEntitiesWithCoins(targetModel, req.query);
    res.send({ success: true, data: result });
});

module.exports = {
    getCoinStats,
    updateCoinSettings,
    massCredit,
    getTransactionHistory,
    getEntitiesWithCoins
};
