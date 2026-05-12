const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const monnifyService = require('../services/monnify');
const { createNotification } = require('../services/notifications');
const { AppError, handleError, asyncHandler } = require('../utils/errorHandler');
const { withTransaction } = require('../utils/database');
const Logger = require('../utils/logger');

async function findDepositTransaction(reference, eventData = {}) {
  if (!reference) return null;

  let transaction = await Transaction.findOne({ reference });
  if (transaction) return transaction;

  transaction = await Transaction.findOne({ 'metadata.monnifyReference': reference });
  if (transaction) return transaction;

  const paymentReference = eventData.paymentReference || eventData.transactionReference || eventData.transactionRef;
  if (paymentReference) {
    transaction = await Transaction.findOne({ reference: paymentReference });
    if (transaction) return transaction;
  }

  const destinationAccountNumber =
    eventData.destinationAccountInformation?.accountNumber ||
    eventData.destinationAccountNumber ||
    eventData.accountNumber;

  if (destinationAccountNumber) {
    transaction = await Transaction.findOne({
      type: 'deposit',
      status: 'pending',
      'metadata.bankDetails.accountNumber': destinationAccountNumber
    }).sort({ createdAt: -1 });
  }

  return transaction;
}

// Get deposit address for crypto
router.get('/address/:chainId', authMiddleware, asyncHandler(async (req, res) => {
  const logger = new Logger('deposit/address');
  
  const user = await User.findById(req.userId);
  const wallet = user.wallets.find(w => w.chainId === req.params.chainId);
  
  if (!wallet) {
    throw new AppError('Wallet not found', 404);
  }

  const explorers = {
    solana: 'https://solscan.io/account/',
    ethereum: 'https://etherscan.io/address/',
    bsc: 'https://bscscan.com/address/',
    polygon: 'https://polygonscan.com/address/',
    base: 'https://basescan.org/address/',
    arbitrum: 'https://arbiscan.io/address/'
  };

  logger.info(`Deposit address requested for ${req.params.chainId}`);
  
  res.json({
    chainId: req.params.chainId,
    address: wallet.address,
    explorerUrl: (explorers[req.params.chainId] || '') + wallet.address
  });
}));

// Request NGN deposit - Get virtual account
router.post('/ngn', authMiddleware, [
  body('amount').isFloat({ min: 100 }).withMessage('Minimum deposit is ₦100')
], asyncHandler(async (req, res) => {
  const logger = new Logger('deposit/ngn');
  
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const user = await User.findById(req.userId);
  const amount = Number(req.body.amount);
  const reference = `DP-NGN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const customerName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  const customerBvn = String(user.bvn || '').trim();
  const customerNin = String(user.nin || '').trim();

  if (!customerName) {
    throw new AppError('Profile name is required before creating a deposit account', 400);
  }

  if (!user.email) {
    throw new AppError('Email is required before creating a deposit account', 400);
  }

  if (!customerBvn && !customerNin) {
    throw new AppError('Complete BVN or NIN verification before requesting an NGN deposit account', 400);
  }

  let bankDetails = null;
  let monnifyResult = null;

  try {
    if (monnifyService.isConfigured) {
      monnifyResult = await monnifyService.createReservedAccount({
        userId: user._id.toString(),
        userName: customerName,
        email: user.email,
        bvn: customerBvn,
        nin: customerNin
      });

      if (monnifyResult.success) {
        const primaryAccount = monnifyResult.accounts?.[0] || {};
        bankDetails = {
          bankName: primaryAccount.bankName || monnifyResult.bank?.name || 'Monnify',
          bankCode: primaryAccount.bankCode || monnifyResult.bank?.code || '',
          accountNumber: primaryAccount.accountNumber || '',
          accountName: primaryAccount.accountName || customerName,
          monnifyAccountId: primaryAccount.accountNumber || null,
          accountReference: monnifyResult.accountReference || null,
          reservationReference: monnifyResult.reservationReference || null
        };
      } else {
        logger.warn('Monnify reserved account creation failed', {
          userId: req.userId,
          error: monnifyResult.error
        });
      }
    }
  } catch (error) {
    logger.error(`Failed to create Monnify reserved account: ${error.message}`);
    throw new AppError('Failed to create bank account. Please try again.', 503);
  }

  if (!bankDetails) {
    throw new AppError(monnifyResult?.error || 'Bank account creation service not available', 503);
  }

  // Create transaction record
  const transaction = new Transaction({
    userId: req.userId,
    type: 'deposit',
    amount,
    currency: 'NGN',
    description: 'NGN deposit via bank transfer',
    status: 'pending',
    reference,
    metadata: {
      bankDetails,
      monnifyAccountId: bankDetails.monnifyAccountId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    }
  });
  await transaction.save();

  logger.info(`NGN deposit requested: ${reference}, amount: ${amount}`);

  res.json({
    success: true,
    message: 'Deposit account created',
    reference,
    amount,
    bankDetails,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    instructions: [
      `Transfer ₦${amount.toLocaleString()} to the account above`,
      'Use the reference as the transaction narration for faster confirmation',
      'Deposit will be credited to your account once payment is confirmed'
    ]
  });
}));

/**
 * WEBHOOK: Monnify Webhook Handler
 * Receives payment notifications from Monnify
 * Path: /webhooks/monnify (must be registered in Monnify dashboard)
 */
router.post('/webhooks/monnify', asyncHandler(async (req, res) => {
  const logger = new Logger('deposit/webhooks/monnify');
  
  try {
    // Verify webhook signature
    const signature = req.headers['monnify-signature'];
    const verification = monnifyService.handleWebhook(req.body, signature, req.rawBody);
    if (!verification.valid) {
      logger.warn('Invalid Monnify webhook signature', { error: verification.error });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    logger.info(`Monnify webhook received: ${verification.event}`);

    // Handle payment success event
    const payload = verification.data;
    const { eventType, eventData } = payload;
    if (eventType === 'SUCCESSFUL_TRANSACTION' || eventType === 'INCOMING_TRANSFER') {
      const reference =
        eventData.transactionReference ||
        eventData.paymentReference ||
        eventData.reference ||
        eventData.transactionRef;
      const amount = Number(eventData.amountPaid || eventData.amount || 0);

      // Find transaction by reference
      const transaction = await findDepositTransaction(reference, eventData);
      
      if (!transaction) {
        logger.warn(`Transaction not found for reference: ${reference}`);
        return res.json({ success: true, message: 'Acknowledged' }); // Acknowledge to prevent retries
      }

      if (transaction.status === 'completed') {
        logger.info(`Transaction already completed: ${reference}`);
        return res.json({ success: true, message: 'Already processed' });
      }

      // Use transaction to ensure atomicity
      await withTransaction(async (session) => {
        // Update transaction status
        transaction.status = 'completed';
        transaction.metadata = {
          ...(transaction.metadata?.toObject ? transaction.metadata.toObject() : transaction.metadata || {}),
          monnifyReference: reference,
          monnifyPaymentReference: eventData.paymentReference || null,
          confirmedAt: new Date().toISOString()
        };
        await transaction.save({ session });

        // Credit user balance
        const user = await User.findById(transaction.userId);
        if (!user) {
          throw new AppError('User not found', 404);
        }

        user.balances.NGN = (user.balances.NGN || 0) + amount;
        await user.save({ session });

        // Send notification
        await createNotification({
          user,
          type: 'receive',
          title: 'Deposit confirmed',
          body: `Your deposit of ₦${amount.toLocaleString()} has been credited to your wallet.`,
          data: {
            reference,
            amount,
            currency: 'NGN',
            transactionId: transaction._id
          },
          sendEmail: true
        });
      });

      logger.info(`Deposit confirmed: ${reference}, amount: ${amount}, user: ${transaction.userId}`);
    }

    // Always return success to acknowledge webhook
    res.json({ success: true, message: 'Webhook processed' });
  } catch (error) {
    logger.error(`Webhook processing error: ${error.message}`);
    // Still return 200 to prevent Monnify from retrying on server errors
    res.json({ success: false, error: error.message });
  }
}));

/**
 * WEBHOOK: Flutterwave Webhook Handler
 * Receives payment notifications from Flutterwave
 * Path: /webhooks/flutterwave (must be registered in Flutterwave dashboard)
 */
router.post('/webhooks/flutterwave', asyncHandler(async (req, res) => {
  const logger = new Logger('deposit/webhooks/flutterwave');
  
  try {
    const { event, data } = req.body;

    // Verify webhook signature
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== process.env.FLUTTERWAVE_WEBHOOK_SECRET) {
      logger.warn('Invalid Flutterwave webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    logger.info(`Flutterwave webhook received: ${event}`);

    // Handle successful transfer events
    if (event === 'Transfer.Complete' && data?.status === 'SUCCESSFUL') {
      const reference = data.tx_ref || data.txRef || data.reference || data.id;
      const amount = Number(data.amount || 0);

      // Find transaction by reference
      const transaction =
        (await Transaction.findOne({ reference })) ||
        (await Transaction.findOne({ 'metadata.flutterwaveReference': reference })) ||
        (data.account_number
          ? await Transaction.findOne({
              type: 'deposit',
              status: 'pending',
              'metadata.bankDetails.accountNumber': data.account_number
            }).sort({ createdAt: -1 })
          : null);

      if (!transaction) {
        logger.warn(`Transaction not found for reference: ${reference}`);
        return res.json({ success: true });
      }

      if (transaction.status === 'completed') {
        logger.info(`Transaction already completed: ${reference}`);
        return res.json({ success: true });
      }

      await withTransaction(async (session) => {
        transaction.status = 'completed';
        transaction.metadata = {
          ...(transaction.metadata?.toObject ? transaction.metadata.toObject() : transaction.metadata || {}),
          flutterwaveReference: reference,
          flutterwaveId: data.id || null,
          confirmedAt: new Date().toISOString()
        };
        await transaction.save({ session });

        const user = await User.findById(transaction.userId);
        if (!user) {
          throw new AppError('User not found', 404);
        }

        user.balances.NGN = (user.balances.NGN || 0) + amount;
        await user.save({ session });

        await createNotification({
          user,
          type: 'receive',
          title: 'Deposit confirmed',
          body: `Your deposit of ₦${amount.toLocaleString()} has been credited to your wallet.`,
          data: {
            reference,
            amount,
            currency: 'NGN',
            transactionId: transaction._id
          },
          sendEmail: true
        });
      });

      logger.info(`Deposit confirmed: ${reference}, amount: ${amount}, user: ${transaction.userId}`);
    }

    res.json({ status: 'success' });
  } catch (error) {
    logger.error(`Webhook processing error: ${error.message}`);
    res.status(200).json({ status: 'error', message: error.message });
  }
}));

// Global error handler
router.use((err, req, res, next) => {
  handleError(err, req, res, new Logger('deposit'));
});

module.exports = router;
