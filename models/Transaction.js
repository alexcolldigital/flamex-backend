const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    required: true,
    enum: [
      'deposit', 'withdrawal', 'swap', 'cross_chain_swap',
      'bill_payment', 'gift_card', 'stake', 'unstake',
      'referral_reward', 'user_transfer_sent', 'user_transfer_received', 'fee',
      'airtime', 'data', 'electricity', 'cable', 'betting', 'giftcard',
      'virtual_card', 'kyc', 'p2p_buy', 'p2p_sell', 'p2p_refund'
    ]
  },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  chainId: { type: String, default: null },
  
  status: { 
    type: String, 
    required: true,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },
  
  description: { type: String, required: true },
  txHash: { type: String, default: null },
  
  fromCurrency: { type: String, default: null },
  toCurrency: { type: String, default: null },
  fromAmount: { type: Number, default: null },
  toAmount: { type: Number, default: null },
  
  fromChainId: { type: String, default: null },
  toChainId: { type: String, default: null },
  
  toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  toUsername: { type: String, default: null },
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  fromUsername: { type: String, default: null },
  
  fee: { type: Number, default: 0 },
  feeCurrency: { type: String, default: null },
  gasFee: { type: Number, default: 0 },
  
  reference: { type: String, required: true, unique: true },
  
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null }
});

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, type: 1 });
// Removed: transactionSchema.index({ reference: 1 }); 
// Index is already created by unique: true constraint on reference field

module.exports = mongoose.model('Transaction', transactionSchema);
