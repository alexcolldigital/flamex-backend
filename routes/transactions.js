const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const BillPayment = require('../models/BillPayment');
const GiftCardPurchase = require('../models/GiftCardPurchase');
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
    
    // Create bill payment record
    const billPayment = new BillPayment({
      userId: req.userId,
      type,
      provider,
      customerId,
      amount: parseFloat(amount),
      currency,
      status: 'completed',
      reference: 'BILL' + Date.now()
    });
    await billPayment.save();
    
    // Create transaction
    const transaction = new Transaction({
      userId: req.userId,
      type: 'bill_payment',
      amount: parseFloat(amount),
      currency,
      status: 'completed',
      description: `${type} payment to ${provider}`,
      billType: type,
      provider
    });
    await transaction.save();
    
    res.json({
      message: 'Bill payment successful',
      reference: billPayment.reference,
      balance: user.balances[currency]
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Buy gift card
router.post('/gift-card', authMiddleware, async (req, res) => {
  try {
    const { provider, amount, currency, paymentCurrency } = req.body;
    
    // Calculate payment amount based on rates
    const rates = {
      amazon: 1450, apple: 1400, google: 1350, steam: 1300,
      netflix: 1200, spotify: 1100, xbox: 1250, playstation: 1250
    };
    const rate = rates[provider] || 1400;
    const paymentAmount = amount * rate;
    
    const user = await User.findById(req.userId);
    
    // Check balance
    if (user.balances[paymentCurrency] < paymentAmount) {
      return res.status(400).json({ message: `Insufficient ${paymentCurrency} balance` });
    }
    
    // Deduct balance
    user.balances[paymentCurrency] -= paymentAmount;
    await user.save();
    
    // Generate card code
    const cardCode = Array(16).fill(0).map(() => Math.floor(Math.random() * 10)).join('');
    
    // Create gift card purchase record
    const giftCard = new GiftCardPurchase({
      userId: req.userId,
      provider,
      amount: parseFloat(amount),
      currency,
      paymentCurrency,
      paymentAmount,
      cardCode,
      status: 'completed',
      reference: 'GC' + Date.now()
    });
    await giftCard.save();
    
    // Create transaction
    const transaction = new Transaction({
      userId: req.userId,
      type: 'gift_card',
      amount: paymentAmount,
      currency: paymentCurrency,
      status: 'completed',
      description: `${provider} gift card $${amount}`
    });
    await transaction.save();
    
    res.json({
      message: 'Gift card purchased successfully',
      reference: giftCard.reference,
      cardCode,
      balance: user.balances[paymentCurrency]
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get bill payments
router.get('/bills', authMiddleware, async (req, res) => {
  try {
    const bills = await BillPayment.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json(bills);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get gift card purchases
router.get('/gift-cards', authMiddleware, async (req, res) => {
  try {
    const giftCards = await GiftCardPurchase.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json(giftCards);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
