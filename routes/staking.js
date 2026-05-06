const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Stake = require('../models/Stake');
const Transaction = require('../models/Transaction');

const STAKING_CONFIG = {
  SOL: {
    flexible: { apy: 5, lockPeriod: 0 },
    '30days': { apy: 8, lockPeriod: 30 },
    '90days': { apy: 12, lockPeriod: 90 },
    '180days': { apy: 15, lockPeriod: 180 },
    '365days': { apy: 20, lockPeriod: 365 }
  },
  FLAME: {
    flexible: { apy: 10, lockPeriod: 0 },
    '30days': { apy: 15, lockPeriod: 30 },
    '90days': { apy: 20, lockPeriod: 90 },
    '180days': { apy: 25, lockPeriod: 180 },
    '365days': { apy: 35, lockPeriod: 365 }
  }
};

// Get staking config
router.get('/config', authMiddleware, (req, res) => {
  res.json({
    tokens: {
      SOL: {
        name: 'Solana',
        symbol: 'SOL',
        options: Object.entries(STAKING_CONFIG.SOL).map(([key, config]) => ({
          id: key,
          name: key === 'flexible' ? 'Flexible' : `${config.lockPeriod} Days`,
          apy: config.apy,
          lockPeriod: config.lockPeriod,
          minAmount: 0.1
        }))
      },
      FLAME: {
        name: 'Flame Token',
        symbol: 'FLAME',
        options: Object.entries(STAKING_CONFIG.FLAME).map(([key, config]) => ({
          id: key,
          name: key === 'flexible' ? 'Flexible' : `${config.lockPeriod} Days`,
          apy: config.apy,
          lockPeriod: config.lockPeriod,
          minAmount: 100
        }))
      }
    }
  });
});

// Stake tokens
router.post('/stake', authMiddleware, [
  body('token').isIn(['SOL', 'FLAME']),
  body('amount').isFloat({ min: 0.000001 }),
  body('lockPeriod').isIn(['flexible', '30days', '90days', '180days', '365days']),
  body('pin').isLength({ min: 4, max: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { token, amount, lockPeriod, pin } = req.body;
    const user = await User.findById(req.userId);

    const pinMatch = await user.comparePin(pin);
    if (!pinMatch) {
      return res.status(400).json({ message: 'Invalid PIN' });
    }

    const balance = user.balances[token] || 0;
    if (balance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    const config = STAKING_CONFIG[token][lockPeriod];
    const minAmount = token === 'SOL' ? 0.1 : 100;
    if (amount < minAmount) {
      return res.status(400).json({ message: `Minimum stake is ${minAmount} ${token}` });
    }

    let endDate = null;
    if (config.lockPeriod > 0) {
      endDate = new Date();
      endDate.setDate(endDate.getDate() + config.lockPeriod);
    }

    const stake = new Stake({
      userId: req.userId,
      token,
      amount,
      apy: config.apy,
      lockPeriod: config.lockPeriod,
      endDate
    });
    await stake.save();

    user.balances[token] -= amount;
    await user.save();

    const transaction = new Transaction({
      userId: req.userId,
      type: 'stake',
      amount,
      currency: token,
      description: `Staked ${amount} ${token} at ${config.apy}% APY`,
      status: 'completed',
      reference: `STAKE-${Date.now()}`
    });
    await transaction.save();

    res.json({
      message: 'Staking successful',
      stake: {
        id: stake._id,
        token,
        amount,
        apy: config.apy,
        lockPeriod: config.lockPeriod,
        endDate
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get staking positions
router.get('/positions', authMiddleware, async (req, res) => {
  try {
    const stakes = await Stake.find({ userId: req.userId, status: 'active' })
      .sort({ createdAt: -1 });

    const updatedStakes = stakes.map(stake => {
      const currentRewards = stake.calculateRewards();
      return {
        id: stake._id,
        token: stake.token,
        amount: stake.amount,
        apy: stake.apy,
        lockPeriod: stake.lockPeriod,
        startDate: stake.startDate,
        endDate: stake.endDate,
        rewards: stake.rewards + currentRewards,
        totalClaimed: stake.totalClaimed,
        canUnstake: stake.lockPeriod === 0 || (stake.endDate && new Date() >= stake.endDate)
      };
    });

    res.json({ stakes: updatedStakes });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const stakes = await Stake.find({ userId: req.userId, status: 'active' });

    const summary = stakes.reduce((acc, stake) => {
      const rewards = stake.rewards + stake.calculateRewards();
      if (!acc[stake.token]) {
        acc[stake.token] = { staked: 0, rewards: 0 };
      }

      acc[stake.token].staked += stake.amount;
      acc[stake.token].rewards += rewards;
      return acc;
    }, { SOL: { staked: 0, rewards: 0 }, FLAME: { staked: 0, rewards: 0 } });

    res.json(summary);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
