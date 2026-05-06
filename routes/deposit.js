const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const monnifyService = require('../services/monnify');

// Get deposit address
router.get('/address/:chainId', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const wallet = user.wallets.find(w => w.chainId === req.params.chainId);
    
    if (!wallet) {
      return res.status(404).json({ message: 'Wallet not found' });
    }

    const explorers = {
      solana: 'https://solscan.io/account/',
      ethereum: 'https://etherscan.io/address/',
      bsc: 'https://bscscan.com/address/',
      polygon: 'https://polygonscan.com/address/'
    };

    res.json({
      chainId: req.params.chainId,
      address: wallet.address,
      explorerUrl: explorers[req.params.chainId] + wallet.address
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// NGN Deposit
router.post('/ngn', authMiddleware, [
  body('amount').isFloat({ min: 100 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = await User.findById(req.userId);
    const { amount } = req.body;
    const reference = `DP-NGN-${Date.now()}`;

    // Try Monnify first, fallback to mock if not configured
    let bankDetails = null;
    let monnifyResult = null;

    if (monnifyService.isConfigured) {
      monnifyResult = await monnifyService.createReservedAccount({
        userId: user._id.toString(),
        userName: `${user.firstName} ${user.lastName}`,
        email: user.email,
        bvn: user.kyc?.bvn || '',
        phoneNumber: user.phone
      });

      if (monnifyResult.success) {
        bankDetails = {
          bankName: monnifyResult.bank?.name || 'Wema Bank',
          accountNumber: monnifyResult.accounts?.[0]?.accountNumber || '1234567890',
          accountName: monnifyResult.accounts?.[0]?.accountName || `${user.firstName} ${user.lastName}`
        };
      }
    }

    // Fallback to mock if Monnify not configured
    if (!bankDetails) {
      bankDetails = {
        bankName: 'Wema Bank',
        accountNumber: '1234567890',
        accountName: `${user.firstName} ${user.lastName}`
      };
    }

    const transaction = new Transaction({
      userId: req.userId,
      type: 'deposit',
      amount,
      currency: 'NGN',
      description: 'NGN deposit',
      status: 'pending',
      reference,
      metadata: { monnifyResult }
    });
    await transaction.save();

    res.json({
      message: 'Deposit initiated',
      reference,
      amount,
      bankDetails,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
