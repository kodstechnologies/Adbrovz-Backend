const Vendor = require('../../models/Vendor.model');
const Subcategory = require('../../models/Subcategory.model');
const CreditPlan = require('../../models/CreditPlan.model');
const ApiError = require('../../utils/ApiError');

/**
 * Get all vendors
 * @returns {Promise<Array>} List of vendors
 */
const getAllVendors = async () => {
    return await Vendor.find()
        .populate('membership.category', 'name')
        .sort({ createdAt: -1 });
};

/**
 * Step 2: Select services and calculate membership fee
 */
const selectServices = async (vendorId, { subcategoryIds, durationMonths }) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (durationMonths % 3 !== 0) {
        throw new ApiError(400, 'Duration must be in multiples of 3 months');
    }

    // Fetch subcategories to get prices
    const subcategories = await Subcategory.find({ _id: { $in: subcategoryIds } });
    if (subcategories.length === 0) {
        throw new ApiError(400, 'No valid subcategories selected');
    }

    // Calculate total price: Sum of subcategory prices * (durationMonths / 3)
    const basePrice = subcategories.reduce((sum, sub) => sum + (sub.price || 0), 0);
    const totalPrice = basePrice * (durationMonths / 3);

    // Update vendor
    vendor.selectedSubcategories = subcategoryIds;
    vendor.membership.fee = totalPrice;
    vendor.membership.durationMonths = durationMonths;
    vendor.registrationStep = 'SERVICES_SELECTED';

    await vendor.save();

    return {
        totalPrice,
        durationMonths,
        subcategories: subcategories.map(s => ({ id: s._id, name: s.name, price: s.price })),
    };
};

/**
 * Step 3: Purchase Membership (Demo)
 */
const purchaseMembership = async (vendorId) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (vendor.registrationStep !== 'SERVICES_SELECTED') {
        throw new ApiError(400, 'Please select services before purchasing membership');
    }

    vendor.membership.isActive = true;
    vendor.membership.startDate = new Date();
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + (vendor.membership.durationMonths || 3));
    vendor.membership.expiryDate = expiryDate;

    vendor.registrationStep = 'MEMBERSHIP_PAID';
    await vendor.save();

    return { message: 'Membership purchased successfully (Demo)' };
};

/**
 * Step 4: Purchase Credit Plan (Demo)
 */
const purchaseCreditPlan = async (vendorId, { planId }) => {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (vendor.registrationStep !== 'MEMBERSHIP_PAID') {
        throw new ApiError(400, 'Please pay for membership before purchasing a credit plan');
    }

    const plan = await CreditPlan.findById(planId);
    if (!plan) throw new ApiError(404, 'Credit plan not found');

    vendor.creditPlan = {
        planId: plan._id,
        expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Standard 30 days for now
    };

    // Add credits to vendor
    vendor.credits.purchased += plan.credits;
    vendor.credits.total += plan.credits;

    vendor.registrationStep = 'COMPLETED';
    vendor.isVerified = true;
    vendor.documentStatus = 'approved';

    await vendor.save();

    return { message: 'Credit plan purchased and registration completed successfully' };
};

module.exports = {
    getAllVendors,
    selectServices,
    purchaseMembership,
    purchaseCreditPlan,
};

