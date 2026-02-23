const mongoose = require('mongoose');
const { ROLES } = require('../constants/roles');

const adminSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    phoneNumber: {
      type: String,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: [ROLES.ADMIN, ROLES.SUPER_ADMIN],
      default: ROLES.ADMIN,
    },
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLogin: {
      type: Date,
    },
    loginHistory: [{
      timestamp: { type: Date },
      ip: { type: String },
      userAgent: { type: String },
    }],
  },
  {
    timestamps: true,
  }
); 

// Indexes
// Note: username already has index from unique: true
adminSchema.index({ role: 1 });

const Admin = mongoose.model('Admin', adminSchema);

module.exports = Admin;

