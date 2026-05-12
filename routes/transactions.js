const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const GiftCardTrade = require('../models/GiftCardTrade');
const User = require('../models/User');

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

// Pay bill
router.post('/bill', authMiddleware, async (req, res) => {
  try {
    const { type, provider, customerId, amount, currency } = req.body;
    
    const user = await User.findById(req.userId);
    
    // Check balance
    if (user.balances[currency] < parseFloat(amount)) {
      return res.status(400).json({ message: `Insufficient ${currency} balance` });
    }
    
    // Deduct balance
    user.balances[currency] -= parseFloat(amount);
    await user.save();
    
    // Create transaction
    const transaction = new Transaction({
      userId: req.userId,
      type: 'bill_payment',
      amount: parseFloat(amount),
      currency,
      status: 'completed',
      description: `${type} payment to ${provider}`,
      reference: 'BILL' + Date.now(),
      metadata: {
        billType: type,
        provider,
        customerId
      }
    });
    await transaction.save();
    
    res.json({
      message: 'Bill payment successful',
      reference: transaction.reference,
      balance: user.balances[currency]
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
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
