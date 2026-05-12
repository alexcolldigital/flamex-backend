/**
 * Dojah Service
 * KYC & Identity Verification
 * Docs: https://docs.dojah.io/
 */

const axios = require('axios');
const crypto = require('crypto');

class DojahService {
  constructor() {
    this.baseUrl = 'https://api.dojah.io/api/v1';
    this.appId = process.env.DOJAH_APP_ID;
    this.apiKey = process.env.DOJAH_API_KEY;
    this.webhookSecret = process.env.DOJAH_WEBHOOK_SECRET || process.env.DOJAH_API_KEY;
    this.isConfigured = !!(this.appId && this.apiKey);
  }

  /**
   * Get authorization headers
   */
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': this.apiKey,
      'AppId': this.appId
    };
  }

  verifyWebhookSignature(payload, headers = {}, rawBody = null) {
    const signature = headers['x-dojah-signature'] || headers['X-Dojah-Signature'];
    const signatureV2 = headers['x-dojah-signature-v2'] || headers['X-Dojah-Signature-V2'];

    if (signature) {
      const expected = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(rawBody || JSON.stringify(payload))
        .digest('hex');

      return {
        valid: signature === expected,
        mode: 'payload',
        expected,
        received: signature
      };
    }

    if (signatureV2) {
      const expected = crypto.createHash('sha256').update(this.webhookSecret).digest('hex');
      return {
        valid: signatureV2 === expected,
        mode: 'secret',
        expected,
        received: signatureV2
      };
    }

    return { valid: false, mode: 'missing', error: 'Missing Dojah signature header' };
  }

  async subscribeWebhook({ webhook, service }) {
    if (!this.isConfigured) {
      return { success: false, error: 'Dojah not configured' };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/webhook/subscribe`,
        { webhook, service },
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error('Dojah webhook subscribe error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Verify BVN (Bank Verification Number)
   * @param {object} params - BVN parameters
   */
  async verifyBvn(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Dojah not configured' };
    }

    const { bvn, firstName, lastName, phoneNumber, dob } = params;

    try {
      // First, get basic BVN info
      const response = await axios.get(
        `${this.baseUrl}/kyc/bvn`,
        {
          params: { bvn },
          headers: this.getHeaders()
        }
      );

      if (response.data?.status === 'success') {
        const data = response.data.data || response.data;
        
        // Verify the details match (optional validation)
        const bvnData = {
          bvn: bvn,
          firstName: data.firstName || data.first_name,
          lastName: data.lastName || data.last_name,
          phoneNumber: data.phoneNumber || data.phone_number,
          dob: data.dateOfBirth || data.dob,
          verified: true,
          verificationLevel: 'basic'
        };

        return {
          success: true,
          data: bvnData,
          message: 'BVN verified successfully'
        };
      } else {
        return {
          success: false,
          error: response.data?.message || 'BVN verification failed'
        };
      }
    } catch (error) {
      console.error('Dojah BVN error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Verify NIN (National Identification Number)
   * @param {object} params - NIN parameters
   */
  async verifyNin(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Dojah not configured' };
    }

    const { nin, firstName, lastName } = params;

    try {
      // Get NIN information
      const response = await axios.get(
        `${this.baseUrl}/kyc/nin`,
        {
          params: { nin },
          headers: this.getHeaders()
        }
      );

      if (response.data?.status === 'success') {
        const data = response.data.data || response.data;
        
        const ninData = {
          nin: nin,
          firstName: data.firstName || data.first_name,
          lastName: data.lastName || data.last_name,
          dateOfBirth: data.dateOfBirth || data.dob,
          gender: data.gender,
          verified: true,
          verificationLevel: 'basic'
        };

        return {
          success: true,
          data: ninData,
          message: 'NIN verified successfully'
        };
      } else {
        return {
          success: false,
          error: response.data?.message || 'NIN verification failed'
        };
      }
    } catch (error) {
      console.error('Dojah NIN error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Verify Selfie with BVN
   * @param {object} params - Selfie verification parameters
   */
  async verifySelfieWithBvn(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Dojah not configured' };
    }

    const { bvn, selfieImage } = params;

    try {
      const formData = new FormData();
      formData.append('bvn', bvn);
      formData.append('image', selfieImage); // Should be base64 or file

      const response = await axios.post(
        `${this.baseUrl}/kyc/bvn/verify`,
        formData,
        {
          headers: {
            ...this.getHeaders(),
            'Content-Type': 'multipart/form-data'
          }
        }
      );

      if (response.data?.status === 'success') {
        return {
          success: true,
          data: response.data.data,
          message: 'Selfie verification successful',
          matchScore: response.data.data?.matchScore
        };
      } else {
        return {
          success: false,
          error: response.data?.message || 'Selfie verification failed'
        };
      }
    } catch (error) {
      console.error('Dojah selfie error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Verify Selfie with NIN
   * @param {object} params - Selfie NIN verification parameters
   */
  async verifySelfieWithNin(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Dojah not configured' };
    }

    const { nin, selfieImage } = params;

    try {
      const formData = new FormData();
      formData.append('nin', nin);
      formData.append('image', selfieImage); // Should be base64 or file

      const response = await axios.post(
        `${this.baseUrl}/kyc/nin/verify`,
        formData,
        {
          headers: {
            ...this.getHeaders(),
            'Content-Type': 'multipart/form-data'
          }
        }
      );

      if (response.data?.status === 'success') {
        return {
          success: true,
          data: response.data.data,
          message: 'Selfie NIN verification successful',
          matchScore: response.data.data?.matchScore
        };
      } else {
        return {
          success: false,
          error: response.data?.message || 'Selfie NIN verification failed'
        };
      }
    } catch (error) {
      console.error('Dojah selfie NIN error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Verify Document/Photo ID
   * @param {object} params - Document verification parameters
   */
  async verifyDocument(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Dojah not configured' };
    }

    const { documentImage, selfieImage, documentType } = params;

    try {
      const response = await axios.post(
        `${this.baseUrl}/kyc/photoid/verify`,
        {
          document_image: documentImage,
          selfie_image: selfieImage,
          document_type: documentType // 'passport', 'drivers_license', 'national_id', etc.
        },
        { headers: this.getHeaders() }
      );

      if (response.data?.status === 'success') {
        return {
          success: true,
          data: response.data.data,
          message: 'Document verification successful'
        };
      } else {
        return {
          success: false,
          error: response.data?.message || 'Document verification failed'
        };
      }
    } catch (error) {
      console.error('Dojah document error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get Drivers License info
   * @param {string} dlNumber - Driver's license number
   */
  async getDriversLicense(dlNumber) {
    if (!this.isConfigured) {
      return { success: false, error: 'Dojah not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/kyc/dl`,
        {
          params: { dl_number: dlNumber },
          headers: this.getHeaders()
        }
      );

      if (response.data?.status === 'success') {
        return {
          success: true,
          data: response.data.data,
          message: "Driver's License info retrieved"
        };
      } else {
        return {
          success: false,
          error: response.data?.message || "Driver's License lookup failed"
        };
      }
    } catch (error) {
      console.error("Dojah driver's license error:", error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get Passport info
   * @param {string} passportNumber - Passport number
   */
  async getPassport(passportNumber) {
    if (!this.isConfigured) {
      return { success: false, error: 'Dojah not configured' };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/kyc/passport`,
        {
          params: { passport_number: passportNumber },
          headers: this.getHeaders()
        }
      );

      if (response.data?.status === 'success') {
        return {
          success: true,
          data: response.data.data,
          message: 'Passport info retrieved'
        };
      } else {
        return {
          success: false,
          error: response.data?.message || 'Passport lookup failed'
        };
      }
    } catch (error) {
      console.error('Dojah passport error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Liveness check
   * @param {object} params - Liveness check parameters
   */
  async checkLiveness(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Dojah not configured' };
    }

    const { selfieImage } = params;

    try {
      const response = await axios.post(
        `${this.baseUrl}/ml/liveness`,
        { image: selfieImage },
        { headers: this.getHeaders() }
      );

      if (response.data?.status === 'success') {
        return {
          success: true,
          data: response.data.data,
          isLive: response.data.data?.is_live || response.data.data?.liveness_score > 0.7,
          message: 'Liveness check completed'
        };
      } else {
        return {
          success: false,
          error: response.data?.message || 'Liveness check failed'
        };
      }
    } catch (error) {
      console.error('Dojah liveness error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get supported ID types
   */
  getSupportedIdTypes() {
    return [
      { id: 'BVN', name: 'Bank Verification Number', country: 'NG' },
      { id: 'NIN', name: 'National Identity Number', country: 'NG' },
      { id: 'PASSPORT', name: 'International Passport', country: 'NG' },
      { id: 'DRIVERS_LICENSE', name: "Driver's License", country: 'NG' },
      { id: 'VOTER_ID', name: 'Voter ID', country: 'NG' }
    ];
  }

  /**
   * Get verification methods
   */
  getVerificationMethods() {
    return [
      { id: 'bvn', name: 'BVN Verification', description: 'Verify Bank Verification Number' },
      { id: 'nin', name: 'NIN Verification', description: 'National Identity Number verification' },
      { id: 'selfie_bvn', name: 'Selfie + BVN', description: 'Face verification with BVN' },
      { id: 'selfie_nin', name: 'Selfie + NIN', description: 'Face verification with NIN' },
      { id: 'document', name: 'Document Verification', description: 'Photo ID document verification' },
      { id: 'liveness', name: 'Liveness Check', description: 'Face liveness verification' }
    ];
  }
}

module.exports = new DojahService();
