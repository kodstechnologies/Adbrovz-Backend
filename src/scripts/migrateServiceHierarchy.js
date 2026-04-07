require('dotenv').config();
const mongoose = require('mongoose');
const Category = require('../models/Category.model');
const Subcategory = require('../models/Subcategory.model');
const ServiceType = require('../models/ServiceType.model');
const Service = require('../models/Service.model');
const config = require('../config/env');

/**
 * MIGRATION: 4-Level Service Hierarchy
 * This script migrates existing services by creating a default "Select Type" (ServiceType)
 * for each subcategory and linking existing services to it.
 * This preserves all your data while moving it into the new structure.
 */
const migrate = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to MongoDB');

        // 1. Find all services that are NOT yet linked to a ServiceType
        const services = await Service.find({ serviceType: { $exists: false } });
        console.log(`Found ${services.length} services that need migration.`);

        if (services.length === 0) {
            console.log('No services to migrate.');
            process.exit(0);
        }

        // 2. Identify unique Subcategories from these services
        const subcategoryIds = [...new Set(services.map(s => s.subcategory?.toString()))].filter(id => !!id);
        console.log(`Working with ${subcategoryIds.length} subcategories.`);

        for (const subId of subcategoryIds) {
            const subcategory = await Subcategory.findById(subId);
            if (!subcategory) {
                console.log(`⚠️  Warning: Subcategory ${subId} not found, skipping.`);
                continue;
            }

            // 3. Create or Find a default ServiceType for this Subcategory
            let serviceType = await ServiceType.findOne({ 
                name: 'Standard', 
                subcategory: subId 
            });

            if (!serviceType) {
                serviceType = await ServiceType.create({
                    name: 'Standard',
                    description: `Default service type for ${subcategory.name}`,
                    subcategory: subId,
                    category: subcategory.category,
                    adminPrice: subcategory.adminPrice || 0,
                    membershipFee: subcategory.membershipFee || 0,
                    order: 1
                });
                console.log(`✅ Created "Standard" ServiceType for Subcategory: ${subcategory.name}`);
            } else {
                console.log(`ℹ️  Found existing ServiceType for Subcategory: ${subcategory.name}`);
            }

            // 4. Update all services in this subcategory to point to this new ServiceType
            const result = await Service.updateMany(
                { subcategory: subId, serviceType: { $exists: false } },
                { $set: { serviceType: serviceType._id } }
            );

            console.log(`   🔗 Linked ${result.modifiedCount} services to "${serviceType.name}" type.`);
        }

        console.log('\n✅ Migration completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
};

migrate();
