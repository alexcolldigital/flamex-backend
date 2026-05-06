const AuditLog = require('../models/AuditLog');

async function logAuditEvent(req, {
  actorUserId = null,
  actorEmail = null,
  action,
  entityType,
  entityId = null,
  severity = 'info',
  metadata = {}
}) {
  try {
    await AuditLog.create({
      actorUserId: actorUserId || req?.user?._id || req?.userId || null,
      actorEmail: actorEmail || req?.user?.email || null,
      action,
      entityType,
      entityId: entityId ? String(entityId) : null,
      severity,
      ipAddress: req?.ip || req?.headers?.['x-forwarded-for'] || null,
      userAgent: req?.headers?.['user-agent'] || null,
      metadata
    });
  } catch (error) {
    console.error('Audit log error:', error.message);
  }
}

module.exports = { logAuditEvent };
