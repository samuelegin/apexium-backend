const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendVerificationEmail(email, code) {
  const mailOptions = {
    from: process.env.FROM_EMAIL || 'noreply@apexium.com',
    to: email,
    subject: 'Verify Your Apexium Account',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Welcome to Apexium!</h2>
        <p>Please verify your email address to complete your registration.</p>
        <div style="background-color: #f3f4f6; padding: 20px; text-align: center; margin: 20px 0;">
          <h3 style="margin: 0; color: #1f2937;">Your Verification Code</h3>
          <p style="font-size: 32px; font-weight: bold; color: #2563eb; margin: 10px 0; letter-spacing: 4px;">${code}</p>
        </div>
        <p>This code will expire in 10 minutes.</p>
        <p>If you didn't request this verification, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
        <p style="color: #6b7280; font-size: 14px;">Apexium - KPI-based freelance marketplace</p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[email] Verification code sent to: ${email}`);
    return true;
  } catch (error) {
    console.error('[email] Failed to send verification email:', error.message);
    return false;
  }
}

module.exports = { sendVerificationEmail };