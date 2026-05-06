const mongoose = require('mongoose');

const userTransferSchema = new mongoose.Schema({
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fromUsername: { type: String, required: true },
  
  toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  toUsername: { type: String, required: true },
  
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  chainId: { type: String, required: true },
  
  fee: { type: Number, default: 0 },
  feeCurrency: { type: String, default: 'USDT' },
  
  status: { 
    type: String, 
    enum: ['pending', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },
  
  description: { type: String, default: '' },
  reference: { type: String, required: true, unique: true },
  
  fromTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
  toTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
  
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null }
});

userTransferSchema.index({ fromUserId: 1, createdAt: -1 });
userTransferSchema.index({ toUserId: 1, createdAt: -1 });

module.exports = mongoose.model('UserTransfer', userTransferSchema);
