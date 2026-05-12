const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { decrypt } = require('../utils/encryption');

const CHAIN_METADATA = [
  { id: 'solana', name: 'Solana', symbol: 'SOL', color: '#9945FF', explorerBaseUrl: 'https://solscan.io/account/' },
  { id: 'ethereum', name: 'Ethereum', symbol: 'ETH', color: '#627EEA', explorerBaseUrl: 'https://etherscan.io/address/' },
  { id: 'bsc', name: 'BSC', symbol: 'BNB', color: '#F3BA2F', explorerBaseUrl: 'https://bscscan.com/address/' },
  { id: 'polygon', name: 'Polygon', symbol: 'MATIC', color: '#8247E5', explorerBaseUrl: 'https://polygonscan.com/address/' },
  { id: 'base', name: 'Base', symbol: 'ETH', color: '#0052FF', explorerBaseUrl: 'https://basescan.org/address/' },
  { id: 'arbitrum', name: 'Arbitrum', symbol: 'ETH', color: '#28A0F0', explorerBaseUrl: 'https://arbiscan.io/address/' }
];

const createUserSecret = (password) => {
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY must be set before exporting wallet keys');
  }
  return `${password}:${process.env.ENCRYPTION_KEY}`;
};

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
    fiatAccounts: {
      NGN: {
        bankName: 'Wema Bank',
        accountNumber: '1234567890',
        accountName: `${user.firstName} ${user.lastName}`
      },
      USD: {
        provider: 'FlameX USD Balance',
        accountId: `USD-${String(user._id).slice(-8).toUpperCase()}`
      }
    },
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
    const user = await User.findById(req.userId);
    res.json(buildWalletSummary(user));
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    res.json(buildWalletSummary(user));
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get balances
router.get('/balances', authMiddleware, async (req, res) => {
  try {
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
    const userSecret = createUserSecret(password);

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
    res.json({ virtualCard: user.virtualCard });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/virtual-card', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const { color = 'purple' } = req.body;
    if (user.virtualCard?.cardNumber) {
      return res.status(400).json({ message: 'Virtual card already exists' });
    }

    user.virtualCard = {
      id: `CARD-${Date.now()}`,
      color,
      cardNumber: `5399 ${Math.floor(1000 + Math.random() * 9000)} ${Math.floor(1000 + Math.random() * 9000)} ${Math.floor(1000 + Math.random() * 9000)}`,
      expiryMonth: '12',
      expiryYear: String(new Date().getFullYear() + 3),
      cvv: String(Math.floor(100 + Math.random() * 900)),
      status: 'active',
      balance: 0
    };
    await user.save();

    res.json({ message: 'Virtual card created', virtualCard: user.virtualCard });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/virtual-card/fund', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
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

    user.balances.NGN -= amount;
    user.virtualCard.balance += amount;
    await user.save();

    const transaction = new Transaction({
      userId: user._id,
      type: 'virtual_card',
      amount,
      currency: 'NGN',
      description: 'Funded virtual card',
      status: 'completed',
      reference: `CARD-FUND-${Date.now()}`
    });
    await transaction.save();

    res.json({
      message: 'Virtual card funded',
      virtualCard: user.virtualCard,
      balances: user.balances
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/virtual-card/freeze', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user.virtualCard?.cardNumber) {
      return res.status(400).json({ message: 'Virtual card not found' });
    }

    user.virtualCard.status =
      user.virtualCard.status === 'frozen' ? 'active' : 'frozen';
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
