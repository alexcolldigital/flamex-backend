const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const Referral = require('../models/Referral');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// Get referral data
router.get('/', authMiddleware, async (req, res) => {
  try {
    const referral = await Referral.findOne({ userId: req.userId })
      .populate('referredUsers.userId', 'firstName lastName username createdAt');

    if (!referral) {
      return res.status(404).json({ message: 'Referral record not found' });
    }

    const tierProgress = {
      bronze: { min: 0, max: 5 },
      silver: { min: 5, max: 20 },
      gold: { min: 20, max: 50 },
      platinum: { min: 50, max: 100 },
      diamond: { min: 100, max: null }
    };

    const currentTier = tierProgress[referral.tier];
    const nextTier = referral.tier === 'bronze' ? 'silver' :
                     referral.tier === 'silver' ? 'gold' :
                     referral.tier === 'gold' ? 'platinum' :
                     referral.tier === 'platinum' ? 'diamond' : null;

    res.json({
      code: referral.code,
      link: referral.link,
      totalReferrals: referral.totalReferrals,
      activeReferrals: referral.activeReferrals,
      totalRewards: referral.totalRewards,
      pendingRewards: referral.pendingRewards,
      claimedRewards: referral.claimedRewards,
      tier: referral.tier,
      referralCode: referral.code,
      referralLink: referral.link,
      stats: {
        totalReferrals: referral.totalReferrals,
        activeReferrals: referral.activeReferrals,
        totalRewards: referral.totalRewards,
        pendingRewards: referral.pendingRewards,
        claimedRewards: referral.claimedRewards
      },
      tierDetails: {
        current: referral.tier,
        rewardPercentage: referral.rewardPercentage,
        next: nextTier,
        progress: {
          current: referral.totalReferrals,
          min: currentTier.min,
          max: currentTier.max,
          percentage: currentTier.max ? 
            Math.min(100, ((referral.totalReferrals - currentTier.min) / (currentTier.max - currentTier.min)) * 100) : 100
        }
      },
      referredUsers: referral.referredUsers.map(u => ({
        id: u.userId?._id,
        username: u.userId?.username,
        name: u.userId ? `${u.userId.firstName} ${u.userId.lastName}` : 'Unknown',
        joinedAt: u.joinedAt,
        status: u.status
      })),
      rewardHistory: referral.rewardHistory.slice(0, 50)
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Generate new link
router.post('/generate-link', authMiddleware, async (req, res) => {
  try {
    let referral = await Referral.findOne({ userId: req.userId });

    if (!referral) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let code = '';
      for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
      
      referral = new Referral({
        userId: req.userId,
        code,
        link: `${process.env.FRONTEND_URL || 'https://flamex.app'}/register?ref=${code}`
      });
      await referral.save();
    }

    res.json({
      code: referral.code,
      link: referral.link,
      referralCode: referral.code,
      referralLink: referral.link
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/link', authMiddleware, async (req, res) => {
  try {
    let referral = await Referral.findOne({ userId: req.userId });

    if (!referral) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let code = '';
      for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));

      referral = new Referral({
        userId: req.userId,
        code,
        link: `${process.env.FRONTEND_URL || 'https://flamex.app'}/register?ref=${code}`
      });
      await referral.save();
    }

    res.json({
      code: referral.code,
      link: referral.link,
      referralCode: referral.code,
      referralLink: referral.link
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get leaderboard
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const topReferrers = await Referral.find()
      .sort({ totalReferrals: -1 })
      .limit(100)
      .populate('userId', 'username firstName lastName profilePicture');

    const leaderboard = topReferrers.map((ref, index) => ({
      rank: index + 1,
      userId: ref.userId?._id,
      username: ref.userId?.username,
      totalReferrals: ref.totalReferrals,
      totalRewards: ref.totalRewards,
      user: {
        id: ref.userId?._id,
        username: ref.userId?.username,
        name: ref.userId ? `${ref.userId.firstName} ${ref.userId.lastName}` : 'Unknown'
      },
      referrals: ref.totalReferrals,
      tier: ref.tier
    }));

    res.json({ leaderboard });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Claim rewards
router.post('/claim-rewards', authMiddleware, async (req, res) => {
  try {
    const referral = await Referral.findOne({ userId: req.userId });

    if (!referral || referral.pendingRewards <= 0) {
      return res.status(400).json({ message: 'No pending rewards' });
    }

    const claimable = referral.rewardHistory.filter(r => r.status === 'pending');
    const totalClaimable = claimable.reduce((sum, r) => sum + r.amount, 0);

    claimable.forEach(r => {
      r.status = 'claimed';
      r.claimedAt = new Date();
    });

    referral.pendingRewards -= totalClaimable;
    referral.claimedRewards += totalClaimable;
    await referral.save();

    const user = await User.findById(req.userId);
    user.balances.USDT = (user.balances.USDT || 0) + totalClaimable;
    await user.save();

    const transaction = new Transaction({
      userId: req.userId,
      type: 'referral_reward',
      amount: totalClaimable,
      currency: 'USDT',
      description: `Claimed referral rewards`,
      status: 'completed',
      reference: `REF-CLAIM-${Date.now()}`
    });
    await transaction.save();

    res.json({ message: 'Rewards claimed', claimedAmount: totalClaimable });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/claim', authMiddleware, async (req, res) => {
  try {
    const referral = await Referral.findOne({ userId: req.userId });

    if (!referral || referral.pendingRewards <= 0) {
      return res.status(400).json({ message: 'No pending rewards' });
    }

    const claimable = referral.rewardHistory.filter((reward) => reward.status === 'pending');
    const totalClaimable = claimable.reduce((sum, reward) => sum + reward.amount, 0);

    claimable.forEach((reward) => {
      reward.status = 'claimed';
      reward.claimedAt = new Date();
    });

    referral.pendingRewards -= totalClaimable;
    referral.claimedRewards += totalClaimable;
    await referral.save();

    const user = await User.findById(req.userId);
    user.balances.USDT = (user.balances.USDT || 0) + totalClaimable;
    await user.save();

    const transaction = new Transaction({
      userId: req.userId,
      type: 'referral_reward',
      amount: totalClaimable,
      currency: 'USDT',
      description: 'Claimed referral rewards',
      status: 'completed',
      reference: `REF-CLAIM-${Date.now()}`
    });
    await transaction.save();

    res.json({ message: 'Rewards claimed', claimedAmount: totalClaimable });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
