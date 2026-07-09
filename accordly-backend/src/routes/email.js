/**
 * src/services/email.js
 * --------------------------------------------------------
 * Email sending via Resend (https://resend.com).
 *
 * SETUP REQUIRED:
 * 1. Sign up at resend.com (free tier: 3,000 emails/month)
 * 2. Verify your sending domain (or use their test domain to start)
 * 3. Get an API key from the Resend dashboard
 * 4. In Railway, add environment variable: RESEND_API_KEY=re_xxxxx
 * 5. Also add: EMAIL_FROM=Accordly <noreply@yourdomain.com>
 *    (must be from a domain you've verified in Resend)
 * --------------------------------------------------------
 */

const { logger } = require('../utils/logger');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Accordly <noreply@accordlyparent.com>';

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    logger.warn(`RESEND_API_KEY not set — email to ${to} was not sent. Subject: "${subject}"`);
    return { sent: false, reason: 'no_api_key' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error(`Resend API error (${res.status}): ${errText}`);
      return { sent: false, reason: 'api_error' };
    }

    return { sent: true };
  } catch (err) {
    logger.error('Email send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

function sendPasswordResetEmail(to, firstName, resetLink) {
  return sendEmail({
    to,
    subject: 'Reset your Accordly password',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
        <h2 style="color: #008f72;">Reset your password</h2>
        <p>Hi ${firstName || 'there'},</p>
        <p>We received a request to reset your Accordly password. Click the button below to choose a new one. This link expires in 1 hour.</p>
        <p style="margin: 24px 0;">
          <a href="${resetLink}" style="background: #00c9a7; color: #0b0f14; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Reset Password</a>
        </p>
        <p>If you didn't request this, you can safely ignore this email — your password won't change.</p>
        <p style="color: #888; font-size: 12px; margin-top: 32px;">Accordly · Patent Pending · USPTO #75170980</p>
      </div>
    `,
  });
}

function sendCoparentInviteEmail(to, inviterName, signupLink) {
  return sendEmail({
    to,
    subject: `${inviterName} invited you to Accordly`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
        <h2 style="color: #008f72;">You've been invited to Accordly</h2>
        <p>${inviterName} has invited you to connect on Accordly, a co-parenting documentation and compliance platform.</p>
        <p>Create your free account using this email address to automatically link your case:</p>
        <p style="margin: 24px 0;">
          <a href="${signupLink}" style="background: #00c9a7; color: #0b0f14; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Create Your Account</a>
        </p>
        <p style="color: #888; font-size: 12px; margin-top: 32px;">Accordly · Patent Pending · USPTO #75170980</p>
      </div>
    `,
  });
}

module.exports = { sendEmail, sendPasswordResetEmail, sendCoparentInviteEmail };
