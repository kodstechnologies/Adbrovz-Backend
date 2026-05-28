jest.mock('../../src/models/Vendor.model', () => ({
    findById: jest.fn(),
}));

const Vendor = require('../../src/models/Vendor.model');
const vendorService = require('../../src/modules/vendor/vendor.service');

const createVendorQueryMock = (vendorDoc) => ({
    select: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(vendorDoc),
    then: jest.fn((resolve) => resolve(vendorDoc)),
});

describe('vendor extra service approval requests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('filters out approved requests for services already purchased', async () => {
        const purchasedServiceId = '507f1f77bcf86cd799439014';
        const approvedRequest = {
            _id: '507f1f77bcf86cd799439020',
            approvalStatus: 'approved',
            adminRemark: '',
            reviewedAt: null,
            requestedAt: new Date('2024-01-01T00:00:00.000Z'),
            category: null,
            services: [{ _id: purchasedServiceId, title: 'Premium Cleaning' }],
            requestedBy: {
                _id: '507f1f77bcf86cd799439030',
                name: 'Vendor One',
                phoneNumber: '9999999999',
                vendorID: 'VEND-001'
            }
        };

        const vendorDoc = {
            _id: '507f1f77bcf86cd799439010',
            selectedServices: [purchasedServiceId],
            extraServiceRequests: [approvedRequest],
        };

        Vendor.findById.mockReturnValue(createVendorQueryMock(vendorDoc));

        const result = await vendorService.getExtraServiceApprovalRequests('507f1f77bcf86cd799439010');

        expect(result.requests).toEqual([]);
    });
});
