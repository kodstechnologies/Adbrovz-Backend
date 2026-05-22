jest.mock('../../src/models/Category.model', () => ({
    find: jest.fn()
}));

jest.mock('../../src/models/Subcategory.model', () => ({
    find: jest.fn(),
    findById: jest.fn(),
    countDocuments: jest.fn().mockResolvedValue(0)
}));

jest.mock('../../src/models/ServiceType.model', () => ({
    find: jest.fn(),
    findById: jest.fn(),
    countDocuments: jest.fn().mockResolvedValue(0)
}));

jest.mock('../../src/models/Service.model', () => ({
    find: jest.fn(),
    countDocuments: jest.fn().mockResolvedValue(0)
}));

const Category = require('../../src/models/Category.model');
const Subcategory = require('../../src/models/Subcategory.model');
const ServiceType = require('../../src/models/ServiceType.model');
const Service = require('../../src/models/Service.model');
const ApiError = require('../../src/utils/ApiError');
const serviceService = require('../../src/modules/service/service.service');

const createQueryMock = (result) => {
    const mock = {
        sort: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        then: jest.fn((resolve) => resolve(result))
    };
    return mock;
};

describe('getServiceManagementRows', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns all four rows with empty dependent sections when nothing is selected', async () => {
        const categories = [{ _id: 'cat-1', name: 'Cleaning' }];

        Category.find.mockReturnValue(createQueryMock(categories));

        const result = await serviceService.getServiceManagementRows();

        expect(result.categories).toEqual(categories);
        expect(result.subcategories).toEqual([]);
        expect(result.serviceTypes).toEqual([]);
        expect(result.services).toEqual([]);
        expect(result.rows.categories.isEnabled).toBe(true);
        expect(result.rows.subcategories.isEnabled).toBe(false);
        expect(result.rows.serviceTypes.isEnabled).toBe(false);
        expect(result.rows.services.isEnabled).toBe(false);
        expect(result.rows.subcategories.emptyMessage).toBe('Select a category to load subcategories.');
    });

    it('resolves the selection chain and loads dependent rows for a selected service type', async () => {
        const categoryId = '507f1f77bcf86cd799439011';
        const subcategoryId = '507f1f77bcf86cd799439012';
        const serviceTypeId = '507f1f77bcf86cd799439013';

        const categories = [{ _id: categoryId, name: 'Cleaning' }];
        const subcategories = [{ _id: subcategoryId, name: 'Home Cleaning' }];
        const serviceTypes = [{ _id: serviceTypeId, name: 'Deep Cleaning' }];
        const services = [{ _id: '507f1f77bcf86cd799439014', title: 'Kitchen Deep Clean' }];

        ServiceType.findById.mockReturnValue({
            select: jest.fn().mockResolvedValue({
                category: { toString: () => categoryId },
                subcategory: { toString: () => subcategoryId }
            })
        });

        Category.find.mockReturnValue(createQueryMock(categories));
        Subcategory.find.mockReturnValue(createQueryMock(subcategories));
        ServiceType.find.mockReturnValue(createQueryMock(serviceTypes));
        Service.find.mockReturnValue(createQueryMock(services));

        const result = await serviceService.getServiceManagementRows({ serviceTypeId });

        expect(result.selected).toEqual({
            categoryId,
            subcategoryId,
            serviceTypeId
        });
        expect(result.subcategories).toEqual(subcategories);
        expect(result.serviceTypes).toEqual(serviceTypes);
        expect(result.services).toEqual(services);
        expect(result.rows.subcategories.isEnabled).toBe(true);
        expect(result.rows.serviceTypes.isEnabled).toBe(true);
        expect(result.rows.services.isEnabled).toBe(true);
        expect(result.rows.services.count).toBe(1);
    });

    it('throws a validation error for an invalid category id', async () => {
        await expect(
            serviceService.getServiceManagementRows({ categoryId: 'bad-id' })
        ).rejects.toEqual(expect.objectContaining({
            statusCode: 400,
            message: 'Invalid categoryId'
        }));
    });

    it('throws when a selected service type does not belong to the selected subcategory', async () => {
        const categoryId = '507f1f77bcf86cd799439011';
        const subcategoryId = '507f1f77bcf86cd799439099';
        const serviceTypeId = '507f1f77bcf86cd799439013';

        Subcategory.findById.mockReturnValue({
            select: jest.fn().mockResolvedValue({
                category: { toString: () => categoryId }
            })
        });

        ServiceType.findById.mockReturnValue({
            select: jest.fn().mockResolvedValue({
                category: { toString: () => categoryId },
                subcategory: { toString: () => '507f1f77bcf86cd799439012' }
            })
        });

        await expect(
            serviceService.getServiceManagementRows({ categoryId, subcategoryId, serviceTypeId })
        ).rejects.toBeInstanceOf(ApiError);
    });
});
