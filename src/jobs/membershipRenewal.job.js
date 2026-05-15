const cron = require('node-cron');
const Vendor = require('../models/Vendor.model');
const notificationService = require('../modules/notification/notification.service');

/**
 * Initialize the membership renewal job
 */
const initMembershipRenewalJob = () => {
    // Run every day at 00:01 AM
    cron.schedule('1 0 * * *', async () => {
        console.log('[JOB] Starting Membership Renewal Check...');
        try {
            await checkRenewals();
        } catch (error) {
            console.error('[JOB ERROR] Membership Renewal Check failed:', error);
        }
    });
    
    console.log('✅ Membership Renewal Job initialized (Scheduled for 00:01 daily)');
};

/**
 * Perform renewal checks for all vendors
 */
const checkRenewals = async () => {
    const now = new Date();
    
    // 5-day warning window
    const warningStart = new Date();
    warningStart.setDate(now.getDate() + 5);
    warningStart.setHours(0, 0, 0, 0);
    
    const warningEnd = new Date(warningStart);
    warningEnd.setHours(23, 59, 59, 999);

    // Expiry window (expired yesterday or today)
    const expiryStart = new Date();
    expiryStart.setDate(now.getDate() - 1);
    expiryStart.setHours(0, 0, 0, 0);
    
    const expiryEnd = new Date();
    expiryEnd.setHours(23, 59, 59, 999);

    // 1. Membership Renewal Checks
    await processMembershipRenewals(warningStart, warningEnd, 'warning');
    await processMembershipRenewals(expiryStart, expiryEnd, 'expired');

    // 2. Service Renewal Checks
    await processServiceRenewals(warningStart, warningEnd, 'warning');
    await processServiceRenewals(expiryStart, expiryEnd, 'expired');

    // 3. Category Subscription Checks
    await processCategoryRenewals(warningStart, warningEnd, 'warning');
    await processCategoryRenewals(expiryStart, expiryEnd, 'expired');
};

/**
 * Process membership expiry dates
 */
const processMembershipRenewals = async (start, end, mode) => {
    const vendors = await Vendor.find({
        'membership.expiryDate': { $gte: start, $lte: end },
        deletedAt: null
    }).select('_id fcmToken membership.expiryDate vendorID');

    for (const vendor of vendors) {
        const isWarning = mode === 'warning';
        const type = isWarning ? 'membership_warning' : 'membership_expired';
        const title = isWarning ? 'Membership Renewal Warning' : 'Membership Expired';
        const body = isWarning 
            ? `Your membership (ID: ${vendor.vendorID}) will expire in 5 days on ${vendor.membership.expiryDate.toLocaleDateString()}. Please renew to avoid service interruption.`
            : `Your membership (ID: ${vendor.vendorID}) has expired. Please renew now to continue receiving leads.`;

        await notificationService.createNotification({
            user: vendor._id,
            userModel: 'Vendor',
            type,
            title,
            body,
            sendPush: true,
            fcmToken: vendor.fcmToken,
            data: { expiryDate: vendor.membership.expiryDate.toISOString() }
        });
        console.log(`[JOB] Sent ${type} to Vendor ${vendor._id}`);
    }
};

/**
 * Process service renewal expiry dates
 */
const processServiceRenewals = async (start, end, mode) => {
    const vendors = await Vendor.find({
        'serviceRenewal.expiryDate': { $gte: start, $lte: end },
        deletedAt: null
    }).select('_id fcmToken serviceRenewal.expiryDate vendorID');

    for (const vendor of vendors) {
        const isWarning = mode === 'warning';
        const type = isWarning ? 'membership_warning' : 'membership_expired';
        const title = isWarning ? 'Service Renewal Warning' : 'Service Subscription Expired';
        const body = isWarning 
            ? `Your service subscription will expire in 5 days on ${vendor.serviceRenewal.expiryDate.toLocaleDateString()}. Please renew to keep your services active.`
            : `Your service subscription has expired. Please renew now to restore your service listings.`;

        await notificationService.createNotification({
            user: vendor._id,
            userModel: 'Vendor',
            type,
            title,
            body,
            sendPush: true,
            fcmToken: vendor.fcmToken,
            data: { expiryDate: vendor.serviceRenewal.expiryDate.toISOString() }
        });
        console.log(`[JOB] Sent ${type} (Service) to Vendor ${vendor._id}`);
    }
};

/**
 * Process individual category subscriptions
 */
const processCategoryRenewals = async (start, end, mode) => {
    // This is more complex because it's an array. We search for vendors who have ANY category expiring in the window.
    const vendors = await Vendor.find({
        'categorySubscriptions': {
            $elemMatch: {
                expiryDate: { $gte: start, $lte: end }
            }
        },
        deletedAt: null
    }).select('_id fcmToken categorySubscriptions vendorID').populate('categorySubscriptions.category', 'name');

    for (const vendor of vendors) {
        const expiringSub = vendor.categorySubscriptions.find(sub => 
            sub.expiryDate >= start && sub.expiryDate <= end
        );

        if (!expiringSub) continue;

        const catName = expiringSub.category?.name || 'Category';
        const isWarning = mode === 'warning';
        const type = isWarning ? 'membership_warning' : 'membership_expired';
        const title = isWarning ? 'Category Renewal Warning' : 'Category Subscription Expired';
        const body = isWarning 
            ? `Your subscription for ${catName} will expire in 5 days on ${expiringSub.expiryDate.toLocaleDateString()}.`
            : `Your subscription for ${catName} has expired. Please renew to continue serving this category.`;

        await notificationService.createNotification({
            user: vendor._id,
            userModel: 'Vendor',
            type,
            title,
            body,
            sendPush: true,
            fcmToken: vendor.fcmToken,
            data: { 
                categoryId: expiringSub.category?._id?.toString() || '', 
                expiryDate: expiringSub.expiryDate.toISOString() 
            }
        });
        console.log(`[JOB] Sent ${type} (Category: ${catName}) to Vendor ${vendor._id}`);
    }
};

module.exports = {
    initMembershipRenewalJob,
    checkRenewals // Exported for manual testing
};
