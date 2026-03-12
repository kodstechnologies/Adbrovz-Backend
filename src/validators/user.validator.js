const Joi = require('joi');
const validate = require('../middlewares/validation.middleware');

// Update profile schema
const updateProfileSchema = Joi.object({
  name: Joi.string()
    .trim()
    .min(2)
    .max(50)
    .optional()
    .messages({
      'string.min': 'Name must be at least 2 characters',
      'string.max': 'Name must not exceed 50 characters',
    }),
  email: Joi.string()
    .email()
    .optional()
    .messages({
      'string.email': 'Invalid email format',
    }),
  // Accept both naming conventions from mobile apps
  phoneNumber: Joi.string().trim().optional(),
  mobileNumber: Joi.string().trim().optional(),
  // Image URL (set by cloudinary middleware or passed as a URL string)
  photo: Joi.string().optional(),
  image: Joi.string().optional(),
});

module.exports = {
  validateUpdateProfile: validate(updateProfileSchema, 'body'),
};
