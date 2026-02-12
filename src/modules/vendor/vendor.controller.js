const vendorService = require('./vendor.service');
const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');

/**
 * Get all vendors
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getAllVendors = asyncHandler(async (req, res) => {
    const vendors = await vendorService.getAllVendors();
    res.status(200).json(
        new ApiResponse(200, vendors, 'Vendors retrieved successfully')
    );
});

/**
 * Select services and calculate fee
 */
const selectServices = asyncHandler(async (req, res) => {
    const { vendorId } = req.params;
    const result = await vendorService.selectServices(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, 'Services selected and price calculated')
    );
});

/**
 * Purchase membership (Demo)
 */
const purchaseMembership = asyncHandler(async (req, res) => {
    const { vendorId } = req.params;
    const result = await vendorService.purchaseMembership(vendorId);
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

/**
 * Purchase credit plan (Demo)
 */
const purchaseCreditPlan = asyncHandler(async (req, res) => {
    const { vendorId } = req.params;
    const result = await vendorService.purchaseCreditPlan(vendorId, req.body);
    res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});

module.exports = {
    getAllVendors,
    selectServices,
    purchaseMembership,
    purchaseCreditPlan,
};

