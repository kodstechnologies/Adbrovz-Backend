const Joi = require('joi');
const validate = require('../middlewares/validation.middleware');

// Phone number pattern (general E.164-like: optional +, 6-15 digits)
const phonePattern = /^\+?\d{6,15}$/;

// User Signup schema
const signupSchema = Joi.object({
  phoneNumber: Joi.string()
    .pattern(phonePattern)
    .required()
    .messages({
      'string.pattern.base': 'Invalid phone number format.',
      'any.required': 'Phone number is required',
    }),
  name: Joi.string()
    .trim()
    .min(2)
    .max(50)
    .required()
    .messages({
      'string.min': 'Name must be at least 2 characters',
      'string.max': 'Name must not exceed 50 characters',
      'any.required': 'Name is required',
    }),
  email: Joi.string()
    .email()
    .optional()
    .allow('', null)
    .messages({
      'string.email': 'Invalid email format',
    }),
  pin: Joi.string()
    .length(4)
    .pattern(/^\d+$/)
    .required()
    .messages({
      'string.length': 'PIN must be exactly 4 digits',
      'string.pattern.base': 'PIN must contain only numbers',
      'any.required': 'PIN is required',
    }),
  confirmPin: Joi.string()
    .valid(Joi.ref('pin'))
    .required()
    .messages({
      'any.only': 'PINs do not match',
      'any.required': 'Confirm PIN is required',
    }),
  acceptedPolicies: Joi.boolean()
    .valid(true)
    .required()
    .messages({
      'any.only': 'You must accept the terms and privacy policy',
      'any.required': 'Policies acceptance is required',
    }),
});

// Initiate User Signup schema
const initiateUserSignupSchema = Joi.object({
  phoneNumber: Joi.string()
    .pattern(phonePattern)
    .required()
    .messages({
      'string.pattern.base': 'Invalid phone number format.',
      'any.required': 'Phone number is required',
    }),
  name: Joi.string()
    .trim()
    .min(2)
    .max(50)
    .required()
    .messages({
      'any.required': 'Name is required',
    }),
  email: Joi.string()
    .email()
    .optional()
    .allow('', null),
});

// Complete User Signup schema
const completeUserSignupSchema = Joi.object({
  signupId: Joi.string()
    .required()
    .messages({
      'any.required': 'Signup ID is required',
    }),
  pin: Joi.string()
    .length(4)
    .pattern(/^\d+$/)
    .required()
    .messages({
      'string.length': 'PIN must be exactly 4 digits',
      'any.required': 'PIN is required',
    }),
  confirmPin: Joi.string()
    .valid(Joi.ref('pin'))
    .required()
    .messages({
      'any.only': 'PINs do not match',
    }),
  acceptedPolicies: Joi.boolean()
    .valid(true)
    .required()
    .messages({
      'any.only': 'You must accept the terms and privacy policy',
    }),
});

// Vendor Signup schema
const vendorSignupSchema = Joi.object({
  phoneNumber: Joi.string()
    .pattern(phonePattern)
    .required(),
  name: Joi.string()
    .trim()
    .min(2)
    .required(),
  email: Joi.string()
    .email()
    .optional()
    .allow('', null),
  pin: Joi.string()
    .length(4)
    .pattern(/^\d+$/)
    .required(),
  confirmPin: Joi.string()
    .valid(Joi.ref('pin'))
    .required(),
  identityNumber: Joi.string().required(),
  photo: Joi.string().optional().allow('', null),
  idProof: Joi.string().optional().allow('', null),
  addressProof: Joi.string().optional().allow('', null),
  workState: Joi.string().required(),
  workCity: Joi.string().required(),
  workPincodes: Joi.array().items(Joi.string()).optional(),
  acceptedTerms: Joi.boolean().valid(true).required(),
  acceptedPrivacyPolicy: Joi.boolean().valid(true).required(),
});

// Admin Signup schema
const adminSignupSchema = Joi.object({
  username: Joi.string().min(3).required(),
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  confirmPassword: Joi.string().valid(Joi.ref('password')).required(),
});

// Admin Login schema
const adminLoginSchema = Joi.object({
  username: Joi.string().required(),
  password: Joi.string().required(),
});

// Login schema (Generic)
const loginSchema = Joi.object({
  phoneNumber: Joi.string()
    .pattern(phonePattern)
    .required()
    .messages({
      'string.pattern.base': 'Invalid phone number format.',
      'any.required': 'Phone number is required',
    }),
  pin: Joi.string()
    .length(4)
    .pattern(/^\d+$/)
    .required()
    .messages({
      'string.length': 'PIN must be exactly 4 digits',
      'string.pattern.base': 'PIN must contain only numbers',
      'any.required': 'PIN is required',
    }),
});

// Initiate Login schema
const initiateLoginSchema = Joi.object({
  phoneNumber: Joi.string()
    .pattern(phonePattern)
    .required(),
  acceptedPolicies: Joi.boolean().optional(),
});

// Complete Login schema
const completeLoginSchema = Joi.object({
  loginId: Joi.string().required(),
  pin: Joi.string().length(4).pattern(/^\d+$/).required(),
});

// OTP verification schema
const otpSchema = Joi.object({
  phoneNumber: Joi.string()
    .pattern(phonePattern)
    .required()
    .messages({
      'string.pattern.base': 'Invalid phone number format.',
      'any.required': 'Phone number is required',
    }),
  otp: Joi.string()
    .optional()
    .allow('', null),
});

// Reset PIN schema (Step 1)
const resetPinSchema = Joi.object({
  phoneNumber: Joi.string()
    .pattern(phonePattern)
    .required()
    .messages({
      'string.pattern.base': 'Invalid phone number format.',
      'any.required': 'Phone number is required',
    }),
  otp: Joi.string()
    .optional()
    .allow('', null),
  newPin: Joi.string()
    .length(4)
    .pattern(/^\d+$/)
    .required()
    .messages({
      'string.length': 'PIN must be exactly 4 digits',
      'string.pattern.base': 'PIN must contain only numbers',
      'any.required': 'New PIN is required',
    }),
  confirmPin: Joi.string()
    .valid(Joi.ref('newPin'))
    .required()
    .messages({
      'any.only': 'PINs do not match',
      'any.required': 'Confirm PIN is required',
    }),
});

// Verify Reset OTP schema (Step 2)
const verifyResetOTPSchema = Joi.object({
  phoneNumber: Joi.string()
    .pattern(phonePattern)
    .required(),
  otp: Joi.string().optional().allow('', null),
});

// Complete Reset PIN schema (Step 3)
const completeResetPINSchema = Joi.object({
  resetId: Joi.string().required(),
  newPin: Joi.string().length(4).pattern(/^\d+$/).required(),
  confirmPin: Joi.string().valid(Joi.ref('newPin')).required(),
  acceptedPolicies: Joi.boolean().optional(),
});

// Export validation middlewares
module.exports = {
  validateUserSignup: validate(signupSchema, 'body'),
  validateInitiateUserSignup: validate(initiateUserSignupSchema, 'body'),
  validateCompleteUserSignup: validate(completeUserSignupSchema, 'body'),
  validateVendorSignup: validate(vendorSignupSchema, 'body'),
  validateAdminSignup: validate(adminSignupSchema, 'body'),
  validateAdminLogin: validate(adminLoginSchema, 'body'),
  validateLogin: validate(loginSchema, 'body'),
  validateInitiateLogin: validate(initiateLoginSchema, 'body'),
  validateCompleteLogin: validate(completeLoginSchema, 'body'),
  validateOTP: validate(otpSchema, 'body'),
  validateResetPIN: validate(resetPinSchema, 'body'),
  validateVerifyResetOTP: validate(verifyResetOTPSchema, 'body'),
  validateCompleteResetPIN: validate(completeResetPINSchema, 'body'),
};
