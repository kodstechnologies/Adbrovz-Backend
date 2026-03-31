const ApiError = require('../utils/ApiError');
const { verifyToken } = require('../utils/jwt');
const { ROLES } = require('../constants/roles');
const MESSAGES = require('../constants/messages');
const asyncHandler = require('../utils/asyncHandler');

const authenticate = asyncHandler(async (req, res, next) => {
  // Get token from header
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError(401, MESSAGES.AUTH.UNAUTHORIZED);
  }

  const token = authHeader.substring(7);

  // Verify token
  const decoded = verifyToken(token);

  // Attach user info to request
  req.user = decoded;
  req.user.id = decoded.userId || decoded.id || decoded._id;
  
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

