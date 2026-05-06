const mongoose = require('mongoose');

const emailOtpSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  purpose: {
    type: String,
    enum: ['verify_email', 'pin_reset'],
    required: true,
    index: true
  },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: true },
  consumedAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 }
});

module.exports = mongoose.model('EmailOtp', emailOtpSchema);
