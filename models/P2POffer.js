const mongoose = require('mongoose');

const paymentDetailsSchema = new mongoose.Schema(
  {
    bankName: { type: String, default: null },
    bankCode: { type: String, default: null },
    accountNumber: { type: String, default: null },
    accountName: { type: String, default: null },
    instructions: { type: String, default: null }
  },
  { _id: false }
);

const p2pOfferSchema = new mongoose.Schema({
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  side: { type: String, enum: ['buy', 'sell'], required: true },
  asset: { type: String, required: true, uppercase: true, trim: true },
  fiatCurrency: { type: String, required: true, default: 'NGN', uppercase: true, trim: true },
  price: { type: Number, required: true, min: 0 },
  availableAmount: { type: Number, required: true, min: 0 },
  minOrderAmount: { type: Number, required: true, min: 0 },
  maxOrderAmount: { type: Number, required: true, min: 0 },
  paymentWindowMinutes: { type: Number, default: 30, min: 5, max: 180 },
  paymentMethod: { type: String, default: 'bank_transfer', trim: true },
  paymentDetails: { type: paymentDetailsSchema, default: () => ({}) },
  terms: { type: String, default: '', trim: true },
  status: {
    type: String,
    enum: ['open', 'paused', 'completed', 'cancelled'],
    default: 'open',
    index: true
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

p2pOfferSchema.index({ side: 1, asset: 1, status: 1, price: 1 });

module.exports = mongoose.model('P2POffer', p2pOfferSchema);
