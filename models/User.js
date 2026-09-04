const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  
  username: { 
    type: String, 
    unique: true, 
    sparse: true,
    lowercase: true,
    trim: true,
    minlength: 3,
    maxlength: 30,
    match: /^[a-zA-Z0-9_]+$/
  },
  usernameSet: { type: Boolean, default: false },
  
  profilePicture: { type: String, default: null },
  emailVerified: { type: Boolean, default: false },
  emailVerifiedAt: { type: Date, default: null },
  pin: { type: String, default: null },
  biometricEnabled: { type: Boolean, default: false },
  
  kycVerified: { type: Boolean, default: false },
  kycLevel: { type: Number, default: 0 },
  kycVerifiedAt: { type: Date, default: null },
  bvn: { type: String, default: null },
  nin: { type: String, default: null },
  kycVerificationDetails: {
    bvn: { type: mongoose.Schema.Types.Mixed, default: null },
    nin: { type: mongoose.Schema.Types.Mixed, default: null },
    selfieBvn: { type: mongoose.Schema.Types.Mixed, default: null },
    selfieNin: { type: mongoose.Schema.Types.Mixed, default: null },
    liveness: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  
  wallets: [{
    chainId: { type: String, required: true },
    address: { type: String, required: true },
    publicKey: { type: String, required: true },
    encryptedPrivateKey: { type: String, required: true },
    isActive: { type: Boolean, default: true }
  }],
  
  primaryWalletAddress: { type: String, default: null },
  encryptedMnemonic: { type: String, default: null },
  
  balances: {
    NGN: { type: Number, default: 0 },
    USD: { type: Number, default: 0 },
    SOL: { type: Number, default: 0 },
    MATIC: { type: Number, default: 0 },
    USDT: { type: Number, default: 0 },
    USDC: { type: Number, default: 0 },
    FLAME: { type: Number, default: 0 },
    ETH: { type: Number, default: 0 },
    BNB: { type: Number, default: 0 }
  },

  lockedBalances: {
    NGN: { type: Number, default: 0 },
    USD: { type: Number, default: 0 },
    SOL: { type: Number, default: 0 },
    MATIC: { type: Number, default: 0 },
    USDT: { type: Number, default: 0 },
    USDC: { type: Number, default: 0 },
    FLAME: { type: Number, default: 0 },
    ETH: { type: Number, default: 0 },
    BNB: { type: Number, default: 0 }
  },
  
  virtualCard: {
    id: { type: String, default: null },
    color: { type: String, default: 'purple' },
    cardNumber: { type: String, default: null },
    expiryMonth: { type: String, default: null },
    expiryYear: { type: String, default: null },
    cvv: { type: String, default: null },
    status: { type: String, enum: ['active', 'frozen', 'blocked', null], default: null },
    balance: { type: Number, default: 0 }
  },
  
  bankAccounts: [{
    bankName: { type: String },
    bankCode: { type: String },
    accountNumber: { type: String },
    accountName: { type: String },
    isDefault: { type: Boolean, default: false }
  }],

  fiatAccounts: {
    NGN: {
      bankName: { type: String, default: null },
      bankCode: { type: String, default: null },
      accountNumber: { type: String, default: null },
      accountName: { type: String, default: null },
      provider: { type: String, default: null },
      providerAccountId: { type: String, default: null },
      reference: { type: String, default: null },
      updatedAt: { type: Date, default: null }
    },
    USD: {
      provider: { type: String, default: null },
      accountId: { type: String, default: null },
      accountNumber: { type: String, default: null },
      updatedAt: { type: Date, default: null }
    }
  },

  p2pProfile: {
    isMerchant: { type: Boolean, default: false },
    merchantStatus: {
      type: String,
      enum: ['none', 'pending', 'approved', 'suspended'],
      default: 'none'
    },
    preferredFiatCurrency: { type: String, default: 'NGN' },
    region: { type: String, default: 'NG' },
    completionRate: { type: Number, default: 0 },
    totalTrades: { type: Number, default: 0 },
    completedTrades: { type: Number, default: 0 },
    cancelledTrades: { type: Number, default: 0 },
    disputedTrades: { type: Number, default: 0 },
    totalVolumeNgn: { type: Number, default: 0 },
    securityDeposit: { type: Number, default: 0 },
    averageReleaseMinutes: { type: Number, default: 0 },
    lastTradeAt: { type: Date, default: null }
  },
  
  settings: {
    currency: { type: String, default: 'NGN' },
    language: { type: String, default: 'en' },
    themeMode: {
      type: String,
      enum: ['system', 'light', 'dark'],
      default: 'system'
    },
    notifications: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
      transactions: { type: Boolean, default: true }
    },
    privacy: {
      showBalance: { type: Boolean, default: true },
      allowUsernameSearch: { type: Boolean, default: true }
    },
    security: {
      transactionConfirmation: { type: Boolean, default: true },
      autoLockMinutes: { type: Number, default: 5 },
      twoFactorEnabled: { type: Boolean, default: false }
    }
  },
  
  status: { 
    type: String, 
    enum: ['active', 'suspended', 'banned', 'pending'],
    default: 'pending'
  },
  
  lastLoginAt: { type: Date, default: null },
  otpVerification: {
    hash: { type: String, default: null },
    context: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

userSchema.pre('save', function preventUsernameChanges(next) {
  if (!this.isNew && this.isModified('username')) {
    return next(new Error('Username can only be set during registration'));
  }
  next();
});

// Indexes are automatically created by unique: true and sparse: true properties
// Removing explicit index() calls to prevent duplicate index warnings

userSchema.pre('save', async function(next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  if (this.isModified('pin') && this.pin) {
    this.pin = await bcrypt.hash(this.pin, 10);
  }
  this.updatedAt = new Date();
  next();
});

userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.comparePin = async function(candidatePin) {
  if (!this.pin) return false;
  return await bcrypt.compare(candidatePin, this.pin);
};

module.exports = mongoose.model('User', userSchema);
