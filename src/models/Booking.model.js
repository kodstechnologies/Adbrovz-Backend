const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema(
  {
    bookingID: {
      type: String,
      unique: true,
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
    },
    services: [{
      service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
      quantity: { type: Number, default: 1 },
      adminPrice: { type: Number },
      vendorPrice: { type: Number },
      finalPrice: { type: Number },
      isPriceConfirmed: { type: Boolean, default: false },
    }],
    status: {
      type: String,
      enum: [
        'pending_acceptance',
        'pending',
        'on_the_way',
        'arrived',
        'ongoing',
        'completed',
        'cancelled',
      ],
      default: 'pending_acceptance',
    },
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
    payment: {
      method: {
        type: String,
        enum: ['cash', 'upi', 'other'],
      },
      status: {
        type: String,
        enum: ['pending', 'completed', 'refunded'],
        default: 'pending',
      },
      razorpayOrderId: { type: String },
      razorpayPaymentId: { type: String },
    },
    otp: {
      startOTP: { type: String },
      completionOTP: { type: String },
    },
    cancellation: {
      cancelledBy: {
        type: String,
        enum: ['user', 'vendor', 'system'],
      },
      reason: { type: String },
      cancelledAt: { type: Date },
      travelChargeApplied: { type: Boolean, default: false },
    },
    rescheduleCount: {
      type: Number,
      default: 0,
    },
    cancelCount: {
      type: Number,
      default: 0,
    },
    vendorArrivedAt: {
      type: Date,
    },
    workStartedAt: {
      type: Date,
    },
    workCompletedAt: {
      type: Date,
    },
    rating: {
      value: { type: Number, min: 1, max: 5 },
      review: { type: String },
      ratedAt: { type: Date },
    },
    priceConfirmationTimeout: {
      type: Date,
    },
    gracePeriodEnd: {
      type: Date,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
// Note: bookingID already has index from unique: true
bookingSchema.index({ user: 1, createdAt: -1 });
bookingSchema.index({ vendor: 1, createdAt: -1 });
bookingSchema.index({ status: 1, scheduledDate: 1 });
bookingSchema.index({ scheduledDate: 1, scheduledTime: 1 });

const Booking = mongoose.model('Booking', bookingSchema);

module.exports = Booking;

