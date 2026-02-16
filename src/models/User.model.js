const mongoose = require('mongoose');
const { ROLES } = require('../constants/roles');

const userSchema = new mongoose.Schema(
  {
    userID: {
      type: String,
      unique: true,
      required: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
    },
    pin: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.USER,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'ACTIVE', 'SUSPENDED'],
      default: 'ACTIVE',
    },
    isLocked: {
      type: Boolean,
      default: false,
    },
    lockUntil: {
      type: Date,
    },
    failedAttempts: {
      type: Number,
      default: 0,
    },
    deviceToken: {
      type: String,
    },
    lastLogin: {
      type: Date,
    },
    deletedAt: {
      type: Date,
    },
    coins: {
      type: Number,
      default: 1000,
    },
    photo: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
// Note: userID and phoneNumber already have indexes from unique: true
userSchema.index({ createdAt: -1 });

// Virtual for checking if account is locked
userSchema.virtual('isAccountLocked').get(function () {
  return !!(this.isLocked && this.lockUntil && this.lockUntil > Date.now());
});

const User = mongoose.model('User', userSchema);

module.exports = User;

