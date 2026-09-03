const adminService = require('../../admin/admin.service');

const ELIGIBLE_VENDOR_REGISTRATION_STEPS = ['MEMBERSHIP_PAID', 'PLAN_PAID', 'COMPLETED'];

const DEFAULT_WAVES = [
    { km: 2, mins: 5 },
    { km: 5, mins: 10 },
    { km: 10, mins: 15 }
];

const getSearchWaveConfig = async () => {
    const [r1_km, r1_min, r2_km, r2_min, r3_km, r3_min] = await Promise.all([
        adminService.getSetting('notifications.radius_row1_km'),
        adminService.getSetting('notifications.radius_row1_mins'),
        adminService.getSetting('notifications.radius_row2_km'),
        adminService.getSetting('notifications.radius_row2_mins'),
        adminService.getSetting('notifications.radius_row3_km'),
        adminService.getSetting('notifications.radius_row3_mins')
    ]);

    const waves = [
        { km: Number(r1_km) || DEFAULT_WAVES[0].km, mins: Number(r1_min) || DEFAULT_WAVES[0].mins },
        { km: Number(r2_km) || DEFAULT_WAVES[1].km, mins: Number(r2_min) || DEFAULT_WAVES[1].mins },
        { km: Number(r3_km) || DEFAULT_WAVES[2].km, mins: Number(r3_min) || DEFAULT_WAVES[2].mins }
    ];

    return {
        waves,
        totalSearchTimeMins: waves.reduce((sum, wave) => sum + wave.mins, 0)
    };
};

const buildSearchTimingPayload = ({ searchId, retryCount, waves, totalSearchTimeMins }) => {
    const currentRetry = Math.min(retryCount || 0, waves.length - 1);
    const currentWave = waves[currentRetry];
    const remainingSearchTimeMins = waves.slice(currentRetry).reduce((sum, wave) => sum + wave.mins, 0);

    return {
        searchId,
        retryCount: currentRetry,
        currentWave: currentRetry + 1,
        currentWaveTimeMins: currentWave?.mins || 0,
        remainingSearchTimeMins,
        totalSearchTimeMins
    };
};

const buildBookingSocketRef = (booking) => ({
    bookingId: String(booking?._id || booking?.id),
    bookingID: booking?.bookingID || String(booking?._id || booking?.id)
});

module.exports = {
    ELIGIBLE_VENDOR_REGISTRATION_STEPS,
    DEFAULT_WAVES,
    getSearchWaveConfig,
    buildSearchTimingPayload,
    buildBookingSocketRef
};
