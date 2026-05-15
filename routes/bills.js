const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const GiftCardTrade = require('../models/GiftCardTrade');
const vtpassService = require('../services/vtpass');
const { createNotification } = require('../services/notifications');
const { requireVerifiedKycForTransactions } = require('../middleware/kyc');
const { getGiftCardConfig, findSupportedCard } = require('../utils/giftcards');
const { withTransaction } = require('../utils/database');
const { AppError } = require('../utils/errorHandler');

const ELECTRICITY_SERVICE_IDS = {
  ikedc: 'ikeja-electric',
  ekedc: 'eko-electric',
  aedc: 'abuja-electric',
  ibedc: 'ibadan-electric',
  kedco: 'kano-electric',
  phedc: 'portharcourt-electric',
  enedc: 'enugu-electric',
  bedc: 'benin-electric',
  yedc: 'yola-electric',
  josedc: 'jos-electric'
};

// Nigerian Service Providers
const PROVIDERS = {
  // Mobile Networks
  airtime: [
    { id: 'mtn', name: 'MTN Nigeria', code: 'MTN', logo: 'mtn' },
    { id: 'airtel', name: 'Airtel Nigeria', code: 'AIRTEL', logo: 'airtel' },
    { id: 'glo', name: 'Glo Mobile', code: 'GLO', logo: 'glo' },
    { id: '9mobile', name: '9mobile', code: '9MOBILE', logo: '9mobile' }
  ],
  data: [
    { id: 'mtn', name: 'MTN Nigeria', code: 'MTN', logo: 'mtn' },
    { id: 'airtel', name: 'Airtel Nigeria', code: 'AIRTEL', logo: 'airtel' },
    { id: 'glo', name: 'Glo Mobile', code: 'GLO', logo: 'glo' },
    { id: '9mobile', name: '9mobile', code: '9MOBILE', logo: '9mobile' }
  ],

  // Electricity Distribution Companies
  electricity: [
    { id: 'ikedc', name: 'Ikeja Electric (IKEDC)', code: 'IKEDC', states: ['Lagos'] },
    { id: 'ekedc', name: 'Eko Electric (EKEDC)', code: 'EKEDC', states: ['Lagos'] },
    { id: 'aedc', name: 'Abuja Electric (AEDC)', code: 'AEDC', states: ['FCT', 'Niger', 'Kogi', 'Nassarawa'] },
    { id: 'ibedc', name: 'Ibadan Electric (IBEDC)', code: 'IBEDC', states: ['Oyo', 'Ogun', 'Osun', 'Kwara'] },
    { id: 'kedco', name: 'Kano Electric (KEDCO)', code: 'KEDCO', states: ['Kano', 'Katsina', 'Jigawa'] },
    { id: 'phedc', name: 'Port Harcourt Electric (PHEDC)', code: 'PHEDC', states: ['Rivers', 'Bayelsa', 'Cross River', 'Akwa Ibom'] },
    { id: 'enedc', name: 'Enugu Electric (EEDC)', code: 'EEDC', states: ['Enugu', 'Anambra', 'Ebonyi', 'Abia', 'Imo'] },
    { id: 'bedc', name: 'Benin Electric (BEDC)', code: 'BEDC', states: ['Edo', 'Delta', 'Ondo', 'Ekiti'] },
    { id: 'yedc', name: 'Yola Electric (YEDC)', code: 'YEDC', states: ['Adamawa', 'Taraba', 'Borno', 'Yobe'] },
    { id: 'josedc', name: 'Jos Electric (JEDC)', code: 'JEDC', states: ['Plateau', 'Gombe', 'Bauchi'] }
  ],

  // Cable TV Providers
  cable: [
    { id: 'dstv', name: 'DStv', packages: ['Padi', 'Yanga', 'Confam', 'Compact', 'Compact Plus', 'Premium'] },
    { id: 'gotv', name: 'GOtv', packages: ['Smallie', 'Jinja', 'Jolli', 'Max', 'Supa'] },
    { id: 'startimes', name: 'StarTimes', packages: ['Nova', 'Basic', 'Classic', 'Unique'] }
  ],

  // Betting Platforms
  betting: [
    { id: 'bet9ja', name: 'Bet9ja', minAmount: 100 },
    { id: 'betking', name: 'BetKing', minAmount: 100 },
    { id: 'sportybet', name: 'SportyBet', minAmount: 100 },
    { id: '1xbet', name: '1xBet', minAmount: 100 },
    { id: 'betway', name: 'Betway', minAmount: 100 },
    { id: 'nairabet', name: 'NairaBet', minAmount: 100 },
    { id: 'merrybet', name: 'MerryBet', minAmount: 100 },
    { id: 'betpawa', name: 'BetPawa', minAmount: 50 }
  ],

  giftcards: {}
};

// Data Bundle Plans
const DATA_PLANS = {
  mtn: [
    { id: 'mtn_50mb', name: '50MB', amount: 50, validity: '24 hours' },
    { id: 'mtn_150mb', name: '150MB', amount: 100, validity: '24 hours' },
    { id: 'mtn_500mb', name: '500MB', amount: 300, validity: '7 days' },
    { id: 'mtn_1gb', name: '1GB', amount: 500, validity: '7 days' },
    { id: 'mtn_2gb', name: '2GB', amount: 1000, validity: '30 days' },
    { id: 'mtn_3gb', name: '3GB', amount: 1500, validity: '30 days' },
    { id: 'mtn_5gb', name: '5GB', amount: 2500, validity: '30 days' },
    { id: 'mtn_10gb', name: '10GB', amount: 3500, validity: '30 days' },
    { id: 'mtn_15gb', name: '15GB', amount: 5000, validity: '30 days' },
    { id: 'mtn_20gb', name: '20GB', amount: 6500, validity: '30 days' }
  ],
  airtel: [
    { id: 'airtel_50mb', name: '50MB', amount: 50, validity: '24 hours' },
    { id: 'airtel_200mb', name: '200MB', amount: 200, validity: '3 days' },
    { id: 'airtel_350mb', name: '350MB', amount: 300, validity: '7 days' },
    { id: 'airtel_1gb', name: '1GB', amount: 500, validity: '7 days' },
    { id: 'airtel_2gb', name: '2GB', amount: 1000, validity: '30 days' },
    { id: 'airtel_4gb', name: '4GB', amount: 2000, validity: '30 days' },
    { id: 'airtel_6gb', name: '6GB', amount: 2500, validity: '30 days' },
    { id: 'airtel_10gb', name: '10GB', amount: 3500, validity: '30 days' }
  ],
  glo: [
    { id: 'glo_50mb', name: '50MB', amount: 50, validity: '1 day' },
    { id: 'glo_350mb', name: '350MB', amount: 200, validity: '2 days' },
    { id: 'glo_1_8gb', name: '1.8GB', amount: 500, validity: '14 days' },
    { id: 'glo_3_9gb', name: '3.9GB', amount: 1000, validity: '30 days' },
    { id: 'glo_7_5gb', name: '7.5GB', amount: 2000, validity: '30 days' },
    { id: 'glo_9_2gb', name: '9.2GB', amount: 2500, validity: '30 days' },
    { id: 'glo_12gb', name: '12GB', amount: 3500, validity: '30 days' }
  ],
  '9mobile': [
    { id: '9mobile_50mb', name: '50MB', amount: 50, validity: '24 hours' },
    { id: '9mobile_200mb', name: '200MB', amount: 200, validity: '3 days' },
    { id: '9mobile_500mb', name: '500MB', amount: 500, validity: '7 days' },
    { id: '9mobile_1_5gb', name: '1.5GB', amount: 1000, validity: '30 days' },
    { id: '9mobile_2gb', name: '2GB', amount: 1500, validity: '30 days' },
    { id: '9mobile_4_5gb', name: '4.5GB', amount: 2500, validity: '30 days' },
    { id: '9mobile_11gb', name: '11GB', amount: 4000, validity: '30 days' }
  ]
};

// Cable TV Packages with Prices
const CABLE_PACKAGES = {
  dstv: [
    { id: 'dstv_padi', name: 'Padi', amount: 2950 },
    { id: 'dstv_yanga', name: 'Yanga', amount: 4200 },
    { id: 'dstv_confam', name: 'Confam', amount: 7400 },
    { id: 'dstv_compact', name: 'Compact', amount: 15700 },
    { id: 'dstv_compact_plus', name: 'Compact Plus', amount: 25000 },
    { id: 'dstv_premium', name: 'Premium', amount: 37000 }
  ],
  gotv: [
    { id: 'gotv_smallie', name: 'Smallie', amount: 1575 },
    { id: 'gotv_jinja', name: 'Jinja', amount: 3300 },
    { id: 'gotv_jolli', name: 'Jolli', amount: 4850 },
    { id: 'gotv_max', name: 'Max', amount: 7200 },
    { id: 'gotv_supa', name: 'Supa', amount: 9600 }
  ],
  startimes: [
    { id: 'startimes_nova', name: 'Nova', amount: 1500 },
    { id: 'startimes_basic', name: 'Basic', amount: 2600 },
    { id: 'startimes_classic', name: 'Classic', amount: 3800 },
    { id: 'startimes_unique', name: 'Unique', amount: 5200 }
  ]
};

async function createBillNotification({ user, transaction, amount, detail }) {
  await createNotification({
    user,
    type: 'bill',
    title: 'Bill payment successful',
    body: `${detail} was paid successfully.`,
    data: {
      reference: transaction.reference,
      amount,
      currency: 'NGN',
      transactionId: transaction._id,
      type: transaction.type
    },
    sendEmail: true,
    emailAmount: amount,
    emailCurrency: 'NGN',
    emailReference: transaction.reference
  });
}

async function completeBillPayment({
  userId,
  amount,
  reference,
  type,
  description,
  metadata
}) {
  return withTransaction(async (session) => {
    const sessionUser = await User.findById(userId).session(session);
    if (!sessionUser) {
      throw new AppError('User not found', 404);
    }

    if (Number(sessionUser.balances.NGN || 0) < Number(amount)) {
      throw new AppError('Insufficient NGN balance', 400);
    }

    const transaction = new Transaction({
      userId,
      type,
      amount,
      currency: 'NGN',
      description,
      status: 'completed',
      reference,
      metadata
    });

    sessionUser.balances.NGN = Number((Number(sessionUser.balances.NGN || 0) - Number(amount)).toFixed(2));

    await Promise.all([
      transaction.save({ session }),
      sessionUser.save({ session })
    ]);

    return { user: sessionUser, transaction };
  });
}

// Get all providers
router.get('/providers', authMiddleware, (req, res) => {
  res.json({
    success: true,
    providers: PROVIDERS
  });
});

// Get providers by type
router.get('/providers/:type', authMiddleware, async (req, res) => {
  const { type } = req.params;
  if (type === 'giftcards') {
    const config = await getGiftCardConfig();
    return res.json({
      success: true,
      type,
      providers: {
        disclaimer: config.disclaimer,
        supportedCards: config.supportedCards
      }
    });
  }
  const providers = PROVIDERS[type];

  if (!providers) {
    return res.status(400).json({ message: 'Invalid provider type' });
  }

  res.json({
    success: true,
    type,
    providers
  });
});

// Get data plans for a provider
router.get('/data-plans/:provider', authMiddleware, (req, res) => {
  const { provider } = req.params;
  const plans = DATA_PLANS[provider];

  if (!plans) {
    return res.status(400).json({ message: 'Invalid provider' });
  }

  res.json({
    success: true,
    provider,
    plans
  });
});

// Get cable packages
router.get('/cable-packages/:provider', authMiddleware, (req, res) => {
  const { provider } = req.params;
  const packages = CABLE_PACKAGES[provider];

  if (!packages) {
    return res.status(400).json({ message: 'Invalid cable provider' });
  }

  res.json({
    success: true,
    provider,
    packages
  });
});

// Validate meter number (electricity)
router.post('/validate-meter', authMiddleware, [
  body('provider').notEmpty(),
  body('meterNumber').notEmpty(),
  body('meterType').isIn(['prepaid', 'postpaid'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { provider, meterNumber, meterType } = req.body;

    // Simulate validation - in production, integrate with disco API
    const isValid = meterNumber.length >= 10 && meterNumber.length <= 13;

    if (!isValid) {
      return res.status(400).json({ message: 'Invalid meter number' });
    }

    // Simulate customer info
    const customerInfo = {
      name: 'John Doe',
      address: '123 Sample Street, Lagos',
      meterNumber,
      meterType,
      provider: PROVIDERS.electricity.find(p => p.id === provider)?.name || provider
    };

    res.json({
      success: true,
      valid: true,
      customerInfo
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// Validate smart card (cable TV)
router.post('/validate-smartcard', authMiddleware, [
  body('provider').notEmpty(),
  body('smartCardNumber').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { provider, smartCardNumber } = req.body;

    // Simulate validation
    const isValid = smartCardNumber.length >= 10 && smartCardNumber.length <= 17;

    if (!isValid) {
      return res.status(400).json({ message: 'Invalid smart card number' });
    }

    const customerInfo = {
      name: 'John Doe',
      smartCardNumber,
      provider: PROVIDERS.cable.find(p => p.id === provider)?.name || provider,
      currentPackage: 'Compact'
    };

    res.json({
      success: true,
      valid: true,
      customerInfo
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// Validate phone number
router.post('/validate-phone', authMiddleware, [
  body('phoneNumber').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { phoneNumber } = req.body;

    // Nigerian phone validation
    const cleaned = phoneNumber.replace(/\D/g, '');
    const isValid = cleaned.length === 11 || (cleaned.length === 13 && cleaned.startsWith('234'));

    // Detect network
    let network = 'Unknown';
    const prefixes = {
      mtn: ['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913'],
      airtel: ['0802', '0808', '0708', '0812', '0701', '0902', '0907', '0901', '0912'],
      glo: ['0805', '0807', '0705', '0815', '0811', '0905', '0915'],
      '9mobile': ['0809', '0817', '0818', '0908', '0909']
    };

    const prefix = cleaned.slice(-11, -7);
    for (const [net, nets] of Object.entries(prefixes)) {
      if (nets.includes('0' + prefix)) {
        network = net;
        break;
      }
    }

    res.json({
      success: true,
      valid: isValid,
      network,
      formattedNumber: cleaned.length === 11 ? '+234' + cleaned.slice(1) : '+' + cleaned
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// Buy Airtime
router.post('/airtime', authMiddleware, requireVerifiedKycForTransactions, [
  body('provider').notEmpty(),
  body('phoneNumber').notEmpty(),
  body('amount').isFloat({ min: 50, max: 50000 }),
  body('pin').isLength({ min: 4, max: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { provider, phoneNumber, amount, pin } = req.body;
    const user = await User.findById(req.userId);

    const pinMatch = await user.comparePin(pin);
    if (!pinMatch) {
      return res.status(400).json({ message: 'Invalid PIN' });
    }

    if (user.balances.NGN < amount) {
      return res.status(400).json({ message: 'Insufficient NGN balance' });
    }

    const reference = `AIRTIME-${Date.now()}`;
    const providerName = PROVIDERS.airtime.find(p => p.id === provider)?.name || provider;

    // Try VTpass first, fallback to mock if not configured
    if (!vtpassService.isConfigured) {
      return res.status(503).json({ message: 'Bill payment service is not configured' });
    }

    const auth = await vtpassService.getAuthToken();
    if (!auth.success) {
      return res.status(502).json({ message: auth.error || 'Unable to authenticate bill payment service' });
    }

    const vtpassResult = await vtpassService.buyAirtime({
      phone: phoneNumber,
      amount,
      network: provider,
      token: auth.token
    });
    if (!vtpassResult.success) {
      return res.status(502).json({ message: vtpassResult.error || 'Airtime provider request failed' });
    }

    const { user: updatedUser, transaction } = await completeBillPayment({
      userId: req.userId,
      amount,
      reference,
      type: 'airtime',
      description: `${providerName} airtime for ${phoneNumber}`,
      metadata: {
        provider,
        phoneNumber,
        billType: 'airtime',
        vtpassResponse: vtpassResult
      }
    });

    await createBillNotification({
      user: updatedUser,
      transaction,
      amount,
      detail: `${providerName} airtime for ${phoneNumber}`
    });

    res.json({
      success: true,
      message: 'Airtime purchase successful',
      reference,
      newBalance: updatedUser.balances.NGN,
      details: {
        provider: providerName,
        phoneNumber,
        amount
      }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// Buy Data
router.post('/data', authMiddleware, requireVerifiedKycForTransactions, [
  body('provider').notEmpty(),
  body('phoneNumber').notEmpty(),
  body('planId').notEmpty(),
  body('pin').isLength({ min: 4, max: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { provider, phoneNumber, planId, pin } = req.body;
    const user = await User.findById(req.userId);

    const pinMatch = await user.comparePin(pin);
    if (!pinMatch) {
      return res.status(400).json({ message: 'Invalid PIN' });
    }

    const plan = DATA_PLANS[provider]?.find(p => p.id === planId);
    if (!plan) {
      return res.status(400).json({ message: 'Invalid data plan' });
    }

    if (user.balances.NGN < plan.amount) {
      return res.status(400).json({ message: 'Insufficient NGN balance' });
    }

    const reference = `DATA-${Date.now()}`;
    const providerName = PROVIDERS.data.find(p => p.id === provider)?.name || provider;

    // Try VTpass first, fallback to mock if not configured
    if (!vtpassService.isConfigured) {
      return res.status(503).json({ message: 'Bill payment service is not configured' });
    }

    const auth = await vtpassService.getAuthToken();
    if (!auth.success) {
      return res.status(502).json({ message: auth.error || 'Unable to authenticate bill payment service' });
    }

    const vtpassResult = await vtpassService.buyData({
      phone: phoneNumber,
      amount: plan.amount,
      network: provider,
      variationCode: planId,
      token: auth.token
    });
    if (!vtpassResult.success) {
      return res.status(502).json({ message: vtpassResult.error || 'Data provider request failed' });
    }

    const { user: updatedUser, transaction } = await completeBillPayment({
      userId: req.userId,
      amount: plan.amount,
      reference,
      type: 'data',
      description: `${plan.name} ${providerName} data for ${phoneNumber}`,
      metadata: {
        provider,
        phoneNumber,
        plan,
        billType: 'data',
        vtpassResponse: vtpassResult
      }
    });

    await createBillNotification({
      user: updatedUser,
      transaction,
      amount: plan.amount,
      detail: `${plan.name} ${providerName} data for ${phoneNumber}`
    });

    res.json({
      success: true,
      message: 'Data purchase successful',
      reference,
      newBalance: updatedUser.balances.NGN,
      details: {
        provider: providerName,
        phoneNumber,
        plan: plan.name,
        validity: plan.validity,
        amount: plan.amount
      }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// Pay Electricity Bill
router.post('/electricity', authMiddleware, requireVerifiedKycForTransactions, [
  body('provider').notEmpty(),
  body('meterNumber').notEmpty(),
  body('meterType').isIn(['prepaid', 'postpaid']),
  body('amount').isFloat({ min: 500, max: 500000 }),
  body('pin').isLength({ min: 4, max: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { provider, meterNumber, meterType, amount, pin } = req.body;
    const user = await User.findById(req.userId);

    const pinMatch = await user.comparePin(pin);
    if (!pinMatch) {
      return res.status(400).json({ message: 'Invalid PIN' });
    }

    if (user.balances.NGN < amount) {
      return res.status(400).json({ message: 'Insufficient NGN balance' });
    }

    const reference = `ELEC-${Date.now()}`;
    const providerName = PROVIDERS.electricity.find(p => p.id === provider)?.name || provider;
    const vtpassServiceId = ELECTRICITY_SERVICE_IDS[provider];

    if (!vtpassService.isConfigured) {
      return res.status(503).json({ message: 'Bill payment service is not configured' });
    }
    if (!vtpassServiceId) {
      return res.status(400).json({ message: 'Unsupported electricity provider' });
    }

    const auth = await vtpassService.getAuthToken();
    if (!auth.success) {
      return res.status(502).json({ message: auth.error || 'Unable to authenticate bill payment service' });
    }

    const vtpassResult = await vtpassService.payElectricity({
      disco: vtpassServiceId,
      meterNumber,
      amount,
      phone: user.phone,
      token: auth.token
    });
    if (!vtpassResult.success) {
      return res.status(502).json({ message: vtpassResult.error || 'Electricity provider request failed' });
    }

    // Generate token for prepaid meters
    const token = meterType === 'prepaid' 
      ? Array(20).fill(0).map(() => Math.floor(Math.random() * 10)).join('')
      : null;

    const { user: updatedUser, transaction } = await completeBillPayment({
      userId: req.userId,
      amount,
      reference,
      type: 'electricity',
      description: `${providerName} ${meterType} payment`,
      metadata: { provider, meterNumber, meterType, token, billType: 'electricity', vtpassResponse: vtpassResult }
    });

    await createBillNotification({
      user: updatedUser,
      transaction,
      amount,
      detail: `${providerName} ${meterType} electricity bill`
    });

    res.json({
      success: true,
      message: 'Electricity payment successful',
      reference,
      newBalance: updatedUser.balances.NGN,
      details: {
        provider: providerName,
        meterNumber,
        meterType,
        amount,
        token
      }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// Pay Cable TV
router.post('/cable', authMiddleware, requireVerifiedKycForTransactions, [
  body('provider').notEmpty(),
  body('smartCardNumber').notEmpty(),
  body('packageId').notEmpty(),
  body('pin').isLength({ min: 4, max: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { provider, smartCardNumber, packageId, pin } = req.body;
    const user = await User.findById(req.userId);

    const pinMatch = await user.comparePin(pin);
    if (!pinMatch) {
      return res.status(400).json({ message: 'Invalid PIN' });
    }

    const package_ = CABLE_PACKAGES[provider]?.find(p => p.id === packageId);
    if (!package_) {
      return res.status(400).json({ message: 'Invalid package' });
    }

    if (user.balances.NGN < package_.amount) {
      return res.status(400).json({ message: 'Insufficient NGN balance' });
    }

    const reference = `CABLE-${Date.now()}`;
    const providerName = PROVIDERS.cable.find(p => p.id === provider)?.name || provider;

    if (!vtpassService.isConfigured) {
      return res.status(503).json({ message: 'Bill payment service is not configured' });
    }

    const auth = await vtpassService.getAuthToken();
    if (!auth.success) {
      return res.status(502).json({ message: auth.error || 'Unable to authenticate bill payment service' });
    }

    const vtpassResult = await vtpassService.payCableTv({
      service: provider,
      smartCardNumber,
      amount: package_.amount,
      variationCode: packageId,
      phone: user.phone,
      token: auth.token
    });
    if (!vtpassResult.success) {
      return res.status(502).json({ message: vtpassResult.error || 'Cable provider request failed' });
    }

    const { user: updatedUser, transaction } = await completeBillPayment({
      userId: req.userId,
      amount: package_.amount,
      reference,
      type: 'cable',
      description: `${providerName} ${package_.name} subscription`,
      metadata: { provider, smartCardNumber, package: package_, billType: 'cable', vtpassResponse: vtpassResult }
    });

    await createBillNotification({
      user: updatedUser,
      transaction,
      amount: package_.amount,
      detail: `${providerName} ${package_.name} subscription`
    });

    res.json({
      success: true,
      message: 'Cable TV subscription successful',
      reference,
      newBalance: updatedUser.balances.NGN,
      details: {
        provider: providerName,
        smartCardNumber,
        package: package_.name,
        amount: package_.amount
      }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// Betting Deposit
router.post('/betting', authMiddleware, requireVerifiedKycForTransactions, [
  body('provider').notEmpty(),
  body('accountId').notEmpty(),
  body('amount').isFloat({ min: 100, max: 1000000 }),
  body('pin').isLength({ min: 4, max: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { provider, accountId, amount, pin } = req.body;
    const user = await User.findById(req.userId);

    const pinMatch = await user.comparePin(pin);
    if (!pinMatch) {
      return res.status(400).json({ message: 'Invalid PIN' });
    }

    if (user.balances.NGN < amount) {
      return res.status(400).json({ message: 'Insufficient NGN balance' });
    }

    const reference = `BET-${Date.now()}`;
    const providerName = PROVIDERS.betting.find(p => p.id === provider)?.name || provider;

    const { user: updatedUser, transaction } = await completeBillPayment({
      userId: req.userId,
      amount,
      reference,
      type: 'betting',
      description: `${providerName} deposit`,
      metadata: { provider, accountId, billType: 'betting' }
    });

    await createBillNotification({
      user: updatedUser,
      transaction,
      amount,
      detail: `${providerName} betting deposit`
    });

    res.json({
      success: true,
      message: 'Betting deposit successful',
      reference,
      newBalance: updatedUser.balances.NGN,
      details: {
        provider: providerName,
        accountId,
        amount
      }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// Manual gift card trade rates
router.get('/giftcard-rates', authMiddleware, async (req, res) => {
  try {
    const config = await getGiftCardConfig();
    res.json({
      success: true,
      disclaimer: config.disclaimer,
      supportedCards: config.supportedCards
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// Submit gift card trade
router.post('/giftcard-trade', authMiddleware, requireVerifiedKycForTransactions, [
  body('brand').notEmpty(),
  body('country').notEmpty(),
  body('currency').notEmpty(),
  body('cardValue').isFloat({ min: 1 }),
  body('cardType').isIn(['physical', 'e_code']),
  body('submissionMethod').isIn(['images', 'code']),
  body('frontImageUrl').optional({ nullable: true }).isString(),
  body('backImageUrl').optional({ nullable: true }).isString(),
  body('cardCode').optional({ nullable: true }).isString(),
  body('tradeCodePin').optional({ nullable: true }).isString(),
  body('note').optional({ nullable: true }).isString(),
  body('pin').isLength({ min: 4, max: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      brand,
      country,
      currency,
      cardValue,
      cardType,
      submissionMethod,
      frontImageUrl,
      backImageUrl,
      cardCode,
      tradeCodePin,
      note,
      pin
    } = req.body;
    const user = await User.findById(req.userId);

    const pinMatch = await user.comparePin(pin);
    if (!pinMatch) {
      return res.status(400).json({ message: 'Invalid PIN' });
    }

    if (submissionMethod === 'images' && (!frontImageUrl || !backImageUrl)) {
      return res.status(400).json({ message: 'Front and back image URLs are required for image submissions' });
    }
    if (submissionMethod === 'code' && !cardCode) {
      return res.status(400).json({ message: 'Gift card code is required for code submissions' });
    }

    const config = await getGiftCardConfig();
    const supportedCard = findSupportedCard(config, { brand, country, currency });
    if (!supportedCard) {
      return res.status(400).json({ message: 'This gift card combination is not supported yet' });
    }

    if (!supportedCard.supportedCardTypes.includes(cardType)) {
      return res.status(400).json({ message: 'Selected card type is not supported for this gift card' });
    }

    const ratePerUnit = Number(supportedCard.rate);
    const estimatedPayout = Number((Number(cardValue) * ratePerUnit).toFixed(2));
    const reference = `GCTR-${Date.now()}`;

    const trade = await GiftCardTrade.create({
      userId: req.userId,
      brand,
      country,
      currency: String(currency).toUpperCase(),
      cardValue: Number(cardValue),
      cardType,
      submissionMethod,
      frontImageUrl: frontImageUrl || null,
      backImageUrl: backImageUrl || null,
      cardCode: cardCode || null,
      tradeCodePin: tradeCodePin || null,
      note: note || null,
      ratePerUnit,
      estimatedPayout,
      reference
    });

    await createNotification({
      user,
      type: 'system',
      title: 'Gift card trade submitted',
      body: `Your ${brand} ${currency} ${cardValue} gift card trade is pending review.`,
      data: {
        giftCardTradeId: trade._id,
        reference,
        estimatedPayout
      },
      sendEmail: true
    });

    res.json({
      success: true,
      message: 'Gift card trade submitted successfully',
      reference,
      status: trade.status,
      details: {
        brand,
        country,
        currency: String(currency).toUpperCase(),
        cardValue: Number(cardValue),
        ratePerUnit,
        estimatedPayout,
        disclaimer: config.disclaimer
      }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

router.get('/giftcard-trades', authMiddleware, async (req, res) => {
  try {
    const trades = await GiftCardTrade.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, trades });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

// Get bill payment history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, type } = req.query;
    const query = { userId: req.userId };

    if (type) {
      query.type = type;
    } else {
      query.type = { $in: ['airtime', 'data', 'electricity', 'cable', 'betting', 'giftcard'] };
    }

    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Transaction.countDocuments(query);

    res.json({
      success: true,
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error' });
  }
});

module.exports = router;
