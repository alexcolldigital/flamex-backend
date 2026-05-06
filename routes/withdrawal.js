const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const monnifyService = require('../services/monnify');
const flutterwaveService = require('../services/flutterwave');
const { createNotification } = require('../services/notifications');
const { requireVerifiedKycForTransactions } = require('../middleware/kyc');

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

    // Try Monnify first, then Flutterwave, fallback to mock
    let accountName = `${user.firstName} ${user.lastName}`;

    if (monnifyService.isConfigured) {
      const verifyResult = await monnifyService.verifyAccount(accountNumber, bankCode);
      if (verifyResult.success) {
        accountName = verifyResult.accountName;
      }
    } else if (flutterwaveService.isConfigured) {
      const verifyResult = await flutterwaveService.verifyAccount(accountNumber, bankCode);
      if (verifyResult.success) {
        accountName = verifyResult.data?.account_name || accountName;
      }
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

// NGN Withdrawal
router.post('/ngn', authMiddleware, requireVerifiedKycForTransactions, [
  body('amount').isFloat({ min: 500 }),
  body('bankCode').notEmpty(),
  body('accountNumber').isLength({ min: 10, max: 10 }),
  body('accountName').notEmpty(),
  body('pin').isLength({ min: 4, max: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { amount, bankCode, accountNumber, accountName, pin } = req.body;
    const user = await User.findById(req.userId);

    const pinMatch = await user.comparePin(pin);
    if (!pinMatch) {
      return res.status(400).json({ message: 'Invalid PIN' });
    }

    if (user.balances.NGN < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    const fee = amount < 10000 ? 50 : 0;
    const reference = `WD-NGN-${Date.now()}`;

    // Try Monnify first, then Flutterwave, fallback to mock
    let transferResult = null;

    if (monnifyService.isConfigured) {
      transferResult = await monnifyService.initiateTransfer({
        amount: amount - fee,
        accountNumber,
        bankCode,
        accountName,
        narration: 'FlameX Withdrawal',
        reference
      });
    } else if (flutterwaveService.isConfigured) {
      transferResult = await flutterwaveService.initiateTransfer({
        amount: amount - fee,
        accountNumber,
        bankCode,
        accountName,
        narration: 'FlameX Withdrawal',
        reference
      });
    }

    const transaction = new Transaction({
      userId: req.userId,
      type: 'withdrawal',
      amount,
      currency: 'NGN',
      description: `Withdrawal to ${accountName}`,
      status: transferResult?.success ? 'pending' : 'pending',
      fee,
      reference,
      metadata: { transferResult, bankCode, accountNumber }
    });
    await transaction.save();

    user.balances.NGN -= amount;
    await user.save();

    await createNotification({
      user,
      type: 'send',
      title: 'NGN withdrawal initiated',
      body: `Your withdrawal of ${amount} NGN to ${accountName} has been initiated.`,
      data: {
        reference,
        amount,
        fee,
        currency: 'NGN',
        transactionId: transaction._id,
        accountNumber,
        bankCode
      },
      sendEmail: true,
      emailAmount: amount,
      emailCurrency: 'NGN',
      emailReference: reference
    });

    res.json({
      message: 'Withdrawal initiated',
      reference,
      amount: amount - fee,
      fee,
      newBalance: user.balances.NGN,
      transferStatus: transferResult?.success ? 'processing' : 'pending'
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Crypto Withdrawal
router.post('/crypto', authMiddleware, requireVerifiedKycForTransactions, [
  body('chainId').notEmpty(),
  body('token').notEmpty(),
  body('amount').isFloat({ min: 0 }),
  body('toAddress').notEmpty(),
  body('pin').isLength({ min: 4, max: 6 })
], async (req, res) => {
  try {
    const { chainId, token, amount, toAddress, pin } = req.body;
    const user = await User.findById(req.userId);

    const pinMatch = await user.comparePin(pin);
    if (!pinMatch) {
      return res.status(400).json({ message: 'Invalid PIN' });
    }

    const balance = user.balances[token.toUpperCase()] || 0;
    if (balance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    const reference = `WD-CRP-${Date.now()}`;

    const transaction = new Transaction({
      userId: req.userId,
      type: 'withdrawal',
      amount,
      currency: token.toUpperCase(),
      chainId,
      description: `${token} withdrawal`,
      status: 'pending',
      reference
    });
    await transaction.save();

    user.balances[token.toUpperCase()] -= amount;
    await user.save();

    await createNotification({
      user,
      type: 'send',
      title: 'Crypto withdrawal initiated',
      body: `Your ${token.toUpperCase()} withdrawal to ${toAddress} has been initiated.`,
      data: {
        reference,
        amount,
        currency: token.toUpperCase(),
        transactionId: transaction._id,
        chainId,
        toAddress
      },
      sendEmail: true,
      emailAmount: amount,
      emailCurrency: token.toUpperCase(),
      emailReference: reference
    });

    res.json({
      message: 'Withdrawal initiated',
      reference,
      newBalance: user.balances[token.toUpperCase()]
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
