const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authMiddleware, requireTransactionPinSet } = require('../middleware/auth');
const User = require('../models/User');
const UserTransfer = require('../models/UserTransfer');
const Transaction = require('../models/Transaction');
const { createNotification } = require('../services/notifications');
const { requireVerifiedKycForTransactions } = require('../middleware/kyc');
const { AppError, handleError, asyncHandler } = require('../utils/errorHandler');
const { withTransaction } = require('../utils/database');
const { storeOTP, sendOTPEmail, verifyOTP, requires2FA } = require('../utils/twoFA');
const Logger = require('../utils/logger');

function getAvailableBalance(user, currency) {
  const currencyUpper = String(currency || '').toUpperCase();
  const balance = Number(user?.balances?.[currencyUpper] || 0);
  const locked = Number(user?.lockedBalances?.[currencyUpper] || 0);
  return Math.max(0, balance - locked);
}

// Validate username
router.get('/validate-username/:username', authMiddleware, asyncHandler(async (req, res) => {
  const user = await User.findOne({ 
    username: req.params.username.toLowerCase() 
  }).select('username firstName lastName profilePicture settings.privacy.allowUsernameSearch');

  if (!user || user.settings?.privacy?.allowUsernameSearch === false) {
    return res.json({ valid: false, message: 'User not found' });
  }

  res.json({
    valid: true,
    user: {
      id: user._id,
      username: user.username,
      name: `${user.firstName} ${user.lastName}`
    }
  });
}));

// Request 2FA OTP for transfer
router.post('/request-otp', authMiddleware, requireTransactionPinSet, requireVerifiedKycForTransactions, [
  body('toUsername').trim().isLength({ min: 3 }),
  body('amount').isFloat({ min: 0.000001 }),
  body('currency').notEmpty()
], asyncHandler(async (req, res) => {
  const logger = new Logger('transfer/request-otp');
  
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { toUsername, currency } = req.body;
  const amount = Number(req.body.amount);
  const sender = await User.findById(req.userId);

  // Check if 2FA is required
  if (!requires2FA(sender, amount)) {
    return res.json({ requiresOTP: false });
  }

  // Verify recipient exists
  const recipient = await User.findOne({ username: toUsername.toLowerCase() });
  if (!recipient) {
    throw new AppError('User not found', 404);
  }

  // Generate and send OTP
  const otp = await storeOTP(sender, 'transfer');
  await sendOTPEmail(sender, otp, 'transfer');

  logger.info(`OTP sent for transfer of ${amount} ${currency} to ${toUsername}`);

  res.json({
    requiresOTP: true,
    message: 'OTP sent to your email',
    recipient: {
      username: recipient.username,
      name: `${recipient.firstName} ${recipient.lastName}`
    }
  });
}));

// Transfer by username with OTP verification
router.post('/username', authMiddleware, requireTransactionPinSet, requireVerifiedKycForTransactions, [
  body('toUsername').trim().isLength({ min: 3 }).withMessage('Invalid username'),
  body('amount').isFloat({ min: 0.000001 }).withMessage('Invalid amount'),
  body('currency').notEmpty().withMessage('Currency required'),
  body('pin').isLength({ min: 4, max: 4 }).isNumeric().withMessage('PIN must be exactly 4 digits'),
  body('otp').optional().isString(),
  body('chainId').optional().isString(),
  body('description').optional().isString()
], asyncHandler(async (req, res) => {
  const logger = new Logger('transfer/username');
  
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { toUsername, currency, chainId = 'solana', description = '', pin, otp } = req.body;
  const amount = Number(req.body.amount);
  const currencyUpper = currency.toUpperCase();
  
  let sender = await User.findById(req.userId);

  // Verify PIN
  const pinMatch = await sender.comparePin(pin);
  if (!pinMatch) {
    throw new AppError('Invalid PIN', 400);
  }

  // Check sender balance (including locked balances)
  const senderAvailableBalance = getAvailableBalance(sender, currencyUpper);

  if (senderAvailableBalance < amount) {
    throw new AppError(
      `Insufficient available ${currencyUpper} balance. Available: ${senderAvailableBalance}, Required: ${amount}`,
      400
    );
  }

  // Find recipient
  const recipient = await User.findOne({ username: toUsername.toLowerCase() });
  if (!recipient) {
    throw new AppError('Recipient not found', 404);
  }

  if (recipient.settings?.privacy?.allowUsernameSearch === false) {
    throw new AppError('Recipient not found', 404);
  }

  if (recipient._id.toString() === sender._id.toString()) {
    throw new AppError('Cannot transfer to yourself', 400);
  }

  // Verify 2FA if required
  if (requires2FA(sender, amount)) {
    if (!otp) {
      return res.status(202).json({
        success: false,
        message: '2FA verification required',
        requiresOTP: true
      });
    }

    await verifyOTP(sender, otp, 'transfer');
    sender = await User.findById(req.userId); // Refresh sender after OTP verification
  }

  const fee = Number(Math.max(0.01, amount * 0.001).toFixed(8)); // 0.1% fee, minimum 0.01
  const netAmount = Number((amount - fee).toFixed(8));
  if (netAmount <= 0) {
    throw new AppError('Transfer amount is too small after fees', 400);
  }
  const reference = `TRF-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Use transaction to ensure atomicity
  return withTransaction(async (session) => {
    const [sessionSender, sessionRecipient] = await Promise.all([
      User.findById(sender._id).session(session),
      User.findById(recipient._id).session(session)
    ]);

    if (!sessionSender || !sessionRecipient) {
      throw new AppError('Unable to load transfer participants', 404);
    }

    if (getAvailableBalance(sessionSender, currencyUpper) < amount) {
      throw new AppError(
        `Insufficient available ${currencyUpper} balance. Available: ${getAvailableBalance(sessionSender, currencyUpper)}, Required: ${amount}`,
        400
      );
    }

    // Deduct from sender
    sessionSender.balances[currencyUpper] = Number((Number(sessionSender.balances[currencyUpper] || 0) - amount).toFixed(8));
    
    // Add to recipient
    sessionRecipient.balances[currencyUpper] = Number((Number(sessionRecipient.balances[currencyUpper] || 0) + netAmount).toFixed(8));

    // Create transfer record
    const transfer = new UserTransfer({
      fromUserId: sessionSender._id,
      fromUsername: sessionSender.username || sessionSender.email,
      toUserId: sessionRecipient._id,
      toUsername: sessionRecipient.username,
      amount: netAmount,
      currency: currencyUpper,
      chainId,
      fee,
      description,
      reference,
      status: 'completed',
      completedAt: new Date()
    });

    // Create separate transaction records (with unique references)
    const senderTx = new Transaction({
      userId: sessionSender._id,
      type: 'user_transfer_sent',
      amount,
      currency: currencyUpper,
      description: `Transfer to @${sessionRecipient.username}`,
      status: 'completed',
      toUserId: sessionRecipient._id,
      toUsername: sessionRecipient.username,
      fee,
      reference: `${reference}-SEND`,
      metadata: {
        transferId: transfer._id,
        netAmount,
        recipientUsername: sessionRecipient.username
      }
    });

    const recipientTx = new Transaction({
      userId: sessionRecipient._id,
      type: 'user_transfer_received',
      amount: netAmount,
      currency: currencyUpper,
      description: `Transfer from @${sessionSender.username || sessionSender.email}`,
      status: 'completed',
      fromUserId: sessionSender._id,
      fromUsername: sessionSender.username || sessionSender.email,
      reference: `${reference}-RECEIVE`,
      metadata: {
        transferId: transfer._id,
        senderUsername: sessionSender.username
      }
    });

    await Promise.all([
      transfer.save({ session }),
      sessionSender.save({ session }),
      sessionRecipient.save({ session }),
      senderTx.save({ session }),
      recipientTx.save({ session })
    ]);

    logger.info(`Transfer completed: ${reference}, sender: ${sessionSender._id}, recipient: ${sessionRecipient._id}, amount: ${amount} ${currencyUpper}`);

    // Send notifications
    await Promise.all([
      createNotification({
        user: sessionSender,
        type: 'send',
        title: 'Transfer sent',
        body: `You sent ${amount} ${currencyUpper} to @${sessionRecipient.username}.`,
        data: {
          reference,
          amount,
          fee,
          currency: currencyUpper,
          transactionId: senderTx._id,
          username: sessionRecipient.username
        },
        sendEmail: true,
        transaction: senderTx
      }),
      createNotification({
        user: sessionRecipient,
        type: 'receive',
        title: 'Transfer received',
        body: `You received ${netAmount} ${currencyUpper} from @${sessionSender.username || sessionSender.email}.`,
        data: {
          reference,
          amount: netAmount,
          currency: currencyUpper,
          transactionId: recipientTx._id,
          username: sessionSender.username || sessionSender.email
        },
        sendEmail: true,
        transaction: recipientTx
      })
    ]);

    res.json({
      success: true,
      message: 'Transfer completed successfully',
      reference,
      amount,
      fee,
      netAmount,
      recipient: {
        username: sessionRecipient.username,
        name: `${sessionRecipient.firstName} ${sessionRecipient.lastName}`
      },
      newBalance: sessionSender.balances[currencyUpper]
    });
  });
}));

// Get transfer history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const transfers = await UserTransfer.find({
      $or: [{ fromUserId: req.userId }, { toUserId: req.userId }]
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    res.json({ transfers });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Global error handler
router.use((err, req, res, next) => {
  handleError(err, req, res, new Logger('transfer'));
});

module.exports = router;
