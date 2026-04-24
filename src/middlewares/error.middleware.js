const ApiError = require('../utils/ApiError');
const MESSAGES = require('../constants/messages');

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;
  error.stack = err.stack;

  // Log error
  console.error(`Error: ${err.message}`, {
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
  });

  const fs = require('fs');
  fs.appendFileSync('error_debug.log', `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}\nError: ${err.message}\nStack: ${err.stack}\n\n`);

  // Invalid JSON body (body-parser)
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    error = new ApiError(400, 'Invalid JSON payload');
  }
 
  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    const message = 'Resource not found';
    error = new ApiError(404, message);
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    const message = `${field} already exists`;
    error = new ApiError(400, message);
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map((val) => val.message).join(', ');
    error = new ApiError(400, message);
  }

  // Joi validation error
  if (err.isJoi) {
    const message = err.details.map((detail) => detail.message).join(', ');
    error = new ApiError(400, message);
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    error = new ApiError(401, MESSAGES.AUTH.UNAUTHORIZED);
  }

  if (err.name === 'TokenExpiredError') {
    error = new ApiError(401, MESSAGES.AUTH.TOKEN_EXPIRED);
  }

  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || MESSAGES.SERVER_ERROR,
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
  });
};

const notFoundHandler = (req, res, next) => {
  const error = new ApiError(404, `Route ${req.originalUrl} not found`);
  next(error);
};

module.exports = {
  errorHandler,
  notFoundHandler,
};

