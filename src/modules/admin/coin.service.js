const CoinTransaction = require('../../models/CoinTransaction.model');
const User = require('../../models/User.model');
const Vendor = require('../../models/Vendor.model');
const adminService = require('./admin.service');
const ApiError = require('../../utils/ApiError');

/**
 * Get overall coin statistics
 */
const getCoinStats = async () => {
    const [userCoins, vendorCoins] = await Promise.all([
        User.aggregate([{ $group: { _id: null, total: { $sum: "$coins" } } }]),
        Vendor.aggregate([{ $group: { _id: null, total: { $sum: "$coins" } } }])
    ]);

    const userSignupBonus = await adminService.getSetting('pricing.signup_welcome_coins');
    const vendorSignupBonus = await adminService.getSetting('pricing.vendor_signup_welcome_coins');

    return {
        totalUserCoins: userCoins[0]?.total || 0,
        totalVendorCoins: vendorCoins[0]?.total || 0,
        userSignupBonus,
        vendorSignupBonus
    };
};

/**
 * Mass credit coins to all users or vendors
 */
const massCredit = async ({ targetModel, amount, purpose, description, adminId }) => {
    if (amount <= 0) throw new ApiError(400, 'Amount must be greater than zero');

    const Model = targetModel === 'User' ? User : Vendor;

    // Update all active records
    const result = await Model.updateMany(
        { isActive: true, deletedAt: null },
        { $inc: { coins: amount } }
    );

    if (result.modifiedCount > 0) {
        // Create a record of this mass credit (we'll log it as a single transaction or separate ones?)
        // The user said "one more common box to whenever users or vendor exist they have to get all the coins separately mass credit"
        // Usually mass credit can be thousands of records. Logging each is better for history but heavy.
        // For now, let's create a summary transaction and maybe individual ones if needed.
        // Requirement 3 says "icon tract history whichever paid by admin coin" at individual level.
        // So we NEED individual transaction records for the "i icon" history.

        // This could be slow for many users. In a real production app, this should be a background job.
        // Since it's a small/medium app for now, we'll do it here but warn.

        const entities = await Model.find({ isActive: true, deletedAt: null }, '_id coins');

        const transactions = entities.map(entity => ({
            targetId: entity._id,
            targetModel,
            amount,
            type: 'credit',
            purpose: purpose || 'mass_credit',
            description: description || `Admin mass credit to all ${targetModel.toLowerCase()}s`,
            performedBy: adminId,
            balanceAfter: entity.coins // This is slightly inaccurate if concurrency happens, but okay for history
        }));

        // Batch insert transactions
        await CoinTransaction.insertMany(transactions);
    }

    return {
        modifiedCount: result.modifiedCount,
        message: `Successfully credited ${amount} coins to ${result.modifiedCount} ${targetModel.toLowerCase()}s`
    };
};

/**
 * Get transaction history (with filters)
 */
const getTransactionHistory = async (query = {}) => {
    const { targetId, targetModel, purpose, skip = 0, limit = 20 } = query;
    const filter = {};

    if (targetId) filter.targetId = targetId;
    if (targetModel) filter.targetModel = targetModel;
    if (purpose) filter.purpose = purpose;

    const [transactions, total] = await Promise.all([
        CoinTransaction.find(filter)
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .populate('performedBy', 'name username'),
        CoinTransaction.countDocuments(filter)
    ]);

    return { transactions, total };
};

/**
 * Get entities with coin balances
 */
const getEntitiesWithCoins = async (targetModel, query = {}) => {
    const Model = targetModel === 'User' ? User : Vendor;
    const { skip = 0, limit = 20, search = '' } = query;

    const filter = { deletedAt: null };
    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: 'i' } },
            { phoneNumber: { $regex: search, $options: 'i' } }
        ];
    }

    const [entities, total] = await Promise.all([
        Model.find(filter, 'name phoneNumber coins userID vendorID')
            .sort({ coins: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit)),
        Model.countDocuments(filter)
    ]);

    return { entities, total };
};

/**
 * Credit coins to a specific user or vendor
 */
const creditIndividual = async ({ targetId, targetModel, amount, purpose, description, adminId }) => {
    if (amount <= 0) throw new ApiError(400, 'Amount must be greater than zero');

    const Model = targetModel === 'User' ? User : Vendor;
    const entity = await Model.findById(targetId);

    if (!entity) {
        throw new ApiError(404, `${targetModel} not found`);
    }

    // Update coins
    entity.coins = (entity.coins || 0) + amount;
    await entity.save();

    // Create transaction record
    const transaction = await CoinTransaction.create({
        targetId,
        targetModel,
        amount,
        type: 'credit',
        purpose: purpose || 'admin_credit',
        description: description || `Individual credit by admin`,
        performedBy: adminId,
        balanceAfter: entity.coins
    });

    return {
        success: true,
        message: `Successfully credited ${amount} coins to ${entity.name}`,
        transaction
    };
};

module.exports = {
    getCoinStats,
    massCredit,
    creditIndividual,
    getTransactionHistory,
    getEntitiesWithCoins
};
