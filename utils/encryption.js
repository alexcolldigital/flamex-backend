const crypto = require('crypto');

const ENCRYPTION_SECRET = process.env.ENCRYPTION_KEY;
const IV_LENGTH = 16;

function createWalletSecret(password) {
  return `${password}:${process.env.JWT_SECRET || 'flamex-secret-key-change-in-production'}`;
}

function getEncryptionKey() {
  if (!ENCRYPTION_SECRET) {
    throw new Error('ENCRYPTION_KEY must be set in environment for secure wallet encryption');
  }
  return ENCRYPTION_SECRET;
}

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * Encrypt text using AES-256-CBC
 * @param {string} text - Text to encrypt
 * @returns {string} Encrypted text (iv:encrypted)
 */
function encrypt(text, secret = getEncryptionKey()) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    deriveKey(secret),
    iv
  );
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt text using AES-256-CBC
 * @param {string} encryptedText - Encrypted text (iv:encrypted)
 * @returns {string} Decrypted text
 */
function decrypt(encryptedText, secret = getEncryptionKey()) {
  const parts = encryptedText.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encrypted = parts.join(':');
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    deriveKey(secret),
    iv
  );
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Hash password using bcrypt-like algorithm (simplified)
 * In production, use bcrypt library
 * @param {string} password - Password to hash
 * @returns {string} Hashed password
 */
async function hashPassword(password) {
  const bcrypt = require('bcryptjs');
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

/**
 * Compare password with hash
 * @param {string} password - Plain text password
 * @param {string} hash - Hashed password
 * @returns {boolean} Whether password matches
 */
async function comparePassword(password, hash) {
  const bcrypt = require('bcryptjs');
  return bcrypt.compare(password, hash);
}

/**
 * Generate a random mnemonic (simplified)
 * In production, use bip39 library
 * @returns {string} 12-word mnemonic
 */
function generateMnemonic() {
  const words = [
    'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract',
    'absurd', 'abuse', 'access', 'accident', 'account', 'accuse', 'achieve', 'acid',
    'acoustic', 'acquire', 'across', 'act', 'action', 'actor', 'actress', 'actual',
    'adapt', 'add', 'addict', 'address', 'adjust', 'admit', 'adult', 'advance',
    'advice', 'aerobic', 'affair', 'afford', 'afraid', 'again', 'age', 'agent',
    'agree', 'ahead', 'aim', 'air', 'airport', 'aisle', 'alarm', 'album',
    'alcohol', 'alert', 'alien', 'all', 'alley', 'allow', 'almost', 'alone',
    'alpha', 'already', 'also', 'alter', 'always', 'amateur', 'amazing', 'among'
  ];
  
  const mnemonic = [];
  for (let i = 0; i < 12; i++) {
    const randomIndex = Math.floor(Math.random() * words.length);
    mnemonic.push(words[randomIndex]);
  }
  return mnemonic.join(' ');
}

/**
 * Generate a random referral code
 * @returns {string} 8-character referral code
 */
function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Generate a secure random string
 * @param {number} length - Length of string
 * @returns {string} Random string
 */
function generateRandomString(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

module.exports = {
  createWalletSecret,
  encrypt,
  decrypt,
  hashPassword,
  comparePassword,
  generateMnemonic,
  generateReferralCode,
  generateRandomString,
};
