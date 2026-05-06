const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const { maintenanceGuard } = require('./middleware/platformGuard');

const app = express();
const allowedOrigins = [
  ...(process.env.FRONTEND_URL || '').split(','),
  ...(process.env.ADMIN_FRONTEND_URL || '').split(',')
].map((origin) => origin.trim()).filter(Boolean);

// Security middleware
app.use(helmet());
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : '*',
  credentials: false
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.'
});
app.use('/api/', limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/admin/login', authLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
app.use(morgan('dev'));
app.use(maintenanceGuard);

// MongoDB Connection
const connectDB = async () => {
  const MAX_RETRIES = 3;
  let retries = 0;
  
  while (retries < MAX_RETRIES) {
    try {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/flamex', {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
      });
      console.log('✅ MongoDB Connected Successfully');
      return;
    } catch (error) {
      retries++;
      if (retries < MAX_RETRIES) {
        console.warn(`⚠️  MongoDB connection attempt ${retries} failed. Retrying in 5 seconds...`);
        console.warn(`Error: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        console.error('❌ MongoDB connection failed after 3 attempts');
        console.error('MongoDB Setup Instructions:');
        console.error('1. Install MongoDB from https://www.mongodb.com/try/download/community');
        console.error('2. Or use MongoDB Atlas: https://www.mongodb.com/cloud/atlas');
        console.error('3. Or use Docker: docker-compose up -d');
        console.error('\nNote: App will run in offline mode with in-memory data storage.');
        // Don't exit - allow app to run with in-memory fallback
      }
    }
  }
};
connectDB();

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/swap', require('./routes/swap'));
app.use('/api/deposit', require('./routes/deposit'));
app.use('/api/withdrawal', require('./routes/withdrawal'));
app.use('/api/bills', require('./routes/bills'));
app.use('/api/staking', require('./routes/staking'));
app.use('/api/referral', require('./routes/referral'));
app.use('/api/transfer', require('./routes/transfer'));
app.use('/api/p2p', require('./routes/p2p'));
app.use('/api/prices', require('./routes/prices'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin', require('./routes/admin'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Info
app.get('/', (req, res) => {
  res.json({
    name: 'FlameX API',
    version: '1.0.0',
    description: 'Multi-chain crypto wallet API'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(val => val.message);
    return res.status(400).json({ message: 'Validation Error', errors: messages });
  }
  
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(400).json({ message: 'Duplicate field', field });
  }
  
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error'
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
