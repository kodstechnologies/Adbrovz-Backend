const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    photo: {
      type: String,
    },
    moreInfo: {
      type: String,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    subcategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subcategory',
    },
    serviceType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceType',
    },
    serviceCharge: {
      type: Number,
    },
    bookingPrice: {
      type: Number,
      default: 0,
    },
    isAdminPriced: {
      type: Boolean,
      default: false,
    },
    coupon: {
      type: String,
      trim: true,
    },
    discount: {
      type: Number,
      default: 0,
    },
    approxCompletionTime: {
      type: Number, // in minutes
    },
    quantityEnabled: {
      type: Boolean,
      default: true,
    },
    priceAdjustmentEnabled: {
      type: Boolean,
      default: true,
    },
    membershipCharge: {
      type: Number,
      default: 0,
    },
    serviceRenewalCharge: {
      type: Number,
      default: 0,
    },
    membershipRenewalCharge: {
      type: Number,
      default: 0,
    },
    vendorConcurrency: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    },
    toObject: { virtuals: true },
  }
);

// Pre-save hook to set isAdminPriced automatically
serviceSchema.pre('save', function (next) {
  if (this.serviceCharge !== undefined && this.serviceCharge !== null && this.serviceCharge > 0) {
    this.isAdminPriced = true;
  } else {
    this.isAdminPriced = false;
    this.serviceCharge = 0; // Normalize to 0 if not priced
  }
  next();
});

// Indexes
serviceSchema.index({ category: 1, subcategory: 1, serviceType: 1 });

const Service = mongoose.model('Service', serviceSchema);

module.exports = Service;

