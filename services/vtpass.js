/**
 * VTpass Service
 * Bill Payments (Airtime, Data, Utilities)
 * Docs: https://www.vtpass.com/documentation
 */

const axios = require('axios');

class VTpassService {
  constructor() {
    this.baseUrl = 'https://vtpass.com/api';
    this.email = process.env.VTPASS_EMAIL;
    this.password = process.env.VTPASS_PASSWORD;
    this.serviceId = process.env.VTPASS_SERVICE_ID;
    this.isConfigured = !!(this.email && this.password);
  }

  /**
   * Get authentication token
   */
  async getAuthToken() {
    if (!this.isConfigured) {
      return { success: false, error: 'VTpass not configured' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/login`,
        {
          email: this.email,
          password: this.password
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        token: response.data.token,
        expiresIn: response.data.expiresAt
      };
    } catch (error) {
      console.error('VTpass auth error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get headers for API calls
   */
  getHeaders(token) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };
  }

  /**
   * Get service categories
   */
  async getServiceCategories(token) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/service-categories`,
        { headers: this.getHeaders(token) }
      );

      return {
        success: true,
        categories: response.data
      };
    } catch (error) {
      console.error('VTpass categories error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get services (variations)
   * @param {string} token - Auth token
   * @param {string} serviceId - Service ID
   */
  async getServices(token, serviceId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/services?variation=${serviceId}`,
        { headers: this.getHeaders(token) }
      );

      return {
        success: true,
        services: response.data
      };
    } catch (error) {
      console.error('VTpass services error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Buy airtime
   * @param {object} params - Purchase parameters
   */
  async buyAirtime(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'VTpass not configured' };
    }

    const { phone, amount, network, token } = params;

    try {
      const response = await axios.post(
        `${this.baseUrl}/pay`,
        {
          serviceID: network || 'mtn',
          billersCode: phone,
          amount: amount.toString(),
          phone: phone,
          request_id: `FLAMEX_AIRTIME_${Date.now()}`
        },
        { headers: this.getHeaders(token) }
      );

      return {
        success: true,
        data: response.data,
        message: response.data?.response_description || 'Airtime purchased'
      };
    } catch (error) {
      console.error('VTpass airtime error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Buy data bundle
   * @param {object} params - Purchase parameters
   */
  async buyData(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'VTpass not configured' };
    }

    const { phone, amount, network, variationCode, token } = params;

    try {
      const response = await axios.post(
        `${this.baseUrl}/pay`,
        {
          serviceID: network || 'mtn-data',
          billersCode: phone,
          amount: amount.toString(),
          variation_code: variationCode,
          phone: phone,
          request_id: `FLAMEX_DATA_${Date.now()}`
        },
        { headers: this.getHeaders(token) }
      );

      return {
        success: true,
        data: response.data,
        message: response.data?.response_description || 'Data purchased'
      };
    } catch (error) {
      console.error('VTpass data error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Pay electricity bill
   * @param {object} params - Payment parameters
   */
  async payElectricity(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'VTpass not configured' };
    }

    const {
      disco, // e.g., 'eko-electric', 'ikeja-electric', 'portharcourt-electric'
      meterNumber,
      amount,
      phone,
      token
    } = params;

    try {
      const response = await axios.post(
        `${this.baseUrl}/pay`,
        {
          serviceID: disco,
          billersCode: meterNumber,
          amount: amount.toString(),
          phone: phone,
          request_id: `FLAMEX_ELECTRICITY_${Date.now()}`
        },
        { headers: this.getHeaders(token) }
      );

      return {
        success: true,
        data: response.data,
        message: response.data?.response_description || 'Electricity bill paid'
      };
    } catch (error) {
      console.error('VTpass electricity error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Pay cable TV
   * @param {object} params - Payment parameters
   */
  async payCableTv(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'VTpass not configured' };
    }

    const {
      service, // 'dstv', 'gotv', 'startimes'
      smartCardNumber,
      amount,
      variationCode,
      phone,
      token
    } = params;

    try {
      const response = await axios.post(
        `${this.baseUrl}/pay`,
        {
          serviceID: service,
          billersCode: smartCardNumber,
          amount: amount.toString(),
          variation_code: variationCode,
          phone: phone,
          request_id: `FLAMEX_CABLE_${Date.now()}`
        },
        { headers: this.getHeaders(token) }
      );

      return {
        success: true,
        data: response.data,
        message: response.data?.response_description || 'Cable TV bill paid'
      };
    } catch (error) {
      console.error('VTpass cable error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Verify meter number
   * @param {string} token - Auth token
   * @param {string} disco - Disco name
   * @param {string} meterNumber - Meter number
   */
  async verifyMeter(token, disco, meterNumber) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/verify?serviceID=${disco}&billersCode=${meterNumber}`,
        { headers: this.getHeaders(token) }
      );

      return {
        success: true,
        data: response.data,
        name: response.data?.name,
        address: response.data?.address
      };
    } catch (error) {
      console.error('VTpass verify meter error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Verify smart card number
   * @param {string} token - Auth token
   * @param {string} service - Service name
   * @param {string} smartCardNumber - Smart card number
   */
  async verifySmartCard(token, service, smartCardNumber) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/verify?serviceID=${service}&billersCode=${smartCardNumber}`,
        { headers: this.getHeaders(token) }
      );

      return {
        success: true,
        data: response.data,
        name: response.data?.name,
        customerNumber: response.data?.Customer_Number
      };
    } catch (error) {
      console.error('VTpass verify card error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get transaction status
   * @param {string} token - Auth token
   * @param {string} requestId - Request ID
   */
  async getTransactionStatus(token, requestId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/transactions/${requestId}`,
        { headers: this.getHeaders(token) }
      );

      return {
        success: true,
        data: response.data,
        status: response.data?.status,
        amount: response.data?.amount
      };
    } catch (error) {
      console.error('VTpass transaction status error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get available networks
   */
  getNetworks() {
    return [
      { id: 'mtn', name: 'MTN', code: 'mtn' },
      { id: 'airtel', name: 'Airtel', code: 'airtel' },
      { id: '9mobile', name: '9mobile', code: '9mobile' },
      { id: 'glo', name: 'Glo', code: 'glo' }
    ];
  }

  /**
   * Get electricity providers
   */
  getElectricityProviders() {
    return [
      { id: 'abuja-electric', name: 'Abuja Electricity' },
      { id: 'benin-electric', name: 'Benin Electricity' },
      { id: 'eko-electric', name: 'Eko Electricity' },
      { id: 'enugu-electric', name: 'Enugu Electricity' },
      { id: 'ibadan-electric', name: 'Ibadan Electricity' },
      { id: 'ikeja-electric', name: 'Ikeja Electricity' },
      { id: 'jos-electric', name: 'Jos Electricity' },
      { id: 'kaduna-electric', name: 'Kaduna Electricity' },
      { id: 'kano-electric', name: 'Kano Electricity' },
      { id: 'portharcourt-electric', name: 'Port Harcourt Electricity' }
    ];
  }

  /**
   * Get cable TV providers
   */
  getCableProviders() {
    return [
      { id: 'dstv', name: 'DStv' },
      { id: 'gotv', name: 'GOtv' },
      { id: 'startimes', name: 'StarTimes' }
    ];
  }
}

module.exports = new VTpassService();