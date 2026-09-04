const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  code: { type: String, required: true, unique: true },
  link: { type: String, required: true },

  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  referredByCode: { type: String, default: null },

  totalReferrals: { type: Number, default: 0 },
  activeReferrals: { type: Number, default: 0 },
  totalRewards: { type: Number, default: 0 },
  pendingRewards: { type: Number, default: 0 },
  claimedRewards: { type: Number, default: 0 },

  referredUsers: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    joinedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    rewardsEarned: { type: Number, default: 0 }
  }],

  rewardHistory: [{
    amount: { type: Number, required: true },
    currency: { type: String, default: 'NGN' },
    type: { type: String, enum: ['signup_bonus', 'bonus'] },
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    description: { type: String },
    createdAt: { type: Date, default: Date.now },
    claimedAt: { type: Date, default: null },
    status: { type: String, enum: ['pending', 'claimed'], default: 'pending' }
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Referral', referralSchema);
