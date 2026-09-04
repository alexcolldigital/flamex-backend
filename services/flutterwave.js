/**
 * Flutterwave Service
 * Card Payments & Virtual Cards
 * Docs: https://developer.flutterwave.com/docs
 */

const axios = require('axios');
const crypto = require('crypto');

class FlutterwaveService {
  constructor() {
    this.baseUrl = 'https://api.flutterwave.com/v3';
    this.publicKey = process.env.FLUTTERWAVE_PUBLIC_KEY;
    this.secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    this.encryptionKey = process.env.FLUTTERWAVE_ENCRYPTION_KEY;
    this.isConfigured = !!this.secretKey;
  }

  /**
   * Get headers for API calls
   */
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.secretKey}`
    };
  }

  /**
   * Encrypt card details
   * @param {object} card - Card details
   */
  encryptCard(card) {
    if (!this.isConfigured) {
      throw new Error('Flutterwave not configured');
    }

    const iv = crypto.randomBytes(16);
    const key = Buffer.from(this.encryptionKey, 'utf8');
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

    let encrypted = cipher.update(JSON.stringify(card), 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return {
      encrypted,
      iv: iv.toString('hex')
    };
  }

  /**
   * Charge a card
   * @param {object} params - Charge parameters
   */
  async chargeCard(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    const {
      cardNumber,
      cvv,
      expiryMonth,
      expiryYear,
      amount,
      currency,
      email,
      phone,
      fullName,
      txRef,
      redirectUrl
    } = params;

    try {
      const encryptedCard = this.encryptCard({
        cardNumber,
        cvv,
        expiryMonth,
        expiryYear
      });

      const response = await axios.post(
        `${this.baseUrl}/charges`,
        {
          card: {
            encrypted: encryptedCard.encrypted,
            cvv: cvv
          },
          amount,
          currency: currency || 'NGN',
          email,
          phone,
          fullname: fullName,
          tx_ref: txRef || `FLAMEX_${Date.now()}`,
          redirect_url: redirectUrl,
          authorization: {
            mode: 'pin'
          }
        },
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave charge error:', error.response?.data || error.message);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.response?.data?.status ||
          error.response?.data?.status_message ||
          error.message
      };
    }
  }

  /**
   * Validate card charge (OTP)
   * @param {string} otp - One-time password
   * @param {string} flwRef - Flutterwave reference
   */
  async validateCharge(otp, flwRef) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/validate-charge`,
        {
          otp,
          flw_ref: flwRef
        },
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave validate error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Verify a transaction
   * @param {string} txRef - Transaction reference
   */
  async verifyTransaction(transactionId) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/transactions/${transactionId}/verify`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave verify error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Verify a transaction with merchant reference
   * @param {string} txRef - Merchant transaction reference
   */
  async verifyTransactionByReference(txRef) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/transactions/verify_by_reference`,
        {
          headers: this.getHeaders(),
          params: { tx_ref: txRef }
        }
      );

      return {
        success: true,
        data: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave verify by reference error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * List transactions by merchant reference
   * @param {string} txRef - Merchant transaction reference
   */
  async getTransactionsByReference(txRef) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/transactions`,
        {
          headers: this.getHeaders(),
          params: { tx_ref: txRef }
        }
      );

      return {
        success: true,
        data: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave list transactions error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Create a payment checkout link
   * @param {object} params - Checkout parameters
   */
  async createCheckout(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    const {
      amount,
      currency = 'NGN',
      email,
      phone,
      fullName,
      txRef,
      redirectUrl,
      paymentOptions = 'card,ussd',
      title = 'FlameX Deposit',
      description = 'Deposit to FlameX wallet'
    } = params;

    if (!email || email.trim() === '') {
      return { success: false, error: 'email is required' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/payments`,
        {
          tx_ref: txRef || `FLAMEX_${Date.now()}`,
          amount,
          currency,
          redirect_url: redirectUrl,
          payment_options: paymentOptions,
          customer: {
            email,
            phone_number: phone,
            name: fullName
          },
          customizations: {
            title,
            description,
            logo: 'https://flamex.com/logo.png' // Update with actual logo URL
          }
        },
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave checkout error:', error.response?.data || error.message);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.response?.data?.status ||
          error.response?.data?.status_message ||
          error.message
      };
    }
  }
  async createVirtualCard(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    const {
      currency,
      amount,
      email,
      firstName,
      lastName,
      phone,
      callbackUrl
    } = params;

    try {
      const response = await axios.post(
        `${this.baseUrl}/virtual-cards`,
        {
          currency: currency || 'USD',
          amount: amount || 0,
          email,
          first_name: firstName,
          last_name: lastName,
          phone,
          callback_url: callbackUrl
        },
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        card: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave create card error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get virtual cards
   */
  async getVirtualCards() {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/virtual-cards`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        cards: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave get cards error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get virtual card details
   * @param {string} cardId - Card ID
   */
  async getVirtualCardDetails(cardId) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/virtual-cards/${cardId}`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        card: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave card details error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Fund virtual card
   * @param {string} cardId - Card ID
   * @param {number} amount - Amount to fund
   */
  async fundVirtualCard(cardId, amount) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/virtual-cards/${cardId}/fund`,
        {
          amount,
          currency: 'USD'
        },
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave fund card error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Withdraw from virtual card
   * @param {string} cardId - Card ID
   * @param {number} amount - Amount to withdraw
   */
  async withdrawFromCard(cardId, amount) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/virtual-cards/${cardId}/withdraw`,
        {
          amount,
          currency: 'USD'
        },
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave withdraw error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Create a virtual account for bank transfers
   * @param {object} params - Virtual account parameters
   */
  async createVirtualAccount(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    const {
      customerName,
      email,
      phone,
      preferredBank = '044',
      txRef
    } = params;

    if (!email || email.trim() === '') {
      return { success: false, error: 'email is required' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/virtual-account-numbers`,
        {
          customer: {
            name: customerName,
            email,
            phone_number: phone,
            customertoken: txRef
          },
          preferred_bank: preferredBank,
          tx_ref: txRef || `FLAMEX_VA_${Date.now()}`,
          narration: `FlameX deposit account`,
          is_permanent: false
        },
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave virtual account error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Terminate virtual card
   * @param {string} cardId - Card ID
   */
  async terminateCard(cardId) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.delete(
        `${this.baseUrl}/virtual-cards/${cardId}`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave terminate card error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get card transactions
   * @param {string} cardId - Card ID
   */
  async getCardTransactions(cardId) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/virtual-cards/${cardId}/transactions`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        transactions: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave card transactions error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get list of banks
   */
  async getBanks() {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/banks/NG`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        banks: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave get banks error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Verify bank account
   * @param {string} accountNumber - Account number
   * @param {string} bankCode - Bank code
   */
  async verifyAccount(accountNumber, bankCode) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/accounts/resolve/${bankCode}/${accountNumber}`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave verify account error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Initiate transfer
   * @param {object} params - Transfer parameters
   */
  async initiateTransfer(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Flutterwave not configured' };
    }

    const {
      amount,
      accountNumber,
      bankCode,
      accountName,
      narration,
      reference,
      currency
    } = params;

    try {
      const response = await axios.post(
        `${this.baseUrl}/transfers`,
        {
          account_bank: bankCode,
          account_number: accountNumber,
          amount,
          narration: narration || 'FlameX Transfer',
          reference: reference || `FLAMEX_${Date.now()}`,
          currency: currency || 'NGN',
          callback_url: process.env.APP_URL + '/webhooks/flutterwave'
        },
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data.data,
        message: response.data.message
      };
    } catch (error) {
      console.error('Flutterwave transfer error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }
}

module.exports = new FlutterwaveService();
