require('dotenv').config();
const mongoose = require('mongoose');
const Category = require('../models/Category.model');
const Subcategory = require('../models/Subcategory.model');
const Service = require('../models/Service.model');
const config = require('../config/env');

const seedData = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to MongoDB');

        // 1. Create 5 Categories
        const categories = [];
        for (let i = 1; i <= 5; i++) {
            const category = await Category.create({
                name: `Test Category ${i}`,
                description: `Description for Test Category ${i} - detailed text here.`,
                icon: `uploads/services/icon-cat-${i}.jpg`, // Dummy path
                membershipFee: 100 * i,
                order: i,
                isActive: true
            });
            categories.push(category);
            console.log(`Created Category: ${category.name}`);
        }

        // 2. Create 5 Subcategories (one for each category)
        const subcategories = [];
        for (let i = 0; i < 5; i++) {
            const subcategory = await Subcategory.create({
                name: `Test Subcategory ${i + 1}`,
                category: categories[i]._id,
                icon: `uploads/services/icon-sub-${i + 1}.jpg`, // Dummy path
                description: `Description for Test Subcategory ${i + 1}`,
                isActive: true,
                order: i + 1,
                price: 50 * (i + 1)
            });
            subcategories.push(subcategory);
            console.log(`Created Subcategory: ${subcategory.name}`);
        }

        // 3. Create 5 Services (one for each subcategory)
        for (let i = 0; i < 5; i++) {
            await Service.create({
                title: `Test Service ${i + 1}`,
                description: `Full description for Test Service ${i + 1}. This service includes all necessary checks and balances.`,
                photo: `uploads/services/service-${i + 1}.jpg`, // Dummy path
                moreInfo: `Extra information about Test Service ${i + 1}`,
                category: categories[i]._id,
                subcategory: subcategories[i]._id,
                adminPrice: 500 * (i + 1),
                isAdminPriced: true,
                approxCompletionTime: 60,
                isActive: true,
                quantityEnabled: true,
                priceAdjustmentEnabled: true
            });
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
