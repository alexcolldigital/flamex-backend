const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authMiddleware, requireTransactionPinSet } = require('../middleware/auth');
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

function getAvailableBalance(user, currency) {
  const currencyUpper = String(currency || '').toUpperCase();
  const balance = Number(user?.balances?.[currencyUpper] || 0);
  const locked = Number(user?.lockedBalances?.[currencyUpper] || 0);
  return Math.max(0, balance - locked);
}

async function refundFailedWithdrawal({ userId, transactionId, amount, failureReason }) {
  await withTransaction(async (session) => {
    const [sessionUser, sessionTransaction] = await Promise.all([
      User.findById(userId).session(session),
      Transaction.findById(transactionId).session(session)
    ]);

    if (!sessionUser || !sessionTransaction) {
      throw new AppError('Unable to reverse failed withdrawal cleanly', 500);
    }

    const currency = sessionTransaction.currency || 'NGN';
    sessionUser.balances[currency] = Number((Number(sessionUser.balances[currency] || 0) + Number(amount)).toFixed(currency === 'NGN' ? 2 : 8));
    sessionTransaction.status = 'failed';
    sessionTransaction.metadata = {
      ...(sessionTransaction.metadata?.toObject?.() || sessionTransaction.metadata || {}),
      failureReason
    };

    await Promise.all([
      sessionUser.save({ session }),
      sessionTransaction.save({ session })
    ]);
  });
}

router.get('/banks', authMiddleware, async (req, res) => {
  res.json({ banks: BANKS });
});

router.post('/verify-account', authMiddleware, [
  body('bankCode').notEmpty(),
  body('accountNumber').isLength({ min: 10, max: 10 })
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const user = await User.findById(req.userId);
  const { bankCode, accountNumber } = req.body;
  const bank = BANKS.find((item) => item.code === bankCode);

  let accountName = `${user.firstName} ${user.lastName}`;

  if (!flutterwaveService.isConfigured) {
    throw new AppError('Bank verification service is not configured', 503);
  }

  const verifyResult = await flutterwaveService.verifyAccount(accountNumber, bankCode);
  if (!verifyResult.success) {
    throw new AppError(verifyResult.error || 'Unable to verify bank account', 502);
  }

  accountName = verifyResult.data?.account_name || accountName;

  res.json({
    accountName,
    accountNumber,
    bankName: bank?.name || 'Unknown Bank'
  });
}));

router.post(['/ngn/request-otp', '/usd/request-otp'], authMiddleware, requireTransactionPinSet, requireVerifiedKycForTransactions, [
  body('amount').isFloat({ min: 1 })
], asyncHandler(async (req, res) => {
  const logger = new Logger('withdrawal/ngn/request-otp');

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const amount = Number(req.body.amount);
  const currency = req.path.startsWith('/usd/') ? 'USD' : 'NGN';
  const user = await User.findById(req.userId);

  if (getAvailableBalance(user, currency) < amount) {
    throw new AppError('Insufficient balance', 400);
  }

  if (!requires2FA(user, amount)) {
    return res.json({ requiresOTP: false });
  }

  const otp = await storeOTP(user, 'withdrawal');
  await sendOTPEmail(user, otp, 'withdrawal');

  logger.info(`OTP sent for ${currency} withdrawal of ${amount}`);
  res.json({
    requiresOTP: true,
    message: 'OTP sent to your email'
  });
}));

router.post(['/ngn', '/usd'], authMiddleware, requireTransactionPinSet, requireVerifiedKycForTransactions, [
  body('amount').isFloat({ min: 1 }),
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
  const currency = req.path === '/usd' ? 'USD' : 'NGN';
  if (currency === 'NGN' && amount < 500) {
    throw new AppError('Minimum NGN withdrawal is 500', 400);
  }
  const { bankCode, accountNumber, accountName, pin, otp } = req.body;
  let user = await User.findById(req.userId);

  const pinMatch = await user.comparePin(pin);
  if (!pinMatch) {
    throw new AppError('Invalid PIN', 400);
  }

  if (getAvailableBalance(user, currency) < amount) {
    throw new AppError('Insufficient available balance', 400);
  }

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

  const fee = currency === 'NGN' && amount < 10000 ? 50 : 0;
  if (amount <= fee) {
    throw new AppError('Withdrawal amount must be greater than the fee', 400);
  }

  const reference = `WD-${currency}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const bankData = {
    bankCode,
    accountNumber,
    accountName,
    bankName: BANKS.find((b) => b.code === bankCode)?.name || 'Unknown'
  };

  const debitResult = await withTransaction(async (session) => {
    const sessionUser = await User.findById(user._id).session(session);
    if (!sessionUser) {
      throw new AppError('User not found', 404);
    }

    if (getAvailableBalance(sessionUser, 'NGN') < amount) {
      throw new AppError('Insufficient available balance', 400);
    }

    const transaction = new Transaction({
      userId: sessionUser._id,
      type: 'withdrawal',
      amount,
      currency,
      description: `Withdrawal to ${accountName} (${bankData.bankName})`,
      status: 'processing',
      fee,
      reference,
      metadata: {
        bankData,
        provider: 'flutterwave',
        netAmount: amount - fee
      }
    });

    sessionUser.balances[currency] = Number((Number(sessionUser.balances[currency] || 0) - amount).toFixed(currency === 'NGN' ? 2 : 8));

    await Promise.all([
      transaction.save({ session }),
      sessionUser.save({ session })
    ]);

    return {
      userId: sessionUser._id,
      transactionId: transaction._id,
      newBalance: sessionUser.balances[currency]
    };
  });

  if (!flutterwaveService.isConfigured) {
    await refundFailedWithdrawal({
      userId: debitResult.userId,
      transactionId: debitResult.transactionId,
      amount,
      failureReason: 'Bank transfer service not configured'
    });
    throw new AppError('Bank transfer service not configured', 503);
  }

  let transferResult;
  try {
    transferResult = await flutterwaveService.initiateTransfer({
      amount: amount - fee,
      accountNumber,
      bankCode,
      accountName,
      narration: 'FlameX Withdrawal',
      reference,
      currency
    });
  } catch (transferError) {
    logger.error(`Flutterwave transfer failed: ${transferError.message}`);
    transferResult = { success: false, error: transferError.message };
  }

  if (!transferResult?.success) {
    await refundFailedWithdrawal({
      userId: debitResult.userId,
      transactionId: debitResult.transactionId,
      amount,
      failureReason: transferResult?.error || 'Failed to initiate bank transfer'
    });
    throw new AppError(transferResult?.error || 'Failed to initiate bank transfer', 503);
  }

  const transaction = await Transaction.findByIdAndUpdate(
    debitResult.transactionId,
    {
      $set: {
        status: 'pending',
        'metadata.transferReference': transferResult?.data?.reference || transferResult?.data?.id || null,
        'metadata.providerResponse': transferResult?.data || null
      }
    },
    { new: true }
  );

  const notificationUser = await User.findById(debitResult.userId);
  await createNotification({
    user: notificationUser,
    type: 'send',
    title: `${currency} withdrawal initiated`,
    body: `Your withdrawal of ${currency} ${amount.toLocaleString()} to ${accountName} has been initiated.`,
    data: {
      reference,
      amount,
      fee,
      currency,
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
    newBalance: debitResult.newBalance,
    transactionId: transaction._id
  });
}));

router.post('/crypto/request-otp', authMiddleware, requireTransactionPinSet, requireVerifiedKycForTransactions, [
  body('amount').isFloat({ min: 0.000001 })
], asyncHandler(async (req, res) => {
  const logger = new Logger('withdrawal/crypto/request-otp');

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const amount = Number(req.body.amount);
  const user = await User.findById(req.userId);

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

router.post('/crypto', authMiddleware, requireTransactionPinSet, requireVerifiedKycForTransactions, [
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

  const pinMatch = await user.comparePin(pin);
  if (!pinMatch) {
    throw new AppError('Invalid PIN', 400);
  }

  const totalAmount = amount + gasFeeEstimate;
  const balance = Number(user.balances[tokenUpper] || 0);
  if (balance < totalAmount) {
    throw new AppError(`Insufficient ${tokenUpper} balance. Required: ${totalAmount}, Available: ${balance}`, 400);
  }

  const lockedAmount = Number(user.lockedBalances?.[tokenUpper] || 0);
  const availableAfterLock = balance - lockedAmount;
  if (availableAfterLock < totalAmount) {
    throw new AppError(`Insufficient available ${tokenUpper} balance. Available: ${availableAfterLock}, Required: ${totalAmount}`, 400);
  }

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

  const { transaction, updatedUser } = await withTransaction(async (session) => {
    const sessionUser = await User.findById(user._id).session(session);
    if (!sessionUser) {
      throw new AppError('User not found', 404);
    }

    const sessionBalance = Number(sessionUser.balances[tokenUpper] || 0);
    const sessionLockedAmount = Number(sessionUser.lockedBalances?.[tokenUpper] || 0);
    const sessionAvailableAfterLock = sessionBalance - sessionLockedAmount;
    if (sessionAvailableAfterLock < totalAmount) {
      throw new AppError(`Insufficient available ${tokenUpper} balance. Available: ${sessionAvailableAfterLock}, Required: ${totalAmount}`, 400);
    }

    const sessionTransaction = new Transaction({
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
        gasFeeEstimate,
        executionMode: 'manual_or_provider_pending'
      }
    });

    sessionUser.balances[tokenUpper] = Number((sessionBalance - totalAmount).toFixed(8));

    await Promise.all([
      sessionTransaction.save({ session }),
      sessionUser.save({ session })
    ]);

    return { transaction: sessionTransaction, updatedUser: sessionUser };
  });

  await createNotification({
    user: updatedUser,
    type: 'send',
    title: 'Crypto withdrawal initiated',
    body: `Your ${tokenUpper} withdrawal of ${amount} to ${toAddress.substring(0, 10)}... has been queued for processing.${gasFeeEstimate > 0 ? ` Network fee: ${gasFeeEstimate}` : ''}`,
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
    newBalance: updatedUser.balances[tokenUpper],
    transactionId: transaction._id
  });
}));

router.use((err, req, res, _next) => {
  handleError(err, req, res, new Logger('withdrawal'));
});

module.exports = router;
