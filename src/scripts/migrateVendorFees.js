require('dotenv').config();
const mongoose = require('mongoose');
const Vendor = require('../models/Vendor.model');
const PaymentRecord = require('../models/PaymentRecord.model');
const CreditPlan = require('../models/CreditPlan.model');
const config = require('../config/env');

const migrate = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to MongoDB');

        const totalVendors = await Vendor.countDocuments({});
        console.log(`Total vendors in database: ${totalVendors}`);

        const sample = await Vendor.findOne({ 'membership': { $exists: true } });
        if (sample) {
            console.log('Sample vendor membership field:', JSON.stringify(sample.membership, null, 2));
        } else {
            console.log('No vendors with a membership field found.');
        }

        const vendors = await Vendor.find({ 'membership.membershipFee': { $exists: true, $gt: 0 } });
        console.log(`Found ${vendors.length} vendors with membership.membershipFee > 0.`);

        let updatedCount = 0;

        for (const vendor of vendors) {
            // Find the completed payment record for membership
            const payment = await PaymentRecord.findOne({
                vendor: vendor._id,
                status: 'COMPLETED',
                purpose: { $in: ['MEMBERSHIP_PURCHASE', 'MEMBERSHIP_RENEWAL'] }
            }).sort({ createdAt: -1 });

            let basePlanFee = null;
            let serviceSelectionsTotal = 0;

            if (payment && payment.metadata) {
                basePlanFee = payment.metadata.basePlanFee;
                serviceSelectionsTotal = payment.metadata.serviceSelectionsTotal || 0;
            }

            // Fallback: If no metadata but has a plan ID, resolve plan price
            if (basePlanFee === null && vendor.membership?.membershipId) {
                const plan = await CreditPlan.findById(vendor.membership.membershipId);
                if (plan) {
                    basePlanFee = plan.price;
                    const combinedSubtotal = vendor.membership.subtotal || vendor.membership.membershipFee || 0;
                    serviceSelectionsTotal = Math.max(0, combinedSubtotal - basePlanFee);
                }
            }

            if (basePlanFee !== null) {
                console.log(`Updating vendor ${vendor.name} (${vendor.vendorID}): Setting plan fee: ${basePlanFee}, service fee: ${serviceSelectionsTotal}`);
                vendor.membership.membershipFee = basePlanFee;
                vendor.membership.serviceFee = serviceSelectionsTotal;
                if (!vendor.membership.subtotal) {
                    vendor.membership.subtotal = basePlanFee + serviceSelectionsTotal;
                }
                await vendor.save();
                updatedCount++;
            } else {
                console.log(`⚠️ Could not resolve split fee for vendor ${vendor.name} (${vendor.vendorID}), skipping.`);
            }
        }

        console.log(`\n✅ Migration completed! Updated ${updatedCount}/${vendors.length} vendors.`);
        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
};

migrate();
