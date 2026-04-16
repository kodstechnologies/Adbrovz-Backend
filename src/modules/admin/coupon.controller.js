const Coupon = require('../../models/Coupon.model');
const User = require('../../models/User.model');

exports.createCoupon = async (req, res) => {
    try {
        const { code, discountType, discountValue, isForAllUsers, applicableUsers, validityDays, isActive } = req.body;

        // Validation
        if (!code) return res.status(400).json({ success: false, message: 'Coupon code is required' });
        if (!['amount', 'percent'].includes(discountType)) return res.status(400).json({ success: false, message: 'Invalid discount type' });
        if (discountValue == null || discountValue <= 0) return res.status(400).json({ success: false, message: 'Valid discount value is required' });
        if (discountType === 'percent' && discountValue > 100) return res.status(400).json({ success: false, message: 'Percentage cannot exceed 100' });
        if (!validityDays || validityDays <= 0) return res.status(400).json({ success: false, message: 'Valid validity days is required' });

        // Check if exists
        const existingCoupon = await Coupon.findOne({ code: code.toUpperCase() });
        if (existingCoupon) {
            return res.status(400).json({ success: false, message: 'Coupon code already exists' });
        }

        const coupon = new Coupon({
            code: code.toUpperCase(),
            discountType,
            discountValue,
            isForAllUsers: isForAllUsers !== undefined ? isForAllUsers : true,
            applicableUsers: isForAllUsers ? [] : applicableUsers || [],
            validityDays,
            isActive: isActive !== undefined ? isActive : true,
            createdBy: req.user.id
        });

        await coupon.save();
        res.status(201).json({ success: true, message: 'Coupon created successfully', data: coupon });
    } catch (error) {
        console.error('Error in createCoupon:', error);
        res.status(500).json({ success: false, message: 'Server error creating coupon', error: error.message });
    }
};

exports.getCoupons = async (req, res) => {
    try {
        const coupons = await Coupon.find().populate('applicableUsers', 'name email phoneNumber').sort({ createdAt: -1 });
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
        const validityEnd = new Date(coupon.createdAt);
        validityEnd.setDate(validityEnd.getDate() + coupon.validityDays);

        if (now > validityEnd) {
            return res.status(200).json({ success: true, valid: false, message: 'Coupon has expired' });
        }

        if (coupon.isForAllUsers) {
            const user = await User.findById(userId);
            if (user && user.createdAt > coupon.createdAt) {
                return res.status(200).json({ success: true, valid: false, message: 'This coupon is only for users who joined before ' + new Date(coupon.createdAt).toLocaleDateString() });
            }
        } else {
            const isApplicable = (coupon.applicableUsers || []).some((u) => u.toString() === userId.toString());
            if (!isApplicable) {
                return res.status(200).json({ success: true, valid: false, message: 'This coupon is not applicable for this user' });
            }
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
        if (!orderAmount || orderAmount <= 0) return res.status(400).json({ success: false, message: 'Valid order amount is required' });

        const coupon = await Coupon.findOne({ code: code.toUpperCase() });

        if (!coupon || !coupon.isActive) {
            return res.status(400).json({ success: false, message: 'Invalid or inactive coupon code' });
        }

        const now = new Date();
        const validityEnd = new Date(coupon.createdAt);
        validityEnd.setDate(validityEnd.getDate() + coupon.validityDays);

        if (now > validityEnd) {
            return res.status(400).json({ success: false, message: 'Coupon has expired' });
        }

        if (coupon.isForAllUsers) {
            const user = await User.findById(userId);
            if (user && user.createdAt > coupon.createdAt) {
                return res.status(400).json({ success: false, message: 'This coupon is only for users who joined before ' + new Date(coupon.createdAt).toLocaleDateString() });
            }
        } else {
            const isApplicable = (coupon.applicableUsers || []).some((u) => u.toString() === userId.toString());
            if (!isApplicable) {
                return res.status(400).json({ success: false, message: 'This coupon is not applicable for this user' });
            }
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
        const now = new Date();

        // Fetch all active coupons
        const allCoupons = await Coupon.find({ isActive: true });

        const availableCoupons = allCoupons.filter((coupon) => {
            // Check expiry
            const validityEnd = new Date(coupon.createdAt);
            validityEnd.setDate(validityEnd.getDate() + coupon.validityDays);
            if (now > validityEnd) return false;

            // Check user applicability
            if (coupon.isForAllUsers) return true;
            return (coupon.applicableUsers || []).some((u) => u.toString() === userId.toString());
        });

        const result = availableCoupons.map((coupon) => ({
            id: coupon._id,
            code: coupon.code,
            discountType: coupon.discountType,
            discountValue: coupon.discountValue,
            isForAllUsers: coupon.isForAllUsers,
            validityDays: coupon.validityDays,
            expiresAt: (() => {
                const d = new Date(coupon.createdAt);
                d.setDate(d.getDate() + coupon.validityDays);
                return d;
            })(),
        }));

        res.status(200).json({ success: true, message: 'Coupons retrieved successfully', data: result });
    } catch (error) {
        console.error('Error in getMyCoupons:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving coupons', error: error.message });
    }
};
