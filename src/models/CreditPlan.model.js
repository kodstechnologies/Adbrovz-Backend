const mongoose = require('mongoose');

const creditPlanSchema = new mongoose.Schema(
    {
        name: {
            type: String, // 'Basic', 'Pro', 'Elite'
            required: true,
            unique: true,
        },
        price: {
            type: Number,
            required: true,
        },
        validityDays: {
            type: Number,
            required: true,
            default: 30,
        },
        dailyLimit: {
            type: Number,
            required: true,
            default: 5,
        },
        description: {
            type: String,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
    }
);

const CreditPlan = mongoose.model('CreditPlan', creditPlanSchema);

module.exports = CreditPlan;
