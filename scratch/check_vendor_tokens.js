const mongoose = require('mongoose');
require('dotenv').config();
const Vendor = require('../src/models/Vendor.model');
const config = require('../src/config/env');

async function checkTokens() {
  await mongoose.connect(config.MONGODB_URI);
  const vendors = await Vendor.find({ fcmToken: { $exists: true, $ne: '' } }).select('name fcmToken');
  console.log('Vendors with tokens:');
  vendors.forEach(v => console.log(`- ${v.name}: ${v.fcmToken}`));
  process.exit(0);
}

checkTokens();
