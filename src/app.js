const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const rateLimit = require('express-rate-limit');

const config = require('./config/env');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middlewares/error.middleware');

const app = express();

/**
 * Trust proxy (important for rate limiting & real IPs)
 */
app.set('trust proxy', 1);

/**
 * Security middlewares
 */
app.use(helmet());
app.use(xss());
app.use(mongoSanitize());

/**
 * CORS
 */
app.use(
  cors({
    origin: config.CORS_ORIGIN?.split(',') || '*',
    credentials: true,
  })
);

/**
 * Body parsers
 */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/**
 * Compression
 */
app.use(compression());

/**
 * Logging
 */
if (config.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

/**
 * Root route (must be before /api middleware)
 */
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Adbrovz API Server',
    version: config.API_VERSION,
    endpoints: {
      health: '/health',
      api: `/api/${config.API_VERSION}`,
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * Favicon handler (prevents 404 errors from browsers)
 */
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

/**
 * Rate limiting
 */
app.use('/api', (req, res, next) => {
  console.log(`🔍 [${new Date().toISOString()}] ${req.method} ${req.originalUrl} - IP: ${req.ip}`);
  next();
});

const limiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
  max: config.RATE_LIMIT_MAX_REQUESTS || 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/api', (req, res) => {
  res.redirect(`/api/${config.API_VERSION}`);
});

app.use('/api', limiter);

console.log(`📡 Registering routes for API version: ${config.API_VERSION}`);

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * API routes
 */
app.use('/api', routes);
app.use(`/api/${config.API_VERSION}`, routes);

/**
 * 404 handler
 */
app.use(notFoundHandler);

/**
 * Global error handler (MUST be last)
 */
app.use(errorHandler);

module.exports = app;
