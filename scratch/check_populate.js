const mongoose = require('mongoose');
const Vendor = require('../src/models/Vendor.model');
require('../src/models/Category.model');
require('../src/models/Subcategory.model');
require('../src/models/Service.model');

async function checkPopulate() {
    try {
        await mongoose.connect('mongodb+srv://ac-qillxuc-shard-00-01.fhbj9mn.mongodb.net/adbrovz?retryWrites=true&w=majority', {
            user: 'adbrovz_admin',
            pass: 'Adbrovz@2024'
        });
        console.log('Connected to DB');

        const vendors = await Vendor.find({ categorySubscriptions: { $exists: true, $not: { $size: 0 } } })
            .populate('categorySubscriptions.category')
            .populate('categorySubscriptions.services')
            .limit(1)
            .lean();

        if (vendors.length > 0) {
            console.log('Vendor Found:', vendors[0].name);
            console.log('Subscriptions:', JSON.stringify(vendors[0].categorySubscriptions, null, 2));
        } else {
            console.log('No vendors with additional subscriptions found.');
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}

checkPopulate();
