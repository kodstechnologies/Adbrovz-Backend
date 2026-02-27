const mongoose = require('mongoose');
const { ROLES } = require('../constants/roles');

const vendorSchema = new mongoose.Schema(
  {
    vendorID: {
      type: String,
      unique: true,
      required: true,
    },
    coins: {
      type: Number,
      default: 0,
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
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    pin: {
      type: String,
      select: false,
    },
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.VENDOR,
    },
    workState: {
      type: String,
      required: true,
    },
    workCity: {
      type: String,
      required: true,
    },
    address: {
      type: String,
      trim: true,
    },
    zipcode: {
      type: String,
      trim: true,
    },
    country: {
      type: String,
      trim: true,
      default: 'India',
    },
    workPincodes: [{
      type: String,
    }],
    selectedCategories: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
    }],
    selectedSubcategories: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subcategory',
    }],
    selectedServices: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
    }],
    registrationStep: {
      type: String,
      enum: ['SIGNUP', 'PIN_PENDING', 'SERVICES_SELECTED', 'MEMBERSHIP_PAID', 'PLAN_PAID', 'COMPLETED', 'PENDING', 'SIGNUP_COMPLETED'],
      default: 'PENDING',
    },
    tcAcceptance: {
      type: Boolean,
      default: false,
    },
    ppAcceptance: {
      type: Boolean,
      default: false,
    },
    policiesAcceptedAt: {
      type: Date,
    },
    documents: {
      photo: {
        url: { type: String, default: '' },
        status: { type: String, enum: ['pending', 'verified', 'approved', 'rejected'], default: 'pending' },
        reason: { type: String }
      },
      idProof: {
        url: { type: String, default: '' },
        status: { type: String, enum: ['pending', 'verified', 'approved', 'rejected'], default: 'pending' },
        reason: { type: String }
      },
      addressProof: {
        url: { type: String, default: '' },
        status: { type: String, enum: ['pending', 'verified', 'approved', 'rejected'], default: 'pending' },
        reason: { type: String }
      },
      workProof: {
        url: { type: String, default: '' },
        status: { type: String, enum: ['pending', 'verified', 'approved', 'rejected'], default: 'pending' },
        reason: { type: String }
      },
      bankProof: {
        url: { type: String, default: '' },
        status: { type: String, enum: ['pending', 'verified', 'approved', 'rejected'], default: 'pending' },
        reason: { type: String }
      },
      policeVerification: {
        url: { type: String, default: '' },
        status: { type: String, enum: ['pending', 'verified', 'approved', 'rejected'], default: 'pending' },
        reason: { type: String }
      },
    },
    documentStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    membership: {
      category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
      fee: { type: Number },
      durationMonths: { type: Number, default: 3 },
      startDate: { type: Date },
      expiryDate: { type: Date },
      isActive: { type: Boolean, default: false },
    },
    creditPlan: {
      planId: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditPlan' },
      expiryDate: { type: Date },
      dailyLimit: { type: Number, default: 0 },
      dailyLeadsCount: { type: Number, default: 0 },
      lastLeadResetDate: { type: Date },
    },
    performance: {
      totalBookings: { type: Number, default: 0 },
      completedBookings: { type: Number, default: 0 },
      cancelledBookings: { type: Number, default: 0 },
      acceptRatio: { type: Number, default: 0 },
      cancelRatio: { type: Number, default: 0 },
      rating: { type: Number, default: 0 },
      totalRatings: { type: Number, default: 0 },
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    isSuspended: {
      type: Boolean,
      default: false,
    },
    isBlocked: {
      type: Boolean,
      default: false,
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
    concurrentJobLimit: {
      type: Number,
      default: 3,
    },
    deletedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        // Ensure both id and _id are consistently returned as strings
        const stringId = ret._id ? ret._id.toString() : (doc._id ? doc._id.toString() : null);
        ret.id = stringId;
        ret._id = stringId;
        delete ret.__v;
        return ret;
      }
    },
    toObject: { virtuals: true },
  }
);

// Consolidated status virtual
vendorSchema.virtual('status').get(function () {
  if (this.isSuspended) return 'SUSPENDED';
  if (this.isBlocked) return 'BLOCKED';
  if (this.isVerified) return 'ACTIVE';
  if (this.documentStatus === 'rejected') return 'REJECTED';
  if (this.registrationStep === 'COMPLETED' && !this.isVerified) return 'PENDING_VERIFICATION';
  return 'PENDING_DOCS';
});

// Indexes
// Note: vendorID and phoneNumber already have indexes from unique: true
vendorSchema.index({ workCity: 1 });
vendorSchema.index({ 'membership.expiryDate': 1 });
vendorSchema.index({ createdAt: -1 });

const Vendor = mongoose.model('Vendor', vendorSchema);

module.exports = Vendor;

