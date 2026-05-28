jest.mock('../../src/models/Vendor.model', () => ({
    find: jest.fn()
}));

jest.mock('../../src/models/Service.model', () => ({
    find: jest.fn()
}));

jest.mock('../../src/models/Booking.model', () => ({}));
jest.mock('../../src/models/User.model', () => ({}));
jest.mock('../../src/models/Dispute.model', () => ({}));
jest.mock('../../src/models/Feedback.model', () => ({}));

jest.mock('../../src/utils/pushNotification', () => ({
    sendPush: jest.fn()
}));

jest.mock('../../src/utils/location', () => ({
    calculateDistance: jest.fn(() => 0)
}));

jest.mock('../../src/modules/admin/admin.service', () => ({
    getSetting: jest.fn()
}));

const Vendor = require('../../src/models/Vendor.model');
const Service = require('../../src/models/Service.model');
const adminService = require('../../src/modules/admin/admin.service');
const bookingService = require('../../src/modules/booking/booking.service');

const createVendorFindQuery = (vendors) => ({
    select: jest.fn().mockResolvedValue(vendors)
});

const createServiceFindQuery = (services) => ({
    select: jest.fn().mockResolvedValue(services)
});

describe('booking searchVendors', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Service.find.mockReturnValue(createServiceFindQuery([]));
        Vendor.find.mockReturnValue(createVendorFindQuery([]));
        adminService.getSetting.mockImplementation(async (key) => {
            if (key === 'notifications.radius_row1_km') return 2;
            if (key === 'notifications.radius_row1_mins') return 5;
            if (key === 'notifications.radius_row2_km') return 5;
            if (key === 'notifications.radius_row2_mins') return 10;
            if (key === 'notifications.radius_row3_km') return 10;
            if (key === 'notifications.radius_row3_mins') return 15;
            return null;
        });
    });

    it('returns matched vendors for active additional category subscriptions without crashing', async () => {
        const vendorDoc = {
            _id: '507f1f77bcf86cd799439011',
            fcmToken: 'token-123',
            membership: { category: '507f1f77bcf86cd799439099' },
            categorySubscriptions: [
                {
                    category: '507f1f77bcf86cd799439022',
                    expiryDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
                    status: 'ACTIVE'
                }
            ]
        };

        Vendor.find.mockReturnValue(createVendorFindQuery([vendorDoc]));
        Service.find.mockReturnValue(createServiceFindQuery([]));

        const booking = {
            _id: '507f1f77bcf86cd799439001',
            searchId: 'search-1',
            user: '507f1f77bcf86cd799439002',
            category: '507f1f77bcf86cd799439022',
            services: [],
            location: {
                latitude: 12.9716,
                longitude: 77.5946
            },
            retryCount: 0,
            rejectedVendors: [],
            laterVendors: [],
            notifiedVendors: []
        };

        await expect(bookingService.searchVendors(booking, false)).resolves.toHaveLength(1);
    });
});
