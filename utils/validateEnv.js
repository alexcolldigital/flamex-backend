/**
 * Environment Validator
 * Ensures all required environment variables are set for production
 */

const requiredEnv = [
  'MONGODB_URI',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'NODE_ENV',
  'PORT',
  'FRONTEND_URL',
  'API_URL'
];

const optionalEnv = [
  'FLUTTERWAVE_PUBLIC_KEY',
  'FLUTTERWAVE_SECRET_KEY',
  'FLUTTERWAVE_ENCRYPTION_KEY',
  'THIRDWEB_SECRET_KEY',
  'LIFI_API_KEY',
  'ALCHEMY_API_KEY',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'REDIS_URL',
  'SENTRY_DSN',
  'LOG_LEVEL'
];

const validateEnvironment = () => {
  const missing = [];
  const warnings = [];

  // Check required variables
  requiredEnv.forEach(key => {
    if (!process.env[key]) {
      missing.push(key);
    }
  });

  // Check optional variables (production warning)
  if (process.env.NODE_ENV === 'production') {
    optionalEnv.forEach(key => {
      if (!process.env[key]) {
        warnings.push(`⚠️  Optional env variable missing: ${key}`);
      }
    });
  }

  // Validate specific values
  if (process.env.NODE_ENV && !['development', 'staging', 'production'].includes(process.env.NODE_ENV)) {
    missing.push('NODE_ENV must be one of: development, staging, production');
  }

  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    missing.push('JWT_SECRET must be at least 32 characters');
  }

  if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length < 32) {
    missing.push('ENCRYPTION_KEY must be at least 32 characters');
  }

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(m => console.error(`   - ${m}`));
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️  Environment Warnings:');
    warnings.forEach(w => console.warn(`   ${w}`));
  }

  return true;
};

module.exports = { validateEnvironment };
