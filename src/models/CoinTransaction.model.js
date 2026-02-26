const mongoose = require('mongoose');

const coinTransactionSchema = new mongoose.Schema(
    {
        targetId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            refPath: 'targetModel',
        },
        targetModel: {
            type: String,
            required: true,
            enum: ['User', 'Vendor'],
        },
        amount: {
            type: Number,
            required: true,
        },
        type: {
            type: String,
            enum: ['credit', 'debit'],
            required: true,
        },
        purpose: {
            type: String,
            required: true,
            // 'signup_bonus', 'mass_credit', 'booking_payment', 'referral', 'manual_adjustment'
        },
        performedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
        },
        description: {
            type: String,
        },
        balanceAfter: {
            type: Number,
        }
    },
    {
        timestamps: true,
    }
);

// Indexes
coinTransactionSchema.index({ targetId: 1, createdAt: -1 });
coinTransactionSchema.index({ targetModel: 1, type: 1 });
coinTransactionSchema.index({ purpose: 1 });

const CoinTransaction = mongoose.model('CoinTransaction', coinTransactionSchema);

module.exports = CoinTransaction;
