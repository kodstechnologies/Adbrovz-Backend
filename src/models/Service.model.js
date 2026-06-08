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
    timeSlots: [{
      _id: false,
      startTime: { type: String, required: true }, // HH:MM format
      endTime: { type: String, required: true },   // HH:MM format
      label: { type: String },                    // e.g. "Morning Slot"
      isActive: { type: Boolean, default: true }
    }],
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

// ── Helper: compute total hierarchical price for a (populated) service ──
const computeTotalHierarchicalPrice = (service) => {
  const categoryPrice =
    service.category && typeof service.category === 'object'
      ? (service.category.bookingPrice || 0)
      : 0;
  const subcategoryPrice =
    service.subcategory && typeof service.subcategory === 'object'
      ? (service.subcategory.bookingPrice || 0)
      : 0;
  const serviceTypePrice =
    service.serviceType && typeof service.serviceType === 'object'
      ? (service.serviceType.bookingPrice || 0)
      : 0;
  const servicePrice =
    service.bookingPrice !== undefined && service.bookingPrice !== null
      ? service.bookingPrice
      : (service.serviceCharge || 0);

  return categoryPrice + subcategoryPrice + serviceTypePrice + servicePrice;
};

// Pre-save hook to set isAdminPriced automatically from hierarchy
serviceSchema.pre('save', function (next) {
  const total = computeTotalHierarchicalPrice(this);
  this.isAdminPriced = total > 0;

  if (this.serviceCharge === undefined || this.serviceCharge === null) {
    this.serviceCharge = 0;
  }
  next();
});

// Indexes
serviceSchema.index({ category: 1, subcategory: 1, serviceType: 1 });

const Service = mongoose.model('Service', serviceSchema);

// ── Async helper: update isAdminPriced on all matching services ──
// Called by Category / Subcategory / ServiceType post-save hooks
Service.updateServicesIsAdminPriced = async function (filter) {
  try {
    const services = await Service.find(filter)
      .populate('category', 'bookingPrice')
      .populate('subcategory', 'bookingPrice')
      .populate('serviceType', 'bookingPrice')
      .lean();

    const bulkOps = services.map((s) => {
      const total = computeTotalHierarchicalPrice(s);
      return {
        updateOne: {
          filter: { _id: s._id },
          update: { $set: { isAdminPriced: total > 0 } },
        },
      };
    });

    if (bulkOps.length > 0) {
      await Service.bulkWrite(bulkOps);
    }
  } catch (err) {
    console.error('[Service.updateServicesIsAdminPriced] Error:', err.message);
  }
};

module.exports = Service;

