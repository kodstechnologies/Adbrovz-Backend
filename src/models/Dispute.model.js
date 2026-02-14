const mongoose = require('mongoose');

const disputeSchema = new mongoose.Schema(
    {
        booking: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Booking',
            required: true,
        },
        raisedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        vendor: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Vendor',
        },
        reason: {
            type: String,
            required: true,
            trim: true,
        },
        description: {
            type: String,
            trim: true,
        },
        status: {
            type: String,
            enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED'],
            default: 'OPEN',
        },
        evidence: [
            {
                type: String, // URL of the uploaded file
            },
        ],
        adminComments: {
            type: String,
            trim: true,
        },
        resolutionNotes: {
            userNote: {
                type: String,
                trim: true,
            },
            vendorNote: {
                type: String,
                trim: true,
            },
        },
        resolvedAt: {
            type: Date,
        },
        resolvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Admin', // Assuming Admin model exists, or just keep ID
        },
    },
    {
        timestamps: true,
    }
);

const Dispute = mongoose.model('Dispute', disputeSchema);

module.exports = Dispute;
