const mongoose = require('mongoose');

const globalConfigSchema = new mongoose.Schema(
    {
        key: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
        value: {
            type: mongoose.Schema.Types.Mixed,
            required: true,
        },
        description: {
            type: String,
            trim: true,
        },
        lastUpdatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin',
        },
    },
    {
        timestamps: true,
    }
);

// Indexes
globalConfigSchema.index({ key: 1 });

const GlobalConfig = mongoose.model('GlobalConfig', globalConfigSchema);

module.exports = GlobalConfig;
