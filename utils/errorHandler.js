const Logger = require('./logger');

class AppError extends Error {
  constructor(message, statusCode, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Centralized error handler for all routes
 * Usage: catch (error) { handleError(error, req, res, logger) }
 */
function handleError(error, req, res, logger = null) {
  const log = logger || new Logger(req.originalUrl || 'Unknown');
  
  // Log the full error for debugging
  log.error(`${error.message}`, {
    stack: error.stack,
    body: req.body,
    params: req.params,
    query: req.query,
    userId: req.userId,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip
  });

  // If already an AppError, use it as-is
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
      ...(process.env.NODE_ENV === 'development' && { details: error.details, stack: error.stack })
    });
  }

  // Mongoose validation error
  if (error.name === 'ValidationError') {
    const details = Object.values(error.errors).map(err => err.message);
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      details
    });
  }

  // Mongoose cast error
  if (error.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: 'Invalid ID format'
    });
  }

  // Mongoose duplicate key error
  if (error.code === 11000) {
    const field = Object.keys(error.keyPattern)[0];
    return res.status(409).json({
      success: false,
      message: `${field} already exists`
    });
  }

  // JWT errors
  if (error.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid authentication token'
    });
  }

  if (error.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Authentication token expired'
    });
  }

  // Default server error
  return res.status(error.statusCode || 500).json({
    success: false,
    message: error.statusCode ? error.message : 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { 
      details: error.message,
      stack: error.stack 
    })
  });
}

/**
 * Async route wrapper to catch errors automatically
 * Usage: router.post('/path', asyncHandler(async (req, res) => { ... }))
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  AppError,
  handleError,
  asyncHandler
};
