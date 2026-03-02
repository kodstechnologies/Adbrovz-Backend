require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

// Connect to MongoDB
const mongoURI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/adbrovz';
mongoose.connect(mongoURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => {
    console.log('Connected to MongoDB');
}).catch((err) => {
    console.log('Error connecting to MongoDB', err);
    process.exit(1);
});

// Load the Service model
const Service = require('../models/Service.model');
const Category = require('../models/Category.model');
const Subcategory = require('../models/Subcategory.model');

// Load Cloudinary Service
const cloudinaryService = require('../services/cloudinary.service');

const migrateModelImages = async (Model, modelName, folderName) => {
    console.log(`\nStarting migration for ${modelName}...`);
    try {
        const records = await Model.find({ photo: { $regex: '^uploads/' } });
        console.log(`Found ${records.length} ${modelName} records with local images.`);

        for (const record of records) {
            try {
                const localPath = path.join(__dirname, '../../', record.photo);
                if (fs.existsSync(localPath)) {
                    console.log(`Uploading ${localPath} to Cloudinary...`);
                    const result = await cloudinaryService.uploadFromPath(localPath, folderName);
                    record.photo = result.secure_url;
                    await record.save();
                    console.log(`✅ Updated ${modelName} ${record._id} to new URL: ${result.secure_url}`);
                } else {
                    console.log(`⚠️ Local file not found: ${localPath}`);
                }
            } catch (err) {
                console.error(`❌ Error migrating record ${record._id}:`, err.message);
            }
        }
    } catch (err) {
        console.error(`Error fetching ${modelName}:`, err);
    }
};

const runMigration = async () => {
    try {
        await migrateModelImages(Service, 'Service', 'services');
        await migrateModelImages(Category, 'Category', 'categories');
        await migrateModelImages(Subcategory, 'Subcategory', 'subcategories');
        console.log('\n✅ Migration script finished.');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        mongoose.connection.close();
    }
};

runMigration();
