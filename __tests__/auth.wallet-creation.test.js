const express = require('express');
const request = require('supertest');

const savedUsers = [];

jest.mock('../middleware/auth', () => ({
  generateToken: jest.fn(() => 'test-token'),
  authMiddleware: jest.fn()
}));

jest.mock('../models/User', () => {
  return jest.fn(function User(data) {
    Object.assign(this, data);
    this._id = 'user-1';
    this.save = jest.fn(async () => savedUsers.push(this));
  });
});
const User = require('../models/User');
User.findOne = jest.fn().mockResolvedValue(null);

jest.mock('../models/Referral', () => {
  return jest.fn(function Referral(data) {
    Object.assign(this, data);
    this.save = jest.fn().mockResolvedValue(undefined);
  });
});
const Referral = require('../models/Referral');
Referral.findOne = jest.fn().mockResolvedValue(null);

jest.mock('../models/Transaction', () => jest.fn());
jest.mock('../models/EmailOtp', () => ({
  deleteMany: jest.fn().mockResolvedValue(undefined),
  create: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../services/email', () => ({
  sendOtpEmail: jest.fn().mockResolvedValue({ success: true })
}));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../services/audit', () => ({ logAuditEvent: jest.fn() }));
jest.mock('../utils/admin', () => ({
  getPlatformSettings: jest.fn().mockResolvedValue({ allowNewRegistrations: true }),
  isAdminUser: jest.fn().mockReturnValue(false),
  buildAdminProfile: jest.fn()
}));

const authRouter = require('../routes/auth');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  return app;
}

const account = {
  firstName: 'Test',
  lastName: 'Wallet',
  email: 'wallet@example.com',
  phone: '+2348012345678',
  username: 'walletuser',
  password: 'password123'
};

describe('wallet creation during registration', () => {
  beforeEach(() => {
    savedUsers.length = 0;
    User.mockClear();
  });

  test('creates and returns a valid wallet without private key material', async () => {
    const response = await request(createApp())
      .post('/auth/register')
      .send({
        ...account,
        wallets: [{
          chainId: 'ethereum',
          address: '0xabc',
          publicKey: '0xpub',
          privateKey: '0xprivate'
        }],
        mnemonic: 'test recovery phrase'
      });

    expect(response.status).toBe(201);
    expect(response.body.token).toBe('test-token');
    expect(response.body.emailVerificationSent).toBe(true);
    expect(response.body.user.wallets).toEqual([
      { chainId: 'ethereum', address: '0xabc', publicKey: '0xpub' }
    ]);
    expect(response.body.user.wallets[0].privateKey).toBeUndefined();
    expect(savedUsers).toHaveLength(1);
    expect(savedUsers[0].wallets[0].encryptedPrivateKey).toBeTruthy();
  });
});
