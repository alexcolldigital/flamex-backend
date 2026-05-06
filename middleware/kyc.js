const { getPlatformSettings } = require('../utils/admin');
const User = require('../models/User');

const requireVerifiedKycForTransactions = async (req, res, next) => {
  try {
    const settings = req.platformSettings || await getPlatformSettings();
    if (!settings.requireKycForTransactions) {
      return next();
    }

    const user = req.user || await User.findById(req.userId);
    if (!user?.kycVerified) {
      return res.status(403).json({ message: 'Complete KYC before performing this transaction' });
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(500).json({ message: 'Unable to verify transaction eligibility' });
  }
};

module.exports = { requireVerifiedKycForTransactions };
