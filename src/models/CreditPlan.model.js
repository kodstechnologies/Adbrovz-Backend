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
        credits: {
            type: Number,
            required: true,
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
