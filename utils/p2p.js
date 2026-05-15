const SUPPORTED_P2P_ASSETS = ['USDT', 'USDC', 'SOL', 'ETH', 'BNB', 'FLAME'];
const SUPPORTED_P2P_PAYMENT_METHODS = ['bank_transfer'];

function normalizeAsset(asset) {
  return String(asset || '').trim().toUpperCase();
}

function ensureSupportedAsset(asset) {
  return SUPPORTED_P2P_ASSETS.includes(normalizeAsset(asset));
}

function ensureSupportedPaymentMethod(paymentMethod) {
  return SUPPORTED_P2P_PAYMENT_METHODS.includes(String(paymentMethod || '').trim().toLowerCase());
}

function ensureLockedBalances(user) {
  if (!user.lockedBalances) {
    user.lockedBalances = {};
  }
}

function getBalance(user, asset) {
  return Number(user?.balances?.[asset] || 0);
}

function getLockedBalance(user, asset) {
  ensureLockedBalances(user);
  return Number(user?.lockedBalances?.[asset] || 0);
}

function getAvailableBalance(user, asset) {
  const normalized = normalizeAsset(asset);
  return Math.max(0, getBalance(user, normalized) - getLockedBalance(user, normalized));
}

function lockFunds(user, asset, amount) {
  const normalized = normalizeAsset(asset);
  const numericAmount = Number(amount);
  if (getBalance(user, normalized) < numericAmount) {
    throw new Error(`Insufficient ${normalized} balance`);
  }
  user.balances[normalized] = getBalance(user, normalized) - numericAmount;
  user.lockedBalances[normalized] = getLockedBalance(user, normalized) + numericAmount;
}

function unlockFunds(user, asset, amount) {
  const normalized = normalizeAsset(asset);
  const numericAmount = Number(amount);
  if (getLockedBalance(user, normalized) < numericAmount) {
    throw new Error(`Insufficient locked ${normalized} balance`);
  }
  user.lockedBalances[normalized] = getLockedBalance(user, normalized) - numericAmount;
  user.balances[normalized] = getBalance(user, normalized) + numericAmount;
}

function releaseLockedFunds(seller, buyer, asset, amount) {
  const normalized = normalizeAsset(asset);
  const numericAmount = Number(amount);
  if (getLockedBalance(seller, normalized) < numericAmount) {
    throw new Error(`Insufficient locked ${normalized} balance`);
  }
  seller.lockedBalances[normalized] = getLockedBalance(seller, normalized) - numericAmount;
  buyer.balances[normalized] = getBalance(buyer, normalized) + numericAmount;
}

function buildParticipant(user) {
  return {
    userId: user._id,
    username: user.username || null,
    fullName: `${user.firstName} ${user.lastName}`.trim()
  };
}

function getDefaultBankAccount(user) {
  const defaultAccount =
    (user.bankAccounts || []).find((account) => account.isDefault) ||
    (user.bankAccounts || [])[0];

  if (!defaultAccount) {
    return null;
  }

  return {
    bankName: defaultAccount.bankName,
    bankCode: defaultAccount.bankCode,
    accountNumber: defaultAccount.accountNumber,
    accountName: defaultAccount.accountName,
    instructions: null
  };
}

function isP2PAdmin(user) {
  const adminEmails = String(process.env.P2P_ADMIN_EMAILS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return adminEmails.includes(String(user?.email || '').toLowerCase());
}

module.exports = {
  SUPPORTED_P2P_ASSETS,
  SUPPORTED_P2P_PAYMENT_METHODS,
  normalizeAsset,
  ensureSupportedAsset,
  ensureSupportedPaymentMethod,
  getBalance,
  getLockedBalance,
  getAvailableBalance,
  lockFunds,
  unlockFunds,
  releaseLockedFunds,
  buildParticipant,
  getDefaultBankAccount,
  isP2PAdmin
};
