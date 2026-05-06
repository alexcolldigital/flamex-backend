const mongoose = require('mongoose');

const evidenceSchema = new mongoose.Schema(
  {
    note: { type: String, default: null },
    url: { type: String, default: null },
    addedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    senderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderLabel: { type: String, default: null },
    message: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const p2pDisputeSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'P2POrder', required: true, unique: true },
  openedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reason: { type: String, required: true, trim: true },
  status: {
    type: String,
    enum: ['open', 'resolved', 'dismissed'],
    default: 'open',
    index: true
  },
  evidence: { type: [evidenceSchema], default: [] },
  messages: { type: [messageSchema], default: [] },
  resolution: {
    outcome: {
      type: String,
      enum: ['release_to_buyer', 'refund_to_seller', 'dismissed', null],
      default: null
    },
    note: { type: String, default: null },
    resolvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('P2PDispute', p2pDisputeSchema);
