const mongoose = require('mongoose');
require('dotenv').config();
const Category = require('../src/models/Category.model');
const Subcategory = require('../src/models/Subcategory.model');
const Service = require('../src/models/Service.model');

async function addData() {
    try {
        console.log('Connecting to:', process.env.MONGODB_URI);
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected successfully!');

        const timestamp = Date.now();

        // 1. Create Category
        const category = await Category.create({
            name: '[PROD_CHECK] Category ' + timestamp,
            description: 'Temporary category for production verification',
            isActive: true
        });
        console.log('Created Category ID:', category._id);

        // 2. Create Subcategory
        const subcategory = await Subcategory.create({
            name: '[PROD_CHECK] Subcategory ' + timestamp,
            category: category._id,
            description: 'Temporary subcategory for production verification',
            isActive: true
        });
        console.log('Created Subcategory ID:', subcategory._id);

        // 3. Create Service
        const service = await Service.create({
            title: '[PROD_CHECK] Service ' + timestamp,
            description: 'Temporary service for production verification',
            category: category._id,
            subcategory: subcategory._id,
            serviceCharge: 100,
            bookingPrice: 50,
            isActive: true
        });
        console.log('Created Service ID:', service._id);

        console.log('\n--- VERIFICATION DATA ---');
        console.log(`Category: ${category.name}`);
        console.log(`Subcategory: ${subcategory.name}`);
        console.log(`Service: ${service.title}`);
        console.log('------------------------');
        console.log('Data successfully stored in production DB.');

    } catch (err) {
        console.error('ERROR during data insertion:', err.message);
    } finally {
        await mongoose.connection.close();
        process.exit();
    }
}

addData();
