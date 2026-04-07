require('dotenv').config();
const mongoose = require('mongoose');
const Category = require('../models/Category.model');
const Subcategory = require('../models/Subcategory.model');
const ServiceType = require('../models/ServiceType.model');
const Service = require('../models/Service.model');
const config = require('../config/env');

const seedData = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to MongoDB');

        // Clear existing data removed to prevent "dont delete services" issues
        console.log('Upserting seed data safely...');

        // 1. Create 5 Categories
        const categories = [];
        for (let i = 1; i <= 5; i++) {
            const category = await Category.findOneAndUpdate(
                { name: `Test Category ${i}` },
                {
                    name: `Test Category ${i}`,
                    description: `Description for Test Category ${i}`,
                    icon: `uploads/services/icon-cat-${i}.jpg`,
                    adminPrice: 100 * i,
                    coupon: `CAT${i}OFF`,
                    discount: 5 + i,
                    membershipFee: 50 * i,
                    renewalCharge: 25 * i,
                    order: i,
                },
                { upsert: true, new: true }
            );
            categories.push(category);
            console.log(`Created Category: ${category.name}`);
        }

        // 2. Create 5 Subcategories
        const subcategories = [];
        for (let i = 0; i < 5; i++) {
            const subcategory = await Subcategory.findOneAndUpdate(
                { name: `Test Subcategory ${i + 1}` },
                {
                    name: `Test Subcategory ${i + 1}`,
                    category: categories[i]._id,
                    icon: `uploads/services/icon-sub-${i + 1}.jpg`,
                    description: `Description for Test Subcategory ${i + 1}`,
                    adminPrice: 50 * (i + 1),
                    coupon: `SUB${i + 1}OFF`,
                    discount: 2 + i,
                    membershipFee: 25 * (i + 1),
                    order: i + 1,
                    price: 50 * (i + 1)
                },
                { upsert: true, new: true }
            );
            subcategories.push(subcategory);
            console.log(`Created Subcategory: ${subcategory.name}`);
        }

        // 3. Create 5 Service Types
        const serviceTypes = [];
        for (let i = 0; i < 5; i++) {
            const serviceType = await ServiceType.findOneAndUpdate(
                { name: `Test Type ${i + 1}`, subcategory: subcategories[i]._id },
                {
                    name: `Test Type ${i + 1}`,
                    category: categories[i]._id,
                    subcategory: subcategories[i]._id,
                    adminPrice: 20 * (i + 1),
                    coupon: `TYPE${i + 1}OFF`,
                    discount: 1 + i,
                    membershipFee: 10 * (i + 1),
                    order: i + 1
                },
                { upsert: true, new: true }
            );
            serviceTypes.push(serviceType);
            console.log(`Created ServiceType: ${serviceType.name}`);
        }

        // 4. Create 5 Services
        for (let i = 0; i < 5; i++) {
            await Service.findOneAndUpdate(
                { title: `Test Service ${i + 1}` },
                {
                    title: `Test Service ${i + 1}`,
                    description: `Full description for Test Service ${i + 1}`,
                    photo: `uploads/services/service-${i + 1}.jpg`,
                    category: categories[i]._id,
                    subcategory: subcategories[i]._id,
                    serviceType: serviceTypes[i]._id,
                    adminPrice: 500 * (i + 1),
                    isAdminPriced: true,
                    coupon: `SVC${i + 1}OFF`,
                    discount: 10,
                    membershipFee: 100 * (i + 1),
                    approxCompletionTime: 60,
                    quantityEnabled: true,
                    priceAdjustmentEnabled: true
                },
                { upsert: true, new: true }
            );
            console.log(`Created Service: Test Service ${i + 1}`);
        }

        console.log('Seeding completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('Error seeding data:', error);
        process.exit(1);
    }
};

seedData();
