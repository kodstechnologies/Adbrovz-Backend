const mongoose = require('mongoose');
const config = require('./src/config/env');

async function migrate() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(config.MONGODB_URI);
    console.log('Connected to DB successfully');

    const db = mongoose.connection.db;
    const collections = ['categories', 'subcategories', 'servicetypes', 'services'];
    
    for (const coll of collections) {
      console.log(`Migrating collection: ${coll}`);
      const result = await db.collection(coll).updateMany({}, {
        $rename: {
          'adminPrice': 'serviceCharge',
          'membershipFee': 'membershipCharge',
          'concurrencyFee': 'serviceRenewalCharge',
          'renewalCharge': 'membershipRenewalCharge'
        }
      });
      console.log(`Matched ${result.matchedCount} and modified ${result.modifiedCount} documents in ${coll}`);
    }

    console.log('Migration completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
