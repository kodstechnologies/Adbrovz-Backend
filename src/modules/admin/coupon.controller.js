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
