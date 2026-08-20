const Coupon = require('../../models/Coupon.model');
const User = require('../../models/User.model');
const { getCouponWindow, getCouponStatusMessage, daysBetween, isAccountEligibleForCoupon } = require('../../utils/couponValidity');

exports.createCoupon = async (req, res) => {
    try {
        const { code, discountType, discountValue, isForAllUsers, applicableUsers, audienceType, isForAllVendors, applicableVendors, validityDays, startDate, endDate, isActive } = req.body;

        // Validation
        if (!code) return res.status(400).json({ success: false, message: 'Coupon code is required' });
        if (!['amount', 'percent'].includes(discountType)) return res.status(400).json({ success: false, message: 'Invalid discount type' });
        if (discountValue == null || discountValue <= 0) return res.status(400).json({ success: false, message: 'Valid discount value is required' });
        if (discountType === 'percent' && discountValue > 100) return res.status(400).json({ success: false, message: 'Percentage cannot exceed 100' });

        let resolvedStartDate;
        let resolvedEndDate;
        let resolvedValidityDays;

        if (startDate && endDate) {
            resolvedStartDate = new Date(startDate);
            resolvedEndDate = new Date(endDate);
            if (isNaN(resolvedStartDate.getTime()) || isNaN(resolvedEndDate.getTime())) {
                return res.status(400).json({ success: false, message: 'Valid start and end dates are required' });
            }
            if (resolvedEndDate < resolvedStartDate) {
                return res.status(400).json({ success: false, message: 'End date cannot be before start date' });
            }
            resolvedValidityDays = daysBetween(resolvedStartDate, resolvedEndDate);
        } else if (validityDays && validityDays > 0) {
            resolvedStartDate = new Date();
            resolvedEndDate = new Date();
            resolvedEndDate.setDate(resolvedEndDate.getDate() + Number(validityDays) - 1);
            resolvedValidityDays = Number(validityDays);
        } else {
            return res.status(400).json({ success: false, message: 'Start date and end date are required' });
        }

        const resolvedAudienceType = audienceType === 'vendor' ? 'vendor' : 'user';
        const forAllUsers = resolvedAudienceType === 'user' && (isForAllUsers !== undefined ? !!isForAllUsers : true);
        const forAllVendors = resolvedAudienceType === 'vendor' && !!isForAllVendors;

        if (resolvedAudienceType === 'user' && !forAllUsers && (!applicableUsers || applicableUsers.length === 0)) {
            return res.status(400).json({ success: false, message: 'Select at least one user for this coupon' });
        }
        if (resolvedAudienceType === 'vendor' && !forAllVendors && (!applicableVendors || applicableVendors.length === 0)) {
            return res.status(400).json({ success: false, message: 'Select at least one vendor for this coupon' });
        }

        // Check if exists
        const existingCoupon = await Coupon.findOne({ code: code.toUpperCase() });
        if (existingCoupon) {
            return res.status(400).json({ success: false, message: 'Coupon code already exists' });
        }

        const coupon = new Coupon({
            code: code.toUpperCase(),
            discountType,
            discountValue,
            isForAllUsers: forAllUsers,
            applicableUsers: forAllUsers || resolvedAudienceType === 'vendor' ? [] : applicableUsers || [],
            audienceType: resolvedAudienceType,
            isForAllVendors: forAllVendors,
            applicableVendors: forAllVendors || resolvedAudienceType === 'user' ? [] : applicableVendors || [],
            validityDays: resolvedValidityDays,
            startDate: resolvedStartDate,
            endDate: resolvedEndDate,
            isActive: isActive !== undefined ? isActive : true,
            createdBy: req.user.id
        });

        await coupon.save();

        const { sendPush } = require('../../utils/pushNotification');
        if (resolvedAudienceType === 'user' && !forAllUsers && applicableUsers && applicableUsers.length > 0) {
            applicableUsers.forEach(userId => {
                sendPush(
                    userId,
                    'User',
                    'new_coupon',
                    'Special Coupon for You!',
                    `You've received a special coupon: ${code.toUpperCase()}. Use it now!`,
                    { code: code.toUpperCase(), discountType, discountValue }
                );
            });
        }
        if (resolvedAudienceType === 'vendor' && !forAllVendors && applicableVendors && applicableVendors.length > 0) {
            applicableVendors.forEach(vendorId => {
                sendPush(
                    vendorId,
                    'Vendor',
                    'new_coupon',
                    'Special Coupon for You!',
                    `You've received a special coupon: ${code.toUpperCase()}. Use it now!`,
                    { code: code.toUpperCase(), discountType, discountValue }
                );
            });
        }

        res.status(201).json({ success: true, message: 'Coupon created successfully', data: coupon });
    } catch (error) {
        console.error('Error in createCoupon:', error);
        res.status(500).json({ success: false, message: 'Server error creating coupon', error: error.message });
    }
};

exports.getCoupons = async (req, res) => {
    try {
        const coupons = await Coupon.find()
            .populate('applicableUsers', 'name email phoneNumber')
            .populate('applicableVendors', 'name email phoneNumber')
            .sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: coupons });
    } catch (error) {
        console.error('Error in getCoupons:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving coupons', error: error.message });
    }
};

exports.deleteCoupon = async (req, res) => {
    try {
        const { id } = req.params;
        const coupon = await Coupon.findByIdAndDelete(id);
        if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
        
        res.status(200).json({ success: true, message: 'Coupon deleted successfully' });
    } catch (error) {
        console.error('Error in deleteCoupon:', error);
        res.status(500).json({ success: false, message: 'Server error deleting coupon', error: error.message });
    }
};

// Verify a coupon code for a specific user
exports.verifyCoupon = async (req, res) => {
    try {
        const { code, userId } = req.body;

        if (!code) return res.status(400).json({ success: false, message: 'Coupon code is required' });
        if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });

        const coupon = await Coupon.findOne({ code: code.toUpperCase() });
        
        if (!coupon) {
            return res.status(200).json({ success: true, valid: false, message: 'Invalid coupon code' });
        }

        if (!coupon.isActive) {
            return res.status(200).json({ success: true, valid: false, message: 'Coupon is inactive' });
        }

        const now = new Date();
        const statusMessage = getCouponStatusMessage(coupon, now);
        if (statusMessage) {
            return res.status(200).json({ success: true, valid: false, message: statusMessage });
        }

        const requesterId = userId || req.user?.id || req.user?.userId;
        const requesterRole = req.user?.role || 'user';
        if (!isAccountEligibleForCoupon(coupon, requesterId, requesterRole)) {
            return res.status(200).json({ success: true, valid: false, message: 'This coupon is not applicable for you. You do not have access to this coupon.' });
        }

        res.status(200).json({
            success: true,
            valid: true,
            message: 'Coupon is valid',
            data: {
                code: coupon.code,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue
            }
        });
    } catch (error) {
        console.error('Error in verifyCoupon:', error);
        res.status(500).json({ success: false, message: 'Server error verifying coupon', error: error.message });
    }
};

// Apply a coupon and calculate discount
exports.applyCoupon = async (req, res) => {
    try {
        const { code, userId, orderAmount } = req.body;

        if (!code) return res.status(400).json({ success: false, message: 'Coupon code is required' });
        if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });
        if (orderAmount === undefined || orderAmount === null || (typeof orderAmount === 'string' && orderAmount.trim() === '')) {
            return res.status(400).json({ success: false, message: 'Valid order amount is required' });
        }

        const parsedAmount = Number(orderAmount);
        if (isNaN(parsedAmount) || parsedAmount < 0) {
            return res.status(400).json({ success: false, message: 'Valid order amount is required' });
        }

        if (parsedAmount === 0) {
            return res.status(400).json({ success: false, message: "Coupon cannot be applied if service price is 0" });
        }

        const coupon = await Coupon.findOne({ code: code.toUpperCase() });

        if (!coupon || !coupon.isActive) {
            return res.status(400).json({ success: false, message: 'Invalid or inactive coupon code' });
        }

        const now = new Date();
        const statusMessage = getCouponStatusMessage(coupon, now);
        if (statusMessage) {
            return res.status(400).json({ success: false, message: statusMessage });
        }

        const requesterId = userId || req.user?.id || req.user?.userId;
        const requesterRole = req.user?.role || 'user';
        if (!isAccountEligibleForCoupon(coupon, requesterId, requesterRole)) {
            return res.status(400).json({ success: false, message: 'This coupon is not applicable for you. You do not have access to this coupon.' });
        }

        let discount = 0;
        if (coupon.discountType === 'amount') {
            discount = coupon.discountValue;
        } else if (coupon.discountType === 'percent') {
            discount = (orderAmount * coupon.discountValue) / 100;
        }

        const finalAmount = Math.max(0, orderAmount - discount);

        res.status(200).json({
            success: true,
            message: 'Coupon applied successfully',
            data: {
                valid: true,
                code: coupon.code,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
                discount,
                originalAmount: orderAmount,
                finalAmount
            }
        });
    } catch (error) {
        console.error('Error in applyCoupon:', error);
        res.status(500).json({ success: false, message: 'Server error applying coupon', error: error.message });
    }
};

// Get coupons available to the logged-in user
exports.getMyCoupons = async (req, res) => {
    try {
        const userId = req.user.userId || req.user._id || req.user.id;
        const role = req.user.role || 'user';
        const now = new Date();

        // Fetch all active coupons
        const allCoupons = await Coupon.find({ isActive: true });

        const availableCoupons = allCoupons.filter((coupon) => {
            if (getCouponStatusMessage(coupon, now)) return false;
            return isAccountEligibleForCoupon(coupon, userId, role);
        });

        const result = availableCoupons.map((coupon) => {
            const { start, end } = getCouponWindow(coupon);
            return {
                id: coupon._id,
                code: coupon.code,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
                isForAllUsers: coupon.isForAllUsers,
                audienceType: coupon.audienceType || 'user',
                isForAllVendors: coupon.isForAllVendors,
                validityDays: coupon.validityDays,
                startDate: start,
                endDate: end,
                expiresAt: end,
            };
        });

        res.status(200).json({ success: true, message: 'Coupons retrieved successfully', data: result });
    } catch (error) {
        console.error('Error in getMyCoupons:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving coupons', error: error.message });
    }
};
