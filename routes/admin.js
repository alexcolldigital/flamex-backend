const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const { adminMiddleware } = require('../middleware/admin');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Referral = require('../models/Referral');
const PlatformLedger = require('../models/PlatformLedger');
const AuditLog = require('../models/AuditLog');
const P2POrder = require('../models/P2POrder');
const P2PDispute = require('../models/P2PDispute');
const GiftCardTrade = require('../models/GiftCardTrade');
const Notification = require('../models/Notification');
const flutterwaveService = require('../services/flutterwave');
const { getPlatformSettings, savePlatformSettings } = require('../utils/admin');
const { getTreasuryBalances, getTreasurySummary, createLedgerEntry } = require('../services/platformLedger');
const { logAuditEvent } = require('../services/audit');
const { getGiftCardConfig, saveGiftCardConfig } = require('../utils/giftcards');
const { createNotification } = require('../services/notifications');

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

function mapKycSubmission(user) {
  return {
    _id: user._id,
    userId: user._id,
    user: mapUser(user),
    status: user.kycVerified ? 'approved' : user.kycLevel > 0 ? 'pending' : 'rejected',
    tier: user.kycLevel || 0,
    bvn: user.bvn,
    nin: user.nin,
    submittedAt: user.updatedAt || user.createdAt,
    reviewedAt: user.kycVerified ? user.updatedAt : null,
    rejectionReason: user.kycVerified ? null : user.kycLevel > 0 ? null : 'KYC not yet verified'
  };
}

function mapVirtualCard(user) {
  if (!user.virtualCard?.id) return null;
  return {
    _id: user.virtualCard.id,
    userId: user._id,
    user: mapUser(user),
    cardNumber: user.virtualCard.cardNumber,
    last4: user.virtualCard.cardNumber ? user.virtualCard.cardNumber.slice(-4) : null,
    expiryMonth: user.virtualCard.expiryMonth,
    expiryYear: user.virtualCard.expiryYear,
    cardholderName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
    status: user.virtualCard.status || 'inactive',
    type: 'visa',
    balance: Number(user.virtualCard.balance || 0),
    currency: 'USD',
    color: user.virtualCard.color || 'purple',
    createdAt: user.updatedAt || user.createdAt
  };
}

function mapBillPayment(transaction) {
  const metadata = transaction.metadata?.toObject ? transaction.metadata.toObject() : transaction.metadata || {};
  return {
    _id: transaction._id,
    userId: transaction.userId,
    type: transaction.type,
    provider: metadata.provider || metadata.billProvider || '-',
    customerId: metadata.customerId || metadata.phoneNumber || metadata.smartCardNumber || metadata.meterNumber || '-',
    amount: transaction.amount,
    currency: transaction.currency,
    status: transaction.status,
    transactionRef: transaction.reference,
    description: transaction.description,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt
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

router.put('/users/:id', [
  param('id').isMongoId(),
  body('firstName').optional().isString().trim().isLength({ min: 1, max: 80 }),
  body('lastName').optional().isString().trim().isLength({ min: 1, max: 80 }),
  body('email').optional().isEmail().normalizeEmail(),
  body('phone').optional().isString().trim().isLength({ min: 7, max: 30 }),
  body('emailVerified').optional().isBoolean().toBoolean()
], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;

    const allowedFields = ['firstName', 'lastName', 'email', 'phone', 'emailVerified'];
    const updates = Object.fromEntries(
      allowedFields.filter((field) => req.body[field] !== undefined).map((field) => [field, req.body[field]])
    );
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'At least one editable field is required' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    Object.assign(user, updates);
    await user.save();
    await logAuditEvent(req, {
      action: 'admin_update_user',
      entityType: 'user',
      entityId: user._id,
      metadata: { fields: Object.keys(updates) }
    });
    res.json({ message: 'User updated', user: mapUser(user) });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: 'Email, phone, or username is already in use' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/users/:id', [param('id').isMongoId()], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.status = 'banned';
    await user.save();
    await logAuditEvent(req, {
      action: 'admin_deactivate_user',
      entityType: 'user',
      entityId: user._id,
      severity: 'warning',
      metadata: { reason: req.body?.reason || 'Deactivated by admin' }
    });
    res.json({ message: 'User deactivated', user: mapUser(user) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/users/:id/transactions', [param('id').isMongoId()], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const transactions = await Transaction.find({ userId: req.params.id }).sort({ createdAt: -1 }).limit(200);
    res.json({ transactions });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/users/:id/notifications', [param('id').isMongoId()], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const notifications = await Notification.find({ userId: req.params.id }).sort({ createdAt: -1 }).limit(100);
    res.json({ notifications });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post(
  '/users/:id/notify',
  [param('id').isMongoId(), body('title').isLength({ min: 3 }), body('body').isLength({ min: 3 })],
  async (req, res) => {
    try {
      if (!sendValidation(req, res)) return;
      const user = await User.findById(req.params.id);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const notification = await createNotification({
        user,
        type: req.body.type || 'system',
        title: req.body.title,
        body: req.body.body,
        data: req.body.data || {},
        sendEmail: Boolean(req.body.sendEmail)
      });

      await logAuditEvent(req, {
        action: 'admin_send_user_notification',
        entityType: 'notification',
        entityId: notification?._id,
        severity: 'warning',
        metadata: { userId: user._id, title: req.body.title }
      });

      res.status(201).json({ message: 'Notification sent', notification });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

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

router.get('/kyc', async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const query = { kycLevel: { $gt: 0 } };

    if (status === 'pending') {
      query.kycVerified = false;
    } else if (status === 'approved') {
      query.kycVerified = true;
    } else if (status === 'rejected') {
      query.kycLevel = 0;
      query.kycVerified = false;
    }

    const users = await User.find(query).sort({ updatedAt: -1 }).limit(200);
    res.json({ submissions: users.map(mapKycSubmission) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/kyc/stats', async (req, res) => {
  try {
    const [pending, approved, total] = await Promise.all([
      User.countDocuments({ kycVerified: false, kycLevel: { $gt: 0 } }),
      User.countDocuments({ kycVerified: true }),
      User.countDocuments({ $or: [{ kycVerified: true }, { kycLevel: { $gt: 0 } }] })
    ]);
    res.json({ pending, approved, rejected: Math.max(total - pending - approved, 0), total });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/kyc/:id', [param('id').isMongoId()], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'KYC submission not found' });
    }
    res.json({ submission: mapKycSubmission(user) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/kyc/:id/approve', [param('id').isMongoId(), body('tier').isInt({ min: 1, max: 3 })], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.kycVerified = true;
    user.kycLevel = Number(req.body.tier);
    await user.save();

    await createNotification({
      user,
      type: 'security',
      title: 'KYC approved',
      body: `Your KYC has been approved for Tier ${req.body.tier}.`,
      sendEmail: true
    });

    await logAuditEvent(req, {
      action: 'admin_approve_kyc',
      entityType: 'user',
      entityId: user._id,
      severity: 'warning',
      metadata: { tier: req.body.tier }
    });

    res.json({ message: 'KYC approved', submission: mapKycSubmission(user) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/kyc/:id/reject', [param('id').isMongoId(), body('reason').isLength({ min: 3 })], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.kycVerified = false;
    user.kycLevel = 0;
    await user.save();

    await createNotification({
      user,
      type: 'security',
      title: 'KYC rejected',
      body: `Your KYC review was rejected. Reason: ${req.body.reason}`,
      sendEmail: true
    });

    await logAuditEvent(req, {
      action: 'admin_reject_kyc',
      entityType: 'user',
      entityId: user._id,
      severity: 'warning',
      metadata: { reason: req.body.reason }
    });

    res.json({
      message: 'KYC rejected',
      submission: { ...mapKycSubmission(user), status: 'rejected', rejectionReason: req.body.reason }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/bill-payments', async (req, res) => {
  try {
    const type = String(req.query.type || '').trim();
    const filter = {
      type: { $in: ['airtime', 'data', 'electricity', 'cable', 'betting', 'giftcard', 'bill_payment'] }
    };
    if (type) {
      filter.type = type;
    }
    const transactions = await Transaction.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json({ billPayments: transactions.map(mapBillPayment) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/bill-payments/stats', async (req, res) => {
  try {
    const transactions = await Transaction.find({
      type: { $in: ['airtime', 'data', 'electricity', 'cable', 'betting', 'giftcard', 'bill_payment'] }
    }).limit(500);
    const totalVolume = transactions
      .filter((item) => item.status === 'completed')
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    res.json({
      total: transactions.length,
      completed: transactions.filter((item) => item.status === 'completed').length,
      failed: transactions.filter((item) => item.status === 'failed').length,
      pending: transactions.filter((item) => item.status === 'pending').length,
      totalVolume
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/virtual-cards', async (req, res) => {
  try {
    const users = await User.find({ 'virtualCard.id': { $ne: null } }).sort({ updatedAt: -1 }).limit(200);
    res.json({ cards: users.map(mapVirtualCard).filter(Boolean) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/virtual-cards/:id/status', [param('id').isString(), body('status').isIn(['active', 'frozen', 'blocked', 'cancelled'])], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const user = await User.findOne({ 'virtualCard.id': req.params.id });
    if (!user) {
      return res.status(404).json({ message: 'Virtual card not found' });
    }

    user.virtualCard.status = req.body.status;
    await user.save();

    await logAuditEvent(req, {
      action: 'admin_update_virtual_card_status',
      entityType: 'virtual_card',
      entityId: req.params.id,
      severity: 'warning',
      metadata: { status: req.body.status }
    });

    res.json({ message: 'Virtual card updated', card: mapVirtualCard(user) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/p2p/disputes', async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const query = {};
    if (status) query.status = status;
    const disputes = await P2PDispute.find(query).sort({ createdAt: -1 }).limit(100);
    res.json({ disputes });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/p2p/disputes/:id/resolve', [
  param('id').isMongoId(),
  body('outcome').isIn(['release_to_buyer', 'refund_to_seller', 'dismissed']),
  body('note').optional().isString()
], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const dispute = await P2PDispute.findById(req.params.id);
    if (!dispute) {
      return res.status(404).json({ message: 'Dispute not found' });
    }

    dispute.status = req.body.outcome === 'dismissed' ? 'dismissed' : 'resolved';
    dispute.resolution = {
      outcome: req.body.outcome,
      note: req.body.note || null,
      resolvedByUserId: req.userId,
      resolvedAt: new Date()
    };
    await dispute.save();

    await logAuditEvent(req, {
      action: 'admin_resolve_p2p_dispute',
      entityType: 'p2p_dispute',
      entityId: dispute._id,
      severity: 'critical',
      metadata: { outcome: req.body.outcome, note: req.body.note || null }
    });

    res.json({ message: 'Dispute updated', dispute });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    const notifications = await Notification.find().sort({ createdAt: -1 }).limit(200);
    res.json({ notifications });
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

router.get('/referrals', async (req, res) => {
  try {
    const referrals = await Referral.find()
      .sort({ totalReferrals: -1, totalRewards: -1 })
      .limit(200)
      .populate('userId', 'firstName lastName email username')
      .populate('referredUsers.userId', 'firstName lastName email username');

    const records = referrals.flatMap((referral) =>
      (referral.referredUsers || []).map((entry) => ({
        _id: `${referral._id}-${entry.userId?._id || entry._id || entry.joinedAt?.getTime?.() || Math.random()}`,
        referrerId: referral.userId?._id || referral.userId,
        referrer: referral.userId
          ? {
              _id: referral.userId._id,
              fullName: `${referral.userId.firstName || ''} ${referral.userId.lastName || ''}`.trim(),
              email: referral.userId.email,
              username: referral.userId.username
            }
          : null,
        referredId: entry.userId?._id || entry.userId,
        referred: entry.userId
          ? {
              _id: entry.userId._id,
              fullName: `${entry.userId.firstName || ''} ${entry.userId.lastName || ''}`.trim(),
              email: entry.userId.email,
              username: entry.userId.username
            }
          : null,
        commission: Number(entry.rewardsEarned || 0),
        status: entry.rewardsEarned > 0 ? 'paid' : 'pending',
        createdAt: entry.joinedAt
      }))
    );

    res.json({ referrals: records });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/referrals/stats', async (req, res) => {
  try {
    const referrals = await Referral.find().limit(500);
    const stats = referrals.reduce(
      (acc, referral) => {
        acc.totalReferrals += Number(referral.totalReferrals || 0);
        acc.totalCommission += Number(referral.totalRewards || 0);
        acc.pendingCommission += Number(referral.pendingRewards || 0);
        acc.paidCommission += Number(referral.claimedRewards || 0);
        return acc;
      },
      { totalReferrals: 0, totalCommission: 0, pendingCommission: 0, paidCommission: 0 }
    );

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/referrals/commission-rate', [body('rate').isFloat({ min: 0, max: 100 })], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const settings = await savePlatformSettings({ referralCommissionRate: Number(req.body.rate) }, req.userId);
    await logAuditEvent(req, {
      action: 'admin_update_referral_commission_rate',
      entityType: 'platform_setting',
      entityId: 'referralCommissionRate',
      severity: 'warning',
      metadata: { rate: Number(req.body.rate) }
    });
    res.json({ message: 'Referral commission rate updated', rate: settings.referralCommissionRate });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
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

        if (flutterwaveService.isConfigured) {
          providerResponse = await flutterwaveService.initiateTransfer({
            amount,
            accountNumber: destination.accountNumber,
            bankCode: destination.bankCode,
            accountName: destination.accountName,
            narration: req.body.note || 'FlameX treasury withdrawal',
            reference,
            currency: 'NGN'
          });
        } else {
          throw new Error('Bank transfer service not configured');
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

router.get('/giftcard-rates', async (req, res) => {
  try {
    const config = await getGiftCardConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/giftcard-rates', async (req, res) => {
  try {
    const config = await saveGiftCardConfig(req.body || {}, req.userId);
    await logAuditEvent(req, {
      action: 'admin_update_giftcard_rates',
      entityType: 'giftcard_rate',
      entityId: 'giftcard_trade_config',
      severity: 'warning',
      metadata: req.body || {}
    });
    res.json({ message: 'Gift card rates updated', config });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/giftcard-trades', async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const query = {};
    if (status) query.status = status;
    const trades = await GiftCardTrade.find(query).sort({ createdAt: -1 }).limit(200);
    res.json({ trades });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/giftcard-trades/:id/request-info', [param('id').isMongoId(), body('note').isLength({ min: 3 })], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const trade = await GiftCardTrade.findById(req.params.id);
    if (!trade) {
      return res.status(404).json({ message: 'Gift card trade not found' });
    }
    trade.status = 'more_info_required';
    trade.reviewNote = req.body.note;
    trade.reviewedByUserId = req.userId;
    trade.reviewedAt = new Date();
    await trade.save();

    const user = await User.findById(trade.userId);
    if (user) {
      await createNotification({
        user,
        type: 'system',
        title: 'More information needed',
        body: `Your gift card trade ${trade.reference} needs more information from you.`,
        data: { giftCardTradeId: trade._id, reference: trade.reference },
        sendEmail: true
      });
    }

    await logAuditEvent(req, {
      action: 'admin_request_giftcard_info',
      entityType: 'giftcard_trade',
      entityId: trade._id,
      severity: 'warning',
      metadata: { note: req.body.note }
    });
    res.json({ message: 'Gift card trade marked for more info', trade });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/giftcard-trades/:id/approve', [param('id').isMongoId(), body('finalPayout').optional().isFloat({ min: 0 }), body('note').optional().isString()], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const trade = await GiftCardTrade.findById(req.params.id);
    if (!trade) {
      return res.status(404).json({ message: 'Gift card trade not found' });
    }
    if (!['pending_review', 'more_info_required'].includes(trade.status)) {
      return res.status(400).json({ message: 'This trade has already been processed' });
    }

    const user = await User.findById(trade.userId);
    if (!user) {
      return res.status(404).json({ message: 'Trade owner not found' });
    }

    const finalPayout = Number(req.body.finalPayout ?? trade.estimatedPayout);
    user.balances.NGN = Number(user.balances.NGN || 0) + finalPayout;

    const transaction = await Transaction.create({
      userId: user._id,
      type: 'giftcard',
      amount: finalPayout,
      currency: 'NGN',
      description: `Gift card trade approved for ${trade.brand} ${trade.currency} ${trade.cardValue}`,
      status: 'completed',
      reference: `${trade.reference}-CR`,
      metadata: {
        giftCardTradeId: trade._id,
        billType: 'giftcard_trade'
      }
    });

    trade.status = 'completed';
    trade.finalPayout = finalPayout;
    trade.reviewNote = req.body.note || null;
    trade.reviewedByUserId = req.userId;
    trade.reviewedAt = new Date();
    trade.creditedTransactionId = transaction._id;

    await Promise.all([
      user.save(),
      trade.save(),
      createNotification({
        user,
        type: 'receive',
        title: 'Gift card trade approved',
        body: `Your wallet has been credited with NGN ${finalPayout.toLocaleString()} for trade ${trade.reference}.`,
        data: { giftCardTradeId: trade._id, reference: trade.reference, amount: finalPayout },
        sendEmail: true,
        emailAmount: finalPayout,
        emailCurrency: 'NGN',
        emailReference: trade.reference
      })
    ]);

    await logAuditEvent(req, {
      action: 'admin_approve_giftcard_trade',
      entityType: 'giftcard_trade',
      entityId: trade._id,
      severity: 'warning',
      metadata: { finalPayout, note: req.body.note || null }
    });
    res.json({ message: 'Gift card trade approved', trade, transaction });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/giftcard-trades/:id/reject', [param('id').isMongoId(), body('reason').isLength({ min: 3 })], async (req, res) => {
  try {
    if (!sendValidation(req, res)) return;
    const trade = await GiftCardTrade.findById(req.params.id);
    if (!trade) {
      return res.status(404).json({ message: 'Gift card trade not found' });
    }
    if (!['pending_review', 'more_info_required'].includes(trade.status)) {
      return res.status(400).json({ message: 'This trade has already been processed' });
    }

    trade.status = 'rejected';
    trade.rejectionReason = req.body.reason;
    trade.reviewedByUserId = req.userId;
    trade.reviewedAt = new Date();
    await trade.save();

    const user = await User.findById(trade.userId);
    if (user) {
      await createNotification({
        user,
        type: 'system',
        title: 'Gift card trade rejected',
        body: `Your gift card trade ${trade.reference} was rejected. Reason: ${req.body.reason}`,
        data: { giftCardTradeId: trade._id, reference: trade.reference },
        sendEmail: true
      });
    }

    await logAuditEvent(req, {
      action: 'admin_reject_giftcard_trade',
      entityType: 'giftcard_trade',
      entityId: trade._id,
      severity: 'warning',
      metadata: { reason: req.body.reason }
    });
    res.json({ message: 'Gift card trade rejected', trade });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
