const mongoose = require('mongoose');

const paymentRecordSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
    },
    orderId: {
      type: String,
      required: true,
      unique: true,
    },
    paymentId: {
      type: String,
    },
    purpose: {
      type: String,
      enum: ['MEMBERSHIP_RENEWAL', 'SERVICE_RENEWAL', 'MEMBERSHIP_PURCHASE', 'PLAN_PURCHASE', 'CATEGORY_PURCHASE'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    gstAmount: {
      type: Number,
      default: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CreditPlan',
    },
    validityDays: {
      type: Number,
    },
    previousExpiryDate: {
      type: Date,
    },
    newExpiryDate: {
      type: Date,
    },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED'],
      default: 'PENDING',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
paymentRecordSchema.index({ vendor: 1, createdAt: -1 });
paymentRecordSchema.index({ orderId: 1 });
paymentRecordSchema.index({ status: 1 });

const PaymentRecord = mongoose.model('PaymentRecord', paymentRecordSchema);

module.exports = PaymentRecord;
