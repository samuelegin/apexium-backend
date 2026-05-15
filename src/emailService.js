async function sendVerificationEmail(email, code) {
  if (process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const { error } = await resend.emails.send({
      from:    process.env.FROM_EMAIL || 'Apexium <noreply@apexium.com>',
      to:      email,
      subject: 'Verify Your Apexium Account',
      html:    buildEmailHtml(code),
    });

    if (error) {
      console.error('[email] Resend error:', error.message);
      return false;
    }
    console.log(`[email] Verification code sent to: ${email}`);
    return true;
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  try {
    await transporter.sendMail({
      from:    process.env.FROM_EMAIL || 'noreply@apexium.com',
      to:      email,
      subject: 'Verify Your Apexium Account',
      html:    buildEmailHtml(code),
    });
    console.log(`[email] Verification code sent to: ${email}`);
    return true;
  } catch (error) {
    console.error('[email] Failed to send verification email:', error.message);
    return false;
  }
}

function buildEmailHtml(code) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f0f0f; color: #ffffff; padding: 40px; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <h1 style="color: #10b981; font-size: 28px; margin: 0;">Apexium</h1>
        <p style="color: #6b7280; margin: 4px 0 0;">KPI-based freelance marketplace</p>
      </div>
      <h2 style="color: #ffffff; font-size: 20px;">Verify your email</h2>
      <p style="color: #9ca3af;">Enter this code to complete your registration:</p>
      <div style="background: #1a1a1a; border: 1px solid #10b981; border-radius: 8px; padding: 24px; text-align: center; margin: 24px 0;">
        <p style="font-size: 40px; font-weight: bold; color: #10b981; margin: 0; letter-spacing: 8px;">${code}</p>
      </div>
      <p style="color: #6b7280; font-size: 14px;">This code expires in 10 minutes.</p>
      <p style="color: #6b7280; font-size: 14px;">If you didn't create an account, ignore this email.</p>
      <hr style="border: none; border-top: 1px solid #1f2937; margin: 24px 0;">
      <p style="color: #4b5563; font-size: 12px; text-align: center;">Apexium — KPI-based freelance marketplace</p>
    </div>
  `;
}

module.exports = { sendVerificationEmail };