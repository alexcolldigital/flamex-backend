const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

const mockUser = {
  _id: 'user-1',
  email: 'verify@example.com',
  emailVerified: false,
  save: jest.fn().mockResolvedValue(undefined)
};
let mockOtpRecord;

jest.mock('../middleware/auth', () => ({
  generateToken: jest.fn(() => 'test-token'),
  authMiddleware: jest.fn()
}));

jest.mock('../models/User', () => ({
  findOne: jest.fn(async ({ email }) => email === mockUser.email ? mockUser : null),
  findById: jest.fn()
}));

jest.mock('../services/email', () => ({
  sendOtpEmail: jest.fn().mockResolvedValue({ success: true })
}));
jest.mock('../models/Referral', () => ({}));
jest.mock('../models/Transaction', () => ({}));
jest.mock('../models/EmailOtp', () => ({
  deleteMany: jest.fn().mockResolvedValue(undefined),
  create: jest.fn(async (data) => {
    mockOtpRecord = { ...data, attempts: 0, save: jest.fn().mockResolvedValue(undefined) };
    return mockOtpRecord;
  }),
  findOne: jest.fn(() => ({ sort: jest.fn(async () => mockOtpRecord) }))
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

describe('email verification', () => {
  beforeEach(() => {
    mockOtpRecord = {
      email: mockUser.email,
      purpose: 'verify_email',
      codeHash: 'not-the-right-code',
      expiresAt: new Date(Date.now() + 600000),
      attempts: 0,
      save: jest.fn().mockResolvedValue(undefined)
    };
    mockUser.emailVerified = false;
    mockUser.save.mockClear();
  });

  test('sends a verification OTP for an existing user', async () => {
    const response = await request(createApp())
      .post('/auth/request-email-otp')
      .send({ email: mockUser.email, purpose: 'verify_email' });

    expect(response.status).toBe(200);
    expect(response.body.delivered).toBe(true);
    expect(mockOtpRecord.email).toBe(mockUser.email);
    expect(mockOtpRecord.purpose).toBe('verify_email');
  });

  test('reports an SMTP delivery failure instead of claiming the OTP was sent', async () => {
    const emailService = require('../services/email');
    emailService.sendOtpEmail.mockResolvedValueOnce({ success: false, error: 'SMTP unavailable' });

    const response = await request(createApp())
      .post('/auth/request-email-otp')
      .send({ email: mockUser.email, purpose: 'verify_email' });

    expect(response.status).toBe(503);
    expect(response.body.message).toMatch(/unable to send verification code/i);
  });

  test('rejects an incorrect OTP without verifying the user', async () => {
    const response = await request(createApp())
      .post('/auth/verify-email-otp')
      .send({ email: mockUser.email, code: '123456' });

    expect(response.status).toBe(400);
    expect(mockUser.emailVerified).toBe(false);
  });

  test('marks the account verified after a valid OTP', async () => {
    const code = '123456';
    mockOtpRecord.codeHash = crypto.createHash('sha256').update(code).digest('hex');

    const response = await request(createApp())
      .post('/auth/verify-email-otp')
      .send({ email: mockUser.email, code });

    expect(response.status).toBe(200);
    expect(response.body.verified).toBe(true);
    expect(mockUser.emailVerified).toBe(true);
    expect(mockUser.save).toHaveBeenCalled();
    expect(mockOtpRecord.save).toHaveBeenCalled();
  });

  test('resets the password only after a password reset OTP', async () => {
    const code = '654321';
    mockOtpRecord.purpose = 'password_reset';
    mockOtpRecord.codeHash = crypto.createHash('sha256').update(code).digest('hex');

    const response = await request(createApp())
      .post('/auth/reset-password-with-otp')
      .send({ email: mockUser.email, code, newPassword: 'new-password-123' });

    expect(response.status).toBe(200);
    expect(response.body.verified).toBe(true);
    expect(mockUser.password).toBe('new-password-123');
    expect(mockUser.emailVerified).toBe(true);
  });

  test('does not reset an unverified PIN account', async () => {
    const code = '111111';
    mockOtpRecord.purpose = 'pin_reset';
    mockOtpRecord.codeHash = crypto.createHash('sha256').update(code).digest('hex');

    const response = await request(createApp())
      .post('/auth/reset-pin-with-otp')
      .send({ email: mockUser.email, code, newPin: '1234' });

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/verify your email/i);
  });
});
