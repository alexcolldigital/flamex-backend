const { getPlatformSettings } = require('../utils/admin');

async function maintenanceGuard(req, res, next) {
  try {
    if (!req.path.startsWith('/api/')) {
      return next();
    }

    const exemptPaths = [
      '/health',
      '/api/auth/admin/login',
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/request-email-otp',
      '/api/auth/verify-email-otp'
    ];

    if (exemptPaths.includes(req.path)) {
      return next();
    }

    const settings = await getPlatformSettings();
    if (settings.maintenanceMode) {
      return res.status(503).json({ message: 'Platform is currently under maintenance' });
    }

    req.platformSettings = settings;
    next();
  } catch (error) {
    next();
  }
}

module.exports = { maintenanceGuard };
