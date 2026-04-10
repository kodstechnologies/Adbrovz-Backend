const mongoose = require('mongoose');
const config = require('../config/env');
const vendorService = require('../modules/vendor/vendor.service');
const Category = require('../models/Category.model');
const PaymentRecord = require('../models/PaymentRecord.model');

async function verify() {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to DB');

        const vendorId = '698d5d086fdda799ff8c289a';
        const categoryId = '698d5eef6fdda799ff8c28ab';

        console.log('--- Testing getAddCategoryFeeDetails ---');
        const feeDetails = await vendorService.getAddCategoryFeeDetails(vendorId, { categoryId });
        console.log('Fee Details:', JSON.stringify(feeDetails, null, 2));

        console.log('\n--- Testing createAddCategoryOrder (with mock charge) ---');
        // Temporarily set a charge to allow order creation
        await Category.findByIdAndUpdate(categoryId, { membershipCharge: 100 });
        
        try {
            const orderResult = await vendorService.createAddCategoryOrder(vendorId, { categoryId });
            console.log('Order Result:', JSON.stringify(orderResult, null, 2));

            // Verify PaymentRecord was created
            const record = await PaymentRecord.findOne({ orderId: orderResult.razorpayOrder.id });
            console.log('Created PaymentRecord:', record ? 'Yes' : 'No');
            if (record) {
                console.log('Purpose:', record.purpose);
                console.log('Amount:', record.amount);
            }
        } catch (err) {
            console.error('Order Creation Failed:', err.message);
        } finally {
            // Revert mock charge
            await Category.findByIdAndUpdate(categoryId, { membershipCharge: 0 });
        }

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from DB');
    }
}

verify();
