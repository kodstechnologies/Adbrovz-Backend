const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');


// Get dashboard stats
const getDashboard = asyncHandler(async (req, res) => {
  const adminService = require('./admin.service');
  const stats = await adminService.getDashboardStats();
  res.status(200).json(
    new ApiResponse(200, stats, 'Dashboard stats retrieved successfully')
  );
});

// Get all users
const getUsers = asyncHandler(async (req, res) => {
  const adminService = require('./admin.service');
  const { limit = 10, skip = 0, search = '' } = req.query;

  const result = await adminService.getAllUsers({ limit, skip, search });

  res.status(200).json(
    new ApiResponse(200, result, 'Users retrieved successfully')
  );
});

// Update user status
const updateUserStatus = asyncHandler(async (req, res) => {
  const adminService = require('./admin.service');
  const { userId } = req.params;
  const { status } = req.body;
  const adminId = req.user.id;

  const user = await adminService.updateUserStatus(userId, status, adminId);

  res.status(200).json(
    new ApiResponse(200, user, 'User status updated successfully')
  );
});

// Delete user
const deleteUser = asyncHandler(async (req, res) => {
  const adminService = require('./admin.service');
  const { userId } = req.params;
  const adminId = req.user.id;

  const user = await adminService.deleteUser(userId, adminId);

  res.status(200).json(
    new ApiResponse(200, user, 'User deleted successfully')
  );
});

const adminService = require('./admin.service');

// ... existing code ...

// Create credit plan
const createCreditPlan = asyncHandler(async (req, res) => {
  const plan = await adminService.createCreditPlan(req.body);
  res.status(201).json(
    new ApiResponse(201, plan, 'Credit plan created successfully')
  );
});

// Get all credit plans
const getCreditPlans = asyncHandler(async (req, res) => {
  const plans = await adminService.getCreditPlans();
  res.status(200).json(
    new ApiResponse(200, plans, 'Credit plans retrieved successfully')
  );
});

// Update credit plan
const updateCreditPlan = asyncHandler(async (req, res) => {
  const { planId } = req.params;
  const plan = await adminService.updateCreditPlan(planId, req.body);
  res.status(200).json(
    new ApiResponse(200, plan, 'Credit plan updated successfully')
  );
});

// Delete credit plan
const deleteCreditPlan = asyncHandler(async (req, res) => {
  const { planId } = req.params;
  await adminService.deleteCreditPlan(planId);
  res.status(200).json(
    new ApiResponse(200, null, 'Credit plan deleted successfully')
  );
});

// Verify vendor (account level)
const verifyVendor = asyncHandler(async (req, res) => {
  const { vendorId } = req.params;
  const vendor = await adminService.verifyVendor(vendorId, req.body);
  res.status(200).json(
    new ApiResponse(200, vendor, 'Vendor verification status updated successfully')
  );
});

// Verify specific document
const verifyVendorDocument = asyncHandler(async (req, res) => {
  const { vendorId } = req.params;
  const vendor = await adminService.verifyVendorDocument(vendorId, req.body);
  res.status(200).json(
    new ApiResponse(200, vendor, 'Document verification status updated successfully')
  );
});

// Verify all documents
const verifyAllVendorDocuments = asyncHandler(async (req, res) => {
  const { vendorId } = req.params;
  const vendor = await adminService.verifyAllVendorDocuments(vendorId);
  res.status(200).json(
    new ApiResponse(200, vendor, 'All documents verified successfully')
  );
});

// Toggle vendor suspension
const toggleVendorSuspension = asyncHandler(async (req, res) => {
  const { vendorId } = req.params;
  const vendor = await adminService.toggleVendorSuspension(vendorId, req.body);
  res.status(200).json(
    new ApiResponse(200, vendor, `Vendor ${req.body.isSuspended ? 'suspended' : 'activated'} successfully`)
  );
});

// Get eligible vendors
const getEligibleVendors = asyncHandler(async (req, res) => {
  const vendors = await adminService.getEligibleVendors();
  res.status(200).json(
    new ApiResponse(200, vendors, 'Eligible vendors fetched successfully')
  );
});

const rejectVendorAccount = asyncHandler(async (req, res) => {
  const { vendorId } = req.params;
  const vendor = await adminService.rejectVendorAccount(vendorId, req.body);
  res.status(200).json(
    new ApiResponse(200, vendor, 'Vendor account rejected successfully')
  );
});

// Global Settings management
const getGlobalSettings = asyncHandler(async (req, res) => {
  const settings = await adminService.getGlobalSettings();
  res.status(200).json(
    new ApiResponse(200, settings, 'Global settings retrieved successfully')
  );
});

const updateGlobalSettings = asyncHandler(async (req, res) => {
  const adminId = req.user.id;
  const settings = await adminService.updateGlobalSettings(req.body, adminId);
  res.status(200).json(
    new ApiResponse(200, settings, 'Global settings updated successfully')
  );
});

// Membership Pricing Management
const getMembershipPricing = asyncHandler(async (req, res) => {
  const adminService = require('./admin.service');
  const pricing = await adminService.getMembershipPricing();
  res.status(200).json(
    new ApiResponse(200, pricing, 'Membership pricing retrieved successfully')
  );
});

const updateMembershipPricing = asyncHandler(async (req, res) => {
  const adminId = req.user.id;
  const adminService = require('./admin.service');
  const pricing = await adminService.updateMembershipPricing(req.body, adminId);
  res.status(200).json(
    new ApiResponse(200, pricing, 'Membership pricing updated successfully')
  );
});

// Get all bookings
const getAllBookings = asyncHandler(async (req, res) => {
  const adminService = require('./admin.service');
  const result = await adminService.getAllBookings(req.query);
  res.status(200).json(
    new ApiResponse(200, result, 'Bookings retrieved successfully')
  );
});

const getBookingDetails = asyncHandler(async (req, res) => {
  const adminService = require('./admin.service');
  const result = await adminService.getBookingDetails(req.params.id);
  res.status(200).json(
    new ApiResponse(200, result, 'Booking details retrieved successfully')
  );
});

const exportBookings = asyncHandler(async (req, res) => {
  const adminService = require('./admin.service');
  const csv = await adminService.exportBookingsCSV(req.query);

  res.header('Content-Type', 'text/csv');
  res.attachment(`bookings_export_${new Date().toISOString().split('T')[0]}.csv`);
  res.status(200).send(csv);
});


const getVendorPaymentHistory = asyncHandler(async (req, res) => {
  const { vendorId } = req.params;
  const adminService = require('./admin.service');
  const history = await adminService.getVendorPaymentHistory(vendorId);
  res.status(200).json(
    new ApiResponse(200, history, 'Vendor payment history retrieved successfully')
  );
});


// Get global transactions
const getGlobalTransactions = asyncHandler(async (req, res) => {
  const adminService = require('./admin.service');
  const result = await adminService.getGlobalTransactions(req.query);
  res.status(200).json(
    new ApiResponse(200, result, 'Global transactions retrieved successfully')
  );
});

module.exports = {
  getDashboard,
  getUsers,
  updateUserStatus,
  deleteUser,
  createCreditPlan,
  getCreditPlans,
  updateCreditPlan,
  deleteCreditPlan,
  verifyVendor,
  verifyVendorDocument,
  verifyAllVendorDocuments,
  toggleVendorSuspension,
  rejectVendorAccount,
  getEligibleVendors,
  getGlobalSettings,
  updateGlobalSettings,
  getMembershipPricing,
  updateMembershipPricing,
  getAllBookings,
  getBookingDetails,
  exportBookings,
  getVendorPaymentHistory,
  getGlobalTransactions
};
