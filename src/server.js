const mongoose = require('mongoose');
const app = require('./app');
const config = require('./config/env');
const { initSocket } = require('./socket');

/**
 * Handle uncaught exceptions
 */
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION');
  console.error(err);
  process.exit(1);
});

/**
 * MongoDB connection
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(config.MONGODB_URI);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('❌ MongoDB connection failed');
    console.error(error.message);
    process.exit(1);
  }
};

/**
 * Start server
 */
const startServer = async () => {
  await connectDB();

  const server = app.listen(config.PORT, () => {
    console.log(`🚀 Server running on port ${config.PORT}`);
    console.log(`📦 API: http://localhost:${config.PORT}/api/${config.API_VERSION}`);
  });

  // Initialize Socket.io
  initSocket(server);

  // Initialize Cron Jobs
  const { initAutoCancelJob } = require('./jobs/bookingAutoCancel.job');
  initAutoCancelJob();

  /**
   * Port already in use
   */
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${config.PORT} is already in use`);
      console.error(`➡ Run: netstat -ano | findstr :${config.PORT}`);
      console.error(`➡ Kill: taskkill /PID <PID> /F`);
    } else {
      console.error('Server error:', err.message);
    }
    process.exit(1);
  });

  /**
   * Unhandled promise rejections
   */
  process.on('unhandledRejection', (err) => {
    console.error('❌ UNHANDLED REJECTION');
    console.error(err);
    server.close(() => process.exit(1));
  });

  /**
   * Graceful shutdown
   */
  process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received. Shutting down...');
    server.close(() => {
      mongoose.connection.close(false, () => {
        process.exit(0);
      });
    });
  });
};

startServer();
