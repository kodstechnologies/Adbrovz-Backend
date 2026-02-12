const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const auditService = require('../../services/audit.service');

// Get audit logs for a user
const getUserAuditLogs = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { limit = 50, skip = 0, action } = req.query;

  const logs = await auditService.getUserAuditLogs(userId, {
    limit: parseInt(limit, 10),
    skip: parseInt(skip, 10),
    action,
  });

  res.status(200).json(
    new ApiResponse(200, logs, 'Audit logs retrieved successfully')
  );
});

// Get audit logs by action type
const getAuditLogsByAction = asyncHandler(async (req, res) => {
  const { action } = req.params;
  const { limit = 100, skip = 0, startDate, endDate } = req.query;

  const logs = await auditService.getAuditLogsByAction(action, {
    limit: parseInt(limit, 10),
    skip: parseInt(skip, 10),
    startDate,
    endDate,
  });

  res.status(200).json(
    new ApiResponse(200, logs, 'Audit logs retrieved successfully')
  );
});

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
  const { includeInactive = 'true' } = req.query;
  const plans = await adminService.getCreditPlans(includeInactive === 'true');
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

module.exports = {
  getDashboard,
  getUsers,
  updateUserStatus,
  getUserAuditLogs,
  getAuditLogsByAction,
  createCreditPlan,
  getCreditPlans,
  updateCreditPlan,
  deleteCreditPlan,
};
