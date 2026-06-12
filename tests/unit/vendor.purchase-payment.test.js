jest.mock('../../src/models/Vendor.model');
jest.mock('../../src/models/Service.model');
jest.mock('../../src/models/Category.model');
jest.mock('../../src/models/Subcategory.model');
jest.mock('../../src/models/ServiceType.model');
jest.mock('../../src/modules/admin/admin.service', () => ({
    getSetting: jest.fn(),
}));

const Vendor = require('../../src/models/Vendor.model');
const Service = require('../../src/models/Service.model');
const Category = require('../../src/models/Category.model');
const Subcategory = require('../../src/models/Subcategory.model');
const ServiceType = require('../../src/models/ServiceType.model');
const adminService = require('../../src/modules/admin/admin.service');
const vendorService = require('../../src/modules/vendor/vendor.service');

describe('calculatePurchasePaymentDetail', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns gstPercent from admin panel when serviceIds is empty', async () => {
        const vendorDoc = {
            _id: '507f1f77bcf86cd799439010',
            selectedServices: [],
            categorySubscriptions: [],
        };

        Vendor.findById.mockReturnValue({
            lean: jest.fn().mockResolvedValue(vendorDoc),
        });

        // Mock admin GST setting to be 12%
        adminService.getSetting.mockImplementation((key) => {
            if (key === 'pricing.membership_gst_percent') {
                return Promise.resolve(12);
            }
            return Promise.resolve(null);
        });

        const result = await vendorService.calculatePurchasePaymentDetail('507f1f77bcf86cd799439010', []);

        expect(result.gstPercent).toBe(12);
        expect(result.items).toEqual([]);
        expect(result.total).toBe(0);
    });

    it('sends already purchased and charged items as 0 rupees without filtering them out', async () => {
        const vendorDoc = {
            _id: '507f1f77bcf86cd799439010',
            selectedServices: ['507f1f77bcf86cd799439014'], // Service 1 is already purchased
            selectedCategories: ['507f1f77bcf86cd799439001'],
            selectedSubcategories: [],
            selectedServiceTypes: [],
            categorySubscriptions: [],
        };

        Vendor.findById.mockReturnValue({
            lean: jest.fn().mockResolvedValue(vendorDoc),
        });

        adminService.getSetting.mockImplementation((key) => {
            if (key === 'pricing.membership_gst_percent') {
                return Promise.resolve(18);
            }
            if (key === 'pricing.service_renewal_days') {
                return Promise.resolve(30);
            }
            return Promise.resolve(null);
        });

        const mockCategory = {
            _id: '507f1f77bcf86cd799439001',
            name: 'AC Services',
            serviceCharge: 500,
        };

        const mockService1 = {
            _id: '507f1f77bcf86cd799439014',
            title: 'AC Cleaning',
            category: '507f1f77bcf86cd799439001',
            serviceCharge: 100,
        };

        const mockService2 = {
            _id: '507f1f77bcf86cd799439015',
            title: 'AC Repair',
            category: '507f1f77bcf86cd799439001',
            serviceCharge: 200,
        };

        Service.find.mockReturnValue({
            lean: jest.fn().mockResolvedValue([mockService1, mockService2]),
        });

        Category.find.mockReturnValue({
            lean: jest.fn().mockResolvedValue([mockCategory]),
        });

        Subcategory.find.mockReturnValue({
            lean: jest.fn().mockResolvedValue([]),
        });

        ServiceType.find.mockReturnValue({
            lean: jest.fn().mockResolvedValue([]),
        });

        // Requesting both Service 1 (purchased) and Service 2 (not purchased)
        const result = await vendorService.calculatePurchasePaymentDetail('507f1f77bcf86cd799439010', [
            '507f1f77bcf86cd799439014',
            '507f1f77bcf86cd799439015',
        ]);

        // We expect items to include:
        // 1. Category (already purchased -> 0 rupees)
        // 2. Service 1 (already purchased -> 0 rupees)
        // 3. Service 2 (new -> 200 rupees)
        expect(result.purchasedItems.length).toBe(3);

        const categoryItem = result.purchasedItems.find(item => item.purchaseType === 'category');
        expect(categoryItem).toBeDefined();
        expect(categoryItem.serviceCharge).toBe(0);
        expect(categoryItem.originalCharge).toBe(0);

        const service1Item = result.purchasedItems.find(item => item.purchaseType === 'service' && item.id === '507f1f77bcf86cd799439014');
        expect(service1Item).toBeDefined();
        expect(service1Item.serviceCharge).toBe(0);
        expect(service1Item.originalCharge).toBe(0);

        const service2Item = result.purchasedItems.find(item => item.purchaseType === 'service' && item.id === '507f1f77bcf86cd799439015');
        expect(service2Item).toBeDefined();
        expect(service2Item.serviceCharge).toBe(200);
        expect(service2Item.originalCharge).toBe(200);

        expect(result.paymentSummary.subTotal).toBe(200);
    });
});
