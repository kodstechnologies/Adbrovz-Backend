require('dotenv').config();
const mongoose = require('mongoose');
const Category = require('../models/Category.model');
const Subcategory = require('../models/Subcategory.model');
const Service = require('../models/Service.model');
const config = require('../config/env');

const seedServicesForAllSubcategories = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to MongoDB');

        // Get all subcategories
        const subcategories = await Subcategory.find().populate('category');
        console.log(`Found ${subcategories.length} subcategories`);

        let totalCreated = 0;

        // For each subcategory, create 5 services
        for (const subcategory of subcategories) {
            console.log(`\nProcessing subcategory: ${subcategory.name}`);

            // Check how many services already exist for this subcategory
            const existingCount = await Service.countDocuments({
                subcategory: subcategory._id
            });

            console.log(`  Existing services: ${existingCount}`);

            // Create 5 new services
            for (let i = 1; i <= 5; i++) {
                const serviceNum = existingCount + i;
                await Service.create({
                    title: `${subcategory.name} Service ${serviceNum}`,
                    description: `Professional ${subcategory.name.toLowerCase()} service #${serviceNum}. High quality work guaranteed with experienced professionals.`,
                    photo: `uploads/services/service-${subcategory._id}-${i}.jpg`,
                    moreInfo: `Additional details about ${subcategory.name} Service ${serviceNum}. Includes all necessary materials and expert consultation.`,
                    category: subcategory.category._id,
                    subcategory: subcategory._id,
                    adminPrice: 300 + (i * 100),
                    isAdminPriced: true,
                    approxCompletionTime: 45 + (i * 15),
                    isActive: true,
                    quantityEnabled: true,
                    priceAdjustmentEnabled: true
                });
                totalCreated++;
            }

            console.log(`  Created 5 new services`);
        }

        console.log(`\n✅ Seeding completed! Created ${totalCreated} services across ${subcategories.length} subcategories.`);
        process.exit(0);
    } catch (error) {
        console.error('Error seeding data:', error);
        process.exit(1);
    }
};

seedServicesForAllSubcategories();
