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
  
  rewardPercentage: { type: Number, default: 10 },
  
  tier: { 
    type: String, 
    enum: ['bronze', 'silver', 'gold', 'platinum', 'diamond'],
    default: 'bronze'
  },
  
  referredUsers: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    joinedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    totalVolume: { type: Number, default: 0 },
    rewardsEarned: { type: Number, default: 0 }
  }],
  
  rewardHistory: [{
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USDT' },
    type: { type: String, enum: ['swap_fee', 'deposit_fee', 'bonus', 'tier_upgrade'] },
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    description: { type: String },
    createdAt: { type: Date, default: Date.now },
    claimedAt: { type: Date, default: null },
    status: { type: String, enum: ['pending', 'claimed'], default: 'pending' }
  }],
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

referralSchema.methods.updateTier = function() {
  const count = this.totalReferrals;
  if (count >= 100) this.tier = 'diamond';
  else if (count >= 50) this.tier = 'platinum';
  else if (count >= 20) this.tier = 'gold';
  else if (count >= 5) this.tier = 'silver';
  else this.tier = 'bronze';
  
  const percentages = { bronze: 10, silver: 15, gold: 20, platinum: 25, diamond: 30 };
  this.rewardPercentage = percentages[this.tier];
};

module.exports = mongoose.model('Referral', referralSchema);
