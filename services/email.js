const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.host = process.env.SMTP_HOST;
    this.port = Number(process.env.SMTP_PORT || 587);
    this.user = process.env.SMTP_USER;
    this.pass = process.env.SMTP_PASS;
    this.from = process.env.SMTP_FROM || this.user || 'no-reply@flamex.app';
    this.secure = this.port === 465;
    this.isConfigured = Boolean(this.host && this.user && this.pass);

    this.transporter = this.isConfigured
      ? nodemailer.createTransport({
          host: this.host,
          port: this.port,
          secure: this.secure,
          auth: {
            user: this.user,
            pass: this.pass
          }
        })
      : null;
  }

  async sendMail({ to, subject, text, html }) {
    if (!to) {
      return { success: false, error: 'Missing recipient email' };
    }

    if (!this.isConfigured || !this.transporter) {
      console.warn(`Email service not configured. Skipping email to ${to} for subject "${subject}"`);
      return { success: false, error: 'Email service not configured' };
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject,
        text,
        html
      });

      return { success: true };
    } catch (error) {
      console.error('Email send error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async sendOtpEmail({ to, code, purpose }) {
    const purposeLabel = purpose === 'pin_reset' ? 'PIN reset' : 'email verification';
    const subject = `Your FlameX ${purposeLabel} code`;
    const text = `Your FlameX ${purposeLabel} code is ${code}. It expires in 10 minutes.`;
    const html = `
      <div style="font-family: Arial, sans-serif; color: #111827;">
        <h2>FlameX ${purposeLabel}</h2>
        <p>Your verification code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">${code}</p>
        <p>This code expires in 10 minutes.</p>
      </div>
    `;

    return this.sendMail({ to, subject, text, html });
  }

  async sendTransactionEmail({ to, title, body, amount, currency, reference }) {
    const subject = `FlameX ${title}`;
    const receiptLine = amount !== undefined && currency ? `Amount: ${amount} ${currency}` : null;
    const referenceLine = reference ? `Reference: ${reference}` : null;
    const text = [body, receiptLine, referenceLine].filter(Boolean).join('\n');
    const html = `
      <div style="font-family: Arial, sans-serif; color: #111827;">
        <h2>${title}</h2>
        <p>${body}</p>
        ${receiptLine ? `<p><strong>${receiptLine}</strong></p>` : ''}
        ${referenceLine ? `<p>${referenceLine}</p>` : ''}
      </div>
    `;

    return this.sendMail({ to, subject, text, html });
  }
}

module.exports = new EmailService();
