const MESSAGES = {
  // Auth
  AUTH: {
    INVALID_CREDENTIALS: 'Invalid phone number or PIN',
    PIN_LOCKED: 'Account locked due to multiple failed attempts. Please verify with OTP to unlock.',
    PIN_MISMATCH: 'PINs do not match',
    INVALID_OTP: 'Invalid or expired OTP',
    OTP_SENT: 'OTP sent successfully',
    LOGIN_SUCCESS: 'Login successful',
    LOGOUT_SUCCESS: 'Logout successful',
    ACCOUNT_LOCKED: 'Account is locked. Please verify with OTP to unlock.',
    UNAUTHORIZED: 'Unauthorized access',
    TOKEN_EXPIRED: 'Token expired',
    TOKEN_INVALID: 'Invalid token',
    ACCOUNT_NOT_VERIFIED: 'Account not verified. Please complete verification.',
  },

  // User
  USER: {
    NOT_FOUND: 'User not found',
    ALREADY_EXISTS: 'User already exists',
    CREATED: 'User created successfully',
    UPDATED: 'User updated successfully',
    DELETED: 'User account deleted successfully',
    PROFILE_UPDATED: 'Profile updated successfully',
  },

  // Vendor
  VENDOR: {
    NOT_FOUND: 'Vendor not found',
    ALREADY_EXISTS: 'Vendor already exists',
    CREATED: 'Vendor created successfully',
    PENDING_VERIFICATION: 'Vendor account pending verification',
    VERIFIED: 'Vendor verified successfully',
    SUSPENDED: 'Vendor suspended',
    BLOCKED: 'Vendor blocked',
    MEMBERSHIP_EXPIRED: 'Vendor membership expired',
    DAILY_LIMIT_EXCEEDED: 'Daily lead limit reached for your current plan',
    DUTY_OFF: 'Cannot accept booking. Please turn ON duty.',
    GPS_REQUIRED: 'GPS permission required to toggle duty',
  },

  // Booking
  BOOKING: {
    NOT_FOUND: 'Booking not found',
    CREATED: 'Booking created successfully',
    ACCEPTED: 'Booking accepted by vendor',
    CANCELLED: 'Booking cancelled',
    COMPLETED: 'Booking completed',
    PRICE_CONFIRMATION_REQUIRED: 'Price confirmation required before starting service',
    PRICE_CONFIRMED: 'Price confirmed',
    VENDOR_NOT_FOUND: 'No vendors available in your area',
    ALREADY_ACCEPTED: 'Booking already accepted by another vendor',
    CANNOT_CANCEL: 'Cannot cancel booking at this stage',
    MAX_CANCEL_LIMIT: 'Maximum cancellation limit reached',
    MAX_RESCHEDULE_LIMIT: 'Maximum reschedule limit reached',
    OVERLAPPING_BOOKING: 'Vendor has overlapping booking',
    GRACE_PERIOD_EXCEEDED: 'Vendor failed to arrive within grace period',
  },

  // Service
  SERVICE: {
    NOT_FOUND: 'Service not found',
    CREATED: 'Service created successfully',
    UPDATED: 'Service updated successfully',
    DELETED: 'Service deleted successfully',
  },

  // Payment
  PAYMENT: {
    FAILED: 'Payment failed',
    SUCCESS: 'Payment successful',
    PENDING: 'Payment pending',
    REFUNDED: 'Payment refunded',
  },

  // Admin
  ADMIN: {
    NOT_FOUND: 'Admin not found',
    UNAUTHORIZED: 'Admin access required',
    SUPER_ADMIN_REQUIRED: 'Super admin access required',
  },

  // General
  SUCCESS: 'Operation successful',
  ERROR: 'An error occurred',
  VALIDATION_ERROR: 'Validation error',
  NOT_FOUND: 'Resource not found',
  FORBIDDEN: 'Access forbidden',
  SERVER_ERROR: 'Internal server error',
  BAD_REQUEST: 'Bad request',
};

module.exports = MESSAGES;

