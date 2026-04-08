require('dotenv').config();
const mongoose = require('mongoose');
const Subcategory = require('../models/Subcategory.model');
const ServiceType = require('../models/ServiceType.model');
const config = require('../config/env');

const seedData = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to MongoDB');

        const subcategories = await Subcategory.find();
        console.log(`Found ${subcategories.length} subcategories.`);

        if (subcategories.length === 0) {
            console.log('No subcategories to seed service types for.');
            process.exit(0);
        }

        const typeNames = ['Basic', 'Premium', 'Pro', 'Elite', 'Advanced'];

        for (const subcategory of subcategories) {
            console.log(`Seeding for subcategory: ${subcategory.name}`);
            
            for (let i = 0; i < 5; i++) {
                const typeName = `${typeNames[i]} ${subcategory.name}`;
                
                // Check if already exists to avoid duplicates
                const existing = await ServiceType.findOne({
                    name: typeName,
                    subcategory: subcategory._id
                });

                if (!existing) {
                    await ServiceType.create({
                        name: typeName,
                        description: `This is a ${typeNames[i].toLowerCase()} service type for ${subcategory.name}.`,
                        subcategory: subcategory._id,
                        category: subcategory.category,
                        adminPrice: subcategory.adminPrice || 0,
                        membershipFee: subcategory.membershipFee || 0,
                        order: i + 2 // Assuming Standard is 1
                    });
                    console.log(`   ✅ Created "${typeName}" ServiceType.`);
                } else {
                    console.log(`   ℹ️  Found existing "${typeName}" ServiceType.`);
                }
            }
        }

        console.log('\n✅ Seeding completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error);
        process.exit(1);
    }
};

seedData();
