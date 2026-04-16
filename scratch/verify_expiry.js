
const mongoose = require('mongoose');
const Vendor = require('./src/models/Vendor.model');
const Category = require('./src/models/Category.model');
const config = require('./src/config/env');
const vendorService = require('./src/modules/vendor/vendor.service');

async function test() {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to DB');

        const vendor = await Vendor.findOne({ phoneNumber: '9876543210' }); // Use a test vendor
        if (!vendor) {
            console.log('Test vendor not found. Please ensure a vendor with 9876543210 exists.');
            return;
        }

        console.log('Vendor before:', vendor.categorySubscriptions);

        // Mock a category purchase
        const category = await Category.findOne();
        if (!category) {
            console.log('No categories found to test.');
            return;
        }

        console.log(`Testing with Category: ${category.name} (${category._id})`);

        // We can't easily call verifyAddCategoryPayment without a real razorpay order
        // but we can test the logic by manually invoking what it does or calling it with isAdminBypass

        const result = await vendorService.verifyAddCategoryPayment(vendor._id, {
            isAdminBypass: true,
            categoryId: category._id,
            razorpay_order_id: 'test_order_' + Date.now(),
            razorpay_payment_id: 'test_pay_' + Date.now(),
            razorpay_signature: 'test_sig'
        });

        console.log('Result:', result.message);

        const updatedVendor = await Vendor.findById(vendor._id);
        console.log('Vendor after:', updatedVendor.categorySubscriptions);
        
        if (updatedVendor.categorySubscriptions.length > 0) {
            const sub = updatedVendor.categorySubscriptions[updatedVendor.categorySubscriptions.length - 1];
            console.log('Start Date:', sub.startDate);
            console.log('Expiry Date:', sub.expiryDate);
            
            const diffDays = Math.ceil((sub.expiryDate - sub.startDate) / (1000 * 60 * 60 * 24));
            console.log('Duration in days:', diffDays);
        }

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

test();
