const Vendor = require('../../src/models/Vendor.model');
const PaymentRecord = require('../../src/models/PaymentRecord.model');
const CreditPlan = require('../../src/models/CreditPlan.model');
const vendorService = require('../../src/modules/vendor/vendor.service');
const Razorpay = require('razorpay');
const crypto = require('crypto');

jest.mock('../../src/models/Vendor.model');
jest.mock('../../src/models/PaymentRecord.model');
jest.mock('../../src/models/CreditPlan.model');
jest.mock('razorpay');
jest.mock('crypto');
jest.mock('../../src/modules/admin/admin.service', () => ({
    getSetting: jest.fn().mockResolvedValue(30),
}));

describe('vendor membership checkout & payment verification', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const createQueryMock = (doc) => ({
        select: jest.fn().mockReturnThis(),
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(doc),
        then: jest.fn((resolve) => resolve(doc)),
    });

    describe('createMembershipOrder', () => {
        it('creates Razorpay order and logs a PENDING PaymentRecord', async () => {
            const vendorDoc = {
                _id: '507f1f77bcf86cd799439010',
                name: 'Vendor One',
                registrationStep: 'SERVICES_APPROVED',
                membership: { durationMonths: 3, membershipId: 'plan123' },
                save: jest.fn().mockResolvedValue(true),
            };

            const planDoc = {
                _id: 'plan123',
                name: 'Basic',
                price: 1000,
                validityDays: 30,
            };

            Vendor.findById.mockReturnValue(createQueryMock(vendorDoc));
            CreditPlan.findById.mockReturnValue(createQueryMock(planDoc));

            // Mock Razorpay instance and order creation
            const mockCreateOrder = jest.fn().mockResolvedValue({
                id: 'order_12345',
                amount: 118000,
                currency: 'INR',
                status: 'created',
                receipt: 'receipt_123',
            });
            Razorpay.mockImplementation(() => ({
                orders: {
                    create: mockCreateOrder,
                },
            }));

            // Mock PaymentRecord.create
            PaymentRecord.create = jest.fn().mockResolvedValue({});

            const result = await vendorService.createMembershipOrder('507f1f77bcf86cd799439010', {
                durationMonths: 1,
                planId: 'plan123',
            });

            expect(mockCreateOrder).toHaveBeenCalled();
            expect(PaymentRecord.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    vendor: '507f1f77bcf86cd799439010',
                    orderId: 'order_12345',
                    purpose: 'MEMBERSHIP_PURCHASE',
                    totalAmount: expect.any(Number),
                    status: 'PENDING',
                })
            );
            expect(result).toHaveProperty('razorpayOrder');
            expect(result.razorpayOrder.id).toBe('order_12345');
        });
    });

    describe('verifyMembershipPayment', () => {
        it('verifies signature, updates PaymentRecord, and updates vendor membership fees unconditionally', async () => {
            const vendorDoc = {
                _id: '507f1f77bcf86cd799439010',
                isVerified: true,
                registrationStep: 'SERVICES_APPROVED',
                membership: {
                    durationMonths: 3,
                    membershipId: 'plan123',
                    totalAmount: 24, // old default amount
                    membershipFee: 20, // old default fee
                },
                save: jest.fn().mockResolvedValue(true),
            };

            const planDoc = {
                _id: 'plan123',
                name: 'Basic',
                price: 1000,
                validityDays: 30,
            };

            const paymentRecordDoc = {
                orderId: 'order_12345',
                status: 'PENDING',
                amount: 1000,
                gstAmount: 180,
                totalAmount: 1180,
                validityDays: 30,
                save: jest.fn().mockResolvedValue(true),
            };

            Vendor.findById.mockReturnValue(createQueryMock(vendorDoc));
            CreditPlan.findById.mockReturnValue(createQueryMock(planDoc));
            PaymentRecord.findOne.mockResolvedValue(paymentRecordDoc);
            PaymentRecord.find.mockReturnValue({
                sort: jest.fn().mockReturnThis(),
                populate: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue([]),
            });

            // Mock crypto verification
            crypto.createHmac.mockReturnValue({
                update: jest.fn().mockReturnThis(),
                digest: jest.fn().mockReturnValue('mocked_signature'),
            });

            const result = await vendorService.verifyMembershipPayment('507f1f77bcf86cd799439010', {
                razorpay_order_id: 'order_12345',
                razorpay_payment_id: 'pay_123',
                razorpay_signature: 'mocked_signature',
                membershipId: 'plan123',
            });

            // Verify PaymentRecord was updated to COMPLETED
            expect(paymentRecordDoc.status).toBe('COMPLETED');
            expect(paymentRecordDoc.paymentId).toBe('pay_123');
            expect(paymentRecordDoc.save).toHaveBeenCalled();

            // Verify vendor membership details were updated to matching plan price/GST (from paymentRecord)
            expect(vendorDoc.membership.totalAmount).toBe(1180);
            expect(vendorDoc.membership.gstAmount).toBe(180);
            expect(vendorDoc.membership.membershipFee).toBe(1000);
            expect(vendorDoc.save).toHaveBeenCalled();
            expect(result.success).toBe(true);
        });
    });
});
