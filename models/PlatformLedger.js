const mongoose = require('mongoose');

const platformLedgerSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      enum: ['p2p_crypto_fee', 'p2p_ngn_fee', 'treasury_withdrawal'],
      required: true
    },
    direction: {
      type: String,
      enum: ['credit', 'debit'],
      required: true
    },
    asset: { type: String, required: true, uppercase: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['completed', 'pending', 'failed'],
      default: 'completed'
    },
    reference: { type: String, required: true, unique: true },
    sourceType: { type: String, default: null },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    destinationType: { type: String, default: null },
    destination: { type: mongoose.Schema.Types.Mixed, default: null },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true
  }
);

platformLedgerSchema.index({ category: 1, asset: 1, createdAt: -1 });

module.exports = mongoose.model('PlatformLedger', platformLedgerSchema);
