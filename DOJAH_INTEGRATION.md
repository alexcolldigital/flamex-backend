# Dojah KYC Integration Guide

## Overview

This document outlines the migration from **Smile Identity** to **Dojah SDK** for KYC (Know Your Customer) verification in the FlameX backend.

## What Changed

### 1. Service Implementation
- **Old**: `services/smileIdentity.js` (Smile Identity API)
- **New**: `services/dojah.js` (Dojah SDK)

The Dojah service provides the same KYC functionality with improved features and better support for Nigerian identity verification.

### 2. Environment Variables

**Before (.env)**
```
SMILE_IDENTITY_PARTNER_ID=your_smile_partner_id
SMILE_IDENTITY_API_KEY=your_smile_api_key
```

**After (.env)**
```
DOJAH_APP_ID=your_dojah_app_id
DOJAH_API_KEY=your_dojah_api_key
```

### 3. API Endpoints

#### New Verification Routes
All endpoints are prefixed with `/api/verification/`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/verification-methods` | Get available verification methods |
| POST | `/verify-bvn` | Verify Bank Verification Number |
| POST | `/verify-nin` | Verify National Identity Number |
| POST | `/verify-selfie-bvn` | Verify selfie against BVN |
| POST | `/verify-selfie-nin` | Verify selfie against NIN |
| POST | `/check-liveness` | Check face liveness |
| GET | `/kyc-status` | Get user's KYC status |

#### Updated Auth Routes

**POST `/api/auth/kyc`** - Enhanced with Dojah verification
- Now performs real-time verification with Dojah
- Returns verification details
- Validates both BVN and NIN

### 4. Dojah Service Methods

```javascript
// Verify BVN
await dojahService.verifyBvn({
  bvn: '12345678901',
  firstName: 'John',
  lastName: 'Doe',
  phoneNumber: '+2348000000000'
})

// Verify NIN
await dojahService.verifyNin({
  nin: '12345678901',
  firstName: 'John',
  lastName: 'Doe'
})

// Verify Selfie with BVN
await dojahService.verifySelfieWithBvn({
  bvn: '12345678901',
  selfieImage: 'base64-encoded-image'
})

// Check Liveness
await dojahService.checkLiveness({
  selfieImage: 'base64-encoded-image'
})

// Get Drivers License
await dojahService.getDriversLicense('DL123456')

// Get Passport Info
await dojahService.getPassport('A12345678')
```

### 5. User Model Changes

New fields added to User model for Dojah integration:

```javascript
{
  // ... existing fields
  bvn: String,                           // Bank Verification Number
  nin: String,                           // National Identity Number
  kycLevel: Number,                      // 0: none, 1: partial, 2: full
  kycVerified: Boolean,                  // Is KYC verified
  kycVerifiedAt: Date,                   // Verification timestamp
  kycVerificationDetails: {              // Verification data from Dojah
    bvn: Object,                         // BVN verification data
    nin: Object,                         // NIN verification data
    selfieBvn: Object,                   // Selfie + BVN verification
    selfieNin: Object                    // Selfie + NIN verification
  }
}
```

## Setup Instructions

### 1. Get Dojah Credentials

1. Visit [Dojah Dashboard](https://dashboard.dojah.io/)
2. Create an account or sign in
3. Generate API credentials
4. Copy your `APP_ID` and `API_KEY`

### 2. Update Environment Variables

```bash
# .env file
DOJAH_APP_ID=your_app_id_here
DOJAH_API_KEY=your_api_key_here
```

### 3. Install Dependencies (if needed)

```bash
npm install axios
```

### 4. Test the Integration

```javascript
// Test BVN verification
curl -X POST http://localhost:5000/api/verification/verify-bvn \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "bvn": "12345678901" }'

// Test KYC status
curl -X GET http://localhost:5000/api/verification/kyc-status \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Verification Levels

- **Level 0**: No KYC
- **Level 1**: Partial KYC (BVN or NIN verified)
- **Level 2**: Full KYC (Both BVN and NIN verified)

## API Response Examples

### BVN Verification Success
```json
{
  "success": true,
  "data": {
    "bvn": "12345678901",
    "firstName": "John",
    "lastName": "Doe",
    "phoneNumber": "+2348000000000",
    "dob": "1990-01-01",
    "verified": true,
    "verificationLevel": "basic"
  },
  "message": "BVN verified successfully"
}
```

### Selfie Verification Success
```json
{
  "success": true,
  "data": {
    "verified": true,
    "livenessScore": 0.95
  },
  "message": "Selfie verification successful",
  "matchScore": 0.92
}
```

### KYC Status Response
```json
{
  "kycVerified": true,
  "kycLevel": 2,
  "kycVerifiedAt": "2024-05-07T10:30:00Z",
  "hasBvn": true,
  "hasNin": true,
  "verificationDetails": {
    "bvn": {
      "firstName": "John",
      "lastName": "Doe",
      "verified": true
    },
    "nin": {
      "firstName": "John",
      "lastName": "Doe",
      "verified": true
    }
  }
}
```

## Error Handling

The Dojah service returns standardized error responses:

```json
{
  "success": false,
  "error": "Invalid BVN format",
  "message": "BVN verification failed"
}
```

Common errors:
- `Invalid BVN format` - BVN must be 11 digits
- `Invalid NIN format` - NIN must be 11 digits
- `Verification failed` - Data doesn't match records
- `Dojah not configured` - Missing API credentials

## Migration Checklist

- [x] Create Dojah service (`services/dojah.js`)
- [x] Update environment variables
- [x] Create verification routes (`routes/verification.js`)
- [x] Update auth routes with Dojah integration
- [x] Add verification route to server.js
- [x] Update User model schema (if needed)
- [x] Update .env.example
- [ ] Update frontend to use new verification endpoints
- [ ] Test all verification flows
- [ ] Deploy to staging
- [ ] Deploy to production

## Support

For issues with Dojah integration:
1. Check [Dojah Documentation](https://docs.dojah.io/)
2. Verify API credentials
3. Check network connectivity
4. Review error logs in application

## Rate Limits

Be aware of Dojah API rate limits:
- Standard plan: Check your Dojah dashboard for limits
- Implement retry logic with exponential backoff
- Cache verification results where appropriate

## Security Notes

1. **Never expose API keys**: Keep credentials in environment variables only
2. **Use HTTPS**: Always use HTTPS in production
3. **Validate inputs**: Server-side validation is required
4. **Audit logging**: All verification attempts are logged
5. **Data retention**: Store verification results securely

## Next Steps

1. Integrate Dojah widgets in frontend for better UX
2. Implement additional verification methods (liveness, selfie)
3. Add KYC rejection and resubmission flow
4. Implement KYC expiration and renewal
5. Add analytics and reporting for KYC metrics
