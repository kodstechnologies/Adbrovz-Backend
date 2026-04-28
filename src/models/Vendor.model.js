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
    selectedServiceTypes: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceType',
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
      membershipFee: { type: Number },
      serviceFee: { type: Number },
      gstAmount: { type: Number },
      totalAmount: { type: Number },
      subtotal: { type: Number },
      fee: { type: Number },
      durationMonths: { type: Number, default: 3 },
      startDate: { type: Date },
      expiryDate: { type: Date },
    },
    serviceRenewal: {
      fee: { type: Number, default: 0 },
      startDate: { type: Date },
      expiryDate: { type: Date },
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
    liveLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0]
      },
      updatedAt: { type: Date }
    },
    isVerified: {
      type: Boolean,
      default: false,
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
    },    lastLogin: {
      type: Date,
    },
    concurrentJobLimit: {
      type: Number,
      default: 3,
    },
    categorySubscriptions: [{
      category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
      subcategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory' }],
      services: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Service' }],
      fee: { type: Number },
      startDate: { type: Date },
      expiryDate: { type: Date },
      status: { type: String, enum: ['ACTIVE', 'EXPIRED'], default: 'ACTIVE' }
    }],
    deletedAt: {
      type: Date,
    },
    deletionRequest: {
      isRequested: { type: Boolean, default: false },
      requestedAt: { type: Date },
      reason: { type: String },
      status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' }
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

        // Add isActive to membership based on expiryDate
        if (ret.membership) {
          ret.membership.isActive = !!(ret.membership.expiryDate && new Date(ret.membership.expiryDate) > new Date());
          
          // Also set planStatus for nested transform results if needed
          const now = new Date();
          const memExp = ret.membership.expiryDate ? new Date(ret.membership.expiryDate) : null;
          const renExp = ret.serviceRenewal?.expiryDate ? new Date(ret.serviceRenewal.expiryDate) : null;
          
          // It's EXPIRED if either the membership expires or (if present) the service renewal expires
          const isMemExpired = memExp ? now > memExp : false;
          const isRenExpired = renExp ? now > renExp : false; // Only mark as expired if it exists and is in the past
          
          if (!memExp) {
            // Check if they have paid but not yet verified (expiryDate is set on verification)
            const hasPaid = ['MEMBERSHIP_PAID', 'PLAN_PAID', 'COMPLETED'].includes(ret.registrationStep);
            ret.membership.planStatus = hasPaid ? 'PAID' : 'UNPAID';
            ret.membership.validity = hasPaid ? 'Pending Review' : 'UNPAID';
          } else if (isMemExpired || isRenExpired) {
             ret.membership.planStatus = 'EXPIRED';
             ret.membership.validity = 'Expired';
          } else {
             ret.membership.planStatus = 'PAID';
             // Show whichever validity is closer to expiring (if renExp exists)
             const memDiff = memExp - now;
             const renDiff = renExp ? renExp - now : Infinity;
             const minDiff = Math.min(memDiff, renDiff);
             const days = Math.ceil(minDiff / (1000 * 60 * 60 * 24));
             ret.membership.validity = days > 0 ? `${days}d remaining` : 'Expired';
          }
          ret.planStatus = (ret.membership && ret.membership.expiryDate && new Date(ret.membership.expiryDate) > new Date()) ? 'PAID' : 'UNPAID';
          if (ret.isVerified) ret.planStatus = 'PAID';
        } else {
          // If no membership object exists at all
          const hasPaid = ['MEMBERSHIP_PAID', 'PLAN_PAID', 'COMPLETED'].includes(ret.registrationStep) || ret.isVerified;
          ret.planStatus = hasPaid ? 'PAID' : 'UNPAID';
        }

        // Add top-level planValidity for table columns
        const memExp = ret.membership?.expiryDate ? new Date(ret.membership.expiryDate) : null;
        const renExp = ret.serviceRenewal?.expiryDate ? new Date(ret.serviceRenewal.expiryDate) : null;
        const now = new Date();
        
        if (!memExp) {
            const hasPaid = ['MEMBERSHIP_PAID', 'PLAN_PAID', 'COMPLETED'].includes(ret.registrationStep) || ret.isVerified;
            ret.planValidity = hasPaid ? 'Pending Review' : 'UNPAID';
        } else {
            const isMemExpired = now > memExp;
            const isRenExpired = renExp ? now > renExp : false;
            if (isMemExpired || isRenExpired) {
                ret.planValidity = 'Expired';
            } else {
                const memDiff = memExp - now;
                const renDiff = renExp ? renExp - now : Infinity;
                const minDiff = Math.min(memDiff, renDiff);
                const days = Math.ceil(minDiff / (1000 * 60 * 60 * 24));
                ret.planValidity = days > 0 ? `${days}d remaining` : 'Expired';
            }
        }

        // Add status to categorySubscriptions
        if (ret.categorySubscriptions && Array.isArray(ret.categorySubscriptions)) {
          ret.categorySubscriptions = ret.categorySubscriptions.map(sub => {
            const exp = sub.expiryDate ? new Date(sub.expiryDate) : null;
            const isExpired = exp ? new Date() > exp : false;
            let validity = 'N/A';
            if (exp) {
              const diff = exp - new Date();
              const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
              validity = days > 0 ? `${days}d remaining` : 'Expired';
            }
            return {
              ...sub,
              isActive: !isExpired,
              validity
            };
          });
        }

        delete ret.__v;
        return ret;
      }
    },
    toObject: { virtuals: true },
  }
);

// Consolidated status virtual for UI consistency (very robust)
vendorSchema.virtual('status').get(function () {
  if (this.deletedAt) return 'DELETED';
  if (this.deletionRequest?.isRequested && this.deletionRequest?.status === 'PENDING') return 'DELETION_REQUESTED';
  if (this.isSuspended) return 'SUSPENDED';
  if (this.isBlocked) return 'BLOCKED';
  if (this.isVerified) return 'VERIFIED';
  
  // High Priority: Check if ANY document is rejected (handles all case variations)
  const docTypes = ['photo', 'idProof', 'addressProof', 'workProof', 'bankProof', 'policeVerification'];
  const hasOneRejected = docTypes.some(type => {
      const d = this.documents?.[type];
      const s = (d && typeof d === 'object') ? (d.status || '').toLowerCase() : String(d || '').toLowerCase();
      return s.trim().startsWith('reject');
  });

  const topLevelRejection = (this.documentStatus || '').toLowerCase().startsWith('reject');
  if (hasOneRejected || topLevelRejection) return 'REJECTED';
  
  // If they have completed signup but not verified/rejected, they are in pending state
  if (['COMPLETED', 'SIGNUP_COMPLETED', 'MEMBERSHIP_PAID', 'PLAN_PAID'].includes(this.registrationStep)) {
    return 'PENDING';
  }
  
  return 'PENDING'; // Default to a clean PENDING status
});

// Subscription/Plan status virtual
vendorSchema.virtual('planStatus').get(function () {
  const now = new Date();
  const memExp = this.membership?.expiryDate ? new Date(this.membership.expiryDate) : null;
  const renExp = this.serviceRenewal?.expiryDate ? new Date(this.serviceRenewal.expiryDate) : null;
  
  if (!memExp) {
    const hasPaid = ['MEMBERSHIP_PAID', 'PLAN_PAID', 'COMPLETED'].includes(this.registrationStep);
    return hasPaid ? 'PAID' : 'UNPAID';
  }
  
  const isMemExpired = now > memExp;
  const isRenExpired = renExp ? now > renExp : false;
  
  if (isMemExpired || isRenExpired) return 'EXPIRED';
  return 'PAID';
});

// Photo virtual mapping to document photo
vendorSchema.virtual('photo').get(function () {
  return this.documents?.photo?.url || '';
});

// Indexes
// Note: vendorID and phoneNumber already have indexes from unique: true
vendorSchema.index({ workCity: 1 });
vendorSchema.index({ 'membership.expiryDate': 1 });
vendorSchema.index({ createdAt: -1 });
vendorSchema.index({ liveLocation: '2dsphere' });

const Vendor = mongoose.model('Vendor', vendorSchema);

module.exports = Vendor;

