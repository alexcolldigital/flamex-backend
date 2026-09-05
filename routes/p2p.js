const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const { authMiddleware, requireTransactionPinSet } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const P2POffer = require('../models/P2POffer');
const P2POrder = require('../models/P2POrder');
const P2PDispute = require('../models/P2PDispute');
const { createLedgerEntry } = require('../services/platformLedger');
const { getPlatformSettings } = require('../utils/admin');
const {
  normalizeAsset,
  ensureSupportedAsset,
  ensureSupportedPaymentMethod,
  lockFunds,
  unlockFunds,
  releaseLockedFunds,
  buildParticipant,
  getDefaultBankAccount,
  isP2PAdmin,
  getAvailableBalance
} = require('../utils/p2p');
const { requireVerifiedKycForTransactions } = require('../middleware/kyc');
const { AppError, handleError, asyncHandler } = require('../utils/errorHandler');
const { withTransaction } = require('../utils/database');
const { createNotification } = require('../services/notifications');
const Logger = require('../utils/logger');

const P2P_RELEASE_WINDOW_MINUTES = Number(process.env.P2P_RELEASE_WINDOW_MINUTES || 10);
const P2P_KYC_NGN_LIMITS = {
  0: 50000,
  1: 500000,
  2: Number.MAX_SAFE_INTEGER,
  3: Number.MAX_SAFE_INTEGER
};

const toOfferPayload = (offer, viewerId = null) => {
  const isMine = viewerId ? String(offer.creatorId?._id || offer.creatorId) === String(viewerId) : false;
  return {
  id: offer._id,
  creatorId: offer.creatorId?._id || offer.creatorId,
  creator: offer.creatorId
    ? {
        username: offer.creatorId.username || null,
        firstName: offer.creatorId.firstName || null,
        lastName: offer.creatorId.lastName || null
      }
    : null,
  side: offer.side,
  asset: offer.asset,
  fiatCurrency: offer.fiatCurrency,
  price: offer.price,
  availableAmount: offer.availableAmount,
  minOrderAmount: offer.minOrderAmount,
  maxOrderAmount: offer.maxOrderAmount,
  paymentWindowMinutes: offer.paymentWindowMinutes,
  paymentMethod: offer.paymentMethod,
  paymentMethods: offer.paymentMethods || [offer.paymentMethod || 'bank_transfer'],
  paymentDetails: isMine ? offer.paymentDetails : null,
  region: offer.region || 'NG',
  merchantOnly: Boolean(offer.merchantOnly),
  merchant: offer.creatorId
    ? {
        isMerchant: Boolean(offer.creatorId.p2pProfile?.isMerchant),
        completionRate: Number(offer.creatorId.p2pProfile?.completionRate || 0),
        totalTrades: Number(offer.creatorId.p2pProfile?.totalTrades || 0),
        completedTrades: Number(offer.creatorId.p2pProfile?.completedTrades || 0),
        totalVolumeNgn: Number(offer.creatorId.p2pProfile?.totalVolumeNgn || 0)
      }
    : null,
  terms: offer.terms,
  status: offer.status,
  isMine,
  createdAt: offer.createdAt,
  updatedAt: offer.updatedAt
  };
};

const toOrderPayload = (order, viewerId = null, dispute = null) => {
  const me = viewerId ? String(viewerId) : null;
  return {
    id: order._id,
    reference: order.reference,
    offerId: order.offerId?._id || order.offerId,
    asset: order.asset,
    fiatCurrency: order.fiatCurrency,
    price: order.price,
    cryptoAmount: order.cryptoAmount,
    fiatAmount: order.fiatAmount,
    total: order.fiatAmount,
    buyer: order.buyer,
    seller: order.seller,
    escrow: {
      sellerUserId: order.escrowUserId,
      lockedAt: order.escrowLockedAt,
      status: ['completed', 'cancelled', 'expired'].includes(order.status) ? 'released_or_unlocked' : 'locked'
    },
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentMethods: order.paymentMethods || [order.paymentMethod || 'bank_transfer'],
    paymentSnapshot: order.paymentSnapshot,
    paymentProofNote: order.paymentProofNote,
    paymentProofUrl: order.paymentProofUrl,
    paymentMarkedAt: order.paymentMarkedAt,
    paymentConfirmedAt: order.paymentConfirmedAt,
    paymentDeadlineAt: order.paymentDeadlineAt,
    releaseDeadlineAt: order.releaseDeadlineAt,
    releaseNote: order.releaseNote,
    releasedAt: order.releasedAt,
    expiresAt: order.expiresAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cryptoFeeAmount: order.cryptoFeeAmount || 0,
    cryptoReleaseAmount: order.cryptoReleaseAmount || order.cryptoAmount,
    fiatFeeAmount: order.fiatFeeAmount || 0,
    chat: order.messages || [],
    isBuyer: me === String(order.buyer?.userId || ''),
    isSeller: me === String(order.seller?.userId || ''),
    dispute: dispute
      ? {
          id: dispute._id,
          status: dispute.status,
          reason: dispute.reason,
          evidence: dispute.evidence,
          messages: dispute.messages,
          resolution: dispute.resolution,
          createdAt: dispute.createdAt,
          updatedAt: dispute.updatedAt
        }
      : null
  };
};

function getTierLimitNgn(user) {
  const level = Number(user?.kycLevel || 0);
  return P2P_KYC_NGN_LIMITS[level] || P2P_KYC_NGN_LIMITS[0];
}

function updateP2PProfileStats(user, updates = {}) {
  if (!user.p2pProfile) {
    user.p2pProfile = {};
  }

  const current = user.p2pProfile;
  current.totalTrades = Number(current.totalTrades || 0) + Number(updates.totalTrades || 0);
  current.completedTrades = Number(current.completedTrades || 0) + Number(updates.completedTrades || 0);
  current.cancelledTrades = Number(current.cancelledTrades || 0) + Number(updates.cancelledTrades || 0);
  current.disputedTrades = Number(current.disputedTrades || 0) + Number(updates.disputedTrades || 0);
  current.totalVolumeNgn = Number(current.totalVolumeNgn || 0) + Number(updates.totalVolumeNgn || 0);

  if (updates.averageReleaseMinutes !== undefined && updates.averageReleaseMinutes !== null) {
    const previousCompleted = Math.max(0, Number(current.completedTrades || 0) - Number(updates.completedTrades || 0));
    const previousAverage = Number(current.averageReleaseMinutes || 0);
    const previousWeighted = previousCompleted * previousAverage;
    const nextCompleted = Number(current.completedTrades || 0);
    current.averageReleaseMinutes = nextCompleted > 0
      ? Number(((previousWeighted + Number(updates.averageReleaseMinutes)) / nextCompleted).toFixed(2))
      : 0;
  }

  current.completionRate = Number(current.totalTrades || 0) > 0
    ? Number(((Number(current.completedTrades || 0) / Number(current.totalTrades || 0)) * 100).toFixed(2))
    : 0;
  current.lastTradeAt = new Date();
}

function appendOrderMessage(order, senderUserId, senderLabel, message) {
  if (!message) {
    return;
  }

  order.messages.push({
    senderUserId,
    senderLabel,
    message
  });
}

async function expireOrderAndUnlockEscrow(order, session = null) {
  if (!order || !['awaiting_payment', 'awaiting_release'].includes(order.status)) {
    return order;
  }

  const now = new Date();
  const deadline =
    order.status === 'awaiting_payment'
      ? order.paymentDeadlineAt || order.expiresAt
      : order.releaseDeadlineAt || order.expiresAt;

  if (!deadline || now <= new Date(deadline)) {
    return order;
  }

  const previousStatus = order.status;
  const [offer, seller] = await Promise.all([
    P2POffer.findById(order.offerId).session(session),
    User.findById(order.seller.userId).session(session)
  ]);

  unlockFunds(seller, order.asset, order.cryptoAmount);
  order.status = 'expired';
  order.cancelReason = previousStatus === 'awaiting_payment'
    ? 'Buyer did not complete payment within the trade window'
    : 'Seller did not release escrow within the release window';
  appendOrderMessage(order, order.seller.userId, 'System', order.cancelReason);
  order.updatedAt = now;

  if (offer && offer.status !== 'cancelled') {
    offer.availableAmount = Number(offer.availableAmount || 0) + Number(order.cryptoAmount || 0);
    if (offer.status === 'completed') {
      offer.status = 'open';
    }
    offer.updatedAt = now;
    await offer.save({ session });
  }

  updateP2PProfileStats(seller, { totalTrades: 1, cancelledTrades: 1 });
  await Promise.all([
    seller.save({ session }),
    order.save({ session })
  ]);

  return order;
}

function hasValidRequest(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return false;
  }
  return true;
}

async function getViewer(req) {
  return User.findById(req.userId);
}

async function getOrderForUser(orderId, userId) {
  const order = await P2POrder.findOne({
    _id: orderId,
    $or: [{ 'buyer.userId': userId }, { 'seller.userId': userId }]
  });
  if (!order) {
    return null;
  }

  await withTransaction(async (session) => {
    const sessionOrder = await P2POrder.findById(order._id).session(session);
    if (sessionOrder) {
      await expireOrderAndUnlockEscrow(sessionOrder, session);
    }
  });

  return P2POrder.findById(order._id);
}

async function applyP2PFeesAndRelease({ order, seller, buyer, adminUserId = null }) {
  const settings = await getPlatformSettings();
  const cryptoFeeRate = Number(settings?.fees?.p2pCryptoFeeRate || 0);
  const ngnFeeRate = Number(settings?.fees?.p2pNgnFeeRate || 0);

  const cryptoFeeAmount = Math.max(0, Number((order.cryptoAmount * cryptoFeeRate).toFixed(8)));
  const cryptoReleaseAmount = Math.max(0, Number((order.cryptoAmount - cryptoFeeAmount).toFixed(8)));
  const fiatFeeAmount = Math.max(0, Number((order.fiatAmount * ngnFeeRate).toFixed(2)));

  releaseLockedFunds(seller, buyer, order.asset, cryptoReleaseAmount);
  if (cryptoFeeAmount > 0) {
    if ((Number(seller.lockedBalances?.[order.asset] || 0)) < cryptoFeeAmount) {
      throw new Error(`Insufficient locked ${order.asset} balance for platform fee`);
    }
    seller.lockedBalances[order.asset] = Number((Number(seller.lockedBalances[order.asset]) - cryptoFeeAmount).toFixed(8));
  }

  order.cryptoFeeAmount = cryptoFeeAmount;
  order.cryptoReleaseAmount = cryptoReleaseAmount;
  order.fiatFeeAmount = fiatFeeAmount;

  const entries = [];
  if (cryptoFeeAmount > 0) {
    entries.push(createLedgerEntry({
      category: 'p2p_crypto_fee',
      direction: 'credit',
      asset: order.asset,
      amount: cryptoFeeAmount,
      reference: `${order.reference}-CRYPTO-FEE`,
      sourceType: 'p2p_order',
      sourceId: order._id,
      createdByUserId: adminUserId,
      metadata: {
        orderReference: order.reference,
        sellerUserId: seller._id,
        buyerUserId: buyer._id
      }
    }));
  }

  if (fiatFeeAmount > 0) {
    entries.push(createLedgerEntry({
      category: 'p2p_ngn_fee',
      direction: 'credit',
      asset: order.fiatCurrency,
      amount: fiatFeeAmount,
      reference: `${order.reference}-NGN-FEE`,
      sourceType: 'p2p_order',
      sourceId: order._id,
      createdByUserId: adminUserId,
      metadata: {
        orderReference: order.reference,
        note: 'Recorded as platform fiat commission for completed P2P order'
      }
    }));
  }

  if (entries.length) {
    await Promise.all(entries);
  }
}

router.get(
  '/offers',
  authMiddleware,
  requireVerifiedKycForTransactions,
  [
    query('side').optional().isIn(['buy', 'sell']),
    query('asset').optional().isString(),
    query('status').optional().isIn(['open', 'paused', 'completed', 'cancelled']),
    query('paymentMethod').optional().isString(),
    query('region').optional().isString(),
    query('minFiatAmount').optional().isFloat({ min: 0 }),
    query('maxFiatAmount').optional().isFloat({ min: 0 })
  ],
  async (req, res) => {
    try {
      if (!hasValidRequest(req, res)) return;

      const filters = { status: req.query.status || 'open' };
      if (req.query.side) filters.side = req.query.side;
      if (req.query.asset) filters.asset = normalizeAsset(req.query.asset);
      if (req.query.region) filters.region = String(req.query.region).trim().toUpperCase();
      if (req.query.paymentMethod) filters.paymentMethods = String(req.query.paymentMethod).trim();

      if (req.query.minFiatAmount || req.query.maxFiatAmount) {
        filters.$expr = { $and: [] };
        if (req.query.minFiatAmount) {
          filters.$expr.$and.push({
            $gte: [{ $multiply: ['$maxOrderAmount', '$price'] }, Number(req.query.minFiatAmount)]
          });
        }
        if (req.query.maxFiatAmount) {
          filters.$expr.$and.push({
            $lte: [{ $multiply: ['$minOrderAmount', '$price'] }, Number(req.query.maxFiatAmount)]
          });
        }
        if (!filters.$expr.$and.length) {
          delete filters.$expr;
        }
      }

      const offers = await P2POffer.find(filters)
        .populate('creatorId', 'username firstName lastName p2pProfile')
        .sort({ createdAt: -1 })
        .limit(100);

      res.json({ offers: offers.map((offer) => toOfferPayload(offer, req.userId)) });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.get('/offers/mine', authMiddleware, async (req, res) => {
  try {
    const offers = await P2POffer.find({ creatorId: req.userId })
      .populate('creatorId', 'username firstName lastName p2pProfile')
      .sort({ createdAt: -1 });
    res.json({ offers: offers.map((offer) => toOfferPayload(offer, req.userId)) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post(
  '/offers',
  authMiddleware,
  requireVerifiedKycForTransactions,
  [
    body('side').isIn(['buy', 'sell']),
    body('asset').custom((value) => ensureSupportedAsset(value)),
    body('price').isFloat({ min: 0.0001 }),
    body('availableAmount').isFloat({ min: 0.000001 }),
    body('minOrderAmount').isFloat({ min: 0.000001 }),
    body('maxOrderAmount').isFloat({ min: 0.000001 }),
    body('paymentWindowMinutes').optional().isInt({ min: 5, max: 180 }),
    body('paymentMethod').optional().isString(),
    body('paymentMethods').optional().isArray({ min: 1 }),
    body('paymentDetails').optional().isObject(),
    body('merchantOnly').optional().isBoolean(),
    body('region').optional().isString(),
    body('terms').optional().isString()
  ],
  async (req, res) => {
    try {
      if (!hasValidRequest(req, res)) return;

      const creator = await getViewer(req);
      const asset = normalizeAsset(req.body.asset);
      const availableAmount = Number(req.body.availableAmount);
      const minOrderAmount = Number(req.body.minOrderAmount);
      const maxOrderAmount = Number(req.body.maxOrderAmount);
      const fiatValueAtMax = Number((maxOrderAmount * Number(req.body.price)).toFixed(2));
      const kycLimitNgn = getTierLimitNgn(creator);
      const paymentMethods = Array.isArray(req.body.paymentMethods) && req.body.paymentMethods.length
        ? req.body.paymentMethods.map((method) => String(method).trim().toLowerCase())
        : [String(req.body.paymentMethod || 'bank_transfer').trim().toLowerCase()];

      if (paymentMethods.some((method) => !ensureSupportedPaymentMethod(method))) {
        return res.status(400).json({ message: 'Unsupported payment method' });
      }

      if (minOrderAmount > maxOrderAmount) {
        return res.status(400).json({ message: 'Minimum order amount cannot exceed maximum order amount' });
      }

      if (availableAmount < minOrderAmount) {
        return res.status(400).json({ message: 'Available amount must cover the minimum order amount' });
      }

      if (fiatValueAtMax > kycLimitNgn) {
        return res.status(400).json({ message: `Your KYC tier allows a maximum P2P order value of NGN ${kycLimitNgn.toLocaleString()}` });
      }

      if (req.body.merchantOnly && creator?.p2pProfile?.merchantStatus !== 'approved') {
        return res.status(400).json({ message: 'Only approved merchants can create merchant-only offers' });
      }

      if (req.body.side === 'sell' && getAvailableBalance(creator, asset) < availableAmount) {
        return res.status(400).json({ message: `Insufficient ${asset} balance to create this sell offer` });
      }

      if (req.body.side === 'sell' && !req.body.paymentDetails?.accountNumber && !getDefaultBankAccount(creator)) {
        return res.status(400).json({ message: 'Add a bank account or provide payment details before creating a sell offer' });
      }

      const offer = new P2POffer({
        creatorId: creator._id,
        side: req.body.side,
        asset,
        fiatCurrency: 'NGN',
        region: String(req.body.region || creator?.p2pProfile?.region || 'NG').trim().toUpperCase(),
        price: Number(req.body.price),
        availableAmount,
        minOrderAmount,
        maxOrderAmount,
        paymentWindowMinutes: Number(req.body.paymentWindowMinutes || 30),
        paymentMethod: paymentMethods[0],
        paymentMethods,
        paymentDetails: req.body.paymentDetails || {},
        merchantOnly: Boolean(req.body.merchantOnly),
        terms: req.body.terms || ''
      });

      await offer.save();
      res.status(201).json({ message: 'Offer created', offer: toOfferPayload(offer, req.userId) });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.patch(
  '/offers/:offerId',
  authMiddleware,
  [
    param('offerId').isMongoId(),
    body('status').optional().isIn(['open', 'paused', 'completed', 'cancelled']),
    body('price').optional().isFloat({ min: 0.0001 }),
    body('minOrderAmount').optional().isFloat({ min: 0.000001 }),
    body('maxOrderAmount').optional().isFloat({ min: 0.000001 }),
    body('paymentMethods').optional().isArray({ min: 1 }),
    body('paymentDetails').optional().isObject(),
    body('merchantOnly').optional().isBoolean(),
    body('region').optional().isString(),
    body('terms').optional().isString()
  ],
  async (req, res) => {
    try {
      if (!hasValidRequest(req, res)) return;

      const offer = await P2POffer.findOne({ _id: req.params.offerId, creatorId: req.userId });
      if (!offer) {
        return res.status(404).json({ message: 'Offer not found' });
      }

      ['status', 'terms', 'paymentMethod'].forEach((field) => {
        if (req.body[field] !== undefined) {
          offer[field] = req.body[field];
        }
      });

      ['price', 'minOrderAmount', 'maxOrderAmount'].forEach((field) => {
        if (req.body[field] !== undefined) {
          offer[field] = Number(req.body[field]);
        }
      });

      if (req.body.paymentDetails) {
        offer.paymentDetails = req.body.paymentDetails;
      }

      if (req.body.paymentMethods) {
        const paymentMethods = req.body.paymentMethods.map((method) => String(method).trim().toLowerCase());
        if (paymentMethods.some((method) => !ensureSupportedPaymentMethod(method))) {
          return res.status(400).json({ message: 'Unsupported payment method' });
        }
        offer.paymentMethods = paymentMethods;
        offer.paymentMethod = paymentMethods[0];
      }

      if (req.body.region !== undefined) {
        offer.region = String(req.body.region || 'NG').trim().toUpperCase();
      }

      if (req.body.merchantOnly !== undefined) {
        if (Boolean(req.body.merchantOnly) && req.body.merchantOnly !== offer.merchantOnly) {
          const owner = await getViewer(req);
          if (owner?.p2pProfile?.merchantStatus !== 'approved') {
            return res.status(400).json({ message: 'Only approved merchants can mark an offer as merchant-only' });
          }
        }
        offer.merchantOnly = Boolean(req.body.merchantOnly);
      }

      offer.updatedAt = new Date();
      await offer.save();
      res.json({ message: 'Offer updated', offer: toOfferPayload(offer, req.userId) });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.post(
  '/offers/:offerId/order',
  authMiddleware,
  requireTransactionPinSet,
  requireVerifiedKycForTransactions,
  [
    param('offerId').isMongoId(),
    body('cryptoAmount').isFloat({ min: 0.000001 }),
    body('paymentMethod').optional().isString(),
    body('pin').isLength({ min: 4, max: 4 }).isNumeric()
  ],
  asyncHandler(async (req, res) => {
    const logger = new Logger('p2p/take-offer');
    
    if (!hasValidRequest(req, res)) return;

    const offer = await P2POffer.findById(req.params.offerId);
    if (!offer || offer.status !== 'open') {
      throw new AppError('Offer not available', 404);
    }

    if (String(offer.creatorId) === String(req.userId)) {
      throw new AppError('You cannot take your own offer', 400);
    }

    const cryptoAmount = Number(req.body.cryptoAmount);
    if (cryptoAmount < offer.minOrderAmount || cryptoAmount > offer.maxOrderAmount) {
      throw new AppError('Order amount is outside this offer range', 400);
    }

    if (cryptoAmount > offer.availableAmount) {
      throw new AppError('Offer does not have enough available liquidity', 400);
    }

    const [maker, taker] = await Promise.all([User.findById(offer.creatorId), User.findById(req.userId)]);
    const takerPinValid = await taker?.comparePin(req.body.pin);
    if (!takerPinValid) {
      throw new AppError('Invalid PIN', 400);
    }
    const seller = offer.side === 'sell' ? maker : taker;
    const buyer = offer.side === 'sell' ? taker : maker;
    const fiatAmount = Number((cryptoAmount * offer.price).toFixed(2));
    const buyerLimitNgn = getTierLimitNgn(buyer);
    const sellerLimitNgn = getTierLimitNgn(seller);

      if (fiatAmount > buyerLimitNgn || fiatAmount > sellerLimitNgn) {
        throw new AppError('This trade exceeds the P2P limit for one of the participants', 400);
      }

      if (offer.side === 'buy' && !getDefaultBankAccount(seller)) {
        throw new AppError('Add a bank account before selling into a buy offer', 400);
      }

      const selectedPaymentMethod = String(
        req.body.paymentMethod || offer.paymentMethod || (offer.paymentMethods || [])[0] || 'bank_transfer'
      )
        .trim()
        .toLowerCase();
      const supportedMethods = (offer.paymentMethods || [offer.paymentMethod || 'bank_transfer']).map((method) =>
        String(method).trim().toLowerCase()
      );
      if (!supportedMethods.includes(selectedPaymentMethod)) {
        throw new AppError('Selected payment method is not supported by this offer', 400);
      }

      const sellerAvailableBalance = getAvailableBalance(seller, offer.asset);

      if (sellerAvailableBalance < cryptoAmount) {
        throw new AppError(
          `Insufficient available ${offer.asset} balance. Available: ${sellerAvailableBalance}, Required: ${cryptoAmount}`,
          400
        );
      }

      return withTransaction(async (session) => {
        const sessionOffer = await P2POffer.findById(offer._id).session(session);
        const sessionSeller = await User.findById(seller._id).session(session);

        if (!sessionOffer || sessionOffer.status !== 'open') {
          throw new AppError('Offer not available', 404);
        }

        if (Number(sessionOffer.availableAmount || 0) < cryptoAmount) {
          throw new AppError('Offer does not have enough available liquidity', 400);
        }

        if (getAvailableBalance(sessionSeller, sessionOffer.asset) < cryptoAmount) {
          throw new AppError(`Insufficient available ${sessionOffer.asset} balance for escrow`, 400);
        }

        lockFunds(sessionSeller, sessionOffer.asset, cryptoAmount);

        sessionOffer.availableAmount = Math.max(0, Number(sessionOffer.availableAmount) - cryptoAmount);
        if (sessionOffer.availableAmount === 0) {
          sessionOffer.status = 'completed';
        }
        sessionOffer.updatedAt = new Date();

        const sellerBankAccount = getDefaultBankAccount(seller);
        const offerPaymentDetails = sessionOffer.paymentDetails || {};
        const paymentSnapshot = sessionOffer.side === 'sell'
          ? {
              bankName: offerPaymentDetails.bankName || sellerBankAccount?.bankName || null,
              bankCode: offerPaymentDetails.bankCode || sellerBankAccount?.bankCode || null,
              accountNumber: offerPaymentDetails.accountNumber || sellerBankAccount?.accountNumber || null,
              accountName: offerPaymentDetails.accountName || sellerBankAccount?.accountName || null,
              instructions: offerPaymentDetails.instructions || sessionOffer.terms || null
            }
          : sellerBankAccount;

        const order = new P2POrder({
          offerId: sessionOffer._id,
          offerOwnerId: maker._id,
          takerId: taker._id,
          asset: sessionOffer.asset,
          fiatCurrency: sessionOffer.fiatCurrency,
          price: sessionOffer.price,
          cryptoAmount,
          fiatAmount,
          buyer: buildParticipant(buyer),
          seller: buildParticipant(seller),
          escrowUserId: seller._id,
          paymentMethod: selectedPaymentMethod,
          paymentMethods: sessionOffer.paymentMethods || [sessionOffer.paymentMethod || 'bank_transfer'],
          paymentSnapshot,
          escrowLockedAt: new Date(),
          paymentDeadlineAt: new Date(Date.now() + sessionOffer.paymentWindowMinutes * 60 * 1000),
          expiresAt: new Date(Date.now() + sessionOffer.paymentWindowMinutes * 60 * 1000),
          reference: `P2P-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          messages: []
        });

        appendOrderMessage(
          order,
          req.userId,
          'System',
          `Trade opened for ${cryptoAmount} ${sessionOffer.asset} at ${sessionOffer.price} ${sessionOffer.fiatCurrency}/${sessionOffer.asset}. Seller funds are now locked in escrow.`
        );

        await sessionSeller.save({ session });
        await sessionOffer.save({ session });
        await order.save({ session });

        logger.info(`P2P order created: ${order.reference}, seller: ${seller._id}, buyer: ${buyer._id}, amount: ${cryptoAmount} ${offer.asset}`);

        const buyerMessage = offer.side === 'sell' ? 'buy' : 'sell';
        await createNotification({
          user: buyer,
          type: 'receive',
          title: 'P2P order created',
          body: `You have a pending P2P order to ${buyerMessage} ${cryptoAmount} ${offer.asset}. Complete payment within ${offer.paymentWindowMinutes} minutes.`,
          data: {
            orderId: order._id,
            reference: order.reference,
            amount: cryptoAmount,
            currency: offer.asset
          },
          sendEmail: true
        });

        res.status(201).json({
          success: true,
          message: 'P2P order created and crypto locked in escrow',
          order: toOrderPayload(order, req.userId)
        });
      });
  })
);

router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const rawOrders = await P2POrder.find({
      $or: [{ 'buyer.userId': req.userId }, { 'seller.userId': req.userId }]
    }).sort({ createdAt: -1 });

    for (const order of rawOrders) {
      await withTransaction(async (session) => {
        const sessionOrder = await P2POrder.findById(order._id).session(session);
        if (sessionOrder) {
          await expireOrderAndUnlockEscrow(sessionOrder, session);
        }
      });
    }

    const orders = await P2POrder.find({
      $or: [{ 'buyer.userId': req.userId }, { 'seller.userId': req.userId }]
    }).sort({ createdAt: -1 });

    const disputeIds = orders.map((order) => order.disputeId).filter(Boolean);
    const disputes = disputeIds.length ? await P2PDispute.find({ _id: { $in: disputeIds } }) : [];
    const disputeMap = new Map(disputes.map((dispute) => [String(dispute._id), dispute]));

    res.json({
      orders: orders.map((order) =>
        toOrderPayload(order, req.userId, order.disputeId ? disputeMap.get(String(order.disputeId)) : null)
      )
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/orders/:orderId', authMiddleware, [param('orderId').isMongoId()], async (req, res) => {
  try {
    if (!hasValidRequest(req, res)) return;

    const order = await getOrderForUser(req.params.orderId, req.userId);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const dispute = order.disputeId ? await P2PDispute.findById(order.disputeId) : null;
    res.json({ order: toOrderPayload(order, req.userId, dispute) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post(
  '/orders/:orderId/mark-paid',
  authMiddleware,
  [param('orderId').isMongoId(), body('proofNote').optional().isString(), body('proofUrl').optional().isString()],
  async (req, res) => {
    try {
      if (!hasValidRequest(req, res)) return;

      const order = await getOrderForUser(req.params.orderId, req.userId);
      if (!order) {
        return res.status(404).json({ message: 'Order not found' });
      }
      if (String(order.buyer.userId) !== String(req.userId)) {
        return res.status(403).json({ message: 'Only the buyer can mark payment as sent' });
      }
      if (order.status !== 'awaiting_payment') {
        return res.status(400).json({ message: 'This order is not awaiting payment' });
      }
      if (order.paymentDeadlineAt && new Date() > new Date(order.paymentDeadlineAt)) {
        return res.status(400).json({ message: 'The payment window has expired for this trade' });
      }

      order.status = 'awaiting_release';
      order.paymentProofNote = req.body.proofNote || null;
      order.paymentProofUrl = req.body.proofUrl || null;
      order.paymentMarkedAt = new Date();
      order.releaseDeadlineAt = new Date(Date.now() + P2P_RELEASE_WINDOW_MINUTES * 60 * 1000);
      appendOrderMessage(order, req.userId, 'Buyer', req.body.proofNote || 'Buyer marked this order as paid.');
      order.updatedAt = new Date();
      await order.save();

      res.json({ message: 'Payment marked as sent', order: toOrderPayload(order, req.userId) });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.post(
  '/orders/:orderId/confirm-payment',
  authMiddleware,
  requireTransactionPinSet,
  [param('orderId').isMongoId(), body('releaseNote').optional().isString()],
  asyncHandler(async (req, res) => {
    const logger = new Logger('p2p/confirm-payment');
    
    if (!hasValidRequest(req, res)) return;

    const order = await getOrderForUser(req.params.orderId, req.userId);
    if (!order) {
      throw new AppError('Order not found', 404);
    }

    if (String(order.seller.userId) !== String(req.userId)) {
      throw new AppError('Only the seller can release escrow', 403);
    }

    if (!req.body.pin || !/^\d{4}$/.test(req.body.pin)) {
      throw new AppError('PIN must be exactly 4 digits', 400);
    }
    const sellerForPin = await User.findById(req.userId);
    if (!(await sellerForPin.comparePin(req.body.pin))) {
      throw new AppError('Invalid PIN', 400);
    }

    if (order.releaseDeadlineAt && new Date() > new Date(order.releaseDeadlineAt)) {
      throw new AppError('This order has passed the seller release window', 400);
    }

    if (order.status !== 'awaiting_release') {
      throw new AppError('This order cannot be released', 400);
    }

    return withTransaction(async (session) => {
      const [sessionOrder, seller, buyer] = await Promise.all([
        P2POrder.findById(order._id).session(session),
        User.findById(order.seller.userId).session(session),
        User.findById(order.buyer.userId).session(session)
      ]);

      if (!sessionOrder) {
        throw new AppError('Order not found', 404);
      }
      if (sessionOrder.status !== 'awaiting_release') {
        throw new AppError('This order cannot be released', 400);
      }

      await applyP2PFeesAndRelease({ order: sessionOrder, seller, buyer });

      sessionOrder.status = 'completed';
      sessionOrder.releaseNote = req.body.releaseNote || null;
      sessionOrder.releasedAt = new Date();
      sessionOrder.paymentConfirmedAt = sessionOrder.releasedAt;
      appendOrderMessage(sessionOrder, req.userId, 'Seller', req.body.releaseNote || 'Seller confirmed payment and released escrow.');
      sessionOrder.updatedAt = new Date();

      const releaseMinutes = sessionOrder.paymentMarkedAt
        ? Number(((new Date(sessionOrder.releasedAt) - new Date(sessionOrder.paymentMarkedAt)) / 60000).toFixed(2))
        : null;
      updateP2PProfileStats(seller, {
        totalTrades: 1,
        completedTrades: 1,
        totalVolumeNgn: sessionOrder.fiatAmount,
        averageReleaseMinutes: releaseMinutes
      });
      updateP2PProfileStats(buyer, {
        totalTrades: 1,
        completedTrades: 1,
        totalVolumeNgn: sessionOrder.fiatAmount
      });

      const sellerTx = new Transaction({
        userId: seller._id,
        type: 'p2p_sell',
        amount: sessionOrder.cryptoAmount,
        currency: sessionOrder.asset,
        description: `P2P sale to ${sessionOrder.buyer.fullName || sessionOrder.buyer.username || 'buyer'}`,
        status: 'completed',
        toUserId: buyer._id,
        toUsername: sessionOrder.buyer.username,
        reference: `${sessionOrder.reference}-SELL`,
        metadata: { p2pOrderId: sessionOrder._id, fiatAmount: sessionOrder.fiatAmount, price: sessionOrder.price }
      });

      const buyerTx = new Transaction({
        userId: buyer._id,
        type: 'p2p_buy',
        amount: sessionOrder.cryptoAmount,
        currency: sessionOrder.asset,
        description: `P2P purchase from ${sessionOrder.seller.fullName || sessionOrder.seller.username || 'seller'}`,
        status: 'completed',
        fromUserId: seller._id,
        fromUsername: sessionOrder.seller.username,
        reference: `${sessionOrder.reference}-BUY`,
        metadata: { p2pOrderId: sessionOrder._id, fiatAmount: sessionOrder.fiatAmount, price: sessionOrder.price }
      });

      await Promise.all([
        seller.save({ session }),
        buyer.save({ session }),
        sessionOrder.save({ session }),
        sellerTx.save({ session }),
        buyerTx.save({ session })
      ]);

      logger.info(`P2P order completed: ${sessionOrder.reference}, seller: ${seller._id}, buyer: ${buyer._id}`);

      // Send notifications
      await Promise.all([
        createNotification({
          user: seller,
          type: 'send',
          title: 'P2P sale completed',
          body: `You successfully sold ${sessionOrder.cryptoAmount} ${sessionOrder.asset} to ${sessionOrder.buyer.username}`,
          data: {
            orderId: sessionOrder._id,
            reference: sessionOrder.reference,
            amount: sessionOrder.cryptoAmount,
            feeAmount: sessionOrder.cryptoFeeAmount
          },
          sendEmail: true,
          transaction: sellerTx
        }),
        createNotification({
          user: buyer,
          type: 'receive',
          title: 'P2P purchase completed',
          body: `Your purchase of ${sessionOrder.cryptoAmount} ${sessionOrder.asset} has been completed. Crypto is now available in your wallet.`,
          data: {
            orderId: sessionOrder._id,
            reference: sessionOrder.reference,
            amount: sessionOrder.cryptoAmount
          },
          sendEmail: true,
          transaction: buyerTx
        })
      ]);

      res.json({
        success: true,
        message: 'Escrow released successfully',
        order: toOrderPayload(sessionOrder, req.userId)
      });
    });
  })
);

router.post(
  '/orders/:orderId/cancel',
  authMiddleware,
  [param('orderId').isMongoId(), body('reason').optional().isString()],
  asyncHandler(async (req, res) => {
    const logger = new Logger('p2p/cancel-order');
    
    if (!hasValidRequest(req, res)) return;

    const order = await getOrderForUser(req.params.orderId, req.userId);
    if (!order) {
      throw new AppError('Order not found', 404);
    }

    if (!['awaiting_payment', 'awaiting_release'].includes(order.status)) {
      throw new AppError('This order cannot be cancelled', 400);
    }

    if (order.status === 'awaiting_release' && String(order.seller.userId) !== String(req.userId)) {
      throw new AppError('Seller must review or dispute after payment is marked sent', 400);
    }

    return withTransaction(async (session) => {
      const sessionOrder = await P2POrder.findById(order._id).session(session);
      const offer = await P2POffer.findById(order.offerId).session(session);
      const seller = await User.findById(order.seller.userId).session(session);

      if (!sessionOrder) {
        throw new AppError('Order not found', 404);
      }
      if (!['awaiting_payment', 'awaiting_release'].includes(sessionOrder.status)) {
        throw new AppError('This order cannot be cancelled', 400);
      }

      // Unlock funds
      unlockFunds(seller, sessionOrder.asset, sessionOrder.cryptoAmount);

      // Restore offer availability if not cancelled
      if (offer && offer.status !== 'cancelled') {
        offer.availableAmount = Number(offer.availableAmount) + Number(sessionOrder.cryptoAmount);
        if (offer.status === 'completed') {
          offer.status = 'open';
        }
        offer.updatedAt = new Date();
      }

      sessionOrder.status = 'cancelled';
      sessionOrder.cancelledByUserId = req.userId;
      sessionOrder.cancelReason = req.body.reason || null;
      appendOrderMessage(
        sessionOrder,
        req.userId,
        String(sessionOrder.seller.userId) === String(req.userId) ? 'Seller' : 'Buyer',
        req.body.reason || 'Trade cancelled.'
      );
      sessionOrder.updatedAt = new Date();

      updateP2PProfileStats(seller, { totalTrades: 1, cancelledTrades: 1 });

      await seller.save({ session });
      await sessionOrder.save({ session });
      if (offer) {
        await offer.save({ session });
      }

      logger.info(`P2P order cancelled: ${sessionOrder.reference}, reason: ${req.body.reason || 'unspecified'}`);

      // Send notification to other party
      const otherUserId = String(sessionOrder.buyer.userId) === String(req.userId)
        ? sessionOrder.seller.userId
        : sessionOrder.buyer.userId;
      const otherUser = await User.findById(otherUserId);
      if (otherUser) {
        await createNotification({
          user: otherUser,
          type: 'p2p',
          title: 'P2P order cancelled',
          body: `The P2P order for ${sessionOrder.cryptoAmount} ${sessionOrder.asset} has been cancelled.`,
          data: {
            orderId: sessionOrder._id,
            reference: sessionOrder.reference
          },
          sendEmail: true
        });
      }

      res.json({
        success: true,
        message: 'Order cancelled and escrow returned',
        order: toOrderPayload(sessionOrder, req.userId)
      });
    });
  })
);

router.post(
  '/orders/:orderId/message',
  authMiddleware,
  [param('orderId').isMongoId(), body('message').isLength({ min: 2, max: 1000 })],
  async (req, res) => {
    try {
      if (!hasValidRequest(req, res)) return;

      const order = await getOrderForUser(req.params.orderId, req.userId);
      if (!order) {
        return res.status(404).json({ message: 'Order not found' });
      }

      if (!['awaiting_payment', 'awaiting_release', 'disputed'].includes(order.status)) {
        return res.status(400).json({ message: 'This trade is not open for chat' });
      }

      const senderLabel = String(order.buyer.userId) === String(req.userId) ? 'Buyer' : 'Seller';
      appendOrderMessage(order, req.userId, senderLabel, req.body.message.trim());
      order.updatedAt = new Date();
      await order.save();

      res.json({ message: 'Trade message sent', order: toOrderPayload(order, req.userId) });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.post(
  '/orders/:orderId/dispute',
  authMiddleware,
  [
    param('orderId').isMongoId(),
    body('reason').isLength({ min: 10 }),
    body('evidenceNote').optional().isString(),
    body('evidenceUrl').optional().isString()
  ],
  async (req, res) => {
    try {
      if (!hasValidRequest(req, res)) return;

      const order = await getOrderForUser(req.params.orderId, req.userId);
      if (!order) {
        return res.status(404).json({ message: 'Order not found' });
      }
      if (order.disputeId) {
        return res.status(400).json({ message: 'This order already has a dispute' });
      }
      if (!['awaiting_payment', 'awaiting_release'].includes(order.status)) {
        return res.status(400).json({ message: 'Only active orders can be disputed' });
      }

      const evidence = [];
      if (req.body.evidenceNote || req.body.evidenceUrl) {
        evidence.push({
          note: req.body.evidenceNote || null,
          url: req.body.evidenceUrl || null,
          addedByUserId: req.userId
        });
      }

      const dispute = new P2PDispute({
        orderId: order._id,
        openedByUserId: req.userId,
        reason: req.body.reason,
        evidence,
        messages: [
          {
            senderUserId: req.userId,
            senderLabel: 'Opened dispute',
            message: req.body.reason
          }
        ]
      });

      await dispute.save();
      order.status = 'disputed';
      order.disputeId = dispute._id;
      appendOrderMessage(order, req.userId, 'System', 'Trade moved to dispute review.');
      order.updatedAt = new Date();

      const [buyer, seller] = await Promise.all([
        User.findById(order.buyer.userId),
        User.findById(order.seller.userId)
      ]);
      updateP2PProfileStats(buyer, { disputedTrades: 1 });
      updateP2PProfileStats(seller, { disputedTrades: 1 });

      await Promise.all([buyer.save(), seller.save()]);
      await order.save();

      res.status(201).json({
        message: 'Dispute opened successfully',
        order: toOrderPayload(order, req.userId, dispute)
      });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.get('/disputes', authMiddleware, async (req, res) => {
  try {
    const viewer = await getViewer(req);
    let disputes = [];

    if (isP2PAdmin(viewer) && req.query.scope === 'all') {
      disputes = await P2PDispute.find().sort({ createdAt: -1 }).limit(100);
    } else {
      const orders = await P2POrder.find({
        disputeId: { $ne: null },
        $or: [{ 'buyer.userId': req.userId }, { 'seller.userId': req.userId }]
      })
        .select('disputeId')
        .lean();
      const disputeIds = orders.map((order) => order.disputeId).filter(Boolean);
      disputes = disputeIds.length ? await P2PDispute.find({ _id: { $in: disputeIds } }).sort({ createdAt: -1 }) : [];
    }

    res.json({ disputes, admin: isP2PAdmin(viewer) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post(
  '/disputes/:disputeId/message',
  authMiddleware,
  [param('disputeId').isMongoId(), body('message').isLength({ min: 2 })],
  async (req, res) => {
    try {
      if (!hasValidRequest(req, res)) return;

      const dispute = await P2PDispute.findById(req.params.disputeId);
      if (!dispute) {
        return res.status(404).json({ message: 'Dispute not found' });
      }

      const order = await getOrderForUser(dispute.orderId, req.userId);
      const viewer = await getViewer(req);
      if (!order && !isP2PAdmin(viewer)) {
        return res.status(403).json({ message: 'You cannot access this dispute' });
      }

      dispute.messages.push({
        senderUserId: req.userId,
        senderLabel: isP2PAdmin(viewer) ? 'Admin' : 'Participant',
        message: req.body.message
      });
      dispute.updatedAt = new Date();
      await dispute.save();

      res.json({ message: 'Dispute message sent', dispute });
    } catch (error) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

router.post(
  '/disputes/:disputeId/resolve',
  authMiddleware,
  [
    param('disputeId').isMongoId(),
    body('outcome').isIn(['release_to_buyer', 'refund_to_seller', 'dismissed']),
    body('note').optional().isString()
  ],
  asyncHandler(async (req, res) => {
    try {
      if (!hasValidRequest(req, res)) return;

      const admin = await getViewer(req);
      if (!isP2PAdmin(admin)) {
        return res.status(403).json({ message: 'Admin access required' });
      }

      const dispute = await P2PDispute.findById(req.params.disputeId);
      if (!dispute || dispute.status !== 'open') {
        return res.status(404).json({ message: 'Open dispute not found' });
      }

      const order = await P2POrder.findById(dispute.orderId);
      if (!order) {
        return res.status(404).json({ message: 'Order not found for dispute' });
      }

      await withTransaction(async (session) => {
        const [sessionOrder, sessionDispute, seller, buyer] = await Promise.all([
          P2POrder.findById(order._id).session(session),
          P2PDispute.findById(dispute._id).session(session),
          User.findById(order.seller.userId).session(session),
          User.findById(order.buyer.userId).session(session)
        ]);

        if (!sessionOrder || !sessionDispute || sessionDispute.status !== 'open') {
          throw new AppError('Open dispute not found', 404);
        }

        if (req.body.outcome === 'release_to_buyer') {
          await applyP2PFeesAndRelease({ order: sessionOrder, seller, buyer, adminUserId: admin._id });
          sessionOrder.status = 'completed';
          sessionOrder.releasedAt = new Date();
          appendOrderMessage(sessionOrder, admin._id, 'Admin', req.body.note || 'Admin released escrow to the buyer.');
          updateP2PProfileStats(seller, {
            totalTrades: 1,
            completedTrades: 1,
            totalVolumeNgn: sessionOrder.fiatAmount
          });
          updateP2PProfileStats(buyer, {
            totalTrades: 1,
            completedTrades: 1,
            totalVolumeNgn: sessionOrder.fiatAmount
          });
        } else if (req.body.outcome === 'refund_to_seller') {
          unlockFunds(seller, sessionOrder.asset, sessionOrder.cryptoAmount);
          const offer = await P2POffer.findById(sessionOrder.offerId).session(session);
          if (offer && offer.status !== 'cancelled') {
            offer.availableAmount = Number(offer.availableAmount) + Number(sessionOrder.cryptoAmount);
            if (offer.status === 'completed') {
              offer.status = 'open';
            }
            offer.updatedAt = new Date();
            await offer.save({ session });
          }
          sessionOrder.status = 'cancelled';
          sessionOrder.cancelReason = req.body.note || 'Admin refunded escrow to the seller.';
          appendOrderMessage(sessionOrder, admin._id, 'Admin', sessionOrder.cancelReason);
          updateP2PProfileStats(seller, { totalTrades: 1, cancelledTrades: 1 });
        } else {
          sessionOrder.status = sessionOrder.paymentMarkedAt ? 'awaiting_release' : 'awaiting_payment';
          appendOrderMessage(sessionOrder, admin._id, 'Admin', req.body.note || 'Dispute dismissed. Trade returned to participants.');
        }

        sessionOrder.updatedAt = new Date();
        sessionDispute.status = req.body.outcome === 'dismissed' ? 'dismissed' : 'resolved';
        sessionDispute.resolution = {
          outcome: req.body.outcome,
          note: req.body.note || null,
          resolvedByUserId: admin._id,
          resolvedAt: new Date()
        };
        sessionDispute.updatedAt = new Date();

        await Promise.all([
          seller.save({ session }),
          buyer.save({ session }),
          sessionOrder.save({ session }),
          sessionDispute.save({ session })
        ]);

        res.json({
          message: 'Dispute resolved',
          order: toOrderPayload(sessionOrder, req.userId, sessionDispute),
          dispute: sessionDispute
        });
      });
    } catch (error) {
      res.status(500).json({ message: error.message || 'Server error' });
    }
  })
);

// Global error handler for P2P routes
router.use((err, req, res, next) => {
  handleError(err, req, res, new Logger('p2p'));
});

module.exports = router;
