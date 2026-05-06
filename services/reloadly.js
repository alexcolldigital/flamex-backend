/**
 * Reloadly Service
 * Gift Cards API
 * Docs: https://developers.reloadly.com/
 */

const axios = require('axios');

class ReloadlyService {
  constructor() {
    this.baseUrl = 'https://giftcards.reloadly.com/api';
    this.apiToken = process.env.RELOADLY_API_TOKEN;
    this.clientId = process.env.RELOADLY_CLIENT_ID;
    this.isConfigured = !!(this.apiToken && this.clientId);
  }

  /**
   * Get headers for API calls
   */
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiToken}`,
      'Accept': 'application/json'
    };
  }

  /**
   * Get all countries
   */
  async getCountries() {
    if (!this.isConfigured) {
      return { success: false, error: 'Reloadly not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/countries`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        countries: response.data
      };
    } catch (error) {
      console.error('Reloadly countries error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get operators by country
   * @param {string} countryCode - Country code (e.g., 'NG', 'US')
   */
  async getOperatorsByCountry(countryCode) {
    if (!this.isConfigured) {
      return { success: false, error: 'Reloadly not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/operators/countries/${countryCode}`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        operators: response.data
      };
    } catch (error) {
      console.error('Reloadly operators error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get operator details
   * @param {number} operatorId - Operator ID
   */
  async getOperatorDetails(operatorId) {
    if (!this.isConfigured) {
      return { success: false, error: 'Reloadly not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/operators/${operatorId}`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        operator: response.data
      };
    } catch (error) {
      console.error('Reloadly operator details error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get available gift cards
   * @param {string} countryCode - Country code
   */
  async getGiftCards(countryCode = 'NG') {
    if (!this.isConfigured) {
      return { success: false, error: 'Reloadly not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/products?country=${countryCode}`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        giftCards: response.data
      };
    } catch (error) {
      console.error('Reloadly gift cards error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get gift card denominations
   * @param {number} productId - Product ID
   */
  async getDenominations(productId) {
    if (!this.isConfigured) {
      return { success: false, error: 'Reloadly not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/products/${productId}/denominations`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        denominations: response.data
      };
    } catch (error) {
      console.error('Reloadly denominations error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get gift card details
   * @param {number} productId - Product ID
   */
  async getGiftCardDetails(productId) {
    if (!this.isConfigured) {
      return { success: false, error: 'Reloadly not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/products/${productId}`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        giftCard: response.data
      };
    } catch (error) {
      console.error('Reloadly gift card details error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Purchase gift card
   * @param {object} params - Purchase parameters
   */
  async purchaseGiftCard(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Reloadly not configured' };
    }

    const {
      productId,
      denominationId,
      quantity,
      recipientEmail,
      senderName,
      message
    } = params;

    try {
      const response = await axios.post(
        `${this.baseUrl}/redemption`,
        {
          productId,
          denominationId,
          quantity: quantity || 1,
          recipientEmail: recipientEmail || '',
          senderName: senderName || 'FlameX',
          customMessage: message || 'Gift card from FlameX'
        },
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data,
        transactionId: response.data?.transactionId,
        status: response.data?.status
      };
    } catch (error) {
      console.error('Reloadly purchase error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get transaction status
   * @param {string} transactionId - Transaction ID
   */
  async getTransactionStatus(transactionId) {
    if (!this.isConfigured) {
      return { success: false, error: 'Reloadly not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/transactions/${transactionId}`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data,
        status: response.data?.status,
        pin: response.data?.pin,
        ecode: response.data?.ecode
      };
    } catch (error) {
      console.error('Reloadly transaction status error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get transaction history
   */
  async getTransactionHistory() {
    if (!this.isConfigured) {
      return { success: false, error: 'Reloadly not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/transactions`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        transactions: response.data
      };
    } catch (error) {
      console.error('Reloadly history error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get balance
   */
  async getBalance() {
    if (!this.isConfigured) {
      return { success: false, error: 'Reloadly not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/balance`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        balance: response.data,
        currency: response.data?.currency
      };
    } catch (error) {
      console.error('Reloadly balance error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get popular gift cards
   */
  async getPopularGiftCards() {
    if (!this.isConfigured) {
      return { success: false, error: 'Reloadly not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/products/popular`,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        giftCards: response.data
      };
    } catch (error) {
      console.error('Reloadly popular error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get popular brands
   */
  getPopularBrands() {
    return [
      { id: 1, name: 'Amazon', logo: 'amazon.png', categories: ['US', 'UK', 'NG'] },
      { id: 2, name: 'iTunes', logo: 'itunes.png', categories: ['US', 'UK'] },
      { id: 3, name: 'Google Play', logo: 'googleplay.png', categories: ['US', 'UK', 'NG'] },
      { id: 4, name: 'Netflix', logo: 'netflix.png', categories: ['US', 'UK', 'NG'] },
      { id: 5, name: 'Spotify', logo: 'spotify.png', categories: ['US', 'UK', 'NG'] },
      { id: 6, name: 'Steam', logo: 'steam.png', categories: ['US', 'UK', 'NG'] },
      { id: 7, name: 'PlayStation', logo: 'playstation.png', categories: ['US', 'UK'] },
      { id: 8, name: 'Xbox', logo: 'xbox.png', categories: ['US', 'UK'] },
      { id: 9, name: 'Apple Store', logo: 'applestore.png', categories: ['US', 'UK'] },
      { id: 10, name: 'Visa', logo: 'visa.png', categories: ['US', 'UK', 'NG'] }
    ];
  }
}

module.exports = new ReloadlyService();