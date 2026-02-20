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
  photo: Joi.string()
    .uri()
    .optional(),
  image: Joi.string()
    .uri()
    .optional(),
  address: Joi.string().trim().optional(),
  city: Joi.string().trim().optional(),
  state: Joi.string().trim().optional(),
  zipcode: Joi.string().trim().optional(),
  country: Joi.string().trim().optional(),
  mobileNumber: Joi.string().trim().optional(),
});

module.exports = {
  validateUpdateProfile: validate(updateProfileSchema, 'body'),
};
