const ApiError = require('../utils/ApiError');
const { verifyToken } = require('../utils/jwt');
const { ROLES } = require('../constants/roles');
const MESSAGES = require('../constants/messages');
const asyncHandler = require('../utils/asyncHandler');
const User = require('../models/User.model');
const Vendor = require('../models/Vendor.model');

const authenticate = asyncHandler(async (req, res, next) => {
  // Get token from header
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError(401, MESSAGES.AUTH.UNAUTHORIZED);
  }

  const token = authHeader.substring(7);

  // Verify token
  const decoded = verifyToken(token);

  // Session validation: if token contains currentLoginId, verify it matches the DB
  if (decoded.currentLoginId && decoded.userId) {
    const model = decoded.role === 'vendor' ? Vendor : User;
    const user = await model.findById(decoded.userId).select('currentLoginId');
    if (user && user.currentLoginId && user.currentLoginId !== decoded.currentLoginId) {
      throw new ApiError(401, 'Session expired. You have been logged in from another device.');
    }
  }

  // Attach user info to request
  req.user = decoded;
  req.user.id = decoded.userId || decoded.id || decoded._id;
  if (req.user?.role) {
    const normalizedRole = String(req.user.role).toLowerCase().trim();
    req.user.role = normalizedRole === 'vendors' ? ROLES.VENDOR : normalizedRole;
  }
  
  console.log('DEBUG: Authenticated User:', {
    role: req.user.role,
    userId: req.user.id
  });
  next();
});

const authorize = (...roles) => {
  return asyncHandler(async (req, res, next) => {
    if (!req.user) {
      throw new ApiError(401, MESSAGES.AUTH.UNAUTHORIZED);
    }

    if (!roles.includes(req.user.role)) {
      console.log('DEBUG: Authorization Failed', {
        userRole: req.user.role,
        requiredRoles: roles,
        userId: req.user.userId || req.user.id || req.user._id,
        decodedToken: req.user
      });
      throw new ApiError(403, MESSAGES.FORBIDDEN);
    }

    next();
  });
};

const optionalAuth = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      const decoded = verifyToken(token);
      req.user = decoded;
      req.user.id = decoded.userId || decoded.id || decoded._id;
    } catch (error) {
      // Ignore error for optional auth
    }
  }

  next();
});

module.exports = {
  authenticate,
  authorize,
  optionalAuth,
};

