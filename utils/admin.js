const AppSetting = require('../models/AppSetting');

const DEFAULT_PLATFORM_SETTINGS = {
  maintenanceMode: false,
  allowNewRegistrations: true,
  requireKycForTransactions: true,
  maxWithdrawalLimit: 50000,
  minWithdrawalAmount: 10,
  referralCommissionRate: 5,
  fees: {
    swapFee: 0.5,
    bridgeFee: 1,
    withdrawalFee: 0.5,
    depositFee: 0,
    virtualCardCreationFee: 10,
    virtualCardMonthlyFee: 2,
    giftCardFee: 2,
    billPaymentFee: 1,
    p2pCryptoFeeRate: Number(process.env.P2P_CRYPTO_FEE_RATE || 0.0025),
    p2pNgnFeeRate: Number(process.env.P2P_NGN_FEE_RATE || 0)
  }
};

function getAdminEmails() {
  const entries = `${process.env.ADMIN_EMAILS || ''},${process.env.P2P_ADMIN_EMAILS || ''}`
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(entries)];
}

function isAdminUser(user) {
  return getAdminEmails().includes(String(user?.email || '').toLowerCase());
}

function buildAdminProfile(user) {
  return {
    _id: user._id,
    email: user.email,
    fullName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
    role: 'superadmin',
    permissions: ['all']
  };
}

async function getPlatformSettings() {
  const entry = await AppSetting.findOne({ key: 'platform_settings' });
  if (!entry?.value) {
    return DEFAULT_PLATFORM_SETTINGS;
  }

  return {
    ...DEFAULT_PLATFORM_SETTINGS,
    ...entry.value,
    fees: {
      ...DEFAULT_PLATFORM_SETTINGS.fees,
      ...(entry.value.fees || {})
    }
  };
}

async function savePlatformSettings(value, updatedByUserId = null) {
  const merged = {
    ...(await getPlatformSettings()),
    ...value,
    fees: {
      ...(await getPlatformSettings()).fees,
      ...(value.fees || {})
    }
  };

  const entry = await AppSetting.findOneAndUpdate(
    { key: 'platform_settings' },
    { value: merged, updatedByUserId },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return entry.value;
}

module.exports = {
  DEFAULT_PLATFORM_SETTINGS,
  isAdminUser,
  buildAdminProfile,
  getPlatformSettings,
  savePlatformSettings
};
