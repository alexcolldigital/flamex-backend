const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { createWalletSecret, decrypt } = require('../utils/encryption');
const { reconcilePendingDepositsForUser } = require('./deposit');
const flutterwaveService = require('../services/flutterwave');
const { withTransaction } = require('../utils/database');
const { AppError } = require('../utils/errorHandler');

const CHAIN_METADATA = [
  { id: 'solana', name: 'Solana', symbol: 'SOL', color: '#9945FF', explorerBaseUrl: 'https://solscan.io/account/' },
  { id: 'ethereum', name: 'Ethereum', symbol: 'ETH', color: '#627EEA', explorerBaseUrl: 'https://etherscan.io/address/' },
  { id: 'bsc', name: 'BSC', symbol: 'BNB', color: '#F3BA2F', explorerBaseUrl: 'https://bscscan.com/address/' },
  { id: 'polygon', name: 'Polygon', symbol: 'MATIC', color: '#8247E5', explorerBaseUrl: 'https://polygonscan.com/address/' },
  { id: 'base', name: 'Base', symbol: 'ETH', color: '#0052FF', explorerBaseUrl: 'https://basescan.org/address/' },
  { id: 'arbitrum', name: 'Arbitrum', symbol: 'ETH', color: '#28A0F0', explorerBaseUrl: 'https://arbiscan.io/address/' }
];

function buildWalletSummary(user) {
  const wallets = (user.wallets || []).map((wallet) => {
    const chain = CHAIN_METADATA.find((item) => item.id === wallet.chainId) || {
      id: wallet.chainId,
      name: wallet.chainId,
      symbol: wallet.chainId.toUpperCase(),
      color: '#64748B',
      explorerBaseUrl: ''
    };

    return {
      chainId: wallet.chainId,
      address: wallet.address,
      publicKey: wallet.publicKey,
      chain,
      balance: user.balances[chain.symbol] || 0,
      explorerUrl: chain.explorerBaseUrl ? `${chain.explorerBaseUrl}${wallet.address}` : null
    };
  });

  const primaryWallet =
    wallets.find((wallet) => wallet.address === user.primaryWalletAddress) || wallets[0] || null;

  return {
    balances: user.balances,
    lockedBalances: user.lockedBalances,
    wallets,
    walletAddress: primaryWallet?.address || null,
    primaryWalletAddress: primaryWallet?.address || null,
    primaryWallet,
    fiatAccounts: user.fiatAccounts || {},
    virtualCard: user.virtualCard,
    bankAccounts: user.bankAccounts,
    profile: {
      username: user.username,
      kycVerified: user.kycVerified,
      kycLevel: user.kycLevel
    }
  };
}

// Get wallet summary
router.get('/', authMiddleware, async (req, res) => {
  try {
    await reconcilePendingDepositsForUser(req.userId);
    const user = await User.findById(req.userId);
    res.json(buildWalletSummary(user));
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/summary', authMiddleware, async (req, res) => {
  try {
    await reconcilePendingDepositsForUser(req.userId);
    const user = await User.findById(req.userId);
    res.json(buildWalletSummary(user));
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get balances
router.get('/balances', authMiddleware, async (req, res) => {
  try {
    await reconcilePendingDepositsForUser(req.userId);
    const user = await User.findById(req.userId);
    const walletsByChain = {};

    for (const wallet of user.wallets) {
      const chain = CHAIN_METADATA.find((item) => item.id === wallet.chainId);
      if (chain) {
        walletsByChain[wallet.chainId] = {
          chain,
          address: wallet.address,
          balance: user.balances[chain.symbol] || 0
        };
      }
    }

    res.json({
      ngnBalance: user.balances.NGN,
      balances: user.balances,
      lockedBalances: user.lockedBalances,
      wallets: walletsByChain
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get transactions
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const currentPage = parseInt(page, 10);
    const pageSize = parseInt(limit, 10);

    const transactions = await Transaction.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .skip((currentPage - 1) * pageSize)
      .limit(pageSize);

    const total = await Transaction.countDocuments({ userId: req.userId });

    res.json({
      transactions,
      pagination: {
        page: currentPage,
        limit: pageSize,
        total,
        pages: Math.ceil(total / pageSize)
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Export keys
router.post('/export-keys', authMiddleware, async (req, res) => {
  try {
    const { password, chainId } = req.body;
    const user = await User.findById(req.userId);
    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid password' });
    }

    const result = { mnemonic: null, wallets: [] };
    const userSecret = createWalletSecret(password);

    if (user.encryptedMnemonic) {
      try {
        result.mnemonic = decrypt(user.encryptedMnemonic, userSecret);
      } catch (error) {
        console.error('Failed to decrypt mnemonic');
      }
    }

    for (const wallet of user.wallets) {
      if (chainId && wallet.chainId !== chainId) continue;

      try {
        const privateKey = decrypt(wallet.encryptedPrivateKey, userSecret);
        result.wallets.push({
          chainId: wallet.chainId,
          address: wallet.address,
          privateKey,
          publicKey: wallet.publicKey
        });
      } catch (error) {
        console.error(`Failed to decrypt key for ${wallet.chainId}`);
      }
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Bank accounts
router.post('/bank-account', authMiddleware, async (req, res) => {
  try {
    const { bankName, bankCode, accountNumber, accountName, isDefault = false } = req.body;
    if (!bankName || !bankCode || !accountNumber || !accountName) {
      return res.status(400).json({ message: 'Incomplete bank account details' });
    }

    const user = await User.findById(req.userId);
    if (isDefault) {
      user.bankAccounts.forEach((account) => {
        account.isDefault = false;
      });
    }

    user.bankAccounts.push({ bankName, bankCode, accountNumber, accountName, isDefault });
    await user.save();

    res.json({ message: 'Bank account added', bankAccounts: user.bankAccounts });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/bank-account/:id', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    user.bankAccounts = user.bankAccounts.filter(
      (account) => account._id.toString() !== req.params.id
    );
    await user.save();

    res.json({ message: 'Bank account removed', bankAccounts: user.bankAccounts });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Virtual card
router.get('/virtual-card', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (user.virtualCard?.id && flutterwaveService.isConfigured) {
      const detailsResult = await flutterwaveService.getVirtualCardDetails(user.virtualCard.id);
      if (detailsResult.success && detailsResult.card) {
        user.virtualCard = {
          ...user.virtualCard,
          id: detailsResult.card.id || user.virtualCard.id,
          cardNumber: detailsResult.card.card_number || user.virtualCard.cardNumber,
          expiryMonth: detailsResult.card.expiration?.substring(0, 2) || user.virtualCard.expiryMonth,
          expiryYear: detailsResult.card.expiration?.substring(2) || user.virtualCard.expiryYear,
          cvv: detailsResult.card.cvv || user.virtualCard.cvv,
          status: detailsResult.card.is_active === false ? 'frozen' : (detailsResult.card.status || user.virtualCard.status || 'active'),
          balance: Number(detailsResult.card.amount || user.virtualCard.balance || 0)
        };
        await user.save();
      }
    }

    res.json({ virtualCard: user.virtualCard });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/virtual-card', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const { color = 'purple' } = req.body;
    if (user.virtualCard?.id) {
      return res.status(400).json({ message: 'Virtual card already exists' });
    }

    if (!flutterwaveService.isConfigured) {
      return res.status(503).json({ message: 'Virtual card service is not configured' });
    }

    const cardResult = await flutterwaveService.createVirtualCard({
      currency: 'USD',
      amount: 0,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      callbackUrl: process.env.APP_URL ? `${process.env.APP_URL}/webhooks/flutterwave` : undefined
    });

    if (!cardResult.success || !cardResult.card) {
      return res.status(502).json({ message: cardResult.error || 'Unable to create virtual card' });
    }

    const expiration = String(cardResult.card.expiration || '');
    user.virtualCard = {
      id: cardResult.card.id,
      color,
      cardNumber: cardResult.card.card_number || null,
      expiryMonth: expiration.substring(0, 2) || null,
      expiryYear: expiration.substring(2) || null,
      cvv: cardResult.card.cvv || null,
      status: cardResult.card.status || 'active',
      balance: Number(cardResult.card.amount || 0)
    };
    await user.save();

    res.json({ message: 'Virtual card created', virtualCard: user.virtualCard });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/virtual-card/fund', authMiddleware, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const user = await User.findById(req.userId);

    if (!user.virtualCard?.cardNumber) {
      return res.status(400).json({ message: 'Create a virtual card first' });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }
    if (user.balances.NGN < amount) {
      return res.status(400).json({ message: 'Insufficient NGN balance' });
    }
    if (!flutterwaveService.isConfigured) {
      return res.status(503).json({ message: 'Virtual card service is not configured' });
    }

    const providerResult = await flutterwaveService.fundVirtualCard(user.virtualCard.id, amount);
    if (!providerResult.success) {
      return res.status(502).json({ message: providerResult.error || 'Unable to fund virtual card' });
    }

    const reference = `CARD-FUND-${Date.now()}`;
    const { updatedUser } = await withTransaction(async (session) => {
      const sessionUser = await User.findById(req.userId).session(session);
      if (!sessionUser) {
        throw new AppError('User not found', 404);
      }
      if (!sessionUser.virtualCard?.id) {
        throw new AppError('Virtual card not found', 400);
      }
      if (Number(sessionUser.balances.NGN || 0) < amount) {
        throw new AppError('Insufficient NGN balance', 400);
      }

      sessionUser.balances.NGN = Number((Number(sessionUser.balances.NGN || 0) - amount).toFixed(2));
      sessionUser.virtualCard.balance = Number((Number(sessionUser.virtualCard.balance || 0) + amount).toFixed(2));

      const transaction = new Transaction({
        userId: sessionUser._id,
        type: 'virtual_card',
        amount,
        currency: 'NGN',
        description: 'Funded virtual card',
        status: 'completed',
        reference,
        metadata: {
          cardId: sessionUser.virtualCard.id,
          provider: 'flutterwave',
          providerResponse: providerResult.data || null
        }
      });

      await Promise.all([
        sessionUser.save({ session }),
        transaction.save({ session })
      ]);

      return { updatedUser: sessionUser };
    });

    res.json({
      message: 'Virtual card funded',
      virtualCard: updatedUser.virtualCard,
      balances: updatedUser.balances
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

router.post('/virtual-card/freeze', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user.virtualCard?.cardNumber) {
      return res.status(400).json({ message: 'Virtual card not found' });
    }

    if (user.virtualCard.status === 'cancelled' || user.virtualCard.status === 'blocked') {
      return res.status(400).json({ message: `Virtual card cannot be toggled from ${user.virtualCard.status} state` });
    }

    user.virtualCard.status = user.virtualCard.status === 'frozen' ? 'active' : 'frozen';
    await user.save();

    res.json({
      message: `Virtual card ${user.virtualCard.status === 'frozen' ? 'frozen' : 'unfrozen'}`,
      virtualCard: user.virtualCard
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
