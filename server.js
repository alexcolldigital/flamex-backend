const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Initialize utilities
const Logger = require('./utils/logger');
const { validateEnvironment } = require('./utils/validateEnv');
const { maintenanceGuard } = require('./middleware/platformGuard');

// Validate environment first
validateEnvironment();

const logger = new Logger('Server');
const app = express();
const cspConnectSources = [
  "'self'",
  ...(process.env.FRONTEND_URL || '').split(','),
  ...(process.env.ADMIN_FRONTEND_URL || '').split(',')
].map(origin => origin.trim()).filter(Boolean);

// Security: Helmet middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: cspConnectSources
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

// Trust proxy for Render deployment and rate limiting
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);

// CORS configuration
const allowedOrigins = [
  ...(process.env.FRONTEND_URL || '').split(','),
  ...(process.env.ADMIN_FRONTEND_URL || '').split(','),
  ...(process.env.MOBILE_URL || '').split(','),
  'https://flamex-omega.vercel.app'
].map(origin => origin.trim()).filter(Boolean);

const isLocalOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || isLocalOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS policy violation'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || 900000),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || 100),
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV !== 'production'
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts, please try again later.',
  skipSuccessfulRequests: true
});

app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/admin/login', authLimiter);

// Body parsing with size limits and raw body capture for webhook signature verification
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTTP request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.http(req.method, req.path, res.statusCode, duration, {
      ip: req.ip,
      userId: req.userId
    });
  });
  next();
});

// Morgan for additional HTTP logging
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Platform guard
app.use(maintenanceGuard);

// MongoDB Connection with retry logic
const connectDB = async () => {
  const MAX_RETRIES = 3;
  let retries = 0;
  
  while (retries < MAX_RETRIES) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
        maxPoolSize: 10,
        retryWrites: true,
        w: 'majority'
      });
      logger.info('✅ MongoDB Connected Successfully');
      return;
    } catch (error) {
      retries++;
      if (retries < MAX_RETRIES) {
        logger.warn(`MongoDB connection attempt ${retries} failed. Retrying in 5 seconds...`, {
          error: error.message
        });
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        logger.error('❌ MongoDB connection failed after maximum retries', {
          error: error.message,
          mongoUri: process.env.MONGODB_URI?.substring(0, 20) + '***'
        });
        
        if (process.env.NODE_ENV === 'production') {
          process.exit(1);
        }
      }
    }
  }
};

connectDB();

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/swap', require('./routes/swap'));
const depositRoutes = require('./routes/deposit');
app.use('/api/deposit', depositRoutes.router);
app.post('/webhooks/flutterwave', depositRoutes.handleFlutterwaveWebhook);
app.use('/api/withdrawal', require('./routes/withdrawal'));
app.use('/api/bills', require('./routes/bills'));
app.use('/api/staking', require('./routes/staking'));
app.use('/api/referral', require('./routes/referral'));
app.use('/api/transfer', require('./routes/transfer'));
app.use('/api/p2p', require('./routes/p2p'));
app.use('/api/prices', require('./routes/prices'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin', require('./routes/admin'));

// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: mongoose.connection.readyState === 1 ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  };
  
  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

// API Info endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'FlameX API',
    version: '1.0.0',
    description: 'Multi-chain crypto wallet API',
    environment: process.env.NODE_ENV,
    status: mongoose.connection.readyState === 1 ? 'online' : 'offline'
  });
});

// 404 handler
app.use((req, res) => {
  logger.warn('Route not found', { method: req.method, path: req.path });
  res.status(404).json({ 
    message: 'Route not found',
    path: req.path,
    method: req.method 
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    path: req.path,
    method: req.method,
    userId: req.userId
  });

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(val => val.message);
    return res.status(400).json({ 
      message: 'Validation Error', 
      errors: messages 
    });
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(400).json({ 
      message: `${field} already exists`, 
      field 
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ message: 'Invalid token' });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ message: 'Token expired' });
  }

  // CORS errors
  if (err.message === 'CORS policy violation') {
    return res.status(403).json({ message: 'CORS policy violation' });
  }

  // Default error response
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
    mongoose.connection.close(false, () => {
      logger.info('MongoDB connection closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
    mongoose.connection.close(false, () => {
      logger.info('MongoDB connection closed');
      process.exit(0);
    });
  });
});

// Uncaught exception handler
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', {
    message: err.message,
    stack: err.stack
  });
  process.exit(1);
});

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', {
    reason,
    promise: promise.toString()
  });
});

// Start server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`, {
    environment: process.env.NODE_ENV,
    nodeVersion: process.version
  });
});

// Handle server errors
server.on('error', (err) => {
  logger.error('Server error', { error: err.message });
  process.exit(1);
});

module.exports = app;
