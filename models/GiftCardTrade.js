const mongoose = require('mongoose');

const giftCardTradeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    brand: { type: String, required: true, trim: true },
    country: { type: String, required: true, trim: true },
    currency: { type: String, required: true, trim: true, uppercase: true },
    cardValue: { type: Number, required: true, min: 1 },
    cardType: { type: String, enum: ['physical', 'e_code'], required: true },
    submissionMethod: { type: String, enum: ['images', 'code'], required: true },
    frontImageUrl: { type: String, default: null },
    backImageUrl: { type: String, default: null },
    cardCode: { type: String, default: null },
    tradeCodePin: { type: String, default: null },
    note: { type: String, default: null },
    ratePerUnit: { type: Number, required: true, min: 0 },
    estimatedPayout: { type: Number, required: true, min: 0 },
    finalPayout: { type: Number, default: null },
    status: {
      type: String,
      enum: ['pending_review', 'more_info_required', 'completed', 'rejected'],
      default: 'pending_review',
      index: true
    },
    reviewNote: { type: String, default: null },
    rejectionReason: { type: String, default: null },
    reviewedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    creditedTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    reference: { type: String, required: true, unique: true }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('GiftCardTrade', giftCardTradeSchema);
