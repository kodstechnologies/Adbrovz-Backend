const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema(
  {
    leadID: {
      type: String,
      unique: true,
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    services: [{
      service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
      quantity: { type: Number, default: 1 },
      adminPrice: { type: Number },
      vendorPrice: { type: Number },
      finalPrice: { type: Number },
      isPriceConfirmed: { type: Boolean, default: false },
    }],
    scheduledDate: {
      type: Date,
      required: true,
    },
    scheduledTime: {
      type: String, // HH:MM:SS format
      required: true,
    },
    location: {
      address: { type: String, required: true },
      latitude: { type: Number },
      longitude: { type: Number },
      pincode: { type: String },
    },
    pricing: {
      basePrice: { type: Number, default: 0 },
      travelCharge: { type: Number, default: 0 },
      additionalCharges: { type: Number, default: 0 },
      totalPrice: { type: Number, default: 0 },
    },
    rejectedVendors: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
    }],
    status: {
      type: String,
      default: 'searching',
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    expireAt: {
      type: Date,
      default: () => new Date(Date.now() + 15 * 60 * 1000), // Default 15 mins TTL
      index: { expires: 0 } // TTL index
    }
  },
  {
    timestamps: true,
  }
);

const Lead = mongoose.model('Lead', leadSchema);

module.exports = Lead;
