const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const { authMiddleware } = require('../middleware/auth');
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
  lockFunds,
  unlockFunds,
  releaseLockedFunds,
  buildParticipant,
  getDefaultBankAccount,
  isP2PAdmin
} = require('../utils/p2p');
const { requireVerifiedKycForTransactions } = require('../middleware/kyc');
const { AppError, handleError, asyncHandler } = require('../utils/errorHandler');
const { withTransaction } = require('../utils/database');
const { createNotification } = require('../services/notifications');
const Logger = require('../utils/logger');

const toOfferPayload = (offer, viewerId = null) => ({
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
  paymentDetails: offer.paymentDetails,
  terms: offer.terms,
  status: offer.status,
  isMine: viewerId ? String(offer.creatorId?._id || offer.creatorId) === String(viewerId) : false,
  createdAt: offer.createdAt,
  updatedAt: offer.updatedAt
});

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
    buyer: order.buyer,
    seller: order.seller,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentSnapshot: order.paymentSnapshot,
    paymentProofNote: order.paymentProofNote,
    paymentProofUrl: order.paymentProofUrl,
    paymentMarkedAt: order.paymentMarkedAt,
    releaseNote: order.releaseNote,
    releasedAt: order.releasedAt,
    expiresAt: order.expiresAt,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
  cryptoFeeAmount: order.cryptoFeeAmount || 0,
  cryptoReleaseAmount: order.cryptoReleaseAmount || order.cryptoAmount,
  fiatFeeAmount: order.fiatFeeAmount || 0,
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
  return P2POrder.findOne({
    _id: orderId,
    $or: [{ 'buyer.userId': userId }, { 'seller.userId': userId }]
  });
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
    query('status').optional().isIn(['open', 'paused', 'completed', 'cancelled'])
  ],
  async (req, res) => {
    try {
      if (!hasValidRequest(req, res)) return;

      const filters = { status: req.query.status || 'open' };
      if (req.query.side) filters.side = req.query.side;
      if (req.query.asset) filters.asset = normalizeAsset(req.query.asset);

      const offers = await P2POffer.find(filters)
        .populate('creatorId', 'username firstName lastName')
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
    const offers = await P2POffer.find({ creatorId: req.userId }).sort({ createdAt: -1 });
    res.json({ offers: offers.map((offer) => toOfferPayload(offer, req.userId)) });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post(
  '/offers',
  authMiddleware,
  [
    body('side').isIn(['buy', 'sell']),
    body('asset').custom((value) => ensureSupportedAsset(value)),
    body('price').isFloat({ min: 0.0001 }),
    body('availableAmount').isFloat({ min: 0.000001 }),
    body('minOrderAmount').isFloat({ min: 0.000001 }),
    body('maxOrderAmount').isFloat({ min: 0.000001 }),
    body('paymentWindowMinutes').optional().isInt({ min: 5, max: 180 }),
    body('paymentMethod').optional().isString(),
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

      if (minOrderAmount > maxOrderAmount) {
        return res.status(400).json({ message: 'Minimum order amount cannot exceed maximum order amount' });
      }

      if (availableAmount < minOrderAmount) {
        return res.status(400).json({ message: 'Available amount must cover the minimum order amount' });
      }

      if (req.body.side === 'sell' && Number(creator.balances[asset] || 0) < availableAmount) {
        return res.status(400).json({ message: `Insufficient ${asset} balance to create this sell offer` });
      }

      const offer = new P2POffer({
        creatorId: creator._id,
        side: req.body.side,
        asset,
        fiatCurrency: 'NGN',
        price: Number(req.body.price),
        availableAmount,
        minOrderAmount,
        maxOrderAmount,
        paymentWindowMinutes: Number(req.body.paymentWindowMinutes || 30),
        paymentMethod: req.body.paymentMethod || 'bank_transfer',
        paymentDetails: req.body.paymentDetails || {},
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
  requireVerifiedKycForTransactions,
  [param('offerId').isMongoId(), body('cryptoAmount').isFloat({ min: 0.000001 })],
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
    const seller = offer.side === 'sell' ? maker : taker;
    const buyer = offer.side === 'sell' ? taker : maker;

    if (offer.side === 'buy' && !getDefaultBankAccount(seller)) {
      throw new AppError('Add a bank account before selling into a buy offer', 400);
    }

    // FIX: Check available balance AFTER locked balances (not just total balance)
    const sellerBalance = seller.balances[offer.asset] || 0;
    const sellerLockedBalance = seller.lockedBalances?.[offer.asset] || 0;
    const sellerAvailableBalance = sellerBalance - sellerLockedBalance;

    if (sellerAvailableBalance < cryptoAmount) {
      throw new AppError(
        `Insufficient available ${offer.asset} balance. Available: ${sellerAvailableBalance}, Required: ${cryptoAmount}`,
        400
      );
    }

    // Use transaction to ensure atomicity
    return withTransaction(async (session) => {
      // Lock the funds within the transaction
      lockFunds(seller, offer.asset, cryptoAmount);

      // Update offer
      offer.availableAmount = Math.max(0, Number(offer.availableAmount) - cryptoAmount);
      if (offer.availableAmount === 0) {
        offer.status = 'completed';
      }
      offer.updatedAt = new Date();

      // Create order
      const order = new P2POrder({
        offerId: offer._id,
        offerOwnerId: maker._id,
        takerId: taker._id,
        asset: offer.asset,
        fiatCurrency: offer.fiatCurrency,
        price: offer.price,
        cryptoAmount,
        fiatAmount: Number((cryptoAmount * offer.price).toFixed(2)),
        buyer: buildParticipant(buyer),
        seller: buildParticipant(seller),
        escrowUserId: seller._id,
        paymentMethod: offer.paymentMethod,
        paymentSnapshot:
          offer.side === 'sell'
            ? {
                bankName: offer.paymentDetails?.bankName || null,
                bankCode: offer.paymentDetails?.bankCode || null,
                accountNumber: offer.paymentDetails?.accountNumber || null,
                accountName: offer.paymentDetails?.accountName || null,
                instructions: offer.paymentDetails?.instructions || offer.terms || null
              }
            : getDefaultBankAccount(seller),
        // FIX: Set proper expiration time
        expiresAt: new Date(Date.now() + offer.paymentWindowMinutes * 60 * 1000),
        reference: `P2P-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
      });

      await Promise.all([
        seller.save({ session }),
        offer.save({ session }),
        order.save({ session })
      ]);

      logger.info(`P2P order created: ${order.reference}, seller: ${seller._id}, buyer: ${buyer._id}, amount: ${cryptoAmount} ${offer.asset}`);

      // Send notifications
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

      order.status = 'payment_sent';
      order.paymentProofNote = req.body.proofNote || null;
      order.paymentProofUrl = req.body.proofUrl || null;
      order.paymentMarkedAt = new Date();
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

    // FIX: Check if order has expired
    if (order.expiresAt && new Date() > order.expiresAt) {
      throw new AppError('This order has expired. Please cancel and create a new one.', 400);
    }

    if (!['payment_sent', 'awaiting_payment'].includes(order.status)) {
      throw new AppError('This order cannot be released', 400);
    }

    // FIX: Require payment confirmation from buyer first if still awaiting payment
    if (order.status === 'awaiting_payment') {
      throw new AppError('Buyer has not marked payment as sent yet', 400);
    }

    return withTransaction(async (session) => {
      const [seller, buyer] = await Promise.all([
        User.findById(order.seller.userId),
        User.findById(order.buyer.userId)
      ]);

      // Apply fees and release crypto
      await applyP2PFeesAndRelease({ order, seller, buyer });

      // Update order status within transaction
      order.status = 'completed';
      order.releaseNote = req.body.releaseNote || null;
      order.releasedAt = new Date();
      order.updatedAt = new Date();

      // Create transactions for record keeping
      const sellerTx = new Transaction({
        userId: seller._id,
        type: 'p2p_sell',
        amount: order.cryptoAmount,
        currency: order.asset,
        description: `P2P sale to ${order.buyer.fullName || order.buyer.username || 'buyer'}`,
        status: 'completed',
        toUserId: buyer._id,
        toUsername: order.buyer.username,
        reference: `${order.reference}-SELL`,
        metadata: { p2pOrderId: order._id, fiatAmount: order.fiatAmount, price: order.price }
      });

      const buyerTx = new Transaction({
        userId: buyer._id,
        type: 'p2p_buy',
        amount: order.cryptoAmount,
        currency: order.asset,
        description: `P2P purchase from ${order.seller.fullName || order.seller.username || 'seller'}`,
        status: 'completed',
        fromUserId: seller._id,
        fromUsername: order.seller.username,
        reference: `${order.reference}-BUY`,
        metadata: { p2pOrderId: order._id, fiatAmount: order.fiatAmount, price: order.price }
      });

      await Promise.all([
        seller.save({ session }),
        buyer.save({ session }),
        order.save({ session }),
        sellerTx.save({ session }),
        buyerTx.save({ session })
      ]);

      logger.info(`P2P order completed: ${order.reference}, seller: ${seller._id}, buyer: ${buyer._id}`);

      // Send notifications
      await Promise.all([
        createNotification({
          user: seller,
          type: 'send',
          title: 'P2P sale completed',
          body: `You successfully sold ${order.cryptoAmount} ${order.asset} to ${order.buyer.username}`,
          data: {
            orderId: order._id,
            reference: order.reference,
            amount: order.cryptoAmount,
            feeAmount: order.cryptoFeeAmount
          },
          sendEmail: true
        }),
        createNotification({
          user: buyer,
          type: 'receive',
          title: 'P2P purchase completed',
          body: `Your purchase of ${order.cryptoAmount} ${order.asset} has been completed. Crypto is now available in your wallet.`,
          data: {
            orderId: order._id,
            reference: order.reference,
            amount: order.cryptoAmount
          },
          sendEmail: true
        })
      ]);

      res.json({
        success: true,
        message: 'Escrow released successfully',
        order: toOrderPayload(order, req.userId)
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

    if (!['awaiting_payment', 'payment_sent'].includes(order.status)) {
      throw new AppError('This order cannot be cancelled', 400);
    }

    // FIX: Only seller can cancel if payment_sent (payment confirmation was made)
    if (order.status === 'payment_sent' && String(order.seller.userId) !== String(req.userId)) {
      throw new AppError('Seller must review or dispute after payment is marked sent', 400);
    }

    return withTransaction(async (session) => {
      const [offer, seller] = await Promise.all([
        P2POffer.findById(order.offerId),
        User.findById(order.seller.userId)
      ]);

      // Unlock funds
      unlockFunds(seller, order.asset, order.cryptoAmount);

      // Restore offer availability if not cancelled
      if (offer && offer.status !== 'cancelled') {
        offer.availableAmount = Number(offer.availableAmount) + Number(order.cryptoAmount);
        if (offer.status === 'completed') {
          offer.status = 'open';
        }
        offer.updatedAt = new Date();
      }

      order.status = 'cancelled';
      order.cancelledByUserId = req.userId;
      order.cancelReason = req.body.reason || null;
      order.updatedAt = new Date();

      await Promise.all([
        seller.save({ session }),
        order.save({ session }),
        ...(offer ? [offer.save({ session })] : [])
      ]);

      logger.info(`P2P order cancelled: ${order.reference}, reason: ${req.body.reason || 'unspecified'}`);

      // Send notification to other party
      const otherUserId = String(order.buyer.userId) === String(req.userId) ? order.seller.userId : order.buyer.userId;
      const otherUser = await User.findById(otherUserId);
      if (otherUser) {
        await createNotification({
          user: otherUser,
          type: 'p2p',
          title: 'P2P order cancelled',
          body: `The P2P order for ${order.cryptoAmount} ${order.asset} has been cancelled.`,
          data: {
            orderId: order._id,
            reference: order.reference
          },
          sendEmail: true
        });
      }

      res.json({
        success: true,
        message: 'Order cancelled and escrow returned',
        order: toOrderPayload(order, req.userId)
      });
    });
  })
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
      if (!['awaiting_payment', 'payment_sent'].includes(order.status)) {
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
      order.updatedAt = new Date();
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
  async (req, res) => {
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

      const [seller, buyer] = await Promise.all([User.findById(order.seller.userId), User.findById(order.buyer.userId)]);

      if (req.body.outcome === 'release_to_buyer') {
        await applyP2PFeesAndRelease({ order, seller, buyer, adminUserId: admin._id });
        order.status = 'completed';
        order.releasedAt = new Date();
      } else {
        unlockFunds(seller, order.asset, order.cryptoAmount);
        const offer = await P2POffer.findById(order.offerId);
        if (offer && offer.status !== 'cancelled') {
          offer.availableAmount = Number(offer.availableAmount) + Number(order.cryptoAmount);
          if (offer.status === 'completed') {
            offer.status = 'open';
          }
          offer.updatedAt = new Date();
          await offer.save();
        }
        order.status = 'cancelled';
      }

      order.updatedAt = new Date();
      dispute.status = req.body.outcome === 'dismissed' ? 'dismissed' : 'resolved';
      dispute.resolution = {
        outcome: req.body.outcome,
        note: req.body.note || null,
        resolvedByUserId: admin._id,
        resolvedAt: new Date()
      };
      dispute.updatedAt = new Date();

      await Promise.all([seller.save(), buyer.save(), order.save(), dispute.save()]);

      res.json({
        message: 'Dispute resolved',
        order: toOrderPayload(order, req.userId, dispute),
        dispute
      });
    } catch (error) {
      res.status(500).json({ message: error.message || 'Server error' });
    }
  }
);

// Global error handler for P2P routes
router.use((err, req, res, next) => {
  handleError(err, req, res, new Logger('p2p'));
});

module.exports = router;
