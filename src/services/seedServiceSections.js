require('dotenv').config();
const mongoose = require('mongoose');
const Category = require('../models/Category.model');
const Subcategory = require('../models/Subcategory.model');
const ServiceSection = require('../models/ServiceSection.model');
const config = require('../config/env');

const seedServiceSections = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI);
        console.log('Connected to MongoDB');

        // Get all subcategories with their categories
        const subcategories = await Subcategory.find().populate('category');
        console.log(`Found ${subcategories.length} subcategories`);

        let created = 0;
        let skipped = 0;

        for (const subcategory of subcategories) {
            // Skip if category is null
            if (!subcategory.category) {
                console.log(`Skipping ${subcategory.name} (no category)`);
                skipped++;
                continue;
            }

            // Check if ServiceSection already exists
            const existing = await ServiceSection.findOne({
                category: subcategory.category._id,
                subcategory: subcategory._id
            });

            if (existing) {
                console.log(`ServiceSection already exists for ${subcategory.name}`);
                skipped++;
                continue;
            }

            // Create ServiceSection
            await ServiceSection.create({
                title: `${subcategory.name} Services`,
                category: subcategory.category._id,
                subcategory: subcategory._id,
                limit: 10, // Show up to 10 services
                order: created + 1
            });

            console.log(`✅ Created ServiceSection for ${subcategory.name}`);
            created++;
        }

        console.log(`\n✅ Seeding completed! Created ${created} ServiceSections, skipped ${skipped}.`);
        process.exit(0);
    } catch (error) {
        console.error('Error seeding data:', error);
        process.exit(1);
    }
};

seedServiceSections();
