const admin = require('firebase-admin');

let serviceAccount;

try {
  // Check environment variable first (preferred for production/Render)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    // Fallback to local file
    serviceAccount = require('./firebase-service-account.json');
  }

  if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin SDK initialized successfully.');
  }
} catch (error) {
  console.warn('⚠️ Firebase Admin SDK initialization failed:');
  console.warn(error.message);
  console.warn('Push notifications will be disabled.');
}

module.exports = admin;
