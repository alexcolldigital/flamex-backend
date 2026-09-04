const express = require('express');
const request = require('supertest');

const mockUser = {
  _id: 'user-1',
  balances: { NGN: 1000, USD: 0 },
  lockedBalances: { NGN: 200, USD: 0 },
  save: jest.fn().mockResolvedValue(undefined)
};
const savedTransactions = [];

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, _res, next) => {
    req.userId = 'user-1';
    next();
  }
}));

jest.mock('../utils/database', () => ({
  withTransaction: async (callback) => callback({ id: 'session-1' })
}));

jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({
    session: jest.fn().mockResolvedValue(mockUser)
  }))
}));

jest.mock('../models/Transaction', () => jest.fn(function Transaction(data) {
  Object.assign(this, data);
  this._id = 'transaction-1';
  this.save = jest.fn(async () => {
    savedTransactions.push(this);
  });
}));

jest.mock('../models/GiftCardTrade', () => ({}));

const transactionsRouter = require('../routes/transactions');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/transactions', transactionsRouter);
  return app;
}

describe('wallet bill transactions', () => {
  beforeEach(() => {
    mockUser.balances.NGN = 1000;
    mockUser.lockedBalances.NGN = 200;
    mockUser.save.mockClear();
    savedTransactions.length = 0;
  });

  test('rejects malformed payment details before loading the wallet', async () => {
    const response = await request(createApp())
      .post('/transactions/bill')
      .send({ type: 'airtime', provider: 'Telco', customerId: '08000000000', amount: 0, currency: 'NGN' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid bill payment details');
    expect(mockUser.save).not.toHaveBeenCalled();
    expect(savedTransactions).toHaveLength(0);
  });

  test('deducts only available balance and records the payment atomically', async () => {
    const response = await request(createApp())
      .post('/transactions/bill')
      .send({ type: 'airtime', provider: 'Telco', customerId: '08000000000', amount: 300, currency: 'ngn' });

    expect(response.status).toBe(200);
    expect(response.body.balance).toBe(700);
    expect(mockUser.balances.NGN).toBe(700);
    expect(mockUser.save).toHaveBeenCalledWith({ session: { id: 'session-1' } });
    expect(savedTransactions).toHaveLength(1);
    expect(savedTransactions[0]).toMatchObject({
      type: 'bill_payment',
      amount: 300,
      currency: 'NGN',
      status: 'completed'
    });
  });

  test('rejects spending locked funds', async () => {
    const response = await request(createApp())
      .post('/transactions/bill')
      .send({ type: 'airtime', provider: 'Telco', customerId: '08000000000', amount: 801, currency: 'NGN' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Insufficient available NGN balance');
    expect(mockUser.balances.NGN).toBe(1000);
    expect(mockUser.save).not.toHaveBeenCalled();
    expect(savedTransactions).toHaveLength(0);
  });
});
