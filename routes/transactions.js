const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const GiftCardTrade = require('../models/GiftCardTrade');
const User = require('../models/User');
const { withTransaction } = require('../utils/database');
const { AppError } = require('../utils/errorHandler');
const emailService = require('../services/email');

const SUPPORTED_BILL_CURRENCIES = new Set(['NGN', 'USD']);

// Get user transactions
router.get('/', authMiddleware, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(100);
    
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get single transaction receipt and optionally email it
router.get('/:id/receipt', authMiddleware, async (req, res) => {
  try {
    const transaction = await Transaction.findOne({ _id: req.params.id, userId: req.userId });
    if (!transaction) return res.status(404).json({ message: 'Transaction not found' });

    const user = await User.findById(req.userId).select('email settings');
    const sendEmail = req.query.email !== 'false' && user?.email;

    if (sendEmail) {
      emailService.sendReceiptEmail({ to: user.email, transaction }).catch(err =>
        console.error('Receipt email error:', err.message)
      );
    }

    res.json({ success: true, transaction, emailSent: Boolean(sendEmail) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Pay bill
router.post('/bill', authMiddleware, async (req, res) => {
  try {
    const { type, provider, customerId } = req.body;
    const currency = String(req.body.currency || '').toUpperCase();
    const amount = Number(req.body.amount);

    if (!type || !provider || !customerId || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Invalid bill payment details' });
    }
    if (!SUPPORTED_BILL_CURRENCIES.has(currency)) {
      return res.status(400).json({ message: `Unsupported bill currency: ${currency || 'unknown'}` });
    }

    const reference = `BILL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await withTransaction(async (session) => {
      const user = await User.findById(req.userId).session(session);
      if (!user) {
        throw new AppError('User not found', 404);
      }

      const balance = Number(user.balances[currency] || 0);
      const lockedBalance = Number(user.lockedBalances?.[currency] || 0);
      const availableBalance = balance - lockedBalance;
      if (availableBalance < amount) {
        throw new AppError(`Insufficient available ${currency} balance`, 400);
      }

      user.balances[currency] = Number((balance - amount).toFixed(8));
      const transaction = new Transaction({
        userId: user._id,
        type: 'bill_payment',
        amount,
        currency,
        status: 'completed',
        description: `${type} payment to ${provider}`,
        reference,
        metadata: { billType: type, provider, customerId }
      });

      await Promise.all([user.save({ session }), transaction.save({ session })]);
      return { balance: user.balances[currency], transaction };
    });

    res.json({ message: 'Bill payment successful', reference, balance: result.balance });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// Legacy gift card purchase route
router.post('/gift-card', authMiddleware, async (req, res) => {
  res.status(410).json({
    message: 'Gift card instant purchase has been retired. Submit manual trades through /api/bills/giftcard-trade instead.'
  });
});

// Get bill payments
router.get('/bills', authMiddleware, async (req, res) => {
  try {
    const bills = await Transaction.find({
      userId: req.userId,
      type: { $in: ['bill_payment', 'airtime', 'data', 'electricity', 'cable', 'betting', 'giftcard'] }
    })
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json(bills);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get gift card trades
router.get('/gift-cards', authMiddleware, async (req, res) => {
  try {
    const giftCards = await GiftCardTrade.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json(giftCards);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
