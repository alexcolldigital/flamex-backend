/**
 * Monnify Service
 * NGN Virtual Accounts & Bank Transfers
 * Docs: https://developers.monnify.com/docs
 */

const axios = require('axios');
const crypto = require('crypto');

class MonnifyService {
  constructor() {
    this.baseUrl = 'https://api.monnify.com';
    this.apiKey = process.env.MONNIFY_API_KEY;
    this.secretKey = process.env.MONNIFY_SECRET_KEY;
    this.contractCode = process.env.MONNIFY_CONTRACT_CODE;
    this.isConfigured = !!(this.apiKey && this.secretKey && this.contractCode);
  }

  /**
   * Get authentication token
   */
  async getAuthToken() {
    if (!this.isConfigured) {
      return { success: false, error: 'Monnify not configured' };
    }

    try {
      const auth = Buffer.from(`${this.apiKey}:${this.secretKey}`).toString('base64');

      const response = await axios.post(
        `${this.baseUrl}/api/v1/auth/login`,
        {},
        {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        accessToken: response.data.responseBody.accessToken,
        expiresIn: response.data.responseBody.expiresIn
      };
    } catch (error) {
      console.error('Monnify auth error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Create a reserved account for a user
   * @param {object} params - Account parameters
   */
  async createReservedAccount(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Monnify not configured' };
    }

    const { userId, userName, email, bvn, phoneNumber } = params;

    try {
      const auth = await this.getAuthToken();
      if (!auth.success) return auth;

      const response = await axios.post(
        `${this.baseUrl}/api/v2/bank-transfer/reserved-accounts`,
        {
          accountReference: `FLAMEX_${userId}_${Date.now()}`,
          accountName: userName || 'FlameX User',
          currencyCode: 'NGN',
          contractCode: this.contractCode,
          customerEmail: email,
          customerName: userName || 'User'
        },
        {
          headers: {
            'Authorization': `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        accountReference: response.data.responseBody.accountReference,
        accounts: response.data.responseBody.accounts,
        bank: response.data.responseBody.bank
      };
    } catch (error) {
      console.error('Monnify create account error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get account details
   * @param {string} accountReference - Account reference
   */
  async getAccountDetails(accountReference) {
    if (!this.isConfigured) {
      return { success: false, error: 'Monnify not configured' };
    }

    try {
      const auth = await this.getAuthToken();
      if (!auth.success) return auth;

      const response = await axios.get(
        `${this.baseUrl}/api/v2/bank-transfer/reserved-accounts/${accountReference}`,
        {
          headers: {
            'Authorization': `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        account: response.data.responseBody
      };
    } catch (error) {
      console.error('Monnify account details error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get transaction history for reserved account
   * @param {string} accountReference - Account reference
   */
  async getTransactionHistory(accountReference) {
    if (!this.isConfigured) {
      return { success: false, error: 'Monnify not configured' };
    }

    try {
      const auth = await this.getAuthToken();
      if (!auth.success) return auth;

      const response = await axios.get(
        `${this.baseUrl}/api/v2/bank-transfer/reserved-accounts/${accountReference}/transactions`,
        {
          headers: {
            'Authorization': `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        transactions: response.data.responseBody.content,
        total: response.data.responseBody.total
      };
    } catch (error) {
      console.error('Monnify transaction history error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Verify bank account
   * @param {string} accountNumber - Bank account number
   * @param {string} bankCode - Bank code
   */
  async verifyAccount(accountNumber, bankCode) {
    if (!this.isConfigured) {
      return { success: false, error: 'Monnify not configured' };
    }

    try {
      const auth = await this.getAuthToken();
      if (!auth.success) return auth;

      const response = await axios.get(
        `${this.baseUrl}/api/v1/bank-transfer/enquiry/${bankCode}/${accountNumber}`,
        {
          headers: {
            'Authorization': `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        accountName: response.data.responseBody.accountName,
        accountNumber: response.data.responseBody.accountNumber,
        bankName: response.data.responseBody.bankName
      };
    } catch (error) {
      console.error('Monnify verify account error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Initiate transfer to another bank
   * @param {object} params - Transfer parameters
   */
  async initiateTransfer(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Monnify not configured' };
    }

    const { amount, accountNumber, bankCode, accountName, narration, reference } = params;

    try {
      const auth = await this.getAuthToken();
      if (!auth.success) return auth;

      const response = await axios.post(
        `${this.baseUrl}/api/v2/bank-transfer/initiate`,
        {
          amount: amount.toString(),
          reference: reference || `FLAMEX_${Date.now()}`,
          currency: 'NGN',
          destinationBankCode: bankCode,
          destinationAccountNumber: accountNumber,
          destinationAccountName: accountName,
          narration: narration || 'FlameX Transfer',
          sourceAccountNumber: '' // Uses main settlement account
        },
        {
          headers: {
            'Authorization': `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        reference: response.data.responseBody.reference,
        status: response.data.responseBody.status,
        message: response.data.responseBody.message
      };
    } catch (error) {
      console.error('Monnify transfer error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get list of banks
   */
  async getBanks() {
    if (!this.isConfigured) {
      return { success: false, error: 'Monnify not configured' };
    }

    try {
      const auth = await this.getAuthToken();
      if (!auth.success) return auth;

      const response = await axios.get(
        `${this.baseUrl}/api/v1/bank-transfer/banks`,
        {
          headers: {
            'Authorization': `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        banks: response.data.responseBody
      };
    } catch (error) {
      console.error('Monnify get banks error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get wallet balance
   */
  async getWalletBalance() {
    if (!this.isConfigured) {
      return { success: false, error: 'Monnify not configured' };
    }

    try {
      const auth = await this.getAuthToken();
      if (!auth.success) return auth;

      const response = await axios.get(
        `${this.baseUrl}/api/v1/wallet/balances`,
        {
          headers: {
            'Authorization': `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        balance: response.data.responseBody.availableBalance,
        currency: response.data.responseBody.currency
      };
    } catch (error) {
      console.error('Monnify wallet balance error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Webhook handler for payment notifications
   */
  handleWebhook(payload, signature, rawBody = null) {
    if (!this.secretKey) {
      return { valid: false, error: 'Monnify secret not configured' };
    }

    const expectedSignature = crypto
      .createHmac('sha512', this.secretKey)
      .update(rawBody || JSON.stringify(payload))
      .digest('hex');

    if (!signature || signature !== expectedSignature) {
      return { valid: false, error: 'Invalid signature' };
    }

    return {
      valid: true,
      event: payload.eventType,
      data: payload
    };
  }
}

module.exports = new MonnifyService();
