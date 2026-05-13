const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const flutterwaveService = require('../services/flutterwave');
const { createNotification } = require('../services/notifications');
const { AppError, handleError, asyncHandler } = require('../utils/errorHandler');
const { withTransaction } = require('../utils/database');
const Logger = require('../utils/logger');

async function findDepositTransaction(reference, eventData = {}) {
  if (!reference) return null;

  let transaction = await Transaction.findOne({ reference });
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

// Request NGN deposit - Create Flutterwave checkout
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

  if (!user.email || user.email.trim() === '') {
    throw new AppError('Email is required before creating a deposit account', 400);
  }

  // Skip KYC verification in development for testing
  if (process.env.NODE_ENV === 'production' && !customerBvn && !customerNin) {
    throw new AppError('Complete BVN or NIN verification before requesting an NGN deposit account', 400);
  }

  let checkoutUrl = null;
  let providerResult = null;

  try {
    if (flutterwaveService.isConfigured) {
      providerResult = await flutterwaveService.createCheckout({
        amount,
        currency: 'NGN',
        email: user.email,
        phone: user.phone,
        fullName: customerName,
        txRef: reference,
        redirectUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/deposit/callback`,
        title: 'FlameX NGN Deposit',
        description: `Deposit ₦${amount.toLocaleString()} to your FlameX wallet`
      });

      if (providerResult.success) {
        const checkoutData = providerResult.data || {};
        checkoutUrl = checkoutData.link || checkoutData.checkout_url || checkoutData.payment_link;
      } else {
        logger.warn('Flutterwave checkout creation failed', {
          userId: req.userId,
          error: providerResult.error
        });
      }
    }
  } catch (error) {
    logger.error(`Failed to create Flutterwave checkout: ${error.message}`);
    throw new AppError('Failed to create payment link. Please try again.', 503);
  }

  if (!checkoutUrl) {
    throw new AppError(providerResult?.error || 'Payment service not available', 503);
  }

  // Create transaction record
  const transaction = new Transaction({
    userId: req.userId,
    type: 'deposit',
    amount,
    currency: 'NGN',
    description: 'NGN deposit via Flutterwave checkout',
    status: 'pending',
    reference,
    metadata: {
      checkoutUrl,
      provider: 'flutterwave',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    }
  });
  await transaction.save();

  logger.info(`NGN deposit checkout created: ${reference}, amount: ${amount}`);

  res.json({
    success: true,
    message: 'Payment link created',
    reference,
    amount,
    checkoutUrl,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    instructions: [
      'Click the payment link to complete your deposit',
      'You can pay with card, bank transfer, or USSD',
      'Deposit will be credited to your account once payment is confirmed'
    ]
  });
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

    // Handle successful checkout payments
    if (event === 'charge.completed' && data?.status === 'successful') {
      const reference = data.tx_ref || data.txRef || data.reference;
      const amount = Number(data.amount || 0);

      // Find transaction by reference
      const transaction = await Transaction.findOne({ reference });

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
          flutterwaveReference: data.id || data.flw_ref || reference,
          flutterwaveId: data.id || null,
          paymentMethod: data.payment_type || 'checkout',
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

      logger.info(`Deposit confirmed via checkout: ${reference}, amount: ${amount}, user: ${transaction.userId}`);
    }

    // Handle successful transfer events (for virtual accounts)
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

      logger.info(`Deposit confirmed via transfer: ${reference}, amount: ${amount}, user: ${transaction.userId}`);
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
