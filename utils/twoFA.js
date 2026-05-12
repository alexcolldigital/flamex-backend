const crypto = require('crypto');
const { AppError } = require('./errorHandler');
const { createNotification } = require('../services/notifications');

/**
 * Generate a 6-digit OTP for 2FA
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Store OTP verification temporarily in user document
 */
async function storeOTP(user, context = 'transfer') {
  const otp = generateOTP();
  const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
  
  user.otpVerification = {
    hash: otpHash,
    context, // 'transfer', 'withdrawal', 'sensitive_action'
    expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
    attempts: 0,
    maxAttempts: 3
  };
  
  await user.save();
  return otp; // Return plain OTP to send to user
}

/**
 * Verify OTP and check if user has confirmed
 */
async function verifyOTP(user, otp, context = 'transfer') {
  if (!user.otpVerification) {
    throw new AppError('No OTP verification in progress', 400);
  }

  // Check expiration
  if (new Date() > user.otpVerification.expiresAt) {
    user.otpVerification = null;
    await user.save();
    throw new AppError('OTP has expired', 400);
  }

  // Check max attempts
  if (user.otpVerification.attempts >= user.otpVerification.maxAttempts) {
    user.otpVerification = null;
    await user.save();
    throw new AppError('Too many OTP attempts. Please try again later.', 429);
  }

  // Check context match
  if (user.otpVerification.context !== context) {
    throw new AppError('OTP context mismatch', 400);
  }

  // Verify OTP
  const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
  if (otpHash !== user.otpVerification.hash) {
    user.otpVerification.attempts += 1;
    await user.save();
    throw new AppError(`Invalid OTP. ${user.otpVerification.maxAttempts - user.otpVerification.attempts} attempts remaining.`, 400);
  }

  // Clear OTP verification on success
  user.otpVerification = null;
  await user.save();
  
  return true;
}

/**
 * Send OTP via email
 */
async function sendOTPEmail(user, otp, context = 'transfer') {
  const contextLabel = {
    'transfer': 'fund transfer',
    'withdrawal': 'withdrawal',
    'sensitive_action': 'sensitive action'
  }[context] || 'action';

  await createNotification({
    user,
    type: 'security',
    title: 'Confirm your ' + contextLabel,
    body: `Your verification code is: ${otp}. This code expires in 5 minutes.`,
    data: {
      context,
      otp, // Include in data for development/testing
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    },
    sendEmail: true,
    emailTemplate: 'otp-verification',
    emailData: {
      otp,
      context: contextLabel,
      expiresIn: '5 minutes'
    }
  });
}

/**
 * Check if user requires 2FA
 */
function requires2FA(user, transferAmount) {
  // Require 2FA for:
  // 1. Large transfers (> 1,000 NGN or crypto equivalent)
  // 2. Any transfer if user explicitly enabled it
  // 3. Any withdrawal
  
  const largeTransferThreshold = 1000; // NGN
  const enabledFor2FA =
    user.settings?.security?.twoFactorEnabled === true ||
    user.settings?.security?.transactionConfirmation === true;
  
  return enabledFor2FA || transferAmount > largeTransferThreshold;
}

/**
 * Middleware to check 2FA confirmation
 * Use this after verifying PIN but before final transaction
 */
async function require2FAMiddleware(req, res, next) {
  const user = req.user || await require('../models/User').findById(req.userId);
  
  const { amount, context = 'transfer' } = req.body;
  
  if (!requires2FA(user, amount)) {
    return next();
  }

  const { otpConfirmed } = req.body;
  
  if (!otpConfirmed) {
    // User hasn't confirmed OTP yet - return special response
    // Frontend should prompt for OTP
    return res.status(202).json({
      success: false,
      message: '2FA verification required',
      requiresOTP: true,
      context
    });
  }

  // Verify the OTP
  try {
    await verifyOTP(user, req.body.otp, context);
    next();
  } catch (error) {
    res.status(error.statusCode || 400).json({
      success: false,
      message: error.message
    });
  }
}

module.exports = {
  generateOTP,
  storeOTP,
  verifyOTP,
  sendOTPEmail,
  requires2FA,
  require2FAMiddleware
};
