const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const Referral = require('../models/Referral');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { getPlatformSettings } = require('../utils/admin');

async function getReferralBonus() {
  const settings = await getPlatformSettings();
  return Number(settings.referralCommissionRate || 500);
}

// Get referral data — auto-creates record if missing
router.get('/', authMiddleware, async (req, res) => {
  try {
    let referral = await Referral.findOne({ userId: req.userId })
      .populate('referredUsers.userId', 'firstName lastName username createdAt');

    if (!referral) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let code = '';
      for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
      referral = await Referral.create({
        userId: req.userId,
        code,
        link: `${process.env.FRONTEND_URL || 'https://flamex.app'}/register?ref=${code}`
      });
    }

    res.json({
      code: referral.code,
      link: referral.link,
      totalReferrals: referral.totalReferrals,
      activeReferrals: referral.activeReferrals,
      totalRewards: referral.totalRewards,
      pendingRewards: referral.pendingRewards,
      claimedRewards: referral.claimedRewards,
      currency: 'NGN',
      bonusPerReferral: await getReferralBonus(),
      referredUsers: referral.referredUsers.map(u => ({
        id: u.userId?._id,
        username: u.userId?.username,
        name: u.userId ? `${u.userId.firstName} ${u.userId.lastName}` : 'Unknown',
        joinedAt: u.joinedAt,
        status: u.status,
        rewardsEarned: u.rewardsEarned
      })),
      rewardHistory: referral.rewardHistory.slice(0, 50)
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Generate / get referral link
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

    res.json({ code: referral.code, link: referral.link });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get leaderboard
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const topReferrers = await Referral.find()
      .sort({ totalReferrals: -1 })
      .limit(50)
      .populate('userId', 'username firstName lastName');

    const leaderboard = topReferrers.map((ref, index) => ({
      rank: index + 1,
      username: ref.userId?.username,
      name: ref.userId ? `${ref.userId.firstName} ${ref.userId.lastName}` : 'Unknown',
      totalReferrals: ref.totalReferrals,
      totalRewards: ref.totalRewards
    }));

    res.json({ leaderboard });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Claim pending rewards
router.post('/claim', authMiddleware, async (req, res) => {
  try {
    const referral = await Referral.findOne({ userId: req.userId });

    if (!referral || referral.pendingRewards <= 0) {
      return res.status(400).json({ message: 'No pending rewards to claim' });
    }

    const claimable = referral.rewardHistory.filter(r => r.status === 'pending');
    const totalClaimable = claimable.reduce((sum, r) => sum + r.amount, 0);

    claimable.forEach(r => {
      r.status = 'claimed';
      r.claimedAt = new Date();
    });

    referral.pendingRewards = Math.max(0, referral.pendingRewards - totalClaimable);
    referral.claimedRewards += totalClaimable;
    await referral.save();

    const user = await User.findById(req.userId);
    user.balances.NGN = (user.balances.NGN || 0) + totalClaimable;
    await user.save();

    await Transaction.create({
      userId: req.userId,
      type: 'referral_reward',
      amount: totalClaimable,
      currency: 'NGN',
      description: `Referral reward claimed`,
      status: 'completed',
      reference: `REF-CLAIM-${Date.now()}`
    });

    res.json({ message: 'Rewards claimed successfully', claimedAmount: totalClaimable, currency: 'NGN' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
