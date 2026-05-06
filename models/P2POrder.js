const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, default: null },
    fullName: { type: String, default: null }
  },
  { _id: false }
);

const paymentSnapshotSchema = new mongoose.Schema(
  {
    bankName: { type: String, default: null },
    bankCode: { type: String, default: null },
    accountNumber: { type: String, default: null },
    accountName: { type: String, default: null },
    instructions: { type: String, default: null }
  },
  { _id: false }
);

const p2pOrderSchema = new mongoose.Schema({
  offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'P2POffer', required: true, index: true },
  offerOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  takerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  asset: { type: String, required: true, uppercase: true, trim: true },
  fiatCurrency: { type: String, required: true, default: 'NGN', uppercase: true, trim: true },
  price: { type: Number, required: true, min: 0 },
  cryptoAmount: { type: Number, required: true, min: 0 },
  fiatAmount: { type: Number, required: true, min: 0 },
  buyer: { type: participantSchema, required: true },
  seller: { type: participantSchema, required: true },
  escrowUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  paymentMethod: { type: String, default: 'bank_transfer' },
  paymentSnapshot: { type: paymentSnapshotSchema, default: () => ({}) },
  status: {
    type: String,
    enum: ['awaiting_payment', 'payment_sent', 'completed', 'cancelled', 'disputed', 'expired'],
    default: 'awaiting_payment',
    index: true
  },
  paymentProofNote: { type: String, default: null },
  paymentProofUrl: { type: String, default: null },
  paymentMarkedAt: { type: Date, default: null },
  releaseNote: { type: String, default: null },
  cryptoFeeAmount: { type: Number, default: 0, min: 0 },
  cryptoReleaseAmount: { type: Number, default: 0, min: 0 },
  fiatFeeAmount: { type: Number, default: 0, min: 0 },
  releasedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
  cancelledByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  cancelReason: { type: String, default: null },
  disputeId: { type: mongoose.Schema.Types.ObjectId, ref: 'P2PDispute', default: null },
  reference: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

p2pOrderSchema.index({ 'buyer.userId': 1, createdAt: -1 });
p2pOrderSchema.index({ 'seller.userId': 1, createdAt: -1 });

module.exports = mongoose.model('P2POrder', p2pOrderSchema);
