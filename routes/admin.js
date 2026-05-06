const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const { adminMiddleware } = require('../middleware/admin');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const PlatformLedger = require('../models/PlatformLedger');
const AuditLog = require('../models/AuditLog');
const P2POrder = require('../models/P2POrder');
const monnifyService = require('../services/monnify');
const flutterwaveService = require('../services/flutterwave');
const { getPlatformSettings, savePlatformSettings } = require('../utils/admin');
const { getTreasuryBalances, getTreasurySummary, createLedgerEntry } = require('../services/platformLedger');
const { logAuditEvent } = require('../services/audit');

const router = express.Router();

router.use(authMiddleware, adminMiddleware);

function sendValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return false;
  }
  return true;
}

function mapUser(user) {
  const balances = user.balances?.toObject ? user.balances.toObject() : user.balances;
  const totalBalance = Object.values(balances || {}).reduce((sum, value) => sum + Number(value || 0), 0);

  return {
    _id: user._id,
    email: user.email,
    fullName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
    phoneNumber: user.phone,
    isActive: user.status === 'active',
    isSuspended: user.status === 'suspended',
    kycStatus: user.kycVerified ? 'approved' : user.kycLevel > 0 ? 'pending' : 'none',
    kycTier: user.kycLevel || 0,
    createdAt: user.createdAt,
    lastLogin: user.lastLoginAt,
    totalBalance,
    balances,
    status: user.status,
    username: user.username,
    emailVerified: user.emailVerified
  };
}

router.get('/users', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;

    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 20);
    const search = String(req.query.search || '').trim();
    const filter = String(req.query.filter || 'all').trim();

    const mongoFilter = {};
    if (search) {
      mongoFilter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } }
      ];
    }
    if (filter === 'active') mongoFilter.status = 'active';
    if (filter === 'suspended') mongoFilter.status = 'suspended';
    if (filter === 'pending_kyc') mongoFilter.kycVerified = false;

    const [users, total] = await Promise.all([
      User.find(mongoFilter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      User.countDocuments(mongoFilter)
    ]);

    res.json({
      users: users.map(mapUser),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/users/stats', async (req, res) => {
  try {
    const [totalUsers, activeUsers, suspendedUsers, pendingKyc] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ status: 'active' }),
      User.countDocuments({ status: 'suspended' }),
      User.countDocuments({ kycVerified: false, kycLevel: { $gt: 0 } })
    ]);

    res.json({ totalUsers, activeUsers, suspendedUsers, pendingKyc });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/users/:id', [param('id').isMongoId()], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({ user: mapUser(user) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/users/:id/suspend', [param('id').isMongoId(), body('reason').optional().isString()], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const user = await User.findByIdAndUpdate(req.params.id, { status: 'suspended' }, { new: true });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    await logAuditEvent(req, {
      action: 'admin_suspend_user',
      entityType: 'user',
      entityId: user._id,
      severity: 'warning',
      metadata: { reason: req.body.reason || null }
    });
    res.json({ message: 'User suspended', user: mapUser(user) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/users/:id/activate', [param('id').isMongoId()], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const user = await User.findByIdAndUpdate(req.params.id, { status: 'active' }, { new: true });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    await logAuditEvent(req, {
      action: 'admin_activate_user',
      entityType: 'user',
      entityId: user._id
    });
    res.json({ message: 'User activated', user: mapUser(user) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/transactions', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 20);
    const type = String(req.query.type || '').trim();
    const status = String(req.query.status || '').trim();

    const filter = {};
    if (type) filter.type = type;
    if (status) filter.status = status;

    const [transactions, total] = await Promise.all([
      Transaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Transaction.countDocuments(filter)
    ]);

    res.json({
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/transactions/stats', async (req, res) => {
  try {
    const [totalTransactions, pendingTransactions] = await Promise.all([
      Transaction.countDocuments(),
      Transaction.countDocuments({ status: 'pending' })
    ]);
    const volumeRows = await Transaction.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: '$currency', total: { $sum: '$amount' }, fees: { $sum: '$fee' } } }
    ]);

    res.json({ totalTransactions, pendingTransactions, breakdown: volumeRows });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/transactions/pending', async (req, res) => {
  try {
    const transactions = await Transaction.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(100);
    res.json({ transactions });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/transactions/:id', [param('id').isMongoId()], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }
    res.json({ transaction });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/transactions/:id', [param('id').isMongoId(), body('status').isIn(['pending', 'processing', 'completed', 'failed', 'cancelled'])], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }
    transaction.status = req.body.status;
    transaction.metadata = {
      ...(transaction.metadata?.toObject ? transaction.metadata.toObject() : transaction.metadata || {}),
      adminNote: req.body.note || null
    };
    if (req.body.status === 'completed') {
      transaction.completedAt = new Date();
    }
    await transaction.save();
    await logAuditEvent(req, {
      action: 'admin_update_transaction',
      entityType: 'transaction',
      entityId: transaction._id,
      severity: req.body.status === 'failed' ? 'warning' : 'info',
      metadata: { status: req.body.status, note: req.body.note || null }
    });
    res.json({ message: 'Transaction updated', transaction });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/dashboard/overview', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalUsers, activeUsers, newUsersToday, totalTransactions, pendingKYC, pendingTransactions, balances] =
      await Promise.all([
        User.countDocuments(),
        User.countDocuments({ status: 'active' }),
        User.countDocuments({ createdAt: { $gte: today } }),
        Transaction.countDocuments(),
        User.countDocuments({ kycVerified: false, kycLevel: { $gt: 0 } }),
        Transaction.countDocuments({ status: 'pending' }),
        getTreasuryBalances()
      ]);

    const p2pOrders = await P2POrder.find({ status: 'completed' }).sort({ createdAt: -1 }).limit(50);
    const transactionVolume24h = p2pOrders.reduce((sum, order) => sum + Number(order.fiatAmount || 0), 0);
    const totalRevenue = Object.values(balances).reduce((sum, value) => sum + Number(value || 0), 0);

    res.json({
      totalUsers,
      activeUsers,
      newUsersToday,
      totalTransactions,
      transactionVolume24h,
      pendingKYC,
      pendingTransactions,
      totalRevenue,
      treasuryBalances: balances
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/dashboard/activity', async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ createdAt: -1 }).limit(20);
    const activity = transactions.map((transaction) => ({
      _id: transaction._id,
      type: transaction.type,
      description: transaction.description,
      createdAt: transaction.createdAt,
      userId: transaction.userId
    }));
    res.json({ activity });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/dashboard/system-health', async (req, res) => {
  res.json({
    apiStatus: 'operational',
    database: 'healthy',
    treasury: 'operational',
    checkedAt: new Date().toISOString()
  });
});

router.get('/settings', async (req, res) => {
  try {
    const settings = await getPlatformSettings();
    res.json({ settings });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/settings', [body('key').isString()], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const current = await getPlatformSettings();
    const settings = await savePlatformSettings({ [req.body.key]: req.body.value }, req.userId);
    await logAuditEvent(req, {
      action: 'admin_update_setting',
      entityType: 'platform_setting',
      entityId: req.body.key,
      severity: 'warning',
      metadata: { value: req.body.value }
    });
    res.json({ message: 'Settings updated', settings: { ...current, ...settings } });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/settings/fees', async (req, res) => {
  try {
    const settings = await getPlatformSettings();
    res.json({ fees: settings.fees });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/settings/fees', async (req, res) => {
  try {
    const settings = await savePlatformSettings({ fees: req.body || {} }, req.userId);
    await logAuditEvent(req, {
      action: 'admin_update_fees',
      entityType: 'platform_fee',
      entityId: 'fees',
      severity: 'warning',
      metadata: req.body || {}
    });
    res.json({ message: 'Fee settings updated', fees: settings.fees });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/p2p/treasury', async (req, res) => {
  try {
    const [summary, recentLedger, recentOrders, settings] = await Promise.all([
      getTreasurySummary(),
      PlatformLedger.find().sort({ createdAt: -1 }).limit(50),
      P2POrder.find({ status: 'completed' }).sort({ releasedAt: -1, createdAt: -1 }).limit(50),
      getPlatformSettings()
    ]);

    const totals = recentOrders.reduce(
      (acc, order) => {
        acc.cryptoFees += Number(order.cryptoFeeAmount || 0);
        acc.fiatFees += Number(order.fiatFeeAmount || 0);
        return acc;
      },
      { cryptoFees: 0, fiatFees: 0 }
    );

    res.json({
      balances: summary.settledBalances,
      pendingDebits: summary.pendingDebits,
      pendingCredits: summary.pendingCredits,
      settings: {
        p2pCryptoFeeRate: settings.fees.p2pCryptoFeeRate,
        p2pNgnFeeRate: settings.fees.p2pNgnFeeRate
      },
      totals,
      recentLedger,
      recentOrders
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post(
  '/p2p/treasury/withdraw',
  [
    body('asset').notEmpty(),
    body('amount').isFloat({ min: 0.000001 }),
    body('destinationType').isIn(['bank_account', 'external_wallet']),
    body('destination').isObject()
  ],
  async (req, res) => {
    try {
      if (!sendValidation(req, res)) return;
      const asset = String(req.body.asset).toUpperCase();
      const amount = Number(req.body.amount);
      const treasurySummary = await getTreasurySummary();
      if (Number(treasurySummary.settledBalances[asset] || 0) < amount) {
        return res.status(400).json({ message: `Insufficient ${asset} treasury balance` });
      }

      const reference = `TRSY-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      let status = 'pending';
      let providerResponse = null;

      if (asset === 'NGN' && req.body.destinationType === 'bank_account') {
        const destination = req.body.destination || {};
        if (!destination.accountNumber || !destination.bankCode || !destination.accountName) {
          return res.status(400).json({ message: 'NGN treasury withdrawals require accountNumber, bankCode, and accountName' });
        }

        if (monnifyService.isConfigured) {
          providerResponse = await monnifyService.initiateTransfer({
            amount,
            accountNumber: destination.accountNumber,
            bankCode: destination.bankCode,
            accountName: destination.accountName,
            narration: req.body.note || 'FlameX treasury withdrawal',
            reference
          });
        } else if (flutterwaveService.isConfigured) {
          providerResponse = await flutterwaveService.initiateTransfer({
            amount,
            accountNumber: destination.accountNumber,
            bankCode: destination.bankCode,
            accountName: destination.accountName,
            narration: req.body.note || 'FlameX treasury withdrawal',
            reference,
            currency: 'NGN'
          });
        }

        if (providerResponse?.success === false) {
          return res.status(400).json({ message: providerResponse.error || 'Unable to initiate NGN treasury withdrawal' });
        }
      }

      const withdrawal = await createLedgerEntry({
        category: 'treasury_withdrawal',
        direction: 'debit',
        asset,
        amount,
        status,
        reference,
        destinationType: req.body.destinationType,
        destination: req.body.destination,
        createdByUserId: req.userId,
        metadata: { note: req.body.note || null, providerResponse }
      });

      await logAuditEvent(req, {
        action: 'admin_create_treasury_withdrawal',
        entityType: 'platform_ledger',
        entityId: withdrawal._id,
        severity: 'warning',
        metadata: {
          asset,
          amount,
          destinationType: req.body.destinationType,
          providerInitiated: Boolean(providerResponse?.success)
        }
      });

      res.status(201).json({ message: 'Treasury withdrawal created', withdrawal });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.put(
  '/p2p/treasury/withdraw/:id',
  [param('id').isMongoId(), body('status').isIn(['completed', 'failed', 'pending'])],
  async (req, res) => {
    try {
      if (!sendValidation(req, res)) return;
      const entry = await PlatformLedger.findById(req.params.id);
      if (!entry || entry.category !== 'treasury_withdrawal') {
        return res.status(404).json({ message: 'Treasury withdrawal not found' });
      }

      entry.status = req.body.status;
      entry.metadata = {
        ...(entry.metadata?.toObject ? entry.metadata.toObject() : entry.metadata || {}),
        reconciliationNote: req.body.note || null,
        reconciledAt: new Date().toISOString()
      };
      await entry.save();

      await logAuditEvent(req, {
        action: 'admin_reconcile_treasury_withdrawal',
        entityType: 'platform_ledger',
        entityId: entry._id,
        severity: req.body.status === 'failed' ? 'warning' : 'info',
        metadata: { status: req.body.status, note: req.body.note || null }
      });

      res.json({ message: 'Treasury withdrawal updated', withdrawal: entry });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.get('/audit-logs', async (req, res) => {
  try {
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(200);
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
