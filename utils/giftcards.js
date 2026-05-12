const AppSetting = require('../models/AppSetting');

const DEFAULT_GIFTCARD_CONFIG = {
  disclaimer: 'Final payout depends on card verification.',
  supportedCards: [
    { id: 'amazon_usa', brand: 'Amazon', country: 'USA', currency: 'USD', rate: 1200, supportedCardTypes: ['physical', 'e_code'] },
    { id: 'steam_usa', brand: 'Steam', country: 'USA', currency: 'USD', rate: 1100, supportedCardTypes: ['physical', 'e_code'] },
    { id: 'apple_uk', brand: 'Apple', country: 'UK', currency: 'GBP', rate: 1000, supportedCardTypes: ['physical', 'e_code'] },
    { id: 'google_play_usa', brand: 'Google Play', country: 'USA', currency: 'USD', rate: 1050, supportedCardTypes: ['e_code'] }
  ]
};

async function getGiftCardConfig() {
  const setting = await AppSetting.findOne({ key: 'giftcard_trade_config' });
  if (!setting?.value) {
    return DEFAULT_GIFTCARD_CONFIG;
  }
  return {
    ...DEFAULT_GIFTCARD_CONFIG,
    ...setting.value,
    supportedCards: setting.value.supportedCards || DEFAULT_GIFTCARD_CONFIG.supportedCards
  };
}

async function saveGiftCardConfig(value, updatedByUserId = null) {
  const merged = {
    ...(await getGiftCardConfig()),
    ...value,
    supportedCards: value.supportedCards || (await getGiftCardConfig()).supportedCards
  };

  const setting = await AppSetting.findOneAndUpdate(
    { key: 'giftcard_trade_config' },
    { value: merged, updatedByUserId },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return setting.value;
}

function findSupportedCard(config, { brand, country, currency }) {
  return (config.supportedCards || []).find((card) =>
    String(card.brand).toLowerCase() === String(brand).toLowerCase() &&
    String(card.country).toLowerCase() === String(country).toLowerCase() &&
    String(card.currency).toUpperCase() === String(currency).toUpperCase()
  );
}

module.exports = {
  DEFAULT_GIFTCARD_CONFIG,
  getGiftCardConfig,
  saveGiftCardConfig,
  findSupportedCard
};
