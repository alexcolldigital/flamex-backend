const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const User = require('../models/User');
const Referral = require('../models/Referral');
const Transaction = require('../models/Transaction');
const EmailOtp = require('../models/EmailOtp');
const { generateToken, authMiddleware } = require('../middleware/auth');
const { encrypt } = require('../utils/encryption');
const emailService = require('../services/email');
const { createNotification } = require('../services/notifications');
const { isAdminUser, buildAdminProfile } = require('../utils/admin');
const { logAuditEvent } = require('../services/audit');
const { getPlatformSettings } = require('../utils/admin');

const createUserSecret = (password) => {
  return `${password}:${process.env.JWT_SECRET || 'flamex-secret-key-change-in-production'}`;
};

function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function sanitizeUser(user, referral = null) {
  const settings = user.settings?.toObject ? user.settings.toObject() : user.settings;
  return {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    emailVerified: user.emailVerified,
    phone: user.phone,
    username: user.username,
    profilePicture: user.profilePicture,
    kycVerified: user.kycVerified,
    kycLevel: user.kycLevel,
    wallets: (user.wallets || []).map((wallet) => ({
      chainId: wallet.chainId,
      address: wallet.address,
      publicKey: wallet.publicKey
    })),
    primaryWalletAddress: user.primaryWalletAddress,
    balances: user.balances,
    lockedBalances: user.lockedBalances,
    virtualCard: user.virtualCard,
    bankAccounts: user.bankAccounts,
    biometricEnabled: user.biometricEnabled,
    settings,
    referralCode: referral?.code || null
  };
}

// Register
router.post('/register', [
  body('firstName').trim().isLength({ min: 2 }),
  body('lastName').trim().isLength({ min: 2 }),
  body('email').isEmail().normalizeEmail(),
  body('phone').isMobilePhone(),
  body('password').isLength({ min: 8 }),
  body('mnemonic').notEmpty(),
  body('wallets').isArray({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      firstName,
      lastName,
      email,
      phone,
      password,
      mnemonic,
      wallets,
      referralCode
    } = req.body;

    const settings = await getPlatformSettings();
    if (!settings.allowNewRegistrations) {
      return res.status(403).json({ message: 'New registrations are currently disabled' });
    }

    const existingUser = await User.findOne({ $or: [{ email }, { phone }] });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email or phone already exists' });
    }

    const userSecret = createUserSecret(password);
    const encryptedMnemonic = encrypt(mnemonic, userSecret);
    const encryptedWallets = wallets.map((wallet) => ({
      chainId: wallet.chainId,
      address: wallet.address,
      publicKey: wallet.publicKey,
      encryptedPrivateKey: encrypt(wallet.privateKey, userSecret),
      isActive: true
    }));

    const primaryWallet = wallets.find((wallet) => wallet.chainId === 'solana') || wallets[0];

    const user = new User({
      firstName,
      lastName,
      email,
      phone,
      password,
      encryptedMnemonic,
      wallets: encryptedWallets,
      primaryWalletAddress: primaryWallet.address,
      status: 'active'
    });

    await user.save();

    let referredBy = null;
    if (referralCode) {
      const referrer = await Referral.findOne({ code: referralCode.toUpperCase() });
      if (referrer) {
        referredBy = referrer.userId;
        referrer.totalReferrals += 1;
        referrer.activeReferrals += 1;
        referrer.referredUsers.push({ userId: user._id, status: 'active' });
        referrer.updateTier();
        await referrer.save();
      }
    }

    const newReferralCode = generateReferralCode();
    const referral = new Referral({
      userId: user._id,
      code: newReferralCode,
      link: `${process.env.FRONTEND_URL || 'https://flamex.app'}/register?ref=${newReferralCode}`,
      referredBy
    });
    await referral.save();

    const token = generateToken(user._id);

    await logAuditEvent(req, {
      actorUserId: user._id,
      actorEmail: user.email,
      action: 'user_registered',
      entityType: 'user',
      entityId: user._id,
      metadata: { emailVerified: user.emailVerified }
    });

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: sanitizeUser(user, referral)
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Server error during registration' });
  }
});

// Login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const referral = await Referral.findOne({ userId: user._id });
    const token = generateToken(user._id);
    await logAuditEvent(req, {
      actorUserId: user._id,
      actorEmail: user.email,
      action: 'user_login',
      entityType: 'user',
      entityId: user._id
    });

    await createNotification({
      user,
      type: 'security',
      title: 'Login successful',
      body: 'Your account was accessed successfully.',
      sendEmail: false
    });

    res.json({
      token,
      user: sanitizeUser(user, referral)
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// Setup PIN
router.post('/setup-pin', authMiddleware, [
  body('pin').isLength({ min: 4, max: 6 }).isNumeric()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { pin } = req.body;
    const user = await User.findById(req.userId);

    if (user.pin) {
      return res.status(400).json({ message: 'PIN already set' });
    }

    user.pin = pin;
    await user.save();

    await createNotification({
      user,
      type: 'security',
      title: 'Transaction PIN created',
      body: 'Your transaction PIN was set successfully.',
      sendEmail: true
    });

    res.json({ message: 'PIN set successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Change PIN
router.post('/change-pin', authMiddleware, [
  body('currentPin').isLength({ min: 4, max: 6 }).isNumeric(),
  body('newPin').isLength({ min: 4, max: 6 }).isNumeric()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPin, newPin } = req.body;
    const user = await User.findById(req.userId);
    const isMatch = await user.comparePin(currentPin);

    if (!isMatch) {
      return res.status(400).json({ message: 'Current PIN is incorrect' });
    }

    user.pin = newPin;
    await user.save();

    await createNotification({
      user,
      type: 'security',
      title: 'Transaction PIN changed',
      body: 'Your transaction PIN was changed successfully.',
      sendEmail: true
    });

    res.json({ message: 'PIN changed successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Verify PIN
router.post('/verify-pin', authMiddleware, [
  body('pin').isLength({ min: 4, max: 6 }).isNumeric()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { pin } = req.body;
    const user = await User.findById(req.userId);

    if (!user.pin) {
      return res.status(400).json({ message: 'PIN not set' });
    }

    const isMatch = await user.comparePin(pin);
    res.json({ valid: isMatch });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/request-email-otp', [
  body('email').isEmail().normalizeEmail(),
  body('purpose').isIn(['verify_email', 'pin_reset'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, purpose } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await EmailOtp.deleteMany({ email, purpose, consumedAt: null });
    await EmailOtp.create({
      email,
      userId: user._id,
      purpose,
      codeHash: hashOtp(code),
      expiresAt
    });

    await emailService.sendOtpEmail({ to: email, code, purpose });

    res.json({ message: 'OTP sent successfully', expiresAt });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/verify-email-otp', [
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min: 6, max: 6 }).isNumeric(),
  body('purpose').optional().isIn(['verify_email', 'pin_reset'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, code, purpose = 'verify_email' } = req.body;
    const otp = await EmailOtp.findOne({
      email,
      purpose,
      consumedAt: null,
      expiresAt: { $gt: new Date() }
    }).sort({ expiresAt: -1 });

    if (!otp) {
      return res.status(400).json({ message: 'OTP is invalid or expired' });
    }

    otp.attempts += 1;
    if (otp.attempts > 5) {
      await otp.save();
      return res.status(429).json({ message: 'Too many OTP attempts' });
    }

    if (otp.codeHash !== hashOtp(code)) {
      await otp.save();
      return res.status(400).json({ message: 'OTP is invalid or expired' });
    }

    otp.consumedAt = new Date();
    await otp.save();

    const user = await User.findOne({ email });
    if (purpose === 'verify_email' && user) {
      user.emailVerified = true;
      user.emailVerifiedAt = new Date();
      await user.save();
    }

    res.json({
      message: purpose === 'verify_email' ? 'Email verified successfully' : 'OTP verified successfully',
      verified: true
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/request-pin-reset-otp', [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await EmailOtp.deleteMany({ email, purpose: 'pin_reset', consumedAt: null });
    await EmailOtp.create({
      email,
      userId: user._id,
      purpose: 'pin_reset',
      codeHash: hashOtp(code),
      expiresAt
    });

    await emailService.sendOtpEmail({ to: email, code, purpose: 'pin_reset' });

    res.json({ message: 'PIN reset OTP sent successfully', expiresAt });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/reset-pin-with-otp', [
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min: 6, max: 6 }).isNumeric(),
  body('newPin').isLength({ min: 4, max: 6 }).isNumeric()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, code, newPin } = req.body;
    const otp = await EmailOtp.findOne({
      email,
      purpose: 'pin_reset',
      consumedAt: null,
      expiresAt: { $gt: new Date() }
    }).sort({ expiresAt: -1 });

    if (!otp || otp.codeHash !== hashOtp(code)) {
      return res.status(400).json({ message: 'OTP is invalid or expired' });
    }

    otp.consumedAt = new Date();
    await otp.save();

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.pin = newPin;
    await user.save();

    await createNotification({
      user,
      type: 'security',
      title: 'Transaction PIN reset',
      body: 'Your transaction PIN was reset using email OTP.',
      sendEmail: true
    });

    res.json({ message: 'PIN reset successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Submit KYC
router.post('/kyc', authMiddleware, [
  body('bvn').optional({ values: 'falsy' }).isLength({ min: 11, max: 11 }).isNumeric(),
  body('nin').optional({ values: 'falsy' }).isLength({ min: 11, max: 11 }).isNumeric()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { bvn, nin } = req.body;
    if (!bvn && !nin) {
      return res.status(400).json({ message: 'BVN or NIN is required' });
    }

    const user = await User.findById(req.userId);
    if (bvn) user.bvn = bvn;
    if (nin) user.nin = nin;

    user.kycLevel = user.bvn && user.nin ? 2 : 1;
    user.kycVerified = Boolean(user.bvn && user.nin);
    await user.save();

    const transaction = new Transaction({
      userId: user._id,
      type: 'kyc',
      amount: 0,
      currency: 'NGN',
      description: 'KYC details submitted',
      status: 'completed',
      reference: `KYC-${Date.now()}`
    });
    await transaction.save();

    await createNotification({
      user,
      type: 'security',
      title: user.kycVerified ? 'KYC verified' : 'KYC submitted',
      body: user.kycVerified
        ? 'Your KYC has been verified successfully.'
        : 'Your KYC details were submitted and are awaiting full verification.',
      sendEmail: true
    });

    res.json({
      message: user.kycVerified ? 'KYC verified successfully' : 'KYC submitted successfully',
      kycVerified: user.kycVerified,
      kycLevel: user.kycLevel,
      user: sanitizeUser(user)
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Set Username
router.post('/set-username', authMiddleware, [
  body('username').trim().isLength({ min: 3, max: 30 }).matches(/^[a-zA-Z0-9_]+$/)
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username } = req.body;
    const lowercaseUsername = username.toLowerCase();

    const existingUser = await User.findOne({ username: lowercaseUsername });
    if (existingUser && existingUser._id.toString() !== String(req.userId)) {
      return res.status(400).json({ message: 'Username already taken' });
    }

    const user = await User.findById(req.userId);
    user.username = lowercaseUsername;
    await user.save();

    res.json({ message: 'Username set successfully', username: lowercaseUsername });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Check Username
router.get('/check-username/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const existingUser = await User.findOne({ username: username.toLowerCase() });
    res.json({ available: !existingUser });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get current user
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password -encryptedMnemonic -wallets.encryptedPrivateKey');
    const referral = await Referral.findOne({ userId: user._id });

    res.json({
      user: {
        ...sanitizeUser(user, referral),
        referralStats: referral ? {
          totalReferrals: referral.totalReferrals,
          activeReferrals: referral.activeReferrals,
          totalRewards: referral.totalRewards,
          pendingRewards: referral.pendingRewards,
          tier: referral.tier
        } : null
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Update profile
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const updates = {};
    if (req.body.firstName) updates.firstName = req.body.firstName;
    if (req.body.lastName) updates.lastName = req.body.lastName;
    if (req.body.profilePicture) updates.profilePicture = req.body.profilePicture;

    const user = await User.findByIdAndUpdate(req.userId, { $set: updates }, { new: true });
    const referral = await Referral.findOne({ userId: user._id });

    res.json({ user: sanitizeUser(user, referral) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get preferences
router.get('/preferences', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('settings biometricEnabled');
    const settings = user.settings?.toObject ? user.settings.toObject() : user.settings;
    res.json({
      preferences: {
        ...settings,
        biometricEnabled: user.biometricEnabled
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Update preferences
router.put('/preferences', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const { currency, language, themeMode, notifications, privacy } = req.body;

    if (currency) user.settings.currency = currency;
    if (language) user.settings.language = language;
    if (themeMode) user.settings.themeMode = themeMode;
    if (notifications) {
      const currentNotifications = user.settings.notifications?.toObject
        ? user.settings.notifications.toObject()
        : user.settings.notifications;
      user.settings.notifications = {
        ...currentNotifications,
        ...notifications
      };
    }
    if (privacy) {
      const currentPrivacy = user.settings.privacy?.toObject
        ? user.settings.privacy.toObject()
        : user.settings.privacy;
      user.settings.privacy = {
        ...currentPrivacy,
        ...privacy
      };
    }

    await user.save();

    res.json({
      message: 'Preferences updated',
      preferences: user.settings?.toObject ? user.settings.toObject() : user.settings
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Update security settings
router.put('/security', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const {
      biometricEnabled,
      transactionConfirmation,
      autoLockMinutes,
      twoFactorEnabled
    } = req.body;

    if (typeof biometricEnabled === 'boolean') {
      user.biometricEnabled = biometricEnabled;
    }
    if (typeof transactionConfirmation === 'boolean') {
      user.settings.security.transactionConfirmation = transactionConfirmation;
    }
    if (typeof autoLockMinutes === 'number') {
      user.settings.security.autoLockMinutes = autoLockMinutes;
    }
    if (typeof twoFactorEnabled === 'boolean') {
      user.settings.security.twoFactorEnabled = twoFactorEnabled;
    }

    await user.save();

    res.json({
      message: 'Security preferences updated',
      security: {
        biometricEnabled: user.biometricEnabled,
        ...(user.settings.security?.toObject ? user.settings.security.toObject() : user.settings.security)
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/admin/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !isAdminUser(user)) {
      return res.status(403).json({ message: 'Admin access required' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ message: 'Admin account is not active' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = generateToken(user._id);
    await logAuditEvent(req, {
      actorUserId: user._id,
      actorEmail: user.email,
      action: 'admin_login',
      entityType: 'admin',
      entityId: user._id,
      severity: 'warning'
    });
    res.json({
      token,
      user: buildAdminProfile(user)
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error during admin login' });
  }
});

router.get('/admin/profile', authMiddleware, async (req, res) => {
  try {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ message: 'Admin access required' });
    }
    res.json({ user: buildAdminProfile(req.user) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/admin/logout', authMiddleware, async (req, res) => {
  try {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ message: 'Admin access required' });
    }
    res.json({ message: 'Admin logout successful' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
