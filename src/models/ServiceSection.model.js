const mongoose = require('mongoose');

const serviceSectionSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: true,
            trim: true,
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
        limit: {
            type: Number,
            default: 5,
            min: 1,
            max: 20,
        },
        order: {
            type: Number,
            default: 0,
        },
        isActive: {
            type: Boolean,
            default: true,
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
serviceSectionSchema.index({ isActive: 1, order: 1 });

const ServiceSection = mongoose.model('ServiceSection', serviceSectionSchema);

module.exports = ServiceSection;
