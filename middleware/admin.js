const { isAdminUser } = require('../utils/admin');

const adminMiddleware = (req, res, next) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ message: 'Admin access required' });
  }

  next();
};

module.exports = { adminMiddleware };
