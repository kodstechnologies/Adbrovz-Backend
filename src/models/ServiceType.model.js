const mongoose = require('mongoose');

const serviceTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    photo: {
      type: String,
      default: null,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    subcategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subcategory',
      required: true,
    },
    serviceCharge: {
      type: Number,
      default: 0,
    },
    bookingPrice: {
      type: Number,
      default: 0,
    },
    coupon: {
      type: String,
      trim: true,
    },
    discount: {
      type: Number,
      default: 0,
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
    order: {
      type: Number,
      default: 0,
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

// Indexes
serviceTypeSchema.index({ subcategory: 1 });
serviceTypeSchema.index({ order: 1 });

const ServiceType = mongoose.model('ServiceType', serviceTypeSchema);

module.exports = ServiceType;
