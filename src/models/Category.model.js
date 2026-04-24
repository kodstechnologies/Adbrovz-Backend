const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    icon: {
      type: String,
    },
    serviceRenewalCharge: {
        type: Number,
        default: 0
    },
    renewalCharge: {
        type: Number,
        default: 0
    },
    order: {
      type: Number,
      default: 0,
    },
    slotStartTime: {
        type: String,
      default: '08:00',
    },
    slotEndTime: {
      type: String,
      default: '20:00',
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
    membershipRenewalCharge: {
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
categorySchema.index({ order: 1 });

const Category = mongoose.model('Category', categorySchema);

module.exports = Category;

