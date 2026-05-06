const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const UserTransfer = require('../models/UserTransfer');
const Transaction = require('../models/Transaction');
const { createNotification } = require('../services/notifications');
const { requireVerifiedKycForTransactions } = require('../middleware/kyc');

// Validate username
router.get('/validate-username/:username', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ 
      username: req.params.username.toLowerCase() 
    }).select('username firstName lastName profilePicture');

    if (!user) {
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
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Transfer by username
router.post('/username', authMiddleware, requireVerifiedKycForTransactions, [
  body('toUsername').trim().isLength({ min: 3 }),
  body('amount').isFloat({ min: 0.000001 }),
  body('currency').notEmpty(),
  body('pin').isLength({ min: 4, max: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { toUsername, amount, currency, chainId = 'solana', description = '', pin } = req.body;
    const sender = await User.findById(req.userId);

    const pinMatch = await sender.comparePin(pin);
    if (!pinMatch) {
      return res.status(400).json({ message: 'Invalid PIN' });
    }

    const senderBalance = sender.balances[currency.toUpperCase()] || 0;
    if (senderBalance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    const recipient = await User.findOne({ username: toUsername.toLowerCase() });
    if (!recipient) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (recipient._id.toString() === sender._id.toString()) {
      return res.status(400).json({ message: 'Cannot transfer to yourself' });
    }

    const fee = Math.max(0.01, amount * 0.001);
    const netAmount = amount - fee;
    const reference = `TRF-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const transfer = new UserTransfer({
      fromUserId: sender._id,
      fromUsername: sender.username || sender.email,
      toUserId: recipient._id,
      toUsername: recipient.username,
      amount: netAmount,
      currency: currency.toUpperCase(),
      chainId,
      fee,
      description,
      reference,
      status: 'completed'
    });

    sender.balances[currency.toUpperCase()] -= amount;
    recipient.balances[currency.toUpperCase()] = (recipient.balances[currency.toUpperCase()] || 0) + netAmount;

    const senderTx = new Transaction({
      userId: sender._id,
      type: 'user_transfer_sent',
      amount,
      currency: currency.toUpperCase(),
      description: `Transfer to @${recipient.username}`,
      status: 'completed',
      toUserId: recipient._id,
      toUsername: recipient.username,
      fee,
      reference
    });

    const recipientTx = new Transaction({
      userId: recipient._id,
      type: 'user_transfer_received',
      amount: netAmount,
      currency: currency.toUpperCase(),
      description: `Transfer from @${sender.username || sender.email}`,
      status: 'completed',
      fromUserId: sender._id,
      fromUsername: sender.username || sender.email,
      reference
    });

    await Promise.all([
      transfer.save(),
      sender.save(),
      recipient.save(),
      senderTx.save(),
      recipientTx.save()
    ]);

    await Promise.all([
      createNotification({
        user: sender,
        type: 'send',
        title: 'Transfer sent',
        body: `You sent ${amount} ${currency.toUpperCase()} to @${recipient.username}.`,
        data: {
          reference,
          amount,
          fee,
          currency: currency.toUpperCase(),
          transactionId: senderTx._id,
          username: recipient.username
        },
        sendEmail: true,
        emailAmount: amount,
        emailCurrency: currency.toUpperCase(),
        emailReference: reference
      }),
      createNotification({
        user: recipient,
        type: 'receive',
        title: 'Transfer received',
        body: `You received ${netAmount} ${currency.toUpperCase()} from @${sender.username || sender.email}.`,
        data: {
          reference,
          amount: netAmount,
          currency: currency.toUpperCase(),
          transactionId: recipientTx._id,
          username: sender.username || sender.email
        },
        sendEmail: true,
        emailAmount: netAmount,
        emailCurrency: currency.toUpperCase(),
        emailReference: reference
      })
    ]);

    res.json({
      message: 'Transfer successful',
      transfer: {
        reference,
        toUsername: recipient.username,
        amount: netAmount,
        currency: currency.toUpperCase(),
        fee
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

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

module.exports = router;
