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
  emailReference,
  transaction = null
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
    if (transaction) {
      // Send a full styled receipt email
      emailService.sendReceiptEmail({
        to: user.email,
        transaction
      }).catch(error => {
        console.error('Failed to send receipt email:', error.message);
      });
    } else {
      emailService.sendTransactionEmail({
        to: user.email,
        title,
        body,
        amount: emailAmount,
        currency: emailCurrency,
        reference: emailReference
      }).catch(error => {
        console.error('Failed to send notification email:', error.message);
      });
    }
  }

  return notification;
}

module.exports = {
  createNotification
};
