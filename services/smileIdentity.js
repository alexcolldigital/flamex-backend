/**
 * Smile Identity Service
 * KYC & Identity Verification
 * Docs: https://docs.smileidentity.com/
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class SmileIdentityService {
  constructor() {
    this.baseUrl = 'https://api.smileidentity.com/v1';
    this.partnerId = process.env.SMILE_IDENTITY_PARTNER_ID;
    this.apiKey = process.env.SMILE_IDENTITY_API_KEY;
    this.isConfigured = !!(this.partnerId && this.apiKey);
  }

  /**
   * Generate signature for API calls
   * @param {string} timestamp - Timestamp
   */
  generateSignature(timestamp) {
    if (!this.isConfigured) {
      throw new Error('Smile Identity not configured');
    }

    const data = `${this.partnerId}:${timestamp}:${this.apiKey}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Get headers for API calls
   */
  getHeaders(timestamp) {
    return {
      'Content-Type': 'application/json',
      'partner_id': this.partnerId,
      'timestamp': timestamp,
      'signature': this.generateSignature(timestamp)
    };
  }

  /**
   * Submit job for verification
   * @param {object} params - Job parameters
   */
  async submitJob(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Smile Identity not configured' };
    }

    const {
      userId,
      jobType, // 1 = BVN, 2 = Basic ID, 3 = Selfie, 4 = Document
      firstName,
      lastName,
      phoneNumber,
      country,
      idType,
      idNumber,
      imageTypeId, // 2 = Selfie, 3 = Document front, 4 = Document back
      image
    } = params;

    const timestamp = new Date().toISOString();

    try {
      const response = await axios.post(
        `${this.baseUrl}/jobs`,
        {
          partner_id: this.partnerId,
          user_id: userId,
          job_type: jobType,
          job_id: `FLAMEX_${Date.now()}`,
          first_name: firstName,
          last_name: lastName,
          phone_number: phoneNumber,
          country: country || 'NG',
          id_type: idType || 'BVN',
          id_number: idNumber,
          image_type_id: imageTypeId,
          image: image, // Base64 encoded image
          timestamp
        },
        { headers: this.getHeaders(timestamp) }
      );

      return {
        success: true,
        data: response.data,
        message: response.data?.message || 'Job submitted'
      };
    } catch (error) {
      console.error('Smile Identity job error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Verify BVN
   * @param {object} params - BVN parameters
   */
  async verifyBvn(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Smile Identity not configured' };
    }

    const {
      userId,
      bvn,
      firstName,
      lastName,
      phoneNumber,
      dob
    } = params;

    const timestamp = new Date().toISOString();

    try {
      const response = await axios.post(
        `${this.baseUrl}/kyc/bvn`,
        {
          partner_id: this.partnerId,
          user_id: userId,
          bvn,
          first_name: firstName,
          last_name: lastName,
          phone_number: phoneNumber,
          dob: dob, // Format: YYYY-MM-DD
          timestamp
        },
        { headers: this.getHeaders(timestamp) }
      );

      return {
        success: true,
        data: response.data,
        message: response.data?.message || 'BVN verified'
      };
    } catch (error) {
      console.error('Smile Identity BVN error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get job status
   * @param {string} jobId - Job ID
   */
  async getJobStatus(jobId) {
    if (!this.isConfigured) {
      return { success: false, error: 'Smile Identity not configured' };
    }

    const timestamp = new Date().toISOString();

    try {
      const response = await axios.get(
        `${this.baseUrl}/jobs/${jobId}`,
        {
          params: { partner_id: this.partnerId },
          headers: this.getHeaders(timestamp)
        }
      );

      return {
        success: true,
        data: response.data,
        status: response.data?.job_status,
        result: response.data?.result
      };
    } catch (error) {
      console.error('Smile Identity status error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Upload document
   * @param {object} params - Document parameters
   */
  async uploadDocument(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Smile Identity not configured' };
    }

    const {
      userId,
      documentType, // 'PASSPORT', 'NIN', 'DRIVERS_LICENSE', 'VOTER_ID'
      documentImage, // Base64 encoded
      country
    } = params;

    const timestamp = new Date().toISOString();

    try {
      const response = await axios.post(
        `${this.baseUrl}/documents`,
        {
          partner_id: this.partnerId,
          user_id: userId,
          document_type: documentType,
          country: country || 'NG',
          document_image: documentImage,
          timestamp
        },
        { headers: this.getHeaders(timestamp) }
      );

      return {
        success: true,
        data: response.data,
        message: response.data?.message || 'Document uploaded'
      };
    } catch (error) {
      console.error('Smile Identity document error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Verify identity
   * @param {object} params - Verification parameters
   */
  async verifyIdentity(params) {
    if (!this.isConfigured) {
      return { success: false, error: 'Smile Identity not configured' };
    }

    const {
      userId,
      firstName,
      lastName,
      idNumber,
      idType,
      country
    } = params;

    const timestamp = new Date().toISOString();

    try {
      const response = await axios.post(
        `${this.baseUrl}/verifications/identity`,
        {
          partner_id: this.partnerId,
          user_id: userId,
          first_name: firstName,
          last_name: lastName,
          id_number: idNumber,
          id_type: idType || 'BVN',
          country: country || 'NG',
          timestamp
        },
        { headers: this.getHeaders(timestamp) }
      );

      return {
        success: true,
        data: response.data,
        message: response.data?.message || 'Identity verified'
      };
    } catch (error) {
      console.error('Smile Identity verify error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
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
   * Get job types
   */
  getJobTypes() {
    return [
      { id: 1, name: 'BVN Verification', description: 'Verify Bank Verification Number' },
      { id: 2, name: 'Basic ID Verification', description: 'Basic identity verification' },
      { id: 3, name: 'Selfie Verification', description: 'Face verification with liveness check' },
      { id: 4, name: 'Document Verification', description: 'Verify government issued documents' }
    ];
  }
}

module.exports = new SmileIdentityService();