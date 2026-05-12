const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/auth');
const { createNotification } = require('../services/notifications');
const { logAuditEvent } = require('../services/audit');
const dojahService = require('../services/dojah');

/**
 * Get KYC verification methods
 */
router.get('/verification-methods', (req, res) => {
  try {
    const methods = dojahService.getVerificationMethods();
    res.json({
      methods,
      supportedIdTypes: dojahService.getSupportedIdTypes()
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching verification methods' });
  }
});

/**
 * Verify BVN
 */
router.post('/verify-bvn', authMiddleware, [
  body('bvn').isLength({ min: 11, max: 11 }).isNumeric()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { bvn } = req.body;
    const user = await User.findById(req.userId);

    const result = await dojahService.verifyBvn({
      bvn,
      firstName: user.firstName,
      lastName: user.lastName,
      phoneNumber: user.phone
    });

    if (!result.success) {
      return res.status(400).json({ 
        message: 'BVN verification failed',
        error: result.error 
      });
    }

    user.bvn = bvn;
    user.kycVerificationDetails = user.kycVerificationDetails || {};
    user.kycVerificationDetails.bvn = result.data;
    
    if (user.nin) {
      user.kycLevel = 2;
      user.kycVerified = true;
      user.kycVerifiedAt = new Date();
    } else {
      user.kycLevel = 1;
    }

    await user.save();

    await createNotification({
      user,
      type: 'security',
      title: 'BVN verified',
      body: 'Your Bank Verification Number has been successfully verified.',
      sendEmail: true
    });

    await logAuditEvent(req, {
      actorUserId: user._id,
      actorEmail: user.email,
      action: 'bvn_verified',
      entityType: 'user',
      entityId: user._id,
      metadata: { bvn }
    });

    res.json({
      message: 'BVN verified successfully',
      data: result.data,
      kycLevel: user.kycLevel,
      kycVerified: user.kycVerified
    });
  } catch (error) {
    console.error('BVN verification error:', error);
    res.status(500).json({ message: 'Server error during BVN verification' });
  }
});

/**
 * Verify NIN
 */
router.post('/verify-nin', authMiddleware, [
  body('nin').isLength({ min: 11, max: 11 }).isNumeric()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { nin } = req.body;
    const user = await User.findById(req.userId);

    const result = await dojahService.verifyNin({
      nin,
      firstName: user.firstName,
      lastName: user.lastName
    });

    if (!result.success) {
      return res.status(400).json({ 
        message: 'NIN verification failed',
        error: result.error 
      });
    }

    user.nin = nin;
    user.kycVerificationDetails = user.kycVerificationDetails || {};
    user.kycVerificationDetails.nin = result.data;
    
    if (user.bvn) {
      user.kycLevel = 2;
      user.kycVerified = true;
      user.kycVerifiedAt = new Date();
    } else {
      user.kycLevel = 1;
    }

    await user.save();

    await createNotification({
      user,
      type: 'security',
      title: 'NIN verified',
      body: 'Your National Identification Number has been successfully verified.',
      sendEmail: true
    });

    await logAuditEvent(req, {
      actorUserId: user._id,
      actorEmail: user.email,
      action: 'nin_verified',
      entityType: 'user',
      entityId: user._id,
      metadata: { nin }
    });

    res.json({
      message: 'NIN verified successfully',
      data: result.data,
      kycLevel: user.kycLevel,
      kycVerified: user.kycVerified
    });
  } catch (error) {
    console.error('NIN verification error:', error);
    res.status(500).json({ message: 'Server error during NIN verification' });
  }
});

/**
 * Verify Selfie with BVN
 */
router.post('/verify-selfie-bvn', authMiddleware, [
  body('bvn').isLength({ min: 11, max: 11 }).isNumeric(),
  body('selfieImage').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { bvn, selfieImage } = req.body;
    const user = await User.findById(req.userId);

    const result = await dojahService.verifySelfieWithBvn({
      bvn,
      selfieImage
    });

    if (!result.success) {
      return res.status(400).json({ 
        message: 'Selfie verification failed',
        error: result.error 
      });
    }

    user.bvn = bvn;
    user.kycVerificationDetails = user.kycVerificationDetails || {};
    user.kycVerificationDetails.selfieBvn = result.data;
    
    if (user.nin) {
      user.kycLevel = 2;
      user.kycVerified = true;
      user.kycVerifiedAt = new Date();
    }

    await user.save();

    await createNotification({
      user,
      type: 'security',
      title: 'Selfie verification successful',
      body: 'Your identity has been successfully verified with your BVN.',
      sendEmail: true
    });

    await logAuditEvent(req, {
      actorUserId: user._id,
      actorEmail: user.email,
      action: 'selfie_bvn_verified',
      entityType: 'user',
      entityId: user._id,
      metadata: { matchScore: result.matchScore }
    });

    res.json({
      message: 'Selfie verification successful',
      data: result.data,
      matchScore: result.matchScore,
      kycLevel: user.kycLevel,
      kycVerified: user.kycVerified
    });
  } catch (error) {
    console.error('Selfie verification error:', error);
    res.status(500).json({ message: 'Server error during selfie verification' });
  }
});

/**
 * Verify Selfie with NIN
 */
router.post('/verify-selfie-nin', authMiddleware, [
  body('nin').isLength({ min: 11, max: 11 }).isNumeric(),
  body('selfieImage').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { nin, selfieImage } = req.body;
    const user = await User.findById(req.userId);

    const result = await dojahService.verifySelfieWithNin({
      nin,
      selfieImage
    });

    if (!result.success) {
      return res.status(400).json({ 
        message: 'Selfie verification failed',
        error: result.error 
      });
    }

    user.nin = nin;
    user.kycVerificationDetails = user.kycVerificationDetails || {};
    user.kycVerificationDetails.selfieNin = result.data;
    
    if (user.bvn) {
      user.kycLevel = 2;
      user.kycVerified = true;
      user.kycVerifiedAt = new Date();
    }

    await user.save();

    await createNotification({
      user,
      type: 'security',
      title: 'Selfie verification successful',
      body: 'Your identity has been successfully verified with your NIN.',
      sendEmail: true
    });

    await logAuditEvent(req, {
      actorUserId: user._id,
      actorEmail: user.email,
      action: 'selfie_nin_verified',
      entityType: 'user',
      entityId: user._id,
      metadata: { matchScore: result.matchScore }
    });

    res.json({
      message: 'Selfie verification successful',
      data: result.data,
      matchScore: result.matchScore,
      kycLevel: user.kycLevel,
      kycVerified: user.kycVerified
    });
  } catch (error) {
    console.error('Selfie verification error:', error);
    res.status(500).json({ message: 'Server error during selfie verification' });
  }
});

/**
 * Check Liveness
 */
router.post('/check-liveness', authMiddleware, [
  body('selfieImage').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { selfieImage } = req.body;

    const result = await dojahService.checkLiveness({
      selfieImage
    });

    if (!result.success) {
      return res.status(400).json({ 
        message: 'Liveness check failed',
        error: result.error 
      });
    }

    res.json({
      message: 'Liveness check completed',
      isLive: result.isLive,
      data: result.data
    });
  } catch (error) {
    console.error('Liveness check error:', error);
    res.status(500).json({ message: 'Server error during liveness check' });
  }
});

/**
 * Get user KYC status
 */
router.get('/kyc-status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('kycVerified kycLevel bvn nin kycVerifiedAt kycVerificationDetails');
    
    res.json({
      kycVerified: user.kycVerified,
      kycLevel: user.kycLevel,
      kycVerifiedAt: user.kycVerifiedAt,
      hasBvn: !!user.bvn,
      hasNin: !!user.nin,
      verificationDetails: {
        bvn: user.kycVerificationDetails?.bvn ? {
          firstName: user.kycVerificationDetails.bvn.firstName,
          lastName: user.kycVerificationDetails.bvn.lastName,
          verified: true
        } : null,
        nin: user.kycVerificationDetails?.nin ? {
          firstName: user.kycVerificationDetails.nin.firstName,
          lastName: user.kycVerificationDetails.nin.lastName,
          verified: true
        } : null
      }
    });
  } catch (error) {
    console.error('Error fetching KYC status:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
