const Notification = require('../models/Notification');
const emailService = require('./email');

async function createNotification({
  user,
  type = 'system',
  title,
  body,
  data = {},
  sendEmail = false,
  emailAmount,
  emailCurrency,
  emailReference
}) {
  if (!user?._id || !title || !body) {
    return null;
  }

  const notification = new Notification({
    userId: user._id,
    type,
    title,
    body,
    data
  });

  await notification.save();

  const allowEmail = Boolean(
    sendEmail &&
      user.email &&
      user.settings?.notifications?.email !== false &&
      (type !== 'transaction' || user.settings?.notifications?.transactions !== false)
  );

  if (allowEmail) {
    await emailService.sendTransactionEmail({
      to: user.email,
      title,
      body,
      amount: emailAmount,
      currency: emailCurrency,
      reference: emailReference
    });
  }

  return notification;
}

module.exports = {
  createNotification
};
