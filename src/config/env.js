require('dotenv').config();

const config = {
  // Server
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 4000,
  API_VERSION: process.env.API_VERSION || 'v1',

  // Database
MONGODB_URI: process.env.MONGODB_URI || "mongodb+srv://adityaprasadtripathy20_db_user:0SJ3JqKGzOYtTDsK@cluster0.fhbj9mn.mongodb.net/",
  MONGODB_URI_TEST: process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/adbrovz_test',

  // JWT
  JWT_SECRET: process.env.JWT_SECRET || 'change-this-secret-key',
  JWT_EXPIRE: process.env.JWT_EXPIRE || '7d',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'change-this-refresh-secret',
  JWT_REFRESH_EXPIRE: process.env.JWT_REFRESH_EXPIRE || '30d',

  // PIN
  PIN_MAX_ATTEMPTS: parseInt(process.env.PIN_MAX_ATTEMPTS, 10) || 3,
  PIN_LOCKOUT_DURATION: parseInt(process.env.PIN_LOCKOUT_DURATION, 10) || 3600000, // 1 hour

  // OTP
  OTP_LENGTH: parseInt(process.env.OTP_LENGTH, 10) || 6,
  OTP_EXPIRE_MINUTES: parseInt(process.env.OTP_EXPIRE_MINUTES, 10) || 10,
  OTP_BOOKING_EXPIRE_MINUTES: parseInt(process.env.OTP_BOOKING_EXPIRE_MINUTES, 10) || 1440, // 24 hours

  // SMS (SMS Country)
  SMS_COUNTRY_API_KEY: process.env.SMS_COUNTRY_API_KEY,
  SMS_COUNTRY_SENDER_ID: process.env.SMS_COUNTRY_SENDER_ID || 'ADBRVZ',

  // Firebase
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,

  // Razorpay
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,

  // GCP
  GCP_PROJECT_ID: process.env.GCP_PROJECT_ID,
  GCP_API_KEY: process.env.GCP_API_KEY,

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,

  // Redis
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: parseInt(process.env.REDIS_PORT, 10) || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',

  // Queue
  QUEUE_CONCURRENCY: parseInt(process.env.QUEUE_CONCURRENCY, 10) || 5,

  // Booking
  DEFAULT_BOOKING_WINDOW_DAYS: parseInt(process.env.DEFAULT_BOOKING_WINDOW_DAYS, 10) || 7,
  DEFAULT_VENDOR_SEARCH_RADIUS_KM: parseInt(process.env.DEFAULT_VENDOR_SEARCH_RADIUS_KM, 10) || 10,
  DEFAULT_TRAVEL_CHARGE: parseFloat(process.env.DEFAULT_TRAVEL_CHARGE) || 50,
  DEFAULT_VENDOR_CONCURRENCY_LIMIT: parseInt(process.env.DEFAULT_VENDOR_CONCURRENCY_LIMIT, 10) || 3,
  PRICE_CONFIRMATION_TIMEOUT_MINUTES: parseInt(process.env.PRICE_CONFIRMATION_TIMEOUT_MINUTES, 10) || 15,
  GRACE_PERIOD_MINUTES: parseInt(process.env.GRACE_PERIOD_MINUTES, 10) || 15,
  MAX_RESCHEDULE_COUNT: parseInt(process.env.MAX_RESCHEDULE_COUNT, 10) || 2,
  MAX_CANCEL_COUNT: parseInt(process.env.MAX_CANCEL_COUNT, 10) || 1,

  // Notification
  NOTIFICATION_RETENTION_DAYS: parseInt(process.env.NOTIFICATION_RETENTION_DAYS, 10) || 30,

  // File Upload
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE, 10) || 5242880, // 5MB
  UPLOAD_PATH: process.env.UPLOAD_PATH || 'uploads',

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000, // 15 minutes
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_DIR: process.env.LOG_DIR || 'logs',

  // CORS
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',

  // Admin
  SUPER_ADMIN_USERNAME: process.env.SUPER_ADMIN_USERNAME || 'adbrovz',
  SUPER_ADMIN_PASSWORD: process.env.SUPER_ADMIN_PASSWORD || 'change-this-password',
};

// Validate required environment variables
const requiredEnvVars = [
  'JWT_SECRET',
  'MONGODB_URI',
];

if (config.NODE_ENV === 'production') {
  requiredEnvVars.forEach((varName) => {
    if (!process.env[varName]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  });
}

module.exports = config;

