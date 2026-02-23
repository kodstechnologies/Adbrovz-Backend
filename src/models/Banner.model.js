const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: true,
            trim: true,
        },
        image: {
            type: String,
            required: true,
        },
        description: {
            type: String,
            trim: true,
        },
        type: {
            type: String,
            enum: ['user', 'vendor'],
            default: 'user',
        },
        category: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Category',
            required: function () {
                return this.type === 'user';
            },
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
bannerSchema.index({ isActive: 1, order: 1 });

const Banner = mongoose.model('Banner', bannerSchema);

module.exports = Banner;
