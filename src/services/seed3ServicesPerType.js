require('dotenv').config();
const mongoose = require('mongoose');
const Category = require('../models/Category.model');
const Subcategory = require('../models/Subcategory.model');
const ServiceType = require('../models/ServiceType.model');
const Service = require('../models/Service.model');
const config = require('../config/env');

const seed3ServicesPerType = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to MongoDB');

        // Get all service types
        const serviceTypes = await ServiceType.find().populate('subcategory category');
        console.log(`Found ${serviceTypes.length} service types`);

        let totalCreated = 0;

        // For each service type, create 3 services
        for (const type of serviceTypes) {
            console.log(`\nProcessing service type: ${type.name}`);

            // Check how many services already exist for this service type
            const existingCount = await Service.countDocuments({
                serviceType: type._id
            });

            console.log(`  Existing services: ${existingCount}`);

            // Create 3 new services
            for (let i = 1; i <= 3; i++) {
                const serviceNum = existingCount + i;
                await Service.findOneAndUpdate(
                    { title: `${type.name} Service ${serviceNum}`, serviceType: type._id },
                    {
                        title: `${type.name} Service ${serviceNum}`,
                        description: `Professional ${type.name.toLowerCase()} service #${serviceNum}. High quality work guaranteed with experienced professionals.`,
                        photo: `uploads/services/service-${type._id}-${i}.jpg`,
                        moreInfo: `Additional details about ${type.name} Service ${serviceNum}. Includes all necessary materials and expert consultation.`,
                        category: type.category ? (type.category._id || type.category) : undefined,
                        subcategory: type.subcategory ? (type.subcategory._id || type.subcategory) : undefined,
                        serviceType: type._id,
                        serviceCharge: 300 + (i * 100),
                        isAdminPriced: true,
                        coupon: `TYPE${serviceNum}OFF`,
                        discount: 5,
                        membershipCharge: 50,
                        serviceRenewalCharge: 20,
                        membershipRenewalCharge: 20,
                        approxCompletionTime: 45 + (i * 15),
                        quantityEnabled: true,
                        priceAdjustmentEnabled: true
                    },
                    { upsert: true, new: true }
                );
                totalCreated++;
            }

            console.log(`  Created 3 new services`);
        }

        console.log(`\n✅ Seeding completed! Created ${totalCreated} services across ${serviceTypes.length} service types.`);
        process.exit(0);
    } catch (error) {
        console.error('Error seeding data:', error);
        process.exit(1);
    }
};

seed3ServicesPerType();
