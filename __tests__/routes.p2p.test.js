const express = require('express');
const request = require('supertest');

function mockCreateQueryResult(doc) {
  return {
    session: jest.fn().mockResolvedValue(doc),
    populate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(doc),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(doc),
    then: (resolve) => Promise.resolve(resolve(doc)),
    catch: (reject) => Promise.resolve(doc).catch(reject)
  };
}

const mockUsers = {};
const mockOffers = {};
const mockOrders = {};
const mockSavedOrders = [];
const mockSavedTransactions = [];

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, _res, next) => {
    req.userId = req.headers['x-user-id'];
    next();
  }
}));

jest.mock('../middleware/kyc', () => ({
  requireVerifiedKycForTransactions: (_req, _res, next) => next()
}));

jest.mock('../utils/database', () => ({
  withTransaction: async (callback) => callback({ id: 'session-1' })
}));

jest.mock('../services/platformLedger', () => ({
  createLedgerEntry: jest.fn().mockResolvedValue({ ok: true })
}));

jest.mock('../utils/admin', () => ({
  getPlatformSettings: jest.fn().mockResolvedValue({
    requireKycForTransactions: false,
    fees: {
      p2pCryptoFeeRate: 0,
      p2pNgnFeeRate: 0
    }
  })
}));

jest.mock('../services/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue({ ok: true })
}));

jest.mock('../utils/logger', () =>
  class Logger {
    info() {}
    warn() {}
    error() {}
    http() {}
  }
);

jest.mock('../models/User', () => ({
  findById: jest.fn((id) => mockCreateQueryResult(mockUsers[String(id)] || null))
}));

jest.mock('../models/P2POffer', () => ({
  findById: jest.fn((id) => mockCreateQueryResult(mockOffers[String(id)] || null)),
  findOne: jest.fn(() => mockCreateQueryResult(null)),
  find: jest.fn(() => mockCreateQueryResult([]))
}));

const mockP2POrder = jest.fn(function P2POrder(data) {
  Object.assign(this, data);
  this._id = this._id || `order-${mockSavedOrders.length + 1}`;
  this.status = this.status || 'awaiting_payment';
  this.paymentMethods = this.paymentMethods || ['bank_transfer'];
  this.paymentSnapshot = this.paymentSnapshot || {};
  this.messages = this.messages || [];
  this.escrowLockedAt = this.escrowLockedAt || new Date();
  this.createdAt = this.createdAt || new Date();
  this.updatedAt = this.updatedAt || new Date();
  this.save = jest.fn().mockImplementation(async () => {
    mockOrders[String(this._id)] = this;
    mockSavedOrders.push(this);
    return this;
  });
});

mockP2POrder.findOne = jest.fn((criteria) => {
  const order = Object.values(mockOrders).find((item) => {
    if (!item) return false;
    if (criteria._id && String(item._id) !== String(criteria._id)) return false;
    if (criteria.$or) {
      return criteria.$or.some((entry) =>
        String(item.buyer.userId) === String(entry['buyer.userId']) ||
        String(item.seller.userId) === String(entry['seller.userId'])
      );
    }
    return true;
  }) || null;
  return mockCreateQueryResult(order);
});

mockP2POrder.findById = jest.fn((id) => mockCreateQueryResult(mockOrders[String(id)] || null));
mockP2POrder.find = jest.fn(() => mockCreateQueryResult([]));

jest.mock('../models/P2POrder', () => mockP2POrder);

const mockTransaction = jest.fn(function Transaction(data) {
  Object.assign(this, data);
  this.save = jest.fn().mockImplementation(async () => {
    mockSavedTransactions.push(this);
    return this;
  });
});

jest.mock('../models/Transaction', () => mockTransaction);

const mockP2PDispute = jest.fn(function P2PDispute(data) {
  Object.assign(this, data);
  this._id = this._id || 'dispute-1';
  this.save = jest.fn().mockResolvedValue(this);
});

mockP2PDispute.findById = jest.fn(() => mockCreateQueryResult(null));
mockP2PDispute.find = jest.fn(() => mockCreateQueryResult([]));

jest.mock('../models/P2PDispute', () => mockP2PDispute);

const router = require('../routes/p2p');

function createUser({
  id,
  username,
  firstName = username,
  lastName = 'User',
  balances = {},
  lockedBalances = {},
  bankAccounts = [],
  kycLevel = 2,
  merchantStatus = 'approved'
}) {
  return {
    _id: id,
    username,
    firstName,
    lastName,
    email: `${username}@example.com`,
    balances: { USDT: 0, NGN: 0, ...balances },
    lockedBalances: { USDT: 0, NGN: 0, ...lockedBalances },
    bankAccounts,
    kycLevel,
    p2pProfile: {
      merchantStatus,
      completionRate: 100,
      totalTrades: 0,
      completedTrades: 0,
      cancelledTrades: 0,
      disputedTrades: 0,
      totalVolumeNgn: 0
    },
    save: jest.fn().mockImplementation(async function save() {
      mockUsers[String(this._id)] = this;
      return this;
    })
  };
}

describe('P2P routes critical escrow flow', () => {
  let app;
  const sellerId = '507f1f77bcf86cd799439011';
  const buyerId = '507f1f77bcf86cd799439012';
  const offerId = '507f1f77bcf86cd799439013';
  const orderIdOne = '507f1f77bcf86cd799439014';
  const orderIdTwo = '507f1f77bcf86cd799439015';

  beforeEach(() => {
    for (const key of Object.keys(mockUsers)) delete mockUsers[key];
    for (const key of Object.keys(mockOffers)) delete mockOffers[key];
    for (const key of Object.keys(mockOrders)) delete mockOrders[key];
    mockSavedOrders.length = 0;
    mockSavedTransactions.length = 0;

    app = express();
    app.use(express.json());
    app.use('/api/p2p', router);
  });

  test('opening a trade locks seller crypto in escrow and reduces offer liquidity', async () => {
    const seller = createUser({
      id: sellerId,
      username: 'seller',
      balances: { USDT: 100 },
      bankAccounts: [
        {
          bankName: 'Test Bank',
          bankCode: '001',
          accountNumber: '1234567890',
          accountName: 'Seller User',
          isDefault: true
        }
      ]
    });
    const buyer = createUser({
      id: buyerId,
      username: 'buyer'
    });

    mockUsers[seller._id] = seller;
    mockUsers[buyer._id] = buyer;
    mockOffers[offerId] = {
      _id: offerId,
      creatorId: seller._id,
      side: 'sell',
      asset: 'USDT',
      fiatCurrency: 'NGN',
      price: 1600,
      availableAmount: 100,
      minOrderAmount: 10,
      maxOrderAmount: 50,
      paymentWindowMinutes: 15,
      paymentMethod: 'bank_transfer',
      paymentMethods: ['bank_transfer'],
      paymentDetails: {
        bankName: 'Test Bank',
        accountNumber: '1234567890',
        accountName: 'Seller User'
      },
      status: 'open',
      save: jest.fn().mockResolvedValue(true)
    };

    const response = await request(app)
      .post(`/api/p2p/offers/${offerId}/order`)
      .set('x-user-id', buyer._id)
      .send({ cryptoAmount: 20, paymentMethod: 'bank_transfer' });

    expect(response.status).toBe(201);
    expect(response.body.order.status).toBe('awaiting_payment');
    expect(response.body.order.escrow.status).toBe('locked');
    expect(seller.balances.USDT).toBe(80);
    expect(seller.lockedBalances.USDT).toBe(20);
    expect(mockOffers[offerId].availableAmount).toBe(80);
  });

  test('buyer marking a trade as paid moves the order into awaiting_release', async () => {
    mockOrders[orderIdOne] = {
      _id: orderIdOne,
      offerId,
      seller: { userId: sellerId, username: 'seller', fullName: 'Seller User' },
      buyer: { userId: buyerId, username: 'buyer', fullName: 'Buyer User' },
      asset: 'USDT',
      fiatCurrency: 'NGN',
      price: 1600,
      cryptoAmount: 20,
      fiatAmount: 32000,
      paymentMethod: 'bank_transfer',
      paymentMethods: ['bank_transfer'],
      paymentSnapshot: {},
      status: 'awaiting_payment',
      reference: 'P2P-TEST-1',
      messages: [],
      paymentDeadlineAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60_000),
      save: jest.fn().mockResolvedValue(true)
    };

    const response = await request(app)
      .post(`/api/p2p/orders/${orderIdOne}/mark-paid`)
      .set('x-user-id', buyerId)
      .send({ proofNote: 'Bank transfer completed' });

    expect(response.status).toBe(200);
    expect(mockOrders[orderIdOne].status).toBe('awaiting_release');
    expect(mockOrders[orderIdOne].paymentProofNote).toBe('Bank transfer completed');
    expect(mockOrders[orderIdOne].paymentMarkedAt).toBeTruthy();
    expect(mockOrders[orderIdOne].releaseDeadlineAt).toBeTruthy();
  });

  test('seller confirming payment releases escrow to the buyer and completes the trade', async () => {
    const seller = createUser({
      id: sellerId,
      username: 'seller',
      balances: { USDT: 80 },
      lockedBalances: { USDT: 20 }
    });
    const buyer = createUser({
      id: buyerId,
      username: 'buyer',
      balances: { USDT: 5 }
    });

    mockUsers[seller._id] = seller;
    mockUsers[buyer._id] = buyer;
    mockOrders[orderIdTwo] = {
      _id: orderIdTwo,
      offerId,
      seller: { userId: seller._id, username: seller.username, fullName: 'Seller User' },
      buyer: { userId: buyer._id, username: buyer.username, fullName: 'Buyer User' },
      asset: 'USDT',
      fiatCurrency: 'NGN',
      price: 1600,
      cryptoAmount: 20,
      fiatAmount: 32000,
      paymentMethod: 'bank_transfer',
      paymentMethods: ['bank_transfer'],
      paymentSnapshot: {},
      status: 'awaiting_release',
      reference: 'P2P-TEST-2',
      messages: [],
      paymentMarkedAt: new Date(Date.now() - 60_000),
      paymentDeadlineAt: new Date(Date.now() + 60_000),
      releaseDeadlineAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60_000),
      save: jest.fn().mockResolvedValue(true)
    };

    const response = await request(app)
      .post(`/api/p2p/orders/${orderIdTwo}/confirm-payment`)
      .set('x-user-id', seller._id)
      .send({ releaseNote: 'Payment received, releasing escrow' });

    expect(response.status).toBe(200);
    expect(mockOrders[orderIdTwo].status).toBe('completed');
    expect(mockOrders[orderIdTwo].paymentConfirmedAt).toBeTruthy();
    expect(seller.lockedBalances.USDT).toBe(0);
    expect(buyer.balances.USDT).toBe(25);
    expect(mockSavedTransactions).toHaveLength(2);
  });
});
