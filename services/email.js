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
      // Don't throw error - make email failures non-blocking in development
      return { success: false, error: error.message };
    }
  }

  async sendOtpEmail({ to, code, purpose }) {
    const purposeLabel = purpose === 'pin_reset'
      ? 'PIN reset'
      : purpose === 'password_reset' ? 'password reset' : 'email verification';
    const subject = `Your FlameX ${purposeLabel} code`;
    const text = `Your FlameX ${purposeLabel} code is ${code}. It expires in 10 minutes.`;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <style>
    @media only screen and (max-width:600px){
      .outer{padding:16px 8px!important}
      .card{border-radius:12px!important}
      .body-cell{padding:24px 16px!important}
      .otp-code{font-size:28px!important;letter-spacing:6px!important;padding:12px 20px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#080B12;font-family:Arial,sans-serif;-webkit-text-size-adjust:100%">
  <table class="outer" width="100%" cellpadding="0" cellspacing="0" style="background:#080B12;padding:32px 16px">
    <tr><td align="center">
      <table class="card" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#0D1117;border-radius:16px;overflow:hidden;border:1px solid #1E293B">
        <tr>
          <td style="background:#111722;padding:28px 24px;text-align:center;border-bottom:1px solid #1E293B">
            <div style="display:inline-block;background:#22C55E;border-radius:12px;padding:8px 18px">
              <span style="color:#080B12;font-size:20px;font-weight:900;letter-spacing:1px">FlameX</span>
            </div>
          </td>
        </tr>
        <tr>
          <td class="body-cell" style="padding:32px 24px;text-align:center">
            <p style="color:#94A3B8;font-size:13px;text-transform:uppercase;letter-spacing:1px;margin:0 0 16px">${purposeLabel}</p>
            <p style="color:#FFFFFF;font-size:15px;margin:0 0 24px">Your verification code is:</p>
            <div style="display:inline-block;background:#111722;border:1px solid #22C55E;border-radius:12px;padding:16px 32px;margin-bottom:24px">
              <span class="otp-code" style="color:#22C55E;font-size:36px;font-weight:900;letter-spacing:8px">${code}</span>
            </div>
            <p style="color:#94A3B8;font-size:13px;margin:0">This code expires in <strong style="color:#F59E0B">10 minutes</strong>.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;text-align:center;background:#080B12;border-top:1px solid #1E293B">
            <p style="color:#94A3B8;font-size:12px;margin:0">If you did not request this, please ignore this email.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
    return this.sendMail({ to, subject, text, html });
  }

  async sendTransactionEmail({ to, title, body, amount, currency, reference }) {
    const subject = `FlameX \u2013 ${title}`;
    const text = [title, body, amount !== undefined && currency ? `Amount: ${amount} ${currency}` : null, reference ? `Reference: ${reference}` : null].filter(Boolean).join('\n');
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <style>
    @media only screen and (max-width:600px){
      .outer{padding:16px 8px!important}
      .card{border-radius:12px!important}
      .body-cell{padding:20px 16px!important}
      .amount-box{padding:12px 14px!important}
      .amount-val{font-size:18px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#080B12;font-family:Arial,sans-serif;-webkit-text-size-adjust:100%">
  <table class="outer" width="100%" cellpadding="0" cellspacing="0" style="background:#080B12;padding:32px 16px">
    <tr><td align="center">
      <table class="card" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#0D1117;border-radius:16px;overflow:hidden;border:1px solid #1E293B">
        <tr>
          <td style="background:#111722;padding:24px;text-align:center;border-bottom:1px solid #1E293B">
            <div style="display:inline-block;background:#22C55E;border-radius:12px;padding:8px 18px">
              <span style="color:#080B12;font-size:20px;font-weight:900;letter-spacing:1px">FlameX</span>
            </div>
          </td>
        </tr>
        <tr>
          <td class="body-cell" style="padding:28px 24px">
            <p style="color:#FFFFFF;font-size:17px;font-weight:700;margin:0 0 12px">${title}</p>
            <p style="color:#94A3B8;font-size:14px;margin:0 0 20px;line-height:1.6">${body}</p>
            ${amount !== undefined && currency ? `<div class="amount-box" style="background:#111722;border:1px solid #1E293B;border-radius:10px;padding:14px 18px;margin-bottom:16px"><span style="color:#94A3B8;font-size:12px;text-transform:uppercase;letter-spacing:1px">Amount</span><br><span class="amount-val" style="color:#22C55E;font-size:22px;font-weight:900">${amount} ${currency}</span></div>` : ''}
            ${reference ? `<p style="color:#94A3B8;font-size:12px;margin:0">Reference: <span style="color:#FFFFFF;font-weight:600;word-break:break-all">${reference}</span></p>` : ''}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;text-align:center;background:#080B12;border-top:1px solid #1E293B">
            <p style="color:#94A3B8;font-size:12px;margin:0">This is an automated notification from <strong style="color:#22C55E">FlameX</strong>.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
    return this.sendMail({ to, subject, text, html });
  }

  async sendReceiptEmail({ to, transaction }) {
    const t = transaction;
    const isCredit = ['deposit', 'user_transfer_received', 'p2p_buy', 'referral_reward'].includes(t.type);
    const sign = isCredit ? '+' : '-';
    const typeLabel = (t.type || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const subject = `FlameX Receipt \u2013 ${typeLabel} (${t.reference})`;

    const statusColor = t.status === 'completed' ? '#22C55E' : t.status === 'failed' ? '#EF4444' : '#F59E0B';
    const statusBg = t.status === 'completed' ? 'rgba(34,197,94,0.15)' : t.status === 'failed' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)';
    const amountColor = isCredit ? '#22C55E' : '#EF4444';

    const rows = [
      ['Receipt No.', t.reference],
      ['Transaction ID', String(t._id)],
      ['Type', typeLabel],
      ['Amount', `${sign}${t.amount} ${t.currency}`],
      t.fee ? ['Fee', `${t.fee} ${t.feeCurrency || t.currency}`] : null,
      ['Status', (t.status || '').toUpperCase()],
      ['Date', new Date(t.createdAt || Date.now()).toUTCString()],
      t.description ? ['Description', t.description] : null,
      t.toUsername ? ['To', `@${t.toUsername}`] : null,
      t.fromUsername ? ['From', `@${t.fromUsername}`] : null,
      t.txHash ? ['Tx Hash', t.txHash] : null
    ].filter(Boolean);

    const rowsHtml = rows.map(([label, value], i) => `
      <tr style="background:${i % 2 === 0 ? '#111722' : '#0D1117'}">
        <td style="padding:12px 20px;color:#94A3B8;font-size:13px;font-family:Arial,sans-serif;white-space:nowrap;width:40%">${label}</td>
        <td style="padding:12px 20px;color:#FFFFFF;font-size:13px;font-family:Arial,sans-serif;font-weight:600;word-break:break-all">${value}</td>
      </tr>`
    ).join('');

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#080B12;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#080B12;padding:32px 16px">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#0D1117;border-radius:16px;overflow:hidden;border:1px solid #1E293B">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#080B12 0%,#111722 100%);padding:28px 24px;text-align:center;border-bottom:1px solid #1E293B">
            <div style="display:inline-block;background:#22C55E;border-radius:12px;padding:8px 18px;margin-bottom:12px">
              <span style="color:#080B12;font-size:20px;font-weight:900;letter-spacing:1px">FlameX</span>
            </div>
            <p style="color:#94A3B8;margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase">Transaction Receipt</p>
          </td>
        </tr>

        <!-- Amount block -->
        <tr>
          <td style="padding:28px 24px;text-align:center;border-bottom:1px solid #1E293B;background:#111722">
            <p style="color:#94A3B8;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px">${typeLabel}</p>
            <p style="color:${amountColor};font-size:36px;font-weight:900;margin:0 0 12px;letter-spacing:-1px">${sign}${t.amount} ${t.currency}</p>
            <span style="display:inline-block;padding:5px 16px;border-radius:20px;font-size:12px;font-weight:700;background:${statusBg};color:${statusColor};border:1px solid ${statusColor}">
              ${(t.status || '').toUpperCase()}
            </span>
          </td>
        </tr>

        <!-- Details table -->
        <tr>
          <td style="padding:0">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td colspan="2" style="padding:16px 20px 8px;color:#FFFFFF;font-size:14px;font-weight:700;background:#0D1117;border-bottom:1px solid #1E293B">Receipt Details</td></tr>
              ${rowsHtml}
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 24px;text-align:center;background:#080B12;border-top:1px solid #1E293B">
            <p style="color:#94A3B8;font-size:12px;margin:0 0 4px">This is an automated receipt from <strong style="color:#22C55E">FlameX</strong>.</p>
            <p style="color:#1E293B;font-size:11px;margin:0">Do not reply to this email.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const text = [`FlameX Receipt — ${typeLabel}`, '', ...rows.map(([l, v]) => `${l}: ${v}`)].join('\n');
    return this.sendMail({ to, subject, text, html });
  }
}

module.exports = new EmailService();
