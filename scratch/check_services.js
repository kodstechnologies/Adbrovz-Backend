const mongoose = require('mongoose');
const Service = require('../src/models/Service.model');
const Category = require('../src/models/Category.model');
const Subcategory = require('../src/models/Subcategory.model');

async function checkServices() {
    try {
        // Find DB connection string from env or use default
        await mongoose.connect('mongodb://localhost:27017/adbrovz');
        const ids = ['69e3bdd54e986a1e0ffd6675', '69e5af2faf33b2ee70ffa0ea', '69e3daabce044373caad865c'];
        const svcs = await Service.find({ _id: { $in: ids } }).populate('category subcategory');
        console.log(JSON.stringify(svcs, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.connection.close();
    }
}

checkServices();
