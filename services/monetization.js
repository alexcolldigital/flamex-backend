const { getPlatformSettings } = require('../utils/admin');
const { createLedgerEntry } = require('./platformLedger');

function roundAmount(amount, decimals = 2) {
  return Number(Number(amount || 0).toFixed(decimals));
}

function calculatePercentageFee(amount, rate) {
  return roundAmount(Number(amount) * (Number(rate) / 100));
}

async function getConfiguredFee(key, amount, { percentage = true, currency = 'NGN' } = {}) {
  const settings = await getPlatformSettings();
  const configured = Number(settings?.fees?.[key] || 0);
  const fee = percentage ? calculatePercentageFee(amount, configured) : roundAmount(configured);
  return { fee, currency: String(currency).toUpperCase(), rate: configured, percentage };
}

async function recordPlatformFee({ fee, currency, reference, sourceType, sourceId, userId, metadata = {} }) {
  if (Number(fee) <= 0) return null;
  return createLedgerEntry({
    category: 'service_fee',
    direction: 'credit',
    asset: currency,
    amount: fee,
    reference: `${reference}-FEE`,
    sourceType,
    sourceId,
    createdByUserId: userId,
    metadata
  });
}

module.exports = {
  roundAmount,
  getConfiguredFee,
  recordPlatformFee
};