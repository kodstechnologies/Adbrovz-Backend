require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User.model');
const Vendor = require('../src/models/Vendor.model');
const Service = require('../src/models/Service.model');
const ServiceType = require('../src/models/ServiceType.model');
const Category = require('../src/models/Category.model');
const Subcategory = require('../src/models/Subcategory.model');
const Banner = require('../src/models/Banner.model');
const Dispute = require('../src/models/Dispute.model');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/adbrovzservices';
const CDN_BASE_URL = 'http://cdn.adbrovz.tech/cdn/images/';

const convertUrl = (oldUrl) => {
    if (!oldUrl || typeof oldUrl !== 'string') return oldUrl;
    // Check if the URL belongs to Cloudinary
    if (oldUrl.includes('cloudinary.com')) {
        const parts = oldUrl.split('/');
        const filename = parts[parts.length - 1];
        return `${CDN_BASE_URL}${filename}`;
    }
    return oldUrl;
};

const runMigration = async () => {
    try {
        console.log(`Connecting to MongoDB at: ${MONGODB_URI}`);
        await mongoose.connect(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('MongoDB connection successful.');

        // 1. Migrate Users
        console.log('Migrating Users...');
        const users = await User.find({ photo: /cloudinary\.com/i });
        console.log(`Found ${users.length} users with Cloudinary photos.`);
        let userCount = 0;
        for (const user of users) {
            const oldUrl = user.photo;
            user.photo = convertUrl(user.photo);
            await user.save();
            console.log(`Updated User photo: ${oldUrl} -> ${user.photo}`);
            userCount++;
        }
        console.log(`Successfully updated ${userCount} users.\n`);

        // 2. Migrate Banners
        console.log('Migrating Banners...');
        const banners = await Banner.find({ image: /cloudinary\.com/i });
        console.log(`Found ${banners.length} banners with Cloudinary images.`);
        let bannerCount = 0;
        for (const banner of banners) {
            const oldUrl = banner.image;
            banner.image = convertUrl(banner.image);
            await banner.save();
            console.log(`Updated Banner image: ${oldUrl} -> ${banner.image}`);
            bannerCount++;
        }
        console.log(`Successfully updated ${bannerCount} banners.\n`);

        // 3. Migrate Services
        console.log('Migrating Services...');
        const services = await Service.find({ photo: /cloudinary\.com/i });
        console.log(`Found ${services.length} services with Cloudinary photos.`);
        let serviceCount = 0;
        for (const service of services) {
            const oldUrl = service.photo;
            service.photo = convertUrl(service.photo);
            await service.save();
            console.log(`Updated Service photo: ${oldUrl} -> ${service.photo}`);
            serviceCount++;
        }
        console.log(`Successfully updated ${serviceCount} services.\n`);

        // 4. Migrate ServiceTypes
        console.log('Migrating ServiceTypes...');
        const serviceTypes = await ServiceType.find({ photo: /cloudinary\.com/i });
        console.log(`Found ${serviceTypes.length} service types with Cloudinary photos.`);
        let serviceTypeCount = 0;
        for (const st of serviceTypes) {
            const oldUrl = st.photo;
            st.photo = convertUrl(st.photo);
            await st.save();
            console.log(`Updated ServiceType photo: ${oldUrl} -> ${st.photo}`);
            serviceTypeCount++;
        }
        console.log(`Successfully updated ${serviceTypeCount} service types.\n`);

        // 5. Migrate Categories
        console.log('Migrating Categories...');
        const categories = await Category.find({ icon: /cloudinary\.com/i });
        console.log(`Found ${categories.length} categories with Cloudinary icons.`);
        let categoryCount = 0;
        for (const cat of categories) {
            const oldUrl = cat.icon;
            cat.icon = convertUrl(cat.icon);
            await cat.save();
            console.log(`Updated Category icon: ${oldUrl} -> ${cat.icon}`);
            categoryCount++;
        }
        console.log(`Successfully updated ${categoryCount} categories.\n`);

        // 6. Migrate Subcategories
        console.log('Migrating Subcategories...');
        const subcategories = await Subcategory.find({ icon: /cloudinary\.com/i });
        console.log(`Found ${subcategories.length} subcategories with Cloudinary icons.`);
        let subcategoryCount = 0;
        for (const subcat of subcategories) {
            const oldUrl = subcat.icon;
            subcat.icon = convertUrl(subcat.icon);
            await subcat.save();
            console.log(`Updated Subcategory icon: ${oldUrl} -> ${subcat.icon}`);
            subcategoryCount++;
        }
        console.log(`Successfully updated ${subcategoryCount} subcategories.\n`);

        // 7. Migrate Disputes
        console.log('Migrating Disputes...');
        const disputes = await Dispute.find({ evidence: /cloudinary\.com/i });
        console.log(`Found ${disputes.length} disputes with Cloudinary evidence.`);
        let disputeCount = 0;
        for (const dispute of disputes) {
            if (dispute.evidence && dispute.evidence.length > 0) {
                dispute.evidence = dispute.evidence.map(url => convertUrl(url));
                await dispute.save();
                console.log(`Updated Dispute evidence.`);
                disputeCount++;
            }
        }
        console.log(`Successfully updated ${disputeCount} disputes.\n`);

        // 8. Migrate Vendors
        console.log('Migrating Vendors...');
        const vendors = await Vendor.find({
            $or: [
                { 'documents.photo.url': /cloudinary\.com/i },
                { 'documents.idProof.url': /cloudinary\.com/i },
                { 'documents.addressProof.url': /cloudinary\.com/i },
                { 'documents.workProof.url': /cloudinary\.com/i },
                { 'documents.bankProof.url': /cloudinary\.com/i },
                { 'documents.policeVerification.url': /cloudinary\.com/i }
            ]
        });
        console.log(`Found ${vendors.length} vendors with Cloudinary documents.`);
        let vendorCount = 0;
        const docTypes = ['photo', 'idProof', 'addressProof', 'workProof', 'bankProof', 'policeVerification'];
        for (const vendor of vendors) {
            docTypes.forEach(type => {
                if (vendor.documents && vendor.documents[type] && vendor.documents[type].url) {
                    const oldUrl = vendor.documents[type].url;
                    vendor.documents[type].url = convertUrl(vendor.documents[type].url);
                    if (oldUrl !== vendor.documents[type].url) {
                        console.log(`Updated Vendor ${vendor.name} (${type}): ${oldUrl} -> ${vendor.documents[type].url}`);
                    }
                }
            });
            await vendor.save();
            vendorCount++;
        }
        console.log(`Successfully updated ${vendorCount} vendors.\n`);

        console.log('Migration complete!');
    } catch (error) {
        console.error('Migration failed:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB.');
    }
};

runMigration();
