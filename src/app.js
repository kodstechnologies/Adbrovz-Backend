const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const rateLimit = require('express-rate-limit');

const path = require('path');
const config = require('./config/env');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middlewares/error.middleware');

const app = express();

/**
 * Socket diagnostics client page (served before helmet to avoid CSP blocking inline scripts)
 */
app.get('/socket-test', (req, res) => {
  res.sendFile(path.join(__dirname, 'socket-test.html'));
});

/**
 * Static files
 */
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/cdn/images', express.static(path.join(__dirname, '../uploads/images')));

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
// --- CORS configuration -------------------------------------------------
// Determine allowed origins from environment. Use explicit origins when credentials are needed.
// If CORS_ORIGIN is set to '*', we fallback to allowing any origin **without** credentials,
// because browsers reject `Access-Control-Allow-Origin: *` when `credentials: true`.
// Admin UI runs on https://admin.adbrovz.tech, so we include that as the default.
const allowedOrigins = (config.CORS_ORIGIN?.split(',') || ['https://admin.adbrovz.tech']).map(o => o.trim());

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no Origin (like curl, Postman) or from allowed list
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes('*')) {
      // Wildcard: do not send credentials
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  // Only send credentials when a specific origin is configured (no wildcard)
  credentials: !allowedOrigins.includes('*'),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Authorization'],
};

app.use(cors(corsOptions));
// Ensure pre‑flight OPTIONS requests are handled for all routes
app.options('*', cors(corsOptions));
// -------------------------------------------------------------------------
/**
 * Body parsers
 */
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
    message: 'Adbrovdz API Server',
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

/* Socket diagnostics route moved above helmet middleware */

/**
 * Rate limiting
 */

app.use('/api', (req, res, next) => {
  const hasAuth = !!req.headers.authorization;
  console.log(`🔍 [${new Date().toISOString()}] ${req.method} ${req.originalUrl} - IP: ${req.ip} - Auth: ${hasAuth ? 'PRESENT' : 'MISSING'}`);
  if (hasAuth) {
    console.log(`🔑 Auth Header: ${req.headers.authorization.substring(0, 15)}...`);
  }
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
