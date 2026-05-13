const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const flutterwaveService = require('../services/flutterwave');
const { createNotification } = require('../services/notifications');
const { requireVerifiedKycForTransactions } = require('../middleware/kyc');
const { AppError, handleError, asyncHandler } = require('../utils/errorHandler');
const { withTransaction } = require('../utils/database');
const { storeOTP, sendOTPEmail, verifyOTP, requires2FA } = require('../utils/twoFA');
const Logger = require('../utils/logger');

const BANKS = [
  { id: '044', name: 'Access Bank', code: '044' },
  { id: '058', name: 'GTBank', code: '058' },
  { id: '011', name: 'First Bank', code: '011' },
  { id: '033', name: 'UBA', code: '033' },
  { id: '057', name: 'Zenith Bank', code: '057' },
  { id: '035', name: 'Wema Bank', code: '035' },
  { id: '076', name: 'Polaris Bank', code: '076' },
  { id: '214', name: 'FCMB', code: '214' }
];

router.get('/banks', authMiddleware, async (req, res) => {
  res.json({ banks: BANKS });
});

router.post('/verify-account', authMiddleware, [
  body('bankCode').notEmpty(),
  body('accountNumber').isLength({ min: 10, max: 10 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = await User.findById(req.userId);
    const { bankCode, accountNumber } = req.body;
    const bank = BANKS.find((item) => item.code === bankCode);

    let accountName = `${user.firstName} ${user.lastName}`;

    if (flutterwaveService.isConfigured) {
      const verifyResult = await flutterwaveService.verifyAccount(accountNumber, bankCode);
      if (verifyResult.success) {
        accountName = verifyResult.data?.account_name || accountName;
      }
    } else {
      throw new AppError('Bank verification service is not configured', 503);
    }

    res.json({
      accountName,
      accountNumber,
      bankName: bank?.name || 'Unknown Bank'
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// NGN Withdrawal - Request OTP
router.post('/ngn/request-otp', authMiddleware, requireVerifiedKycForTransactions, [
  body('amount').isFloat({ min: 500 })
], asyncHandler(async (req, res) => {
  const logger = new Logger('withdrawal/ngn/request-otp');
  
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const amount = Number(req.body.amount);
  const user = await User.findById(req.userId);

  if (user.balances.NGN < amount) {
    throw new AppError('Insufficient balance', 400);
  }

  if (!requires2FA(user, amount)) {
    // No 2FA required, return success
    return res.json({ requiresOTP: false });
  }

  // Generate and send OTP
  const otp = await storeOTP(user, 'withdrawal');
  await sendOTPEmail(user, otp, 'withdrawal');

  logger.info(`OTP sent for NGN withdrawal of ${amount}`);
  res.json({
    requiresOTP: true,
    message: 'OTP sent to your email'
  });
}));

// NGN Withdrawal - Confirm with OTP and initiate transfer
router.post('/ngn', authMiddleware, requireVerifiedKycForTransactions, [
  body('amount').isFloat({ min: 500 }),
  body('bankCode').notEmpty().withMessage('Bank code required'),
  body('accountNumber').isLength({ min: 10, max: 10 }).withMessage('Invalid account number'),
  body('accountName').notEmpty().withMessage('Account name required'),
  body('pin').isLength({ min: 4, max: 6 }).withMessage('Invalid PIN'),
  body('otp').optional().isString()
], asyncHandler(async (req, res) => {
  const logger = new Logger('withdrawal/ngn');
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const amount = Number(req.body.amount);
  const { bankCode, accountNumber, accountName, pin, otp } = req.body;
  let user = await User.findById(req.userId);

  // Verify PIN
  const pinMatch = await user.comparePin(pin);
  if (!pinMatch) {
    throw new AppError('Invalid PIN', 400);
  }

  // Check balance (before checking OTP, so frontend can decide)
  if (user.balances.NGN < amount) {
    throw new AppError('Insufficient balance', 400);
  }

  // Verify 2FA if required
  if (requires2FA(user, amount)) {
    if (!otp) {
      return res.status(202).json({
        success: false,
        message: '2FA verification required',
        requiresOTP: true
      });
    }
    
    await verifyOTP(user, otp, 'withdrawal');
    user = await User.findById(req.userId); // Refresh user after OTP verification
  }

  const fee = amount < 10000 ? 50 : 0;
  const reference = `WD-NGN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Use transaction to ensure atomicity
  return withTransaction(async (session) => {
    const bankData = {
      bankCode,
      accountNumber,
      accountName,
      bankName: BANKS.find(b => b.code === bankCode)?.name || 'Unknown'
    };

    // Try to initiate transfer with Flutterwave
    let transferResult = null;
    let transferInitiated = false;

    if (flutterwaveService.isConfigured) {
      try {
        transferResult = await flutterwaveService.initiateTransfer({
          amount: amount - fee,
          accountNumber,
          bankCode,
          accountName,
          narration: 'FlameX Withdrawal',
          reference
        });
        transferInitiated = transferResult?.success === true;
      } catch (transferError) {
        logger.error(`Flutterwave transfer failed: ${transferError.message}`);
        throw new AppError('Bank transfer failed. Please try again.', 503, transferError.message);
      }
    } else {
      throw new AppError('Bank transfer service not configured', 503);
    }

    // Only deduct balance after successful bank transfer initiation
    if (!transferInitiated) {
      throw new AppError('Failed to initiate bank transfer', 503);
    }

    // Create transaction record
    const transaction = new Transaction({
      userId: req.userId,
      type: 'withdrawal',
      amount,
      currency: 'NGN',
      description: `Withdrawal to ${accountName} (${bankData.bankName})`,
      status: 'pending',
      fee,
      reference,
      metadata: {
        bankData,
        transferReference: transferResult?.reference || transferResult?.transactionId,
        provider: 'flutterwave'
      }
    });
    await transaction.save({ session });

    // Deduct balance (atomically within transaction)
    user.balances.NGN -= amount;
    await user.save({ session });

    // Send notification
    await createNotification({
      user,
      type: 'send',
      title: 'NGN withdrawal initiated',
      body: `Your withdrawal of ₦${amount.toLocaleString()} to ${accountName} has been initiated.`,
      data: {
        reference,
        amount,
        fee,
        currency: 'NGN',
        transactionId: transaction._id,
        status: 'pending'
      },
      sendEmail: true
    });

    logger.info(`NGN withdrawal initiated: ${reference}, amount: ${amount}`);

    res.json({
      success: true,
      message: 'Withdrawal initiated successfully',
      reference,
      amount: amount - fee,
      fee,
      newBalance: user.balances.NGN,
      transactionId: transaction._id
    });
  });
}));

// Crypto Withdrawal - Request OTP
router.post('/crypto/request-otp', authMiddleware, requireVerifiedKycForTransactions, [
  body('amount').isFloat({ min: 0.000001 })
], asyncHandler(async (req, res) => {
  const logger = new Logger('withdrawal/crypto/request-otp');
  
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const amount = Number(req.body.amount);
  const user = await User.findById(req.userId);

  // For crypto, always require 2FA if large amount
  if (!requires2FA(user, amount)) {
    return res.json({ requiresOTP: false });
  }

  const otp = await storeOTP(user, 'withdrawal');
  await sendOTPEmail(user, otp, 'withdrawal');

  logger.info(`OTP sent for crypto withdrawal of ${amount}`);
  res.json({
    requiresOTP: true,
    message: 'OTP sent to your email'
  });
}));

// Crypto Withdrawal - Confirm and execute
router.post('/crypto', authMiddleware, requireVerifiedKycForTransactions, [
  body('chainId').notEmpty().withMessage('Chain ID required'),
  body('token').notEmpty().withMessage('Token required'),
  body('amount').isFloat({ min: 0.000001 }).withMessage('Invalid amount'),
  body('toAddress').matches(/^0x[a-fA-F0-9]{40}$|^[1-9A-HJ-NP-Z]{32,44}$/).withMessage('Invalid recipient address'),
  body('pin').isLength({ min: 4, max: 6 }).withMessage('Invalid PIN'),
  body('gasFeeEstimate').optional().isFloat({ min: 0 }).withMessage('Invalid gas fee'),
  body('otp').optional().isString()
], asyncHandler(async (req, res) => {
  const logger = new Logger('withdrawal/crypto');
  
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const amount = Number(req.body.amount);
  const gasFeeEstimate = Number(req.body.gasFeeEstimate || 0);
  const { chainId, token, toAddress, pin, otp } = req.body;
  const tokenUpper = token.toUpperCase();
  
  let user = await User.findById(req.userId);

  // Verify PIN
  const pinMatch = await user.comparePin(pin);
  if (!pinMatch) {
    throw new AppError('Invalid PIN', 400);
  }

  // Validate balance including gas fee
  const totalAmount = amount + gasFeeEstimate;
  const balance = user.balances[tokenUpper] || 0;
  if (balance < totalAmount) {
    throw new AppError(`Insufficient ${tokenUpper} balance. Required: ${totalAmount}, Available: ${balance}`, 400);
  }

  // Check for locked balances (P2P escrow)
  const lockedAmount = user.lockedBalances?.[tokenUpper] || 0;
  const availableAfterLock = balance - lockedAmount;
  if (availableAfterLock < totalAmount) {
    throw new AppError(`Insufficient available ${tokenUpper} balance. Available: ${availableAfterLock}, Required: ${totalAmount}`, 400);
  }

  // Verify 2FA if required
  if (requires2FA(user, amount)) {
    if (!otp) {
      return res.status(202).json({
        success: false,
        message: '2FA verification required',
        requiresOTP: true
      });
    }
    
    await verifyOTP(user, otp, 'withdrawal');
    user = await User.findById(req.userId);
  }

  const reference = `WD-CRP-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Create transaction with gas fee tracking
  const transaction = new Transaction({
    userId: req.userId,
    type: 'withdrawal',
    amount,
    currency: tokenUpper,
    chainId,
    description: `${tokenUpper} withdrawal to ${toAddress.substring(0, 10)}...`,
    status: 'pending',
    gasFee: gasFeeEstimate,
    reference,
    metadata: {
      toAddress,
      chainId,
      gasFeeEstimate
    }
  });
  await transaction.save();

  // Deduct balance and gas fee
  user.balances[tokenUpper] -= (amount + gasFeeEstimate);
  await user.save();

  // Send notification
  await createNotification({
    user,
    type: 'send',
    title: 'Crypto withdrawal initiated',
    body: `Your ${tokenUpper} withdrawal of ${amount} to ${toAddress.substring(0, 10)}... has been initiated.${gasFeeEstimate > 0 ? ` Network fee: ${gasFeeEstimate}` : ''}`,
    data: {
      reference,
      amount,
      currency: tokenUpper,
      gasFee: gasFeeEstimate,
      chainId,
      toAddress,
      transactionId: transaction._id,
      status: 'pending'
    },
    sendEmail: true
  });

  logger.info(`Crypto withdrawal initiated: ${reference}, amount: ${amount}, gas: ${gasFeeEstimate}`);

  res.json({
    success: true,
    message: 'Withdrawal initiated successfully',
    reference,
    amount,
    gasFee: gasFeeEstimate,
    newBalance: user.balances[tokenUpper],
    transactionId: transaction._id
  });
}));

// Global error handler for this router
router.use((err, req, res, next) => {
  handleError(err, req, res, new Logger('withdrawal'));
});

module.exports = router;
