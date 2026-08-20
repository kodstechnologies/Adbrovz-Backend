const nodemailer = require('nodemailer');
const config = require('../config/env');

const createTransporter = () => {
  if (!config.EMAIL_USER || !config.EMAIL_PASSWORD) {
    throw new Error('Email is not configured. Set EMAIL_USER and EMAIL_PASSWORD.');
  }

  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: {
      user: config.EMAIL_USER,
      pass: config.EMAIL_PASSWORD,
    },
  });
};

const sendEmail = async (to, subject, html, text) => {
  const transporter = createTransporter();
  await transporter.sendMail({
    from: config.EMAIL_FROM,
    to,
    subject,
    html,
    text: text || undefined,
  });
  return { success: true, message: 'Email sent successfully' };
};

const sendOTPEmail = async (to, otp) => {
  const subject = 'Your AdBrovz OTP';
  const html = `
    <div>
      <h2>Your OTP Code</h2>
      <p>Your OTP code is: <strong>${otp}</strong></p>
      <p>This code will expire in ${config.OTP_EXPIRE_MINUTES} minutes.</p>
      <p>If you didn't request this code, please ignore this email.</p>
    </div>
  `;
  const text = `Your AdBrovz OTP is ${otp}. It expires in ${config.OTP_EXPIRE_MINUTES} minutes.`;
  return sendEmail(to, subject, html, text);
};

module.exports = {
  sendEmail,
  sendOTPEmail,
};
