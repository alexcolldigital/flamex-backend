const mongoose = require('mongoose');

const stakeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  token: { 
    type: String, 
    required: true,
    enum: ['SOL', 'FLAME']
  },
  amount: { type: Number, required: true },
  apy: { type: Number, required: true },
  
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, default: null },
  lockPeriod: { type: Number, default: 0 },
  
  status: { 
    type: String, 
    required: true,
    enum: ['active', 'unstaking', 'completed'],
    default: 'active'
  },
  
  rewards: { type: Number, default: 0 },
  lastClaimDate: { type: Date, default: Date.now },
  totalClaimed: { type: Number, default: 0 },
  
  createdAt: { type: Date, default: Date.now }
});

stakeSchema.methods.calculateRewards = function() {
  const now = new Date();
  const daysSinceLastClaim = (now - this.lastClaimDate) / (1000 * 60 * 60 * 24);
  const dailyRate = this.apy / 365 / 100;
  return this.amount * dailyRate * daysSinceLastClaim;
};

module.exports = mongoose.model('Stake', stakeSchema);
