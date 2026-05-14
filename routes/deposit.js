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

  const paymentReference =
    eventData.paymentReference ||
    eventData.transactionReference ||
    eventData.transactionRef;
  if (paymentReference) {
    transaction = await Transaction.findOne({ reference: paymentReference });
    if (transaction) return transaction;
  }

  const destinationAccountNumber =
    eventData.destinationAccountInformation?.accountNumber ||
    eventData.destinationAccountNumber ||
    eventData.accountNumber ||
    eventData.account_number;

  if (destinationAccountNumber) {
    transaction = await Transaction.findOne({
      type: 'deposit',
      status: 'pending',
      'metadata.bankDetails.accountNumber': destinationAccountNumber
    }).sort({ createdAt: -1 });
  }

  return transaction;
}

function getTransactionMetadata(transaction) {
  return transaction.metadata?.toObject
    ? transaction.metadata.toObject()
    : { ...(transaction.metadata || {}) };
}

function isSuccessfulFlutterwaveStatus(status) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  return ['successful', 'success', 'completed'].includes(normalizedStatus);
}

async function verifyFlutterwaveDeposit(reference, transactionId = null) {
  if (!flutterwaveService.isConfigured) {
    return { success: false, error: 'Flutterwave not configured' };
  }

  if (transactionId) {
    const byIdResult = await flutterwaveService.verifyTransaction(transactionId);
    if (byIdResult.success) {
      return byIdResult;
    }
  }

  return flutterwaveService.verifyTransactionByReference(reference);
}

async function creditNgnDeposit({
  transaction,
  amount,
  providerData = {},
  paymentMethod = 'checkout',
  session
}) {
  const normalizedAmount = Number(amount || 0);
  if (!normalizedAmount || normalizedAmount <= 0) {
    throw new AppError('Invalid deposit amount', 400);
  }

  transaction.status = 'completed';
  transaction.completedAt = new Date();
  transaction.metadata = {
    ...getTransactionMetadata(transaction),
    flutterwaveReference:
      providerData.flw_ref ||
      providerData.flwRef ||
      providerData.id ||
      providerData.tx_ref ||
      providerData.txRef ||
      transaction.reference,
    flutterwaveId: providerData.id || null,
    paymentMethod,
    confirmedAt: new Date().toISOString()
  };
  transaction.markModified('metadata');
  await transaction.save({ session });

  const user = await User.findByIdAndUpdate(
    transaction.userId,
    { $inc: { 'balances.NGN': normalizedAmount } },
    { new: true, session }
  );

  if (!user) {
    throw new AppError('User not found', 404);
  }

  await createNotification({
    user,
    type: 'receive',
    title: 'Deposit confirmed',
    body: `Your deposit of NGN ${normalizedAmount.toLocaleString()} has been credited to your wallet.`,
    data: {
      reference: transaction.reference,
      amount: normalizedAmount,
      currency: 'NGN',
      transactionId: transaction._id
    },
    sendEmail: true
  });

  return user;
}

async function reconcilePendingDepositsForUser(userId, { limit = 5 } = {}) {
  if (!flutterwaveService.isConfigured) {
    return { checked: 0, credited: 0 };
  }

  const pendingTransactions = await Transaction.find({
    userId,
    type: 'deposit',
    currency: 'NGN',
    status: 'pending',
    'metadata.provider': 'flutterwave',
    createdAt: { $gte: new Date(Date.now() - 48 * 60 * 60 * 1000) }
  })
    .sort({ createdAt: -1 })
    .limit(limit);

  let credited = 0;

  for (const pendingTransaction of pendingTransactions) {
    const metadata = getTransactionMetadata(pendingTransaction);
    const transactionId = metadata.flutterwaveId ? Number(metadata.flutterwaveId) : null;
    const verification = await verifyFlutterwaveDeposit(pendingTransaction.reference, transactionId);

    if (!verification.success) {
      continue;
    }

    const providerData = verification.data || {};
    const verifiedAmount = Number(providerData.amount || providerData.charged_amount || 0);
    const verifiedCurrency = String(providerData.currency || '').toUpperCase();
    const verifiedReference =
      providerData.tx_ref ||
      providerData.txRef ||
      pendingTransaction.reference;

    if (
      !isSuccessfulFlutterwaveStatus(providerData.status) ||
      verifiedCurrency !== 'NGN' ||
      verifiedReference !== pendingTransaction.reference ||
      verifiedAmount < Number(pendingTransaction.amount || 0)
    ) {
      continue;
    }

    const creditedUser = await withTransaction(async (session) => {
      const transactionInSession = await Transaction.findById(pendingTransaction._id).session(session);
      if (!transactionInSession || transactionInSession.status === 'completed') {
        return null;
      }

      return creditNgnDeposit({
        transaction: transactionInSession,
        amount: transactionInSession.amount,
        providerData,
        paymentMethod: providerData.payment_type || metadata.depositMethod || 'checkout',
        session
      });
    });

    if (creditedUser) {
      credited += 1;
    }
  }

  return {
    checked: pendingTransactions.length,
    credited
  };
}

// Get deposit address for crypto
router.get('/address/:chainId', authMiddleware, asyncHandler(async (req, res) => {
  const logger = new Logger('deposit/address');

  const user = await User.findById(req.userId);
  const wallet = user.wallets.find((w) => w.chainId === req.params.chainId);

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

// Request NGN deposit - Create Flutterwave checkout or virtual account
router.post('/ngn', authMiddleware, [
  body('amount').isFloat({ min: 100 }).withMessage('Minimum deposit is NGN 100'),
  body('method').optional().isIn(['checkout', 'virtual_account']).withMessage('Method must be either checkout or virtual_account')
], asyncHandler(async (req, res) => {
  const logger = new Logger('deposit/ngn');

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const user = await User.findById(req.userId);
  const amount = Number(req.body.amount);
  const method = req.body.method || 'checkout';
  const reference = `DP-NGN-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const customerName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  const customerBvn = String(user.bvn || '').trim();
  const customerNin = String(user.nin || '').trim();

  if (!customerName) {
    throw new AppError('Profile name is required before creating a deposit account', 400);
  }

  if (!user.email || user.email.trim() === '') {
    throw new AppError('Email is required before creating a deposit account', 400);
  }

  if (process.env.NODE_ENV === 'production' && !customerBvn && !customerNin) {
    throw new AppError('Complete BVN or NIN verification before requesting an NGN deposit account', 400);
  }

  let result = null;
  let providerResult = null;

  try {
    if (flutterwaveService.isConfigured) {
      if (method === 'checkout') {
        const callbackHost = process.env.FRONTEND_URL || process.env.APP_URL || 'https://flamex.app';
        providerResult = await flutterwaveService.createCheckout({
          amount,
          currency: 'NGN',
          email: user.email,
          phone: user.phone,
          fullName: customerName,
          txRef: reference,
          redirectUrl: `${callbackHost}/deposit/callback`,
          title: 'FlameX NGN Deposit',
          description: `Deposit NGN ${amount.toLocaleString()} to your FlameX wallet`
        });

        if (providerResult.success) {
          const checkoutData = providerResult.data || {};
          result = {
            method: 'checkout',
            checkoutUrl:
              checkoutData.link ||
              checkoutData.checkout_url ||
              checkoutData.payment_link ||
              checkoutData.meta?.authorization?.redirect ||
              checkoutData.authorization?.redirect,
            instructions: [
              'Click the payment link to complete your deposit',
              'You can pay with card, bank transfer, or USSD',
              'Deposit will be credited to your account once payment is confirmed'
            ]
          };
        }
      } else if (method === 'virtual_account') {
        providerResult = await flutterwaveService.createVirtualAccount({
          customerName,
          email: user.email,
          phone: user.phone,
          preferredBank: '044',
          txRef: reference
        });

        if (providerResult.success) {
          const accountData = providerResult.data || {};
          result = {
            method: 'virtual_account',
            bankDetails: {
              bankName: accountData.bank_name || accountData.bank || 'Flutterwave',
              bankCode: accountData.bank_code || accountData.bankCode || '044',
              accountNumber: accountData.account_number || accountData.accountNumber || '',
              accountName: accountData.account_name || customerName,
              flutterwaveAccountId: accountData.id || accountData.account_number || null,
              txRef: accountData.tx_ref || reference
            },
            instructions: [
              `Transfer NGN ${amount.toLocaleString()} to the account above`,
              'Use the reference as the transaction narration for faster confirmation',
              'Deposit will be credited to your account once payment is confirmed'
            ]
          };
        }
      }

      if (providerResult && !providerResult.success) {
        logger.warn(`Flutterwave ${method} creation failed`, {
          userId: req.userId,
          error: providerResult.error
        });
      }
    }
  } catch (error) {
    logger.error(`Failed to create Flutterwave ${method}: ${error.message}`);
    throw new AppError(
      `Failed to create ${method === 'checkout' ? 'payment link' : 'bank account'}. Please try again.`,
      503
    );
  }

  if (!result) {
    throw new AppError(
      providerResult?.error || `${method === 'checkout' ? 'Payment service' : 'Bank account creation service'} not available`,
      503
    );
  }

  const transaction = new Transaction({
    userId: req.userId,
    type: 'deposit',
    amount,
    currency: 'NGN',
    description: `NGN deposit via Flutterwave ${method === 'checkout' ? 'checkout' : 'bank transfer'}`,
    status: 'pending',
    reference,
    metadata: {
      ...result,
      provider: 'flutterwave',
      depositMethod: method,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    }
  });
  await transaction.save();

  logger.info(`NGN deposit ${method} created: ${reference}, amount: ${amount}`);

  res.json({
    success: true,
    message: `${method === 'checkout' ? 'Payment link' : 'Deposit account'} created`,
    reference,
    amount,
    method,
    ...result,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  });
}));

router.post('/verify', authMiddleware, [
  body('reference').trim().notEmpty().withMessage('Reference is required'),
  body('transactionId').optional().isInt().withMessage('transactionId must be a number')
], asyncHandler(async (req, res) => {
  const logger = new Logger('deposit/verify');
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const reference = String(req.body.reference || '').trim();
  const transactionId = req.body.transactionId ? Number(req.body.transactionId) : null;
  const transaction = await Transaction.findOne({ reference, userId: req.userId, type: 'deposit' });

  if (!transaction) {
    throw new AppError('Deposit transaction not found', 404);
  }

  if (transaction.status === 'completed') {
    const user = await User.findById(req.userId);
    return res.json({
      success: true,
      status: 'completed',
      reference,
      amount: transaction.amount,
      balances: user?.balances || null
    });
  }

  const verification = await verifyFlutterwaveDeposit(reference, transactionId);
  if (!verification.success) {
    logger.warn('Flutterwave deposit verification failed', {
      reference,
      transactionId,
      error: verification.error
    });

    return res.status(202).json({
      success: false,
      status: transaction.status,
      reference,
      message: verification.error || 'Payment is still being confirmed'
    });
  }

  const providerData = verification.data || {};
  const verifiedAmount = Number(providerData.amount || providerData.charged_amount || 0);
  const verifiedCurrency = String(providerData.currency || '').toUpperCase();
  const verifiedReference = providerData.tx_ref || providerData.txRef || reference;

  if (
    !isSuccessfulFlutterwaveStatus(providerData.status) ||
    verifiedCurrency !== 'NGN' ||
    verifiedReference !== reference ||
    verifiedAmount < Number(transaction.amount || 0)
  ) {
    return res.status(202).json({
      success: false,
      status: transaction.status,
      reference,
      message: 'Payment has not met verification checks yet'
    });
  }

  const user = await withTransaction(async (session) => {
    const transactionInSession = await Transaction.findById(transaction._id).session(session);
    if (!transactionInSession) {
      throw new AppError('Deposit transaction not found', 404);
    }

    if (transactionInSession.status === 'completed') {
      return User.findById(req.userId).session(session);
    }

    return creditNgnDeposit({
      transaction: transactionInSession,
      amount: transactionInSession.amount,
      providerData,
      paymentMethod: providerData.payment_type || 'checkout',
      session
    });
  });

  logger.info(`Deposit verified and credited: ${reference}, user: ${req.userId}`);

  res.json({
    success: true,
    status: 'completed',
    reference,
    amount: transaction.amount,
    balances: user?.balances || null
  });
}));

/**
 * WEBHOOK: Flutterwave Webhook Handler
 * Receives payment notifications from Flutterwave
 * Path: /webhooks/flutterwave
 */
async function handleFlutterwaveWebhook(req, res) {
  const logger = new Logger('deposit/webhooks/flutterwave');

  try {
    const { event, data } = req.body;

    const signature = req.headers['verif-hash'];
    logger.info('Incoming Flutterwave webhook', {
      signature,
      event,
      data,
      headers: {
        'verif-hash': signature,
        'user-agent': req.headers['user-agent'],
        'content-type': req.headers['content-type']
      }
    });

    if (!signature || signature !== process.env.FLUTTERWAVE_WEBHOOK_SECRET) {
      logger.warn('Invalid Flutterwave webhook signature', { signature });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const normalizedEvent = String(event || '').trim().toLowerCase();
    const isCheckoutEvent = normalizedEvent === 'charge.completed';
    const isTransferEvent = ['transfer.complete', 'transfer.completed'].includes(normalizedEvent);

    if (isCheckoutEvent && isSuccessfulFlutterwaveStatus(data?.status)) {
      const reference = data.tx_ref || data.txRef || data.reference;
      const transaction = await findDepositTransaction(reference, data);

      if (!transaction) {
        logger.warn(`Transaction not found for reference: ${reference}`);
        return res.json({ success: true });
      }

      if (transaction.status === 'completed') {
        logger.info(`Transaction already completed: ${reference}`);
        return res.json({ success: true });
      }

      await withTransaction(async (session) => {
        const verification = data.id
          ? await flutterwaveService.verifyTransaction(data.id)
          : await flutterwaveService.verifyTransactionByReference(reference);
        const providerData = verification.success ? (verification.data || data) : data;
        const verifiedAmount = Number(providerData.amount || providerData.charged_amount || 0);
        const verifiedCurrency = String(providerData.currency || '').toUpperCase();
        const verifiedReference = providerData.tx_ref || providerData.txRef || reference;

        if (
          !isSuccessfulFlutterwaveStatus(providerData.status) ||
          verifiedCurrency !== 'NGN' ||
          verifiedReference !== transaction.reference ||
          verifiedAmount < Number(transaction.amount || 0)
        ) {
          logger.warn('Flutterwave checkout webhook failed verification checks', {
            reference,
            verifiedReference,
            verifiedCurrency,
            verifiedAmount
          });
          return;
        }

        const transactionInSession = await Transaction.findById(transaction._id).session(session);
        if (!transactionInSession || transactionInSession.status === 'completed') {
          return;
        }

        await creditNgnDeposit({
          transaction: transactionInSession,
          amount: transactionInSession.amount,
          providerData,
          paymentMethod: providerData.payment_type || 'checkout',
          session
        });
      });

      logger.info(`Deposit confirmed via checkout: ${reference}, amount: ${transaction.amount}, user: ${transaction.userId}`);
    }

    if (isTransferEvent && isSuccessfulFlutterwaveStatus(data?.status)) {
      const reference = data.tx_ref || data.txRef || data.reference || data.id;
      const transaction = await findDepositTransaction(reference, data);

      if (!transaction) {
        logger.warn(`Transaction not found for reference: ${reference}`);
        return res.json({ success: true });
      }

      if (transaction.status === 'completed') {
        logger.info(`Transaction already completed: ${reference}`);
        return res.json({ success: true });
      }

      await withTransaction(async (session) => {
        const transactionInSession = await Transaction.findById(transaction._id).session(session);
        if (!transactionInSession || transactionInSession.status === 'completed') {
          return;
        }

        await creditNgnDeposit({
          transaction: transactionInSession,
          amount: transactionInSession.amount,
          providerData: data,
          paymentMethod: 'virtual_account',
          session
        });
      });

      logger.info(`Deposit confirmed via transfer: ${reference}, amount: ${transaction.amount}, user: ${transaction.userId}`);
    }

    res.json({ status: 'success' });
  } catch (error) {
    logger.error(`Webhook processing error: ${error.message}`);
    res.status(200).json({ status: 'error', message: error.message });
  }
}

router.post('/webhooks/flutterwave', asyncHandler(handleFlutterwaveWebhook));

router.use((err, req, res, next) => {
  handleError(err, req, res, new Logger('deposit'));
});

module.exports = { router, handleFlutterwaveWebhook, reconcilePendingDepositsForUser };
